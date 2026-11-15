/**
 * P0-3 SOP-gate contract: change evidence (3a), REVIEW verdicts (3b) and
 * the round-close gate (3c) — as specified in workspace/p0-plan.md.
 *
 *   node scripts/sop-check.mjs
 *
 * Layers (per-layer counts are DELIBERATELY omitted, B05b-3: they drifted
 * every time a row was added — the only authoritative count is the dynamic
 * n/n in the OK line at the bottom):
 *   S1  verdict parser  — standalone REVIEW: lines, multi-block markdown
 *                         (blank-line splits, bold paragraphs, lists),
 *                         quoted verdicts (blockquote/table/heading are
 *                         invisible), variants, whole-line code spans
 *   S2  gate table      — every decision row of gateDecision, incl. the B05
 *                         author dimension and both fail-closed halves
 *   S3  worktree snap   — repo-root resolution: a cwd INSIDE a subdirectory
 *                         still sees sibling-directory changes; non-git
 *                         working dirs report available:false; untracked
 *                         fingerprints + dirty-file re-edit fallback
 *   S4  green path      — write + REVIEW: PASS + verify exit 0 → verify runs
 *                         exactly once, round-end summary appears
 *   S5  verify fails     — exit 1 with a LONG output (marker beyond the
 *                         1500-char prefix) → no summary, gate notice whose
 *                         output TAIL (not head) carries the marker
 *   S6  no verdict      — changed round, no REVIEW line → blocked before any
 *                         verify runs
 *   S7  chat-only round  — no changes → gate never runs, summary normal
 *   S8  no verify config — changed + PASS closes directly; no verdict blocks
 *   S9  restart race     — while the verify command runs, POST /api/restart
 *                         must NOT fire the restart (gateActive drains)
 *   S9b stale idle       — a new turn started while the gate's verify was
 *                         running must never see a busy:false (SSE watch)
 *   S10 B04 episodes     — clean+changed+PASS rounds write exactly one
 *                         room-scope episode (repeat round = hash no-op;
 *                         verify-fail/no-verdict/chat write nothing; no-
 *                         verify PASS writes 「未配置验证」), and the
 *                         orchestrator's retrieval wiring pulls an out-of-
 *                         recency memory in only on a query hit
 *   S11 B05 self-review  — the implementer's own PASS blocks (notice names
 *                         「实现者本人」, no summary, no episode); no
 *                         designation keeps prior behavior; a designated
 *                         reviewer on another harness closes, a same-harness
 *                         reviewer or a PASS from someone else blocks
 *   S12 restart data dir — the WMI script args carry the restarting
 *                         server's data dir: a test-triggered restart
 *                         replacement must inherit the TEST database, not
 *                         boot a PROD-data zombie whose sweep kills the
 *                         live turns (2026-11-06 incident)
 *   S13 auto-commit     — a clean+changed+PASS round lands its work as
 *                         exactly one commit at the drain point; CHANGES
 *                         and chat-only rounds commit nothing; ignored
 *                         paths never enter the commit; push NEVER runs
 *                         (the bare remote's ref never moves); pre-staged
 *                         unrelated content stays out (--only) and a
 *                         vanished never-tracked path can't kill the batch
 *
 * Scenarios S4-S8 share one server (each room drained before the next
 * starts, so per-turn change attribution stays clean); S9 boots its own
 * server so the pending restart request can never leak across scenarios.
 * Pure-logic layers import the real modules — never re-typed constants.
 * Output: `OK: sop contract passed (n/n)`; non-zero exit on any failure.
 */
import { spawn } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { changedPathsBetween, commitPaths, diffSnapshotPaths, snapshotWorktree } from '../server/gitstate.ts'
import { gateDecision, parseReviewVerdict } from '../server/sop.ts'

const ROOT = join(import.meta.dirname, '..')
const IS_WIN = process.platform === 'win32'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let passed = 0
let failed = 0
const servers = []
const tempDirs = []

function check(name, ok, detail = '') {
  if (ok) {
    passed += 1
    console.log(`✓ ${name}`)
  } else {
    failed += 1
    console.log(`× ${name}${detail ? `: ${detail}` : ''}`)
  }
}

/* ------------------------------------------------------------- server I/O */

async function req(port, path, init) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: { 'content-type': 'application/json' },
    ...init,
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${init?.method ?? 'GET'} ${path} -> ${response.status} ${text}`)
  return text ? JSON.parse(text) : null
}

const freePort = () => 20000 + Math.floor(Math.random() * 18000)

/** Boot a real server; resolve once /api/health answers. Retries on port races. */
async function bootServer(dataDir) {
  let lastLog = ''
  for (let attempt = 0; attempt < 4; attempt++) {
    const port = freePort()
    const proc = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'server', 'index.ts')], {
      cwd: ROOT,
      env: { ...process.env, AC_DATA_DIR: dataDir, AC_PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    servers.push(proc)
    let log = ''
    proc.stdout.on('data', (chunk) => (log += chunk))
    proc.stderr.on('data', (chunk) => (log += chunk))
    const exitCode = new Promise((resolve) => proc.once('exit', (code) => resolve(code)))
    const deadline = Date.now() + 30_000
    let up = false
    let dead = false
    while (Date.now() < deadline && !dead) {
      const outcome = await Promise.race([
        req(port, '/api/health')
          .then((health) => ({ health, state: 'up' }))
          .catch(() => ({ health: null, state: 'wait' })),
        exitCode.then((code) => ({ health: null, state: `dead:${code}` })),
      ])
      if (outcome.state === 'up') {
        up = true
        return { port, pid: proc.pid, proc, health: outcome.health }
      }
      if (typeof outcome.state === 'string' && outcome.state.startsWith('dead:')) {
        dead = true
        break
      }
      await sleep(200)
    }
    lastLog = log
  }
  throw new Error(`server failed to boot on 4 ports; last boot log tail:\n${lastLog.slice(-2000)}`)
}

async function hardKill(proc) {
  if (proc.exitCode !== null || proc.signalCode !== null) return
  if (IS_WIN) {
    await new Promise((resolve, reject) => {
      const killer = spawn('taskkill', ['/F', '/T', '/PID', String(proc.pid)], { stdio: 'ignore', windowsHide: true })
      killer.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`taskkill exit ${code}`))))
      killer.on('error', reject)
    })
  } else {
    proc.kill('SIGKILL')
  }
  await Promise.race([
    new Promise((resolve) => proc.once('exit', resolve)),
    sleep(5_000).then(() => {
      throw new Error('server refused to die after kill')
    }),
  ])
  await sleep(300)
}

/* ------------------------------------------------------------------ polling */

async function waitState(port, roomId, predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const state = await req(port, `/api/rooms/${roomId}/state`)
      if (predicate(state)) return state
    } catch {
      /* mid-restart poll gap */
    }
    await sleep(200)
  }
  return null
}

async function waitMessages(port, roomId, predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const { messages } = await req(port, `/api/rooms/${roomId}/messages?limit=200`)
    if (predicate(messages)) return messages
    await sleep(300)
  }
  return null
}

/* ------------------------------------------------------------------ sqlite */

function withDb(dataDir, fn) {
  const handle = new DatabaseSync(join(dataDir, 'agent-crowd.db'))
  try {
    return fn(handle)
  } finally {
    handle.close()
  }
}

const roundChecksWhere = (dataDir, where, ...args) =>
  withDb(dataDir, (handle) => handle.prepare(`select * from round_checks where ${where}`).all(...args))

/* ---------------------------------------------------------------- fixtures */

const ON_USER_ONLY = {
  onUser: true, onAll: false, onCharacters: [], onCharacterNames: [], keyword: '', mention: false, onRoundEnd: false,
}
const QUIET = {
  onUser: false, onAll: false, onCharacters: [], onCharacterNames: [], keyword: '', mention: false, onRoundEnd: false,
}
/** Follows the developer by name so the round carries change + verdict. */
const FOLLOWS_DEV = {
  onUser: false, onAll: false, onCharacters: [], onCharacterNames: ['开发甲'], keyword: '', mention: false, onRoundEnd: false,
}
const ROUND_SUMMARIZER = {
  onUser: false, onAll: false, onCharacters: [], onCharacterNames: [], keyword: '', mention: false, onRoundEnd: true,
}

async function makeRoom(port, name, workingDir, verifyCommand = '') {
  return req(port, '/api/rooms', {
    method: 'POST',
    body: JSON.stringify({ name, maxHops: 4, workingDir, verifyCommand }),
  })
}

async function makeCharacter(port, roomId, name, triggers, persona = 'SOP 测试角色') {
  return req(port, `/api/rooms/${roomId}/characters`, {
    method: 'POST',
    body: JSON.stringify({ name, harness: 'mock', model: 'mock', persona, triggers }),
  })
}

async function postMessage(port, roomId, content) {
  return req(port, `/api/rooms/${roomId}/messages`, { method: 'POST', body: JSON.stringify({ content }) })
}

const characterMessages = (messages, authorName) =>
  messages.filter((message) => message.authorType === 'character' && message.authorName === authorName)

const systemNotices = (messages, keyword) =>
  messages.filter((message) => message.authorType === 'system' && message.content.includes(keyword))

/** Wait for a room to be fully drained: no turn, no queue, no gate running. */
async function waitIdle(port, roomId, timeoutMs = 30_000) {
  const state = await waitState(
    port,
    roomId,
    (candidate) => !candidate.busy && candidate.queuedCharacterIds.length === 0 && candidate.gate === 'idle',
    timeoutMs,
  )
  return state !== null
}

/**
 * Subscribe to a room's SSE stream and collect every event frame — the only
 * way to catch a TRANSIENT broadcast (a busy:false flash has no persistent
 * trace in /state or the db, but it drops the web client's live view on
 * arrival).
 */
async function sseWatch(port, roomId) {
  const controller = new AbortController()
  const events = []
  const response = await fetch(`http://127.0.0.1:${port}/api/rooms/${roomId}/events`, {
    signal: controller.signal,
  })
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const drain = (async () => {
    let buffer = ''
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let index
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, index)
          buffer = buffer.slice(index + 2)
          const lines = frame.split('\n')
          const event = lines.find((line) => line.startsWith('event: '))?.slice('event: '.length)
          const dataLine = lines.find((line) => line.startsWith('data: '))
          if (!event || !dataLine) continue
          try {
            events.push({ event, data: JSON.parse(dataLine.slice('data: '.length)) })
          } catch {
            /* partial frame; the next chunk completes it */
          }
        }
      }
    } catch {
      /* aborted */
    }
  })()
  return {
    events,
    stop: async () => {
      await sleep(300) // let buffered frames land before tearing down
      controller.abort()
      await drain
    },
  }
}

