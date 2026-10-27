/** Small shared helpers. */

export function pickDefined<T extends object>(patch: T): Partial<T> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) out[key] = value
  }
  return out as Partial<T>
}

export function truncate(text: string, max: number, suffix = '…'): string {
  if (text.length <= max) return text
  return text.slice(0, Math.max(0, max - suffix.length)) + suffix
}

export function formatClock(ts: number): string {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false })
}

export function safeJsonParse<T>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T
  } catch {
    return undefined
  }
}

/** Strip ANSI escape sequences that CLI tools write to stderr. */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
}
