import type { Character, CharacterPreset, HarnessMap } from '../types'
import { Avatar } from './Avatar'
import { HARNESS_META, modelShort, triggerSummary } from '../lib/format'

/**
 * Fields the server-side sync overwrites (db.syncCharacterFromPreset:
 * name/aliases/avatar/color/harness/model/persona/cwd/triggers/
 * commandTemplate/autoApprove); enabled, identity-bound memory and chat
 * history are preserved. Keep the tooltip honest about the blast radius.
 */
const SYNC_COVERAGE = '名字、别名、外观、人设、harness、模型、工作目录、触发规则、命令模板与自动批准'

interface CharacterPanelProps {
  characters: Character[]
  members: Character[]
  presets: CharacterPreset[]
  harnesses: HarnessMap
  activeCharacterId: string | null
  onAdd: () => void
  onPickFromLibrary: () => void
  /**
   * Collapse the panel back off-screen. On phones the panel is a fixed
   * overlay covering the header's toggle button, so without an in-panel
   * collapse control the drawer traps the user once opened.
   */
  onCollapse: () => void
  onEdit: (character: Character) => void
  onRun: (character: Character) => void
  onToggle: (character: Character, enabled: boolean) => void
  onSync: (character: Character) => void
}

export function CharacterPanel({
  characters,
  members,
  presets,
  harnesses,
  activeCharacterId,
  onAdd,
  onPickFromLibrary,
  onCollapse,
  onEdit,
  onRun,
  onToggle,
  onSync,
}: CharacterPanelProps) {
  // Mirrors the router: with no @mention the first *enabled* character takes
  // the user message. The badge below makes that fallback visible.
  const firstEnabledId = characters.find((character) => character.enabled)?.id ?? null

  return (
    <aside className="character-panel">
      <div className="panel-head">
        <div>
          <h3>角色</h3>
          <p>每个角色 = 一个 harness + 一个模型 + 一段人设</p>
        </div>
        <div className="panel-head-actions">
          <button className="btn btn-ghost btn-sm panel-collapse" onClick={onCollapse} title="收起面板" aria-label="收起面板">
            ✕
          </button>
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
          const isDefaultResponder = character.id === firstEnabledId
          // Mirrors the server's sync rule: the linked template (preset_id)
          // wins; otherwise only a *unique* same-name template can be
          // adopted — several presets sharing the name are ambiguous and
          // the route would 409, so the panel must not offer the button.
          const exactPreset = character.presetId
            ? presets.find((preset) => preset.id === character.presetId)
            : undefined
          const sameNamePresets = exactPreset
            ? []
            : presets.filter((preset) => preset.name === character.name)
          const linkedPreset = exactPreset ?? (sameNamePresets.length === 1 ? sameNamePresets[0] : undefined)
          const presetMissing = Boolean(character.presetId) && !linkedPreset
          const presetAmbiguous = !linkedPreset && sameNamePresets.length > 1

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
                    {presetMissing && (
                      <span className="warn-tag" title="角色库里的模板已被删除，无法再对齐">
                        模板已删除
                      </span>
                    )}
                    {presetAmbiguous && (
                      <span
                        className="warn-tag"
                        title="角色库里存在多个同名模板，无法确定对齐目标；请先在角色库里消除重名"
                      >
                        模板重名
                      </span>
                    )}
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
                {isDefaultResponder && (
                  <span
                    className="trigger-chip default-chip"
                    title="没有 @ 任何人时，用户消息默认由这个（第一个启用的）角色接手回复"
                  >
                    用户发言·默认
                  </span>
                )}
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
                {linkedPreset && (
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => onSync(character)}
                    title={
                      exactPreset
                        ? `用角色库模板「${linkedPreset.name}」覆盖${SYNC_COVERAGE}（保留启用状态、长期记忆与聊天历史）`
                        : `关联角色库同名模板「${linkedPreset.name}」并同步：覆盖${SYNC_COVERAGE}（保留启用状态、长期记忆与聊天历史）`
                    }
                  >
                    ↻ 对齐
                  </button>
                )}
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
