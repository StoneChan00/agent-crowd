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
import type { HarnessKind } from './types.ts'

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
 * reads). Used by stripVerdictLines on EXTRACTED paragraph lines, where
 * mdast has already stripped list markers and code-span backticks.
 */
export function isVerdictProtocolLine(line: string): boolean {
  const trimmed = line.trim()
  if (REVIEW_LINE.test(trimmed)) return true
  const codeSpan = /^(`+)([^`]*)\1$/.exec(trimmed)
  return Boolean(codeSpan && REVIEW_LINE.test(codeSpan[2].trim()))
}

/**
 * A paragraph's verdict-source lines with the raw source span each one came
 * from (B04 review 5). THE line extractor — verdictSourceLines (the gate)
 * and stripVerdictLines (the episode delivery) both go through here, so the
 * two can never disagree about where lines break again. The drift this
 * replaced: mdast keeps newlines inside inlineCode values, and a second
 * hand-rolled split read them differently from the gate's join-then-split.
 *
 * Line semantics = a plain join-then-split: text and inlineCode values both
 * break lines at embedded newlines; break nodes end lines. Spans: a line
 * from ordinary text maps to its raw line(s); a line built from a
 * MULTI-LINE inlineCode carries that node's WHOLE start..end range — a
 * verdict inside a code span deletes the entire span, because deleting half
 * of one strands its backticks.
 */
function paragraphLineSpans(paragraph: MdNode): { lines: string[]; spans: Array<{ start: number; end: number }> } {
  let raw = paragraph.position?.start.line ?? 1
  let current = ''
  let lineStart = raw
  let widen: { start: number; end: number } | null = null
  const lines: string[] = []
  const spans: Array<{ start: number; end: number }> = []
  const finishLine = (): void => {
    lines.push(current)
    spans.push(
      widen
        ? { start: Math.min(lineStart, widen.start), end: Math.max(raw, widen.end) }
        : { start: lineStart, end: raw },
    )
    current = ''
    widen = null
    lineStart = raw
  }
  const appendSplit = (value: string, whole?: { start: number; end: number }): void => {
    value.split('\n').forEach((segment, index) => {
      if (index > 0) {
        finishLine()
        raw += 1
        lineStart = raw
      }
      if (whole) widen = whole
      current += segment
    })
  }
  const walk = (node: MdNode): void => {
    if (node.type === 'break') {
      const at = node.position?.start.line ?? raw
      raw = Math.max(raw, at)
      finishLine()
      raw = Math.max(raw, at + 1)
      lineStart = raw
      return
    }
    if (NOT_A_CALL.has(node.type)) {
      if (node.type === 'inlineCode' && node.value) {
        const start = node.position?.start.line ?? raw
        const end = node.position?.end.line ?? raw
        // Multi-line code span: its value splits into several extracted
        // lines, and each carries the WHOLE node range for deletion.
        appendSplit(node.value, end > start ? { start, end } : undefined)
        raw = Math.max(raw, end)
        return
      }
      const end = node.position?.end.line
      if (end && end > raw) raw = end
      return
    }
    if (node.type === 'text') {
      appendSplit(node.value ?? '')
      const end = node.position?.end.line
      if (end && end > raw) raw = end
      return
    }
    for (const child of node.children ?? []) walk(child)
  }
  for (const child of paragraph.children ?? []) walk(child)
  finishLine()
  return { lines, spans }
}

/**
 * Strip gate-protocol verdict lines from raw message text (B04: the episode
 * memory's delivery). One mdast pass, the SAME traversal shape the verdict
 * extractor reads (paragraphs, including inside list items — the gate
 * accepts `- REVIEW: PASS`; blockquotes, tables, headings, fenced/indented
 * code and html contribute nothing and are kept verbatim as content). Each
 * extracted line that is a verdict marks its raw line span for removal —
 * list markers, code-span backticks and multi-line code spans included via
 * the position mapping, so the stripping judgment can never drift from the
 * parser's again.
 */
export function stripVerdictLines(text: string): string {
  const drop = new Set<number>()
  const root = fromMarkdown(text, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  }) as unknown as MdNode
  const collect = (node: MdNode): void => {
    if (node.type === 'paragraph') {
      const { lines, spans } = paragraphLineSpans(node)
      lines.forEach((line, index) => {
        if (!isVerdictProtocolLine(line)) return
        for (let raw = spans[index].start; raw <= spans[index].end; raw += 1) drop.add(raw)
      })
      return
    }
    if (node.type === 'list' || node.type === 'listItem') {
      for (const child of node.children ?? []) collect(child)
      return
    }
    // Everything else (blockquote, table, heading, code, html, ...) is
    // quoted or structural text — content, never stripped.
  }
  for (const child of root.children ?? []) collect(child)
  return text
    .split('\n')
    .filter((_, index) => !drop.has(index + 1))
    .join('\n')
}

