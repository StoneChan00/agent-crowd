/**
 * Regression guard for the agent transcript contract (server/prompt.ts).
 *
 * The bug this pins shut (2026-11-05): every history message was hard-capped
 * at 1_200 chars inside 【最近的群聊记录】 while the DB kept the full text —
 * reviews and fix reports (1.5k–2.5k chars) reached the reviewed agent cut
 * mid-list ("…`ALL_MENTION` 的尾边…"), P3 items vanished, and the room had to
 * fish originals out of the DB. The chat UI never truncated anything; the
 * cut existed only in this transcript layer.
 *
 * Layers:
 *   1. delivery — a full-size review/report message reaches the agent intact;
 *   2. bound    — a pathological dump is still capped, with the … marker;
 *   3. budget   — the transcript keeps the NEWEST messages within budget
 *                 (four max-length messages: the closing loop must fit);
 *   4. ceiling  — when the total-prompt guard fires, only the header is cut:
 *                 the "【现在轮到你】" instruction always survives.
 *   5. override — a steer/manual override is capped like one message before
 *                 it rides the guard-protected tail: a 40k override must not
 *                 slip the ceiling and blow the CLI's 32_767-char argv limit.
 *
 * Constants are IMPORTED from the live module — never re-typed here.
 * Node ≥ 23.6 (type stripping) is required for the `.ts` imports.
 *
 *   node scripts/prompt-check.mjs
 */
import {
  buildTurnPrompt,
  MAX_MESSAGE_CHARS,
  MAX_TOTAL_PROMPT,
  TRANSCRIPT_CHAR_BUDGET,
} from '../server/prompt.ts'
import { DEFAULT_TRIGGERS } from '../server/types.ts'

let failed = 0

function check(name, ok, detail = '') {
  if (ok) {
    console.log(`✓ ${name}`)
  } else {
    console.log(`× ${name}${detail ? `: ${detail}` : ''}`)
    failed += 1
  }
}

const room = {
  id: 'r1', name: '测试房', topic: '', workingDir: 'D:/tmp', maxHops: 8, verifyCommand: '', createdAt: 0,
}

const baseCharacter = {
  id: 'c1',
  roomId: 'r1',
  name: 'GLM',
  aliases: [],
  avatar: '',
  color: '',
  harness: 'cannbot',
  model: '',
  persona: '测试人设',
  cwd: '',
  triggers: DEFAULT_TRIGGERS,
  commandTemplate: '',
  autoApprove: true,
  enabled: true,
  identityId: null,
  presetId: null,
  createdAt: 0,
}

const msg = (id, content, minutesAgo) => ({
  id,
  roomId: 'r1',
  authorType: 'character',
  characterId: 'c2',
  authorName: '审查者',
  authorAvatar: '',
  color: '',
  content,
  meta: null,
  createdAt: Date.now() - minutesAgo * 60_000,
})

const build = (messages, character = baseCharacter, override) =>
  buildTurnPrompt({ room, character, characters: [character], messages, cwd: 'D:/tmp', override })

const mark = (tag) => `⟪${tag}⟫`

// ---- 1. delivery ------------------------------------------------------------------

{
  // A full-size report sits just under the per-message cap: it must arrive
  // whole, with no ellipsis marker anywhere in the prompt.
  const report = 'a'.repeat(MAX_MESSAGE_CHARS - 200) + mark('REPORT-TAIL')
  const prompt = build([msg('m1', report, 1)])
  check('full-size message reaches the agent intact', prompt.includes(mark('REPORT-TAIL')))
  check('an uncapped prompt carries no … marker', !prompt.includes('…'), 'something is being cut that should not be')
}

// ---- 2. bound ---------------------------------------------------------------------

{
  const dump = 'z'.repeat(MAX_MESSAGE_CHARS * 2) + mark('LOST-TAIL')
  const prompt = build([msg('m2', dump, 1)])
  check('a pathological dump is still capped', !prompt.includes(mark('LOST-TAIL')))
  check('the cut is marked with …', prompt.includes('…'))
}

// ---- 3. budget keeps the newest messages ------------------------------------------

{
  // Ten near-cap messages: only the newest four fit the transcript budget —
  // the 需求 → 汇报 → review → 二次汇报 loop must close inside one prompt.
  const messages = Array.from({ length: 10 }, (_, i) =>
    msg(`m${i}`, 'y'.repeat(MAX_MESSAGE_CHARS - 300) + mark(`NEW-${i}`), 10 - i),
  )
  const prompt = build(messages)
  check('the newest message survives the budget', prompt.includes(mark('NEW-9')))
  check('four max-length messages fit (budget admits the closing loop)', prompt.includes(mark('NEW-6')))
  check('the 5th-oldest long message is dropped by the budget', !prompt.includes(mark('NEW-5')))
  check('the oldest long message is dropped by the budget', !prompt.includes(mark('NEW-0')))
  check(
    'the whole prompt stays within the ceiling',
    prompt.length <= MAX_TOTAL_PROMPT + 30,
    `prompt.length=${prompt.length}`,
  )
  check('budget respects TRANSCRIPT_CHAR_BUDGET', 4 * MAX_MESSAGE_CHARS < TRANSCRIPT_CHAR_BUDGET)
}

