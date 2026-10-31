/**
 * Regression guard for the chat newline contract: "the rendering layer
 * must not eat newlines". The bug this pins shut appeared twice in this
 * room: every role reply collapsed onto one line because the markdown
 * pipeline had no `remarkBreaks`, and system pills still collapse harness
 * stderr tails (multi-line stacks, truncated to 800 chars by the
 * orchestrator) because `.system-pill` had no `white-space: pre-wrap`.
 * Neither regression fails `tsc` or `vite build` — only this test notices.
 *
 * Three layers, one contract:
 *   1. semantic — render the REAL pipeline (`markdownRemarkPlugins`, the
 *      same module MessageList imports) through react-dom/server and
 *      assert single `\n` → <br>, blank line → paragraphs, GFM tables /
 *      lists intact, code-block newlines untouched;
 *   2. wiring — MessageList must render via the shared plugin array, so
 *      deleting `remarkBreaks` anywhere along the chain breaks THIS
 *      test instead of production;
 *   3. css — the plain-text surfaces (`.system-pill`, `.user-text`,
 *      `.live-text`, `.memory-content`) must keep `white-space: pre-wrap`
 *      + `word-break: break-word`, in exactly one rule block each.
 *
 * Zero new dependencies — react / react-dom / react-markdown / both remark
 * plugins already ship in package.json. Node ≥ 23.6 (type stripping) is
 * required for the `.ts` import, same as test-timeout.mjs.
 *
 *   node scripts/markdown-breaks-check.mjs
 */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import { readFileSync } from 'node:fs'
import { markdownRemarkPlugins } from '../web/src/lib/markdown.ts'

let failed = 0

function check(name, ok, detail = '') {
  if (ok) {
    console.log(`✓ ${name}`)
  } else {
    console.log(`× ${name}${detail ? `: ${detail}` : ''}`)
    failed += 1
  }
}

const render = (text) =>
  renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins: markdownRemarkPlugins }, text))

// ---- semantic: the pipeline itself -------------------------------------------------

{
  const html = render('第一行\n第二行')
  check('single newline renders <br>', html.includes('<br'), html)
}
{
  const html = render('第一段\n\n第二段')
  const paragraphs = (html.match(/<p>/g) || []).length
  check('blank line still splits paragraphs (no <br>)', paragraphs === 2 && !html.includes('<br'), html)
}
{
  const html = render('- 列表 a\n- 列表 b\n\n1. 其一\n2. 其二')
  const items = (html.match(/<li>/g) || []).length
  check('lists still parse with both plugins active', items === 4, html)
}
{
  const html = render('| a | b |\n| --- | --- |\n| 1 | 2 |')
  check(
    'gfm table intact (row breaks are block-level, not text nodes)',
    html.includes('<table') && !html.includes('<br'),
    html,
  )
}
{
  const html = render('```\nline1\nline2\n```')
  check(
    'code-block newlines preserved, no <br> injected',
    html.includes('line1\nline2') && !html.includes('<br'),
    JSON.stringify(html),
  )
}

// ---- wiring: MessageList must go through the shared plugin array -------------------

{
  const src = readFileSync(new URL('../web/src/components/MessageList.tsx', import.meta.url), 'utf8')
  check(
    'MessageList renders with the shared markdownRemarkPlugins',
    src.includes('remarkPlugins={markdownRemarkPlugins}'),
    'a hardcoded plugin array here would bypass the shared module — and this guard',
  )
}

// ---- css: plain-text surfaces keep pre-wrap + break-word ---------------------------

{
  const css = readFileSync(new URL('../web/src/styles.css', import.meta.url), 'utf8')
  for (const selector of ['.system-pill', '.user-text', '.live-text', '.memory-content']) {
    const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    // match ALL blocks for the selector — a later override (media query,
    // compact mode) flipping `white-space` back to `normal` must fail here,
    // not silently win because only the first block was inspected.
    const blocks = [...css.matchAll(new RegExp(`${esc}\\s*\\{([^}]*)\\}`, 'g'))].map((m) => m[1])
    check(
      `${selector} appears as exactly one rule block`,
      blocks.length === 1,
      `${blocks.length} blocks — a later override can silently flip the newline contract`,
    )
    for (const block of blocks) {
      check(
        `${selector} keeps white-space: pre-wrap + word-break: break-word`,
        /white-space:\s*pre-wrap/.test(block) && /word-break:\s*break-word/.test(block),
        block ? block.replace(/\s+/g, ' ').trim() : 'rule not found',
      )
    }
  }
}

if (failed) {
  console.log(`\n${failed} case(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nOK: markdown newline contract passed (semantic + wiring + css)')
}