/* ------------------------------------------------------- S1 verdict parser */

function scenarioParser() {
  const cases = [
    ['REVIEW: PASS', 'pass'],
    ['REVIEW: CHANGES', 'changes'],
    ['**REVIEW: PASS**', 'pass'],
    ['REVIEW：PASS', 'pass'],
    ['review: pass', 'pass'],
    ['REVIEW:CHANGES', 'changes'],
    ['我认为 REVIEW: PASS 是合适的', null],
    ['REVIEW: PASSED', null],
    ['```\nREVIEW: PASS\n```', null],
    ['先看 `REVIEW: PASS` 这行', null],
    ['完全无关的正文', null],
  ]
  for (const [content, expected] of cases) {
    check(
      `S1 parse ${JSON.stringify(content)} → ${expected}`,
      parseReviewVerdict(content) === expected,
      `实际 ${JSON.stringify(parseReviewVerdict(content))}`,
    )
  }
  const lastWins = parseReviewVerdict('初判：\nREVIEW: CHANGES\n修复后复核，\n通过。\nREVIEW: PASS')
  check('S1 多条结论取最后一行（CHANGES → PASS = pass）', lastWins === 'pass', `实际 ${lastWins}`)
  const beyondTail = 'REVIEW: PASS\n其一\n其二\n其三\n其四\n其五\n其六'
  check('S1 超出尾部 5 行的结论不识别', parseReviewVerdict(beyondTail) === null, `实际 ${parseReviewVerdict(beyondTail)}`)
  const withinTail = 'REVIEW: CHANGES\n其一\n其二\n其三\n其四\nREVIEW: PASS'
  check('S1 尾部 5 行内的最后结论生效', parseReviewVerdict(withinTail) === 'pass', `实际 ${parseReviewVerdict(withinTail)}`)

  // Multi-block markdown — how real reviews arrive (review round 2: the
  // space-joining extraction glued these into one line and every one of
  // them parsed null while the mock-only S1 cases stayed green).
  const casesBlocks = [
    ['结论：通过。\n\nREVIEW: PASS', 'pass', '空行分段不与结论粘连'],
    ['**结论：通过。**\n\nREVIEW: PASS', 'pass', '加粗独立段不吞结论行'],
    ['- 问题一\n- 问题二\n\nREVIEW: PASS', 'pass', '列表后的结论行独立'],
    ['REVIEW: PASS\n\n其一\n\n其二\n\n其三', 'pass', '尾部 5 行内含空行仍生效'],
    ['看\n**REVIEW: PASS**', 'pass', '软换行后整行加粗是独立行'],
    ['`REVIEW: PASS`', 'pass', '整行仅一个 code span 仍识别（规则 9 示例被照抄）'],
  ]
  for (const [content, expected, label] of casesBlocks) {
    const actual = parseReviewVerdict(content)
    check(`S1 ${label}`, actual === expected, `实际 ${JSON.stringify(actual)}`)
  }

  // Quoted verdicts are not the author's conclusion (review round 3): the
  // extractor reads only top-level / list-item paragraph lines, so a verdict
  // inside a blockquote, a table cell or a heading is invisible — and it
  // doesn't eat into the tail-lines budget either.
  const casesQuoted = [
    ['> REVIEW: PASS', null, '引用块里的结论不算门禁信号'],
    ['| 项 | 值 |\n|---|---|\n| 门禁 | REVIEW: PASS |', null, '表格单元格里的结论不算门禁信号'],
    ['## REVIEW: PASS', null, '标题行不算结论'],
    ['- 列表里的结论有效：\n- REVIEW: PASS', 'pass', 'listItem 段落里的结论仍然生效'],
    ['> 引用：别人说通过了。\n\nREVIEW: PASS', 'pass', '引用块后的正文结论不受引用影响'],
  ]
  for (const [content, expected, label] of casesQuoted) {
    const actual = parseReviewVerdict(content)
    check(`S1 ${label}`, actual === expected, `实际 ${JSON.stringify(actual)}`)
  }
}

/* -------------------------------------------------------- S2 decision table */

function scenarioGateTable() {
  // Author fixtures for the B05 dimension: implementer (mock), reviewer
  // (custom harness), a same-harness reviewer, and a wrong reviewer.
  const implementer = { id: 'dev', harness: 'mock' }
  const otherMock = { id: 'other', harness: 'mock' }
  const customReviewer = { id: 'rev', harness: 'custom' }
  const rows = [
    [{ changed: 0, verifyRequired: true, verify: 'none', verdict: 'none' }, 'close', '无改动 → 直接收尾（不跑验证）'],
    [{ changed: 2, verifyRequired: false, verify: 'none', verdict: 'changes' }, 'block', '有改动无验证命令 + CHANGES → 阻断'],
    [
      { changed: 2, verifyRequired: false, verify: 'none', verdict: 'pass', verdictAuthor: otherMock, changedAuthor: implementer },
      'close',
      '有改动无验证命令 + 他角色 PASS → 收尾',
    ],
    [
      { changed: 1, verifyRequired: true, verify: 'none', verdict: 'none' },
      'block',
      '有验证命令但无结论 → 先卡结论不白跑验证',
    ],
    [
      { changed: 1, verifyRequired: true, verify: 'none', verdict: 'pass', verdictAuthor: otherMock, changedAuthor: implementer },
      'run-verify',
      '有改动 + 他角色 PASS + 未验证 → 跑验证',
    ],
    [
      { changed: 1, verifyRequired: true, verify: 'fail', verdict: 'pass', verdictAuthor: otherMock, changedAuthor: implementer },
      'block',
      '验证失败 → 阻断',
    ],
    [
      { changed: 1, verifyRequired: true, verify: 'pass', verdict: 'pass', verdictAuthor: otherMock, changedAuthor: implementer },
      'close',
      '验证通过 + 他角色 PASS → 收尾',
    ],
    // B05 author dimension.
    [
      { changed: 1, verifyRequired: false, verify: 'none', verdict: 'pass', changedAuthor: implementer },
      'block',
      'PASS 缺作者 → fail closed 阻断',
    ],
    [
      { changed: 1, verifyRequired: false, verify: 'none', verdict: 'pass', verdictAuthor: implementer, changedAuthor: implementer },
      'block',
      '实现者自审 PASS → 阻断（self-review）',
    ],
    [
      { changed: 1, verifyRequired: false, verify: 'none', verdict: 'pass', verdictAuthor: otherMock, changedAuthor: implementer, reviewer: customReviewer },
      'block',
      'PASS 非指定 reviewer → 阻断',
    ],
    [
      { changed: 1, verifyRequired: false, verify: 'none', verdict: 'pass', verdictAuthor: otherMock, changedAuthor: implementer, reviewer: otherMock },
      'block',
      '指定 reviewer 与实现者同一 harness → 阻断',
    ],
    [
      { changed: 1, verifyRequired: false, verify: 'none', verdict: 'pass', verdictAuthor: customReviewer, changedAuthor: implementer, reviewer: customReviewer },
      'close',
      '指定异构 reviewer 的 PASS → 收尾',
    ],
    // B05b-4: designated reviewer present but ineligible (disabled /
    // summarizer) — actionable block BEFORE the identity checks.
    [
      { changed: 1, verifyRequired: false, verify: 'none', verdict: 'pass', verdictAuthor: otherMock, changedAuthor: implementer, reviewer: customReviewer, reviewerEligible: false },
      'block',
      '指定 reviewer 资格失效（停用/总结角色）→ 可操作阻断',
      'reviewer-ineligible',
    ],
    // B05b-2: the OTHER fail-closed half — verdict present, implementer
    // author missing. Real wiring cannot produce this state (changedAuthor
    // is recorded on every changed turn), but the branch exists in the
    // single decision table, so it must be pinned like every other row.
    [
      { changed: 1, verifyRequired: false, verify: 'none', verdict: 'pass', verdictAuthor: otherMock, changedAuthor: null },
      'block',
      '改动作者缺失 → fail closed 阻断',
      'no-author',
    ],
  ]
  for (const [input, expected, label, expectReason] of rows) {
    const actual = gateDecision(input)
    check(
      `S2 ${label}`,
      actual.action === expected && (!expectReason || actual.reason === expectReason),
      `实际 ${actual.action}(${actual.reason})`,
    )
  }
}

/* -------------------------------------------------------- S3 worktree snap */

