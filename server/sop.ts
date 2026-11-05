/**
 * SOP gate logic (P0-3 3b/3c): the verdict parser and the gate's decision
 * table. No side effects, no imports beyond mentions — this module is what
 * scripts/sop-check.mjs pins down, so everything behavioral lives here.
 *
 * The verdict convention: a reviewer ends its review with a STANDALONE line
 * `REVIEW: PASS` or `REVIEW: CHANGES` (fullwidth colon and `**` bolding
 * tolerated, case-insensitive). `REVIEW: PASSED` and friends are NOT
 * verdicts — the line must contain verdict and nothing else, otherwise a
 * sentence like "I don't think REVIEW: PASSED is right here" would gate a
 * round shut. Verdicts inside code spans/fences are invisible on purpose:
 * they are quoted text, same rule as @mentions.
 */
import { visibleText } from './mentions.ts'

/** Whole-line verdict: optional `**`/whitespace framing, REVIEW, colon, keyword, nothing else. */
const REVIEW_LINE = /^\s*\**\s*review\s*[:：]\s*\**\s*(pass|changes)\s*\**\s*$/i

export type ReviewVerdict = 'pass' | 'changes'

/** How many trailing non-empty lines of a message are scanned for the verdict. */
export const REVIEW_TAIL_LINES = 5

/**
 * The verdict a message carries, or null. When several tail lines carry a
 * verdict the LAST one wins — "CHANGES → PASS after the fix" is a pass.
 */
export function parseReviewVerdict(content: string): ReviewVerdict | null {
  const plain = visibleText(content)
  const lines = plain
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  let verdict: ReviewVerdict | null = null
  for (const line of lines.slice(-REVIEW_TAIL_LINES)) {
    const match = REVIEW_LINE.exec(line)
    if (match) verdict = match[1].toLowerCase() === 'pass' ? 'pass' : 'changes'
  }
  return verdict
}

export type GateDecision = 'close' | 'run-verify' | 'block'

export interface GateInput {
  /** How many paths changed this round. 0 = a chat-only round. */
  changed: number
  /** Whether the room configured a verification command. */
  verifyRequired: boolean
  /** Outcome of this round's verification run ('none' = not run yet). */
  verify: 'none' | 'pass' | 'fail'
  /** Latest review verdict ('none' = nobody concluded). */
  verdict: 'none' | 'pass' | 'changes'
}

/**
 * The gate's decision table — every row is asserted in sop-check S2:
 *
 * | changed | verifyCommand | verify | verdict | action                     |
 * |---------|---------------|--------|---------|----------------------------|
 * | 0       | any           | any    | any     | close (verify never runs) |
 * | >0      | empty         | —      | other   | block                     |
 * | >0      | empty         | —      | pass    | close                     |
 * | >0      | set           | none   | other   | block (verdict first: no  |
 * |         |               |        |         | wasted verify runs)       |
 * | >0      | set           | none   | pass    | run-verify                |
 * | >0      | set           | fail   | pass    | block                     |
 * | >0      | set           | pass   | pass    | close                     |
 *
 * A changed round closes only with verdict pass AND (no verify command OR a
 * passing verify run). Chat-only rounds close as before — the gate is a
 * worktree gate, not a speech gate.
 */
export function gateDecision(input: GateInput): GateDecision {
  if (input.changed === 0) return 'close'
  // A changed round without a pass verdict never closes, and never burns a
  // verify run first: the verdict is the cheaper precondition.
  if (input.verdict !== 'pass') return 'block'
  if (!input.verifyRequired) return 'close'
  if (input.verify === 'pass') return 'close'
  if (input.verify === 'none') return 'run-verify'
  return 'block'
}
