/**
 * P0-2 queue-persistence contract: the turns table doubles as the queue, so a
 * hard-killed server must lose no pending work (workspace/p0-plan.md).
 *
 *   node scripts/queue-check.mjs
 *
 * Boots REAL servers (AC_DATA_DIR -> temp dir, AC_PORT -> random) with mock
 * characters only, hard-kills them (taskkill /F /T on Windows, SIGKILL
 * elsewhere — no exit hooks either way), and reboots on the same DATA_DIR:
 *
 *   Q1  A queued turn survives the kill and runs to done — exactly once;
 *       the interrupted running turn is swept to error with exactly ONE
 *       system notice.
 *   Q2  A user stop terminal-sweeps the queued turn rows, so a reboot must
 *       not resurrect the silenced round.
 *   Q3  Persisted scheduling flags round-trip: hop=2 against maxHops=1 is
 *       stopped by the relay budget (hop not zeroed by the restore); a
 *       retry=1 turn fails once with no second auto-retry; an override
 *       persisted like a steer re-aim rides the reboot into the restored
 *       turn's 【现在轮到你】 (asserted via the mock's echo seam).
 *   Q4  An old-schema DB migrates in place (hop/override/retry/
 *       is_round_summary columns appear via addColumnIfMissing) and the boot
 *       still comes up healthy; a queued row for a deleted room is swept to
 *       stopped, not restored.
 *   Q5  A second reboot of the same DATA_DIR re-runs nothing already
 *       terminal (idempotent restore).
 *   Q6  The restored round fires NO round-end summary: a queued row inserted
 *       for a QUIET runner while the room also holds an onRoundEnd
 *       summarizer, reboot → the runner speaks, the summarizer stays silent
 *       and no is_round_summary row is created (restoreQueues owns no
 *       `rounds` entry — the reboot already cut that round).
 *   Q7  Regression = the rest of `pnpm test` + `pnpm typecheck`: this script
 *       is one suite in that chain, not a re-run of the others.
 *
 * Turn rows are read/written through node:sqlite against the temp DB (Q3's
 * rows are inserted while the server is down — never concurrently).
 * Output: `OK: queue contract passed (n/n)`; non-zero exit on any failure.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

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
          .then(() => 'up')
          .catch(() => 'wait'),
        exitCode.then((code) => `dead:${code}`),
      ])
      if (outcome === 'up') {
        up = true
        break
      }
      if (typeof outcome === 'string' && outcome.startsWith('dead:')) {
        dead = true
        break
      }
      await sleep(200)
    }
    if (up) return { port, pid: proc.pid, proc }
    lastLog = log
  }
  throw new Error(`server failed to boot on 4 ports; last boot log tail:\n${lastLog.slice(-2000)}`)
}

/** Hard kill — no exit hooks run, exactly the crash this suite simulates. */
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
  await sleep(300) // let the WAL files settle before the reboot
}

/* ------------------------------------------------------------------ polling */

async function waitState(port, roomId, predicate, timeoutMs = 15_000) {
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

const turnRowsWhere = (dataDir, where, ...args) =>
  withDb(dataDir, (handle) => handle.prepare(`select * from turns where ${where}`).all(...args))

async function waitTurn(dataDir, where, predicate, timeoutMs = 10_000, ...args) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const rows = turnRowsWhere(dataDir, where, ...args)
    if (rows.length > 0 && predicate(rows[0])) return rows[0]
    await sleep(150)
  }
  return null
}

/* ---------------------------------------------------------------- fixtures */

const ON_USER_ONLY = {
  onUser: true, onAll: false, onCharacters: [], onCharacterNames: [], keyword: '', mention: false, onRoundEnd: false,
}
const QUIET = {
  onUser: false, onAll: false, onCharacters: [], onCharacterNames: [], keyword: '', mention: false, onRoundEnd: false,
}

async function makeRoom(port, name, maxHops, workingDir) {
  return req(port, '/api/rooms', { method: 'POST', body: JSON.stringify({ name, maxHops, workingDir }) })
}

