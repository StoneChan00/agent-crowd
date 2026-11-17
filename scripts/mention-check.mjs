/**
 * Regression guard for the `@`-mention contract, in two halves that must
 * agree: **server/mentions.ts** decides who a message wakes, and
 * **web/src/lib/markdown.ts + mentions.ts** decide what gets highlighted.
 *
 * The bug this pins shut (2026-xx review round): a character wrote
 * "@GLM 要不要我把 P0 拆成可执行方案？" while *asking the user* to decide. The
 * bare @ woke GLM, the relay fired, and the decision was taken out of the
 * user's hands. The fix is a distinction the whole stack has to share —
 * bare `@name` = a call (wake / relay), quoted `` `@name` `` = prose (nobody
 * wakes) — plus `meta.relayTo` so the UI shows the router's own verdict.
 *
 * Layers:
 *   1. grammar  — boundary rules (`@鱼` ≠ `@鱼头`, `boss@x` ≠ `@x`, a
 *                 hyphenated name ≠ its stem: `@GLM-5` ≠ `@GLM`), aliases,
 *                 case-insensitivity, `@all`;
 *   2. escape   — quoted text is not a call: every code form the renderer
 *                 hides (spans — incl. double-backtick and cross-line ones —
 *                 fenced blocks incl. unclosed, indented code), link labels
 *                 AND gfm autolinked URLs wake nobody and light nothing up;
 *   3. agreement— for a roster and a set of samples, the chips the real
 *                 markdown pipeline produces resolve to exactly the members
 *                 the server would wake (and nobody else);
 *   4. wiring   — the router and the prompt keep using the shared grammar,
 *                 the relay path parses visibleText once per message, and
 *                 both opaque sets + both character classes
 *                 (CALL_NAME_SOURCE / MENTION_TOKEN) are IMPORTED from the
 *                 live modules — never scraped back out of source text.
 *
 * The server parses through mdast-util-from-markdown + gfm — the same
 * micromark grammar family the browser renders with (react-markdown /
 * remark-gfm). Node ≥ 23.6 (type stripping) is required for the `.ts`
 * imports.
 *
 *   node scripts/mention-check.mjs
 */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import { readFileSync } from 'node:fs'
import {
  ALL_MENTION,
  CALL_NAME_SOURCE,
  isMentioned,
  matchNames,
  NOT_A_CALL,
  visibleText,
} from '../server/mentions.ts'
import { markdownRemarkPlugins, MENTION_TOKEN, mentionTokenFromHref, OPAQUE } from '../web/src/lib/markdown.ts'
import { resolveMention } from '../web/src/lib/mentions.ts'

let failed = 0

function check(name, ok, detail = '') {
  if (ok) {
    console.log(`✓ ${name}`)
  } else {
    console.log(`× ${name}${detail ? `: ${detail}` : ''}`)
    failed += 1
  }
}

const render = (text) => renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins: markdownRemarkPlugins }, text))

/**
 * Tokens the pipeline turned into mention links, in document order.
 * The href is percent-encoded by the mdast→hast URI normaliser (`@千姐` arrives
 * as `%E5%8D%83%E5%A7%90`), so it must be decoded through the SAME helper the
 * component uses — comparing the raw href against the roster would report a
 * missing chip for every CJK name while the UI renders it correctly.
 */
const renderedTokens = (text) =>
  [...render(text).matchAll(/href="#mention:([^"]+)"/g)].map((m) => mentionTokenFromHref(`#mention:${m[1]}`))

// ---- 1. grammar ---------------------------------------------------------------------

check('bare @name is a call', isMentioned('@GLM 帮我看下', 'GLM'))
check('mention is case-insensitive', isMentioned('@glm 帮我看下', 'GLM'))
check('a longer word is not a call (@GLMM)', !isMentioned('@GLMM 帮我看下', 'GLM'))
check('an email is not a call (boss@GLM)', !isMentioned('boss@GLM 收一下', 'GLM'))
check('CJK punctuation ends a call name (@GLM，)', isMentioned('@GLM，请继续', 'GLM'))
check('CJK prefix is not a call (@鱼头 vs 鱼)', !isMentioned('@鱼头 看一下', '鱼'))
check('CJK exact name is a call (@鱼 看一下)', isMentioned('@鱼 看一下', '鱼'))
check('a hyphenated call-name is a whole call (@A-B)', isMentioned('@A-B 你看', 'A-B'))
check('a hyphenated suffix is not the stem (@GLM-5 vs GLM)', !isMentioned('@GLM-5 这个模型', 'GLM'))
check('a hyphenated name calls itself (@GLM-5)', isMentioned('@GLM-5 这个模型', 'GLM-5'))
check('alias wakes the character (@千姐)', matchNames({ name: '千问', aliases: ['千姐'] }, '@千姐 你看'))
check('unknown alias does not wake (@千阿姨)', !matchNames({ name: '千问', aliases: ['千姐'] }, '@千阿姨 你看'))
check('@all is a broadcast', ALL_MENTION.test('@all 都看一下'))
check('@所有人 is a broadcast', ALL_MENTION.test('@所有人 都看一下'))
check('@all-hands is not a broadcast', !ALL_MENTION.test('@all-hands 看一下'))

