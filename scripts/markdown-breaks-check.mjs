/**
 * Regression guard for the chat newline contract: "the rendering layer
 * must not eat newlines". The bug this pins shut appeared twice in this
 * room: every role reply collapsed onto one line because the markdown
 * pipeline had no `remarkBreaks`, and system pills still collapse harness
 * stderr tails (multi-line stacks, truncated to 800 chars by the
 * orchestrator) because `.system-pill` had no `white-space: pre-wrap`.
 * Neither regression fails `tsc` or `vite build` — only this test notices.
 *
 * Five layers, one contract:
 *   1. semantic — render the REAL pipeline (`markdownRemarkPlugins`, the
 *      same module MessageList imports) through react-dom/server and
 *      assert single `\n` → <br>, blank line → paragraphs, GFM tables /
 *      lists intact, code-block newlines untouched;
 *   2. wiring — MessageList must render via the shared plugin array, so
 *      deleting `remarkBreaks` anywhere along the chain breaks THIS
 *      test instead of production;
 *   3. css — every rule that DIRECTLY targets a plain-text surface
 *      (`.system-pill`, `.user-text`, `.live-text`, `.memory-content`)
 *      is audited: at least one such rule must apply `white-space:
 *      pre-wrap` + `word-break: break-word`, and none may write either
 *      property with any other value. Compound, group, descendant and
 *      attribute selectors all count (`.system-pill.is-error`,
 *      `[class~="system-pill"]`, `.msg-system .system-pill`), while
 *      sub-element rules (`.system-pill span`) and longer names
 *      (`.system-pill-variant`) are correctly ignored — so a legal
 *      narrow-screen tweak that doesn't touch the pair stays green and
 *      the guard doesn't rot into something people delete;
 *   4. self-test — the auditor runs against poisoned fixtures (bad
 *      overrides via compound / same-selector / attribute selectors,
 *      allowed media tweaks, commented-out rules). The evidence that
 *      the detector actually catches regressions lives HERE, in the
 *      test, not in a one-off poison run described in a chat report;
 *   5. artifact — when `dist/web` exists, its built CSS goes through
 *      the same auditor, so a stale bundle that still collapses
 *      newlines cannot be served unnoticed ("fixed src, forgot build").
 *
 * Zero new dependencies — react / react-dom / react-markdown / both remark
 * plugins already ship in package.json. Node ≥ 23.6 (type stripping) is
 * required for the `.ts` import, same as test-timeout.mjs; the floor is
 * also machine-declared via package.json `engines`.
 *
 *   node scripts/markdown-breaks-check.mjs
 */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
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

// ---- css auditor --------------------------------------------------------------------
// Limits (fine for this stylesheet and vite's minified output, pinned by the
// self-test below): declaration values containing `{`/`}` and quoted strings
// containing selector metacharacters are not parsed; neither occurs here.

const SURFACES = ['.system-pill', '.user-text', '.live-text', '.memory-content']
const PAIR = { 'white-space': 'pre-wrap', 'word-break': 'break-word' }

// Split a stylesheet into (selector, body) rule pairs. Comments are stripped
// first so a commented-out override never enters the audit. Inner rules of
// at-rules (@media …) are extracted naturally — the wrapper itself can never
// match, because its "body" would have to cross a `{`.
function cssRules(css) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '')
  return [...clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1], body: m[2] }))
}

// Split on `chars` only at bracket/paren depth 0 — commas and combinators
// inside `[class~="x"]` or `:is(...)` must not split anything.
function topLevelSplit(s, chars) {
  const parts = []
  let depth = 0
  let start = 0
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === '[' || ch === '(') depth += 1
    else if (ch === ']' || ch === ')') depth -= 1
    else if (depth === 0 && chars.includes(ch)) {
      parts.push(s.slice(start, i))
      start = i + 1
    }
  }
  parts.push(s.slice(start))
  return parts
}

// Does this rule DIRECTLY target the class `token`? "Directly" = the token
// appears in the last compound selector of at least one selector of the
// (possibly comma-separated) list:
//   .system-pill  .system-pill.is-error  .msg-system .system-pill
//   [class~="system-pill"]                     → yes
//   .system-pill span (sub-element)            → no
//   .system-pill-variant (longer identifier)   → no
function directlyTargets(sel, token) {
  const tokenRe = new RegExp(`(?:^|[^\\w-])${token}(?![\\w-])`)
  return topLevelSplit(sel, ',').some((complex) => {
    const compounds = topLevelSplit(complex, ' \t\n>+~').filter(Boolean)
    return tokenRe.test(compounds[compounds.length - 1] ?? '')
  })
}