/** Minimal mdast shape — enough for the extraction pass (same trick as mentions.ts). */
interface MdNode {
  type: string
  value?: string
  children?: MdNode[]
  position?: { start: { line: number }; end: { line: number } }
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
 *
 * B04 review 5: the line extraction itself is paragraphLineSpans — the ONE
 * implementation, shared with stripVerdictLines. A second hand-rolled
 * line-split (paragraphLines, deleted) read multi-line inlineCode values
 * differently and let the gate and the delivery stripper drift.
 */
function verdictSourceLines(content: string): string[] {
  const lines: string[] = []
  const collect = (node: MdNode): void => {
    if (node.type === 'paragraph') {
      lines.push(...paragraphLineSpans(node).lines)
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

/**
 * Who a gate judgment is about (B05): a character's stable identity plus its
 * harness — the self-review ban needs both (id for "same character", harness
 * for "same model family ≠ independent judge").
 */
export interface GateAuthor {
  id: string
  harness: HarnessKind
}

export interface GateInput {
  /** How many paths changed this round. 0 = a chat-only round. */
  changed: number
  /** Whether the room configured a verification command. */
  verifyRequired: boolean
  /** Outcome of this round's verification run ('none' = not run yet). */
  verify: 'none' | 'pass' | 'fail'
  /** Latest review verdict ('none' = nobody concluded). */
  verdict: 'none' | 'pass' | 'changes'
  /** Author of that verdict (B05); null/absent while verdict isn't 'pass'. */
  verdictAuthor?: GateAuthor | null
  /** Author of the round's last turn that changed the worktree (B05). */
  changedAuthor?: GateAuthor | null
  /** The room's designated reviewer (B05); null = no designation. */
  reviewer?: GateAuthor | null
}

/** Why a gate blocked, for the notice text. null = not blocked. */
export type GateBlockReason =
  | 'self-review'
  | 'wrong-reviewer'
  | 'same-harness'
  | 'no-author'
  | 'changes'
  | 'verify-fail'
  | 'no-verdict'

export interface GateOutcome {
  action: GateDecision
  reason: GateBlockReason | null
}

/**
 * The gate's decision table — the ONE place a round's fate is decided. Every
 * row is asserted in sop-check S2 (incl. the B05 author dimension):
 *
 * | changed | verifyCommand | verify | verdict | authorship            | action          |
 * |---------|---------------|--------|---------|-----------------------|-----------------|
 * | 0       | any           | any    | any     | — (never checked)     | close           |
 * | >0      | any           | any    | other   | —                     | block           |
 * | >0      | any           | any    | pass    | author unknown        | block (fail     |
 * |         |               |        |         |                       | closed)         |
 * | >0      | any           | any    | pass    | PASS from implementer | block           |
 * | >0      | any           | any    | pass    | PASS ≠ designated     | block           |
 * | >0      | any           | any    | pass    | reviewer same harness | block           |
 * | >0      | empty         | —      | pass    | independent PASS      | close           |
 * | >0      | set           | none   | pass    | independent PASS      | run-verify      |
 * | >0      | set           | fail   | pass    | independent PASS      | block           |
 * | >0      | set           | pass   | pass    | independent PASS      | close           |
 *
 * B05 authorship (checked once verdict === 'pass', BEFORE verify): without a
 * designated reviewer the PASS author must simply differ from the round's
 * last implementer. A designated reviewer adds two rules: the PASS must come
 * from that character, and its harness must differ from the implementer's
 * (same harness ≠ independent judgment). Chat-only rounds (changed = 0)
 * never check authorship.
 */
export function gateDecision(input: GateInput): GateOutcome {
  if (input.changed === 0) return { action: 'close', reason: null }
  // A changed round without a pass verdict never closes, and never burns a
  // verify run first: the verdict is the cheaper precondition.
  if (input.verdict !== 'pass') {
    return { action: 'block', reason: input.verdict === 'changes' ? 'changes' : 'no-verdict' }
  }
  // B05: a PASS without a recorded author (or an implementer without one) is
  // an internal inconsistency — fail closed rather than wave it through.
  if (input.verdictAuthor == null || input.changedAuthor == null) {
    return { action: 'block', reason: 'no-author' }
  }
  if (input.verdictAuthor.id === input.changedAuthor.id) {
    return { action: 'block', reason: 'self-review' }
  }
  if (input.reviewer) {
    if (input.verdictAuthor.id !== input.reviewer.id) {
      return { action: 'block', reason: 'wrong-reviewer' }
    }
    if (input.reviewer.harness === input.changedAuthor.harness) {
      return { action: 'block', reason: 'same-harness' }
    }
  }
  if (!input.verifyRequired) return { action: 'close', reason: null }
  if (input.verify === 'pass') return { action: 'close', reason: null }
  if (input.verify === 'none') return { action: 'run-verify', reason: null }
  return { action: 'block', reason: 'verify-fail' }
}
