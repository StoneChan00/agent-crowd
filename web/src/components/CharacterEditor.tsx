import { useEffect, useState, type ChangeEvent } from 'react'
import type { Character, CharacterPreset, HarnessKind, HarnessMap, Memory, Room, Triggers } from '../types'
import { api } from '../lib/api'
import { HARNESS_META, HARNESS_ORDER } from '../lib/format'
import { isImageAvatar } from './Avatar'
import { AvatarCropper } from './AvatarCropper'
import { Modal } from './Modal'

export interface CharacterDraft {
  name: string
  aliases: string[]
  avatar: string
  color: string
  harness: HarnessKind
  model: string
  persona: string
  cwd: string
  enabled: boolean
  autoApprove: boolean
  commandTemplate: string
  triggers: Triggers
}

interface CharacterEditorProps {
  mode: 'room' | 'library'
  character: Character | CharacterPreset | null
  /** Room members, for the quick "指定角色发言后" checkboxes. */
  members?: Character[]
  room?: Room
  models: Record<string, string[]>
  harnesses: HarnessMap
  onClose: () => void
  onSave: (draft: CharacterDraft) => Promise<void>
  onDelete?: () => Promise<void>
}

const AVATARS = [
  '🤖', '🛠️', '🔍', '🧪', '📊', '🪽', '🧠', '🎨', '🚀', '🧰', '✍️', '🐱', '🦉', '⚙️',
  '🐙', '🐟', '🦊', '🐼', '⚡', '🧭', '📚', '🐉',
]

const COLORS = ['#f97316', '#8b76f6', '#4f9cf9', '#2dd4bf', '#f0a75a', '#f472b6', '#a3e635', '#f87171']

/** Split raw alias input on half/full-width commas, keeping trimmed parts. */
function parseAliasInput(text: string): string[] {
  return text
    .split(/[,，]/)
    .map((part) => part.trim())
    .filter(Boolean)
}

/**
 * Normalize one alias the same way the server does: drop a leading @ (users
 * habitually type it), collapse inner whitespace, cap at 32 chars.
 */
function normalizeAlias(alias: string): string {
  return alias.trim().replace(/^@+/, '').replace(/\s+/g, ' ').trim().slice(0, 32)
}

function toDraft(character: Character | CharacterPreset | null): CharacterDraft {
  return {
    name: character?.name ?? '',
    aliases: character?.aliases ?? [],
    avatar: character?.avatar ?? '🤖',
    color: character?.color ?? '#8b76f6',
    harness: character?.harness ?? 'cannbot',
    model: character?.model ?? '',
    persona: character?.persona ?? '',
    cwd: character?.cwd ?? '',
    enabled: character && 'enabled' in character ? character.enabled : true,
    autoApprove: character?.autoApprove ?? true,
    commandTemplate: character?.commandTemplate ?? '',
    triggers: {
      onUser: character?.triggers.onUser ?? true,
      onAll: character?.triggers.onAll ?? false,
      onCharacters: character?.triggers.onCharacters ?? [],
      onCharacterNames: character?.triggers.onCharacterNames ?? [],
      keyword: character?.triggers.keyword ?? '',
      mention: character?.triggers.mention ?? true,
    },
  }
}

