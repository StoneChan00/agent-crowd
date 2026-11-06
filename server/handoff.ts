import type { Handoff } from './types.ts'

/**
 * B06: the five-tuple relay handoff, as a PURE function — zero model calls,
 * zero db reads (the orchestrator fetches the card fields and passes them
 * in). The data whitelist is the contract (workspace/backlog.md B06):
 *
 *   What          ← the round's delivery line + the first 5 changed paths
 *   Why           ← only when the round executes a task card: the card's why
 *   Tradeoff      ← no data source exists — permanently empty
 *   Open Questions← only from KNOWN pending states: the card is not yet
 *                   accepted, the room's verify command has not yet run.
 *                   Anything else is invention — omitted.
 *   Next Action   ← the card's acceptance when one exists; otherwise the
 *                   generic relay instruction.
 *
 * Deliberately ABSENT: gate conclusions ("门禁已通过/被拦") — the gate runs
 * at queue-drain, NOT at handoff time, so a handoff stating one would be
 * a guess about the future.
 *
 * Truncation happens HERE (not at render): each field ≤ HANDOFF_FIELD_MAX,
 * total ≤ HANDOFF_TOTAL_MAX — the persisted meta and the injected prompt
 * can never disagree about size.
 */
export const HANDOFF_FIELD_MAX = 200
export const HANDOFF_TOTAL_MAX = 800
/** Paths listed verbatim in `what` before the "等 N 个" style rollover. */
const HANDOFF_PATHS_LISTED = 5

export interface HandoffInput {
  /** The round's delivery line INCLUDING this turn's (already verdict-stripped). */
  lastDelivery: string
  /** The round's cumulative changed paths, this turn included. */
  changedPaths: string[]
  /** Task card this round executes, if any. */
  taskId: string | null
  /** The card's why — fetched by the caller; null without a card. */
  taskWhy: string | null
  /** The card's acceptance — fetched by the caller; null without a card. */
  taskAcceptance: string | null
  /** The room has a verify command configured. */
  verifyConfigured: boolean
  /** The round has not run its verification yet. */
  verifyPending: boolean
}

/** Cap one field: hard slice + ellipsis, so the marker is always readable. */
function cap(text: string): string {
  return text.length > HANDOFF_FIELD_MAX ? `${text.slice(0, HANDOFF_FIELD_MAX - 1)}…` : text
}

/** Total budget: shave the overflow (deterministically, from `what` first). */
function enforceTotal(handoff: Handoff): Handoff {
  const order: Array<keyof Omit<Handoff, 'tradeoff'>> = ['what', 'openQuestions', 'why', 'nextAction']
  let total = order.reduce((sum, key) => sum + handoff[key].length, 0)
  let over = total - HANDOFF_TOTAL_MAX
  if (over <= 0) return handoff
  const next = { ...handoff }
  for (const key of order) {
    if (over <= 0) break
    const room = next[key].length
    const cut = Math.min(room, over)
    next[key] = cap(next[key].slice(0, room - cut))
    over -= cut
  }
  return next
}

export function buildHandoff(input: HandoffInput): Handoff {
  // What: delivery + paths (dedup, first 5 listed verbatim, rollover note).
  const paths = [...new Set(input.changedPaths)].slice(0, HANDOFF_PATHS_LISTED)
  const pathText = paths.length
    ? `改动：${paths.join('、')}${input.changedPaths.length > HANDOFF_PATHS_LISTED ? ` 等 ${input.changedPaths.length} 个` : ''}`
    : ''
  const what = cap([input.lastDelivery.trim(), pathText].filter(Boolean).join('；'))

  // Why: card-only source.
  const why = cap(input.taskId ? (input.taskWhy ?? '').trim() : '')

  // Tradeoff: no source, permanently empty.
  const tradeoff = ''

  // Open Questions: known pending states only.
  const openParts: string[] = []
  if (input.taskId) openParts.push('任务卡尚未验收')
  if (input.verifyConfigured && input.verifyPending) openParts.push('房间配置的验证命令尚未运行')
  const openQuestions = cap(openParts.join('；'))

  // Next Action: the card's acceptance when one exists, else the generic
  // relay instruction.
  const GENERIC_NEXT = '接手本轮并给出 REVIEW 结论'
  const nextAction = cap(
    input.taskId ? (input.taskAcceptance ?? '').trim() || GENERIC_NEXT : GENERIC_NEXT,
  )

  return enforceTotal({ what, why, tradeoff, openQuestions, nextAction })
}
