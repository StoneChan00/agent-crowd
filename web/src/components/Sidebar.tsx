import type { Character, HarnessMap, Room } from '../types'
import { HARNESS_META } from '../lib/format'

interface SidebarProps {
  rooms: Room[]
  characters: Character[]
  selectedRoomId: string | null
  harnesses: HarnessMap
  connected: boolean
  view: 'chat' | 'library'
  presetCount: number
  onSelect: (roomId: string) => void
  onNewRoom: () => void
  onViewChange: (view: 'chat' | 'library') => void
}

export function Sidebar({
  rooms,
  characters,
  selectedRoomId,
  harnesses,
  connected,
  view,
  presetCount,
  onSelect,
  onNewRoom,
  onViewChange,
}: SidebarProps) {
  const harnessKinds = ['cannbot', 'opencode', 'dsh', 'hermes'] as const

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">◍</div>
        <div className="brand-text">
          <strong>Agent Crowd</strong>
          <span>多 harness 协作聊天室</span>
        </div>
      </div>

      <div className="side-nav">
        <button
          className={`nav-item${view === 'chat' ? ' is-active' : ''}`}
          onClick={() => onViewChange('chat')}
        >
          <span className="nav-glyph">◌</span>
          聊天
        </button>
        <button
          className={`nav-item${view === 'library' ? ' is-active' : ''}`}
          onClick={() => onViewChange('library')}
        >
          <span className="nav-glyph">▦</span>
          角色库
          <span className="room-count">{presetCount}</span>
        </button>
      </div>

      <div className="sidebar-section">
        <div className="sidebar-label">
          <span>房间</span>
          <button className="icon-btn" title="新建房间" onClick={onNewRoom}>
            +
          </button>
        </div>
        <div className="room-list">
          {rooms.map((room) => {
            const count = characters.filter((character) => character.roomId === room.id).length
            return (
              <button
                key={room.id}
                className={`room-item${view === 'chat' && room.id === selectedRoomId ? ' is-active' : ''}`}
                onClick={() => onSelect(room.id)}
              >
                <span className="room-hash">#</span>
                <span className="room-name">{room.name}</span>
                <span className="room-count">{count}</span>
              </button>
            )
          })}
          {rooms.length === 0 && <div className="empty-hint">还没有房间</div>}
        </div>
      </div>

      <div className="sidebar-footer">
        <div className="status-row">
          <span className={`dot${connected ? ' dot-ok' : ' dot-off'}`} />
          {connected ? '实时连接正常' : '连接断开，正在重连'}
        </div>
        <div className="harness-legend">
          {harnessKinds.map((kind) => {
            const info = harnesses[kind]
            const meta = HARNESS_META[kind]
            return (
              <div key={kind} className="legend-item" title={info?.detail ?? ''}>
                <span
                  className={`dot${info?.available ? ' dot-ok' : ' dot-off'}`}
                  style={info?.available ? { background: meta.color } : undefined}
                />
                <span>{meta.label}</span>
              </div>
            )
          })}
        </div>
      </div>
    </aside>
  )
}