async function makeCharacter(port, roomId, name, triggers) {
  return req(port, `/api/rooms/${roomId}/characters`, {
    method: 'POST',
    body: JSON.stringify({ name, harness: 'mock', model: 'mock', persona: `队列测试角色 ${name}`, triggers }),
  })
}

async function postMessage(port, roomId, content) {
  return req(port, `/api/rooms/${roomId}/messages`, { method: 'POST', body: JSON.stringify({ content }) })
}

const characterMessages = (messages, authorName) =>
  messages.filter((message) => message.authorType === 'character' && message.authorName === authorName)

const systemNotices = (messages, keyword) =>
  messages.filter((message) => message.authorType === 'system' && message.content.includes(keyword))

/* ---------------------------------------------------------------- scenarios */

/**
 * Q1 + Q5. @all wakes both 甲 and 乙; 甲 runs the ~5s mock slow turn while 乙
 * waits queued. Hard-kill mid-甲 → reboot #1: 甲 swept to error (one notice),
 * 乙 restored and runs to done (one message, one turn row). Hard-kill again
 * while idle → reboot #2: nothing re-runs (terminal rows aren't restored).
 */
async function scenarioRestoreAndIdempotent() {
  const dir = mkdtempSync(join(tmpdir(), 'ac-queue-q1-'))
  tempDirs.push(dir)
  const s1 = await bootServer(dir)
  const room = await makeRoom(s1.port, 'q1-恢复', 4, dir)
  const jia = await makeCharacter(s1.port, room.id, '甲', ON_USER_ONLY)
  const yi = await makeCharacter(s1.port, room.id, '乙', ON_USER_ONLY)
  await postMessage(s1.port, room.id, '@all 请模拟慢速')

  const busyState = await waitState(s1.port, room.id, (state) => state.busy, 10_000)
  check('Q1 busy 窗口捕获（甲在跑、乙在队）', Boolean(busyState), '10s 内未观察到 busy')
  await sleep(1_000) // safely inside 甲's ~5s slow turn
  await hardKill(s1.proc)

  const s2 = await bootServer(dir)
  await waitMessages(s2.port, room.id, (messages) => characterMessages(messages, '乙').length > 0, 30_000)
  await waitState(s2.port, room.id, (state) => !state.busy && state.queuedCharacterIds.length === 0, 20_000)
  const messages = (await req(s2.port, `/api/rooms/${room.id}/messages?limit=200`)).messages

  const yiTurns = turnRowsWhere(dir, 'character_id = ?', yi.id)
  check(
    'Q1 乙 turn 恰 1 行且 done',
    yiTurns.length === 1 && yiTurns[0].status === 'done',
    JSON.stringify(yiTurns.map((row) => row.status)),
  )
  const yiMsgs = characterMessages(messages, '乙')
  check('Q1 乙 消息恰 1 条（不重跑）', yiMsgs.length === 1, `实际 ${yiMsgs.length} 条`)
  const jiaTurns = turnRowsWhere(dir, 'character_id = ?', jia.id)
  check(
    'Q1 甲 turn 被中断为 error',
    jiaTurns.length === 1 && jiaTurns[0].status === 'error' && jiaTurns[0].error === '服务器重启，回合中断',
    JSON.stringify(jiaTurns.map((row) => [row.status, row.error])),
  )
  const interrupts = systemNotices(messages, '已中断')
  check(
    'Q1 中断播报恰 1 条且计 1 个',
    interrupts.length === 1 && interrupts[0].content.includes('1 个进行中的回合已中断'),
    `实际 ${interrupts.length} 条`,
  )

  // Q5: kill again while idle, reboot the same DATA_DIR — no double runs.
  await hardKill(s2.proc)
  const s3 = await bootServer(dir)
  await sleep(1_500) // boot restore fires here; give any resurrected pump a beat to show itself
  const messages3 = (await req(s3.port, `/api/rooms/${room.id}/messages?limit=200`)).messages
  const yiMsgs3 = characterMessages(messages3, '乙')
  check('Q5 二次重启后乙消息仍恰 1 条', yiMsgs3.length === 1, `实际 ${yiMsgs3.length} 条`)
  const yiTurns3 = turnRowsWhere(dir, 'character_id = ?', yi.id)
  check(
    'Q5 乙 turn 行数不变（终态不恢复）',
    yiTurns3.length === 1 && yiTurns3[0].status === 'done',
    JSON.stringify(yiTurns3.map((row) => row.status)),
  )
}