async function scenarioSnapshot() {
  const repo = mkdtempSync(join(tmpdir(), 'ac-sop-s3-'))
  tempDirs.push(repo)
  execFileSync('git', ['-C', repo, 'init'], { stdio: 'ignore' })
  execFileSync('git', ['-C', repo, 'add', '-A'], { stdio: 'ignore' })
  execFileSync('git', ['-C', repo, '-c', 'user.name=sop', '-c', 'user.email=sop@t', 'commit', '-m', 'seed', '--allow-empty'], {
    stdio: 'ignore',
  })
  const sub = join(repo, 'workspace')
  mkdirSync(sub, { recursive: true })

  const clean1 = await snapshotWorktree(sub)
  const clean2 = await snapshotWorktree(sub)
  check('S3 干净仓库：cwd 在子目录也能解析到仓库根', clean1.available === true && clean2.available === true)
  check('S3 干净仓库：两次快照 digest 相同', clean1.digest === clean2.digest && clean1.digest !== '')

  // Change a file in a SIBLING directory — exactly the shape this project's
  // own room has (cwd=workspace/, real changes land under server/).
  mkdirSync(join(repo, 'server-sim'), { recursive: true })
  writeFileSync(join(repo, 'server-sim', 'a.ts'), 'export const a = 1\n')
  const dirty = await snapshotWorktree(sub)
  check('S3 兄弟目录改动：digest 变化', dirty.available && dirty.digest !== clean1.digest)
  check(
    'S3 兄弟目录改动：paths 含该文件（toplevel 解析正确）',
    dirty.paths.includes('server-sim/a.ts'),
    JSON.stringify(dirty.paths),
  )
  const diff = diffSnapshotPaths(clean1, dirty)
  check(
    'S3 diffSnapshotPaths 恰好得到变化文件',
    diff.length === 1 && diff[0] === 'server-sim/a.ts',
    JSON.stringify(diff),
  )

  // A tracked file edited AGAIN keeps its XY code (` M` → ` M`) AND, for a
  // 1-line-for-1-line swap, the diffstat numbers too (`2 +-` twice) — only
  // the entry fingerprint sees it (review round 2: the status-only diff
  // let a gated round close).
  const tracked = join(repo, 'tracked.ts')
  writeFileSync(tracked, 'export const t = 1\n')
  execFileSync('git', ['-C', repo, 'add', '-A'], { stdio: 'ignore' })
  execFileSync('git', ['-C', repo, '-c', 'user.name=sop', '-c', 'user.email=sop@t', 'commit', '-m', 'tracked', '--allow-empty'], { stdio: 'ignore' })
  const cleanTracked = await snapshotWorktree(sub)
  writeFileSync(tracked, 'export const t = 2\n')
  const dirtyTracked = await snapshotWorktree(sub)
  check('S3 dirty 文件首次弄脏 → changed 含该文件', changedPathsBetween(cleanTracked, dirtyTracked).includes('tracked.ts'))
  await sleep(60)
  writeFileSync(tracked, 'export const t = 9\n') // same ` M` code, same 1-line swap, new content
  const reEdited = await snapshotWorktree(sub)
  check('S3 二次修改同文件（XY 与 diffstat 均不变）→ digest 仍变化', reEdited.digest !== dirtyTracked.digest)
  const reDiff = diffSnapshotPaths(dirtyTracked, reEdited)
  check(
    'S3 二次修改同文件 → 指纹级 diff 恰好得到该文件',
    reDiff.length === 1 && reDiff[0] === 'tracked.ts',
    JSON.stringify(reDiff),
  )
  // The fallback: a digest that moved with NO attributable entry diff
  // (defensive — anything the fingerprint somehow missed) degrades to the
  // after snapshot's dirty set, never to "no change".
  check(
    'S3 digest 变化但 diff 无法归属 → 退化为 after 脏路径全集',
    JSON.stringify(changedPathsBetween(dirtyTracked, { ...reEdited, digest: 'force-different' })) === JSON.stringify(reEdited.paths),
    JSON.stringify(changedPathsBetween(dirtyTracked, { ...reEdited, digest: 'force-different' })),
  )

  // Untracked content edits keep `??` and never show in `git diff HEAD`:
  // the size+mtime fingerprint is what makes them visible to the gate.
  const untracked = join(sub, 'scratch.txt')
  writeFileSync(untracked, 'v1')
  const un1 = await snapshotWorktree(sub)
  check('S3 untracked 快照带指纹', un1.entries.some((entry) => entry.path === 'workspace/scratch.txt' && entry.fingerprint))
  await sleep(60)
  writeFileSync(untracked, 'version 2 with different length')
  const un2 = await snapshotWorktree(sub)
  check('S3 untracked 内容变化 → digest 变化', un2.digest !== un1.digest)
  check(
    'S3 untracked 内容变化 → changed 含该文件',
    changedPathsBetween(un1, un2).includes('workspace/scratch.txt'),
    JSON.stringify(changedPathsBetween(un1, un2)),
  )

  // Unjudgeable stays "cannot tell" — never silently "no changes".
  check('S3 两侧其一不可判定 → null（无法判定≠无改动）', changedPathsBetween(clean1, { ...clean1, available: false }) === null)
  check('S3 digest 相同 → []', JSON.stringify(changedPathsBetween(clean1, { ...clean1 })) === '[]')

  const nonGit = mkdtempSync(join(tmpdir(), 'ac-sop-s3n-'))
  tempDirs.push(nonGit)
  const noRepo = await snapshotWorktree(nonGit)
  check('S3 非 git 工作目录 → available:false', noRepo.available === false)
}

/* --------------------------------------------- S13 unit: commitPaths itself */

