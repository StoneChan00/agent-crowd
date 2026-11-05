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
 * round shut. Verdicts must also be the author's OWN prose: only top-level
 * paragraphs and paragraphs inside list items count, so a verdict that
 * arrives quoted (blockquote `> REVIEW: PASS`, a table cell) or as a
 * heading is not a gate signal — same rule as code fences and link labels:
 * quoted text, never a gate signal.
 */
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfm } from 'micromark-extension-gfm'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { NOT_A_CALL } from './mentions.ts'

/** Whole-line verdict: optional `**`/whitespace framing, REVIEW, colon, keyword, nothing else. */
const REVIEW_LINE = /^\s*\**\s*review\s*[:：]\s*\**\s*(pass|changes)\s*\**\s*$/i

export type ReviewVerdict = 'pass' | 'changes'

/** How many trailing non-empty lines of a message are scanned for the verdict. */
export const REVIEW_TAIL_LINES = 5

/**
 * Line-level verdict-protocol classification (B04 review 3): is this single
 * line, judged OUTSIDE any code block, a whole-line verdict in a shape the
 * gate accepts? Covers the plain form REVIEW_LINE already describes, plus
 * the whole-line CODE SPAN (`` `REVIEW: PASS` `` — agents copy rule 9's
 * example text into backticks; the span's inner text is what the gate
 * reads). PURE line logic, no mdast — memory.ts reuses it so the episode
 * delivery stripper can never drift from the parser a third time.
 */
export function isVerdictProtocolLine(line: string): boolean {
  const trimmed = line.trim()
  if (REVIEW_LINE.test(trimmed)) return true
  const codeSpan = /^(`+)([^`]*)\1$/.exec(trimmed)
  return Boolean(codeSpan && REVIEW_LINE.test(codeSpan[2].trim()))
}

/**
 * Strip gate-protocol verdict lines from raw message text (B04: the episode
 * memory's delivery). Whole-line verdicts in every shape the gate accepts
 * are removed; lines inside FENCED (```/~~~) or INDENTED (4+ spaces after a
 * blank line) code blocks are KEPT — quoted code is content the gate never
 * reads as a verdict, so it must not vanish from the delivery either.
 * Shares isVerdictProtocolLine with the parser; blockquotes and tables never
 * match the line shape and pass through untouched.
 */
export function stripVerdictLines(text: string): string {
  const kept: string[] = []
  let fence: { marker: string; length: number } | null = null
  let inIndentedCode = false
  let prevBlank = true
  for (const raw of text.split('\n')) {
    const fenceHit = /^ {0,3}(`{3,}|~{3,})/.exec(raw)
    if (fence) {
      kept.push(raw)
      if (fenceHit && fenceHit[1][0] === fence.marker && fenceHit[1].length >= fence.length && raw.trim() === fenceHit[1].trim()) {
        fence = null
      }
    } else if (fenceHit) {
      fence = { marker: fenceHit[1][0], length: fenceHit[1].length }
      kept.push(raw)
    } else if (inIndentedCode) {
      kept.push(raw)
      if (raw.trim() !== '' && !/^[ \t]{4,}/.test(raw)) inIndentedCode = false
    } else if (prevBlank && /^[ \t]{4,}\S/.test(raw)) {
      inIndentedCode = true
      kept.push(raw)
    } else if (!isVerdictProtocolLine(raw)) {
      kept.push(raw)
    }
    prevBlank = raw.trim() === ''
  }
  return kept.join('\n')
}

/** Minimal mdast shape — enough for the extraction pass (same trick as mentions.ts). */
interface MdNode {
  type: string
  value?: string
  children?: MdNode[]
}

/**
 * The visible text of ONE paragraph with soft line breaks preserved (they
 * live inside text values; `break` nodes map to `\n`). Code spans are the
 * deliberate exception to the opaque set: their content flows into the
 * line, so a whole line that is just `` `REVIEW: PASS` `` still reads as a
 * verdict — agents copy rule 9's example text into backticks — while
 * `先看 `REVIEW: PASS` 这行` keeps its framing text and matches nothing.
 * Link labels, images and inline html stay invisible exactly like mentions.
 */
function paragraphLines(paragraph: MdNode): string[] {
  const parts: string[] = []
  const walk = (node: MdNode): void => {
    if (node.type === 'break') {
      parts.push('\n')
      return
    }
    if (NOT_A_CALL.has(node.type)) {
      if (node.type === 'inlineCode' && node.value) parts.push(node.value)
      return
    }
    if (node.type === 'text') {
      if (node.value) parts.push(node.value)
      return
    }
    for (const child of node.children ?? []) walk(child)
  }
  for (const child of paragraph.children ?? []) walk(child)
  return parts.join('').split('\n')
}

/**
 * The lines a verdict may live on, in document order: the author's own
 * prose. Top-level paragraphs contribute their lines; list items contribute
 * their (possibly nested) paragraphs' lines. Quoted shapes — blockquotes,
 * table cells, headings, fenced code, html — contribute NOTHING, not even
 * an empty line: a quote near the end must neither carry a verdict nor eat
 * into the tail-lines budget (review round 3: `> REVIEW: PASS` and
 * `| 门禁 | REVIEW: PASS |` both parsed as live verdicts when the extractor
 * only preserved block boundaries and dropped the quoting marks).
 */
function verdictSourceLines(content: string): string[] {
  const lines: string[] = []
  const collect = (node: MdNode): void => {
    if (node.type === 'paragraph') {
      lines.push(...paragraphLines(node))
      return
    }
    if (node.type === 'list' || node.type === 'listItem') {
      for (const child of node.children ?? []) collect(child)
      return
    }
    // Everything else (blockquote, table, heading, code, html, ...) is
    // quoted or structural text — invisible to the verdict scan.
  }
  const root = fromMarkdown(content, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  }) as unknown as MdNode
  for (const child of root.children ?? []) collect(child)
  return lines
}

/**
 * The verdict a message carries, or null. When several tail lines carry a
 * verdict the LAST one wins — "CHANGES → PASS after the fix" is a pass.
 */
export function parseReviewVerdict(content: string): ReviewVerdict | null {
  const lines = verdictSourceLines(content)
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