export function CharacterEditor({
  mode,
  character,
  members = [],
  room,
  models,
  harnesses,
  onClose,
  onSave,
  onDelete,
}: CharacterEditorProps) {
  const [draft, setDraft] = useState<CharacterDraft>(() => toDraft(character))
  const [nameInput, setNameInput] = useState('')
  const [aliasInput, setAliasInput] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  /** Data URL of an image waiting to be cropped, shown in the cropper modal. */
  const [cropSrc, setCropSrc] = useState<string | null>(null)
  /** Cross-room identity memories, loaded for existing room characters. */
  const [memories, setMemories] = useState<Memory[] | null>(null)
  const [memoryInput, setMemoryInput] = useState('')
  const [memoryBusy, setMemoryBusy] = useState(false)

  const isExistingRoomCharacter = mode === 'room' && character && 'roomId' in character

  // Identity memories belong to the character (cross-room), so only an
  // existing room character has something to show yet.
  useEffect(() => {
    if (!isExistingRoomCharacter || !room) {
      setMemories(null)
      return
    }
    let cancelled = false
    api
      .memories(room.id)
      .then((data) => {
        if (cancelled) return
        const mine = data.members.find((member) => member.characterId === character.id)
        setMemories(mine?.memories ?? [])
      })
      .catch(() => setMemories([]))
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isExistingRoomCharacter, room?.id, character?.id])

  const suggestions = models[draft.harness] ?? []
  const harnessInfo = harnesses[draft.harness]
  const names = draft.triggers.onCharacterNames

  const set = <K extends keyof CharacterDraft>(key: K, value: CharacterDraft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }))
  const setTrigger = <K extends keyof Triggers>(key: K, value: Triggers[K]) =>
    setDraft((current) => ({ ...current, triggers: { ...current.triggers, [key]: value } }))

  const addName = () => {
    const value = nameInput.trim()
    if (!value) return
    if (!names.includes(value)) setTrigger('onCharacterNames', [...names, value])
    setNameInput('')
  }

  // Comma batch input: "小千, qw，喵" adds all three at once — half- and
  // full-width commas both split. Mirrors db-side sanitizeAliases: leading @
  // stripped, whitespace collapsed, 32-char cap, max 8; duplicates, empties
  // and the primary name are skipped. submit() runs the same merge so
  // unconfirmed input survives a direct save.
  const mergeAliases = (base: string[], incoming: string[]): string[] => {
    const name = draft.name.trim()
    const seen = new Set(base)
    const next = [...base]
    for (const raw of incoming) {
      if (next.length >= 8) break
      const alias = normalizeAlias(raw)
      if (!alias || alias === name || seen.has(alias)) continue
      seen.add(alias)
      next.push(alias)
    }
    return next
  }

  const addAliases = () => {
    const incoming = parseAliasInput(aliasInput)
    if (!incoming.length) return
    const next = mergeAliases(draft.aliases, incoming)
    if (next.length !== draft.aliases.length) set('aliases', next)
    setAliasInput('')
  }
  const removeAlias = (alias: string) => set('aliases', draft.aliases.filter((item) => item !== alias))

  const addMemory = async () => {
    const content = memoryInput.trim()
    if (!content || !isExistingRoomCharacter || !room || !character) return
    setMemoryBusy(true)
    try {
      const result = await api.addMemory(room.id, {
        scope: 'identity',
        characterId: character.id,
        kind: 'fact',
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

  const toggleMemoryPin = async (memory: Memory) => {
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

  const removeName = (name: string) => {
    setTrigger('onCharacterNames', names.filter((item) => item !== name))
    setDraft((current) => ({
      ...current,
      triggers: {
        ...current.triggers,
        onCharacterNames: current.triggers.onCharacterNames.filter((item) => item !== name),
        onCharacters: current.triggers.onCharacters.filter((id) => {
          const member = members.find((item) => item.id === id)
          return member?.name !== name
        }),
      },
    }))
  }

  const toggleMember = (member: Character) => {
    if (names.includes(member.name)) {
      removeName(member.name)
      return
    }
    setDraft((current) => ({
      ...current,
      triggers: {
        ...current.triggers,
        onCharacterNames: [...current.triggers.onCharacterNames, member.name],
        onCharacters: [...new Set([...current.triggers.onCharacters, member.id])],
      },
    }))
  }

  // Uploads open the cropper instead of silently center-cropping: the user
  // drags/zooms the square frame over the image, and the confirmed crop is
  // exported as a 128px data URL into the same avatar field every surface
  // already renders.
  const onAvatarFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (!file.type.startsWith('image/')) {
      setError('头像需要是图片文件')
      return
    }
    if (file.size > 4 * 1024 * 1024) {
      setError('图片超过 4MB，请先压缩再上传')
      return
    }
    const reader = new FileReader()
    reader.onload = () => setCropSrc(String(reader.result))
    reader.onerror = () => setError('无法读取这张图片')
    reader.readAsDataURL(file)
  }

  const submit = async () => {
    if (!draft.name.trim()) {
      setError('请填写角色名')
      return
    }
    setSaving(true)
    setError('')
    try {
      // Keep id-based references in sync with the names the user picked; the
      // name list is what makes copied presets portable.
      const ids = members
        .filter((member) => names.includes(member.name))
        .map((member) => member.id)
      await onSave({
        ...draft,
        name: draft.name.trim(),
        avatar: draft.avatar.trim() || '🤖',
        model: draft.model.trim(),
        cwd: draft.cwd.trim(),
        // Fold in whatever is still sitting unconfirmed in the input box, so
        // typing "小千,qw" and clicking 保存 works without pressing Enter.
        aliases: mergeAliases(
          draft.aliases.filter((alias) => alias.trim() && alias.trim() !== draft.name.trim()),
          parseAliasInput(aliasInput),
        ),
        triggers: { ...draft.triggers, onCharacters: mode === 'room' ? ids : [] },
      })
      onClose()
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const isLibrary = mode === 'library'

  return (
    <>
      <Modal
      wide
      title={
        isLibrary
          ? character
            ? `编辑角色库 · ${character.name}`
            : '新建角色（角色库）'
          : character
            ? `编辑角色 · ${character.name}`
            : '新建角色'
      }
      subtitle={
        isLibrary
          ? '保存为全局模板；加入任何房间时按名字解析触发关系'
          : `房间「${room?.name ?? ''}」· 一个角色绑定一个 harness、一个模型、一段人设`
      }
      onClose={onClose}
      footer={
        <>
          {character && onDelete && (
            <button
              className="btn btn-danger-ghost"
              onClick={async () => {
                await onDelete()
                onClose()
              }}
            >
              {isLibrary ? '删除模板' : '删除角色'}
            </button>
          )}
          <span className="spacer" />
          <button className="btn btn-ghost" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" onClick={submit} disabled={saving}>
            {saving ? '保存中…' : '保存'}
          </button>
        </>
      }
    >
      {error && <div className="form-error">{error}</div>}

      <section className="form-section">
        <h4>身份</h4>
        <div className="identity-row">
          <div className="avatar-field">
            <span
              className="avatar avatar-preview"
              style={{
                background: `linear-gradient(140deg, ${draft.color}2e, ${draft.color}0d)`,
                borderColor: `${draft.color}66`,
              }}
            >
              {isImageAvatar(draft.avatar) ? <img src={draft.avatar} alt="" /> : draft.avatar || '🤖'}
            </span>
            {isImageAvatar(draft.avatar) ? (
              <button type="button" className="link-btn" onClick={() => set('avatar', '🤖')}>
                移除图片
              </button>
            ) : (
              <input
                className="input avatar-input"
                value={draft.avatar}
                maxLength={4}
                onChange={(event) => set('avatar', event.target.value)}
                aria-label="头像 emoji"
              />
            )}
          </div>
          <div className="field grow">
            <label>名称</label>
            <input
              className="input"
              value={draft.name}
              placeholder="例如：开发者 / 审查者"
              onChange={(event) => set('name', event.target.value)}
            />
          </div>
          <div className="field">
            <label>主题色</label>
            <div className="color-row">
              {COLORS.map((color) => (
                <button
                  key={color}
                  className={`color-dot${draft.color === color ? ' is-active' : ''}`}
                  style={{ background: color }}
                  onClick={() => set('color', color)}
                  aria-label={color}
                />
              ))}
            </div>
          </div>
        </div>
        <div className="field">
          <label>别名</label>
          <div className="name-chips">
            {draft.aliases.map((alias) => (
              <span key={alias} className="name-chip alias-chip">
                @{alias}
                <button onClick={() => removeAlias(alias)} aria-label={`移除别名 ${alias}`}>
                  ×
                </button>
              </span>
            ))}
            <input
              className="name-input"
              value={aliasInput}
              placeholder={draft.aliases.length ? '再加一个或多个（逗号分隔）…' : '输入别名后回车；可用逗号一次加多个，@别名 也能唤醒这个角色'}
              onChange={(event) => setAliasInput(event.target.value)}
              onKeyDown={(event) => {
                // isComposing: 中文输入法选词的回车不能当提交（Composer 同款防护）。
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                  event.preventDefault()
                  addAliases()
                }
              }}
            />
          </div>
          <span className="field-hint">聊天里 @名字 或 @任意别名 都能点名这个角色；回车或直接点「保存」都会带上输入框里的别名，逗号分隔可一次加多个，最多 8 个。</span>
        </div>
        <div className="emoji-row">
          {AVATARS.map((emoji) => (
            <button
              key={emoji}
              className={`emoji-btn${draft.avatar === emoji ? ' is-active' : ''}`}
              onClick={() => set('avatar', emoji)}
            >
              {emoji}
            </button>
          ))}
          <label
            className={`emoji-btn upload-btn${isImageAvatar(draft.avatar) ? ' is-active' : ''}`}
            title="上传图片作为头像（可拖动、缩放选取范围，导出 128px data URL）"
          >
            📷
            <input type="file" accept="image/*" hidden onChange={onAvatarFile} />
          </label>
        </div>
      </section>

      <section className="form-section">
        <h4>引擎</h4>
        <div className="grid-2">
          <div className="field">
            <label>Harness</label>
            <select
              className="input"
              value={draft.harness}
              onChange={(event) => set('harness', event.target.value as HarnessKind)}
            >
              {HARNESS_ORDER.map((kind) => {
                const info = harnesses[kind]
                const meta = HARNESS_META[kind]
                const suffix = info && !info.available ? '（未检测到）' : ''
                return (
                  <option key={kind} value={kind}>
                    {meta.label} {suffix}
                  </option>
                )
              })}
            </select>
            {harnessInfo?.detail && <span className="field-hint">{harnessInfo.detail}</span>}
          </div>
          <div className="field">
            <label>模型</label>
            <input
              className="input"
              list={`models-${draft.harness}`}
              value={draft.model}
              placeholder={draft.harness === 'cannbot' ? '例如：cannbot/glm-5.3' : '例如：deepseek-flash'}
              onChange={(event) => set('model', event.target.value)}
            />
            <datalist id={`models-${draft.harness}`}>
              {suggestions.map((model) => (
                <option key={model} value={model} />
              ))}
            </datalist>
            <span className="field-hint">
              {draft.harness === 'cannbot' && 'CANNBot 用 provider/model，如 cannbot/glm-5.3；'}
              {draft.harness === 'opencode' && '格式 provider/model，可从下拉选择；'}
              {draft.harness === 'dsh' && '填 model 名或用 provider/model 指定其他供应商；'}
              {draft.harness === 'hermes' && '填 hermes 支持的 model 名；'}
              {suggestions.length > 0 ? ` 已从本机读到 ${suggestions.length} 个可选模型。` : ''}
            </span>
          </div>
        </div>

        {draft.harness === 'custom' && (
          <div className="field">
            <label>命令模板</label>
            <input
              className="input"
              value={draft.commandTemplate}
              placeholder='my-cli --model {model} --cwd {cwd} "{prompt}"'
              onChange={(event) => set('commandTemplate', event.target.value)}
            />
            <span className="field-hint">占位符：{'{prompt} {model} {cwd} {name}'}，由 cmd.exe 执行。</span>
          </div>
        )}

        <label className="check-row">
          <input
            type="checkbox"
            checked={draft.autoApprove}
            onChange={(event) => set('autoApprove', event.target.checked)}
          />
          <span>
            自动批准工具调用
            <small>无人值守时必须打开，否则角色会卡在权限确认上（cannbot / opencode / hermes 对应不同参数）。</small>
          </span>
        </label>
      </section>

      <section className="form-section">
        <h4>人设</h4>
        <div className="field">
          <textarea
            className="input textarea"
            rows={6}
            value={draft.persona}
            placeholder={
              '你是一名严谨的全栈工程师，负责在项目目录里把需求实现出来。\n完成后用中文简要汇报：改了哪些文件、怎么验证的、还有什么风险。'
            }
            onChange={(event) => set('persona', event.target.value)}
          />
          <span className="field-hint">这段文字会作为角色的系统提示注入，写清职责、输出格式和边界。</span>
        </div>
      </section>

      {isExistingRoomCharacter && (
        <section className="form-section">
          <h4>长期记忆（跨房间）</h4>
          <p className="field-hint">
            同名角色在所有房间共享同一份身份记忆：这里记下的事实会跟着它走，发言时自动注入。
            聊天里也可以点某条消息下的「记住」快速归档。
          </p>
          {memories === null ? (
            <p className="field-hint">记忆加载中…</p>
          ) : memories.length === 0 ? (
            <p className="field-hint">还没有长期记忆。</p>
          ) : (
            <div className="memory-list">
              {memories.map((memory) => (
                <div key={memory.id} className={`memory-item${memory.pinned ? ' is-pinned' : ''}`}>
                  <button
                    className={`memory-pin${memory.pinned ? ' is-on' : ''}`}
                    title={memory.pinned ? '取消钉选' : '钉选（始终注入 prompt）'}
                    onClick={() => toggleMemoryPin(memory)}
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
            <input
              className="input"
              value={memoryInput}
              placeholder="要让它长期记住的事，例如：偏好简洁的中文回复"
              onChange={(event) => setMemoryInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                  event.preventDefault()
                  void addMemory()
                }
              }}
            />
            <button className="btn btn-ghost btn-sm" disabled={memoryBusy || !memoryInput.trim()} onClick={addMemory}>
              记住
            </button>
          </div>
        </section>
      )}

      <section className="form-section">
        <h4>什么时候发言</h4>
        <p className="field-hint">
          用户消息按 @ 规则路由：@名字 点名、@all 唤醒全体、不 @ 时由第一个启用的角色接手。下面的开关只影响角色发言后的接力。
        </p>
        <div className="trigger-grid">
          <label className="check-row">
            <input
              type="checkbox"
              checked={draft.triggers.onAll}
              onChange={(event) => setTrigger('onAll', event.target.checked)}
            />
            <span>任何角色发言后</span>
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={draft.triggers.mention}
              onChange={(event) => setTrigger('mention', event.target.checked)}
            />
            <span>被 @ 时</span>
          </label>
        </div>

        <div className="field">
          <label>指定角色发言后接过话（按名字匹配）</label>
          <div className="name-chips">
            {names.map((name) => (
              <span key={name} className="name-chip">
                {name}
                <button onClick={() => removeName(name)} aria-label={`移除 ${name}`}>
                  ×
                </button>
              </span>
            ))}
            <input
              className="name-input"
              value={nameInput}
              placeholder={names.length ? '再加一个名字…' : '输入角色名后回车，例如：开发者'}
              onChange={(event) => setNameInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                  event.preventDefault()
                  addName()
                }
              }}
            />
          </div>
          <span className="field-hint">
            按名字而不是 id 匹配，所以角色库模板加到任何房间都能自动接上；房间内改名会同步更新这条规则。
          </span>
        </div>

        {members.length > 0 && (
          <div className="field">
            <label>快速勾选房间成员</label>
            <div className="member-checks">
              {members
                .filter((member) => member.id !== (character && 'id' in character ? character.id : ''))
                .map((member) => (
                  <label key={member.id} className="member-check">
                    <input type="checkbox" checked={names.includes(member.name)} onChange={() => toggleMember(member)} />
                    <span className="member-dot" style={{ background: member.color }} />
                    {member.name}
                  </label>
                ))}
            </div>
          </div>
        )}

        <div className="field">
          <label>关键词触发</label>
          <input
            className="input"
            value={draft.triggers.keyword}
            placeholder="例如：review、修好了（留空则关闭）"
            onChange={(event) => setTrigger('keyword', event.target.value)}
          />
        </div>
      </section>

      <section className="form-section">
        <h4>运行</h4>
        <div className="field">
          <label>工作目录{isLibrary ? '（默认值）' : ''}</label>
          <input
            className="input"
            value={draft.cwd}
            placeholder={room ? `留空则用房间目录：${room.workingDir}` : '留空则用房间目录'}
            onChange={(event) => set('cwd', event.target.value)}
          />
          <span className="field-hint">这个角色执行文件操作、跑命令时所在的目录。</span>
        </div>
        {!isLibrary && (
          <label className="check-row">
            <input type="checkbox" checked={draft.enabled} onChange={(event) => set('enabled', event.target.checked)} />
            <span>启用这个角色（停用后不会自动发言，也不能手动触发）</span>
          </label>
        )}
      </section>
      </Modal>

      {cropSrc && (
        <AvatarCropper
          imageSrc={cropSrc}
          onCancel={() => setCropSrc(null)}
          onConfirm={(dataUrl) => {
            set('avatar', dataUrl)
            setCropSrc(null)
          }}
        />
      )}
    </>
  )
}
