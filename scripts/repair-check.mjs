/**
 * B15 auto-repair contract:
 *   P1  REVIEW: CHANGES → one automatic repair turn for the implementer,
 *       followed by a fresh blind review; a second PASS closes and commits.
 *   P2  an always-CHANGES reviewer hits the cap: exactly two reviews, one
 *       repair, no commit, round blocked.
 *
 *   node scripts/repair-check.mjs
 */
import { execFileSync, spawn } from 'node:child_process'
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

async function waitMessages(port, roomId, predicate, timeoutMs = 40_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const { messages } = await req(port, `/api/rooms/${roomId}/messages?limit=200`)
    if (predicate(messages)) return messages
    await sleep(250)
  }
  return null
}

async function waitIdle(port, roomId, timeoutMs = 40_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const state = await req(port, `/api/rooms/${roomId}/state`)
    if (!state.busy && state.gate === 'idle' && state.queuedCharacterIds.length === 0) return state
    await sleep(200)
  }
  return null
}

function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'ac-repair-repo-'))
  const git = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim()
  git(['init', '-q'])
  git(['config', 'user.email', 'repair@example.test'])
  git(['config', 'user.name', 'repair'])
  writeFileSync(join(repo, 'seed.txt'), 'seed\n')
  git(['add', 'seed.txt'])
  git(['commit', '-q', '-m', 'seed'])
  return { repo, git }
}

async function makeRoom(port, name, repo, reviewerPersona) {
  const room = await req(port, '/api/rooms', {
    method: 'POST',
    body: JSON.stringify({ name, workingDir: repo, maxHops: 6 }),
  })
  await req(port, `/api/rooms/${room.id}/characters`, {
    method: 'POST',
    body: JSON.stringify({
      name: '实现者',
      harness: 'custom',
      model: '',
      persona: '写文件',
      commandTemplate: 'echo done & echo x>>repair.txt',
      roles: ['implementer'],
      triggers: { onUser: true },
    }),
  })
  await req(port, `/api/rooms/${room.id}/characters`, {
    method: 'POST',
    body: JSON.stringify({
      name: '返修评审',
      harness: 'mock',
      model: 'mock',
      persona: reviewerPersona,
      roles: ['reviewer'],
      triggers: { onUser: false, mention: true },
    }),
  })
  await req(port, `/api/rooms/${room.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ blindReview: true }),
  })
  return room
}

const dataDir = mkdtempSync(join(tmpdir(), 'ac-repair-'))
const happy = makeRepo()
const capped = makeRepo()
const proc = await bootServer(dataDir)
try {
  const happyRoom = await makeRoom(proc.port, '返修房', happy.repo, 'MOCK-返修评审')
  await req(proc.port, `/api/rooms/${happyRoom.id}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content: '做一个改动' }),
  })
  const happyMessages = await waitMessages(
    proc.port,
    happyRoom.id,
    (messages) =>
      messages.some((message) => message.content.includes('已自动排入返修回合')) &&
      messages.filter((message) => message.authorType === 'character' && message.authorName === '返修评审').length >= 2,
  )
  await waitIdle(proc.port, happyRoom.id)
  const reviews = happyMessages?.filter(
    (message) => message.authorType === 'character' && message.authorName === '返修评审',
  )
  const implementers = happyMessages?.filter(
    (message) => message.authorType === 'character' && message.authorName === '实现者',
  )
  check('P1 CHANGES 后自动排入一次返修', Boolean(happyMessages?.some((m) => m.content.includes('返修回合（1/1）'))))
  check(
    'P1 返修后重新评审并 PASS',
    reviews?.length === 2 && reviews[0].content.includes('REVIEW: CHANGES') && reviews[1].content.includes('REVIEW: PASS'),
    JSON.stringify(reviews?.map((m) => m.content.slice(-20))),
  )
  check('P1 实现者跑了初始 + 返修两次', implementers?.length === 2, `实现者消息=${implementers?.length}`)
  const happyLog = happy.git(['log', '--pretty=%s'])
  check('P1 PASS 后自动提交', happyLog.includes('auto:'), happyLog)
  const { rounds } = await req(proc.port, `/api/rooms/${happyRoom.id}/rounds`)
  check(
    'P1 轮次报告记录 review PASS + commit',
    Boolean(rounds[0]?.commitHash) &&
      rounds[0].checks?.some((c) => c.kind === 'review' && c.verdict === 'pass') &&
      rounds[0].checks?.some((c) => c.kind === 'commit'),
    JSON.stringify(rounds[0]?.checks),
  )

  const cappedRoom = await makeRoom(proc.port, '返修上限房', capped.repo, 'MOCK-返修评审不改')
  await req(proc.port, `/api/rooms/${cappedRoom.id}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content: '做一个改动' }),
  })
  const cappedMessages = await waitMessages(
    proc.port,
    cappedRoom.id,
    (messages) =>
      messages.filter((message) => message.authorType === 'character' && message.authorName === '返修评审').length >= 2,
  )
  await waitIdle(proc.port, cappedRoom.id)
  const cappedReviews = cappedMessages?.filter(
    (message) => message.authorType === 'character' && message.authorName === '返修评审',
  )
  const cappedImplementers = cappedMessages?.filter(
    (message) => message.authorType === 'character' && message.authorName === '实现者',
  )
  check('P2 上限 1：只发生一次返修', cappedImplementers?.length === 2, `实现者消息=${cappedImplementers?.length}`)
  check(
    'P2 第二次 CHANGES 被门禁拦下，不再返修',
    cappedReviews?.length === 2 &&
      cappedMessages?.some((m) => m.authorType === 'system' && m.content.includes('REVIEW: CHANGES')),
    JSON.stringify(cappedReviews?.map((m) => m.content.slice(-20))),
  )
  check('P2 上限后没有自动提交', capped.git(['log', '--pretty=%s']) === 'seed')
} finally {
  await killServer(proc)
}

if (failed) {
  console.log(`\n${failed} case(s) failed`)
  process.exit(1)
}
console.log('\nOK: auto-repair contract passed')
process.exit(0)
