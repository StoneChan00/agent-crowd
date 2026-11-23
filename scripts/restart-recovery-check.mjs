/**
 * B12 restart self-healing: a hard-killed server must continue the in-flight
 * turn that had already produced partial output.
 *
 *   node scripts/restart-recovery-check.mjs
 *
 * R1  hard kill mid-turn leaves the running row with a checkpointed partial
 * R2  reboot auto-queues exactly one recovery turn (`restart_recovery=1`)
 * R3  the partial reply is preserved as a chat message, and the recovery turn
 *     completes on its own
 */
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(import.meta.dirname, '..')
const IS_WIN = process.platform === 'win32'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let failed = 0
const servers = []
const check = (name, ok, detail = '') => {
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
  let lastError = null
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
      } catch (error) {
        lastError = error
        if (proc.exitCode !== null) break
        await sleep(200)
      }
    }
  }
  throw new Error(`server failed to boot: ${lastError}`)
}

async function hardKill(proc) {
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

async function waitState(port, roomId, predicate, timeoutMs = 20_000) {
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

const dataDir = mkdtempSync(join(tmpdir(), 'ac-restart-recovery-'))
const workDir = mkdtempSync(join(tmpdir(), 'ac-restart-work-'))
let room
let character

try {
  const first = await bootServer(dataDir)
  room = await req(first.port, '/api/rooms', {
    method: 'POST',
    body: JSON.stringify({ name: '恢复房', workingDir: workDir, maxHops: 4 }),
  })
  character = await req(first.port, `/api/rooms/${room.id}/characters`, {
    method: 'POST',
    body: JSON.stringify({ name: '甲', harness: 'mock', model: 'mock', persona: '恢复测试', triggers: { onUser: true } }),
  })
  await req(first.port, `/api/rooms/${room.id}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content: '请模拟慢速' }),
  })
  const busy = await waitState(first.port, room.id, (state) => state.busy, 10_000)
  check('R1 回合已进入运行中', Boolean(busy))
  await sleep(2_800) // slow mock emits every 400ms; one 2s checkpoint has fired
  await hardKill(first.proc)

  const handle = new DatabaseSync(join(dataDir, 'agent-crowd.db'))
  const before = handle
    .prepare("select id,status,output from turns where room_id = ? and status = 'running'")
    .all(room.id)
  handle.close()
  check(
    'R1 硬杀后 running 行带部分产出',
    before.length === 1 && before[0].output.trim().length > 0,
    JSON.stringify(before.map((row) => ({ status: row.status, len: row.output.length }))),
  )

  const second = await bootServer(dataDir)
  const messages = await waitMessages(
    second.port,
    room.id,
    (items) =>
      items.some((message) => message.authorType === 'system' && message.content.includes('已自动续跑')) &&
      items.filter((message) => message.authorType === 'character').length >= 2,
    30_000,
  )
  check('R2 重启后自动续跑通知出现', Boolean(messages?.some((m) => m.authorType === 'system' && m.content.includes('已自动续跑'))))
  const characterMessages = messages?.filter((m) => m.authorType === 'character') ?? []
  check(
    'R3 部分输出作为消息保留',
    characterMessages.some((m) => m.meta?.error === '服务器重启中断的部分输出' && String(m.content).trim().length > 0),
    JSON.stringify(characterMessages.map((m) => ({ error: m.meta?.error, len: m.content.length }))),
  )
  check('R3 续跑回合完成并发消息', characterMessages.length >= 2, `character messages=${characterMessages.length}`)

  const verify = new DatabaseSync(join(dataDir, 'agent-crowd.db'))
  const turns = verify
    .prepare('select id,status,restart_recovery,restart_recovery as rr from turns where room_id = ? order by started_at')
    .all(room.id)
  verify.close()
  check(
    'R2 原回合 error、续跑回合恰 1 条并完成',
    turns.length === 2 &&
      turns[0].status === 'error' &&
      turns.filter((turn) => turn.restart_recovery === 1).length === 1 &&
      turns[1].status === 'done',
    JSON.stringify(turns.map((turn) => ({ status: turn.status, rr: turn.restart_recovery }))),
  )

  const idle = await waitState(second.port, room.id, (state) => !state.busy && state.queuedCharacterIds.length === 0, 20_000)
  check('R3 房间最终空闲', Boolean(idle))
} catch (error) {
  failed += 1
  console.log(`× script error: ${error instanceof Error ? (error.stack ?? error.message) : error}`)
} finally {
  for (const proc of servers) await hardKill(proc).catch(() => {})
}

if (failed) {
  console.log(`\n${failed} case(s) failed`)
  process.exit(1)
}
console.log('\nOK: restart self-healing passed')
process.exit(0)