/** Q2. A stop mid-turn sweeps the queued rows to 'stopped'; reboot must not revive them. */
async function scenarioStopSurvivesReboot() {
  const dir = mkdtempSync(join(tmpdir(), 'ac-queue-q2-'))
  tempDirs.push(dir)
  const s1 = await bootServer(dir)
  const room = await makeRoom(s1.port, 'q2-停止', 4, dir)
  await makeCharacter(s1.port, room.id, '丙', ON_USER_ONLY)
  const ding = await makeCharacter(s1.port, room.id, '丁', ON_USER_ONLY)
  await postMessage(s1.port, room.id, '@all 请模拟慢速')
  await waitState(s1.port, room.id, (state) => state.busy, 10_000)
  await req(s1.port, `/api/rooms/${room.id}/stop`, { method: 'POST', body: JSON.stringify({}) })
  await waitState(s1.port, room.id, (state) => !state.busy, 10_000)

  const dingTurns = turnRowsWhere(dir, 'character_id = ?', ding.id)
  check(
    'Q2 stop 时排队行即被标 stopped',
    dingTurns.length === 1 && dingTurns[0].status === 'stopped',
    JSON.stringify(dingTurns.map((row) => row.status)),
  )

  await hardKill(s1.proc)
  const s2 = await bootServer(dir)
  await sleep(1_500)
  const messages = (await req(s2.port, `/api/rooms/${room.id}/messages?limit=200`)).messages
  const dingMsgs = characterMessages(messages, '丁')
  check('Q2 重启后丁未复活（0 条消息）', dingMsgs.length === 0, `实际 ${dingMsgs.length} 条`)
  const dingTurns2 = turnRowsWhere(dir, 'character_id = ?', ding.id)
  check(
    'Q2 丁 turn 保持 stopped',
    dingTurns2.length === 1 && dingTurns2[0].status === 'stopped',
    JSON.stringify(dingTurns2.map((row) => row.status)),
  )
  check(
    'Q2 无中断播报（无在跑回合被杀）',
    systemNotices(messages, '已中断').length === 0,
    `实际 ${systemNotices(messages, '已中断').length} 条`,
  )
}

/**
 * Q3. Rows inserted directly into the temp DB while the server is down, with
 * the scheduling flags set by hand — the reboot must honor them:
 * hop=2 (maxHops=1) → stopped by the relay budget, proving hop survived;
 * retry=1 + 模拟失败 → runs once, no "正在自动重试一次".
 */
