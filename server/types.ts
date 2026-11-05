/** Shared data model for agent-crowd. */

export type HarnessKind =
  | 'mock'
  | 'opencode'
  | 'cannbot'
  | 'dsh'
  | 'hermes'
  | 'claude'
  | 'codex'
  | 'custom'

export const HARNESS_LABELS: Record<HarnessKind, string> = {
  mock: 'Mock（本地演示）',
  opencode: 'opencode',
  cannbot: 'CANNBot',
  dsh: 'DeepSeek Harness',
  hermes: 'Hermes',
  claude: 'Claude Code',
  codex: 'Codex',
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
  /**
   * Post an automatic round-end summary: when a round that ran at least one
   * turn drains (relay chain ended on its own, or the hop budget cut it),
   * this character is queued with a summarization instruction. Manual stops
   * and rounds that never ran a turn never trigger it.
   */
  onRoundEnd: boolean
}

export const DEFAULT_TRIGGERS: Triggers = {
  onUser: true,
  onAll: false,
  onCharacters: [],
  onCharacterNames: [],
  keyword: '',
  mention: true,
  onRoundEnd: false,
}

export interface Room {
  id: string
  name: string
  topic: string
  workingDir: string
  maxHops: number
  createdAt: number
  /**
   * SOP gate (P0-3 3c): verification command the SERVER itself runs before a
   * round with worktree changes may close (shell semantics, room workingDir,
   * 300s budget). Empty = no verification, the gate then only checks the
   * review verdict.
   */
  verifyCommand: string
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
  /** Library template this character was created from; powers the "↻ 同步" refresh. */
  presetId: string | null
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
  /**
   * Names of the characters this reply hands off to, i.e. who the relay
   * actually queues next. Written by the orchestrator's own `shouldWake`
   * verdict, so the UI can show "接力 → …" without re-deriving the rules.
   */
  relayTo?: string[]
  /** Present when this user message is a steer note (「中途补充」). */
  steer?: SteerMeta
  /**
   * Worktree paths this turn changed (SOP gate, P0-3 3a): computed from
   * before/after git snapshots taken by the orchestrator around the turn.
   * Absent on turns that changed nothing; a turn that could not be judged
   * (not a git repo) simply never sets it.
   */
  changed?: string[]
  /**
   * True when this turn rode the character's persisted CLI session
   * (P0-1): the prompt carried only post-cursor messages and the adapter
   * got a resume argument. Absent on full-replay turns.
   */
  resume?: boolean
  /** Task card this system message carries (B03 approval / re-dispatch). */
  taskId?: string
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
  /**
   * Insertion sequence = the messages table's rowid (P0-1 review): monotonic
   * with insert order, and together with `createdAt` the same total order the
   * messages query itself sorts by. The session cursor carries it as the
   * same-millisecond tiebreaker — a bare createdAt cursor would permanently
   * skip any sibling message written within the same ms (scripted clients
   * double-post that fast).
   */
  seq: number
}

export type TurnStatus = 'queued' | 'running' | 'done' | 'error' | 'stopped'

/**
 * Task-card lifecycle (B03): a proposed unit of work a human approves before
 * anything runs. Approval writes `running` SYNCHRONOUSLY — the old fleeting
 * `approved` state is no longer produced (it had no exit when a queued turn
 * was swept; a boot migration flips any legacy row). The SOP gate blocking a
 * round leaves `running` with `result='blocked'`; a crashed or errored turn
 * leaves `running` with `result='error'` — both re-dispatchable.
 */
export type TaskStatus = 'proposed' | 'approved' | 'running' | 'done' | 'rejected'

export interface Task {
  id: string
  roomId: string
  title: string
  /** What to do — lands verbatim in the approval message, i.e. the prompt. */
  what: string
  /** Why it matters — context for the assignee. */
  why: string
  /** Acceptance criteria — delivered into the prompt; judged by humans/review. */
  acceptance: string
  /** Character this card is assigned to; null once that character is deleted. */
  assigneeId: string | null
  status: TaskStatus
  createdAt: number
  approvedAt: number | null
  doneAt: number | null
  /** The round the approval (or re-dispatch) opened — the write-back anchor. */
  roundId: string | null
  /** Settlement note: 'blocked' (SOP gate refused) | 'error' (crashed/errored round); null only on a clean done. */
  result: string | null
}

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
  /**
   * Relay depth at enqueue time (1 = direct target of a human message / manual
   * run, +1 per hand-off). Turns double as the queue, so these three
   * scheduling fields are persisted at enqueue and restored on boot — a
   * restart must not zero the relay budget or retry a turn twice.
   */
  hop: number
  /** Manual instruction for this turn (steer note / run button / round summary); null = none. */
  override: string | null
  /** Loop guard: marks the automatic second attempt so a restart never re-arms it. */
  retry: boolean
  /** Round-end summary turns never relay and don't count as round activity. */
  isRoundSummary: boolean
  /**
   * Round this turn belongs to (SOP gate, P0-3): one roundId per human
   * message / manual run, shared by every relay hand-off it triggers. Null
   * on turns restored by a reboot (their round was cut) and on legacy rows.
   */
  roundId: string | null
  /**
   * Task card this turn executes (B03): set on the approval/dispatch turn
   * and inherited by every relay hand-off of the same round. Null on
   * ordinary chat turns.
   */
  taskId: string | null
  /**
   * Worktree paths this turn changed, JSON-encoded (P0-3 3a); null = the
   * worktree could not be judged (not a git repo) — treated as "unknown",
   * never as "no changes".
   */
  changed: string[] | null
  startedAt: number
  endedAt: number | null
}

export interface ParseResult<T> {
  ok: boolean
  value?: T
  error?: string
}

/**
 * One recorded outcome of the SOP gate (P0-3): either a review verdict the
 * server parsed out of a character message (kind='review') or a run of the
 * room's verification command (kind='verify'). The gate reads the round's
 * latest entries to decide whether a changed round may close.
 */
export interface RoundCheck {
  id: string
  roomId: string
  roundId: string
  kind: 'review' | 'verify'
  verdict: 'pass' | 'fail'
  characterId: string | null
  messageId: string | null
  /** Verify runs keep the output tail here; review rows leave it null. */
  detail: string | null
  createdAt: number
}

/**
 * The CLI session one character rides in one room (session continuity,
 * P0-1): the adapter-reported session id plus the message cursor already
 * delivered into that session. One row per (room, character) — the next
 * turn resumes the CLI session and ships only post-cursor messages, so
 * "the character remembers the last round" without replaying the whole
 * transcript. Swept on character deletion, message clearing, room deletion
 * and harness/model drift.
 */
export interface Session {
  roomId: string
  characterId: string
  /** Harness that produced the session id — drift invalidates the row. */
  harness: HarnessKind
  /** Model the session ran with — drift invalidates the row. */
  model: string
  /** The CLI's own session/thread identifier. */
  sessionId: string
  /**
   * Cursor of the messages already delivered into the session: createdAt of
   * the newest one, plus its seq as the same-millisecond tiebreaker (see
   * Message.seq — the pair is what "already delivered" compares on).
   */
  consumedAt: number
  consumedSeq: number
  /** How many successful turns have ridden (re)written this row. */
  turns: number
  createdAt: number
  updatedAt: number
}