// ---- 2. escape: quoted text is not a call -------------------------------------------

check('visibleText leaves plain text untouched', visibleText('普通文本，没有代码') === '普通文本，没有代码')
check('inline code is not visible', visibleText('a `@GLM` b').includes('@GLM') === false)
check('fenced block is not visible', visibleText('```\n@GLM\n```').includes('@GLM') === false)
check('double-backtick span is not visible', visibleText('``@GLM`` 这样写').includes('@GLM') === false)
check('code span across lines is not visible', visibleText('`@GLM\n继续`').includes('@GLM') === false)
check('unclosed fence swallows the rest', visibleText('```\n@GLM 你看下').includes('@GLM') === false)
check('indented code block is not visible', visibleText('    @GLM 缩进').includes('@GLM') === false)
check('link label is not a call', visibleText('[@GLM](http://example.com) 链接').includes('@GLM') === false)
check('an autolinked URL is not visible (gfm)', visibleText('看 https://e.com/@GLM 你好').includes('@GLM') === false)
check('inline code mention does not wake (`@GLM`)', !matchNames({ name: 'GLM', aliases: [] }, visibleText('要不要我交给 `@GLM` 落地？')))
check('fenced mention does not wake', !matchNames({ name: 'GLM', aliases: [] }, visibleText('示例：\n```\n@GLM\n```\n以上')))
check('quoted @all does not broadcast', !ALL_MENTION.test(visibleText('`@all` 只是文字')))
check('a URL @all does not broadcast (gfm autolink)', !ALL_MENTION.test(visibleText('看 https://e.com/@all 不要广播')))
check(
  'bare mention next to a quoted one still wakes (@千问 after `@GLM`)',
  matchNames({ name: '千问', aliases: ['千姐'] }, visibleText('`@GLM` 不动，@千问 接着做')),
)

// ---- 3. the highlight and the router must agree -------------------------------------
// One roster, several samples: the chips the REAL markdown pipeline emits must
// resolve to exactly the characters `shouldWake` would wake — no more, no less.

const roster = [
  { name: 'GLM', aliases: ['旮旯玛'], color: '#f97316' },
  { name: 'GLM-5', aliases: [], color: '#94a3b8' },
  { name: '千问', aliases: ['千姐'], color: '#4f9cf9' },
  { name: '鱼', aliases: [], color: '#2dd4bf' },
  { name: 'A-B', aliases: [], color: '#a78bfa' },
]

const samples = [
  '@GLM 这个交给你',
  '`@GLM` 只是提到，不叫醒',
  '@鱼头 说两句',
  '@千姐 你看',
  '见 @GLM 和 @千姐',
  '@GLM, 请继续',
  'user@glm.com 是邮箱',
  '```\n@GLM\n```',
  '`` `@GLM` 双反引号 ``',
  // The five edge cases the 2026-11 review round found: the renderer treats
  // each of these as code (or a link label) while the old regex approximation
  // still saw prose — waking on text that never lights up.
  '``@GLM`` 纯双反引号',
  '`@GLM\n跨行` 的行内代码',
  '```\n@GLM 未闭合围栏\n',
  '    @GLM 缩进代码块',
  '[@GLM](http://example.com) 链接文字',
  // gfm-rich prose: the mention stays visible on both sides in all of these.
  '~~@GLM~~ 删除线里的提及',
  '**@GLM** 加粗里的交接',
  '> @GLM 引用里的交接',
  '| a | b |\n| --- | --- |\n| @GLM | x | 表格里的提及',
  // The gfm autolink gap the follow-up review round found: without the gfm
  // extension on the server, this URL is prose there (waking GLM) but an
  // autolink in the browser (no chip).
  'https://e.com/@GLM 和 @千问',
  // The hyphen gap the 1130 review round found: the chip token class has
  // `-` but the wake-side trailing boundary didn't — `@GLM-5` woke the stem
  // while the bubble lit nobody (or, with GLM-5 in the roster, woke BOTH
  // and lit one chip).
  '@GLM-5 这个模型',
  '@千问-3.8 跑一下',
  '@GLM-5 和 @GLM 各自接',
  'x@GLM-y',
  '@A-B 你看',
]

