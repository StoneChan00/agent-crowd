import type { CliEvent, ToolTrace } from '../types.ts'
import type { AdapterEvent } from './types.ts'

/**
 * B13: one small state machine shared by every adapter. It records the
 * ordered tool timeline for the final message AND returns the live event the
 * orchestrator broadcasts, so adapters never invent their own pairing logic.
 */
export interface ToolTimeline {
  events: CliEvent[]
  tools: ToolTrace[]
  open: Map<string, { name: string; input?: string; at: number }>
}

export function createTimeline(): ToolTimeline {
  return { events: [], tools: [], open: new Map() }
}

function clip(value: string | undefined, max: number): string | undefined {
  if (!value) return undefined
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** Record a tool start; returns the live event to emit. */
export function beginTool(
  timeline: ToolTimeline,
  id: string,
  name: string,
  input?: string,
  at = Date.now(),
): AdapterEvent {
  const shown = clip(input, 200)
  timeline.open.set(id, { name, input: shown, at })
  timeline.events.push({ kind: 'tool_use', id, name, input: shown, at })
  return {
    kind: 'tool',
    text: shown ? `调用 ${name} ${clip(shown, 60)}` : `调用 ${name}`,
    phase: 'use',
    toolId: id,
    toolName: name,
    toolInput: shown,
    at,
  }
}

/** Record a tool result; pairs with its beginTool by id. */
export function endTool(
  timeline: ToolTimeline,
  id: string,
  name: string,
  ok: boolean,
  output?: string,
  durationMs?: number,
  at = Date.now(),
): AdapterEvent {
  const started = timeline.open.get(id)
  timeline.open.delete(id)
  const shown = clip(output, 400)
  const duration = durationMs ?? (started ? at - started.at : undefined)
  timeline.events.push({ kind: 'tool_result', id, name, ok, output: shown, durationMs: duration, at })
  timeline.tools.push({
    id,
    name,
    ok,
    detail: shown,
    durationMs: duration,
    input: started?.input,
  })
  return {
    kind: 'tool',
    text: `${ok ? '完成' : '失败'} ${name}`,
    phase: 'result',
    toolId: id,
    toolName: name,
    toolOk: ok,
    toolOutput: shown,
    toolDurationMs: duration,
    at,
  }
}