async function scenarioFlagsRoundTrip() {
  const dir = mkdtempSync(join(tmpdir(), 'ac-queue-q3-'))
  tempDirs.push(dir)
  const s1 = await bootServer(dir)
  const r3 = await makeRoom(s1.port, 'q3-接力上限', 1, dir)
  const r4 = await makeRoom(s1.port, 'q3-重试守卫', 4, dir)
  const r5 = await makeRoom(s1.port, 'q3-override往返', 4, dir)
  // Messages land while the rooms have no characters yet → nothing enqueues.
  const msg3 = await postMessage(s1.port, r3.id, '这次请模拟失败')
  const msg4 = await postMessage(s1.port, r4.id, '这次请模拟失败')
  const msg5 = await postMessage(s1.port, r5.id, '恢复后正常回复')
  const man3 = await makeCharacter(s1.port, r3.id, '慢三', QUIET)
  const man4 = await makeCharacter(s1.port, r4.id, '慢四', QUIET)
  const wu = await makeCharacter(s1.port, r5.id, '戊', QUIET)
  await hardKill(s1.proc)

  withDb(dir, (handle) => {
    const insert = handle.prepare(
      `insert into turns
         (id, room_id, character_id, status, trigger_message_id, output, error,
          hop, override, retry, is_round_summary, started_at, ended_at, pid)
       values (?, ?, ?, 'queued', ?, '', null, ?, ?, ?, ?, ?, null, null)`,
    )
    // hop=2 / retry=1 / is_round_summary=1 — one row carrying all three flags.
    insert.run('qc3-hop', r3.id, man3.id, msg3.id, 2, null, 1, 1, Date.now())
    // retry=1 on the failure seam: the loop guard must survive the reboot.
    insert.run('qc3-retry', r4.id, man4.id, msg4.id, 1, null, 1, 0, Date.now())
    // An override shaped like a steer re-aim: it must ride the reboot into
    // the restored turn's 【现在轮到你】 (steer depends on exactly this).
    insert.run('qc3-override', r5.id, wu.id, msg5.id, 1, '跨重启补充指令：请回显指令', 0, 0, Date.now())
  })

  const s2 = await bootServer(dir)
  const hopTurn = await waitTurn(dir, "id = 'qc3-hop'", (row) => row.status === 'stopped', 10_000)
  check(
    'Q3 hop=2 越限被标 stopped（hop 未被清零）',
    hopTurn !== null && hopTurn.status === 'stopped',
    hopTurn ? hopTurn.status : '10s 内仍非 stopped',
  )
  const r3Messages = (await req(s2.port, `/api/rooms/${r3.id}/messages?limit=200`)).messages
  check(
    'Q3 接力上限播报出现（1 层）',
    systemNotices(r3Messages, '本轮接力已达上限（1 层）').length === 1,
    '未找到上限播报',
  )

  const failArrived = await waitMessages(
    s2.port,
    r4.id,
    (messages) => systemNotices(messages, '运行失败').length > 0,
    20_000,
  )
  check('Q3 retry=1 失败回合跑过一次（有失败播报）', Boolean(failArrived), '20s 内无失败播报')
  const r4Messages = (await req(s2.port, `/api/rooms/${r4.id}/messages?limit=200`)).messages
  check(
    'Q3 无“正在自动重试一次”',
    !r4Messages.some((message) => message.content.includes('正在自动重试一次')),
    '出现了二次重试播报',
  )
  const man4Turns = turnRowsWhere(dir, 'character_id = ?', man4.id)
  check(
    'Q3 retry=1 turn 恰 1 行且 error',
    man4Turns.length === 1 && man4Turns[0].status === 'error',
    JSON.stringify(man4Turns.map((row) => row.status)),
  )

  // The override round-trip: the restored turn's 【现在轮到你】 carried the
  // persisted override into the prompt, and the mock's echo seam proves it.
  const echoed = await waitMessages(s2.port, r5.id, (messages) => characterMessages(messages, '戊').length > 0, 20_000)
  const wuContent = echoed ? characterMessages(echoed, '戊')[0].content : ''
  check(
    'Q3 override 跨重启存活（回显进入回复）',
    wuContent.includes('跨重启补充指令'),
    wuContent ? `回复不含 override：${wuContent.slice(0, 80)}` : '20s 内戊未发言',
  )
}

/** Q4. An old-schema turns table migrates in place; a ghost queued row is swept, not restored. */
async function scenarioOldSchemaMigration() {
  const dir = mkdtempSync(join(tmpdir(), 'ac-queue-q4-'))
  tempDirs.push(dir)
  const handle = new DatabaseSync(join(dir, 'agent-crowd.db'))
  handle.exec(`
    create table turns (
      id text primary key,
      room_id text not null,
      character_id text not null,
      status text not null,
      trigger_message_id text,
      output text not null default '',
      error text,
      started_at integer not null,
      ended_at integer
    );
  `)
  handle
    .prepare(
      `insert into turns (id, room_id, character_id, status, trigger_message_id, output, error, started_at, ended_at)
       values ('qc4-ghost', 'ghost-room', 'ghost-char', 'queued', null, '', null, ?, null)`,
    )
    .run(Date.now())
  handle.close()

  const s1 = await bootServer(dir)
  const health = await req(s1.port, '/api/health')
  check('Q4 老库上服务健康启动', health.ok === true, 'health 返回异常')

  const columns = new Set(
    withDb(dir, (db) => db.prepare('pragma table_info(turns)').all()).map((row) => row.name),
  )
  const missing = ['pid', 'hop', 'override', 'retry', 'is_round_summary'].filter((name) => !columns.has(name))
  check('Q4 老库迁移补齐 5 个新列', missing.length === 0, `缺列: ${missing.join(',')}`)

  const ghost = await waitTurn(dir, "id = 'qc4-ghost'", (row) => row.status === 'stopped', 10_000)
  check(
    'Q4 幽灵房间的 queued 行被清为 stopped',
    ghost !== null && ghost.status === 'stopped',
    ghost ? ghost.status : '10s 内仍非 stopped',
  )
}

