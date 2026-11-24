/**
 * B08 contract: failure lessons + token usage aggregation.
 *
 *   node scripts/lesson-check.mjs
 *
 * L1 pure builder — deterministic content/hash, prefix, path rollover.
 * L2 DB lessons  — exact-repeat dedupe, only the latest lesson stays pinned.
 * L3 usage       — harness-reported tokens only (no estimation), per character
 *                  totals incl. total fallback to input + output.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failed = 0
function check(name, ok, detail) {
  if (ok) {
    console.log(`✓ ${name}`)
    return
  }
  failed += 1
  console.log(`✗ ${name}${detail ? ` — ${detail}` : ''}`)
}

const mem = await import('../server/memory.ts')

// --- L1: pure builder -----------------------------------------------------
const a = mem.buildFailureEpisode({ cause: '自审无效', changedPaths: ['b.ts', 'a.ts'] })
const b = mem.buildFailureEpisode({ cause: '自审无效', changedPaths: ['a.ts', 'b.ts'] })
const c = mem.buildFailureEpisode({ cause: '验证命令未通过', changedPaths: ['a.ts', 'b.ts'] })
check('L1 内容带固定前缀', a.content.startsWith(mem.FAILURE_LESSON_PREFIX))
check('L1 路径排序 → 同一事实同一 hash', a.hash === b.hash && a.content === b.content)
check('L1 原因不同 → hash 不同', a.hash !== c.hash)
check(
  'L1 多行原因压成一行',
  mem.buildFailureEpisode({ cause: '第一行\n第二行', changedPaths: [] }).content ===
    `${mem.FAILURE_LESSON_PREFIX}第一行 第二行`,
)

// --- L2/L3: DB-backed -----------------------------------------------------
const dataDir = mkdtempSync(join(tmpdir(), 'ac-lesson-'))
process.env.AC_DATA_DIR = dataDir
const db = await import('../server/db.ts')
const ROOM = 'room-lesson-check'

const first = db.addFailureEpisode({ roomId: ROOM, cause: '自审无效', changedPaths: ['a.ts'], roundId: 'r-1' })
check(
  'L2 首次写入 → lesson + pinned + 来源轮次',
  !first.existed && first.memory.pinned && first.memory.kind === 'lesson' && first.memory.sourceRoundId === 'r-1',
)
const repeat = db.addFailureEpisode({ roomId: ROOM, cause: '自审无效', changedPaths: ['a.ts'] })
check('L2 完全相同 → 去重不再写', repeat.existed && repeat.memory.id === first.memory.id)

const promotedA = db.getMemory(first.memory.id)
check(
  'L2 重复出现 → 计数 +1 并升级为常驻',
  promotedA?.repeatCount === 2 && promotedA.promoted && promotedA.lastSeenAt !== null,
  JSON.stringify(promotedA),
)

const second = db.addFailureEpisode({ roomId: ROOM, cause: '验证命令未通过', changedPaths: ['b.ts'] })
const lessons = db.listMemories('room', ROOM).filter((memory) => memory.content.startsWith(mem.FAILURE_LESSON_PREFIX))
const pinned = lessons.filter((memory) => memory.pinned)
check(
  'L2 新教训 → 最新一条被钉选，常驻约定继续钉选',
  lessons.length === 2 && pinned.length === 2 && pinned.some((memory) => memory.id === second.memory.id),
)
check('L2 旧教训升级后保留钉选', lessons.some((memory) => memory.id === first.memory.id && memory.pinned && memory.promoted))

// A → B → A: the hash hit must be re-pinned (promoted) and the newer B unpinned.
const again = db.addFailureEpisode({ roomId: ROOM, cause: '自审无效', changedPaths: ['a.ts'] })
const afterAgain = db.listMemories('room', ROOM).filter((memory) =>
  memory.content.startsWith(mem.FAILURE_LESSON_PREFIX),
)
const pinnedAfterAgain = afterAgain.filter((memory) => memory.pinned)
check('L2 A→B→A：命中的旧教训计数继续累加', again.existed && again.memory.id === first.memory.id && again.memory.repeatCount === 3)
check(
  'L2 A→B→A：常驻约定保留，B 已解除',
  pinnedAfterAgain.length === 1 &&
    pinnedAfterAgain[0].id === first.memory.id &&
    afterAgain.some((memory) => memory.id === second.memory.id && !memory.pinned),
)

const fromMessage = db.addMemory({
  scope: 'room',
  ownerId: ROOM,
  kind: 'fact',
  content: '这条来自消息',
  sourceRoomId: ROOM,
  sourceMessageId: 'm-1',
})
check('L2 手动记忆保留来源消息', fromMessage.memory.sourceMessageId === 'm-1')

const episode = db.addRoundEpisode({
  roomId: ROOM,
  changedPaths: ['a.ts'],
  verify: 'pass',
  delivery: '完成',
  roundId: 'r-2',
})
check('L2 episode 保留来源轮次', episode.memory.sourceRoundId === 'r-2' && episode.memory.kind === 'episode')

db.addMessage({
  roomId: ROOM,
  authorType: 'character',
  characterId: 'c1',
  authorName: '审查者',
  content: 'review',
  meta: { harness: 'claude', model: 'opus', tokens: { input: 100, output: 20, cacheRead: 30 } },
})
db.addMessage({
  roomId: ROOM,
  authorType: 'character',
  characterId: 'c1',
  authorName: '审查者',
  content: '再来一轮',
  meta: { harness: 'claude', model: 'opus', tokens: { input: 50, output: 10, total: 80 } },
})
db.addMessage({
  roomId: ROOM,
  authorType: 'character',
  characterId: 'c2',
  authorName: '实现者',
  content: '无用量',
  meta: { harness: 'codex', model: 'gpt' },
})
db.addMessage({
  roomId: ROOM,
  authorType: 'user',
  authorName: '你',
  content: '用户消息',
  meta: { tokens: { input: 999, output: 999 } },
})

const usage = db.getRoomUsage(ROOM)
const c1 = usage.characters.find((character) => character.characterId === 'c1')
check('L3 只统计带 usage 的角色消息', usage.totals.turns === 2 && usage.characters.length === 1)
check(
  'L3 合计与缓存字段',
  c1?.input === 150 && c1?.output === 30 && c1?.cacheRead === 30 && c1?.total === 200,
  JSON.stringify(c1),
)
check('L3 total 缺失时回退 input + output（100+20=120，50+10 用上报的 80）', c1?.total === 200)

// --- L4: delivery report ------------------------------------------------
const turn = db.createTurn({ roomId: ROOM, characterId: 'c1', triggerMessageId: null, roundId: 'r-9' })
db.updateTurn(turn.id, {
  status: 'done',
  output: '本轮交付：修好了登录',
  changed: ['b.ts', 'a.ts'],
  endedAt: Date.now(),
})
db.addRoundCheck({ roomId: ROOM, roundId: 'r-9', kind: 'review', verdict: 'pass', characterId: 'c1' })
db.addRoundCheck({ roomId: ROOM, roundId: 'r-9', kind: 'verify', verdict: 'pass', detail: 'exit 0' })
db.addRoundCheck({ roomId: ROOM, roundId: 'r-9', kind: 'commit', verdict: 'pass', detail: 'abc1234' })
db.addMessage({
  roomId: ROOM,
  authorType: 'character',
  characterId: 'c1',
  authorName: '审查者',
  content: 'PASS',
  meta: { turnId: turn.id, tokens: { input: 10, output: 5 } },
})
const report = db.listRoundReports(ROOM).find((item) => item.roundId === 'r-9')
check(
  'L4 轮次报告聚合改动/交付/token/commit/证据',
  report?.turnCount === 1 &&
    report.changedPaths.join() === 'a.ts,b.ts' &&
    report.delivery.includes('修好了登录') &&
    report.tokens.total === 15 &&
    report.commitHash === 'abc1234' &&
    report.checks.length === 3 &&
    report.checks.some((check) => check.kind === 'commit'),
  JSON.stringify(report),
)

// A reviewer turn after the implementer must not become the report's author.
const reviewTurn = db.createTurn({ roomId: ROOM, characterId: 'c2', triggerMessageId: null, roundId: 'r-9' })
db.updateTurn(reviewTurn.id, { status: 'done', output: 'REVIEW: PASS', endedAt: Date.now() })
const reportAfterReview = db.listRoundReports(ROOM).find((item) => item.roundId === 'r-9')
check(
  'L4 报告作者取最后改动者，而不是最后发言的 reviewer',
  reportAfterReview?.authorCharacterId === 'c1' && reportAfterReview.turnCount === 2,
  JSON.stringify({ author: reportAfterReview?.authorCharacterId, turns: reportAfterReview?.turnCount }),
)

// The DB handle keeps the temp dir open on Windows; prompt-check leaves its
// temp dir in place too, so this script does the same.

if (failed) {
  console.log(`\n${failed} case(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nOK: failure lessons + token usage passed')
}
