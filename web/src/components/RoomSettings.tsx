import { useEffect, useState } from 'react'
import type { Memory, Room } from '../types'
import { api } from '../lib/api'
import { Modal } from './Modal'

interface RoomSettingsProps {
  room: Room | null
  canDelete: boolean
  onClose: () => void
  onSave: (draft: { name: string; topic: string; workingDir: string; maxHops: number }) => Promise<void>
  onDelete?: () => Promise<void>
}

const MEMORY_KINDS: { value: string; label: string }[] = [
  { value: 'fact', label: '事实' },
  { value: 'decision', label: '决议' },
  { value: 'preference', label: '约定' },
]

export function RoomSettings({ room, canDelete, onClose, onSave, onDelete }: RoomSettingsProps) {
  const [name, setName] = useState(room?.name ?? '')
  const [topic, setTopic] = useState(room?.topic ?? '')
  const [workingDir, setWorkingDir] = useState(room?.workingDir ?? '')
  const [maxHops, setMaxHops] = useState(room?.maxHops ?? 6)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  /** Team memory (room scope): shared context every member sees in their prompt. */
  const [memories, setMemories] = useState<Memory[] | null>(null)
  const [memoryInput, setMemoryInput] = useState('')
  const [memoryKind, setMemoryKind] = useState('decision')
  const [memoryBusy, setMemoryBusy] = useState(false)

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
      await onSave({ name: name.trim(), topic, workingDir: workingDir.trim(), maxHops })
      onClose()
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

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
