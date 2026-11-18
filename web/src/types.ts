export type {
  AuthorType,
  Character,
  CharacterPreset,
  CharacterUsage,
  HarnessKind,
  Memory,
  MemoryKind,
  MemoryScope,
  Message,
  MessageMeta,
  Room,
  RoomUsage,
  Skill,
  Task,
  TaskStatus,
  ToolTrace,
  Triggers,
  Turn,
  TurnTokens,
  UsageTotals,
} from '../../server/types.ts'

/** One skills/*.md entry WITHOUT the body — the editor's checkbox list item (B07). */
export type SkillInfo = Omit<import('../../server/types.ts').Skill, 'body'>

export type { RoomTemplate, TemplateCharacter } from '../../server/room-templates.ts'

export interface HarnessInfo {
  label: string
  available: boolean
  detail: string | null
}

export type HarnessMap = Record<string, HarnessInfo>

/** One MCP server entry, read from a harness CLI's own config file. */
export interface McpServerInfo {
  name: string
  type: string
  enabled: boolean
  detail: string
  source?: string
  timeoutMs?: number
}

export interface McpHarnessInfo {
  label: string
  available: boolean
  sources: string[]
  servers: McpServerInfo[]
  error?: string
  note?: string
}

export type McpMap = Record<string, McpHarnessInfo>

export interface Bootstrap {
  rooms: import('../../server/types.ts').Room[]
  characters: import('../../server/types.ts').Character[]
  presets: import('../../server/types.ts').CharacterPreset[]
  harnesses: HarnessMap
  models: Record<string, string[]>
  busy: Record<string, boolean>
}
