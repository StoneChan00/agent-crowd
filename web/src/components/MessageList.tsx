import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Character, Message } from '../types'
import { Avatar } from './Avatar'
import { HARNESS_META, clock, formatDuration, modelShort, tokenSummary } from '../lib/format'

export interface LiveTurn {
  turnId: string
  characterId: string
  text: string
  thinking: string[]
  tools: string[]
  startedAt: number
  /** Pid of the CLI process running this turn, once announced. */
  pid?: number
}

interface MessageListProps {
  messages: Message[]
  characters: Character[]
  live: LiveTurn | null
  activeCharacterId: string | null
  roomId: string | null
  /** "记住" on a message: files it into long-term memory (private for a character reply, shared for a user note). */
  onRemember?: (message: Message) => void
}

export function MessageList({ messages, characters, live, activeCharacterId, roomId, onRemember }: MessageListProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const pinnedRef = useRef(true)
  const [showThinking, setShowThinking] = useState<Record<string, boolean>>({})

  useEffect(() => {
    const node = scrollRef.current
    if (!node) return
    if (pinnedRef.current) {
      node.scrollTop = node.scrollHeight
    }
  }, [messages, live?.text, live?.thinking.length, live?.tools.length, roomId])

  const onScroll = () => {
    const node = scrollRef.current
    if (!node) return
    pinnedRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 120
  }

  const liveCharacter = live ? characters.find((character) => character.id === live.characterId) : undefined

  return (
    <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
      <div className="chat-column">
        {messages.length === 0 && !live && (
          <div className="chat-empty">
            <div className="chat-empty-mark">◍</div>
            <h3>群聊已就绪</h3>
            <p>直接发一条需求：@角色名 点名、@all 唤醒全体、不 @ 则由第一个角色接手。一个角色发言后，监听它的角色会自动接力。</p>
          </div>
        )}

        {messages.map((message) => (
          <MessageRow
            key={message.id}
            message={message}
            character={message.characterId ? characters.find((item) => item.id === message.characterId) : undefined}
            showThinking={Boolean(showThinking[message.id])}
            onToggleThinking={() =>
              setShowThinking((current) => ({ ...current, [message.id]: !current[message.id] }))
            }
            onRemember={onRemember ? () => onRemember(message) : undefined}
          />
        ))}

        {live && (
          <div className="msg msg-character">
            <div className="msg-avatar">
              <Avatar
                emoji={liveCharacter?.avatar ?? '🤖'}
                color={liveCharacter?.color ?? '#8b76f6'}
                size={38}
                glow
              />
            </div>
            <div className="msg-main">
              <div className="msg-head">
                <span className="msg-name" style={{ color: liveCharacter?.color }}>
                  {liveCharacter?.name ?? '角色'}
                </span>
                {liveCharacter && (
                  <span className={`harness-chip harness-${liveCharacter.harness}`}>
                    {HARNESS_META[liveCharacter.harness].label}
                  </span>
                )}
                <span className="msg-model">{modelShort(liveCharacter?.model)}</span>
                <span className="live-badge">
                  <span className="spinner" />
                  工作中
                </span>
                {live.pid !== undefined && (
                  <span
                    className="pid-chip"
                    title="本回合 CLI 进程的 PID；确认是孤儿进程时可 taskkill /PID 它 /T /F"
                  >
                    PID {live.pid}
                  </span>
                )}
              </div>

              {live.tools.length > 0 && (
                <div className="live-tools">
                  {live.tools.slice(-4).map((tool, index) => (
                    <div className="tool-line" key={`${tool}-${index}`}>
                      ⚙ {tool}
                    </div>
                  ))}
                </div>
              )}

              {live.text ? (
                <div className="live-text">{live.text}</div>
              ) : (
                <div className="typing">
                  <span />
                  <span />
                  <span />
                </div>
              )}

              {live.thinking.length > 0 && (
                <details className="thinking">
                  <summary>思考过程（{live.thinking.length} 行）</summary>
                  <pre>{live.thinking.join('\n')}</pre>
                </details>
              )}
            </div>
          </div>
        )}

        {!live && activeCharacterId && (
          <div className="typing-row">
            <span className="spinner" />
            正在唤起角色…
          </div>
        )}
      </div>
    </div>
  )
}

