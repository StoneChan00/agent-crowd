/**
 * B03 task-card contract: proposal → approval → execution → settlement, as
 * specified in workspace/b03-plan.md.
 *
 *   node scripts/task-check.mjs
 *
 * Layers:
 *   T1  create-without-approve: 0 turns, status proposed, no card message (3)
 *   T2  approve: exactly 1 turn (linked via turns.task_id), exactly 1 card
 *       system message, card settles done (5)
 *   T3  prompt delivery: card fields reach the assignee's prompt — fresh,
 *       oversized (what 3900 + acceptance: the 4k chat cap must not cut the
 *       acceptance), and resumed (the card rides the B01 increment) (4)
 *   T4  reject: 0 turns, 0 messages, status rejected, re-approve 409 (4)
 *   T5  double approve: second 409, turn count stays 1 (2)
 *   T6  delete room: tasks cascade away (1)
 *   T7  delete assignee: card survives, assignee cleared, approve refuses (3)
 *   T8  settlement timestamps: approved_at/done_at written (2)
 *   T9  SOP gate block: file change + REVIEW: CHANGES → card stays running,
 *       result=blocked (3)
 *   T10 re-dispatch: second round, turn count 2, running → done (4)
 *   T11 validation: empty title/what, cross-room assignee, unknown task,
 *       bogus status, field edit on approved (6)
 *   T12 busy-approve + stop: approval writes running synchronously; a swept
 *       queued turn leaves the card running (no fake done) and re-
 *       dispatchable (5)
 *   T13 assignee disabled mid-queue: card stays running, the assignee can
 *       be re-pointed (content fields stay locked), re-dispatch finishes (5)
 *   T14 errored round: card settles running + result=error (never done),
 *       the auto-retry turns keep the task_id link, re-dispatch works (3)
 *   T15 scheduling exception: the adapter itself throws (missing-CLI /
 *       mkdir-EEXIST shape) — card settles running + result=error, the
 *       「回合调度异常」notice fires, re-dispatch works (3)
 *
 * Server scenarios boot one real server (AC_DATA_DIR on a temp dir, mock
 * harness only); T9 uses a real git repo as the room's working dir so the
 * SOP gate sees the change evidence. Output: `OK: task contract passed
 * (n/n)`; non-zero exit on any failure.
 */
import { spawn, execFileSync } from 'node:child_process'
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

/** Non-throwing variant for the 4xx/409 assertions (T4/T5/T11). */
async function attempt(port, path, init) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: { 'content-type': 'application/json' },
    ...init,
  })
  const text = await response.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = { error: text }
  }
  return { status: response.status, body }
}

const freePort = () => 20000 + Math.floor(Math.random() * 18000)

async function bootServer(dataDir) {
  for (let attemptCount = 0; attemptCount < 4; attemptCount++) {
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
    const deadline = Date.now() + 30_000
    let dead = false
    while (Date.now() < deadline && !dead) {
      const outcome = await Promise.race([
        req(port, '/api/health')
          .then(() => 'up')
          .catch(() => 'wait'),
        new Promise((resolve) => proc.once('exit', (code) => resolve(`dead:${code}`))).then((state) => state),
      ])
      if (outcome === 'up') return port
      if (typeof outcome === 'string' && outcome.startsWith('dead:')) {
        dead = true
        break
      }
      await sleep(200)
    }
  }
  throw new Error('server failed to boot on 4 ports')
}

async function hardKill(proc) {
  if (proc.exitCode !== null || proc.signalCode !== null) return
  if (IS_WIN) {
    await new Promise((resolve) => {
      const killer = spawn('taskkill', ['/F', '/T', '/PID', String(proc.pid)], { stdio: 'ignore', windowsHide: true })
      killer.on('close', () => resolve())
      killer.on('error', resolve)
    })
  } else {
    proc.kill('SIGKILL')
  }
  await sleep(300)
}

/* ------------------------------------------------------------------ polling */

async function waitIdle(port, roomId, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const state = await req(port, `/api/rooms/${roomId}/state`)
      if (!state.busy && state.queuedCharacterIds.length === 0 && state.gate === 'idle') return true
    } catch {
      /* transient poll gap */
    }
    await sleep(200)
  }
  return false
}

