import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api'
import type { CharacterUsage, RoomUsage } from '../types'
import { Modal } from './Modal'

interface UsagePanelProps {
  roomId: string
  roomName: string
  onClose: () => void
}

const number = (value: number): string => value.toLocaleString('zh-CN')

/**
 * Token usage accumulated from message meta (B08). No estimation: a harness
 * that does not report usage contributes nothing, and the panel says so.
 */
export function UsagePanel({ roomId, roomName, onClose }: UsagePanelProps) {
  const [usage, setUsage] = useState<RoomUsage | null>(null)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setError('')
    try {
      setUsage(await api.usage(roomId))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [roomId])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <Modal
      title="Token 用量"
      subtitle={`${roomName} · 按角色累计，只统计 harness 上报了 usage 的回合`}
      wide
      onClose={onClose}
      footer={
        <>
          <span className="usage-foot-hint">
            数字来自各 CLI 自己上报的 usage；mock 的数值是占位，不代表真实消耗。
          </span>
          <span className="spacer" />
          <button className="btn" onClick={() => void load()} disabled={!usage && !error}>
            刷新
          </button>
        </>
      }
    >
      {error && <div className="form-error">读取失败：{error}</div>}
      {!usage && !error && <div className="usage-loading">读取中…</div>}
      {usage && (
        <>
          <div className="usage-summary">
            <UsageStat label="回合" value={number(usage.totals.turns)} />
            <UsageStat label="输入" value={number(usage.totals.input)} />
            <UsageStat label="输出" value={number(usage.totals.output)} />
            <UsageStat label="缓存读" value={number(usage.totals.cacheRead)} />
            <UsageStat label="合计" value={number(usage.totals.total)} highlight />
          </div>
          {usage.characters.length === 0 ? (
            <p className="usage-empty">还没有可统计的回合——这个房间的 harness 还没有上报过 usage。</p>
          ) : (
            <table className="usage-table">
              <thead>
                <tr>
                  <th>角色</th>
                  <th>回合</th>
                  <th>输入</th>
                  <th>输出</th>
                  <th>缓存读</th>
                  <th>缓存写</th>
                  <th>合计</th>
                </tr>
              </thead>
              <tbody>
                {usage.characters.map((character) => (
                  <UsageRow key={character.characterId} character={character} />
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </Modal>
  )
}

function UsageStat({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className={`usage-stat${highlight ? ' is-highlight' : ''}`}>
      <span className="usage-stat-label">{label}</span>
      <span className="usage-stat-value">{value}</span>
    </div>
  )
}

function UsageRow({ character }: { character: CharacterUsage }) {
  return (
    <tr>
      <td>
        <span className="usage-name">{character.name}</span>
        <span className={`harness-chip harness-${character.harness}`}>{character.harness}</span>
        {character.model && <span className="usage-model">{character.model}</span>}
      </td>
      <td>{number(character.turns)}</td>
      <td>{number(character.input)}</td>
      <td>{number(character.output)}</td>
      <td>{character.cacheRead ? number(character.cacheRead) : '—'}</td>
      <td>{character.cacheWrite ? number(character.cacheWrite) : '—'}</td>
      <td className="usage-total">{number(character.total)}</td>
    </tr>
  )
}