// Audit one stylesheet for one surface class: some direct rule must apply
// the newline pair, and no direct rule may write either property with a
// different value. Offending selectors are returned so failures can name them.
function audit(css, token) {
  const rules = cssRules(css).filter((r) => directlyTargets(r.sel, token))
  const applies = (body, prop) => new RegExp(`${prop}\\s*:\\s*${PAIR[prop]}(?![\\w-])`).test(body)
  const mentions = (body, prop) => new RegExp(`${prop}\\s*:`).test(body)
  const hasPair = rules.some((r) => applies(r.body, 'white-space') && applies(r.body, 'word-break'))
  const bad = rules.filter(
    (r) =>
      (mentions(r.body, 'white-space') && !applies(r.body, 'white-space')) ||
      (mentions(r.body, 'word-break') && !applies(r.body, 'word-break')),
  )
  return { hasPair, bad }
}

// ---- css: plain-text surfaces keep pre-wrap + break-word ---------------------------

{
  const css = readFileSync(new URL('../web/src/styles.css', import.meta.url), 'utf8')
  for (const selector of SURFACES) {
    const token = selector.slice(1)
    const { hasPair, bad } = audit(css, token)
    check(
      `${selector} has a rule applying the newline pair (pre-wrap + break-word)`,
      hasPair,
      'no rule block — including compound/group/descendant/attribute selectors — applies the pair',
    )
    check(
      `${selector} is never overridden to a different white-space/word-break`,
      bad.length === 0,
      bad.map((r) => r.sel.trim()).join(' | '),
    )
  }
}

// ---- self-test: the auditor must catch what it claims --------------------------------
// Every regex change to the auditor has to keep these fixtures exactly this
// red/green — the poison evidence is permanent, not a one-off chat report.

{
  const base = '.system-pill{white-space:pre-wrap;word-break:break-word}'
  const fixtures = [
    ['compound override (.system-pill.is-error) is caught', `${base} .system-pill.is-error{white-space:normal}`, true, 1],
    ['same-selector re-override is caught', `${base} .system-pill{white-space:normal}`, true, 1],
    ['attribute selector override ([class~=...]) is caught', `${base} [class~="system-pill"]{white-space:normal}`, true, 1],
    ['group selector participates (.foo, .system-pill)', '.foo, .system-pill { white-space: pre-wrap; word-break: break-word }', true, 0],
    ['sub-element rule (.system-pill span) may differ', `${base} .system-pill span{white-space:normal}`, true, 0],
    ['media tweak that skips the pair stays green', `${base} @media(max-width:600px){.system-pill{font-size:11px}}`, true, 0],
    ['longer identifier is a different class', `${base} .system-pill-variant{white-space:normal}`, true, 0],
    ['commented-out override is ignored', `${base} /* .system-pill{white-space:normal} */`, true, 0],
    ['missing pair is caught', '.system-pill{color:red}', false, 0],
  ]
  for (const [name, css, wantPair, wantBad] of fixtures) {
    const { hasPair, bad } = audit(css, 'system-pill')
    check(
      `self-test: ${name}`,
      hasPair === wantPair && bad.length === wantBad,
      `hasPair=${hasPair} bad=${bad.length} (expected hasPair=${wantPair} bad=${wantBad})`,
    )
  }
}

// ---- artifact: a built dist must keep the pair as well --------------------------------
// tsc and vite build stay green while newlines die, and the server serves
// dist/web straight from disk — so if a build exists, it must pass the same
// audit the source passes. No dist yet (fresh clone) → layer skipped, not failed.

{
  const distDir = fileURLToPath(new URL('../dist/web/', import.meta.url))
  const files = []
  for (const dir of [distDir, join(distDir, 'assets')]) {
    if (existsSync(dir)) {
      for (const f of readdirSync(dir)) if (f.endsWith('.css')) files.push(join(dir, f))
    }
  }
  if (files.length === 0) {
    console.log('· dist/web not built yet — artifact layer skipped (run `pnpm build` to enable it)')
  }
  for (const file of files) {
    const css = readFileSync(file, 'utf8')
    for (const selector of SURFACES) {
      const { hasPair, bad } = audit(css, selector.slice(1))
      check(
        `artifact ${basename(file)}: ${selector} keeps the newline pair`,
        hasPair && bad.length === 0,
        'the served bundle still collapses newlines — rebuild with `pnpm build`',
      )
    }
  }
}

if (failed) {
  console.log(`\n${failed} case(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nOK: markdown newline contract passed (semantic + wiring + css + self-test + artifact)')
}
