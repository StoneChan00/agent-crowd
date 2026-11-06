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
 *   4. ceiling  — when the total-prompt guard fires, only the head is cut:
 *                 the "【现在轮到你】" instruction and (B01) the newest
 *                 transcript line always survive;
 *   5. override — a steer/manual override is capped like one message before
 *                 it rides the guard-protected tail: a 40k override must not
 *                 slip the ceiling and blow the CLI's 32_767-char argv limit.
 *   6. memory   — (B04) retrieval: pure planning locks (term split, escaping,
 *                 episode assembly) + DB-backed R1–R8 (FTS substring, LIKE
 *                 fallback for short CJK, mixed union, escaping, pinned,
 *                 budgets, empty-query parity).
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
import * as sop from '../server/sop.ts'

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
  // head — never the "【现在轮到你】" tail, and since B01 never the transcript
  // either (the old header-tail slice ate exactly the newest lines) — is
  // what gets cut.
  const huge = { ...baseCharacter, persona: 'P'.repeat(MAX_TOTAL_PROMPT) }
  const prompt = build([msg('m1', '正常长度的消息', 1)], huge)
  check('overflow guard fires with its marker', prompt.includes('…（上下文过长已截断）'))
  check(
    'the turn instruction survives the overflow cut',
    prompt.trimEnd().endsWith('请直接给出你要发到群里的那条消息。'),
  )
  check('the overflow cut keeps the newest transcript line (B01)', prompt.includes('正常长度的消息'))
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