/** Wait until the room has a running turn (T12/T13's busy-approval window). */
async function waitBusy(port, roomId, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const state = await req(port, `/api/rooms/${roomId}/state`)
      if (state.busy) return true
    } catch {
      /* transient poll gap */
    }
    await sleep(100)
  }
  return false
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

const taskRows = (dataDir, where = '1=1', ...args) =>
  withDb(dataDir, (handle) => handle.prepare(`select * from tasks where ${where}`).all(...args))

const turnRows = (dataDir, where, ...args) =>
  withDb(dataDir, (handle) => handle.prepare(`select * from turns where ${where} order by started_at asc`).all(...args))

const messageRows = (dataDir, where, ...args) =>
  withDb(dataDir, (handle) => handle.prepare(`select * from messages where ${where} order by created_at asc`).all(...args))

/* ---------------------------------------------------------------- fixtures */

const ON_USER_ONLY = {
  onUser: true, onAll: false, onCharacters: [], onCharacterNames: [], keyword: '', mention: false, onRoundEnd: false,
}

async function makeRoom(port, name, workingDir) {
  return req(port, '/api/rooms', {
    method: 'POST',
    body: JSON.stringify({ name, maxHops: 4, workingDir }),
  })
}

async function makeCharacter(port, roomId, name, persona = '任务测试角色') {
  return req(port, `/api/rooms/${roomId}/characters`, {
    method: 'POST',
    body: JSON.stringify({ name, harness: 'mock', model: 'mock', persona, triggers: ON_USER_ONLY }),
  })
}

async function postMessage(port, roomId, content) {
  return req(port, `/api/rooms/${roomId}/messages`, { method: 'POST', body: JSON.stringify({ content }) })
}

const createTask = (port, roomId, input) =>
  req(port, `/api/rooms/${roomId}/tasks`, { method: 'POST', body: JSON.stringify(input) })

const getTask = (port, taskId) => req(port, `/api/tasks/${taskId}`)

const repliesOf = async (port, roomId, name) =>
  (await req(port, `/api/rooms/${roomId}/messages?limit=300`)).messages.filter(
    (message) => message.authorType === 'character' && message.authorName === name,
  )

/* ------------------------------------------------------------------- main */

const dir = mkdtempSync(join(tmpdir(), 'ac-task-'))
tempDirs.push(dir)
const plainWork = mkdtempSync(join(tmpdir(), 'ac-task-w-'))
tempDirs.push(plainWork)

