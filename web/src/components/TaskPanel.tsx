import { useState } from 'react'
import type { Character, Task, TaskStatus } from '../types'
import { api } from '../lib/api'
import { Modal } from './Modal'

interface TaskPanelProps {
  roomId: string
  roomName: string
  characters: Character[]
  tasks: Task[]
  onClose: () => void
  /** Refetch after a local action — SSE `task` events keep other tabs in sync. */
  onRefresh: () => void
}

const STATUS_LABELS: Record<TaskStatus, string> = {
  proposed: '待批准',
  approved: '已批准',
  running: '进行中',
  done: '已完成',
  rejected: '已驳回',
}

const STATUS_PILLS: Record<TaskStatus, string> = {
  proposed: 'pill pill-task-proposed',
  approved: 'pill pill-task-approved',
  running: 'pill pill-task-running',
  done: 'pill pill-task-done',
  rejected: 'pill pill-task-rejected',
}

function formatTime(ts: number | null): string {
  return ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false }) : ''
}

export function TaskPanel({ roomId, roomName, characters, tasks, onClose, onRefresh }: TaskPanelProps) {
  const enabled = characters.filter((character) => character.enabled)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [draft, setDraft] = useState({
    title: '',
    what: '',
    why: '',
    acceptance: '',
    assigneeId: enabled[0]?.id ?? '',
  })

  const assigneeName = (task: Task): string =>
    task.assigneeId ? (characters.find((c) => c.id === task.assigneeId)?.name ?? '（角色已删除）') : '（未指定）'

  const create = async () => {
    if (!draft.title.trim() || !draft.what.trim()) {
      setError('标题和「要做什么」不能为空')
      return
    }
    setBusy(true)
    setError('')
    try {
      await api.createTask(roomId, { ...draft, assigneeId: draft.assigneeId || null })
      setDraft({ title: '', what: '', why: '', acceptance: '', assigneeId: enabled[0]?.id ?? '' })
      onRefresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const act = async (task: Task, action: 'approve' | 'reject' | 'dispatch') => {
    setBusy(true)
    setError('')
    try {
      if (action === 'dispatch') {
        await api.dispatchTask(task.id)
      } else {
        await api.updateTask(task.id, { status: action === 'approve' ? 'approved' : 'rejected' })
      }
      onRefresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      wide
      title={`任务卡 · ${roomName}`}
      subtitle="卡片只是提案：批准后才会把内容作为系统消息发给负责人并叫醒它；驳回不产生任何回合。"
      onClose={onClose}
    >
      <div className="form-section">
        <h4>新建任务卡</h4>
        <div className="field">
          <label>标题</label>
          <input
            value={draft.title}
            maxLength={120}
            placeholder="一句话说清这张卡要做什么"
            onChange={(event) => setDraft({ ...draft, title: event.target.value })}
          />
        </div>
        <div className="field">
          <label>要做什么 *</label>
          <textarea
            rows={3}
            value={draft.what}
            maxLength={4000}
            placeholder="具体的任务描述，会原文进入负责人的 prompt"
            onChange={(event) => setDraft({ ...draft, what: event.target.value })}
          />
        </div>
        <div className="task-form-row">
          <div className="field grow">
            <label>为什么（可选）</label>
            <input
              value={draft.why}
              maxLength={2000}
              placeholder="背景与动机"
              onChange={(event) => setDraft({ ...draft, why: event.target.value })}
            />
          </div>
          <div className="field">
            <label>负责人</label>
            <select
              value={draft.assigneeId}
              onChange={(event) => setDraft({ ...draft, assigneeId: event.target.value })}
            >
              <option value="">（暂不指定）</option>
              {enabled.map((character) => (
                <option key={character.id} value={character.id}>
                  {character.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="field">
          <label>验收标准（可选）</label>
          <textarea
            rows={2}
            value={draft.acceptance}
            maxLength={2000}
            placeholder="怎样算做完；只送进 prompt，判定仍由人 / review 决定"
            onChange={(event) => setDraft({ ...draft, acceptance: event.target.value })}
          />
        </div>
        {error && <p className="form-error">{error}</p>}
        <div>
          <button className="btn btn-primary" onClick={create} disabled={busy || !roomId}>
            提交卡片
          </button>
        </div>
      </div>

      <div className="form-section">
        <h4>卡片列表（{tasks.length}）</h4>
        {tasks.length === 0 && <p className="task-empty">还没有任务卡。上面的卡片只是提案，批准后才会叫醒负责人。</p>}
        <div className="task-list">
          {tasks.map((task) => (
            <div key={task.id} className="task-card">
              <div className="task-card-head">
                <span className={STATUS_PILLS[task.status]}>{STATUS_LABELS[task.status]}</span>
                <h4>{task.title}</h4>
                {task.result === 'blocked' && (
                  <span className="pill pill-task-blocked" title="上一轮被 SOP 门禁拦下，未收尾">
                    门禁拦截
                  </span>
                )}
              </div>
              <p className="task-meta">
                负责人：{assigneeName(task)} · 创建 {formatTime(task.createdAt)}
                {task.approvedAt ? ` · 批准 ${formatTime(task.approvedAt)}` : ''}
                {task.doneAt ? ` · 完成 ${formatTime(task.doneAt)}` : ''}
              </p>
              {expanded === task.id && (
                <div className="task-body">
                  <p>{task.what}</p>
                  {task.why && (
                    <p>
                      <b>为什么：</b>
                      {task.why}
                    </p>
                  )}
                  {task.acceptance && (
                    <p>
                      <b>验收标准：</b>
                      {task.acceptance}
                    </p>
                  )}
                </div>
              )}
              <div className="task-actions">
                <button className="btn btn-ghost btn-sm" onClick={() => setExpanded(expanded === task.id ? null : task.id)}>
                  {expanded === task.id ? '收起' : '详情'}
                </button>
                {task.status === 'proposed' && (
                  <>
                    <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => act(task, 'approve')}>
                      批准并派发
                    </button>
                    <button className="btn btn-danger-ghost btn-sm" disabled={busy} onClick={() => act(task, 'reject')}>
                      驳回
                    </button>
                  </>
                )}
                {task.status === 'running' && (
                  <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => act(task, 'dispatch')}>
                    重新派发
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </Modal>
  )
}
