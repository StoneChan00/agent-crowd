/**
 * P0-1 session-continuity contract: sessions table + incremental prompt +
 * resume argv + fallback — as specified in workspace/p0-plan.md.
 *
 *   node scripts/session-check.mjs
 *
 * Layers:
 *   P1  incremental prompt (pure): post-cursor messages only, pre-cursor
 *       absent, no-new-messages copy, since=0 ≡ full, resumed title note,
 *       default call unchanged, same-millisecond tiebreak, cursor helper (9)
 *   P1b overflow fold (pure, B01): newest increment always renders, the
 *       rest ride along as a deterministic fold (count + oldest excerpts,
 *       no model), the cursor advances over what was represented — next
 *       round's increment is empty; the 32k guard squeezes the transcript
 *       budget instead of slicing the transcript away; fold accounting:
 *       overflow disclosed in the header only, foldedCount = dropped +
 *       beyond-window, window-overflow-with-fitting-fetch (15)
 *   P2  db isolation & invalidation: two rooms never cross sessions;
 *       delete character / clear messages / harness drift / model drift /
 *       delete room each sweep the row (11)
 *   P3  resume argv (pure): every declared adapter's resumeArgs('abc')
 *       asserted exactly (order included); undeclared adapters undefined;
 *       full assembled argv for claude/codex/opencode/cannbot — flags and
 *       positions pinned, the codex resume sandbox parity lives here (17)
 *   P4  integration: two mock rounds → sessions.turns=2, 2nd message
 *       meta.resume=true, RESUME-OK line count proves old messages stayed
 *       OUT of the prompt (7)
 *   P4b mid-round message: a message posted while the round-1 CLI is still
 *       streaming must ship in round 2's increment — locks the cursor
 *       against Date.now()-style regressions (7)
 *   P4c integration (B01): resumed turns fetch by cursor — >80 increments
 *       all reach the prompt, 4k floods fold end-to-end, floods beyond the
 *       fetch window ride along as a fold count while the cursor still
 *       advances (8)
 *   P5  fallback: preseeded bogus session → resume dies → silent full
 *       rerun, no user-facing failure message, session row replaced (5)
 *   P6  kill switch: AC_SESSION_RESUME=0 → adapter gets no resume, no
 *       meta.resume — the switch gates the RIDE, not the bookkeeping (4)
 *   P7  real-CLI smoke: MANUAL and plan-mandated (claude, two rounds) —
 *       not automatable offline; runs as a separate manual step and its
 *       outcome belongs in the delivery report, not this script.
 *
 * Server scenarios boot real servers (AC_DATA_DIR on temp dirs, mock
 * harness only); pure layers import the real modules — never re-typed
 * constants. Output: `OK: session contract passed (n/n)`; non-zero exit on
 * any failure.
 */
import { spawn } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { buildClaudeArgs } from '../server/harnesses/claude.ts'
import { buildCodexArgs } from '../server/harnesses/codex.ts'
import { buildDshArgs } from '../server/harnesses/dsh.ts'
import { buildOpencodeLikeArgs } from '../server/harnesses/opencodeLike.ts'
import { getAdapter } from '../server/harnesses/index.ts'
import {
  buildTurnPrompt,
  buildTurnPromptDetailed,
  MAX_TOTAL_PROMPT,
  nextSessionCursor,
  TRANSCRIPT_CHAR_BUDGET,
} from '../server/prompt.ts'
import { DEFAULT_TRIGGERS } from '../server/types.ts'

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

