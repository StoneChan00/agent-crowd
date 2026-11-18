import type { Character, HarnessKind, Room, ToolTrace, TurnTokens } from '../types.ts'

export interface AdapterEvent {
  kind: 'text' | 'thinking' | 'tool' | 'status'
  text: string
}

export interface RunInput {
  character: Character
  room: Room
  /** Fully composed prompt for this turn. */
  prompt: string
  /** Absolute working directory the harness should run in. */
  cwd: string
  /**
   * Session continuity (P0-1): present when this turn rides the character's
   * persisted CLI session — the adapter passes `resumeArgs(id)` to its CLI
   * so the run continues where the last one ended. Absent = full replay.
   */
  resume?: { id: string }
  signal: AbortSignal
  emit: (event: AdapterEvent) => void
  /** Receives the spawned CLI's pid, so the room can display it live. */
  onSpawn?: (pid: number) => void
}

export interface RunOutput {
  text: string
  thinking?: string
  toolTraces?: ToolTrace[]
  sessionId?: string
  /** Pid of the CLI process that served this turn. */
  pid?: number
  tokens?: TurnTokens
  exitCode: number
  durationMs: number
  /**
   * Rigid error contract, consumed by the orchestrator's turn pump:
   * - non-empty = the turn FAILED. `error && empty text` → turn status
   *   `error` + a system failure message (with one fast-fail auto-retry);
   *   `error && partial text` (e.g. hard timeout) → the text still lands as
   *   the character's message, flagged via meta.error.
   * - In BOTH cases the orchestrator never enqueues followers: a broken or
   *   half-finished reply must not chain the room on.
   * - Adapters MUST guarantee a non-empty error on every known failure path
   *   (claude `result.is_error` with/without an `error` string, non-zero
   *   exit without usable text, timeout, spawn failure). Never return an
   *   empty error from a failed run.
   */
  error?: string
  /**
   * True when the run was killed by the idle watchdog or the hard cap —
   * the CLI's own session SURVIVES the kill on disk, so the orchestrator
   * can resume it once instead of settling for the truncated reply.
   */
  timedOut?: boolean
}

export interface HarnessAdapter {
  id: HarnessKind
  label: string
  run(input: RunInput): Promise<RunOutput>
  /**
   * Session continuity (P0-1): the argv fragment that resumes a prior CLI
   * session. DECLARING it is the capability marker — the orchestrator only
   * rides a stored session when this exists, and it must only exist for
   * flags actually verified against the CLI's own --help (never guessed).
   * Returns null when the adapter cannot resume this id after all.
   */
  resumeArgs?: (id: string) => string[] | null
  /** Models this harness can offer in the character editor. */
  listModels?(): Promise<string[]>
}
