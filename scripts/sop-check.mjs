/**
 * P0-3 SOP-gate contract: change evidence (3a), REVIEW verdicts (3b) and
 * the round-close gate (3c) — as specified in workspace/p0-plan.md.
 *
 *   node scripts/sop-check.mjs
 *
 * Layers:
 *   S1  verdict parser  — standalone REVIEW: lines, multi-block markdown
 *                         (blank-line splits, bold paragraphs, lists),
 *                         quoted verdicts (blockquote/table/heading are
 *                         invisible), variants, whole-line code spans (25)
 *   S2  gate table      — all 7 decision rows of gateDecision (7)
 *   S3  worktree snap   — repo-root resolution: a cwd INSIDE a subdirectory
 *                         still sees sibling-directory changes; non-git
 *                         working dirs report available:false; untracked
 *                         fingerprints + dirty-file re-edit fallback (15)
 *   S4  green path      — write + REVIEW: PASS + verify exit 0 → verify runs
 *                         exactly once, round-end summary appears (6)
 *   S5  verify fails     — exit 1 with a LONG output (marker beyond the
 *                         1500-char prefix) → no summary, gate notice whose
 *                         output TAIL (not head) carries the marker (3)
 *   S6  no verdict      — changed round, no REVIEW line → blocked before any
 *                         verify runs (3)
 *   S7  chat-only round  — no changes → gate never runs, summary normal (3)
 *   S8  no verify config — changed + PASS closes directly; no verdict blocks (4)
 *   S9  restart race     — while the verify command runs, POST /api/restart
 *                         must NOT fire the restart (gateActive drains) (4)
 *   S9b stale idle       — a new turn started while the gate's verify was
 *                         running must never see a busy:false (SSE watch) (3)
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

import { changedPathsBetween, diffSnapshotPaths, snapshotWorktree } from '../server/gitstate.ts'
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
  const rows = [
    [{ changed: 0, verifyRequired: true, verify: 'none', verdict: 'none' }, 'close', '无改动 → 直接收尾（不跑验证）'],
    [{ changed: 2, verifyRequired: false, verify: 'none', verdict: 'changes' }, 'block', '有改动无验证命令 + CHANGES → 阻断'],
    [{ changed: 2, verifyRequired: false, verify: 'none', verdict: 'pass' }, 'close', '有改动无验证命令 + PASS → 收尾'],
    [{ changed: 1, verifyRequired: true, verify: 'none', verdict: 'none' }, 'block', '有验证命令但无结论 → 先卡结论不白跑验证'],
    [{ changed: 1, verifyRequired: true, verify: 'none', verdict: 'pass' }, 'run-verify', '有改动 + PASS + 未验证 → 跑验证'],
    [{ changed: 1, verifyRequired: true, verify: 'fail', verdict: 'pass' }, 'block', '验证失败 → 阻断'],
    [{ changed: 1, verifyRequired: true, verify: 'pass', verdict: 'pass' }, 'close', '验证通过 + PASS → 收尾'],
  ]
  for (const [input, expected, label] of rows) {
    const actual = gateDecision(input)
    check(`S2 ${label}`, actual === expected, `实际 ${actual}`)
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

  const server = await bootServer(dir)
  const port = server.port

  /* S4 green path: write + REVIEW: PASS + verify exit 0 → summary appears. */
  {
    const room = await makeSopRoom(port, repo, 's4-全绿', {
      verifyCommand: 'exit 0',
      reviewerPersona: 'MOCK-评审通过',
    })
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
    const messagesB = await runRoundAndDrain(port, roomB.id)
    check('S8b 无验证命令 + 无结论 → 阻断', characterMessages(messagesB, '总结丙').length === 0, '总结丙发言了')
    check(
      'S8b 门禁通知出现',
      systemNotices(messagesB, 'SOP 门禁').length === 1,
      `实际 ${systemNotices(messagesB, 'SOP 门禁').length}`,
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