async function scenarioAutoCommitUnit() {
  const repo = mkdtempSync(join(tmpdir(), 'ac-s13u-'))
  tempDirs.push(repo)
  const gitIn = (args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
  const headFiles = () =>
    gitIn(['show', '--name-only', '--format=', 'HEAD'])
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
  execFileSync('git', ['-C', repo, 'init'], { stdio: 'ignore' })
  writeFileSync(join(repo, '.gitignore'), 'local-state/\n')
  execFileSync('git', ['-C', repo, 'add', '-A'], { stdio: 'ignore' })
  execFileSync('git', ['-C', repo, '-c', 'user.name=sop', '-c', 'user.email=sop@t', 'commit', '-m', 'seed', '--allow-empty'], {
    stdio: 'ignore',
  })

  // Mixed change set: one ignored + one normal file → only the normal one
  // lands; the ignored file is left untouched on disk.
  mkdirSync(join(repo, 'local-state'), { recursive: true })
  writeFileSync(join(repo, 'local-state', 'scratch.json'), '{}')
  writeFileSync(join(repo, 'feature.ts'), 'export const feature = 1\n')
  const mixed = await commitPaths(repo, ['local-state/scratch.json', 'feature.ts'], {
    subject: 'auto: 混合改动测试',
    body: (kept) => `改动: ${kept.join('、')}\nREVIEW: PASS（测试）`,
  })
  check(
    'S13e ignored 路径被滤除，普通文件正常提交',
    mixed.ok && !mixed.skipped && typeof mixed.hash === 'string' && mixed.hash.length > 0 && headFiles().length === 1 && headFiles()[0] === 'feature.ts',
    JSON.stringify({ mixed, files: headFiles() }),
  )
  check(
    'S13e commitPaths.files 即为实际提交路径',
    Array.isArray(mixed.files) && mixed.files.length === 1 && mixed.files[0] === 'feature.ts',
    JSON.stringify(mixed.files),
  )
  const body1 = gitIn(['log', '-1', '--format=%B'])
  check(
    'S13e commit 双段消息（主题 + 正文）',
    body1.includes('auto: 混合改动测试') && body1.includes('改动: feature.ts') && body1.includes('REVIEW: PASS（测试）'),
    body1,
  )
  check('S13e ignored 文件不进提交也不被跟踪', !gitIn(['ls-files']).includes('local-state/'), gitIn(['ls-files']))

  // All-ignored change set → skipped, commit count unchanged.
  const count1 = Number(gitIn(['rev-list', '--count', 'HEAD']).trim())
  writeFileSync(join(repo, 'local-state', 'more.json'), '{}')
  const allIgnored = await commitPaths(repo, ['local-state/more.json'], { subject: 'auto: x', body: () => 'x' })
  check(
    'S13f 全 ignored 改动集跳过提交',
    allIgnored.ok && allIgnored.skipped === 'ignored' && Number(gitIn(['rev-list', '--count', 'HEAD']).trim()) === count1,
    JSON.stringify(allIgnored),
  )

  // A path that existed during the round but was never tracked and has since
  // been deleted (diffSnapshotPaths records it as "before has, after hasn't")
  // must not kill the batch — the round's real work still lands.
  writeFileSync(join(repo, 'ghost.tmp'), 'temp')
  rmSync(join(repo, 'ghost.tmp'))
  writeFileSync(join(repo, 'real3.ts'), 'export const real3 = 1\n')
  const ghost = await commitPaths(repo, ['ghost.tmp', 'real3.ts'], { subject: 'auto: ghost 测试', body: (kept) => `改动: ${kept.join('、')}` })
  check(
    'S13h 已消失的未跟踪路径不炸提交（真实改动照常落地）',
    ghost.ok && !ghost.skipped && ghost.files?.length === 1 && ghost.files[0] === 'real3.ts',
    JSON.stringify(ghost),
  )

  // Pre-staged unrelated content must stay OUT of the auto-commit (--only)
  // and keep its staged state.
  writeFileSync(join(repo, 'unrelated.ts'), 'unrelated WIP\n')
  execFileSync('git', ['-C', repo, 'add', 'unrelated.ts'], { stdio: 'ignore' })
  writeFileSync(join(repo, 'feature2.ts'), 'export const feature2 = 1\n')
  const staged = await commitPaths(repo, ['feature2.ts'], { subject: 'auto: 预暂存隔离测试', body: (kept) => `改动: ${kept.join('、')}` })
  check(
    'S13g 预暂存的无关改动不进 auto 提交且保持 staged',
    staged.ok && !staged.skipped && staged.files?.length === 1 && staged.files[0] === 'feature2.ts' && gitIn(['status', '--porcelain']).includes('A  unrelated.ts'),
    JSON.stringify({ staged, status: gitIn(['status', '--porcelain']) }),
  )

  // A non-ASCII ignored path must be filtered too: check-ignore quotes such
  // paths by default (core.quotePath), which would miss the set and sink the
  // whole add — quotePath=false in commitPaths is what keeps it working.
  writeFileSync(join(repo, '.gitignore'), 'local-state/\n本地缓存/\n')
  mkdirSync(join(repo, '本地缓存'), { recursive: true })
  writeFileSync(join(repo, '本地缓存', 'x.json'), '{}')
  writeFileSync(join(repo, 'ascii.ts'), 'export const ascii = 1\n')
  const cjk = await commitPaths(repo, ['本地缓存/x.json', 'ascii.ts'], { subject: 'auto: quotePath 测试', body: (kept) => `改动: ${kept.join('、')}` })
  check(
    'S13i 非 ASCII ignored 路径正确过滤（quotePath=false）',
    cjk.ok && !cjk.skipped && cjk.files?.length === 1 && cjk.files[0] === 'ascii.ts' && !gitIn(['ls-files']).includes('本地缓存'),
    JSON.stringify(cjk),
  )

  // Staged deletion (git rm): the path left the index AND the disk but not
  // HEAD — HEAD-based tracking keeps it, the add pathspec set drops it
  // (git add would fatal), commit --only lands the removal.
  const commitIn = (msg) =>
    execFileSync('git', ['-C', repo, '-c', 'user.name=sop', '-c', 'user.email=sop@t', 'commit', '-m', msg], { stdio: 'ignore' })
  writeFileSync(join(repo, 'dead.ts'), 'dying\n')
  execFileSync('git', ['-C', repo, 'add', 'dead.ts'], { stdio: 'ignore' })
  commitIn('add dead')
  execFileSync('git', ['-C', repo, 'rm', 'dead.ts'], { stdio: 'ignore' })
  const removed = await commitPaths(repo, ['dead.ts'], { subject: 'auto: 删除测试', body: (kept) => `改动: ${kept.join('、')}` })
  check(
    'S13j 已暂存删除（git rm）恰提交 1 个 deletion 且工作区干净',
    removed.ok &&
      !removed.skipped &&
      removed.files?.length === 1 &&
      removed.files[0] === 'dead.ts' &&
      !gitIn(['ls-files']).includes('dead.ts') &&
      !gitIn(['status', '--porcelain']).includes('dead.ts'),
    JSON.stringify({ removed, status: gitIn(['status', '--porcelain']) }),
  )

  // fs delete + `git add -A` (an agent staging everything after the fact):
  // same index state as git rm — the deletion must land the same way.
  writeFileSync(join(repo, 'gone2.ts'), 'g\n')
  execFileSync('git', ['-C', repo, 'add', 'gone2.ts'], { stdio: 'ignore' })
  commitIn('add gone2')
  rmSync(join(repo, 'gone2.ts'))
  execFileSync('git', ['-C', repo, 'add', '-A'], { stdio: 'ignore' })
  const removed2 = await commitPaths(repo, ['gone2.ts'], { subject: 'auto: 删除测试2', body: (kept) => `改动: ${kept.join('、')}` })
  check(
    'S13k 删文件后 git add -A 的暂存删除同样落地',
    removed2.ok && !removed2.skipped && removed2.files?.length === 1 && removed2.files[0] === 'gone2.ts' && !gitIn(['status', '--porcelain']).includes('gone2.ts'),
    JSON.stringify(removed2),
  )

  // Staged rename: parsePorcelainZ must record the origin as a deletion so it
  // enters changedPaths at all; commitPaths then commits BOTH halves.
  writeFileSync(join(repo, 'old.ts'), 'old\n')
  execFileSync('git', ['-C', repo, 'add', 'old.ts'], { stdio: 'ignore' })
  commitIn('add old')
  execFileSync('git', ['-C', repo, 'mv', 'old.ts', 'new.ts'], { stdio: 'ignore' })
  const snap = await snapshotWorktree(repo)
  check(
    'S13l 重命名 origin 进入快照 paths（D 语义）',
    snap.paths.includes('old.ts') && snap.paths.includes('new.ts'),
    JSON.stringify(snap.paths),
  )
  const renamed = await commitPaths(repo, ['new.ts', 'old.ts'], { subject: 'auto: 重命名测试', body: (kept) => `改动: ${kept.join('、')}` })
  check(
    'S13m 暂存重命名完整提交（HEAD 无旧路径、工作区干净）',
    renamed.ok &&
      !renamed.skipped &&
      renamed.files?.length === 2 &&
      renamed.files.includes('new.ts') &&
      renamed.files.includes('old.ts') &&
      !gitIn(['ls-files']).includes('old.ts') &&
      gitIn(['ls-files']).includes('new.ts') &&
      !gitIn(['status', '--porcelain']).includes('old.ts'),
    JSON.stringify({ renamed, status: gitIn(['status', '--porcelain']) }),
  )

  // Staged deletion + real change in one round: both land, nothing is left.
  writeFileSync(join(repo, 'victim.ts'), 'v\n')
  execFileSync('git', ['-C', repo, 'add', 'victim.ts'], { stdio: 'ignore' })
  commitIn('add victim')
  execFileSync('git', ['-C', repo, 'rm', 'victim.ts'], { stdio: 'ignore' })
  writeFileSync(join(repo, 'real5.ts'), 'export const real5 = 1\n')
  const mixedRemoval = await commitPaths(repo, ['victim.ts', 'real5.ts'], { subject: 'auto: 混合删除测试', body: (kept) => `改动: ${kept.join('、')}` })
  check(
    'S13n 暂存删除 + 真实变更混合时两者都提交',
    mixedRemoval.ok &&
      !mixedRemoval.skipped &&
      mixedRemoval.files?.length === 2 &&
      mixedRemoval.files.includes('victim.ts') &&
      mixedRemoval.files.includes('real5.ts') &&
      !gitIn(['ls-files']).includes('victim.ts') &&
      !gitIn(['status', '--porcelain']).includes('victim.ts'),
    JSON.stringify({ mixedRemoval, files: headFiles(), status: gitIn(['status', '--porcelain']) }),
  )

  // Glob metacharacters in paths ([?*) are filename characters, never git
  // pathspec magic: without --literal-pathspecs, app/[id]/page.tsx matches
  // the sibling app/i/page.tsx and silently swallows its staged WIP.
  mkdirSync(join(repo, 'app', '[id]'), { recursive: true })
  mkdirSync(join(repo, 'app', 'i'), { recursive: true })
  writeFileSync(join(repo, 'app', '[id]', 'page.tsx'), 'export const dyn = 1\n')
  writeFileSync(join(repo, 'app', 'i', 'page.tsx'), 'export const plain = 1\n')
  execFileSync('git', ['-C', repo, 'add', '-A'], { stdio: 'ignore' })
  commitIn('add app pages')
  // Pre-stage WIP on the sibling, change the [id] page this round: only the
  // literal path may enter the commit; the staged WIP stays staged.
  writeFileSync(join(repo, 'app', 'i', 'page.tsx'), 'export const plain = 2 // WIP\n')
  execFileSync('git', ['-C', repo, 'add', 'app/i/page.tsx'], { stdio: 'ignore' })
  writeFileSync(join(repo, 'app', '[id]', 'page.tsx'), 'export const dyn = 2\n')
  const glob = await commitPaths(repo, ['app/[id]/page.tsx'], { subject: 'auto: glob 字面量测试', body: (kept) => `改动: ${kept.join('、')}` })
  check(
    'S13o glob 元字符路径按字面提交（预暂存兄弟 WIP 不被吞）',
    glob.ok &&
      !glob.skipped &&
      glob.files?.length === 1 &&
      glob.files[0] === 'app/[id]/page.tsx' &&
      gitIn(['status', '--porcelain']).includes('M  app/i/page.tsx'),
    JSON.stringify({ glob, status: gitIn(['status', '--porcelain']) }),
  )
  // Unstaged-dirty variant: unstage the WIP, dirty both files again — the
  // wildcard must not even STAGE the sibling.
  execFileSync('git', ['-C', repo, 'reset', '--', 'app/i/page.tsx'], { stdio: 'ignore' })
  writeFileSync(join(repo, 'app', 'i', 'page.tsx'), 'export const plain = 3 // dirty\n')
  writeFileSync(join(repo, 'app', '[id]', 'page.tsx'), 'export const dyn = 3\n')
  const glob2 = await commitPaths(repo, ['app/[id]/page.tsx'], { subject: 'auto: glob 字面量（未暂存变体）', body: (kept) => `改动: ${kept.join('、')}` })
  check(
    'S13p 未暂存的兄弟脏文件也不被通配卷入',
    glob2.ok &&
      !glob2.skipped &&
      glob2.files?.length === 1 &&
      glob2.files[0] === 'app/[id]/page.tsx' &&
      gitIn(['status', '--porcelain']).includes(' M app/i/page.tsx'),
    JSON.stringify({ glob2, status: gitIn(['status', '--porcelain']) }),
  )

  // Tracked-but-ignored (force-added past .gitignore) whose staged deletion
  // is in this round: check-ignore alone would read it as "ignored" and the
  // deletion would be lost forever — HEAD-first filtering must rescue it.
  writeFileSync(join(repo, '.gitignore'), 'local-state/\n本地缓存/\n*.log\n')
  writeFileSync(join(repo, 'kept.log'), 'force-added log\n')
  execFileSync('git', ['-C', repo, 'add', '-f', 'kept.log'], { stdio: 'ignore' })
  commitIn('force-add kept.log')
  execFileSync('git', ['-C', repo, 'rm', 'kept.log'], { stdio: 'ignore' })
  writeFileSync(join(repo, 'real6.ts'), 'export const real6 = 1\n')
  const trackedIgnored = await commitPaths(repo, ['kept.log', 'real6.ts'], { subject: 'auto: tracked-ignored 删除测试', body: (kept) => `改动: ${kept.join('、')}` })
  check(
    'S13q tracked-ignored 暂存删除 + 真实变更混合时两者都提交',
    trackedIgnored.ok &&
      !trackedIgnored.skipped &&
      trackedIgnored.files?.length === 2 &&
      trackedIgnored.files.includes('kept.log') &&
      trackedIgnored.files.includes('real6.ts') &&
      !gitIn(['ls-files']).includes('kept.log') &&
      !gitIn(['status', '--porcelain']).includes('kept.log'),
    JSON.stringify({ trackedIgnored, status: gitIn(['status', '--porcelain']) }),
  )

  // Same shape, deletion ONLY: the verdict must not be skipped:'ignored'.
  writeFileSync(join(repo, 'only.log'), 'another force-added log\n')
  execFileSync('git', ['-C', repo, 'add', '-f', 'only.log'], { stdio: 'ignore' })
  commitIn('force-add only.log')
  execFileSync('git', ['-C', repo, 'rm', 'only.log'], { stdio: 'ignore' })
  const trackedIgnoredOnly = await commitPaths(repo, ['only.log'], { subject: 'auto: tracked-ignored 纯删除', body: (kept) => `改动: ${kept.join('、')}` })
  check(
    'S13q tracked-ignored 纯删除照常落地（不是 skipped）',
    trackedIgnoredOnly.ok &&
      !trackedIgnoredOnly.skipped &&
      trackedIgnoredOnly.files?.length === 1 &&
      trackedIgnoredOnly.files[0] === 'only.log' &&
      !gitIn(['ls-files']).includes('only.log'),
    JSON.stringify(trackedIgnoredOnly),
  )
}

/* --------------------------------------------- S4–S8 end-to-end (one server) */

/**
 * The standard SOP room: 开发甲 writes a file (MOCK-写文件 seam), 评审乙
 * follows by name with a REVIEW verdict (MOCK-评审 seam, or a plain persona
 * for the no-verdict scenarios), 总结丙 summarizes on round end. All
 * triggers keep the chain deterministic — mention routing is off.
 */
async function makeSopRoom(port, repo, name, { verifyCommand, reviewerPersona }) {
  const room = await makeRoom(port, name, repo, verifyCommand)
  await makeCharacter(port, room.id, '开发甲', ON_USER_ONLY, 'MOCK-写文件')
  await makeCharacter(port, room.id, '评审乙', FOLLOWS_DEV, reviewerPersona)
  await makeCharacter(port, room.id, '总结丙', ROUND_SUMMARIZER, '总结者')
  return room
}

async function runRoundAndDrain(port, roomId) {
  await postMessage(port, roomId, '请开始干活，完成后请评审')
  // Drain fully: turns → gate (maybe verify) → summary — then idle.
  const okIdle = await waitIdle(port, roomId, 40_000)
  if (!okIdle) {
    const state = await req(port, `/api/rooms/${roomId}/state`)
    throw new Error(`room never went idle: ${JSON.stringify(state)}`)
  }
  await sleep(300)
  return (await req(port, `/api/rooms/${roomId}/messages?limit=200`)).messages
}

async function scenarioEndToEnd() {
  const dir = mkdtempSync(join(tmpdir(), 'ac-sop-e2e-'))
  tempDirs.push(dir)
  const repo = mkdtempSync(join(tmpdir(), 'ac-sop-repo-'))
  tempDirs.push(repo)
  execFileSync('git', ['-C', repo, 'init'], { stdio: 'ignore' })
  execFileSync('git', ['-C', repo, 'add', '-A'], { stdio: 'ignore' })
  execFileSync('git', ['-C', repo, '-c', 'user.name=sop', '-c', 'user.email=sop@t', 'commit', '-m', 'seed', '--allow-empty'], {
    stdio: 'ignore',
  })
  // S13: a bare remote the auto-commit must NEVER touch — push is a user
  // decision by contract, and the ref staying on the seed commit is the
  // proof for every round this scenario runs.
  const bare = mkdtempSync(join(tmpdir(), 'ac-sop-bare-'))
  tempDirs.push(bare)
  execFileSync('git', ['-C', bare, 'init', '--bare'], { stdio: 'ignore' })
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', bare], { stdio: 'ignore' })
  execFileSync('git', ['-C', repo, 'push', '-q', 'origin', 'HEAD:refs/heads/main'], { stdio: 'ignore' })

  const server = await bootServer(dir)
  const port = server.port
  // S10 (B04) reads these rooms' episode memories after their rounds close.
  let roomS4
  let roomS5
  let roomS6
  let roomS7
  let roomS8a
  let roomS8b

  /* S4 green path: write + REVIEW: PASS + verify exit 0 → summary appears. */
  {
    const room = await makeSopRoom(port, repo, 's4-全绿', {
      verifyCommand: 'exit 0',
      reviewerPersona: 'MOCK-评审通过',
    })
    roomS4 = room
    const messages = await runRoundAndDrain(port, room.id)
    const dev = characterMessages(messages, '开发甲')
    check('S4 开发甲发言 1 条', dev.length === 1, `实际 ${dev.length}`)
    const changed = dev[0]?.meta?.changed ?? []
    check(
      'S4 开发甲消息 meta.changed 含写入文件',
      changed.length === 1 && changed[0].startsWith('mock-') && changed[0].endsWith('.txt'),
      JSON.stringify(changed),
    )
    check(
      'S4 系统消息播报验证通过',
      systemNotices(messages, '验证命令通过').length === 1,
      `实际 ${systemNotices(messages, '验证命令通过').length}`,
    )
    const checks = roundChecksWhere(dir, 'room_id = ?', room.id)
    const verifyRows = checks.filter((row) => row.kind === 'verify')
    check(
      'S4 round_checks：verify 恰 1 行且 pass',
      verifyRows.length === 1 && verifyRows[0].verdict === 'pass',
      JSON.stringify(verifyRows.map((row) => [row.kind, row.verdict])),
    )
    const reviewRows = checks.filter((row) => row.kind === 'review')
    check(
      'S4 round_checks：review 恰 1 行且 pass（detail 存 REVIEW: PASS）',
      reviewRows.length === 1 && reviewRows[0].verdict === 'pass' && reviewRows[0].detail === 'REVIEW: PASS',
      JSON.stringify(reviewRows.map((row) => [row.kind, row.verdict, row.detail])),
    )
    check('S4 轮末总结出现（总结丙发言）', characterMessages(messages, '总结丙').length === 1, '总结丙未发言')
  }

  /* S5 verify fails: exit 1 with a LONG output → no summary, fail notice
   * whose output TAIL carries the marker. The marker sits BEYOND the
   * 1500-char prefix: a head-keeping cap (the truncate() this replaced)
   * dropped exactly this line — the only one that names the failure. */
  {
    const room = await makeSopRoom(port, repo, 's5-验证失败', {
      verifyCommand:
        'node -e "console.log(\'x\'.repeat(2000));console.log(\'sop-verify-fail-marker\');process.exit(1)"',
      reviewerPersona: 'MOCK-评审通过',
    })
    roomS5 = room
    const messages = await runRoundAndDrain(port, room.id)
    check('S5 验证失败 → 无轮末总结', characterMessages(messages, '总结丙').length === 0, '总结丙发言了')
    const notice = systemNotices(messages, '验证命令未通过')
    check(
      'S5 门禁通知含 exit 1 与输出尾部',
      notice.length === 1 && notice[0].content.includes('exit 1') && notice[0].content.includes('sop-verify-fail-marker'),
      `实际 ${notice.length} 条`,
    )
    const verifyRows = roundChecksWhere(dir, 'room_id = ?', room.id).filter((row) => row.kind === 'verify')
    check(
      'S5 round_checks：verify 恰 1 行且 fail',
      verifyRows.length === 1 && verifyRows[0].verdict === 'fail' && verifyRows[0].detail.includes('sop-verify-fail-marker'),
      JSON.stringify(verifyRows.map((row) => [row.verdict, row.detail])),
    )
  }

  /* S6 no verdict: changed round, reviewer says nothing → blocked, no verify. */
  {
    const room = await makeSopRoom(port, repo, 's6-无结论', {
      verifyCommand: 'exit 0',
      reviewerPersona: '普通评审角色（不会给结论）',
    })
    roomS6 = room
    const messages = await runRoundAndDrain(port, room.id)
    check('S6 无 review 结论 → 无轮末总结', characterMessages(messages, '总结丙').length === 0, '总结丙发言了')
    check(
      'S6 门禁通知说明没有 review 结论',
      systemNotices(messages, '没有 review 结论').length === 1,
      `实际 ${systemNotices(messages, '没有 review 结论').length}`,
    )
    check(
      'S6 结论未过 → 验证从未运行',
      roundChecksWhere(dir, 'room_id = ?', room.id).filter((row) => row.kind === 'verify').length === 0,
      '出现了 verify 行',
    )
  }

  /* S7 chat-only round: no changes → gate (and verify) skipped, summary OK. */
  {
    const room = await makeRoom(port, 's7-纯聊天', repo, 'exit 0')
    roomS7 = room
    await makeCharacter(port, room.id, '闲丁', ON_USER_ONLY, '普通聊天角色')
    await makeCharacter(port, room.id, '总结丙', ROUND_SUMMARIZER, '总结者')
    const messages = await runRoundAndDrain(port, room.id)
    check('S7 无改动轮总结正常', characterMessages(messages, '总结丙').length === 1, '总结丙未发言')
    check(
      'S7 未配置触发的验证没跑（round_checks 无 verify 行）',
      roundChecksWhere(dir, 'room_id = ?', room.id).filter((row) => row.kind === 'verify').length === 0,
      '出现了 verify 行',
    )
    const chat = characterMessages(messages, '闲丁')
    check('S7 聊天消息不带改动标注', chat.length === 1 && (chat[0].meta?.changed ?? []).length === 0, JSON.stringify(chat[0]?.meta?.changed ?? null))
  }

  /* S8 no verify command configured: PASS closes directly; no verdict blocks. */
  {
    const roomA = await makeSopRoom(port, repo, 's8a-无验证直收', {
      verifyCommand: '',
      reviewerPersona: 'MOCK-评审通过',
    })
    roomS8a = roomA
    const messagesA = await runRoundAndDrain(port, roomA.id)
    check('S8a 无验证命令 + PASS → 直接总结', characterMessages(messagesA, '总结丙').length === 1, '总结丙未发言')
    check(
      'S8a 无验证命令 → 无 verify 行',
      roundChecksWhere(dir, 'room_id = ?', roomA.id).filter((row) => row.kind === 'verify').length === 0,
      '出现了 verify 行',
    )

    const roomB = await makeSopRoom(port, repo, 's8b-无验证无结论', {
      verifyCommand: '',
      reviewerPersona: '普通评审角色（不会给结论）',
    })
    roomS8b = roomB
    const messagesB = await runRoundAndDrain(port, roomB.id)
    check('S8b 无验证命令 + 无结论 → 阻断', characterMessages(messagesB, '总结丙').length === 0, '总结丙发言了')
    check(
      'S8b 门禁通知出现',
      systemNotices(messagesB, 'SOP 门禁').length === 1,
      `实际 ${systemNotices(messagesB, 'SOP 门禁').length}`,
    )
  }

  /* S13 auto-commit: a clean+changed+PASS round lands its work as exactly one
   * commit at the drain point; a CHANGES round and a chat-only round commit
   * nothing; push NEVER runs — the bare remote stays on the seed commit. */
  {
    const gitIn = (args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
    const bareIn = (args) => execFileSync('git', ['-C', bare, ...args], { encoding: 'utf8' })
    const seedRemote = bareIn(['rev-parse', 'refs/heads/main']).trim()
    const commitCount = () => Number(gitIn(['rev-list', '--count', 'HEAD']).trim())
    const before13 = commitCount()

    const room13a = await makeSopRoom(port, repo, 's13a-自动提交', {
      verifyCommand: 'exit 0',
      reviewerPersona: 'MOCK-评审通过',
    })
    const messages13a = await runRoundAndDrain(port, room13a.id)
    const changedFile = characterMessages(messages13a, '开发甲')[0]?.meta?.changed?.[0] ?? ''
    check('S13a 全绿轮新增恰 1 个 commit', commitCount() === before13 + 1, `${before13} -> ${commitCount()}`)
    check('S13a 全绿轮系统播报自动提交', systemNotices(messages13a, '已自动提交').length === 1, '未见提交播报')
    const headFiles = gitIn(['show', '--name-only', '--format=', 'HEAD'])
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
    check('S13a commit 恰含本轮改动文件', headFiles.length === 1 && headFiles[0] === changedFile, `${JSON.stringify(headFiles)} vs ${changedFile}`)
    const headSubject = gitIn(['log', '-1', '--format=%s']).trim()
    check('S13a commit 主题带 auto 前缀', headSubject.startsWith('auto: '), headSubject)
    check('S13a 提交后该文件不再是脏路径', !gitIn(['status', '--porcelain']).includes(changedFile), changedFile)

    const room13b = await makeSopRoom(port, repo, 's13b-返修不提交', {
      verifyCommand: 'exit 0',
      reviewerPersona: 'MOCK-评审返修',
    })
    const messages13b = await runRoundAndDrain(port, room13b.id)
    check('S13b CHANGES 轮不提交', commitCount() === before13 + 1, `出现新 commit：${before13 + 1} -> ${commitCount()}`)
    check('S13b CHANGES 轮无自动提交播报', systemNotices(messages13b, '已自动提交').length === 0, '出现提交播报')
    check('S13b CHANGES 轮被门禁拦截', systemNotices(messages13b, 'SOP 门禁').length === 1, '未见拦截通知')

    const room13c = await makeRoom(port, 's13c-纯聊天', repo, 'exit 0')
    await makeCharacter(port, room13c.id, '闲己', ON_USER_ONLY, '普通聊天角色')
    await makeCharacter(port, room13c.id, '总结丙', ROUND_SUMMARIZER, '总结者')
    const messages13c = await runRoundAndDrain(port, room13c.id)
    check('S13c 纯聊天轮不提交', commitCount() === before13 + 1, `出现新 commit：${before13 + 1} -> ${commitCount()}`)
    check('S13c 纯聊天轮总结正常', characterMessages(messages13c, '总结丙').length === 1, '总结丙未发言')

    check('S13d push 永不发生（bare 远端仍在 seed）', bareIn(['rev-parse', 'refs/heads/main']).trim() === seedRemote, bareIn(['rev-parse', 'refs/heads/main']).trim())
  }

  /* S10 (B04): automatic round-end episodes — clean+changed+PASS closes
   * write exactly one room-scope episode; everything else writes nothing;
   * identical facts on a repeat round are a hash no-op. */
  const memoriesWhere = (roomId, where = '1=1', ...args) =>
    withDb(
      dir,
      (handle) =>
        handle
          .prepare(`select * from memories where scope = 'room' and owner_id = ? and kind = 'episode' and ${where}`)
          .all(roomId, ...args),
    )
  {

    // S10a: the S4 green round wrote exactly one episode with all facts.
    const episodes4 = memoriesWhere(roomS4.id)
    const episode4 = episodes4[0]
    check(
      'S10a 全绿轮恰 1 条 episode（含路径/PASS/verify/交付，hash 非空）',
      episodes4.length === 1 &&
        episode4.source_room_id === roomS4.id &&
        episode4.content.includes('mock-') &&
        episode4.content.includes('review PASS') &&
        episode4.content.includes('verify 通过') &&
        episode4.content.includes('交付：') &&
        typeof episode4.content_hash === 'string' &&
        episode4.content_hash.length > 0,
      JSON.stringify(episodes4.map((row) => row.content)),
    )

    // S10b: a repeat round with identical facts is a no-op (same hash). The
    // file rewrite still counts as a change via the mtime fingerprint, so
    // the round stays eligible — only the dedup keeps the count at 1.
    await runRoundAndDrain(port, roomS4.id)
    check(
      'S10b 同事实重复轮不重复写（hash 去重）',
      memoriesWhere(roomS4.id).length === 1,
      JSON.stringify(memoriesWhere(roomS4.id).map((row) => row.content)),
    )

    // S10c: verify fail / no verdict / pure chat all write nothing.
    check('S10c 验证失败轮 0 条 episode', memoriesWhere(roomS5.id).length === 0)
    check('S10c 无结论轮 0 条 episode', memoriesWhere(roomS6.id).length === 0)
    check('S10c 纯聊天轮 0 条 episode', memoriesWhere(roomS7.id).length === 0)

    // S10d: no verify configured + PASS still closes clean — with the
    // "未配置验证" wording; no verdict writes nothing.
    const episodes8a = memoriesWhere(roomS8a.id)
    check(
      'S10d 无验证直收轮恰 1 条（写「未配置验证」）',
      episodes8a.length === 1 && episodes8a[0].content.includes('未配置验证'),
      JSON.stringify(episodes8a.map((row) => row.content)),
    )
    check('S10d 无验证无结论轮 0 条 episode', memoriesWhere(roomS8b.id).length === 0)

    // S10e: the orchestrator's query wiring, through the real server (M3's
    // lock): an old, out-of-recency memory re-enters the prompt only when
    // this round's own query hits it. The target is ~280 chars so recency
    // alone can never fit it; the 12 fillers (~97 chars each) fill the
    // 800-char room budget without containing the probe phrases.
    {
      const room = await makeRoom(port, 's10e-检索注入', repo, '')
      await makeCharacter(port, room.id, '检索丁', ON_USER_ONLY, '普通角色')
      await req(port, `/api/rooms/${room.id}/memories`, {
        method: 'POST',
        body: JSON.stringify({
          scope: 'room',
          content: `旧事实：续传游标的修复记录与验证结论（模拟记忆留存）。${'备'.repeat(240)}`,
        }),
      })
      for (let i = 0; i < 12; i += 1) {
        await req(port, `/api/rooms/${room.id}/memories`, {
          method: 'POST',
          body: JSON.stringify({ scope: 'room', content: `填充${String(i).padStart(2, '0')}：${'水'.repeat(92)}` }),
        })
        await sleep(2)
      }
      const ask = async (content) => {
        await postMessage(port, room.id, content)
        const okIdle = await waitIdle(port, room.id, 40_000)
        if (!okIdle) throw new Error('s10e room never went idle')
        await sleep(300)
        const messages = (await req(port, `/api/rooms/${room.id}/messages?limit=200`)).messages
        return messages.filter((message) => message.authorType === 'character').at(-1)
      }
      const missReply = await ask('模拟记忆 量子纠缠')
      check('S10e 未命中查询：探针不在注入区', missReply?.content.includes('探针「量子纠缠」未命中'), missReply?.content)
      const hitReply = await ask('模拟记忆 续传游标')
      check(
        'S10e 本轮查询命中 → 窗口外旧条目被注入（探针命中）',
        hitReply?.content.includes('探针「续传游标」命中'),
        hitReply?.content,
      )
    }

    // S10f (B04 review 1, init-failure leg): a pre-existing BROKEN memories_fts
    // (name conflict → trigger creation succeeds, rebuild fails) must not
    // take startup, memory writes, or degraded retrieval down. Leftover
    // triggers would re-route every write into the broken vtable and throw.
    {
      const dir2 = mkdtempSync(join(tmpdir(), 'ac-sop-s10f-'))
      tempDirs.push(dir2)
      const poison = new DatabaseSync(join(dir2, 'agent-crowd.db'))
      poison.exec('create table memories_fts (x)')
      poison.close()
      const server2 = await bootServer(dir2)
      const room = await makeRoom(server2.port, 's10f-降级', repo, '')
      await makeCharacter(server2.port, room.id, '降级丁', ON_USER_ONLY, '普通角色')
      const added = await req(server2.port, `/api/rooms/${room.id}/memories`, {
        method: 'POST',
        body: JSON.stringify({ scope: 'room', content: `降级事实：续传游标修复记录。${'备'.repeat(240)}` }),
      })
      for (let i = 0; i < 12; i += 1) {
        await req(server2.port, `/api/rooms/${room.id}/memories`, {
          method: 'POST',
          body: JSON.stringify({ scope: 'room', content: `填充${String(i).padStart(2, '0')}：${'水'.repeat(92)}` }),
        })
        await sleep(2)
      }
      check(
        'S10f FTS 初始化失败不挡写记忆（触发器已清理）',
        added.memory?.content?.includes('续传游标'),
        JSON.stringify(added).slice(0, 120),
      )
      await postMessage(server2.port, room.id, '模拟记忆 续传游标')
      const okIdle = await waitIdle(server2.port, room.id, 40_000)
      if (!okIdle) throw new Error('s10f room never went idle')
      await sleep(300)
      const degradedReply = (await req(server2.port, `/api/rooms/${room.id}/messages?limit=200`)).messages
        .filter((message) => message.authorType === 'character')
        .at(-1)
      check(
        'S10f 降级后检索仍命中（LIKE 承接长词，窗口外旧条目被注入）',
        degradedReply?.content.includes('探针「续传游标」命中'),
        degradedReply?.content,
      )
    }

    // S10g (B04 review 2): a verdict-only reviewer ("REVIEW: PASS" alone)
    // strips to an empty delivery and must not wipe the assignee's real one —
    // the episode's 交付 stays the dev's text, not a blank.
    {
      const room = await makeSopRoom(port, repo, 's10g-只回结论', {
        verifyCommand: 'exit 0',
        reviewerPersona: 'MOCK-只回结论',
      })
      await runRoundAndDrain(port, room.id)
      const episodes = memoriesWhere(room.id)
      check(
        'S10g 只回结论的 reviewer 不清空交付（episode 仍是开发者的文本）',
        episodes.length === 1 && episodes[0].content.includes('已在工作目录写入') && episodes[0].content.includes('交付：'),
        JSON.stringify(episodes.map((row) => row.content)),
      )
    }

    // S10g-b (B04 review 3): the whole-line code span — rule 9's example
    // copied verbatim into backticks — is equally gate protocol. It must not
    // become the delivery either, or the next same-facts round dedupes
    // against a verdict-text episode and swallows its real delivery.
    {
      const room = await makeSopRoom(port, repo, 's10g-反引号结论', {
        verifyCommand: 'exit 0',
        reviewerPersona: 'MOCK-反引号结论',
      })
      await runRoundAndDrain(port, room.id)
      const episodes = memoriesWhere(room.id)
      check(
        'S10g-b 反引号整行 code span 也不成为交付（episode 仍是开发者文本）',
        episodes.length === 1 &&
          episodes[0].content.includes('已在工作目录写入') &&
          !episodes[0].content.includes('REVIEW'),
        JSON.stringify(episodes.map((row) => row.content)),
      )
    }

    // S10g-c (B04 review 4): a list-item verdict ("- REVIEW: PASS" — the
    // gate accepts listItem paragraphs) must not become the delivery; the
    // reviewer's prose line above the bullet survives as the delivery.
    {
      const room = await makeSopRoom(port, repo, 's10g-列表结论', {
        verifyCommand: 'exit 0',
        reviewerPersona: 'MOCK-列表结论',
      })
      await runRoundAndDrain(port, room.id)
      const episodes = memoriesWhere(room.id)
      check(
        'S10g-c 列表项 verdict 不成为交付（交付是结论行之外的正文）',
        episodes.length === 1 &&
          episodes[0].content.includes('复核完毕，结论如下：') &&
          !episodes[0].content.includes('REVIEW'),
        JSON.stringify(episodes.map((row) => row.content)),
      )
    }
  }

  /* S11 (B05): the self-review ban — WHO gave the PASS finally matters.
   * S11a implementer self-approves → block; S11b no designation + another
   * character's PASS → unchanged; S11c designated reviewer on a different
   * harness (custom, echoes the verdict) → closes; S11d designated reviewer
   * shares the implementer's harness → block; S11e PASS from someone other
   * than the designated reviewer → block. */
  {
    const roomA = await makeRoom(port, 's11a-自审', repo, 'exit 0')
    await makeCharacter(port, roomA.id, '开发甲', ON_USER_ONLY, 'MOCK-自审')
    await makeCharacter(port, roomA.id, '总结丙', ROUND_SUMMARIZER, '总结者')
    const messagesA = await runRoundAndDrain(port, roomA.id)
    check('S11a 实现者自审 → 无轮末总结', characterMessages(messagesA, '总结丙').length === 0, '总结丙发言了')
    check(
      'S11a 门禁通知点名「实现者本人」',
      systemNotices(messagesA, '实现者本人').length === 1,
      `实际 ${systemNotices(messagesA, '实现者本人').length}`,
    )
    check('S11a 自审轮不写 episode', memoriesWhere(roomA.id).length === 0)

    const roomB = await makeSopRoom(port, repo, 's11b-兼容', {
      verifyCommand: 'exit 0',
      reviewerPersona: 'MOCK-评审通过',
    })
    const messagesB = await runRoundAndDrain(port, roomB.id)
    check('S11b 未指定 reviewer：他角色 PASS 仍正常收尾', characterMessages(messagesB, '总结丙').length === 1, '总结丙未发言')

    const roomC = await makeRoom(port, 's11c-指定异构', repo, 'exit 0')
    await makeCharacter(port, roomC.id, '开发甲', ON_USER_ONLY, 'MOCK-写文件')
    const reviewerC = await req(port, `/api/rooms/${roomC.id}/characters`, {
      method: 'POST',
      body: JSON.stringify({
        name: '指定评审',
        harness: 'custom',
        model: '',
        persona: 'SOP 测试角色',
        commandTemplate: 'echo REVIEW: PASS',
        triggers: FOLLOWS_DEV,
      }),
    })
    await makeCharacter(port, roomC.id, '总结丙', ROUND_SUMMARIZER, '总结者')
    await req(port, `/api/rooms/${roomC.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ reviewerCharacterId: reviewerC.id }),
    })
    const messagesC = await runRoundAndDrain(port, roomC.id)
    check('S11c 指定异构 reviewer 的 PASS → 正常收尾', characterMessages(messagesC, '总结丙').length === 1, '总结丙未发言')

    const roomD = await makeRoom(port, 's11d-同harness', repo, 'exit 0')
    await makeCharacter(port, roomD.id, '开发甲', ON_USER_ONLY, 'MOCK-写文件')
    const reviewerD = await makeCharacter(port, roomD.id, '评审乙', FOLLOWS_DEV, 'MOCK-评审通过')
    await makeCharacter(port, roomD.id, '总结丙', ROUND_SUMMARIZER, '总结者')
    await req(port, `/api/rooms/${roomD.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ reviewerCharacterId: reviewerD.id }),
    })
    const messagesD = await runRoundAndDrain(port, roomD.id)
    check('S11d reviewer 与实现者同一 harness → 阻断', characterMessages(messagesD, '总结丙').length === 0, '总结丙发言了')
    check(
      'S11d 门禁通知点名「同一 harness」',
      systemNotices(messagesD, '同一 harness').length === 1,
      `实际 ${systemNotices(messagesD, '同一 harness').length}`,
    )

    const roomE = await makeRoom(port, 's11e-非指定', repo, 'exit 0')
    await makeCharacter(port, roomE.id, '开发甲', ON_USER_ONLY, 'MOCK-写文件')
    await makeCharacter(port, roomE.id, '评审乙', FOLLOWS_DEV, 'MOCK-评审通过')
    // B05b-4 review fix: a real summarizer must exist so "blocked round has
    // no summary" is a FAILABLE assertion, not a vacuous one.
    await makeCharacter(port, roomE.id, '总结丙', ROUND_SUMMARIZER, '总结者')
    // B05b-4: the designated reviewer must be an ELIGIBLE member (the save
    // validation refuses disabled/summarizer designations) — a silent
    // eligible 评审甲 that never speaks makes 评审乙's PASS a wrong-reviewer.
    const silentReviewerE = await makeCharacter(port, roomE.id, '评审甲', ON_USER_ONLY, 'MOCK-评审通过')
    await req(port, `/api/rooms/${roomE.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ reviewerCharacterId: silentReviewerE.id }),
    })
    const messagesE = await runRoundAndDrain(port, roomE.id)
    check('S11e PASS 非指定 reviewer → 阻断', characterMessages(messagesE, '总结丙').length === 0, '总结丙发言了')
    check(
      'S11e 门禁通知点名「非指定 reviewer」',
      systemNotices(messagesE, '非指定 reviewer').length === 1,
      `实际 ${systemNotices(messagesE, '非指定 reviewer').length}`,
    )

    /* S11f (B05b-4): save-time eligibility validation. */
    {
      const room = await makeRoom(port, 's11f-校验', repo, 'exit 0')
      const dev = await makeCharacter(port, room.id, '开发甲', ON_USER_ONLY, 'MOCK-写文件')
      const reviewer = await makeCharacter(port, room.id, '评审乙', FOLLOWS_DEV, 'MOCK-评审通过')
      const summarizer = await makeCharacter(port, room.id, '总结丙', ROUND_SUMMARIZER, '总结者')
      const patch = (assignee) =>
        fetch(`http://127.0.0.1:${port}/api/rooms/${room.id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ reviewerCharacterId: assignee }),
        }).then((r) => r.status)
      check('S11f 指定总结角色 → 400', (await patch(summarizer.id)) === 400)
      await req(port, `/api/characters/${reviewer.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: false }) })
      check('S11f 指定已停用角色 → 400', (await patch(reviewer.id)) === 400)
      await req(port, `/api/characters/${reviewer.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: true }) })
      check('S11f 指定合法角色 → 200', (await patch(reviewer.id)) === 200)
      check('S11f null 清空指定 → 200', (await patch(null)) === 200)
      check('S11f 开发者本人可被指定（资格与自审是两回事）', (await patch(dev.id)) === 200)
    }

    /* S11g (B05b-4): an already-designated reviewer that becomes ineligible
     * blocks with an actionable reason — never a silent fail-open, never
     * silently cleared. */
    {
      const room = await makeRoom(port, 's11g-资格失效', repo, 'exit 0')
      await makeCharacter(port, room.id, '开发甲', ON_USER_ONLY, 'MOCK-写文件')
      await makeCharacter(port, room.id, '评审甲', FOLLOWS_DEV, 'MOCK-评审通过')
      // B05b-4 review fix: same as S11e — the "no summary after block"
      // assertion needs a real summarizer to be able to fail.
      await makeCharacter(port, room.id, '总结丙', ROUND_SUMMARIZER, '总结者')
      const designated = await makeCharacter(port, room.id, '评审乙', ON_USER_ONLY, 'MOCK-评审通过')
      await req(port, `/api/rooms/${room.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ reviewerCharacterId: designated.id }),
      })
      await req(port, `/api/characters/${designated.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: false }) })
      const messages = await runRoundAndDrain(port, room.id)
      check(
        'S11g reviewer 资格失效后改动轮仍被拦截（不静默放行）',
        characterMessages(messages, '总结丙').length === 0,
        '总结丙发言了',
      )
      check(
        'S11g 通知点名「已停用或为轮末总结角色」并指向设置页',
        systemNotices(messages, '已停用或为轮末总结角色').length === 1 &&
          systemNotices(messages, '重新指定 reviewer').length === 1,
        `实际 ${systemNotices(messages, '已停用或为轮末总结角色').length} 条`,
      )
      // The designation itself survives (kept, not cleared) — re-enabling
      // restores the original contract without re-designating.
      const roomRow = (await req(port, '/api/bootstrap')).rooms.find((r) => r.id === room.id)
      check('S11g 指定保留（不自动清空，重启用即恢复）', roomRow && roomRow.reviewerCharacterId === designated.id)
    }
  }

  /* S12 (B05 incident, 2026-11-06): a fired restart must pass the
   * RESTARTING server's data dir down the whole chain. A test server's
   * replacement used to boot on the PRODUCTION database (start-server.ps1
   * never set AC_DATA_DIR), and the replacement's boot sweep then killed
   * the live production's in-flight turns — three review-loop deaths
   * before this was found. Dynamic import AFTER pointing AC_DATA_DIR at
   * this scenario's temp dir, so the db module the import pulls in opens
   * the TEST database, not the production one. */
  {
    process.env.AC_DATA_DIR = dir
    const { restartScriptArgs } = await import('../server/restart.ts')
    const { DATA_DIR } = await import('../server/paths.ts')
    const args = restartScriptArgs({})
    const at = args.indexOf('-DataDir')
    check(
      'S12 重启脚本参数携带本服务器数据目录（替补继承同库）',
      at >= 0 && args[at + 1] === DATA_DIR,
      JSON.stringify(at >= 0 ? args.slice(at, at + 2) : []),
    )
    check(
      'S12 重启脚本参数仍携带端口与接管 pid',
      args.includes('-Port') && args.includes('-TakeoverPid'),
      '',
    )
  }
}

