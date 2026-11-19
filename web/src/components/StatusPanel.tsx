import { useCallback, useEffect, useState } from 'react'
import type { RoomObservability, RoundCheck, RoundReport } from '../types'
import { api } from '../lib/api'
import { clock, fullTime } from '../lib/format'
import { Modal } from './Modal'

interface StatusPanelProps {
  roomId: string
  roomName: string
  onClose: () => void
}

/**
 * B10 observability drawer: one place that answers "what is happening now and
 * why did the last round close / not close". Polls while open — the data is
 * cheap (live maps + a small evidence table + a log tail).
 */
export function StatusPanel({ roomId, roomName, onClose }: StatusPanelProps) {
  const [data, setData] = useState<RoomObservability | null>(null)
  const [rounds, setRounds] = useState<RoundReport[]>([])
  const [error, setError] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [diffs, setDiffs] = useState<Record<string, string>>({})
  const [diffBusy, setDiffBusy] = useState<string | null>(null)
  const [diffError, setDiffError] = useState('')
  const [blindBusy, setBlindBusy] = useState<string | null>(null)
  const [blindNotice, setBlindNotice] = useState('')

  const load = useCallback(async () => {
    try {
      const [next, history] = await Promise.all([api.observability(roomId), api.rounds(roomId)])
      setData(next)
      setRounds(history.rounds)
      setError('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [roomId])

  const loadDiff = async (report: RoundReport) => {
    if (diffs[report.roundId]) return
    setDiffBusy(report.roundId)
    setDiffError('')
    try {
      const result = await api.roundDiff(roomId, report.roundId)
      setDiffs((current) => ({ ...current, [report.roundId]: result.text }))
    } catch (cause) {
      setDiffError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setDiffBusy(null)
    }
  }

  const startBlindReview = async (report: RoundReport) => {
    setBlindBusy(report.roundId)
    setBlindNotice('')
    try {
      const result = await api.blindReview(roomId, report.roundId)
      setBlindNotice(`已唤醒「${result.reviewer.name}」进行盲审（只带需求与 diff，不带聊天记录）`)
    } catch (cause) {
      setBlindNotice(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBlindBusy(null)
    }
  }

  const exportReport = async (report: RoundReport) => {
    let diff = diffs[report.roundId]
    if (!diff && report.commitHash) {
      try {
        diff = (await api.roundDiff(roomId, report.roundId)).text
        setDiffs((current) => ({ ...current, [report.roundId]: diff }))
      } catch {
        /* export without the diff rather than failing the whole report */
      }
    }
    const review = report.checks.find((check) => check.kind === 'review')
    const verify = report.checks.find((check) => check.kind === 'verify')
    const markdown = [
      `# 轮次报告 ${report.roundId}`,
      `- 开始：${fullTime(report.startedAt)}`,
      `- 结束：${report.endedAt ? fullTime(report.endedAt) : '—'}`,
      `- 回合数：${report.turnCount}`,
      `- 提交：${report.commitHash ?? '无自动提交'}`,
      `- review：${review ? `${review.verdict.toUpperCase()}（${review.characterName ?? '未知角色'}）` : '无'}`,
      `- verify：${verify ? verify.verdict.toUpperCase() : '未运行'}`,
      `- token：${report.tokens.total}（输入 ${report.tokens.input} / 输出 ${report.tokens.output}）`,
      '',
      '## 改动文件',
      report.changedPaths.length > 0 ? report.changedPaths.map((path) => `- \`${path}\``).join('\n') : '（无）',
      '',
      '## 交付',
      report.delivery || '（无）',
      diff ? `\n## Diff\n\n\`\`\`diff\n${diff}\n\`\`\`` : '',
    ].join('\n')
    const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `round-${report.roundId.slice(0, 8)}.md`
    link.click()
    URL.revokeObjectURL(url)
  }

  useEffect(() => {
    void load()
    const timer = setInterval(() => void load(), 3_000)
    return () => clearInterval(timer)
  }, [load])

  const state = data?.state
  const round = data?.round

  return (
    <Modal
      title="运行状态"
      subtitle={`${roomName} · 每 3 秒刷新`}
      wide
      onClose={onClose}
      footer={
        <>
          <span className="usage-foot-hint">数据来自 orchestrator 的实时状态与 round_checks 证据表。</span>
          <span className="spacer" />
          <button className="btn" onClick={() => void load()}>
            刷新
          </button>
        </>
      }
    >
      {error && <div className="form-error">读取失败：{error}</div>}
      {!data && !error && <div className="usage-loading">读取中…</div>}
      {data && (
        <div className="status-body">
          <section className="status-section">
            <h4 className="template-heading">当前回合</h4>
            <div className="status-grid">
              <StatusItem label="状态" value={state?.busy ? '运行中' : '空闲'} tone={state?.busy ? 'live' : 'muted'} />
              <StatusItem label="角色" value={state?.activeCharacterName ?? '—'} />
              <StatusItem label="PID" value={state?.activePid ? String(state.activePid) : '—'} />
              <StatusItem label="门禁" value={state?.gate === 'running' ? '验证中' : '空闲'} tone={state?.gate === 'running' ? 'warn' : 'muted'} />
              <StatusItem
                label="队列"
                value={state && state.queuedNames.length > 0 ? state.queuedNames.join(' → ') : '—'}
              />
            </div>
          </section>

          <section className="status-section">
            <h4 className="template-heading">本轮</h4>
            {round ? (
              <>
                <div className="status-grid">
                  <StatusItem label="review" value={round.verdict.toUpperCase()} tone={round.verdict === 'pass' ? 'ok' : round.verdict === 'changes' ? 'bad' : 'muted'} />
                  <StatusItem
                    label="验证"
                    value={round.verifyState === 'pass' ? '通过' : round.verifyState === 'fail' ? '失败' : round.verifyState === 'running' ? '运行中' : '未配置'}
                    tone={round.verifyState === 'pass' ? 'ok' : round.verifyState === 'fail' ? 'bad' : 'muted'}
                  />
                  <StatusItem label="最后一回合" value={round.lastTurnOutcome} tone={round.lastTurnOutcome === 'ok' ? 'ok' : 'bad'} />
                  <StatusItem label="结束原因" value={round.endReason === 'limit' ? '接力上限' : '自然收尾'} />
                  <StatusItem label="改动" value={`${round.changedPaths.length} 个文件`} />
                </div>
                {round.changedPaths.length > 0 && (
                  <ul className="status-paths">
                    {round.changedPaths.slice(0, 20).map((path) => (
                      <li key={path}>
                        <code>{path}</code>
                      </li>
                    ))}
                    {round.changedPaths.length > 20 && <li>等 {round.changedPaths.length} 个</li>}
                  </ul>
                )}
              </>
            ) : (
              <p className="usage-empty">当前没有进行中的轮次。</p>
            )}
          </section>

          <section className="status-section">
            <h4 className="template-heading">轮次报告</h4>
            {diffError && <div className="form-error">{diffError}</div>}
            {blindNotice && <div className="status-notice">{blindNotice}</div>}
            {rounds.length === 0 ? (
              <p className="usage-empty">还没有已结束的轮次。</p>
            ) : (
              <ul className="round-list">
                {rounds.map((report) => {
                  const review = report.checks.find((check) => check.kind === 'review')
                  const verify = report.checks.find((check) => check.kind === 'verify')
                  const open = expanded === report.roundId
                  return (
                    <li key={report.roundId} className="round-card">
                      <button
                        className="round-head"
                        onClick={() => setExpanded(open ? null : report.roundId)}
                      >
                        <span className="round-time">{fullTime(report.startedAt)}</span>
                        <span className="round-id">#{report.roundId.slice(0, 8)}</span>
                        <span className="round-meta">
                          {report.turnCount} 回合 · {report.changedPaths.length} 文件
                        </span>
                        {review && (
                          <span className={`round-badge ${review.verdict}`}>review {review.verdict}</span>
                        )}
                        {verify && (
                          <span className={`round-badge ${verify.verdict}`}>verify {verify.verdict}</span>
                        )}
                        <span className={`round-badge ${report.commitHash ? 'pass' : 'muted'}`}>
                          {report.commitHash ? `commit ${report.commitHash.slice(0, 7)}` : '未提交'}
                        </span>
                      </button>
                      {open && (
                        <div className="round-body">
                          <p className="round-delivery">{report.delivery || '（没有交付文本）'}</p>
                          {report.changedPaths.length > 0 && (
                            <ul className="status-paths">
                              {report.changedPaths.map((path) => (
                                <li key={path}>
                                  <code>{path}</code>
                                </li>
                              ))}
                            </ul>
                          )}
                          {report.checks.length > 0 && (
                            <ul className="status-checks">
                              {report.checks.map((check) => (
                                <StatusCheckRow key={check.id} check={check} />
                              ))}
                            </ul>
                          )}
                          <div className="round-actions">
                            {report.commitHash && (
                              <button
                                className="btn btn-ghost btn-sm"
                                disabled={diffBusy === report.roundId}
                                onClick={() => void loadDiff(report)}
                              >
                                {diffBusy === report.roundId
                                  ? '读取中…'
                                  : diffs[report.roundId]
                                    ? '重新读取 diff'
                                    : '查看 diff'}
                              </button>
                            )}
                            <button className="btn btn-ghost btn-sm" onClick={() => void exportReport(report)}>
                              导出 md
                            </button>
                            {report.commitHash && (
                              <button
                                className="btn btn-ghost btn-sm"
                                disabled={blindBusy === report.roundId}
                                title="基于已提交 diff 的事后盲审；结论会作为新消息发出，不回滚已收尾轮次"
                                onClick={() => void startBlindReview(report)}
                              >
                                {blindBusy === report.roundId ? '唤起中…' : '盲审本轮'}
                              </button>
                            )}
                          </div>
                          {diffs[report.roundId] && (
                            <pre className="status-check-detail round-diff">{diffs[report.roundId]}</pre>
                          )}
                        </div>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </section>

          <section className="status-section">
            <h4 className="template-heading">轮次证据（最近 40 条）</h4>
            {data.checks.length === 0 ? (
              <p className="usage-empty">还没有 review / verify 记录。</p>
            ) : (
              <ul className="status-checks">
                {data.checks.map((check) => (
                  <StatusCheckRow key={check.id} check={check} />
                ))}
              </ul>
            )}
          </section>

          <section className="status-section">
            <h4 className="template-heading">崩溃日志（最近 20 行）</h4>
            {data.crash.length === 0 ? (
              <p className="usage-empty">没有崩溃记录。</p>
            ) : (
              <pre className="status-crash">{data.crash.join('\n')}</pre>
            )}
          </section>
        </div>
      )}
    </Modal>
  )
}

function StatusItem({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone?: 'ok' | 'bad' | 'warn' | 'live' | 'muted'
}) {
  return (
    <div className={`status-item${tone ? ` tone-${tone}` : ''}`}>
      <span className="status-label">{label}</span>
      <span className="status-value">{value}</span>
    </div>
  )
}

function StatusCheckRow({ check }: { check: RoundCheck }) {
  const [open, setOpen] = useState(false)
  const detail = check.detail ?? ''
  const hasDetail = detail.length > 0
  return (
    <li className={`status-check${check.verdict === 'pass' ? ' is-pass' : ' is-fail'}`}>
      <span className="status-check-time">{clock(check.createdAt)}</span>
      <span className={`status-check-kind kind-${check.kind}`}>{check.kind}</span>
      <span className="status-check-verdict">{check.verdict}</span>
      {hasDetail ? (
        <button className="link-btn" onClick={() => setOpen((value) => !value)}>
          {open ? '收起' : '详情'}
        </button>
      ) : (
        <span className="status-check-empty">—</span>
      )}
      {open && <pre className="status-check-detail">{detail}</pre>}
    </li>
  )
}