// ---- 4. ceiling guard keeps the turn instruction ----------------------------------

{
  // A persona this huge blows the total ceiling: the guard must fire, and the
  // header — never the "【现在轮到你】" tail — is what gets cut.
  const huge = { ...baseCharacter, persona: 'P'.repeat(MAX_TOTAL_PROMPT) }
  const prompt = build([msg('m1', '正常长度的消息', 1)], huge)
  check('overflow guard fires with its marker', prompt.includes('…（上下文过长已截断）'))
  check(
    'the turn instruction survives the overflow cut',
    prompt.trimEnd().endsWith('请直接给出你要发到群里的那条消息。'),
  )
}

// ---- 5. oversized override cannot blow the argv ceiling ---------------------------

{
  // The override rides in the tail — the one part the overflow guard never
  // cuts — so before its own cap a 40k steer slipped the ceiling whole
  // (prompt = 40_022 chars > the spawned CLI's 32_767-char argv limit) and
  // the child died with zero events. An override is capped like one message.
  const giant = 'S'.repeat(MAX_TOTAL_PROMPT + 8_000) + mark('LOST-STEER-TAIL')
  const prompt = build([msg('m1', '正常消息', 1)], baseCharacter, giant)
  check('an oversized override is capped', !prompt.includes(mark('LOST-STEER-TAIL')))
  check('the override cut is marked with …', prompt.includes('…'))
  check(
    'a giant override keeps the whole prompt within the ceiling',
    prompt.length <= MAX_TOTAL_PROMPT + 30,
    `prompt.length=${prompt.length}`,
  )
  check('the capped override still heads the turn-instruction block', prompt.includes('【现在轮到你】'))

  // Normal steering text passes through untouched; a blank override falls
  // back to the default instruction.
  const steer = mark('STEER') + ' 优先核对 pnpm test 的结果'
  check('a normal override arrives whole', build([msg('m1', 'x', 1)], baseCharacter, steer).includes(steer))
  check(
    'a blank override falls back to the default instruction',
    build([msg('m1', 'x', 1)], baseCharacter, '   ').includes('现在轮到你（GLM）发言'),
  )

  // Composition: giant persona AND giant override together still land under
  // the ceiling with the turn instruction intact.
  const both = build([msg('m1', 'x', 1)], { ...baseCharacter, persona: 'P'.repeat(MAX_TOTAL_PROMPT) }, giant)
  check(
    'giant persona + giant override together stay within the ceiling',
    both.length <= MAX_TOTAL_PROMPT + 30 && both.includes('【现在轮到你】'),
    `both.length=${both.length}`,
  )
}

// ---- 6. degenerate input ----------------------------------------------------------

{
  const prompt = build([])
  check('an empty room renders the placeholder', prompt.includes('（空）'))
}

// ---- 7. SOP gate surfaces (P0-3): change evidence + gate rules -----------------------

{
  // meta.changed renders as the reviewer's glance line in the transcript.
  const touched = msg('m1', '已改完', 1)
  touched.meta = { harness: 'cannbot', changed: ['server/a.ts', 'server/b.ts'] }
  const withChanges = build([touched])
  check(
    'meta.changed renders the [改动: …] glance line',
    withChanges.includes('[改动: server/a.ts、server/b.ts]'),
    'transcript line missing the change tag',
  )
  check('a change-less message carries no glance line', !build([msg('m1', '纯聊天', 1)]).includes('[改动:'))

  // More than five files: the list is summarized, not sprawled.
  const many = msg('m2', '批量改动', 1)
  many.meta = { changed: ['1.ts', '2.ts', '3.ts', '4.ts', '5.ts', '6.ts', '7.ts'] }
  const withMany = build([many])
  check(
    '6+ changed files collapse to the first five + total count',
    withChanges && withMany.includes('[改动: 1.ts、2.ts、3.ts、4.ts、5.ts 等 7 个文件]'),
    'long change list not summarized',
  )

  // Rule 9 (REVIEW verdict line) rides along for every room…
  check('rule 9 (REVIEW verdict) is always announced', withChanges.includes('REVIEW: PASS'))
  // …rule 10 (verify-command notice) only for rooms that configured one.
  check('rule 10 absent without a verify command', !withChanges.includes('验证命令（收尾门禁）'))
  const verified = buildTurnPrompt({
    room: { ...room, verifyCommand: 'pnpm test' },
    character: baseCharacter,
    characters: [baseCharacter],
    messages: [touched],
    cwd: 'D:/tmp',
  })
  check(
    'rule 10 appears when the room configured a verify command',
    verified.includes('验证命令（收尾门禁）') && verified.includes('服务端会在轮末收尾前自动运行'),
    'rule 10 missing for a configured room',
  )
}

if (failed) {
  console.log(`\n${failed} case(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nOK: prompt transcript contract passed (delivery + bound + budget + ceiling + override)')
}
