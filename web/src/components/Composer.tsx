import { useEffect, useRef, useState } from 'react'
import type { Character } from '../types'

interface ComposerProps {
  characters: Character[]
  disabled: boolean
  /** Drafts are per-room: switching rooms must not carry text over. */
  roomId: string | null
  onSend: (content: string) => void
  /** Steer (「中途补充」) plumbing: the active speaker and its handler. */
  busy?: boolean
  activeCharacter?: Character | null
  onSteer?: (targetId: string, content: string) => void
}

const draftKey = (roomId: string) => `ac-draft:${roomId}`

export function Composer({
  characters,
  disabled,
  roomId,
  onSend,
  busy = false,
  activeCharacter = null,
  onSteer,
}: ComposerProps) {
  const [value, setValue] = useState(() => {
    if (!roomId) return ''
    try {
      return window.localStorage.getItem(draftKey(roomId)) ?? ''
    } catch {
      return ''
    }
  })
  const [steerMode, setSteerMode] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)

  // Steer only makes sense against a live turn; leave the mode when it ends.
  useEffect(() => {
    if (!busy || !activeCharacter) setSteerMode(false)
  }, [busy, activeCharacter])

  // Persist as we type; an empty box (fresh send included) clears the stored
  // draft so the room starts clean next time. Storage failures (private
  // mode) just mean drafts won't survive reloads.
  useEffect(() => {
    if (!roomId) return
    try {
      if (value) window.localStorage.setItem(draftKey(roomId), value)
      else window.localStorage.removeItem(draftKey(roomId))
    } catch {
      /* ignore */
    }
  }, [roomId, value])

  useEffect(() => {
    const node = ref.current
    if (!node) return
    node.style.height = 'auto'
    node.style.height = `${Math.min(220, node.scrollHeight)}px`
  }, [value])

  const submit = () => {
    const text = value.trim()
    if (!text || disabled) return
    if (steerMode && activeCharacter && onSteer) onSteer(activeCharacter.id, text)
    else onSend(text)
    setValue('')
  }

  const mention = (name: string) => {
    setValue((current) => (current.endsWith(' ') || current === '' ? `${current}@${name} ` : `${current} @${name} `))
    ref.current?.focus()
  }

  const enabled = characters.filter((character) => character.enabled)

  return (
    <div className="composer-wrap">
      {enabled.length > 0 && (
        <div className="mention-row">
          <span className="mention-label">点名</span>
          <button
            className="mention-chip"
            style={{ borderColor: '#8a8f9844', color: '#8a8f98' }}
            title="唤醒本房间全部启用的角色"
            onClick={() => mention('all')}
          >
            @all
          </button>
          {enabled.map((character) => (
            <button
              key={character.id}
              className="mention-chip"
              style={{ borderColor: `${character.color}44`, color: character.color }}
              title={character.aliases.length ? `也可 @${character.aliases.join(' / @')} 唤醒` : undefined}
              onClick={() => mention(character.name)}
            >
              @{character.name}
            </button>
          ))}
          {busy && activeCharacter && (
            <button
              className={`mention-chip steer-chip${steerMode ? ' is-active' : ''}`}
              title="把补充指令立即注入正在发言的角色：会打断它当前这轮回复，带着补充重跑"
              onClick={() => setSteerMode((mode) => !mode)}
            >
              ⚡ 补充给 {activeCharacter.name}
            </button>
          )}
        </div>
      )}
      <div className={`composer${disabled ? ' is-disabled' : ''}${steerMode ? ' is-steer' : ''}`}>
        <textarea
          ref={ref}
          rows={1}
          value={value}
          disabled={disabled}
          placeholder={
            disabled
              ? '先选择一个房间…'
              : steerMode && activeCharacter
                ? `补充指令给 ${activeCharacter.name}：会打断当前回复，带着补充立即重跑`
                : '描述你的需求，或直接 @某个角色…'
          }
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              submit()
            }
          }}
        />
        <button
          className={`btn btn-send${steerMode ? ' btn-steer' : ''}`}
          disabled={disabled || !value.trim()}
          onClick={submit}
        >
          {steerMode && activeCharacter ? '补充' : '发送'}
        </button>
      </div>
      <div className="composer-hint">
        <span>
          {steerMode && activeCharacter
            ? `Enter 补充 · 目标 ${activeCharacter.name}（打断当前回复并重跑）`
            : 'Enter 发送 · Shift+Enter 换行'}
        </span>
        <span>角色会按触发规则自动接力</span>
      </div>
    </div>
  )
}
