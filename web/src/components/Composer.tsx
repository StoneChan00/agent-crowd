import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { Character } from '../types'
import { Avatar } from './Avatar'
import { readableTextColor } from '../lib/format'

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

interface MentionOption {
  key: string
  /** Call-name inserted after the `@`. */
  name: string
  label: string
  hint: string
  avatar?: string
  color?: string
}

interface MentionState {
  /** Index of the `@` that opened the menu. */
  start: number
  /** Caret position when the query was read; the choice is spliced in here. */
  end: number
  query: string
  /** Highlighted option; clamped while rendering. */
  index: number
}

/**
 * The `@word` immediately before the caret, or null when the caret isn't in
 * one. `@` inside an email (`name@example.com`) deliberately doesn't count.
 */
function mentionAt(text: string, caret: number): { start: number; end: number; query: string } | null {
  const upto = text.slice(0, caret)
  const start = upto.lastIndexOf('@')
  if (start < 0) return null
  const query = upto.slice(start + 1)
  // Whitespace or punctuation ends the call-name: close instead of hunting
  // for a match against "千问，" or "name ".
  if (/[\s@，,。.!！？?、：:；;）)]/.test(query)) return null
  if (start > 0 && /[A-Za-z0-9_]/.test(upto[start - 1])) return null
  return { start, end: caret, query }
}

/** Enabled characters (name or alias) plus `@all`, filtered by the typed query. */
function mentionOptions(query: string, characters: Character[]): MentionOption[] {
  const needle = query.trim().toLowerCase()
  const options: MentionOption[] = []
  if (!needle || 'all'.startsWith(needle) || '所有人'.startsWith(needle)) {
    options.push({ key: 'all', name: 'all', label: '@all', hint: '唤醒全部启用的角色' })
  }
  for (const character of characters) {
    if (!character.enabled) continue
    const callNames = [character.name, ...character.aliases]
    const match =
      callNames.find((name) => name.toLowerCase().startsWith(needle)) ??
      callNames.find((name) => name.toLowerCase().includes(needle))
    if (!match) continue
    options.push({
      key: character.id,
      name: match,
      label: `@${match}`,
      hint: match === character.name ? character.persona.split('\n')[0] || '点它发言' : `别名 · ${character.name}`,
      avatar: character.avatar,
      color: character.color,
    })
  }
  return options.slice(0, 8)
}

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
  const [mention, setMention] = useState<MentionState | null>(null)
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

  // Keep the popup in step with the caret. Re-selecting only the same token
  // keeps the highlighted row stable while the user keeps typing.
  const syncMention = (text: string, caret: number) => {
    const found = mentionAt(text, caret)
    setMention((current) => {
      if (!found) return null
      if (current && current.start === found.start && current.query === found.query) return current
      return { ...found, index: 0 }
    })
  }

  const options = useMemo(
    () => (mention ? mentionOptions(mention.query, characters) : []),
    [mention, characters],
  )
  const activeIndex = mention ? Math.min(mention.index, Math.max(0, options.length - 1)) : 0

  const submit = () => {
    const text = value.trim()
    if (!text || disabled) return
    if (steerMode && activeCharacter && onSteer) onSteer(activeCharacter.id, text)
    else onSend(text)
    setValue('')
    setMention(null)
  }

  /** Replace the half-typed `@query` with the chosen call-name. */
  const applyMention = (option: MentionOption) => {
    if (!mention) return
    const head = value.slice(0, mention.start)
    const tail = value.slice(mention.end)
    // Keep a separator after the call-name: besides reading better, it closes
    // the menu (a bare `@name` before the caret would immediately re-open it
    // and swallow the next Enter). When the tail already starts with
    // whitespace we don't insert a space but *skip past it* instead — the
    // caret lands after the separator, so the query re-read from onSelect
    // ends in whitespace and the menu closes the same natural way. Parking
    // the caret right after `@name` would also re-open the menu on the next
    // keystroke, not just the next Enter.
    const skip = /^\s+/.exec(tail)?.[0].length ?? 0
    const insert = `@${option.name}${skip > 0 ? '' : ' '}`
    setValue(`${head}${insert}${tail}`)
    setMention(null)
    const caret = head.length + insert.length + skip
    requestAnimationFrame(() => {
      const node = ref.current
      if (!node) return
      node.focus()
      node.setSelectionRange(caret, caret)
    })
  }

  const insertCallName = (name: string) => {
    setValue((current) => (current.endsWith(' ') || current === '' ? `${current}@${name} ` : `${current} @${name} `))
    ref.current?.focus()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return
    if (mention) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const step = event.key === 'ArrowDown' ? 1 : -1
        setMention((current) => {
          if (!current) return current
          const count = mentionOptions(current.query, characters).length
          if (count === 0) return current
          return { ...current, index: (current.index + step + count) % count }
        })
        return
      }
      if ((event.key === 'Enter' || event.key === 'Tab') && options.length > 0) {
        event.preventDefault()
        applyMention(options[activeIndex])
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setMention(null)
        return
      }
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      submit()
    }
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
            onClick={() => insertCallName('all')}
          >
            @all
          </button>
          {enabled.map((character) => (
            <button
              key={character.id}
              className="mention-chip"
              style={{ borderColor: `${character.color}44`, color: readableTextColor(character.color) }}
              title={character.aliases.length ? `也可 @${character.aliases.join(' / @')} 唤醒` : undefined}
              onClick={() => insertCallName(character.name)}
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
      <div className="composer-anchor">
        {mention && (
          <div className="mention-pop" role="listbox" aria-label="选择要 @ 的角色">
            {options.length === 0 ? (
              <div className="mention-pop-empty">没有匹配「{mention.query}」的角色</div>
            ) : (
              options.map((option, index) => (
                <button
                  key={option.key}
                  type="button"
                  role="option"
                  aria-selected={index === activeIndex}
                  className={`mention-option${index === activeIndex ? ' is-active' : ''}`}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setMention((current) => (current ? { ...current, index } : current))}
                  onClick={() => applyMention(option)}
                >
                  {option.avatar ? (
                    <Avatar emoji={option.avatar} color={option.color ?? '#8b76f6'} size={22} />
                  ) : (
                    <span className="mention-option-all">@</span>
                  )}
                  <span className="mention-option-name">{option.label}</span>
                  <span className="mention-option-hint">{option.hint}</span>
                </button>
              ))
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
                  : '描述你的需求，或输入 @ 点名某个角色…'
            }
            onChange={(event) => {
              setValue(event.target.value)
              syncMention(event.target.value, event.target.selectionStart ?? event.target.value.length)
            }}
            onKeyDown={onKeyDown}
            onSelect={(event) => syncMention(event.currentTarget.value, event.currentTarget.selectionStart ?? 0)}
            onBlur={() => setMention(null)}
          />
          <button
            className={`btn btn-send${steerMode ? ' btn-steer' : ''}`}
            disabled={disabled || !value.trim()}
            onClick={submit}
          >
            {steerMode && activeCharacter ? '补充' : '发送'}
          </button>
        </div>
      </div>
      <div className="composer-hint">
        <span>
          {steerMode && activeCharacter
            ? `Enter 补充 · 目标 ${activeCharacter.name}（打断当前回复并重跑）`
            : 'Enter 发送 · Shift+Enter 换行 · ↑↓ 选择 @ 对象'}
        </span>
        <span>角色会按触发规则自动接力</span>
      </div>
    </div>
  )
}
