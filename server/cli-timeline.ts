import type { CliEvent, ToolTrace } from './types.ts'

/** One rendered tool row, paired from tool_use/tool_result by id (B13). */
export interface CliRow {
  id: string
  name: string
  input?: string
  ok: boolean
  running: boolean
  output?: string
  durationMs?: number
  at: number
}

const MAX_ROWS = 100

/**
 * Build the CLI timeline. Prefers the structured event list; old messages
 * (only `tools`) degrade to one completed row per trace. Keeping this pure
 * makes the pairing rules testable without a DOM.
 */
export function buildCliRows(events?: CliEvent[], tools?: ToolTrace[]): CliRow[] {
  if (events && events.length > 0) {
    const rows: CliRow[] = []
    const byId = new Map<string, CliRow>()
    for (const event of events) {
      if (event.kind === 'tool_use') {
        const row: CliRow = {
          id: event.id,
          name: event.name,
          input: event.input,
          ok: true,
          running: true,
          at: event.at,
        }
        byId.set(event.id, row)
        rows.push(row)
      } else {
        const row = byId.get(event.id)
        if (row) {
          row.ok = event.ok
          row.running = false
          row.output = event.output
          row.durationMs = event.durationMs
          if (!row.name) row.name = event.name
        } else {
          rows.push({
            id: event.id,
            name: event.name,
            ok: event.ok,
            running: false,
            output: event.output,
            durationMs: event.durationMs,
            at: event.at,
          })
        }
      }
    }
    return rows.slice(-MAX_ROWS)
  }
  return (tools ?? []).slice(-MAX_ROWS).map((tool, index) => ({
    id: tool.id ?? `${tool.name}-${index}`,
    name: tool.name,
    input: tool.input,
    ok: tool.ok,
    running: false,
    output: tool.detail,
    durationMs: tool.durationMs,
    at: index,
  }))
}
