/** Shared data model for agent-crowd. */

export type HarnessKind = 'mock' | 'opencode' | 'cannbot' | 'dsh' | 'hermes' | 'custom'

export const HARNESS_LABELS: Record<HarnessKind, string> = {
  mock: 'Mock（本地演示）',
  opencode: 'opencode',
  cannbot: 'CANNBot',
  dsh: 'DeepSeek Harness',
  hermes: 'Hermes',
  custom: '自定义命令',
}

/** Which messages wake this character up. */
export interface Triggers {
  /** Wake on any human message. */
  onUser: boolean
  /** Wake on any other character's message. */
  onAll: boolean
  /** Wake when one of these character ids posts. */
  onCharacters: string[]
  /** Same rule by display name; this is what makes a preset portable across rooms. */
  onCharacterNames: string[]
  /** Wake when a message contains this text (case-insensitive). Empty = off. */
  keyword: string
  /** Wake when the message contains `@<name>`. */
  mention: boolean
}

export const DEFAULT_TRIGGERS: Triggers = {
  onUser: true,
  onAll: false,
  onCharacters: [],
  onCharacterNames: [],
  keyword: '',
  mention: true,
}

export interface Room {
  id: string
  name: string
  topic: string
  workingDir: string
  maxHops: number
  createdAt: number
}

/**
 * A cross-room persistent identity ("这是谁"的稳定锚点): every character with
 * the same name binds to the same identity row, so memories written in one
 * room follow the character everywhere.
 */
export interface Identity {
  id: string
  name: string
  avatar: string
  color: string
  persona: string
  createdAt: number
}

export type MemoryScope = 'identity' | 'room'
export type MemoryKind = 'fact' | 'decision' | 'preference' | 'episode'

export const MEMORY_KIND_LABELS: Record<MemoryKind, string> = {
  fact: '事实',
  decision: '决议',
  preference: '偏好',
  episode: '经历',
}

/** One long-term memory entry; scope+owner decides who sees it. */
export interface Memory {
  id: string
  scope: MemoryScope
  ownerId: string
  kind: MemoryKind
  content: string
  sourceRoomId: string | null
  pinned: boolean
  useCount: number
  createdAt: number
  lastUsedAt: number | null
}

export interface Character {
  id: string
  roomId: string
  name: string
  /** Extra @names that wake this character, e.g. ['鱼哥', 'dsh']. */
  aliases: string[]
  avatar: string
  color: string
  harness: HarnessKind
  model: string
  persona: string
  /** Per-character working directory override; empty = room working directory. */
  cwd: string
  triggers: Triggers
  /** Only used by the `custom` harness: `{prompt}`, `{model}`, `{cwd}` placeholders. */
  commandTemplate: string
  /** Auto-approve tool calls so the agent can work without a human at the keyboard. */
  autoApprove: boolean
  enabled: boolean
  /** Cross-room identity anchor (long-term memory owner); bound on first turn. */
  identityId: string | null
  createdAt: number
}

/**
 * A room-independent character template ("角色库"). Trigger references are
 * stored by name so the same preset can be dropped into any room.
 */
export interface CharacterPreset {
  id: string
  name: string
  /** Extra @names that wake this character once imported into a room. */
  aliases: string[]
  avatar: string
  color: string
  harness: HarnessKind
  model: string
  persona: string
  cwd: string
  triggers: Triggers
  commandTemplate: string
  autoApprove: boolean
  createdAt: number
}

export interface TurnTokens {
  input?: number
  output?: number
  total?: number
  cacheRead?: number
  cacheWrite?: number
}

export interface ToolTrace {
  name: string
  ok: boolean
  detail?: string
  durationMs?: number
}

/** Marks a user message as a mid-turn steer note aimed at one character. */
export interface SteerMeta {
  targetId: string
  targetName: string
}

export interface MessageMeta {
  harness?: HarnessKind
  model?: string
  turnId?: string
  durationMs?: number
  exitCode?: number
  /** Pid of the CLI process that produced this message. */
  pid?: number
  sessionId?: string
  tokens?: TurnTokens
  thinking?: string
  error?: string
  tools?: ToolTrace[]
  /** True when the message was written by a character's harness run. */
  generated?: boolean
  /** Present when this user message is a steer note (「中途补充」). */
  steer?: SteerMeta
}

export type AuthorType = 'user' | 'character' | 'system'

export interface Message {
  id: string
  roomId: string
  authorType: AuthorType
  characterId: string | null
  authorName: string
  authorAvatar: string
  color: string
  content: string
  meta: MessageMeta | null
  createdAt: number
}

export type TurnStatus = 'queued' | 'running' | 'done' | 'error' | 'stopped'

export interface Turn {
  id: string
  roomId: string
  characterId: string
  status: TurnStatus
  triggerMessageId: string | null
  output: string
  error: string | null
  /** Pid of the CLI process behind this turn; persisted while running so the boot sweep can reap orphaned trees after a hard kill. */
  pid: number | null
  startedAt: number
  endedAt: number | null
}

export interface ParseResult<T> {
  ok: boolean
  value?: T
  error?: string
}