/* ---------------------------------------------------------- S9 restart race */

async function scenarioRestartRace() {
  const dir = mkdtempSync(join(tmpdir(), 'ac-sop-s9-'))
  tempDirs.push(dir)
  const repo = mkdtempSync(join(tmpdir(), 'ac-sop-s9repo-'))
  tempDirs.push(repo)
  execFileSync('git', ['-C', repo, 'init'], { stdio: 'ignore' })
  execFileSync('git', ['-C', repo, 'add', '-A'], { stdio: 'ignore' })
  execFileSync('git', ['-C', repo, '-c', 'user.name=sop', '-c', 'user.email=sop@t', 'commit', '-m', 'seed', '--allow-empty'], {
    stdio: 'ignore',
  })

  const server = await bootServer(dir)
  const port = server.port
  const beforePid = server.pid
  // A verify command that stays alive long enough to observe the drain: the
  // gate must hold the restart off while it runs.
  const room = await makeSopRoom(port, repo, 's9-重启竞态', {
    verifyCommand: IS_WIN ? 'ping -n 30 127.0.0.1' : 'sleep 30',
    reviewerPersona: 'MOCK-评审通过',
  })
  await postMessage(port, room.id, '请开始干活，完成后请评审')

  const gateRunning = await waitState(port, room.id, (state) => state.gate === 'running', 40_000)
  check('S9 验证运行中 /state 显示 gate=running', gateRunning !== null, '40s 内未见 gate running')

  const restart = await req(port, '/api/restart', { method: 'POST', body: JSON.stringify({}) })
  check('S9 restart 请求已排队（next-idle）', restart.ok === true && restart.scheduled === 'next-idle')

  await sleep(4_000)
  const messages = (await req(port, `/api/rooms/${room.id}/messages?limit=200`)).messages
  check(
    'S9 验证运行中重启未触发（无「服务器重启中」播报）',
    systemNotices(messages, '服务器重启中').length === 0,
    `实际 ${systemNotices(messages, '服务器重启中').length} 条`,
  )
  const health = await req(port, '/api/health')
  check(
    'S9 服务器仍在原进程上服务（pid 不变）',
    health.ok === true && health.pid === beforePid,
    `实际 pid ${health.pid}，期望 ${beforePid}`,
  )
  // NOTE: no wait for the 30s verify here — the scenario ends with the gate
  // still running and the restart still pending, which is exactly the state
  // hardKill() cleans up (the WMI script was never launched).
}

