/**
 * The `@`-mention grammar, in one pure module.
 *
 * Three places have to agree on "what counts as a call": human routing
 * (`handleUserMessage`), relay detection (`shouldWake` → `enqueueFollowers`)
 * and the UI highlight (web/src/lib/markdown.ts). They used to be one regex
 * buried in orchestrator.ts; the display layer re-deriving it in the browser
 * is exactly how "the bubble promises a wake-up the router won't do" happens.
 *
 * A call is a **bare** `@name` bounded on both sides: `@fish` must not match
 * `@fisher` or `boss@fish`, and the CJK-aware trailing boundary keeps `@鱼`
 * from matching `@鱼头`.
 *
 * **Quoted text is not a call.** What counts as quoted is decided by a real
 * CommonMark parser — the same grammar the bubble renders through — not by a
 * regex approximation: the approximation only agreed with the renderer on
 * the happy path, while an unclosed fence, an indented code block, or a code
 * span that doubles its backticks or crosses a newline all render as code
 * the regex still treated as prose (waking people on text that never lights
 * up). Link labels are skipped for the mirror-image reason: the web pipeline
 * renders them as plain links, no chip, so they must wake nobody either.
 * The parser carries the SAME GFM extensions the web pipeline does — without
 * gfm, `https://e.com/@GLM` is prose here but an autolink there, so the URL
 * would wake GLM while the bubble shows no chip.
 * Together that is the escape hatch every character has: `` `@GLM` `` (or
 * any other quoted form) names a teammate without waking them. That
 * distinction is the difference between "I'm mentioning you" and "you're
 * next" — without it an agent that writes "@GLM 要不要我把方案拆成任务？"
 * while asking the *user* to decide silently hands the decision to GLM.
 */
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfm } from 'micromark-extension-gfm'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import type { Character } from './types.ts'

/**
 * The shape a call-name (a character name or alias) must have to be @'able:
 * ONE chip token. The web pipeline can only highlight `@` followed by this
 * character class (MENTION_TOKEN in web/src/lib/markdown.ts) — a call-name
 * with a space, a dot or any other outside character is still matched
 * literally by `isMentioned`, so the router would wake a character whose
 * chip can never light up. The db layer therefore refuses to store such a
 * call-name (sanitizeAliases / createCharacter in server/db.ts), and
 * scripts/mention-check.mjs pins the two spellings in lockstep.
 */
export const CALL_NAME_SOURCE = /^[A-Za-z0-9_\u4e00-\u9fff-]+$/

/** `@all` / `@所有人` as a whole word on both sides, so `team@all.com` or `@all-hands` won't wake everyone. */
export const ALL_MENTION = /(?<![A-Za-z0-9_])@(?:all|所有人)(?![A-Za-z0-9_\u4e00-\u9fff-])/i

/**
 * Node types whose text is not a call — the SAME opaque set the web pipeline
 * skips (web/src/lib/markdown.ts): code is quoted text, raw HTML never
 * renders, and link/image labels render as links, so a mention there lights
 * nothing up and must wake nobody. Exported so scripts/mention-check.mjs
 * imports BOTH sets and pins them equal — scraping `new Set([...])` literals
 * out of the source with a regex would silently bind to the wrong Set the
 * day someone adds an unrelated one above it.
 */
export const NOT_A_CALL = new Set(['inlineCode', 'code', 'html', 'link', 'linkReference', 'image', 'imageReference'])

/** Minimal mdast shape — enough for the extraction pass (same trick as web/src/lib/markdown.ts). */
interface MdNode {
  type: string
  value?: string
  children?: MdNode[]
}

/**
 * The prose a reader can actually see, extracted through the same
 * CommonMark+gfm grammar the bubble renders with (gfm matters for
 * autolinks: a bare URL is prose to plain CommonMark but a link node to
 * the renderer). Fragments are joined with spaces so a node boundary can
 * never create or eat a `@name` boundary. Callers feed the result to
 * `matchNames` / `ALL_MENTION` — BOTH call sites (the user router and the
 * relay filter) extract once per message, so a room of ten members parses
 * ten names, not ten markdown trees.
 */
export function visibleText(content: string): string {
  const parts: string[] = []
  const walk = (node: MdNode): void => {
    if (NOT_A_CALL.has(node.type)) return
    if (node.type === 'text') {
      if (node.value) parts.push(node.value)
      return
    }
    for (const child of node.children ?? []) walk(child)
  }
  walk(
    fromMarkdown(content, {
      extensions: [gfm()],
      mdastExtensions: [gfmFromMarkdown()],
    }) as unknown as MdNode,
  )
  return parts.join(' ')
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Case-insensitive `@name` with word boundaries on both sides. The trailing
 * class is the SAME character class the chip tokenizes (MENTION_TOKEN /
 * CALL_NAME_SOURCE) — `-` included — so `@GLM-5` calls the character
 * `GLM-5`, never `GLM`: with both in one room the stem must not wake
 * alongside the sibling while the bubble lights a single chip.
 */
export function isMentioned(content: string, name: string): boolean {
  if (!name) return false
  return new RegExp(`(?<![A-Za-z0-9_])@${escapeRegExp(name)}(?![A-Za-z0-9_\\u4e00-\\u9fff-])`, 'i').test(content)
}

/**
 * Any of the character's call-names (name + aliases) is @'d.
 * Callers pass text that already went through `visibleText` — both the
 * user router and the relay filter extract once per message, then match
 * each member against that single parse.
 */
export function matchNames(character: Pick<Character, 'name' | 'aliases'>, content: string): boolean {
  return isMentioned(content, character.name) || character.aliases.some((alias) => isMentioned(content, alias))
}
