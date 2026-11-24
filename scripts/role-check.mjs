/**
 * B14 role routing contract:
 *   R1  reviewer selection — designated wins, otherwise reviewer-tagged,
 *       otherwise any eligible; author/same-harness/summarizer excluded.
 *   R2  default responder — no-@ user messages go to the configured character,
 *       and fall back to the first enabled one when unset.
 *
 *   node scripts/role-check.mjs
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

// --- R1: pure reviewer selection -----------------------------------------
const { pickReviewer } = await import('../server/reviewers.ts')
const mk = (id, harness, roles = [], extra = {}) => ({
  id,
  name: id,
  harness,
  roles,
  enabled: extra.enabled ?? true,
  triggers: { onRoundEnd: extra.onRoundEnd ?? false },
})
const author = { id: 'impl', harness: 'claude' }
const characters = [
  mk('impl', 'claude', ['implementer']),
  mk('review-designated', 'codex', ['reviewer']),
  mk('review-pool', 'cannbot', ['reviewer']),
  mk('assistant', 'dsh', ['assistant']),
  mk('summarizer', 'mock', ['summarizer'], { onRoundEnd: true }),
]

const designated = pickReviewer({ characters, designatedId: 'review-designated', author })
check('R1 指定 reviewer 优先', designated.reviewer?.id === 'review-designated')

const pool = pickReviewer({ characters, designatedId: null, author })
check('R1 无指定时从审查标签里选', pool.reviewer?.id === 'review-designated')

const selfDesignated = pickReviewer({ characters, designatedId: 'impl', author })
check('R1 指定自己 → 拒绝', selfDesignated.reviewer === null && selfDesignated.reason === 'designated-ineligible')

const sameHarness = pickReviewer({ characters: [mk('x', 'claude', ['reviewer'])], designatedId: null, author })
check('R1 与实现者同 harness → 无候选', sameHarness.reviewer === null && sameHarness.reason === 'no-candidate')

const fallback = pickReviewer({ characters: [mk('impl', 'claude'), mk('plain', 'codex')], designatedId: null, author })
check('R1 无角色标签时回退到任意合格角色', fallback.reviewer?.id === 'plain')

const summarizerOnly = pickReviewer({
  characters: [mk('impl', 'claude'), mk('sum', 'mock', ['reviewer'], { onRoundEnd: true })],
  designatedId: null,
  author,
})
check('R1 总结角色不参与 reviewer', summarizerOnly.reviewer === null)

// --- R1b: independent CHANGES + stale reviewer resolution -----------------
const { isIndependentReviewerVerdict, resolveRoundReviewer } = await import('../server/reviewers.ts')
const verdict = (id, harness) => ({ id, harness })
check(
  'R1b 独立 reviewer 的 CHANGES 才算数（不同 harness + 身份匹配）',
  isIndependentReviewerVerdict({
    verdictAuthor: verdict('review-designated', 'codex'),
    changedAuthor: verdict('impl', 'claude'),
    designatedId: 'review-designated',
    poolReviewerId: null,
  }) &&
    isIndependentReviewerVerdict({
      verdictAuthor: verdict('review-pool', 'cannbot'),
      changedAuthor: verdict('impl', 'claude'),
      designatedId: null,
      poolReviewerId: 'review-pool',
    }),
)
check(
  'R1b 同 harness / 第三方 / 无 reviewer 的 CHANGES 不触发返修',
  !isIndependentReviewerVerdict({
    verdictAuthor: verdict('same', 'claude'),
    changedAuthor: verdict('impl', 'claude'),
    designatedId: 'same',
    poolReviewerId: null,
  }) &&
    !isIndependentReviewerVerdict({
      verdictAuthor: verdict('third', 'cannbot'),
      changedAuthor: verdict('impl', 'claude'),
      designatedId: 'review-designated',
      poolReviewerId: null,
    }) &&
    !isIndependentReviewerVerdict({
      verdictAuthor: verdict('x', 'codex'),
      changedAuthor: verdict('impl', 'claude'),
      designatedId: null,
      poolReviewerId: null,
    }),
)

const staleDisabled = resolveRoundReviewer({
  designatedId: null,
  poolReviewer: { id: 'review-pool', name: '旧名', harness: 'cannbot' },
  characters: [mk('review-pool', 'cannbot', ['reviewer'], { enabled: false })],
})
check('R1b 池 reviewer 被停用 → 门禁 fail closed', staleDisabled.eligible === false && staleDisabled.reviewer?.id === 'review-pool')
const staleMissing = resolveRoundReviewer({
  designatedId: null,
  poolReviewer: { id: 'gone', name: '已删', harness: 'cannbot' },
  characters: [],
})
check('R1b 池 reviewer 被删除 → 门禁 fail closed', staleMissing.eligible === false)
const reharnessed = resolveRoundReviewer({
  designatedId: null,
  poolReviewer: { id: 'review-pool', name: '旧名', harness: 'cannbot' },
  characters: [mk('review-pool', 'claude', ['reviewer'])],
})
check('R1b 门禁读取 reviewer 当前 harness', reharnessed.reviewer?.harness === 'claude' && reharnessed.eligible)

// --- R2: default responder (real server) ---------------------------------
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

async function waitMessages(port, roomId, predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const { messages } = await req(port, `/api/rooms/${roomId}/messages?limit=100`)
    if (predicate(messages)) return messages
    await sleep(200)
  }
  return null
}

const dataDir = mkdtempSync(join(tmpdir(), 'ac-role-'))
const workDir = mkdtempSync(join(tmpdir(), 'ac-role-work-'))
const proc = await bootServer(dataDir)
try {
  const room = await req(proc.port, '/api/rooms', {
    method: 'POST',
    body: JSON.stringify({ name: '路由房', workingDir: workDir, maxHops: 2 }),
  })
  const first = await req(proc.port, `/api/rooms/${room.id}/characters`, {
    method: 'POST',
    body: JSON.stringify({ name: '甲', harness: 'mock', model: 'mock', persona: '甲', triggers: { onUser: true } }),
  })
  const second = await req(proc.port, `/api/rooms/${room.id}/characters`, {
    method: 'POST',
    body: JSON.stringify({
      name: '乙',
      harness: 'mock',
      model: 'mock',
      persona: '乙',
      roles: ['assistant'],
      triggers: { onUser: false, mention: true },
    }),
  })
  check('R3 POST 角色时 roles 落库', JSON.stringify(second.roles) === JSON.stringify(['assistant']), JSON.stringify(second.roles))
  const patched = await req(proc.port, `/api/characters/${second.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ roles: ['reviewer', 'assistant'] }),
  })
  check(
    'R3 PATCH 角色时 roles 落库',
    JSON.stringify(patched.roles) === JSON.stringify(['reviewer', 'assistant']),
    JSON.stringify(patched.roles),
  )
  const badRoles = await fetch(`http://127.0.0.1:${proc.port}/api/rooms/${room.id}/characters`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: '非法角色', harness: 'mock', roles: ['reviewer', 'typo'] }),
  })
  check('R3 未知角色标签 → 400', badRoles.status === 400, `status=${badRoles.status}`)
  await req(proc.port, `/api/rooms/${room.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ defaultResponderId: second.id, reviewerCharacterId: first.id, blindReview: false }),
  })
  await req(proc.port, `/api/rooms/${room.id}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content: '没有 @ 的消息' }),
  })
  const firstRound = await waitMessages(proc.port, room.id, (messages) =>
    messages.some((message) => message.authorType === 'character'),
  )
  const speakers = firstRound?.filter((message) => message.authorType === 'character').map((message) => message.authorName)
  check('R2 无 @ 时默认响应者接手', speakers?.length === 1 && speakers[0] === '乙', JSON.stringify(speakers))

  await req(proc.port, `/api/rooms/${room.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ defaultResponderId: null }),
  })
  await req(proc.port, `/api/rooms/${room.id}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content: '第二条没有 @ 的消息' }),
  })
  const secondRound = await waitMessages(
    proc.port,
    room.id,
    (messages) => messages.filter((message) => message.authorType === 'character').length >= 2,
  )
  const all = secondRound?.filter((message) => message.authorType === 'character').map((message) => message.authorName)
  check('R2 清空后回退到第一个启用角色', all?.length === 2 && all[0] === '乙' && all[1] === '甲', JSON.stringify(all))

  // Blind config deadlock: reviewer pool goes stale while blind is on; the
  // user must still be able to turn it off in one PATCH.
  await req(proc.port, `/api/rooms/${room.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ reviewerCharacterId: null, blindReview: false }),
  })
  const enabledByPool = await req(proc.port, `/api/rooms/${room.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ blindReview: true }),
  })
  check('R4 角色池可单独开启盲审', enabledByPool.blindReview === true)
  await req(proc.port, `/api/characters/${second.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ roles: [] }),
  })
  const closed = await req(proc.port, `/api/rooms/${room.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ blindReview: false }),
  })
  check('R4 池失效后仍能关闭盲审', closed.blindReview === false)
  const reopen = await fetch(`http://127.0.0.1:${proc.port}/api/rooms/${room.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ blindReview: true }),
  })
  check('R4 无合格 reviewer 时重新开启 → 400', reopen.status === 400, `status=${reopen.status}`)

  // Deleting a character must clear a room's default-responder pointer.
  await req(proc.port, `/api/rooms/${room.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ defaultResponderId: second.id }),
  })
  await req(proc.port, `/api/characters/${second.id}`, { method: 'DELETE' })
  const bootstrap = await req(proc.port, '/api/bootstrap')
  const roomAfterDelete = bootstrap.rooms.find((item) => item.id === room.id)
  check(
    'R2 删除默认响应者后房间指针清空',
    roomAfterDelete?.defaultResponderId === null,
    JSON.stringify(roomAfterDelete?.defaultResponderId),
  )
} finally {
  await killServer(proc)
}

if (failed) {
  console.log(`\n${failed} case(s) failed`)
  process.exit(1)
}
console.log('\nOK: role routing passed')
process.exit(0)
