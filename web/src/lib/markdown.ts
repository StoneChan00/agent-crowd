import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'

/**
 * The chat markdown pipeline for role replies, in one place:
 *   - gfm: tables / strikethrough / task lists;
 *   - breaks: a single `\n` is a HARD newline, not a CommonMark soft break;
 *   - mentions: `@name` becomes a scannable chip (see `remarkMentions`).
 *
 * Without `breaks` every reply rendered with its newlines collapsed onto
 * one line — and `tsc` / `vite build` both stayed green through that bug.
 * `scripts/markdown-breaks-check.mjs` renders through THIS array (plus a
 * static wiring check on MessageList) so the contract stays observable.
 *
 * Plain-text surfaces (`.system-pill`, `.user-text`, `.live-text`,
 * `.memory-content`) don't go through markdown at all; they keep the same
 * newline contract via `white-space: pre-wrap` + `word-break: break-word`
 * in styles.css, asserted by the same script.
 */
export const markdownRemarkPlugins = [remarkGfm, remarkBreaks, remarkMentions]

/** Prefix that marks a link as an `@name` mention instead of a URL. */
export const MENTION_HREF_PREFIX = '#mention:'

/**
 * `#mention:<token>` → token. The mdast→hast step runs the URL through a URI
 * normaliser, so a CJK call-name (`@千问`) arrives percent-encoded and has to
 * be decoded before it can be matched against the roster.
 */
export function mentionTokenFromHref(href: string): string {
  const raw = href.slice(MENTION_HREF_PREFIX.length)
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

/** Minimal mdast shape — enough for the mention pass, no extra dependency. */
interface MdNode {
  type: string
  value?: string
  url?: string
  title?: string | null
  children?: MdNode[]
}

/**
 * Node types whose text stays literal: code is quoted text, raw HTML never
 * renders, and link text is skipped because a mention link nested in an
 * `<a>` is invalid HTML. server/mentions.ts extracts routing text through
 * the SAME opaque set (`visibleText`) — a mention in any of these nodes
 * wakes nobody on the server and lights up nothing here, so a chip and a
 * real wake-up can never drift apart. Exported for scripts/mention-check.mjs,
 * which imports BOTH sets and pins them equal instead of scraping `new
 * Set([...])` literals out of the sources.
 */
export const OPAQUE = new Set(['inlineCode', 'code', 'html', 'link', 'linkReference', 'image', 'imageReference'])

/**
 * `@name` at a word boundary — the same shape the server treats as a call, so
 * a highlighted chip and a real relay always agree. Deliberately knows nothing
 * about room membership: MessageList resolves the token against the room's
 * characters and renders an unknown token as plain text.
 *
 * The character class MUST stay identical to CALL_NAME_SOURCE in
 * server/mentions.ts: the db layer only stores call-names that fit it, so a
 * chip can render every name the router can wake. scripts/mention-check.mjs
 * imports BOTH regexes and pins the two spellings in lockstep.
 */
export const MENTION_TOKEN = /(?<![A-Za-z0-9_])@([A-Za-z0-9_\u4e00-\u9fff-]+)/g

/** Rewrite one text node into text + `#mention:` link nodes. */
function splitText(value: string): MdNode[] {
  const out: MdNode[] = []
  let last = 0
  for (const match of value.matchAll(MENTION_TOKEN)) {
    const start = match.index ?? 0
    if (start > last) out.push({ type: 'text', value: value.slice(last, start) })
    const token = match[1]
    out.push({
      type: 'link',
      url: `${MENTION_HREF_PREFIX}${token}`,
      title: null,
      children: [{ type: 'text', value: `@${token}` }],
    })
    last = start + match[0].length
  }
  if (last < value.length) out.push({ type: 'text', value: value.slice(last) })
  return out
}

function walk(node: MdNode): void {
  const children = node.children
  if (!children) return
  const next: MdNode[] = []
  for (const child of children) {
    if (child.type === 'text' && child.value) {
      next.push(...splitText(child.value))
      continue
    }
    if (!OPAQUE.has(child.type)) walk(child)
    next.push(child)
  }
  node.children = next
}

/**
 * Highlight `@name` in role replies. Runs last so the tree is final; only
 * plain text nodes are rewritten, which is why code spans, existing links,
 * tables and images keep exactly what the author wrote.
 */
export function remarkMentions() {
  return (tree: MdNode): void => walk(tree)
}
