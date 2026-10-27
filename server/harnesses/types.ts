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
  error?: string
}

export interface HarnessAdapter {
  id: HarnessKind
  label: string
  run(input: RunInput): Promise<RunOutput>
  /** Models this harness can offer in the character editor. */
  listModels?(): Promise<string[]>
}
