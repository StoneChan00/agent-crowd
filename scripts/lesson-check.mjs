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

const first = db.addFailureEpisode({ roomId: ROOM, cause: '自审无效', changedPaths: ['a.ts'] })
check('L2 首次写入 → lesson + pinned', !first.existed && first.memory.pinned && first.memory.kind === 'lesson')
const repeat = db.addFailureEpisode({ roomId: ROOM, cause: '自审无效', changedPaths: ['a.ts'] })
check('L2 完全相同 → 去重不再写', repeat.existed && repeat.memory.id === first.memory.id)

const second = db.addFailureEpisode({ roomId: ROOM, cause: '验证命令未通过', changedPaths: ['b.ts'] })
const lessons = db.listMemories('room', ROOM).filter((memory) => memory.content.startsWith(mem.FAILURE_LESSON_PREFIX))
const pinned = lessons.filter((memory) => memory.pinned)
check('L2 新教训 → 最新一条被钉选', lessons.length === 2 && pinned.length === 1 && pinned[0].id === second.memory.id)
check('L2 旧教训保留但不再钉选', lessons.some((memory) => memory.id === first.memory.id && !memory.pinned))

// A → B → A: the hash hit must be re-pinned and the newer B unpinned.
const again = db.addFailureEpisode({ roomId: ROOM, cause: '自审无效', changedPaths: ['a.ts'] })
const afterAgain = db.listMemories('room', ROOM).filter((memory) =>
  memory.content.startsWith(mem.FAILURE_LESSON_PREFIX),
)
const pinnedAfterAgain = afterAgain.filter((memory) => memory.pinned)
check(
  'L2 A→B→A：命中的旧教训被重新钉选',
  again.existed && again.memory.id === first.memory.id && again.memory.pinned,
)
check(
  'L2 A→B→A：仍只有一条钉选，B 已解除',
  pinnedAfterAgain.length === 1 &&
    pinnedAfterAgain[0].id === first.memory.id &&
    afterAgain.some((memory) => memory.id === second.memory.id && !memory.pinned),
)

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

// The DB handle keeps the temp dir open on Windows; prompt-check leaves its
// temp dir in place too, so this script does the same.

if (failed) {
  console.log(`\n${failed} case(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nOK: failure lessons + token usage passed')
}