/** Boot a real server; resolve once /api/health answers. `extraEnv` rides the child env (P6's kill switch). */
async function bootServer(dataDir, extraEnv = {}) {
  let lastLog = ''
  for (let attempt = 0; attempt < 4; attempt++) {
    const port = freePort()
    const proc = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'server', 'index.ts')], {
      cwd: ROOT,
      env: { ...process.env, AC_DATA_DIR: dataDir, AC_PORT: String(port), ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    servers.push(proc)
    let log = ''
    proc.stdout.on('data', (chunk) => (log += chunk))
    proc.stderr.on('data', (chunk) => (log += chunk))
    const exitCode = new Promise((resolve) => proc.once('exit', (code) => resolve(code)))
    const deadline = Date.now() + 30_000
    let dead = false
    while (Date.now() < deadline && !dead) {
      const outcome = await Promise.race([
        req(port, '/api/health')
          .then((health) => ({ health, state: 'up' }))
          .catch(() => ({ health: null, state: 'wait' })),
        exitCode.then((code) => ({ health: null, state: `dead:${code}` })),
      ])
      if (outcome.state === 'up') return { port, pid: proc.pid, proc, health: outcome.health }
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
      /* transient poll gap */
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
 * Live SSE subscription (P4b): streaming events as they arrive, same frame
 * parsing as sop-check's S9b watcher. The first `delta` of kind 'text' is
 * the deterministic "the turn's prompt snapshot has already been taken"
 * signal — adapter.run() only starts after db.listMessages, so a message
 * posted after that delta can never leak into the running turn's prompt.
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

/* ------------------------------------------------------------------ sqlite */

function withDb(dataDir, fn) {
  const handle = new DatabaseSync(join(dataDir, 'agent-crowd.db'))
  try {
    return fn(handle)
  } finally {
    handle.close()
  }
}

const sessionRows = (dataDir, where = '1=1', ...args) =>
  withDb(dataDir, (handle) => handle.prepare(`select * from sessions where ${where}`).all(...args))

const turnRows = (dataDir, where, ...args) =>
  withDb(dataDir, (handle) => handle.prepare(`select * from turns where ${where} order by started_at asc`).all(...args))

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

async function makeCharacter(port, roomId, name, persona = '会话测试角色') {
  return req(port, `/api/rooms/${roomId}/characters`, {
    method: 'POST',
    body: JSON.stringify({ name, harness: 'mock', model: 'mock', persona, triggers: ON_USER_ONLY }),
  })
}

async function postMessage(port, roomId, content) {
  return req(port, `/api/rooms/${roomId}/messages`, { method: 'POST', body: JSON.stringify({ content }) })
}

const characterMessages = (messages, authorName) =>
  messages.filter((message) => message.authorType === 'character' && message.authorName === authorName)

const systemNotices = (messages, keyword) =>
  messages.filter((message) => message.authorType === 'system' && message.content.includes(keyword))

/* ----------------------------------------------- P1 incremental prompt (pure) */

function scenarioIncrementalPrompt() {
  const room = {
    id: 'r1', name: '会话测试', topic: '', workingDir: 'D:/tmp', maxHops: 6, verifyCommand: '', createdAt: 0,
  }
  const character = {
    id: 'c1', roomId: 'r1', name: '甲', aliases: [], avatar: '', color: '',
    harness: 'mock', model: 'mock', persona: '测试人设', cwd: '', triggers: DEFAULT_TRIGGERS,
    commandTemplate: '', autoApprove: true, enabled: true, identityId: null, presetId: null, createdAt: 0,
  }
  const msg = (id, content, at, seq, authorType = 'user') => ({
    id,
    roomId: 'r1',
    authorType,
    characterId: authorType === 'character' ? 'c1' : null,
    authorName: authorType === 'user' ? '我' : '甲',
    authorAvatar: '',
    color: '',
    content,
    meta: null,
    createdAt: at,
    seq,
  })
  const messages = [
    msg('m1', '旧消息：第一轮需求是红鲱鱼方案', 100, 11),
    msg('m2', '甲的旧回复：收到', 200, 12, 'character'),
    msg('m3', '新消息：第二轮指令是蓝鲸号方案', 300, 13),
    // Same-millisecond siblings of m3 (P0-1 review): a bare createdAt cursor
    // swallows exactly these — seq is the tiebreaker.
    msg('m4', '同毫秒第一条：海豚号', 300, 14),
    msg('m5', '同毫秒第二条：海鸥号', 300, 15),
  ]
  const build = (opts) =>
    buildTurnPrompt({ room, character, characters: [character], messages, cwd: 'D:/tmp', ...opts })

  const resumed = build({ since: { at: 200, seq: 0 }, resumed: true })
  check(
    'P1 游标后的新消息进入 prompt',
    resumed.includes('蓝鲸号') && resumed.includes('海豚号') && resumed.includes('海鸥号'),
    resumed.slice(-200),
  )
  check('P1 游标前的旧消息不进入 prompt', !resumed.includes('红鲱鱼'))
  check('P1 续传标题注明增量语义', resumed.includes('（以下是你上次发言之后的新消息；更早内容已在同一会话上下文中）'))

  const empty = build({ since: { at: 300, seq: 15 }, resumed: true })
  check('P1 无新消息时写（无新消息）', empty.includes('（无新消息）'), empty.slice(-200))

  const since0 = build({ since: { at: 0, seq: 0 }, resumed: true })
  check('P1 since=0 等价全量（全部消息可见）', since0.includes('红鲱鱼') && since0.includes('蓝鲸号'))

  const full = build({})
  check(
    'P1 默认调用行为不变（全量 + 无续传标题）',
    full.includes('红鲱鱼') && full.includes('蓝鲸号') && !full.includes('上次发言之后的新消息'),
  )

  // The same-millisecond regression (P0-1 review): cursor exactly at m3
  // (seq 13) — the old bare createdAt filter would skip BOTH m4 and m5.
  const afterM3 = build({ since: { at: 300, seq: 13 }, resumed: true })
  check(
    'P1 同毫秒后到的消息不被裸时间游标吞掉',
    afterM3.includes('海豚号') && afterM3.includes('海鸥号') && !afterM3.includes('蓝鲸号'),
    afterM3.slice(-200),
  )
  // Cursor at m4: only m5 stays visible — the tiebreak is per-message.
  const afterM4 = build({ since: { at: 300, seq: 14 }, resumed: true })
  check(
    'P1 游标在同毫秒内精确到该条之后',
    afterM4.includes('海鸥号') && !afterM4.includes('海豚号') && !afterM4.includes('蓝鲸号'),
    afterM4.slice(-200),
  )

  check(
    'P1 nextSessionCursor 取最新可见消息、空表回落游标',
    JSON.stringify(nextSessionCursor(messages, { at: 200, seq: 0 })) === JSON.stringify({ at: 300, seq: 15 }) &&
      JSON.stringify(nextSessionCursor(messages, { at: 0, seq: 0 })) === JSON.stringify({ at: 300, seq: 15 }) &&
      JSON.stringify(nextSessionCursor([], { at: 200, seq: 0 })) === JSON.stringify({ at: 200, seq: 0 }),
  )
}

/* --------------------------- P1b fold: overflowing increments (pure, B01) */

function scenarioFoldPrompt() {
  const room = {
    id: 'r2', name: '折叠测试', topic: '', workingDir: 'D:/tmp', maxHops: 6, verifyCommand: '', createdAt: 0,
  }
  const character = {
    id: 'c1', roomId: 'r2', name: '甲', aliases: [], avatar: '', color: '',
    harness: 'mock', model: 'mock', persona: '测试人设', cwd: '', triggers: DEFAULT_TRIGGERS,
    commandTemplate: '', autoApprove: true, enabled: true, identityId: null, presetId: null, createdAt: 0,
  }
  const mark = (tag) => `⟪${tag}⟫`
  const msg = (id, content, at, seq) => ({
    id, roomId: 'r2', authorType: 'user', characterId: null, authorName: '我', authorAvatar: '', color: '',
    content, meta: null, createdAt: at, seq,
  })
  // 5 × ~4k increment messages (B01): the 18k budget admits four — the fifth
  // used to be dropped by a bare `break` while the cursor still advanced to
  // the newest, a permanent skip on the resume chain.
  const big = (i, at, seq) => msg(`f${i}`, `${mark(`FOLD-${i}`)}${'x'.repeat(3_900)}`, at, seq)
  const messages = [big(0, 1_000, 20), big(1, 1_100, 21), big(2, 1_200, 22), big(3, 1_300, 23), big(4, 1_400, 24)]
  const build = (opts) =>
    buildTurnPromptDetailed({ room, character, characters: [character], messages, cwd: 'D:/tmp', ...opts })

  const since = { at: 900, seq: 0 }
  const built = build({ since, resumed: true })
  check('P1b 溢出增量：最新消息完整在场（触发不被挤出）', built.prompt.includes(mark('FOLD-4')), built.prompt.slice(-300))
  check(
    'P1b 溢出增量：放不下的旧增量进确定性折叠（计数 1）',
    built.prompt.includes('〔已折叠 1 条'),
    built.prompt.slice(-900),
  )
  check('P1b 溢出增量：折叠带最旧消息的开头摘录', built.prompt.includes(mark('FOLD-0')), built.prompt.slice(-900))
  check(
    'P1b 溢出增量：游标推到最新（折叠消费，不跳过）',
    JSON.stringify(built.nextCursor) === JSON.stringify({ at: 1_400, seq: 24 }) && built.foldedCount === 1,
    JSON.stringify(built.nextCursor),
  )
  const sectionStart = built.prompt.indexOf('【最近的群聊记录】')
  const sectionEnd = built.prompt.indexOf('\n【现在轮到你】')
  const bodyLen = built.prompt.slice(sectionStart, sectionEnd).split('\n').slice(1).join('\n').length
  check(
    'P1b 溢出增量：折叠+渲染不超 transcript 预算',
    bodyLen <= TRANSCRIPT_CHAR_BUDGET,
    `body=${bodyLen}`,
  )
  const next = build({ since: built.nextCursor, resumed: true })
  check(
    'P1b 溢出增量：下轮增量为空（折叠已消费，不重复膨胀）',
    next.prompt.includes('（无新消息）') && !next.prompt.includes('〔已折叠') && !next.prompt.includes(mark('FOLD-0')),
    next.prompt.slice(-200),
  )

  // 32k squeeze (B01, same root cause as the review's non-blocking 3): a
  // giant-but-fitting persona shrinks the transcript budget instead of
  // triggering the slice — newest + fold stay, no truncation marker.
  const squeezed = buildTurnPromptDetailed({
    room,
    character: { ...character, persona: 'P'.repeat(20_000) },
    characters: [{ ...character, persona: 'P'.repeat(20_000) }],
    messages,
    cwd: 'D:/tmp',
    since,
    resumed: true,
  })
  check(
    'P1b 32k 挤压：预算收缩而不是截断',
    squeezed.prompt.length <= MAX_TOTAL_PROMPT + 30 && !squeezed.prompt.includes('…（上下文过长已截断）'),
    `len=${squeezed.prompt.length}`,
  )
  check('P1b 32k 挤压：最新消息仍在（触发不丢）', squeezed.prompt.includes(mark('FOLD-4')))
  check('P1b 32k 挤压：收缩放不下的进折叠', /〔已折叠 [1-9]\d* 条/.test(squeezed.prompt), squeezed.prompt.slice(-600))

  // 32k extreme: a persona at the ceiling itself forces the last-resort
  // slice — which now cuts the HEAD, never the transcript. The old slice
  // took the header tail, i.e. exactly the newest transcript lines.
  const extreme = buildTurnPromptDetailed({
    room,
    character: { ...character, persona: 'P'.repeat(MAX_TOTAL_PROMPT) },
    characters: [{ ...character, persona: 'P'.repeat(MAX_TOTAL_PROMPT) }],
    messages,
    cwd: 'D:/tmp',
    since,
    resumed: true,
  })
  check(
    'P1b 32k 极端：截断兜底仍不超上限',
    extreme.prompt.length <= MAX_TOTAL_PROMPT + 30 && extreme.prompt.includes('…（上下文过长已截断）'),
    `len=${extreme.prompt.length}`,
  )
  check(
    'P1b 32k 极端：截断保住最新消息与折叠（不再切 transcript 尾部）',
    extreme.prompt.includes(mark('FOLD-4')) && /〔已折叠 [1-9]\d* 条/.test(extreme.prompt),
    extreme.prompt.slice(-600),
  )

  // Fold accounting (B01 review, non-blocking 2/4/6): overflow rides in the
  // header's own disclosure — the "其余 N 条未摘录" line counts DROPPED
  // messages only; foldedCount = dropped + beyond-window; and a flood that
  // fits whole still leaves a count line when part of it sat beyond the
  // fetch window.
  // (a) 8×4k + overflow 3: four dropped, all excerpted → no rest line, the
  //     header alone discloses the 3 window-outside ones.
  const big8 = (i) => msg(`g${i}`, `${mark(`GAP-${i}`)}${'g'.repeat(3_900)}`, 2_000 + i * 100, 40 + i)
  const messages8 = Array.from({ length: 8 }, (_, i) => big8(i))
  const withOverflow = buildTurnPromptDetailed({
    room,
    character,
    characters: [character],
    messages: messages8,
    cwd: 'D:/tmp',
    since: { at: 1_900, seq: 0 },
    resumed: true,
    foldOverflow: 3,
  })
  check(
    'P1b 溢出账目：摘录齐全不出现「未摘录」行（窗口外只在 header 披露）',
    !withOverflow.prompt.includes('未摘录') &&
      withOverflow.prompt.includes('已折叠 7 条') &&
      withOverflow.prompt.includes('另有 3 条在取回窗口之外仅计数'),
    withOverflow.prompt.slice(-900),
  )
  check('P1b 溢出账目：foldedCount = dropped + 窗口外', withOverflow.foldedCount === 7, `foldedCount=${withOverflow.foldedCount}`)

  // (b) fetched all fit + window overflow: count line only, originals
  //     render verbatim, cursor still advances to the newest.
  const fitting = buildTurnPromptDetailed({
    room,
    character,
    characters: [character],
    messages: [msg('h0', '短消息一', 3_000, 50), msg('h1', '短消息二', 3_100, 51)],
    cwd: 'D:/tmp',
    since: { at: 2_900, seq: 0 },
    resumed: true,
    foldOverflow: 7,
  })
  check(
    'P1b 窗口外但 fetched 全装得下：仅计数行、原文照常渲染',
    fitting.prompt.includes('〔已折叠 7 条较早的新消息，均在取回窗口之外，仅计数〕') &&
      fitting.prompt.includes('短消息一') &&
      fitting.prompt.includes('短消息二'),
    fitting.prompt.slice(-400),
  )
  check(
    'P1b 窗口外但 fetched 全装得下：游标推到最新、foldedCount 计入窗口外',
    JSON.stringify(fitting.nextCursor) === JSON.stringify({ at: 3_100, seq: 51 }) && fitting.foldedCount === 7,
    JSON.stringify({ cursor: fitting.nextCursor, foldedCount: fitting.foldedCount }),
  )
}

/* --------------------------------------- P2 db isolation & invalidation (server) */

async function scenarioIsolation() {
  const dir = mkdtempSync(join(tmpdir(), 'ac-session-p2-'))
  tempDirs.push(dir)
  const work1 = mkdtempSync(join(tmpdir(), 'ac-session-p2w1-'))
  tempDirs.push(work1)
  const work2 = mkdtempSync(join(tmpdir(), 'ac-session-p2w2-'))
  tempDirs.push(work2)

  const server = await bootServer(dir)
  const port = server.port

  const room1 = await makeRoom(port, 'p2-房间一', work1)
  const a1 = await makeCharacter(port, room1.id, '甲一')
  const b1 = await makeCharacter(port, room1.id, '乙一')
  const room2 = await makeRoom(port, 'p2-房间二', work2)
  const a2 = await makeCharacter(port, room2.id, '甲二')
  const b2 = await makeCharacter(port, room2.id, '乙二')

  await postMessage(port, room1.id, '@all 大家好')
  await postMessage(port, room2.id, '@all 大家好')
  const drained =
    (await waitIdle(port, room1.id, 40_000)) && (await waitIdle(port, room2.id, 40_000))
  check('P2 两房四角色全部跑完', drained)

  const rows = sessionRows(dir)
  check('P2 sessions 恰 4 行（2 房间、2 角色各一行）', rows.length === 4, JSON.stringify(rows.map((r) => [r.room_id, r.character_id, r.session_id])))
  const pairs = new Set(rows.map((row) => `${row.room_id}:${row.character_id}`))
  check(
    'P2 行与 (room, character) 一一对齐',
    pairs.has(`${room1.id}:${a1.id}`) && pairs.has(`${room1.id}:${b1.id}`) &&
      pairs.has(`${room2.id}:${a2.id}`) && pairs.has(`${room2.id}:${b2.id}`),
  )
  check('P2 房间间 session 互不串（4 个 session_id 互不相同）', new Set(rows.map((row) => row.session_id)).size === 4)

  // Delete a character: its row must go with it, the sibling's must stay.
  await req(port, `/api/characters/${b1.id}`, { method: 'DELETE' })
  check(
    'P2 删除角色 → 其 session 行消失（同房另一角色保留）',
    sessionRows(dir, 'room_id = ? and character_id = ?', room1.id, b1.id).length === 0 &&
      sessionRows(dir, 'room_id = ? and character_id = ?', room1.id, a1.id).length === 1,
  )

  // Clear a room's messages: the cursor pointed into a transcript that no
  // longer exists — the whole room's rows must go.
  await req(port, `/api/rooms/${room2.id}/clear`, { method: 'POST' })
  check('P2 清空消息 → 房间全部 session 行消失', sessionRows(dir, 'room_id = ?', room2.id).length === 0)

  // Model drift (P0-1 review): same harness, different brain — the row must
  // go, exactly like harness drift.
  await req(port, `/api/characters/${a1.id}`, { method: 'PATCH', body: JSON.stringify({ model: 'drifted-model' }) })
  check(
    'P2 model 变化 → session 行消失',
    sessionRows(dir, 'room_id = ? and character_id = ?', room1.id, a1.id).length === 0,
  )

  // Re-establish a row so the harness-drift check below still proves
  // CLEARING (the re-run itself doubles as a full-replay exercise — there is
  // no row to resume after the model drift).
  await postMessage(port, room1.id, '甲一请再报一次')
  await waitIdle(port, room1.id, 40_000)
  check(
    'P2 漂移清行后重跑恢复 session 行（全量重放成功）',
    sessionRows(dir, 'room_id = ? and character_id = ?', room1.id, a1.id).length === 1,
  )

  // Harness drift: the stored session belongs to a different agent now.
  await req(port, `/api/characters/${a1.id}`, { method: 'PATCH', body: JSON.stringify({ harness: 'dsh' }) })
  check('P2 harness 变化 → session 行消失', sessionRows(dir, 'room_id = ? and character_id = ?', room1.id, a1.id).length === 0)

  // Room deletion sweeps its rows too.
  const room3 = await makeRoom(port, 'p2-房间三', work1)
  const c3 = await makeCharacter(port, room3.id, '丙三')
  await postMessage(port, room3.id, '丙三请发言')
  await waitIdle(port, room3.id, 40_000)
  check('P2 删除前房间三有 session 行', sessionRows(dir, 'room_id = ? and character_id = ?', room3.id, c3.id).length === 1)
  await req(port, `/api/rooms/${room3.id}`, { method: 'DELETE' })
  check('P2 删除房间 → session 行消失', sessionRows(dir, 'room_id = ?', room3.id).length === 0)
}

/* ---------------------------------------------- P3 resume argv (pure) */

function scenarioResumeArgs() {
  const declared = [
    ['claude', ['--resume', 'abc']],
    ['codex', ['exec', 'resume', 'abc']],
    ['opencode', ['--session', 'abc']],
    ['cannbot', ['--session', 'abc']],
    ['mock', ['--session', 'abc']],
  ]
  for (const [id, expected] of declared) {
    const actual = getAdapter(id).resumeArgs?.('abc')
    check(
      `P3 ${id} resumeArgs('abc') 精确（含顺序）`,
      JSON.stringify(actual) === JSON.stringify(expected),
      `实际 ${JSON.stringify(actual)}`,
    )
  }
  for (const id of ['dsh', 'hermes', 'custom']) {
    check(`P3 ${id} 未声明 resume 能力（返回 undefined）`, getAdapter(id).resumeArgs === undefined)
  }
}

/**
 * Full assembled argv, not just the resume fragment (P0-1 review): the
 * codex resume branch dropping its read-only sandbox slipped through every
 * fragment assertion — the assembly point itself is what has to be pinned,
 * flags and positions included.
 */
function scenarioFullArgv() {
  const P = 'PROMPT-样例'
  const WD = 'D:/work'
  const eq = (name, actual, expected) =>
    check(name, JSON.stringify(actual) === JSON.stringify(expected), `实际 ${JSON.stringify(actual)}`)

  // codex — 2×2 matrix (fresh/resume × autoApprove) + empty model.
  eq(
    'P3 codex 全量 argv（只读沙箱，argsPrefix 前置）',
    buildCodexArgs({ argsPrefix: ['node', 'wrap.js'], autoApprove: false, model: 'gpt-5', prompt: P }),
    ['node', 'wrap.js', 'exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only', '--model', 'gpt-5', P],
  )
  eq(
    'P3 codex 续传 argv 保住只读沙箱（-c 通道，非 autoApprove）',
    buildCodexArgs({ argsPrefix: [], resumeId: 'sid-9', autoApprove: false, model: 'gpt-5', prompt: P }),
    ['exec', 'resume', 'sid-9', '--json', '--skip-git-repo-check', '-c', 'sandbox_mode=read-only', '--model', 'gpt-5', P],
  )
  eq(
    'P3 codex 全量 argv（autoApprove 走 bypass，无沙箱）',
    buildCodexArgs({ argsPrefix: [], autoApprove: true, model: 'gpt-5', prompt: P }),
    ['exec', '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', '--model', 'gpt-5', P],
  )
  eq(
    'P3 codex 续传 argv（autoApprove 走 bypass，无 -c）',
    buildCodexArgs({ argsPrefix: [], resumeId: 'sid-9', autoApprove: true, model: 'gpt-5', prompt: P }),
    ['exec', 'resume', 'sid-9', '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', '--model', 'gpt-5', P],
  )
  eq(
    'P3 codex 空 model 不产 --model',
    buildCodexArgs({ argsPrefix: [], autoApprove: false, model: '  ', prompt: P }),
    ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only', P],
  )

  // claude
  eq(
    'P3 claude 全量 argv（默认权限模式）',
    buildClaudeArgs({ argsPrefix: [], autoApprove: false, model: 'sonnet', prompt: P }),
    ['-p', P, '--output-format', 'stream-json', '--verbose', '--model', 'sonnet', '--permission-mode', 'default'],
  )
  eq(
    'P3 claude 续传 argv（skip-permissions）',
    buildClaudeArgs({ argsPrefix: [], resumeId: 'sid-7', autoApprove: true, model: 'sonnet', prompt: P }),
    ['-p', P, '--output-format', 'stream-json', '--verbose', '--resume', 'sid-7', '--model', 'sonnet', '--dangerously-skip-permissions'],
  )

  // opencode-like — one adapter, two auto-approve flags.
  eq(
    'P3 opencode 续传 argv（--session，非 autoApprove 无额外旗标）',
    buildOpencodeLikeArgs({ argsPrefix: [], resumeId: 'sid-3', autoApprove: false, autoApproveFlag: '--auto', model: 'qwen3-max', cwd: WD, prompt: P }),
    ['run', '--format', 'json', '--session', 'sid-3', '--model', 'qwen3-max', '--dir', WD, P],
  )
  eq(
    'P3 cannbot 续传 argv（--session + 其 bypass 旗标）',
    buildOpencodeLikeArgs({ argsPrefix: [], resumeId: 'sid-3', autoApprove: true, autoApproveFlag: '--dangerously-skip-permissions', model: '', cwd: WD, prompt: P }),
    ['run', '--format', 'json', '--session', 'sid-3', '--dangerously-skip-permissions', '--dir', WD, P],
  )

  // dsh — autoApprove selects the danger-full-access permission preset (the
  // flag-less default is headless's own workspace-write + ask).
  eq(
    'P3 dsh 全量 argv（autoApprove → danger-full-access 预设）',
    buildDshArgs({ argsPrefix: ['node', 'bin.js'], patchPath: 'C:/rt/patch.yml', autoApprove: true, prompt: P }),
    ['node', 'bin.js', '--profile', 'headless', '--patch', 'C:/rt/patch.yml', '--permission-mode', 'danger-full-access', P],
  )
  eq(
    'P3 dsh 全量 argv（非 autoApprove 无权限旗标，保持 headless 默认沙箱）',
    buildDshArgs({ argsPrefix: [], patchPath: 'C:/rt/patch.yml', autoApprove: false, prompt: P }),
    ['--profile', 'headless', '--patch', 'C:/rt/patch.yml', P],
  )
}

/* ------------------------------------------ P4 integration: two mock rounds */

async function scenarioIntegration() {
  const dir = mkdtempSync(join(tmpdir(), 'ac-session-p4-'))
  tempDirs.push(dir)
  const work = mkdtempSync(join(tmpdir(), 'ac-session-p4w-'))
  tempDirs.push(work)

  const server = await bootServer(dir)
  const port = server.port
  const room = await makeRoom(port, 'p4-续传', work)
  await makeCharacter(port, room.id, '甲', 'MOCK-续传')

  await postMessage(port, room.id, '第一轮：暗号是红鲱鱼')
  await waitIdle(port, room.id, 40_000)
  const first = characterMessages((await req(port, `/api/rooms/${room.id}/messages?limit=200`)).messages, '甲')
  check('P4 第一轮甲发言 1 条', first.length === 1, `实际 ${first.length}`)
  check('P4 首轮全量重放（meta.resume 未置位）', first[0].meta?.resume !== true)
  const row1 = sessionRows(dir, 'room_id = ?', room.id)[0]
  check(
    'P4 第一轮后 sessions.turns=1（session_id 为 mock- 形态）',
    row1 && row1.turns === 1 && String(row1.session_id).startsWith('mock-'),
    JSON.stringify(row1),
  )

  await postMessage(port, room.id, '第二轮：请汇报最新情况')
  await waitIdle(port, room.id, 40_000)
  const second = characterMessages((await req(port, `/api/rooms/${room.id}/messages?limit=200`)).messages, '甲')[1]
  check('P4 第二轮 meta.resume=true', second?.meta?.resume === true)
  check(
    'P4 第二轮回复 RESUME-OK 并回显续传会话 id',
    second?.content.includes('RESUME-OK') && second?.content.includes('mock-'),
    second?.content.slice(0, 120),
  )
  // The round-2 incremental prompt carries exactly: 甲's round-1 reply +
  // the round-2 user message = 2 lines. The round-1 USER message stays
  // behind the cursor — a full replay would count 3.
  check('P4 增量 prompt 只带游标后的消息（新消息 2 条而非 3 条）', second?.content.includes('新消息 2 条'), second?.content)
  const row2 = sessionRows(dir, 'room_id = ?', room.id)[0]
  check('P4 第二轮后 sessions.turns=2', row2 && row2.turns === 2, JSON.stringify(row2))
}

/* ---------------------------- P4b integration: message during a running turn */

/**
 * Mid-round message (P0-1 review): round 1 rides the slow mock seam (~4.8s)
 * so a second human message can be posted strictly INSIDE the turn. The
 * cursor round 1 leaves behind must be the newest message ITS prompt
 * actually carried (msg1 only) — a Date.now()-style regression would set it
 * past the mid-round message and round 2's increment would come up empty.
 * The first streamed `delta` is the deterministic injection point: the
 * harness only starts after the turn's message snapshot, so the mid-round
 * message can never leak into round 1's own prompt.
 */
async function scenarioMidRoundMessage() {
  const dir = mkdtempSync(join(tmpdir(), 'ac-session-p4b-'))
  tempDirs.push(dir)
  const work = mkdtempSync(join(tmpdir(), 'ac-session-p4bw-'))
  tempDirs.push(work)

  const server = await bootServer(dir)
  const port = server.port
  const room = await makeRoom(port, 'p4b-运行中插话', work)
  await makeCharacter(port, room.id, '甲', 'MOCK-续传')

  const watch = await sseWatch(port, room.id)
  await postMessage(port, room.id, '第一轮：模拟慢速，先建立会话')
  const sawStream = await (async () => {
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      if (watch.events.some((frame) => frame.event === 'delta' && frame.data?.kind === 'text')) return true
      await sleep(100)
    }
    return false
  })()
  check('P4b 第一轮流式输出已开始（prompt 快照已过）', sawStream)
  await postMessage(port, room.id, '中途插话：暗号是蓝鲸号二')
  await waitIdle(port, room.id, 60_000)
  await watch.stop()

  const messages = (await req(port, `/api/rooms/${room.id}/messages?limit=200`)).messages
  const replies = characterMessages(messages, '甲')
  check(
    'P4b 消息 seq 随插入单调递增（rowid tiebreaker 在位）',
    messages.every((message, index) => index === 0 || message.seq > messages[index - 1].seq),
    messages.map((message) => message.seq).join(','),
  )
  check('P4b 两轮各 1 条回复（中途消息接力出第二轮）', replies.length === 2, `实际 ${replies.length}`)
  const second = replies[1]
  check('P4b 第二轮为续传轮（meta.resume=true）', second?.meta?.resume === true)
  check(
    'P4b 中途消息未被游标吞掉（增量 prompt 带上它）',
    Boolean(second) && second.content.includes('蓝鲸号二'),
    second?.content,
  )
  check(
    'P4b 增量恰 2 条（慢速回复 + 中途消息）',
    Boolean(second) && second.content.includes('新消息 2 条'),
    second?.content,
  )
  const row = sessionRows(dir, 'room_id = ?', room.id)[0]
  check('P4b sessions.turns=2', row && row.turns === 2, JSON.stringify(row))
}

/* --------------- P4c integration: after-cursor fetch + fold end-to-end (B01) */

/**
 * The old recent-80 fetch window and the bare-`break` transcript fill (B01):
 * (a) 92 post-cursor messages — the window only ever loaded 80, so the
 *     oldest increments never even reached memory, fold or no fold;
 * (b) six 4k floods — overflow reaches the fold through the real server;
 * (c) 1005 floods — beyond the 1000-message fetch window, the overflow must
 *     ride along as a fold COUNT and the cursor must still advance (a
 *     silent skip or a frozen cursor would both strand them).
 * Floods go straight into sqlite: through the API each would wake the
 * character and start a turn.
 */
async function scenarioIncrementalFetch() {
  const dir = mkdtempSync(join(tmpdir(), 'ac-session-p4c-'))
  tempDirs.push(dir)
  const work = mkdtempSync(join(tmpdir(), 'ac-session-p4cw-'))
  tempDirs.push(work)

  const server = await bootServer(dir)
  const port = server.port

  // Flood timestamps must sit BETWEEN the cursor (round-1 trigger) and the
  // round-2 trigger's real wall-clock time: past-dated relative to the
  // anchor (+10ms, 4 per ms), never in the future — a future-dated flood
  // sorts AFTER the round-2 trigger and both the render order and the
  // "newest 200" API window bury the trigger mid-list.
  const flood = (roomId, anchorAt, prefix, count, body) =>
    withDb(dir, (handle) => {
      const insert = handle.prepare(
        'insert into messages (id, room_id, author_type, character_id, author_name, content, created_at) values (?, ?, ?, null, ?, ?, ?)',
      )
      for (let i = 0; i < count; i += 1) {
        insert.run(`${prefix}-${i}`, roomId, 'user', '用户', body(i), anchorAt + 10 + Math.floor(i / 4))
      }
    })

  // --- a) >80 short increments: everything must reach the prompt.
  const roomA = await makeRoom(port, 'p4c-增量取回', work)
  await makeCharacter(port, roomA.id, '甲', 'MOCK-续传')
  await postMessage(port, roomA.id, '第一轮：建立会话')
  await waitIdle(port, roomA.id, 40_000)
  const anchorA = (await req(port, `/api/rooms/${roomA.id}/messages?limit=200`)).messages.find((message) =>
    message.content.includes('第一轮：建立会话'),
  )
  flood(roomA.id, anchorA.createdAt, 'flood-a', 90, (i) => `洪水消息${i}：暗号UFO-${i}`)
  await postMessage(port, roomA.id, '第二轮：请汇报最新情况')
  await waitIdle(port, roomA.id, 60_000)
  const messagesA = (await req(port, `/api/rooms/${roomA.id}/messages?limit=200`)).messages
  const secondA = characterMessages(messagesA, '甲')[1]
  check('P4c 超量增量轮为续传轮', secondA?.meta?.resume === true)
  check(
    'P4c 超过 80 条增量全部进入 prompt（旧窗口只看得到 80）',
    Boolean(secondA) && secondA.content.includes('新消息 92 条'),
    secondA?.content.slice(0, 220),
  )
  check(
    'P4c 短消息总量在预算内，折叠不误触发',
    Boolean(secondA) && secondA.content.includes('折叠 0 条'),
    secondA?.content.slice(0, 220),
  )
  const triggerA = messagesA.find((message) => message.content.includes('第二轮：请汇报最新情况'))
  const rowA = sessionRows(dir, 'room_id = ?', roomA.id)[0]
  check(
    'P4c 游标推到最新（92 条全部消费，无滞留）',
    Boolean(rowA) && rowA.consumed_seq === triggerA?.seq && rowA.turns === 2,
    JSON.stringify({ row: rowA, triggerSeq: triggerA?.seq }),
  )

  // --- b) six 4k floods: the fold engages through the whole server chain.
  const roomB = await makeRoom(port, 'p4c-折叠', work)
  await makeCharacter(port, roomB.id, '乙', 'MOCK-续传')
  await postMessage(port, roomB.id, '第一轮：建立会话')
  await waitIdle(port, roomB.id, 40_000)
  const anchorB = (await req(port, `/api/rooms/${roomB.id}/messages?limit=200`)).messages.find((message) =>
    message.content.includes('第一轮：建立会话'),
  )
  flood(roomB.id, anchorB.createdAt, 'big-b', 6, (i) => `⟪BIG-${i}⟫${'B'.repeat(3_992)}`)
  await postMessage(port, roomB.id, '第二轮：请汇报最新情况')
  await waitIdle(port, roomB.id, 60_000)
  const secondB = characterMessages((await req(port, `/api/rooms/${roomB.id}/messages?limit=200`)).messages, '乙')[1]
  check(
    'P4c 4k 增量溢出走折叠（服务端全链）',
    Boolean(secondB) && secondB.content.includes('折叠 2 条'),
    secondB?.content.slice(0, 220),
  )

  // --- c) 1005 floods: beyond the fetch window, counted not skipped.
  const roomC = await makeRoom(port, 'p4c-窗口溢出', work)
  await makeCharacter(port, roomC.id, '丙', 'MOCK-续传')
  await postMessage(port, roomC.id, '第一轮：建立会话')
  await waitIdle(port, roomC.id, 40_000)
  const anchorC = (await req(port, `/api/rooms/${roomC.id}/messages?limit=200`)).messages.find((message) =>
    message.content.includes('第一轮：建立会话'),
  )
  flood(roomC.id, anchorC.createdAt, 'flood-c', 1_005, (i) => `洪${String(i).padStart(5, '0')}`)
  await postMessage(port, roomC.id, '第二轮：请汇报最新情况')
  await waitIdle(port, roomC.id, 120_000)
  // 1009 rows in this room — the default newest-200 window buries 丙's
  // round-1 reply (older createdAt than the flood block), so pull them all.
  const messagesC = (await req(port, `/api/rooms/${roomC.id}/messages?limit=1200`)).messages
  const secondC = characterMessages(messagesC, '丙')[1]
  check(
    'P4c 窗口溢出：折叠计数在场',
    Boolean(secondC) && /折叠 [1-9]\d* 条/.test(secondC.content),
    secondC?.content.slice(0, 220),
  )
  check(
    'P4c 窗口溢出：窗口外条数以计数披露（不静默跳过）',
    Boolean(secondC) && secondC.content.includes('含取回窗口外计数'),
    secondC?.content.slice(0, 220),
  )
  const triggerC = messagesC.find((message) => message.content.includes('第二轮：请汇报最新情况'))
  const rowC = sessionRows(dir, 'room_id = ?', roomC.id)[0]
  check(
    'P4c 窗口溢出：游标仍推进到最新（按计数消费，不冻结）',
    Boolean(rowC) && rowC.consumed_seq === triggerC?.seq,
    JSON.stringify({ row: rowC, triggerSeq: triggerC?.seq }),
  )
}

/* -------------------------------------------- P5 fallback: bogus session row */

async function scenarioFallback() {
  const dir = mkdtempSync(join(tmpdir(), 'ac-session-p5-'))
  tempDirs.push(dir)
  const work = mkdtempSync(join(tmpdir(), 'ac-session-p5w-'))
  tempDirs.push(work)

  const server = await bootServer(dir)
  const port = server.port
  const room = await makeRoom(port, 'p5-回退', work)
  const character = await makeCharacter(port, room.id, '甲', 'MOCK-会话失效')

  // Preseed a session row the CLI never made: the next turn rides it, the
  // mock dies with "session not found", and the orchestrator must fall back
  // to a full-transcript rerun the user never hears about.
  withDb(dir, (handle) =>
    handle
      .prepare(
        'insert into sessions (room_id, character_id, harness, model, session_id, consumed_at, turns, created_at, updated_at) values (?, ?, ?, ?, ?, ?, 5, ?, ?)',
      )
      .run(room.id, character.id, 'mock', 'mock', 'bogus-session-xyz', 0, Date.now(), Date.now()),
  )

  await postMessage(port, room.id, '请开始干活')
  await waitIdle(port, room.id, 60_000)
  const messages = (await req(port, `/api/rooms/${room.id}/messages?limit=200`)).messages
  const replies = characterMessages(messages, '甲')
  check('P5 回退后甲恰发言 1 条（全量重跑成功）', replies.length === 1, `实际 ${replies.length}`)
  check('P5 用户侧无失败播报（静默回退）', systemNotices(messages, '运行失败').length === 0)
  check('P5 重跑消息为全量形态（meta.resume 未置位）', replies[0]?.meta?.resume !== true)
  const row = sessionRows(dir, 'room_id = ? and character_id = ?', room.id, character.id)[0]
  check(
    'P5 session 行已被替换（bogus → mock-，turns=1）',
    row && String(row.session_id).startsWith('mock-') && row.turns === 1,
    JSON.stringify(row),
  )
  const turns = turnRows(dir, 'character_id = ?', character.id)
  check(
    'P5 turn 序列：先 error（resume 失败）后 done（全量重跑）',
    turns.length === 2 && turns[0].status === 'error' && turns[1].status === 'done',
    JSON.stringify(turns.map((turn) => turn.status)),
  )
}

/* --------------------------------------------------- P6 kill switch (env) */

async function scenarioKillSwitch() {
  const dir = mkdtempSync(join(tmpdir(), 'ac-session-p6-'))
  tempDirs.push(dir)
  const work = mkdtempSync(join(tmpdir(), 'ac-session-p6w-'))
  tempDirs.push(work)

  const server = await bootServer(dir, { AC_SESSION_RESUME: '0' })
  const port = server.port
  const room = await makeRoom(port, 'p6-开关', work)
  await makeCharacter(port, room.id, '甲', 'MOCK-续传')

  await postMessage(port, room.id, '第一轮：建立会话')
  await waitIdle(port, room.id, 40_000)
  await postMessage(port, room.id, '第二轮：请汇报最新情况')
  await waitIdle(port, room.id, 40_000)
  const replies = characterMessages((await req(port, `/api/rooms/${room.id}/messages?limit=200`)).messages, '甲')
  check('P6 两轮各 1 条回复', replies.length === 2, `实际 ${replies.length}`)
  check('P6 开关关闭时第二轮不续传（meta.resume 未置位）', replies[1]?.meta?.resume !== true)
  check(
    'P6 开关关闭时适配器未收到 resume（回复为默认形态而非 RESUME-OK）',
    Boolean(replies[1]) && !replies[1].content.includes('RESUME-OK'),
    replies[1]?.content.slice(0, 80),
  )
  const row = sessionRows(dir, 'room_id = ?', room.id)[0]
  check('P6 开关只关乘坐不关记账（turns 仍累加到 2）', row && row.turns === 2, JSON.stringify(row))
}

/* ------------------------------------------------------------------- main */

try {
  scenarioIncrementalPrompt()
  scenarioResumeArgs()
  scenarioFullArgv()
  await scenarioIsolation()
  await scenarioIntegration()
  await scenarioMidRoundMessage()
  await scenarioFoldPrompt()
  await scenarioIncrementalFetch()
  await scenarioFallback()
  await scenarioKillSwitch()
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
  console.log(`\nOK: session contract passed (${passed}/${passed})`)
}