/**
 * Q6. The restored round fires NO round-end summary. The room holds a QUIET
 * runner plus an onRoundEnd summarizer; a queued row inserted while the
 * server is down reboots into a running turn. When it drains, the summarizer
 * must stay silent and no is_round_summary row may appear — restoreQueues
 * deliberately creates no `rounds` entry (regression: it used to, and the
 * first restored turn flipped hadTurn back to true, firing the summary).
 */
async function scenarioNoSummaryAfterRestore() {
  const dir = mkdtempSync(join(tmpdir(), 'ac-queue-q6-'))
  tempDirs.push(dir)
  const s1 = await bootServer(dir)
  const room = await makeRoom(s1.port, 'q6-恢复轮不总结', 4, dir)
  // The user message lands while the room has no characters yet → nothing
  // enqueues and no round state exists: the queued row below is the only
  // thing a hard kill leaves behind, which is exactly the "pre-reboot round
  // cut by the reboot" shape.
  const msg = await postMessage(s1.port, room.id, '恢复后正常回复')
  const runner = await makeCharacter(s1.port, room.id, '跑者', QUIET)
  const summarizer = await makeCharacter(s1.port, room.id, '总结王', { ...QUIET, onRoundEnd: true })
  await hardKill(s1.proc)

  withDb(dir, (handle) => {
    handle
      .prepare(
        `insert into turns
           (id, room_id, character_id, status, trigger_message_id, output, error,
            hop, override, retry, is_round_summary, started_at, ended_at, pid)
         values ('qc6-run', ?, ?, 'queued', ?, '', null, 1, null, 0, 0, ?, null, null)`,
      )
      .run(room.id, runner.id, msg.id, Date.now())
  })

  const s2 = await bootServer(dir)
  const ran = await waitMessages(s2.port, room.id, (messages) => characterMessages(messages, '跑者').length > 0, 20_000)
  check('Q6 恢复的排队回合跑完（跑者发言）', Boolean(ran), '20s 内跑者未发言')
  // The summary decision is made in the pump cycle that drains the queue
  // (the runner's row turning 'done'); a buggy summary would be RUNNING
  // right after, so waiting for full idle guarantees any such summary has
  // already landed its message before the assertions read the room.
  await waitTurn(dir, "id = 'qc6-run'", (row) => row.status === 'done', 10_000)
  await waitState(s2.port, room.id, (state) => !state.busy && state.queuedCharacterIds.length === 0, 20_000)
  await sleep(1_000)
  const messages = (await req(s2.port, `/api/rooms/${room.id}/messages?limit=200`)).messages
  const summaryMsgs = characterMessages(messages, '总结王')
  check(
    'Q6 总结角色 0 条消息（恢复轮不触发轮末总结）',
    summaryMsgs.length === 0,
    `实际 ${summaryMsgs.length} 条`,
  )
  const summaryRows = turnRowsWhere(dir, 'room_id = ? and is_round_summary = 1', room.id)
  check(
    'Q6 无 is_round_summary=1 的 turn 行',
    summaryRows.length === 0,
    `实际 ${summaryRows.length} 行`,
  )
}

/* ------------------------------------------------------------------- main */

try {
  await scenarioRestoreAndIdempotent()
  await scenarioStopSurvivesReboot()
  await scenarioFlagsRoundTrip()
  await scenarioOldSchemaMigration()
  await scenarioNoSummaryAfterRestore()
} catch (error) {
  failed += 1
  console.log(`× script error: ${error instanceof Error ? (error.stack ?? error.message) : error}`)
} finally {
  for (const proc of servers) {
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
  console.log(`\nOK: queue contract passed (${passed}/${passed})`)
}
