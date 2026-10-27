import { useState } from 'react'
import type { CharacterPreset } from '../types'
import { Modal } from './Modal'
import { Avatar } from './Avatar'
import { HARNESS_META, modelShort, triggerSummary } from '../lib/format'

interface PresetPickerProps {
  presets: CharacterPreset[]
  existingNames: string[]
  roomName: string
  onClose: () => void
  onAdd: (presetIds: string[]) => Promise<void>
}

export function PresetPicker({ presets, existingNames, roomName, onClose, onAdd }: PresetPickerProps) {
  const [selected, setSelected] = useState<string[]>([])
  const [saving, setSaving] = useState(false)

  const already = new Set(existingNames)
  const toggle = (id: string) =>
    setSelected((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]))

  const submit = async () => {
    if (selected.length === 0) return
    setSaving(true)
    try {
      await onAdd(selected)
      onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title="从角色库添加"
      subtitle={`把模板复制进「${roomName}」；已存在的同名角色会跳过`}
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <button className="btn btn-ghost" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" onClick={submit} disabled={selected.length === 0 || saving}>
            {saving ? '添加中…' : `添加 ${selected.length || ''} 个角色`}
          </button>
        </>
      }
    >
      <div className="picker-list">
        {presets.map((preset) => {
          const exists = already.has(preset.name)
          const meta = HARNESS_META[preset.harness]
          return (
            <label key={preset.id} className={`picker-item${exists ? ' is-disabled' : ''}`}>
              <input
                type="checkbox"
                disabled={exists}
                checked={selected.includes(preset.id)}
                onChange={() => toggle(preset.id)}
              />
              <Avatar emoji={preset.avatar} color={preset.color} size={34} />
              <div className="picker-id">
                <div className="picker-name">
                  {preset.name}
                  {exists && <span className="picker-exists">已在房间</span>}
                </div>
                <div className="character-tags">
                  <span className={`harness-chip harness-${preset.harness}`}>
                    {meta.glyph} {meta.label}
                  </span>
                  <span className="model-tag">{modelShort(preset.model)}</span>
                </div>
                <div className="picker-triggers">
                  {triggerSummary(preset).map((trigger) => (
                    <span key={trigger} className="trigger-chip">
                      {trigger}
                    </span>
                  ))}
                </div>
              </div>
            </label>
          )
        })}
        {presets.length === 0 && <div className="empty-hint">角色库是空的，先去「角色库」建几个角色。</div>}
      </div>
    </Modal>
  )
}
