/**
 * B10 cross-room directory lock: two non-isolated rooms sharing one working
 * directory must never run turns concurrently (their CLIs would overwrite
 * each other's files and mix commits).
 *
 *   node scripts/collision-check.mjs
 *
 * C1  room B's turn stays queued while room A is running on the same dir
 *     (sampled states: never both busy at once).
 * C2  A's release wakes B, and B finishes on its own.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const IS_WIN = process.platform === 'win32'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let failed = 0
const servers = []
function check(name, ok, detail = '') {
  if (ok) console.log(`✓ ${name}`)
  else {
    failed += 1
    console.log(`× ${name}${detail ? `: ${detail}` : ''}`)
  }
}

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

async function bootServer(dataDir) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const port = freePort()
    const proc = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'server', 'index.ts')], {
      cwd: ROOT,
      env: { ...process.env, AC_DATA_DIR: dataDir, AC_PORT: String(port) },
      stdio: 'ignore',
      windowsHide: true,
    })
    servers.push(proc)
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      try {
        await req(port, '/api/health')
        return { port, proc }
      } catch {
        if (proc.exitCode !== null) break
        await sleep(200)
      }
    }
  }
  throw new Error('server failed to boot')
}

async function killServer(proc) {
  if (proc.exitCode !== null || proc.signalCode !== null) return
  if (IS_WIN) {
    await new Promise((resolve) => {
      const killer = spawn('taskkill', ['/F', '/T', '/PID', String(proc.pid)], { stdio: 'ignore', windowsHide: true })
      killer.on('close', resolve)
      killer.on('error', resolve)
    })
  } else {
    proc.kill('SIGKILL')
  }
}

async function waitState(port, roomId, predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const state = await req(port, `/api/rooms/${roomId}/state`)
      if (predicate(state)) return state
    } catch {
      /* between polls */
    }
    await sleep(150)
  }
  return null
}

async function waitMessages(port, roomId, predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const { messages } = await req(port, `/api/rooms/${roomId}/messages?limit=200`)
    if (predicate(messages)) return messages
    await sleep(250)
  }
  return null
}

const dataDir = mkdtempSync(join(tmpdir(), 'ac-collision-'))
const sharedDir = mkdtempSync(join(tmpdir(), 'ac-collision-work-'))
const proc = await bootServer(dataDir)
const port = proc.port

try {
  const roomA = await req(port, '/api/rooms', {
    method: 'POST',
    body: JSON.stringify({ name: '房间A', workingDir: sharedDir, maxHops: 2 }),
  })
  const roomB = await req(port, '/api/rooms', {
    method: 'POST',
    body: JSON.stringify({ name: '房间B', workingDir: sharedDir, maxHops: 2 }),
  })
  for (const [room, name] of [
    [roomA, '甲'],
    [roomB, '乙'],
  ]) {
    await req(port, `/api/rooms/${room.id}/characters`, {
      method: 'POST',
      body: JSON.stringify({ name, harness: 'mock', model: 'mock', persona: name, triggers: { onUser: true } }),
    })
  }

  await req(port, `/api/rooms/${roomA.id}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content: '请模拟慢速' }),
  })
  const aBusy = await waitState(port, roomA.id, (state) => state.busy, 10_000)
  check('C1 房间 A 已进入慢速回合', Boolean(aBusy))

  await req(port, `/api/rooms/${roomB.id}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content: '请模拟慢速' }),
  })

  let bothBusy = false
  let bQueuedWhileA = false
  for (let i = 0; i < 20; i += 1) {
    const [a, b] = await Promise.all([req(port, `/api/rooms/${roomA.id}/state`), req(port, `/api/rooms/${roomB.id}/state`)])
    if (a.busy && b.busy) bothBusy = true
    if (a.busy && b.queuedCharacterIds.length > 0) bQueuedWhileA = true
    await sleep(150)
  }
  check('C1 两房间从未同时运行', !bothBusy)
  check('C1 房间 B 在 A 运行期间保持排队', bQueuedWhileA)

  const aDone = await waitMessages(port, roomA.id, (messages) =>
    messages.some((message) => message.authorType === 'character' && message.authorName === '甲'),
  )
  const bDone = await waitMessages(port, roomB.id, (messages) =>
    messages.some((message) => message.authorType === 'character' && message.authorName === '乙'),
  )
  check('C2 房间 A 慢速回合完成', Boolean(aDone))
  check('C2 A 释放后房间 B 自动继续并完成', Boolean(bDone))

  const bState = await waitState(port, roomB.id, (state) => !state.busy && state.queuedCharacterIds.length === 0)
  check('C2 两个房间最终都空闲', Boolean(bState))

  const observability = await req(port, `/api/rooms/${roomA.id}/observability`)
  check(
    'C3 观测端点返回空闲状态与证据数组',
    observability.state.busy === false &&
      Array.isArray(observability.checks) &&
      Array.isArray(observability.crash) &&
      observability.round === null,
    JSON.stringify(observability),
  )
} finally {
  await killServer(proc)
  // Windows may still hold the SQLite file handle; temp dirs are disposable.
  try {
    rmSync(dataDir, { recursive: true, force: true })
    rmSync(sharedDir, { recursive: true, force: true })
  } catch {
    /* leave the temp dirs to the OS */
  }
}

if (failed) {
  console.log(`\n${failed} case(s) failed`)
  process.exit(1)
}
console.log('\nOK: cross-room directory lock passed')
// The spawned server can leave a Windows handle behind after taskkill; this
// suite has no other async work to drain, so exit explicitly.
process.exit(0)