function MessageRow({
  message,
  character,
  showThinking,
  onToggleThinking,
  onRemember,
}: {
  message: Message
  character?: Character
  showThinking: boolean
  onToggleThinking: () => void
  onRemember?: () => void
}) {
  if (message.authorType === 'system') {
    return (
      <div className="msg msg-system">
        <span className={`system-pill${message.meta?.error ? ' is-error' : ''}`}>{message.content}</span>
      </div>
    )
  }

  if (message.authorType === 'user') {
    const steer = message.meta?.steer
    return (
      <div className="msg msg-user">
        <div className={`bubble bubble-user${steer ? ' bubble-steer' : ''}`}>
          {steer && <div className="steer-tag">⚡ 中途补充 → {steer.targetName}</div>}
          <div className="user-text">{message.content}</div>
        </div>
        {onRemember && (
          <button
            className="link-btn remember-btn"
            title="把这条消息记入房间共享记忆，本房间所有角色发言时都能看到"
            onClick={onRemember}
          >
            记住
          </button>
        )}
        <span className="msg-time">{clock(message.createdAt)}</span>
      </div>
    )
  }

  const meta = message.meta
  const harness = meta?.harness
  const harnessMeta = harness ? HARNESS_META[harness] : undefined
  const color = message.color || harnessMeta?.color || '#8b76f6'
  const duration = formatDuration(meta?.durationMs)
  const tokens = tokenSummary(meta)
  const hasDetail = Boolean(meta?.thinking || (meta?.tools && meta.tools.length > 0))

  return (
    <div className="msg msg-character">
      <div className="msg-avatar">
        <Avatar emoji={message.authorAvatar || character?.avatar || '🤖'} color={color} size={38} />
      </div>
      <div className="msg-main">
        <div className="msg-head">
          <span className="msg-name" style={{ color }}>
            {message.authorName}
          </span>
          {harness && (
            <span className={`harness-chip harness-${harness}`}>{harnessMeta?.label ?? harness}</span>
          )}
          {meta?.model && <span className="msg-model">{modelShort(meta.model)}</span>}
          <span className="msg-time">{clock(message.createdAt)}</span>
        </div>

        <div className="markdown">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
            }}
          >
            {message.content}
          </ReactMarkdown>
        </div>

        {meta?.error && (
          <div className="turn-error-warn">
            ⚠️ 本轮中断（{meta.error.split('\n')[0].slice(0, 60)}），内容可能不完整
          </div>
        )}

        {(duration || tokens || hasDetail || onRemember) && (
          <div className="msg-footer">
            {duration && <span>⏱ {duration}</span>}
            {tokens && <span>◆ {tokens}</span>}
            {meta?.exitCode !== undefined && meta.exitCode !== 0 && (
              <span className="footer-warn">exit {meta.exitCode}</span>
            )}
            {meta?.pid !== undefined && <span className="footer-pid">PID {meta.pid}</span>}
            {onRemember && (
              <button
                className="link-btn remember-btn"
                title={`把这条回复记入「${message.authorName}」的跨房间长期记忆`}
                onClick={onRemember}
              >
                记住
              </button>
            )}
            {hasDetail && (
              <button className="link-btn" onClick={onToggleThinking}>
                {showThinking ? '收起详情' : '详情'}
              </button>
            )}
          </div>
        )}

        {showThinking && meta?.thinking && (
          <details className="thinking" open>
            <summary>思考过程</summary>
            <pre>{meta.thinking}</pre>
          </details>
        )}

        {showThinking && meta?.tools && meta.tools.length > 0 && (
          <div className="tool-traces">
            {meta.tools.map((tool, index) => (
              <div className="tool-line" key={`${tool.name}-${index}`}>
                {tool.ok ? '✓' : '×'} {tool.name}
                {tool.durationMs ? ` · ${formatDuration(tool.durationMs)}` : ''}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
