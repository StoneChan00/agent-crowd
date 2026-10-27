import type { CharacterPreset, HarnessMap } from '../types'
import { Avatar } from './Avatar'
import { HARNESS_META, modelShort, triggerSummary } from '../lib/format'

interface LibraryViewProps {
  presets: CharacterPreset[]
  harnesses: HarnessMap
  onCreate: () => void
  onEdit: (preset: CharacterPreset) => void
  onDelete: (preset: CharacterPreset) => void
}

export function LibraryView({ presets, harnesses, onCreate, onEdit, onDelete }: LibraryViewProps) {
  return (
    <div className="library">
      <header className="library-head">
        <div>
          <h2>角色库</h2>
          <p>全局维护角色模板：harness、模型、人设、默认触发规则。房间里的「从角色库添加」可以直接勾选多个加入。</p>
        </div>
        <button className="btn btn-primary" onClick={onCreate}>
          + 新建角色
        </button>
      </header>

      <div className="library-grid">
        {presets.map((preset) => {
          const meta = HARNESS_META[preset.harness]
          const available = harnesses[preset.harness]?.available ?? true
          return (
            <article key={preset.id} className="library-card">
              <div className="library-card-top">
                <Avatar emoji={preset.avatar} color={preset.color} size={44} />
                <div className="library-card-id">
                  <strong>{preset.name}</strong>
                  <div className="character-tags">
                    <span className={`harness-chip harness-${preset.harness}`}>
                      {meta.glyph} {meta.label}
                    </span>
                    <span className="model-tag" title={preset.model}>
                      {modelShort(preset.model)}
                    </span>
                    {!available && <span className="warn-tag">未安装</span>}
                  </div>
                </div>
              </div>

              <p className="library-persona">{preset.persona || '（还没写人设）'}</p>

              <div className="trigger-row">
                {triggerSummary(preset).map((trigger) => (
                  <span key={trigger} className="trigger-chip">
                    {trigger}
                  </span>
                ))}
              </div>

              <div className="library-card-actions">
                <button className="btn btn-ghost btn-sm" onClick={() => onEdit(preset)}>
                  编辑
                </button>
                <button className="btn btn-danger-ghost btn-sm" onClick={() => onDelete(preset)}>
                  删除
                </button>
              </div>
            </article>
          )
        })}

        {presets.length === 0 && (
          <div className="library-empty">
            <p>角色库还是空的。把常用的角色（开发者、审查者、文档助手…）在这里配一次，之后每个房间一键添加。</p>
            <button className="btn btn-primary" onClick={onCreate}>
              + 新建第一个角色
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
