/**
 * B11 pre-commit blind review: a changed round auto-queues the designated
 * independent reviewer with ONLY the request + worktree diff, and its PASS
 * closes the SOP gate (auto-commit) without any chat-context review.
 *
 *   node scripts/blind-check.mjs
 *
 * Fixture: custom-harness implementer writes a file; mock reviewer
 * (MOCK-盲审) reports BLIND-OK only when the prompt has the blind shape.
 */
import { spawn } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
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

async function waitMessages(port, roomId, predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const { messages } = await req(port, `/api/rooms/${roomId}/messages?limit=200`)
    if (predicate(messages)) return messages
    await sleep(250)
  }
  return null
}

async function waitState(port, roomId, predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const state = await req(port, `/api/rooms/${roomId}/state`)
    if (predicate(state)) return state
    await sleep(200)
  }
  return null
}

const dataDir = mkdtempSync(join(tmpdir(), 'ac-blind-'))
const repo = mkdtempSync(join(tmpdir(), 'ac-blind-repo-'))
const git = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim()
git(['init', '-q'])
git(['config', 'user.email', 'blind@example.test'])
git(['config', 'user.name', 'blind'])
writeFileSync(join(repo, 'a.txt'), 'base\n')
git(['add', 'a.txt'])
git(['commit', '-q', '-m', 'seed'])

const proc = await bootServer(dataDir)
const port = proc.port

try {
  const room = await req(port, '/api/rooms', {
    method: 'POST',
    body: JSON.stringify({ name: '盲审房', workingDir: repo, maxHops: 6 }),
  })
  const implementer = await req(port, `/api/rooms/${room.id}/characters`, {
    method: 'POST',
    body: JSON.stringify({
      name: '实现者',
      harness: 'custom',
      model: '',
      persona: '写文件',
      commandTemplate: 'echo writer done & echo changed>blind-writer.txt',
      triggers: { onUser: true },
    }),
  })
  const reviewer = await req(port, `/api/rooms/${room.id}/characters`, {
    method: 'POST',
    body: JSON.stringify({
      name: '盲审员',
      harness: 'mock',
      model: 'mock',
      persona: 'MOCK-盲审',
      roles: ['reviewer'],
      triggers: { onUser: false, mention: true },
    }),
  })
  // No explicit reviewer designation: the role pool must select this one and
  // the gate must bind that selection to the round.
  await req(port, `/api/rooms/${room.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ blindReview: true }),
  })

  await req(port, `/api/rooms/${room.id}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content: '请开始' }),
  })

  const messages = await waitMessages(port, room.id, (items) =>
    items.some((message) => message.authorType === 'character' && message.authorName === '盲审员'),
  )
  const blindMessage = messages?.find(
    (message) => message.authorType === 'character' && message.authorName === '盲审员',
  )
  check('B1 未被 @ 的角色池 reviewer 自动进入盲审', Boolean(blindMessage), JSON.stringify(messages?.map((m) => m.authorName)))
  check(
    'B2 盲审 prompt 只有需求 + diff（BLIND-OK）且给出 PASS',
    Boolean(blindMessage?.content.includes('BLIND-OK')) && Boolean(blindMessage?.content.includes('REVIEW: PASS')),
    blindMessage?.content,
  )

  const idle = await waitState(
    port,
    room.id,
    (state) => !state.busy && state.gate === 'idle' && state.queuedCharacterIds.length === 0,
    40_000,
  )
  check('B3 盲审后房间回到空闲', Boolean(idle))

  const subject = git(['log', '-1', '--pretty=%s'])
  const files = git(['show', '--name-only', '--pretty=', 'HEAD']).split(/\r?\n/).filter(Boolean)
  check('B4 PASS 触发轮末自动提交', subject.startsWith('auto:'), subject)
  check('B5 提交包含实现者的改动', files.some((file) => file.includes('blind-writer.txt')), files.join(','))

  const { rounds } = await req(port, `/api/rooms/${room.id}/rounds`)
  const latest = rounds[0]
  check(
    'B6 角色池选中的 reviewer 被门禁认可，报告记录 review/commit 证据',
    Boolean(latest?.commitHash) &&
      latest.checks.some((check) => check.kind === 'review' && check.verdict === 'pass') &&
      latest.checks.some((check) => check.kind === 'commit'),
    JSON.stringify(latest?.checks),
  )
} finally {
  await killServer(proc)
}

if (failed) {
  console.log(`\n${failed} case(s) failed`)
  process.exit(1)
}
console.log('\nOK: pre-commit blind review passed')
process.exit(0)
