import type { CliEvent, ToolTrace } from '../types'
import { buildCliRows } from '../../../server/cli-timeline.ts'
import { formatDuration } from '../lib/format'

interface CliTimelineProps {
  events?: CliEvent[]
  tools?: ToolTrace[]
  /** Live view: status + name + input only, no expanded output. */
  compact?: boolean
}

/** B13: one renderer for every harness — pairing lives in buildCliRows. */
export function CliTimeline({ events, tools, compact = false }: CliTimelineProps) {
  const rows = buildCliRows(events, tools)
  if (rows.length === 0) return null
  return (
    <ul className={`cli-timeline${compact ? ' is-compact' : ''}`}>
      {rows.map((row) => (
        <li key={`${row.id}-${row.at}`} className={`cli-row ${row.running ? 'is-running' : row.ok ? 'is-ok' : 'is-fail'}`}>
          <span className="cli-status" aria-hidden>
            {row.running ? '…' : row.ok ? '✓' : '×'}
          </span>
          <span className="cli-name">{row.name}</span>
          {row.input && (
            <code className="cli-input" title={row.input}>
              {row.input}
            </code>
          )}
          {row.durationMs !== undefined && <span className="cli-duration">{formatDuration(row.durationMs)}</span>}
          {!compact && row.output && (
            <details className="cli-output">
              <summary>输出</summary>
              <pre>{row.output}</pre>
            </details>
          )}
        </li>
      ))}
    </ul>
  )
}
