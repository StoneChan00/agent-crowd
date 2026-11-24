import { useEffect, useState } from 'react'
import type { Character, HarnessMap, McpMap, Memory, Room } from '../types'
import { api } from '../lib/api'
import { modelShort } from '../lib/format'
import { Modal } from './Modal'

interface Readiness {
  level: 'ok' | 'warn' | 'error' | 'off'
  issues: string[]
  mcpEnabled: number
  /** B13: what this CLI can report — differences made explicit. */
  caps: string
}

/** Path comparison for the shared-directory warning: case/slash/trailing-slash insensitive. */
function sameDir(a: string, b: string): boolean {
  const normalize = (path: string) => path.trim().replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase()
  return normalize(a) === normalize(b)
}

/**
 * A local, best-effort readiness check for one character: is its CLI on this
 * machine, is the configured model in the harness's own candidate list, does
 * DSH have credentials, and is a custom command actually filled in. It never
 * calls the network — everything comes from the same probes /api/health uses.
 */
function readinessFor(
  character: Character,
  harnesses: HarnessMap,
  models: Record<string, string[]>,
  mcps: McpMap | null,
): Readiness {
  if (!character.enabled) return { level: 'off', issues: [], mcpEnabled: 0, caps: '' }
  const issues: string[] = []
  const info = harnesses[character.harness]
  if (!info?.available) issues.push(`CLI 不可用（${info?.detail ?? '未找到'}）`)
  if (character.harness === 'custom' && !character.commandTemplate.trim()) {
    issues.push('自定义命令未填写')
  }
  if (character.harness === 'dsh' && info?.detail?.includes('缺失')) {
    issues.push('DeepSeek 凭据缺失')
  }
  const wanted = character.model.trim()
  const candidates = models[character.harness] ?? []
  if (wanted && candidates.length > 0) {
    const short = (value: string) => value.split('/').pop() ?? value
    const matched = candidates.some(
      (candidate) => candidate === wanted || short(candidate) === wanted || short(candidate) === short(wanted),
    )
    if (!matched) issues.push(`模型 ${wanted} 不在候选列表`)
  }
  const mcpInfo = mcps?.[character.harness]
  if (mcpInfo?.error) issues.push(`MCP 配置读取失败：${mcpInfo.error}`)
  const mcpEnabled = mcpInfo?.servers.filter((server) => server.enabled).length ?? 0
  const capability = info?.capabilities
  const caps = capability
    ? `工具${capability.tools === 'structured' ? '✓' : capability.tools === 'text' ? '~' : '×'} · 思考${
        capability.thinking ? '✓' : '×'
      } · token${capability.tokens ? '✓' : '×'} · 续传${capability.sessionResume ? '✓' : '×'}`
    : ''
  return {
    level: issues.length === 0 ? 'ok' : issues.some((issue) => /不可用|缺失|未填写/.test(issue)) ? 'error' : 'warn',
    issues,
    mcpEnabled,
    caps,
  }
}

interface RoomSettingsProps {
  room: Room | null
  /** Every room, for the shared-working-directory warning. */
  rooms: Room[]
  characters: Character[]
  harnesses: HarnessMap
  models: Record<string, string[]>
  canDelete: boolean
  onClose: () => void
  onSave: (draft: {
    name: string
    topic: string
    workingDir: string
    maxHops: number
    verifyCommand: string
    reviewerCharacterId: string | null
    blindReview: boolean
    defaultResponderId: string | null
  }) => Promise<void>
  onIsolate: () => Promise<void>
  onUnisolate: () => Promise<void>
  onLocateMemory: (memory: Memory) => void
  onDelete?: () => Promise<void>
}

const MEMORY_KINDS: { value: string; label: string }[] = [
  { value: 'fact', label: '事实' },
  { value: 'decision', label: '决议' },
  { value: 'preference', label: '约定' },
]

