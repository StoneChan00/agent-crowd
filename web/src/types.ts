export type {
  AuthorType,
  Character,
  CharacterPreset,
  HarnessKind,
  Memory,
  MemoryKind,
  MemoryScope,
  Message,
  MessageMeta,
  Room,
  ToolTrace,
  Triggers,
  Turn,
  TurnTokens,
} from '../../server/types.ts'

export interface HarnessInfo {
  label: string
  available: boolean
  detail: string | null
}

export type HarnessMap = Record<string, HarnessInfo>

export interface Bootstrap {
  rooms: import('../../server/types.ts').Room[]
  characters: import('../../server/types.ts').Character[]
  presets: import('../../server/types.ts').CharacterPreset[]
  harnesses: HarnessMap
  models: Record<string, string[]>
  busy: Record<string, boolean>
}