for (const sample of samples) {
  const stripped = visibleText(sample)
  const woke = roster.filter((member) => matchNames(member, stripped)).map((member) => member.name).sort()
  const chipped = [
    ...new Set(
      renderedTokens(sample)
        .map((token) => resolveMention(token, roster))
        .filter((target) => target.kind === 'member')
        .map((target) => target.name),
    ),
  ].sort()
  check(
    `chips == wake list for ${JSON.stringify(sample)}`,
    JSON.stringify(woke) === JSON.stringify(chipped),
    `router woke [${woke}] but the body highlights [${chipped}]`,
  )
}

check('highlight does not fire inside code', renderedTokens('`@GLM` 只是提到，不叫醒').length === 0)
check('code keeps the literal name', render('`@GLM`').includes('<code>@GLM</code>'))
check('a bare mention becomes a chip', renderedTokens('@GLM 交给你').join() === 'GLM')
check('a CJK mention chip decodes its href', mentionTokenFromHref('#mention:%E5%8D%83%E5%A7%90') === '千姐')
check('a non-member token resolves to plain text', resolveMention('glm_fan', roster).kind === 'plain')
check('@all resolves to a broadcast chip', resolveMention('all', roster).kind === 'all')
check('@所有人 resolves to a broadcast chip', resolveMention('所有人', roster).kind === 'all')

// ---- 4. wiring: one grammar, no second copy -----------------------------------------

{
  const orchestrator = readFileSync(new URL('../server/orchestrator.ts', import.meta.url), 'utf8')
  check(
    'orchestrator routes through the shared grammar',
    orchestrator.includes("from './mentions.ts'") && orchestrator.includes('ALL_MENTION.test(plain)'),
    'routing must strip code first (ALL_MENTION.test(plain)), not test the raw content',
  )
  check(
    'orchestrator does not re-implement the boundary regex',
    orchestrator.includes('(?<![A-Za-z0-9_])@') === false,
    'the `@name` boundary lives in server/mentions.ts only',
  )
  check(
    'relay detection strips code too',
    orchestrator.includes('visibleText(media.text)'),
    'shouldWake/mentions must ignore quoted @name, or the escape hatch is one-way (media.text: the relay path reads the media-rewritten text, so a [media] link never mints a call either)',
  )
  check(
    'relay parses once, outside the per-member filter',
    orchestrator.includes('matchNames(character, visibleText(') === false,
    'the relay path must extract visibleText once per message, not once per member',
  )
  // The escape hatch only holds if BOTH sides skip the same node types: a
  // mention the server reads but the bubble can't chip (or vice versa) is
  // the exact drift the 2026-11 review round caught on link labels. Both
  // sets are IMPORTED (not scraped from the source with a regex — the
  // regex bound to "the first new Set([...]) in the file" and would
  // silently compare the wrong pair the day someone adds an unrelated Set
  // above them).
  const serverOpaque = [...NOT_A_CALL].sort().join(',')
  const webOpaque = [...OPAQUE].sort().join(',')
  check(
    'server and web share one opaque set',
    serverOpaque === webOpaque && serverOpaque.includes('linkReference'),
    `server skips [${serverOpaque}] but web skips [${webOpaque}]`,
  )
  // The character class the chip captures and the shape the db accepts must
  // be the SAME spelling: a stored call-name with a space or a dot would be
  // matched literally by the router but can never tokenize into a chip —
  // woken with nothing lighting up. The db layer refuses such names, and
  // both classes are pulled off the IMPORTED regexes so neither side drifts
  // (and no source-scraping regex binds to the wrong literal).
  const callNameClass = CALL_NAME_SOURCE.source.match(/^\^\[([^\]]+)\]\+\$$/)?.[1] ?? ''
  const tokenClass = MENTION_TOKEN.source.match(/@\(\[([^\]]+)\]\+\)/)?.[1] ?? ''
  check(
    'call-name shape == chip token shape',
    callNameClass !== '' && callNameClass === tokenClass,
    `db accepts [${callNameClass}] but the chip tokenizes [${tokenClass}]`,
  )
  const dbSrc = readFileSync(new URL('../server/db.ts', import.meta.url), 'utf8')
  check(
    'the db refuses call-names the chip cannot render',
    dbSrc.includes('CALL_NAME_SOURCE') && dbSrc.includes('InvalidCallNameError'),
    'a spaced name/alias would wake a character whose chip can never light up',
  )
  const prompt = readFileSync(new URL('../server/prompt.ts', import.meta.url), 'utf8')
  check(
    'the turn prompt teaches both forms',
    prompt.includes('`@名字`') && prompt.includes('反引号'),
    'characters cannot use an escape hatch nobody told them about',
  )
  check(
    'the UI resolves chips through the shared resolver',
    readFileSync(new URL('../web/src/components/MessageList.tsx', import.meta.url), 'utf8').includes(
      'resolveMention(',
    ),
    'a hand-rolled name comparison in the component would drift from the router',
  )
}

if (failed) {
  console.log(`\n${failed} case(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nOK: mention contract passed (grammar + escape + agreement + wiring)')
}
