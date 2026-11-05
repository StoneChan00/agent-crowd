/**
 * P0-3 SOP-gate contract: change evidence (3a), REVIEW verdicts (3b) and
 * the round-close gate (3c) — as specified in workspace/p0-plan.md.
 *
 *   node scripts/sop-check.mjs
 *
 * Layers:
 *   S1  verdict parser  — standalone REVIEW: lines, quoting, variants (13)
 *   S2  gate table      — all 7 decision rows of gateDecision (7)
 *   S3  worktree snap   — repo-root resolution: a cwd INSIDE a subdirectory
 *                         still sees sibling-directory changes; non-git
 *                         working dirs report available:false (5)
 *   S4  green path      — write + REVIEW: PASS + verify exit 0 → verify runs
 *                         exactly once, round-end summary appears (7)
 *   S5  verify fails     — exit 1 → no summary, gate notice with exit code,
 *                         round_checks verify/fail row (4)
 *   S6  no verdict      — changed round, no REVIEW line → blocked before any
 *                         verify runs (3)
 *   S7  chat-only round  — no changes → gate never runs, summary normal (3)
 *   S8  no verify config — changed + PASS closes directly; no verdict blocks (4)
 *   S9  restart race     — while the verify command runs, POST /api/restart
 *                         must NOT fire the restart (gateActive drains) (3)
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

import { diffSnapshotPaths, snapshotWorktree } from '../server/gitstate.ts'
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

  /* S5 verify fails: exit 1 → no summary, fail notice, verify/fail row. */
  {
    const room = await makeSopRoom(port, repo, 's5-验证失败', {
      verifyCommand: 'echo sop-verify-fail-marker && exit 1',
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

/* ------------------------------------------------------------------- main */

try {
  scenarioParser()
  scenarioGateTable()
  await scenarioSnapshot()
  await scenarioEndToEnd()
  await scenarioRestartRace()
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
