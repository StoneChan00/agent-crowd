import type { Character, CharacterPreset, HarnessKind, MessageMeta, Triggers } from '../types'

export const HARNESS_META: Record<HarnessKind, { label: string; glyph: string; color: string }> = {
  opencode: { label: 'opencode', glyph: '⌘', color: '#4f9cf9' },
  cannbot: { label: 'CANNBot', glyph: '◆', color: '#f97316' },
  dsh: { label: 'DSH', glyph: '◈', color: '#8b76f6' },
  hermes: { label: 'Hermes', glyph: '✦', color: '#2dd4bf' },
  mock: { label: 'Mock', glyph: '○', color: '#8a8f98' },
  custom: { label: 'Custom', glyph: '⚙', color: '#f0a75a' },
}

export const HARNESS_ORDER: HarnessKind[] = ['cannbot', 'opencode', 'dsh', 'hermes', 'mock', 'custom']

export function clock(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' })
}

export function fullTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString('zh-CN', { hour12: false })
}

export function formatDuration(ms?: number): string {
  if (!ms || ms < 0) return ''
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`
}

export function modelShort(model?: string): string {
  const value = (model ?? '').trim()
  if (!value) return '默认模型'
  const parts = value.split('/')
  return parts.length > 1 ? parts.slice(1).join('/') : value
}

export function tokenSummary(meta?: MessageMeta | null): string {
  const tokens = meta?.tokens
  if (!tokens) return ''
  const input = tokens.input ?? 0
  const output = tokens.output ?? 0
  if (!input && !output) return ''
  return `${input} in / ${output} out`
}

export function triggerSummary(character: Character | CharacterPreset, members: Character[] = []): string[] {
  const triggers: Triggers = character.triggers
  const out: string[] = []
  // Note: `onUser` is deliberately NOT summarized anymore — human messages
  // route by @ (name/alias) with a first-member fallback, so the old
  // "用户消息" chip promised something the router never delivers.
  if (triggers.onAll) out.push('任何角色')

  const names = new Set(triggers.onCharacterNames)
  for (const id of triggers.onCharacters) {
    const member = members.find((item) => item.id === id)
    if (member) names.add(member.name)
  }
  for (const name of names) out.push(`${name} 后`)

  if (triggers.keyword.trim()) out.push(`含「${triggers.keyword.trim()}」`)
  if (triggers.mention) out.push('@我')
  return out.length ? out : ['不自动触发']
}

export function uid(prefix = 'tmp'): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`
}