try {
  const port = await bootServer(dir)

  /* T1 — create without approve: nothing runs, nothing is announced. */
  const roomA = await makeRoom(port, 't1-建卡', plainWork)
  const workerA = await makeCharacter(port, roomA.id, '甲', 'MOCK-任务')
  const taskA = await createTask(port, roomA.id, {
    title: 'T1-登录页改版',
    what: '把登录页改成新的设计稿，WHAT-SENTINEL 全部对齐。',
    why: '旧版转化率低',
    acceptance: 'ACC-SENTINEL：像素级对齐且通过回归',
    assigneeId: workerA.id,
  })
  await sleep(400)
  check('T1 建卡后状态 proposed', (await getTask(port, taskA.id)).status === 'proposed')
  check('T1 建卡不产生任何回合', turnRows(dir, 'room_id = ?', roomA.id).length === 0)
  check('T1 建卡不发任务系统消息', messageRows(dir, "room_id = ? and content like '%【任务卡】%'", roomA.id).length === 0)

  /* T2 — approve: exactly one turn, one card message, settles done. */
  const approvedA = await req(port, `/api/tasks/${taskA.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'approved' }),
  })
  check('T2 批准同步段即 running（瞬态 approved 已收进同步段）', approvedA.status === 'running', approvedA.status)
  const drainedA = await waitIdle(port, roomA.id)
  const settledA = await getTask(port, taskA.id)
  const turnsA = turnRows(dir, 'room_id = ?', roomA.id)
  check('T2 批准触发恰 1 个回合且排空', drainedA && turnsA.length === 1, `turns=${turnsA.length}`)
  check('T2 回合经 turns.task_id 关联卡片', turnsA[0]?.task_id === taskA.id, JSON.stringify(turnsA[0]?.task_id))
  check(
    'T2 恰好 1 条任务系统消息（meta.taskId 反查）',
    messageRows(dir, "room_id = ? and content like '%【任务卡】%'", roomA.id).length === 1,
  )
  check('T2 正常收尾后卡片 done', settledA.status === 'done', settledA.status)

  /* T3 — prompt delivery: fresh, oversized, resumed. */
  const roomB = await makeRoom(port, 't3-送达', plainWork)
  const workerB = await makeCharacter(port, roomB.id, '乙', 'MOCK-任务')
  const taskB = await createTask(port, roomB.id, {
    title: 'T3-小卡',
    what: '做一件小事，WHAT-SENTINEL-B。',
    why: '',
    acceptance: 'ACC-SENTINEL-B：完成即收',
    assigneeId: workerB.id,
  })
  await req(port, `/api/tasks/${taskB.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'approved' }) })
  await waitIdle(port, roomB.id)
  const replyB = (await repliesOf(port, roomB.id, '乙'))[0]
  check('T3 批准后字段送达 prompt（TASK-PROMPT-OK）', replyB?.content.includes('TASK-PROMPT-OK'), replyB?.content)
  check('T3 首轮为全量（meta.resume 未置位）', replyB?.meta?.resume !== true)

  const roomC = await makeRoom(port, 't3-大卡', plainWork)
  const workerC = await makeCharacter(port, roomC.id, '丙', 'MOCK-任务')
  const taskC = await createTask(port, roomC.id, {
    title: 'T3-超大卡',
    what: `WHAT-SENTINEL-C 开头。${'x'.repeat(3_900)}`,
    why: '',
    acceptance: 'ACC-SENTINEL-C：验收行不得被截断',
    assigneeId: workerC.id,
  })
  await req(port, `/api/tasks/${taskC.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'approved' }) })
  await waitIdle(port, roomC.id)
  const replyC = (await repliesOf(port, roomC.id, '丙'))[0]
  check(
    'T3 大卡（what 3900）的验收标准不被 4k 单条上限截掉',
    replyC?.content.includes('TASK-PROMPT-OK'),
    replyC?.content,
  )

  const roomD = await makeRoom(port, 't3-续传', plainWork)
  const workerD = await makeCharacter(port, roomD.id, '丁', 'MOCK-任务')
  await postMessage(port, roomD.id, '第一轮：先建立会话')
  await waitIdle(port, roomD.id)
  const taskD = await createTask(port, roomD.id, {
    title: 'T3-续传卡',
    what: '做一件续传的事，WHAT-SENTINEL-D。',
    why: '',
    acceptance: 'ACC-SENTINEL-D：续传送达',
    assigneeId: workerD.id,
  })
  await req(port, `/api/tasks/${taskD.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'approved' }) })
  await waitIdle(port, roomD.id, 40_000)
  const repliesD = await repliesOf(port, roomD.id, '丁')
  check(
    'T3 续传房间：卡片随 B01 增量送达（meta.resume=true 且 OK）',
    repliesD[1]?.meta?.resume === true && repliesD[1]?.content.includes('TASK-PROMPT-OK'),
    JSON.stringify({ resume: repliesD[1]?.meta?.resume, content: repliesD[1]?.content?.slice(0, 80) }),
  )

  /* T4 — reject: nothing runs, nothing is announced, re-approve refused. */
  const roomE = await makeRoom(port, 't4-驳回', plainWork)
  const workerE = await makeCharacter(port, roomE.id, '戊', 'MOCK-任务')
  const taskE = await createTask(port, roomE.id, {
    title: 'T4-被驳回的卡',
    what: '不会被批准的内容',
    why: '',
    acceptance: '无',
    assigneeId: workerE.id,
  })
  const rejectedE = await req(port, `/api/tasks/${taskE.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'rejected' }),
  })
  await sleep(400)
  check('T4 驳回后状态 rejected', rejectedE.status === 'rejected')
  check('T4 驳回零回合', turnRows(dir, 'room_id = ?', roomE.id).length === 0)
  check('T4 驳回零任务系统消息', messageRows(dir, "room_id = ? and content like '%【任务卡】%'", roomE.id).length === 0)
  const reApproveE = await attempt(port, `/api/tasks/${taskE.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'approved' }),
  })
  check('T4 驳回后再批准被拒（409）', reApproveE.status === 409, `status=${reApproveE.status}`)

  /* T5 — double approve is idempotent-refused. */
  const roomF = await makeRoom(port, 't5-重复批准', plainWork)
  const workerF = await makeCharacter(port, roomF.id, '己', 'MOCK-任务')
  const taskF = await createTask(port, roomF.id, {
    title: 'T5-只批准一次',
    what: '内容',
    why: '',
    acceptance: '标准',
    assigneeId: workerF.id,
  })
  await req(port, `/api/tasks/${taskF.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'approved' }) })
  await waitIdle(port, roomF.id)
  const secondF = await attempt(port, `/api/tasks/${taskF.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'approved' }),
  })
  check('T5 第二次批准 409', secondF.status === 409, `status=${secondF.status}`)
  check('T5 turn 总数仍为 1', turnRows(dir, 'room_id = ?', roomF.id).length === 1)

  /* T6 — deleting the room cascades its cards away. */
  const roomG = await makeRoom(port, 't6-删房间', plainWork)
  const workerG = await makeCharacter(port, roomG.id, '庚', 'MOCK-任务')
  const taskG = await createTask(port, roomG.id, {
    title: 'T6-随房间消失',
    what: '内容',
    why: '',
    acceptance: '标准',
    assigneeId: workerG.id,
  })
  await req(port, `/api/rooms/${roomG.id}`, { method: 'DELETE' })
  check('T6 删除房间 → tasks 级联为空', taskRows(dir, 'room_id = ?', roomG.id).length === 0)

  /* T7 — deleting the assignee keeps the card, clears the pointer. */
  const roomH = await makeRoom(port, 't7-删负责人', plainWork)
  const workerH = await makeCharacter(port, roomH.id, '辛', 'MOCK-任务')
  const taskH = await createTask(port, roomH.id, {
    title: 'T7-负责人被删',
    what: '内容',
    why: '',
    acceptance: '标准',
    assigneeId: workerH.id,
  })
  await req(port, `/api/characters/${workerH.id}`, { method: 'DELETE' })
  const rowH = taskRows(dir, 'id = ?', taskH.id)[0]
  check('T7 删 assignee → 卡片保留且 assignee_id 置空', rowH && rowH.assignee_id === null && rowH.status === 'proposed')
  const approveH = await attempt(port, `/api/tasks/${taskH.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'approved' }),
  })
  check('T7 无负责人的卡片不能批准（400）', approveH.status === 400, `status=${approveH.status}`)

  /* T8 — settlement timestamps. */
  const settledF = await getTask(port, taskF.id)
  check('T8 批准时间落库', Number(settledF.approvedAt) > 0, JSON.stringify(settledF.approvedAt))
  check('T8 完成时间落库且状态 done', settledF.status === 'done' && Number(settledF.doneAt) > 0, settledF.status)

  /* T9 — SOP gate block keeps the card running. Real git repo as workdir so
     the drill's file write counts as change evidence. */
  const repo = mkdtempSync(join(tmpdir(), 'ac-task-repo-'))
  tempDirs.push(repo)
  execFileSync('git', ['-C', repo, 'init'], { stdio: 'ignore' })
  execFileSync('git', ['-C', repo, 'add', '-A'], { stdio: 'ignore' })
  execFileSync('git', ['-C', repo, '-c', 'user.name=task', '-c', 'user.email=task@t', 'commit', '-m', 'seed', '--allow-empty'], {
    stdio: 'ignore',
  })
  const roomI = await makeRoom(port, 't9-门禁拦截', repo)
  const workerI = await makeCharacter(port, roomI.id, '壬', 'MOCK-任务')
  const taskI = await createTask(port, roomI.id, {
    title: 'T9-返修演练卡',
    what: '这是一次返修演练：实现过程中会写文件并给出 REVIEW: CHANGES。',
    why: '',
    acceptance: '门禁拦截后卡片必须保持 running',
    assigneeId: workerI.id,
  })
  await req(port, `/api/tasks/${taskI.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'approved' }) })
  await waitIdle(port, roomI.id, 40_000)
  const blockedI = await getTask(port, taskI.id)
  check('T9 门禁 block → 卡片保持 running', blockedI.status === 'running', blockedI.status)
  check('T9 result=blocked 留痕', blockedI.result === 'blocked', JSON.stringify(blockedI.result))
  check(
    'T9 门禁说明已播报',
    messageRows(dir, "room_id = ? and content like '%SOP 门禁%'", roomI.id).length === 1,
  )

  /* T10 — re-dispatch opens a second round that closes clean. */
  const dispatchI = await req(port, `/api/tasks/${taskI.id}/dispatch`, { method: 'POST' })
  await waitIdle(port, roomI.id, 40_000)
  const settledI = await getTask(port, taskI.id)
  const turnsI = turnRows(dir, 'room_id = ?', roomI.id)
  check('T10 派发后仍是 running 起步', dispatchI.status === 'running', dispatchI.status)
  check('T10 第二个回合跑完（turn 数 2）', turnsI.length === 2, `turns=${turnsI.length}`)
  check('T10 收尾后卡片 done 且 blocked 结果清除', settledI.status === 'done' && settledI.result === null, JSON.stringify({ status: settledI.status, result: settledI.result }))
  check(
    'T10 重新派发消息恰 1 条（含【任务卡·重新派发】）',
    messageRows(dir, "room_id = ? and content like '%【任务卡·重新派发】%'", roomI.id).length === 1,
  )

  /* T11 — parameter validation. */
  const roomJ = await makeRoom(port, 't11-校验', plainWork)
  const workerJ = await makeCharacter(port, roomJ.id, '癸', 'MOCK-任务')
  const otherRoom = await makeRoom(port, 't11-别的房间', plainWork)
  const otherWorker = await makeCharacter(port, otherRoom.id, '外来者', 'MOCK-任务')
  const emptyTitle = await attempt(port, `/api/rooms/${roomJ.id}/tasks`, {
    method: 'POST',
    body: JSON.stringify({ title: '  ', what: '内容', assigneeId: workerJ.id }),
  })
  check('T11 空 title → 400', emptyTitle.status === 400, `status=${emptyTitle.status}`)
  const emptyWhat = await attempt(port, `/api/rooms/${roomJ.id}/tasks`, {
    method: 'POST',
    body: JSON.stringify({ title: '标题', what: '', assigneeId: workerJ.id }),
  })
  check('T11 空 what → 400', emptyWhat.status === 400, `status=${emptyWhat.status}`)
  const crossRoom = await attempt(port, `/api/rooms/${roomJ.id}/tasks`, {
    method: 'POST',
    body: JSON.stringify({ title: '标题', what: '内容', assigneeId: otherWorker.id }),
  })
  check('T11 跨房间 assignee → 400', crossRoom.status === 400, `status=${crossRoom.status}`)
  const unknown = await attempt(port, '/api/tasks/no-such-task', {
    method: 'PATCH',
    body: JSON.stringify({ status: 'approved' }),
  })
  check('T11 未知 task → 404', unknown.status === 404, `status=${unknown.status}`)
  const bogus = await createTask(port, roomJ.id, { title: '标题', what: '内容', acceptance: '标准', assigneeId: workerJ.id })
  const badStatus = await attempt(port, `/api/tasks/${bogus.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'done' }),
  })
  check('T11 非法 status 直改 → 409', badStatus.status === 409, `status=${badStatus.status}`)
  await req(port, `/api/tasks/${bogus.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'approved' }) })
  await waitIdle(port, roomJ.id)
  const editApproved = await attempt(port, `/api/tasks/${bogus.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ title: '改标题' }),
  })
  check('T11 已批准卡编辑字段 → 409', editApproved.status === 409, `status=${editApproved.status}`)

  /* T12 — approve while busy + stop: the card must stay actionable.
     (B03 review blocking 1: the old fleeting `approved` state had no exit —
     a queued turn swept by a stop locked the card out of every action.) */
  const roomK = await makeRoom(port, 't12-忙时批准', plainWork)
  await makeCharacter(port, roomK.id, '慢甲', '普通角色')
  const workerK = await makeCharacter(port, roomK.id, '快乙', 'MOCK-任务')
  await postMessage(port, roomK.id, '模拟慢速，先占住房间')
  check('T12 房间已忙（慢速回合在跑）', await waitBusy(port, roomK.id))
  const taskK = await createTask(port, roomK.id, {
    title: 'T12-忙时批准的卡',
    what: '排队中被 stop 扫掉也不丢出路，WHAT-K。',
    why: '',
    acceptance: 'ACC-K：卡片必须可重派',
    assigneeId: workerK.id,
  })
  const approveK = await req(port, `/api/tasks/${taskK.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'approved' }),
  })
  check('T12 忙时批准同步段即 running', approveK.status === 'running', approveK.status)
  await req(port, `/api/rooms/${roomK.id}/stop`, { method: 'POST' })
  await waitIdle(port, roomK.id, 40_000)
  const stoppedK = await getTask(port, taskK.id)
  check(
    'T12 stop 扫掉排队回合后卡片仍 running（无假 done、可重派）',
    stoppedK.status === 'running' && stoppedK.doneAt === null,
    JSON.stringify({ status: stoppedK.status, doneAt: stoppedK.doneAt }),
  )
  await req(port, `/api/tasks/${taskK.id}/dispatch`, { method: 'POST' })
  await waitIdle(port, roomK.id, 40_000)
  const finalK = await getTask(port, taskK.id)
  const turnsK = turnRows(dir, 'room_id = ?', roomK.id)
  check(
    'T12 重派后跑完 done',
    finalK.status === 'done' && finalK.doneAt !== null,
    JSON.stringify({ status: finalK.status, doneAt: finalK.doneAt }),
  )
  check('T12 turn 序列（慢速 stopped + 排队 swept + 重派 done）', turnsK.length === 3, `turns=${turnsK.length}`)

  /* T13 — assignee disabled mid-queue: re-assign keeps the card actionable. */
  const roomL = await makeRoom(port, 't13-换人重派', plainWork)
  await makeCharacter(port, roomL.id, '慢甲', '普通角色')
  const workerL = await makeCharacter(port, roomL.id, '乙', 'MOCK-任务')
  const spareL = await makeCharacter(port, roomL.id, '丙', 'MOCK-任务')
  await postMessage(port, roomL.id, '模拟慢速，先占住房间')
  check('T13 房间已忙', await waitBusy(port, roomL.id))
  const taskL = await createTask(port, roomL.id, {
    title: 'T13-负责人失效的卡',
    what: '排队期间负责人被停用，WHAT-L。',
    why: '',
    acceptance: 'ACC-L：换人后可重派',
    assigneeId: workerL.id,
  })
  await req(port, `/api/tasks/${taskL.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'approved' }) })
  await req(port, `/api/characters/${workerL.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: false }) })
  await waitIdle(port, roomL.id, 40_000)
  const stuckL = await getTask(port, taskL.id)
  check(
    'T13 排队中负责人被停用 → 卡片保持 running（不假 done）',
    stuckL.status === 'running' && stuckL.doneAt === null,
    JSON.stringify({ status: stuckL.status }),
  )
  const reassignL = await req(port, `/api/tasks/${taskL.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ assigneeId: spareL.id }),
  })
  check('T13 进行中卡片可换负责人（200）', reassignL.assigneeId === spareL.id, JSON.stringify(reassignL.assigneeId))
  const titleEditL = await attempt(port, `/api/tasks/${taskL.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ title: '偷改标题' }),
  })
  check('T13 进行中卡片改内容字段仍 409', titleEditL.status === 409, `status=${titleEditL.status}`)
  await req(port, `/api/tasks/${taskL.id}/dispatch`, { method: 'POST' })
  await waitIdle(port, roomL.id, 40_000)
  const finalL = await getTask(port, taskL.id)
  check('T13 换人重派后 done', finalL.status === 'done', finalL.status)

  /* T14 — an errored round must not settle the card as done. The failing
     context is a prior 模拟失败 user message: the mock's lastUser seam picks
     it up, so the card turn (and its auto-retry) error out too. */
  const roomM = await makeRoom(port, 't14-回合出错', plainWork)
  const workerM = await makeCharacter(port, roomM.id, '丁', 'MOCK-任务')
  await postMessage(port, roomM.id, '模拟失败：先制造一个会报错的上下文')
  await waitIdle(port, roomM.id, 40_000)
  const taskM = await createTask(port, roomM.id, {
    title: 'T14-会出错的卡',
    what: '这一轮的 prompt 里最后一条用户消息是模拟失败，注定报错。',
    why: '',
    acceptance: 'ACC-M：出错不假 done',
    assigneeId: workerM.id,
  })
  await req(port, `/api/tasks/${taskM.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'approved' }) })
  await waitIdle(port, roomM.id, 40_000)
  const erroredM = await getTask(port, taskM.id)
  const turnsM = turnRows(dir, 'room_id = ?', roomM.id)
  check(
    'T14 回合报错 → 卡片不 done（running + result=error）',
    erroredM.status === 'running' && erroredM.result === 'error' && erroredM.doneAt === null,
    JSON.stringify({ status: erroredM.status, result: erroredM.result, doneAt: erroredM.doneAt }),
  )
  // Filter by task_id, not position: the retry policy (how many error turns
  // the chat round produces) must not make this assertion drift.
  const taskTurnsM = turnsM.filter((turn) => turn.task_id === taskM.id)
  check(
    'T14 重试链的 turn 也带 task_id（重启不丢关联）',
    taskTurnsM.length >= 2 && taskTurnsM.every((turn) => turn.status === 'error'),
    JSON.stringify(turnsM.map((turn) => [turn.status, turn.task_id])),
  )
  const dispatchM = await req(port, `/api/tasks/${taskM.id}/dispatch`, { method: 'POST' })
  check('T14 出错卡片可重新派发', dispatchM.status === 'running', dispatchM.status)

  /* T15 — a scheduling EXCEPTION (the adapter itself throwing) must not
     settle done either. (B03 review 3: the catch path never reached the
     output.error handling, so a crashed turn left lastTurnOutcome at its
     default 'ok' — missing CLI binaries and mkdirSync EEXIST land here.) */
  const roomN = await makeRoom(port, 't15-调度崩溃', plainWork)
  const workerN = await makeCharacter(port, roomN.id, '戊', 'MOCK-崩溃')
  const taskN = await createTask(port, roomN.id, {
    title: 'T15-会崩溃的卡',
    what: '适配器直接抛异常，不走 output.error 路径。',
    why: '',
    acceptance: 'ACC-N：崩溃不假 done',
    assigneeId: workerN.id,
  })
  await req(port, `/api/tasks/${taskN.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'approved' }) })
  await waitIdle(port, roomN.id, 40_000)
  const crashedN = await getTask(port, taskN.id)
  const turnsN = turnRows(dir, 'room_id = ?', roomN.id)
  check(
    'T15 调度异常（adapter throw）→ 卡片不 done（running + result=error）',
    crashedN.status === 'running' && crashedN.result === 'error' && crashedN.doneAt === null,
    JSON.stringify({ status: crashedN.status, result: crashedN.result, doneAt: crashedN.doneAt }),
  )
  check(
    'T15 turn 行 status=error 且调度异常已播报',
    turnsN.length === 1 &&
      turnsN[0].status === 'error' &&
      messageRows(dir, "room_id = ? and content like '%回合调度异常%'", roomN.id).length === 1,
    JSON.stringify(turnsN.map((turn) => turn.status)),
  )
  const dispatchN = await req(port, `/api/tasks/${taskN.id}/dispatch`, { method: 'POST' })
  check('T15 崩溃卡片可重新派发', dispatchN.status === 'running', dispatchN.status)
} catch (error) {
  failed += 1
  console.log(`× script error: ${error instanceof Error ? (error.stack ?? error.message) : error}`)
} finally {
  for (const proc of servers) await hardKill(proc).catch(() => {})
  for (const temp of tempDirs) {
    try {
      rmSync(temp, { recursive: true, force: true })
    } catch {
      /* stray WAL handle on Windows */
    }
  }
}

if (failed > 0) {
  console.log(`\n${failed} case(s) failed`)
  process.exitCode = 1
} else {
  console.log(`\nOK: task contract passed (${passed}/${passed})`)
}