/* ------------------------------------------- memory retrieval (B04, R1–R8) */
// DB-backed cases live in a dynamic-import section so the pure-function
// layer above stays import-clean (AC_DATA_DIR must be set BEFORE db.ts
// loads — paths.ts reads it at module scope). Pure helpers import statically.
{
  const mem = await import('../server/memory.ts')
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const sleep2 = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  // --- pure-function locks -------------------------------------------------
  {
    const planCjk = mem.planMemoryQuery('续传游标')
    check('R-pure 3 码点分界：4 字中文进 FTS', planCjk?.ftsTerms.length === 1 && planCjk.likeTerms.length === 0)
    const planShort = mem.planMemoryQuery('游标 lost')
    check(
      'R-pure 3 码点分界：2 字中文进 LIKE、英文进 FTS',
      planShort?.likeTerms.length === 1 && planShort.ftsTerms.length === 1,
    )
    check(
      'R-pure 空串/空白/null → null',
      mem.planMemoryQuery('') === null && mem.planMemoryQuery('   ') === null && mem.planMemoryQuery(null) === null,
    )
    check('R-pure 词数上限 8（两类合计）', mem.planMemoryQuery('a1 a2 a3 a4 a5 a6 a7 a8 a9 a10')?.likeTerms.length === 8)
    check(
      'R-pure 引号转义（FTS 双写、LIKE 反斜杠）',
      mem.ftsQuote('他说"游标"') === '"他说""游标"""' && mem.escapeLike('100%_\\') === '100\\%\\_\\\\',
    )
    const epA = mem.buildRoundEpisode({ roomId: 'r', changedPaths: ['b.ts', 'a.ts'], verify: 'pass', delivery: '修好了\nREVIEW: PASS' })
    const epB = mem.buildRoundEpisode({ roomId: 'r', changedPaths: ['a.ts', 'b.ts'], verify: 'pass', delivery: '修好了' })
    check(
      'R-pure 路径排序无关 + REVIEW 行剥除 → 同 hash',
      epA.content === epB.content && epA.hash === epB.hash && !epA.content.includes('REVIEW'),
      epA.content,
    )
    const epLong = mem.buildRoundEpisode({
      roomId: 'r',
      changedPaths: Array.from({ length: 9 }, (_, i) => `file-${i}.ts`),
      verify: 'none',
      delivery: 'x'.repeat(400),
    })
    check('R-pure >6 路径写「等 N 个」+ 480 截断', epLong.content.includes('等 9 个') && epLong.content.length <= 480, `${epLong.content.length}`)
    check(
      'R-pure 查询取末条用户消息或任务卡消息',
      mem.memoryQueryFromMessages([
        { id: '1', roomId: 'r', authorType: 'user', characterId: null, authorName: '我', authorAvatar: '', color: '', content: '旧问题', meta: null, createdAt: 1, seq: 1 },
        { id: '2', roomId: 'r', authorType: 'character', characterId: 'c', authorName: '甲', authorAvatar: '', color: '', content: '回复', meta: null, createdAt: 2, seq: 2 },
        { id: '3', roomId: 'r', authorType: 'system', characterId: null, authorName: '系统', authorAvatar: '', color: '', content: '【任务卡】卡片正文', meta: { taskId: 't' }, createdAt: 3, seq: 3 },
      ]) === '【任务卡】卡片正文' &&
        mem.memoryQueryFromMessages([
          { id: '1', roomId: 'r', authorType: 'character', characterId: 'c', authorName: '甲', authorAvatar: '', color: '', content: '最后一条', meta: null, createdAt: 2, seq: 2 },
        ]) === '最后一条' &&
        mem.memoryQueryFromMessages([]) === '',
    )
    // Table-driven cross-check against the gate itself (B04 review 3/4/5):
    // for every verdict shape, the gate seeing a verdict must coincide with
    // the stripper changing the text — expectations derive from
    // parseReviewVerdict, not from a hand-listed subset that can drift.
    // SAMPLE DISCIPLINE (review non-blocking 1): keep every sample short
    // enough that its verdict sits inside the gate's trailing-5-lines window
    // — a verdict followed by 6+ more lines is stripped but not gate-seen,
    // and would break the equivalence on purpose.
    {
      const verdictShapes = [
        'REVIEW: PASS',
        '**REVIEW: PASS**',
        'REVIEW：PASS',
        'review: changes',
        '`REVIEW: PASS`',
        '`**REVIEW：CHANGES**`',
        '``REVIEW: PASS``',
        '  REVIEW: PASS  ',
        '- REVIEW: PASS',
        '- `REVIEW: PASS`',
        '1. REVIEW: PASS',
        '- 复核\n\n    REVIEW: PASS',
        // Multi-line inlineCode (B04 review 5): mdast keeps the newlines in
        // the value — the shared extractor must split them the same way the
        // gate does, in BOTH directions:
        '`REVIEW: PASS\n说明`', // under-strip: gate sees the verdict line
        '`REVIEW:\nPASS`', // over-strip: gate sees NO whole verdict line
        '> REVIEW: PASS',
        '| 门禁 | REVIEW: PASS |',
        'REVIEW: PASSED',
        '我认为 REVIEW: PASS 不合适',
        '```\nREVIEW: PASS\n```',
        '\n    REVIEW: PASS',
        '<div>\nREVIEW: PASS\n</div>',
        '> 结论\nREVIEW: PASS',
      ]
      let shapesAligned = true
      let shapeDetail = ''
      for (const sample of verdictShapes) {
        const text = `交付内容一行\n${sample}`
        const gateSees = sop.parseReviewVerdict(text) !== null
        const strippedSomething = sop.stripVerdictLines(text) !== text
        if (gateSees !== strippedSomething) {
          shapesAligned = false
          shapeDetail += `[${JSON.stringify(sample)} gate=${gateSees} strip=${strippedSomething}] `
        }
      }
      check('R-pure verdict 形态表驱动对拍（gate 判定与剥离同源一致）', shapesAligned, shapeDetail)
    }
    check(
      'R-pure 剥离覆盖反引号整行 code span（交付保留正文）',
      mem.episodeDelivery('完成\n`REVIEW: PASS`') === '完成' && mem.episodeDelivery('完成\n``REVIEW: PASS``') === '完成',
    )
    check(
      'R-pure 多行 inline code 的 verdict 整段剥除（交付不含 REVIEW）',
      mem.episodeDelivery('`REVIEW: PASS\n说明`') === '' && mem.episodeDelivery('前置\n`REVIEW: PASS\n说明`') === '前置',
    )
    check(
      'R-pure 门禁不认的多行 code span 不误删（REVIEW: 无 pass/changes 结尾）',
      mem.episodeDelivery('`REVIEW:\nPASS`').includes('REVIEW:'),
    )
    check(
      'R-pure 剥离覆盖列表项形态（无序/有序/嵌 code span/列表续行）',
      mem.episodeDelivery('- REVIEW: PASS') === '' &&
        mem.episodeDelivery('- `REVIEW: PASS`') === '' &&
        mem.episodeDelivery('1. REVIEW: PASS') === '' &&
        mem.episodeDelivery('- 复核\n\n    REVIEW: PASS') === '- 复核',
    )
    check(
      'R-pure 引用块 lazy continuation 与 HTML 块不被误删',
      mem.episodeDelivery('> 结论\nREVIEW: PASS').includes('REVIEW: PASS') &&
        mem.episodeDelivery('<div>\nREVIEW: PASS\n</div>').includes('REVIEW: PASS'),
    )
    check(
      'R-pure 纯结论消息的交付为空串（含反引号与列表形态）',
      mem.episodeDelivery('REVIEW: PASS') === '' &&
        mem.episodeDelivery('`REVIEW: PASS`') === '' &&
        mem.episodeDelivery('**REVIEW：CHANGES**') === '' &&
        mem.episodeDelivery('- REVIEW: PASS') === '',
    )
    const epOther = mem.buildRoundEpisode({ roomId: 'r', changedPaths: ['c.ts'], verify: 'pass', delivery: '另一种交付' })
    const epOtherDelivery = mem.buildRoundEpisode({ roomId: 'r', changedPaths: ['a.ts', 'b.ts'], verify: 'pass', delivery: '不同的交付' })
    check(
      'R-pure 不同事实 → 不同 hash（路径或交付任一变化）',
      epA.hash !== epOther.hash && epA.hash !== epOtherDelivery.hash,
    )
  }

  // --- DB-backed retrieval -------------------------------------------------
  const memDir = mkdtempSync(join(tmpdir(), 'ac-prompt-mem-'))
  process.env.AC_DATA_DIR = memDir
  const memDb = await import('../server/db.ts')
  const ROOM = 'room-mem-check'

  const target = memDb.addMemory({
    scope: 'room',
    ownerId: ROOM,
    kind: 'fact',
    content: '修复了续传游标丢失的问题：折叠摘要与按游标取回。',
  }).memory
  const lostEntry = memDb.addMemory({ scope: 'room', ownerId: ROOM, content: '环境记录：lost connection 后自动重试成功。' }).memory
  const percentEntry = memDb.addMemory({ scope: 'room', ownerId: ROOM, content: '覆盖率说明：达到 100% 覆盖才算过。' }).memory
  const quoteEntry = memDb.addMemory({ scope: 'room', ownerId: ROOM, content: '他说"游标"又丢了，已定位。' }).memory
  // Push the target out of the 800-char recency window: ~12 × ~90 chars.
  for (let i = 0; i < 12; i += 1) {
    memDb.addMemory({ scope: 'room', ownerId: ROOM, content: `无关记忆${i}：${'水'.repeat(85)}` })
    await sleep2(2)
  }

  const idsOf = (picked) => picked.room.map((memory) => memory.id)

  check(
    'R1 3 字以上中文子串命中（FTS）',
    memDb.searchMemoryIds('room', ROOM, '续传游标').includes(target.id) &&
      idsOf(memDb.pickMemoriesForPrompt(null, ROOM, undefined, '续传游标')).includes(target.id),
  )
  const miss = memDb.pickMemoriesForPrompt(null, ROOM, undefined, '量子纠缠')
  check(
    'R2 未命中不注入（recency 同旧行为，旧条目不在）',
    memDb.searchMemoryIds('room', ROOM, '量子纠缠').length === 0 && !idsOf(miss).includes(target.id),
  )
  check(
    'R3 预算不变（room 非钉选 ≤ 800）',
    miss.room.filter((memory) => !memory.pinned).reduce((sum, memory) => sum + memory.content.length, 0) <= 800,
    `${miss.room.reduce((sum, memory) => sum + memory.content.length, 0)}`,
  )
  check(
    'R4 2 字中文走 LIKE 回退命中',
    memDb.searchMemoryIds('room', ROOM, '游标').includes(target.id) &&
      idsOf(memDb.pickMemoriesForPrompt(null, ROOM, undefined, '游标')).includes(target.id),
  )
  const mixed = memDb.searchMemoryIds('room', ROOM, '游标 lost')
  check('R4b 混排取并集（LIKE 短词 + FTS 长词都命中）', mixed.includes(target.id) && mixed.includes(lostEntry.id), JSON.stringify(mixed))
  check(
    'R5 LIKE 转义：「%」只命中字面百分号条目',
    JSON.stringify(memDb.searchMemoryIds('room', ROOM, '%')) === JSON.stringify([percentEntry.id]),
  )
  const noQuery = idsOf(memDb.pickMemoriesForPrompt(null, ROOM))
  const emptyQuery = idsOf(memDb.pickMemoriesForPrompt(null, ROOM, undefined, ''))
  check(
    'R7 空 query 与不传一致（不发起检索）',
    JSON.stringify(noQuery) === JSON.stringify(emptyQuery) && !noQuery.includes(target.id),
  )
  check('R8 含引号的查询不抛且命中字面内容', memDb.searchMemoryIds('room', ROOM, '他说"游标"又丢了').includes(quoteEntry.id))
  memDb.updateMemory(target.id, { pinned: true })
  check(
    'R6 钉选优先（旧条目钉选后必在注入中）',
    idsOf(memDb.pickMemoriesForPrompt(null, ROOM, undefined, '量子纠缠')).includes(target.id),
  )
  memDb.updateMemory(target.id, { pinned: false })

  // R9 (B04 review 1): with the FTS index unavailable, long terms must
  // DEGRADE to LIKE — not vanish. (The flag is test-injected; the real
  // unavailable path — a broken pre-existing vtable — is locked by sop-check
  // S10f end-to-end.)
  memDb.__setMemoryFtsForTests(false)
  check(
    'R9 FTS 不可用：长词降级 LIKE 仍命中',
    memDb.searchMemoryIds('room', ROOM, '续传游标').includes(target.id),
  )
  const degradedMixed = memDb.searchMemoryIds('room', ROOM, '游标 lost')
  check(
    'R9 FTS 不可用：混排里长词也被承接（短+长都命中）',
    degradedMixed.includes(target.id) && degradedMixed.includes(lostEntry.id),
    JSON.stringify(degradedMixed),
  )
  memDb.__setMemoryFtsForTests(true)

  // Distinct facts must coexist as two episodes (a fixed-hash regression
  // would collapse the second into `existed: true`).
  const ROOM2 = 'room-mem-episodes'
  const ep1 = memDb.addRoundEpisode({ roomId: ROOM2, changedPaths: ['a.ts'], verify: 'pass', delivery: '第一轮交付内容' })
  const ep2 = memDb.addRoundEpisode({ roomId: ROOM2, changedPaths: ['b.ts'], verify: 'pass', delivery: '第二轮交付内容' })
  check(
    'R-DB 不同事实的两条 episode 共存（hash 区分，不误去重）',
    !ep1.existed && !ep2.existed && ep1.memory.id !== ep2.memory.id,
    JSON.stringify([ep1.existed, ep2.existed]),
  )

  try {
    rmSync(memDir, { recursive: true, force: true })
  } catch {
    /* db handle still open — Windows EBUSY, same treatment as sop-check */
  }
}

if (failed) {
  console.log(`\n${failed} case(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nOK: prompt transcript contract passed (delivery + bound + budget + ceiling + override + memory retrieval)')
}
