import type { Character, HarnessMap } from '../types'
import { Avatar } from './Avatar'
import { HARNESS_META, modelShort, triggerSummary } from '../lib/format'

interface CharacterPanelProps {
  characters: Character[]
  members: Character[]
  harnesses: HarnessMap
  activeCharacterId: string | null
  onAdd: () => void
  onPickFromLibrary: () => void
  onEdit: (character: Character) => void
  onRun: (character: Character) => void
  onToggle: (character: Character, enabled: boolean) => void
}

export function CharacterPanel({
  characters,
  members,
  harnesses,
  activeCharacterId,
  onAdd,
  onPickFromLibrary,
  onEdit,
  onRun,
  onToggle,
}: CharacterPanelProps) {
  return (
    <aside className="character-panel">
      <div className="panel-head">
        <div>
          <h3>角色</h3>
          <p>每个角色 = 一个 harness + 一个模型 + 一段人设</p>
        </div>
        <div className="panel-head-actions">
          <button className="btn btn-ghost btn-sm" onClick={onPickFromLibrary} title="从角色库批量添加">
            角色库
          </button>
          <button className="btn btn-primary btn-sm" onClick={onAdd}>
            + 新建
          </button>
        </div>
      </div>

      <div className="character-list">
        {characters.map((character) => {
          const meta = HARNESS_META[character.harness]
          const available = harnesses[character.harness]?.available ?? true
          const triggers = triggerSummary(character, members)
          const isActive = character.id === activeCharacterId

          return (
            <div
              key={character.id}
              className={`character-card${character.enabled ? '' : ' is-off'}${isActive ? ' is-active' : ''}`}
            >
              <div className="character-top">
                <Avatar emoji={character.avatar} color={character.color} size={40} glow={isActive} />
                <div className="character-id">
                  <div className="character-name-row">
                    <span className="character-name">{character.name}</span>
                    <label className="switch" title={character.enabled ? '已启用' : '已停用'}>
                      <input
                        type="checkbox"
                        checked={character.enabled}
                        onChange={(event) => onToggle(character, event.target.checked)}
                      />
                      <span className="switch-track" />
                    </label>
                  </div>
                  <div className="character-tags">
                    <span className={`harness-chip harness-${character.harness}`}>
                      {meta.glyph} {meta.label}
                    </span>
                    <span className="model-tag" title={character.model}>
                      {modelShort(character.model)}
                    </span>
                    {!available && <span className="warn-tag">未安装</span>}
                    {character.aliases.map((alias) => (
                      <span key={alias} className="alias-tag" title={`@${alias} 也能唤醒 ${character.name}`}>
                        @{alias}
                      </span>
                    ))}
                  </div>
                </div>
              </div>

              {character.persona && <p className="character-persona">{character.persona.split('\n')[0]}</p>}

              <div className="trigger-row">
                {triggers.map((trigger) => (
                  <span key={trigger} className="trigger-chip">
                    {trigger}
                  </span>
                ))}
              </div>

              <div className="character-actions">
                <button className="btn btn-ghost btn-sm" onClick={() => onEdit(character)}>
                  编辑
                </button>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => onRun(character)}
                  disabled={isActive}
                  title="立即让它读一遍群聊并发言"
                >
                  {isActive ? '运行中' : '▶ 发言'}
                </button>
              </div>
            </div>
          )
        })}

        {characters.length === 0 && (
          <div className="empty-hint">还没有角色，新建一个，选好 harness 和模型。</div>
        )}
      </div>

      <div className="panel-foot">
        <p>
          用户消息按 @ 路由：@名字 / @别名 点名、@all 唤醒全体、没人被 @ 时由第一个启用的角色接手。
          角色发言后，再按各自身上的接力规则（任何角色 / 指定角色后 / 关键词 / @我）自动接话。
        </p>
      </div>
    </aside>
  )
}
