/**
 * B13 structured CLI events: an adapter's tool_use/tool_result timeline must
 * survive the orchestrator into message.meta.events (and the legacy tools
 * list), so the UI has one renderer for every harness.
 *
 *   node scripts/cli-events-check.mjs
 */
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const IS_WIN = process.platform === 'win32'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let failed = 0
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

async function bootServer(dataDir) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const port = 20000 + Math.floor(Math.random() * 18000)
    const proc = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'server', 'index.ts')], {
      cwd: ROOT,
      env: { ...process.env, AC_DATA_DIR: dataDir, AC_PORT: String(port) },
      stdio: 'ignore',
      windowsHide: true,
    })
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

const dataDir = mkdtempSync(join(tmpdir(), 'ac-cli-events-'))
const proc = await bootServer(dataDir)
try {
  const room = await req(proc.port, '/api/rooms', {
    method: 'POST',
    body: JSON.stringify({ name: '事件房', workingDir: dataDir, maxHops: 2 }),
  })
  await req(proc.port, `/api/rooms/${room.id}/characters`, {
    method: 'POST',
    body: JSON.stringify({
      name: '甲',
      harness: 'mock',
      model: 'mock',
      persona: 'MOCK-结构化',
      triggers: { onUser: true },
    }),
  })
  await req(proc.port, `/api/rooms/${room.id}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content: '来' }),
  })

  let message
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const { messages } = await req(proc.port, `/api/rooms/${room.id}/messages?limit=50`)
    message = messages.find((item) => item.authorType === 'character')
    if (message) break
    await sleep(200)
  }
  const events = message?.meta?.events ?? []
  const tools = message?.meta?.tools ?? []
  check(
    'E1 消息保存 tool_use/tool_result 时间线',
    events.length === 2 &&
      events[0].kind === 'tool_use' &&
      events[0].name === 'Read' &&
      events[0].input === 'a.ts' &&
      events[1].kind === 'tool_result' &&
      events[1].ok === true &&
      events[1].output === 'file body',
    JSON.stringify(events),
  )
  check(
    'E2 旧 tools 字段仍保留且带 input',
    tools.length === 1 && tools[0].name === 'Read' && tools[0].input === 'a.ts' && tools[0].ok === true,
    JSON.stringify(tools),
  )
} finally {
  await killServer(proc)
}

if (failed) {
  console.log(`\n${failed} case(s) failed`)
  process.exit(1)
}
console.log('\nOK: structured CLI events passed')
process.exit(0)
