import type { Character, Room } from '../types'
import { Avatar } from './Avatar'
import { modelShort } from '../lib/format'

interface ChatHeaderProps {
  room: Room | null
  characters: Character[]
  busy: boolean
  activeCharacterId: string | null
  queueLength: number
  /** Task cards not yet settled (B03): proposed + running. */
  openTaskCount: number
  onStop: () => void
  onClear: () => void
  onEditRoom: () => void
  onTogglePanel: () => void
  onShowTasks: () => void
  onShowUsage: () => void
  /** Mobile only: open the sidebar drawer (room list / library nav). */
  onToggleSidebar: () => void
}

export function ChatHeader({
  room,
  characters,
  busy,
  activeCharacterId,
  queueLength,
  openTaskCount,
  onStop,
  onClear,
  onEditRoom,
  onTogglePanel,
  onShowTasks,
  onShowUsage,
  onToggleSidebar,
}: ChatHeaderProps) {
  const active = characters.find((character) => character.id === activeCharacterId)
  const enabled = characters.filter((character) => character.enabled)

  return (
    <header className="chat-header">
      <div className="chat-title">
        <div className="chat-title-row">
          <h2>{room ? room.name : '选择一个房间'}</h2>
          {busy ? (
            <span className="pill pill-live">
              <span className="spinner" />
              {active ? `${active.name} 工作中` : '运行中'}
              {queueLength > 0 ? ` · 队列 ${queueLength}` : ''}
            </span>
          ) : (
            <span className="pill pill-idle">空闲</span>
          )}
        </div>
        <p className="chat-subtitle">
          <span className="topic" title={room?.topic || undefined}>
            {room?.topic || '还没有设置主题'}
          </span>
          {room && (
            <>
              <span className="sep">·</span>
              <code className="path" title={room.workingDir}>
                {room.workingDir}
              </code>
            </>
          )}
        </p>
      </div>

      <div className="member-stack" title="已启用角色">
        {enabled.slice(0, 5).map((character) => (
          <Avatar key={character.id} emoji={character.avatar} color={character.color} size={26} />
        ))}
        {enabled.length > 5 && <span className="member-more">+{enabled.length - 5}</span>}
      </div>

      <div className="header-actions">
        <button
          className="btn btn-icon btn-ghost sidebar-toggle"
          onClick={onToggleSidebar}
          title="房间与导航"
          aria-label="打开侧栏"
        >
          ☰
        </button>
        {busy && (
          <button className="btn btn-danger-ghost" onClick={onStop}>
            停止
          </button>
        )}
        <button className="btn btn-ghost" onClick={onClear} title="清空聊天记录">
          清空
        </button>
        <button className="btn btn-ghost" onClick={onEditRoom} disabled={!room}>
          房间设置
        </button>
        <button className="btn btn-ghost" onClick={onShowTasks} disabled={!room} title="任务卡">
          任务{openTaskCount > 0 ? ` · ${openTaskCount}` : ''}
        </button>
        <button className="btn btn-ghost" onClick={onShowUsage} disabled={!room} title="Token 用量">
          用量
        </button>
        <button className="btn btn-icon btn-ghost panel-toggle" onClick={onTogglePanel} title="角色面板">
          ◫
        </button>
      </div>
    </header>
  )
}

export function ActiveCharacterLabel({ character }: { character?: Character }) {
  if (!character) return null
  return (
    <span className="active-label">
      {character.name} · {modelShort(character.model)}
    </span>
  )
}