export function RoomSettings({
  room,
  rooms,
  characters,
  harnesses,
  models,
  canDelete,
  onClose,
  onSave,
  onIsolate,
  onUnisolate,
  onLocateMemory,
  onDelete,
}: RoomSettingsProps) {
  const [name, setName] = useState(room?.name ?? '')
  const [topic, setTopic] = useState(room?.topic ?? '')
  const [workingDir, setWorkingDir] = useState(room?.workingDir ?? '')
  const [maxHops, setMaxHops] = useState(room?.maxHops ?? 6)
  const [verifyCommand, setVerifyCommand] = useState(room?.verifyCommand ?? '')
  /** B05 self-review ban: the room's designated reviewer (empty = unrestricted). */
  const [reviewerCharacterId, setReviewerCharacterId] = useState(room?.reviewerCharacterId ?? '')
  /** B11: auto-queue the designated reviewer with request + diff only. */
  const [blindReview, setBlindReview] = useState(room?.blindReview ?? false)
  /** B14: who answers a user message that mentions nobody. */
  const [defaultResponderId, setDefaultResponderId] = useState(room?.defaultResponderId ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  /** Team memory (room scope): shared context every member sees in their prompt. */
  const [memories, setMemories] = useState<Memory[] | null>(null)
  const [memoryInput, setMemoryInput] = useState('')
  const [memoryKind, setMemoryKind] = useState('decision')
  const [memoryBusy, setMemoryBusy] = useState(false)
  /** MCP config per harness, for the readiness panel (best-effort: null = still reading). */
  const [mcps, setMcps] = useState<McpMap | null>(null)
  const [isolationBusy, setIsolationBusy] = useState(false)
  const [isolationError, setIsolationError] = useState('')

  const runIsolation = async (action: () => Promise<void>) => {
    setIsolationBusy(true)
    setIsolationError('')
    try {
      await action()
    } catch (error) {
      setIsolationError(error instanceof Error ? error.message : String(error))
    } finally {
      setIsolationBusy(false)
    }
  }

  useEffect(() => {
    let cancelled = false
    api
      .mcps()
      .then((data) => {
        if (!cancelled) setMcps(data.mcps)
      })
      .catch(() => {
        if (!cancelled) setMcps({})
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!room) {
      setMemories(null)
      return
    }
    let cancelled = false
    api
      .memories(room.id)
      .then((data) => {
        if (!cancelled) setMemories(data.room)
      })
      .catch(() => {
        if (!cancelled) setMemories([])
      })
    return () => {
      cancelled = true
    }
  }, [room?.id])

  const addMemory = async () => {
    const content = memoryInput.trim()
    if (!content || !room) return
    setMemoryBusy(true)
    try {
      const result = await api.addMemory(room.id, {
        scope: 'room',
        kind: memoryKind,
        content,
      })
      setMemories((current) =>
        current?.some((item) => item.id === result.memory.id) ? current : [result.memory, ...(current ?? [])],
      )
      setMemoryInput('')
    } catch (memoryError) {
      setError(memoryError instanceof Error ? memoryError.message : '记忆写入失败')
    } finally {
      setMemoryBusy(false)
    }
  }

  const togglePin = async (memory: Memory) => {
    if (!room) return
    try {
      const updated = await api.updateMemory(memory.id, { pinned: !memory.pinned })
      setMemories((current) => (current ?? []).map((item) => (item.id === updated.id ? updated : item)))
    } catch (memoryError) {
      setError(memoryError instanceof Error ? memoryError.message : '记忆更新失败')
    }
  }

  const removeMemory = async (memory: Memory) => {
    if (!room) return
    try {
      await api.deleteMemory(memory.id)
      setMemories((current) => (current ?? []).filter((item) => item.id !== memory.id))
    } catch (memoryError) {
      setError(memoryError instanceof Error ? memoryError.message : '记忆删除失败')
    }
  }

  const submit = async () => {
    if (!name.trim()) {
      setError('房间名不能为空')
      return
    }
    if (!Number.isInteger(maxHops) || maxHops < 1 || maxHops > 30) {
      setError('接力上限必须是 1-30 的整数')
      return
    }
    setSaving(true)
    setError('')
    try {
      await onSave({
        name: name.trim(),
        topic,
        workingDir: workingDir.trim(),
        maxHops,
        verifyCommand: verifyCommand.trim(),
        reviewerCharacterId: reviewerCharacterId || null,
        blindReview,
        defaultResponderId: defaultResponderId || null,
      })
      onClose()
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  // Two non-isolated rooms on the same directory will overwrite each other's
  // files when both run; the warning names the other room so the user can
  // isolate one side (or move it).
  const sharedRooms =
    room && !room.isolationBranch
      ? rooms.filter(
          (other) =>
            other.id !== room.id &&
            !other.isolationBranch &&
            sameDir(other.workingDir, room.workingDir),
        )
      : []

  // B14: a role-tagged reviewer can stand in when no one is explicitly designated.
  const reviewerPoolAvailable = characters.some(
    (character) => character.enabled && character.roles.includes('reviewer') && !character.triggers.onRoundEnd,
  )
  const designatedReviewer = reviewerCharacterId
    ? characters.find((character) => character.id === reviewerCharacterId)
    : undefined
  const designatedUsable = Boolean(designatedReviewer?.enabled && !designatedReviewer.triggers.onRoundEnd)
  // B15: an existing blind config whose reviewer went stale must still be
  // closable — otherwise the checkbox stays on+disabled and every save 400s.
  const blindConfigBroken = blindReview && !designatedUsable && !reviewerPoolAvailable

  const readiness = characters.map((character) => ({
    character,
    ...readinessFor(character, harnesses, models, mcps),
  }))
  const activeReadiness = readiness.filter((item) => item.level !== 'off')
  const errorCount = activeReadiness.filter((item) => item.level === 'error').length
  const warnCount = activeReadiness.filter((item) => item.level === 'warn').length

  return (
    <Modal
      title={room ? '房间设置' : '新建房间'}
      subtitle="工作目录是所有角色默认的文件操作位置"
      onClose={onClose}
      footer={
        <>
          {room && canDelete && onDelete && (
            <button
              className="btn btn-danger-ghost"
              onClick={async () => {
                try {
                  await onDelete()
                  onClose()
                } catch (deleteError) {
                  setError(deleteError instanceof Error ? deleteError.message : '删除失败')
                }
              }}
            >
              删除房间
            </button>
          )}
          <span className="spacer" />
          <button className="btn btn-ghost" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" onClick={submit} disabled={saving}>
            {saving ? '保存中…' : room ? '保存' : '创建'}
          </button>
        </>
      }
    >
      {error && <div className="form-error">{error}</div>}
      <div className="field">
        <label>房间名</label>
        <input className="input" value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：开发小队" />
      </div>
      <div className="field">
        <label>主题</label>
        <input
          className="input"
          value={topic}
          onChange={(event) => setTopic(event.target.value)}
          placeholder="一句话说明这个房间用来做什么"
        />
      </div>
      <div className="field">
        <label>工作目录</label>
        <input
          className="input"
          value={workingDir}
          onChange={(event) => setWorkingDir(event.target.value)}
          placeholder="D:\\2_Projects\\my-app（留空则用项目内置 workspace）"
        />
        <span className="field-hint">角色会在这个目录里读写文件、跑命令。</span>
      </div>
      {room && (
        <div className="field">
          <label>工作目录隔离</label>
          {room.isolationBranch ? (
            <>
              <div className="isolation-state">
                <div>
                  <span className="isolation-ok">✓ 独立工作树</span>
                  <code className="isolation-path">{room.workingDir}</code>
                </div>
                <div className="isolation-meta">
                  分支 <code>{room.isolationBranch}</code> · 来源 <code>{room.isolationSource}</code>
                </div>
                <button
                  className="btn btn-ghost btn-sm"
                  disabled={isolationBusy}
                  onClick={() => void runIsolation(onUnisolate)}
                >
                  {isolationBusy ? '处理中…' : '解除隔离'}
                </button>
              </div>
              <span className="field-hint">
                工作树的提交留在分支 {room.isolationBranch} 上，解除隔离不会删除该分支；合并由你决定。
              </span>
            </>
          ) : (
            <>
              <button
                className="btn btn-ghost btn-sm"
                disabled={isolationBusy}
                onClick={() => void runIsolation(onIsolate)}
              >
                {isolationBusy ? '创建中…' : '创建隔离工作树'}
              </button>
              <span className="field-hint">
                为本房间切一个独立 worktree 和分支，适合多个房间指向同一个仓库。工作树从当前 HEAD 创建，
                <b>源仓库里未提交的改动不会带过去</b>；需要时先在源仓库提交。
              </span>
            </>
          )}
          {isolationError && <div className="form-error">{isolationError}</div>}
          {sharedRooms.length > 0 && (
            <span className="field-hint isolation-warn">
              ⚠ 与房间「{sharedRooms.map((other) => other.name).join('」「')}」共用工作目录：同时运行会互相覆盖文件、提交也会混在一起。建议至少给一侧创建隔离工作树。
            </span>
          )}
        </div>
      )}
      <div className="field">
        <label>单轮接力上限</label>
        <input
          className="input"
          type="number"
          min={1}
          max={30}
          value={maxHops}
          onChange={(event) => setMaxHops(Number(event.target.value))}
        />
        <span className="field-hint">角色之间最多接力多少层；你和 @ 点名（含 @all）唤起的角色都算第 1 层，不计入上限。</span>
      </div>
      {room && characters.length > 0 && (
        <div className="field">
          <label>默认响应者（没人被 @ 时）</label>
          <select className="input" value={defaultResponderId} onChange={(event) => setDefaultResponderId(event.target.value)}>
            <option value="">第一个启用角色（默认）</option>
            {characters.map((character) => (
              <option key={character.id} value={character.id} disabled={!character.enabled}>
                {character.name}（{character.harness}）{character.enabled ? '' : ' — 已停用'}
              </option>
            ))}
          </select>
          <span className="field-hint">
            用户消息没人被 @ 时由谁接手。指定的角色停用或被删除时，会回退到第一个启用角色。@名字 / @别名 仍然优先。
          </span>
        </div>
      )}
      <div className="field">
        <label>验证命令（收尾门禁）</label>
        <input
          className="input"
          value={verifyCommand}
          onChange={(event) => setVerifyCommand(event.target.value)}
          placeholder="例如：npm test（留空 = 不做验证）"
        />
        <span className="field-hint">
          本轮有代码改动时，服务器会在轮末收尾前自动运行这条命令，并要求最后一条 review 结论是 REVIEW: PASS，否则本轮不收尾。
        </span>
      </div>
      {room && characters.length > 0 && (
        <div className="field">
          <label>指定 reviewer（禁止自审）</label>
          {/* B05b-4: only ELIGIBLE members are offered (enabled + not a
              round-end summarizer — the same rule the server enforces on
              save). The currently designated-but-ineligible value stays
              visible, explicitly marked, so a stale designation is never
              silently hidden. */}
          {(() => {
            const eligible = characters.filter((character) => character.enabled && !character.triggers.onRoundEnd)
            const current = characters.find((character) => character.id === reviewerCharacterId)
            const currentIneligible =
              current !== undefined && (!current.enabled || current.triggers.onRoundEnd)
            return (
              <>
                <select className="input" value={reviewerCharacterId} onChange={(event) => setReviewerCharacterId(event.target.value)}>
                  <option value="">不指定（任何非实现者角色的 PASS 都可收尾）</option>
                  {eligible.map((character) => (
                    <option key={character.id} value={character.id}>
                      {character.name}（{character.harness}）
                    </option>
                  ))}
                  {currentIneligible && (
                    <option value={current.id}>
                      {current.name}（{current.harness}）— 已停用/总结角色（不可用）
                    </option>
                  )}
                </select>
                {currentIneligible && (
                  <span className="field-hint reviewer-ineligible-hint">
                    ⚠ 当前指定的「{current.name}」已停用或为轮末总结角色，无法给出有效 PASS——本轮改动会被门禁拦下。请另选他人（或先启用该角色）。
                  </span>
                )}
              </>
            )
          })()}
          <span className="field-hint">
            指定后：REVIEW: PASS 必须来自该角色，且它与实现者不能是同一 harness（同一模型家族不算独立判断）。无论如何，实现者本人的自审 PASS 一律无效。
          </span>
          <label className="check-row">
            <input
              type="checkbox"
              checked={blindReview}
              disabled={!blindReview && !reviewerCharacterId && !reviewerPoolAvailable}
              onChange={(event) => setBlindReview(event.target.checked)}
            />
            改动后自动盲审
          </label>
          <span className="field-hint">
            开启后，有代码改动的回合会自动把 reviewer 排进本轮：优先指定 reviewer；没有指定时从带「审查」标签的角色里选。
            reviewer 只收到原始需求 + 当前未提交 diff，看不到聊天记录；它的 REVIEW 结论直接参与收尾门禁和自动提交。
            {!blindReview && !reviewerCharacterId && !reviewerPoolAvailable && '（需要先指定 reviewer，或给一个角色加「审查」标签）'}
          </span>
          {blindConfigBroken && (
            <span className="field-hint isolation-warn">
              ⚠ 当前盲审配置不可用（指定 reviewer 停用/不适合，且没有可用的「审查」角色）。可以取消勾选关闭盲审，或先补一个 reviewer。
            </span>
          )}
        </div>
      )}

      {room && characters.length > 0 && (
        <div className="field">
          <label>角色就绪检查</label>
          <span className="field-hint">
            只在本机探测 CLI、模型候选、凭据和 MCP 配置，不发起网络请求。
            {activeReadiness.length > 0 &&
              (errorCount > 0
                ? ` 当前 ${errorCount} 个角色有阻塞问题${warnCount > 0 ? `，${warnCount} 个提示` : ''}。`
                : warnCount > 0
                  ? ` 当前 ${warnCount} 个提示，没有阻塞问题。`
                  : ' 全部就绪。')}
          </span>
          <div className="readiness-list">
            {readiness.map(({ character, level, issues, mcpEnabled, caps }) => (
              <div key={character.id} className={`readiness-row readiness-${level}`}>
                <span className="readiness-dot" />
                <span className="readiness-name">{character.name}</span>
                <span className="readiness-harness">
                  {harnesses[character.harness]?.label ?? character.harness} · {modelShort(character.model)}
                </span>
                {level !== 'off' && mcps?.[character.harness] && (
                  <span className="readiness-mcp">MCP {mcpEnabled}</span>
                )}
                {level !== 'off' && caps && (
                  <span className="readiness-caps" title="CLI 能力：工具时间线 / 思考 / token / 会话续传">
                    {caps}
                  </span>
                )}
                <span className="readiness-detail">
                  {level === 'off'
                    ? '未启用'
                    : issues.length > 0
                      ? issues.join('；')
                      : '就绪'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {room && (
        <div className="field">
          <label>团队记忆（本房间共享）</label>
          <span className="field-hint">
            这里记下的公共事实 / 决议会注入本房间每个角色的发言上下文；各角色的私人长期记忆在角色编辑弹窗里管理。
          </span>
          {memories === null ? (
            <p className="field-hint">记忆加载中…</p>
          ) : memories.length === 0 ? (
            <p className="field-hint">还没有团队记忆，例如：「接口风格统一用 REST，不引入 GraphQL」。</p>
          ) : (
            <div className="memory-list">
              {memories.map((memory) => (
                <div key={memory.id} className={`memory-item${memory.pinned ? ' is-pinned' : ''}`}>
                  <button
                    className={`memory-pin${memory.pinned ? ' is-on' : ''}`}
                    title={memory.pinned ? '取消钉选' : '钉选（始终注入 prompt）'}
                    onClick={() => togglePin(memory)}
                  >
                    📌
                  </button>
                  <span className="memory-kind">{memory.kind}</span>
                  <span className="memory-content">{memory.content}</span>
                  {memory.repeatCount > 1 && (
                    <span className="memory-repeat" title={`同一原因已出现 ${memory.repeatCount} 次`}>
                      ×{memory.repeatCount}
                    </span>
                  )}
                  {memory.promoted && (
                    <span className="memory-promoted" title="重复出现，已升级为常驻约定">
                      常驻
                    </span>
                  )}
                  {memory.sourceMessageId && (
                    <button
                      className="memory-source"
                      title="定位到来源消息"
                      onClick={() => {
                        onLocateMemory(memory)
                        onClose()
                      }}
                    >
                      来源
                    </button>
                  )}
                  <button className="memory-del" onClick={() => removeMemory(memory)} title="删除这条记忆">
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="memory-add">
            <select className="input memory-kind-select" value={memoryKind} onChange={(event) => setMemoryKind(event.target.value)}>
              {MEMORY_KINDS.map((kind) => (
                <option key={kind.value} value={kind.value}>
                  {kind.label}
                </option>
              ))}
            </select>
            <input
              className="input"
              value={memoryInput}
              placeholder="一条团队共识，回车或点「记下」保存"
              onChange={(event) => setMemoryInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                  event.preventDefault()
                  void addMemory()
                }
              }}
            />
            <button className="btn btn-ghost btn-sm" disabled={memoryBusy || !memoryInput.trim()} onClick={addMemory}>
              记下
            </button>
          </div>
        </div>
      )}
    </Modal>
  )
}