/* ------------------------------------------------- S9b stale idle broadcast */

/**
 * The gate's async await (a verify run) can straddle a new human message:
 * that message's own pump() starts a turn, and when the verify settles the
 * OLD pump resumes into "queue was empty" state and used to broadcast
 * busy:false straight over the running turn — the web client drops its
 * live view on busy:false, mid-turn. The fix re-checks active/queue after
 * the await; this scenario pins it with a real SSE listener, the only
 * witness of a transient broadcast.
 */
async function scenarioStaleIdleRace() {
  const dir = mkdtempSync(join(tmpdir(), 'ac-sop-s9b-'))
  tempDirs.push(dir)
  const repo = mkdtempSync(join(tmpdir(), 'ac-sop-s9brepo-'))
  tempDirs.push(repo)
  execFileSync('git', ['-C', repo, 'init'], { stdio: 'ignore' })
  execFileSync('git', ['-C', repo, 'add', '-A'], { stdio: 'ignore' })
  execFileSync('git', ['-C', repo, '-c', 'user.name=sop', '-c', 'user.email=sop@t', 'commit', '-m', 'seed', '--allow-empty'], {
    stdio: 'ignore',
  })

  const server = await bootServer(dir)
  const port = server.port
  // The verify must outlive the turns that triggered it (write → PASS) but
  // stay INSIDE the slow turn fired while it runs — that overlap is the
  // window where the stale pump wakes up. ping -n 5 / sleep 4 ≈ 4s; the
  // mock 模拟慢速 turn runs ~4.8s.
  const room = await makeSopRoom(port, repo, 's9b-陈旧idle', {
    verifyCommand: IS_WIN ? 'ping -n 5 127.0.0.1' : 'sleep 4',
    reviewerPersona: 'MOCK-评审通过',
  })
  await makeCharacter(
    port,
    room.id,
    '慢戊',
    { onUser: false, onAll: false, onCharacters: [], onCharacterNames: [], keyword: '', mention: true, onRoundEnd: false },
    '慢速测试角色',
  )

  const watch = await sseWatch(port, room.id)
  await postMessage(port, room.id, '请开始干活，完成后请评审')
  const gateRunning = await waitState(port, room.id, (state) => state.gate === 'running', 40_000)
  check('S9b 验证运行中 gate=running（慢回合启动前的锚点）', gateRunning !== null, '40s 内未见 gate running')
  // The slow turn (mock 模拟慢速, ~5s) starts while the verify (~4s) is
  // still running: the verify settles mid-turn and its pump resumes.
  await postMessage(port, room.id, '@慢戊 模拟慢速')
  const idle = await waitIdle(port, room.id, 40_000)
  check('S9b 场景完整收敛（慢回合与门禁均落地）', idle, '房间未回到 idle')
  await watch.stop()

  // Scan the whole stream: a busy:false must never arrive between a turn's
  // running and its terminal event. (A legitimate busy:false only ever
  // follows the turn's done/stopped broadcast — never precedes it.)
  let violations = 0
  let inTurn = false
  for (const { event, data } of watch.events) {
    if (event === 'turn') {
      inTurn = data.status === 'running'
    } else if (event === 'busy' && data.busy === false && inTurn) {
      violations += 1
    }
  }
  check('S9b 门禁 await 悬空期无陈旧 idle 广播（运行中回合不闪 busy:false）', violations === 0, `${violations} 个 busy:false 落在回合区间内`)
}

/* ------------------------------------------------------------------- main */

try {
  scenarioParser()
  scenarioGateTable()
  await scenarioSnapshot()
  await scenarioAutoCommitUnit()
  await scenarioEndToEnd()
  await scenarioRestartRace()
  await scenarioStaleIdleRace()
} catch (error) {
  failed += 1
  console.log(`× script error: ${error instanceof Error ? (error.stack ?? error.message) : error}`)
} finally {
  for (const proc of servers) {
    if (proc.exitCode === null && proc.signalCode !== null) await hardKill(proc).catch(() => {})
    if (proc.exitCode === null && proc.signalCode === null) await hardKill(proc).catch(() => {})
  }
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // a stray WAL handle on Windows; the temp dir self-cleans on reboot
    }
  }
}

if (failed > 0) {
  console.log(`\n${failed} case(s) failed`)
  process.exitCode = 1
} else {
  console.log(`\nOK: sop contract passed (${passed}/${passed})`)
}
