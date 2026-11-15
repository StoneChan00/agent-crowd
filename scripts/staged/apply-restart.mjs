// One-shot staged-code applicator for the server-side restart queue.
// Run it DETACHED (outside any agent turn - Start-Process, never from an
// agent's own shell): writing server/*.ts triggers a tsx-watch reload that
// kills the running turn, including the agent's turn that launched this
// script. The applicator therefore:
//   1. idempotence-checks (server/restart.ts must not exist yet),
//   2. WAITS for a moment when every room is idle (polls /api/bootstrap,
//      same idea as the restart script's drain), so the reload interrupts
//      nobody and even the startup-recovery notice stays silent,
//   3. applies staged code via unique-anchor replacements (aborts without
//      writing if any anchor is missing or ambiguous - a future edit moved
//      it, and blind insertion could corrupt orchestrator.ts/index.ts),
//   4. runs `pnpm typecheck`; on failure restores snapshots (the rollback
//      writes trigger another reload back into the old code) and exits 1.
// Every step appends to data\apply-restart.log - the evidence of record.
import { execFileSync } from 'node:child_process'
import { appendFileSync, copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const stagedDir = dirname(fileURLToPath(import.meta.url))
const root = join(stagedDir, '..', '..')
const server = (...p) => join(root, 'server', ...p)
const applyLog = join(root, 'data', 'apply-restart.log')
const PORT = 8787

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`
  try {
    appendFileSync(applyLog, `${line}\n`, 'utf8')
  } catch {
    /* log path gone; console still gets it */
  }
  console.log(line)
}

const fail = (msg) => {
  log(`ABORT: ${msg}`)
  process.exit(1)
}

// 1. idempotence: this applicator must never run twice.
if (existsSync(server('restart.ts'))) {
  fail('server/restart.ts already exists - staged code already applied')
}

// 2. wait for all-idle (bootstrap carries a busy map). The watch reload
//    this script provokes must catch nobody mid-turn.
const deadline = Date.now() + 20 * 60 * 1000
for (;;) {
  if (Date.now() > deadline) fail('rooms stayed busy for 20min - re-run this script later')
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/bootstrap`)
    const data = await res.json()
    if (Object.values(data.busy ?? {}).every((busy) => !busy)) break
    log('waiting: some rooms busy')
  } catch {
    fail(`server on :${PORT} unreachable - run this on the right host/port`)
  }
  await new Promise((resolve) => setTimeout(resolve, 2000))
}
log('all rooms idle - applying staged code now')

// 3. snapshot + anchor-replace. Every anchor must appear EXACTLY once.
const files = {}
const read = (rel) => {
  const path = server(rel)
  const content = readFileSync(path, 'utf8')
  files[rel] = { path, old: content }
  return content
}
const replaceOnce = (rel, anchor, replacement) => {
  // Compose on the ACCUMULATED text: orchestrator.ts and index.ts each take
  // TWO replacements (import + hook/route), and recomputing from .old every
  // call silently dropped the first replacement - the composed files then
  // referenced maybeRestartNow/restart without importing them, typecheck
  // failed TS2304 and the applicator rolled back forever (P0, review round 3).
  const base = files[rel].new ?? files[rel].old
  const first = base.indexOf(anchor)
  if (first === -1) fail(`anchor not found in ${rel}: ${JSON.stringify(anchor)}`)
  if (base.indexOf(anchor, first + 1) !== -1) fail(`anchor not unique in ${rel}: ${JSON.stringify(anchor)}`)
  files[rel].new = base.replace(anchor, replacement)
}

read('orchestrator.ts')
replaceOnce(
  'orchestrator.ts',
  "import { buildTurnPrompt } from './prompt.ts'",
  "import { buildTurnPrompt } from './prompt.ts'\n// Circular with restart.ts (it imports isBusy): safe - both sides only call\n// functions at runtime, never at module top level.\nimport { maybeRestartNow } from './restart.ts'",
)
replaceOnce(
  'orchestrator.ts',
  '    if (consumed) void pump(roomId)',
  '    if (consumed) void pump(roomId)\n    // The relay chain reached its end and every queue is empty: this is the\n    // all-idle moment a pending POST /api/restart waits for (server/restart.ts).\n    maybeRestartNow()',
)

read('index.ts')
replaceOnce(
  'index.ts',
  "import * as orchestrator from './orchestrator.ts'",
  "import * as orchestrator from './orchestrator.ts'\nimport * as restart from './restart.ts'",
)
replaceOnce(
  'index.ts',
  '/* ------------------------------------------------------------------- sse */',
  `/* ---------------------------------------------------------------- restart */

// System-message channel for tooling: the restart script's start notice and
// RESULT line land here (authorType system, never wakes the orchestrator).
// Human messages stay on POST /api/rooms/:id/messages.
app.post('/api/rooms/:id/system', (req, res) => {
  const room = requireRoom(res, req.params.id)
  if (!room) return
  const content = typeof req.body?.content === 'string' ? req.body.content.trim() : ''
  if (!content) return fail(res, 400, '消息不能为空')
  const message = db.addMessage({
    roomId: room.id,
    authorType: 'system',
    authorName: '系统',
    content: truncate(content, 20_000),
    meta: { generated: true },
  })
  res.status(201).json(message)
  broadcast(room.id, 'message', { roomId: room.id, message })
})

// Queue a restart for the next all-idle moment (server/restart.ts): an
// external script's drain self-locks on this group's review loop, so the
// server itself fires the restart script from pump()'s finally and exits.
app.post('/api/restart', (req, res) => {
  const body = req.body ?? {}
  const result = restart.requestRestart(
    {
      excludeRoom: typeof body.excludeRoom === 'string' ? body.excludeRoom : undefined,
      notifyRoom: typeof body.notifyRoom === 'string' ? body.notifyRoom : undefined,
      drainSeconds: Number.isFinite(Number(body.drainSeconds)) ? Number(body.drainSeconds) : undefined,
    },
    // force lifts ONLY the 60min soft window (script ABORTed - the server
    // cannot see that, WMI is fire-and-forget); pending/launching still 409.
    body.force === true,
  )
  if (!result.ok) {
    // Truthful refusal reasons (P1, review round 5): the in-flight window is
    // the one an operator CAN act on after a script ABORT - say exactly what
    // unlocks it instead of a blanket "already pending" lie.
    if (result.reason === 'invalid-room-name') {
      return res.status(400).json({ ok: false, error: 'excludeRoom/notifyRoom 不得包含引号' })
    }
    if (result.reason === 'launching') {
      return res.status(409).json({ ok: false, error: '重启脚本正在启动（launcher 在途），请稍候重试' })
    }
    if (result.reason === 'in-flight-window') {
      return res.status(409).json({
        ok: false,
        error: '距上次重启脚本启动不足 60 分钟（软窗口）；若脚本已中止，可带 force:true 重新排队',
      })
    }
    return res.status(409).json({ ok: false, error: '已有待执行的重启请求' })
  }
  res.json({ ok: true, scheduled: 'next-idle' })
  // Response is written; if every room is already idle the restart fires
  // right here, otherwise the last turn's pump() finally picks it up.
  restart.maybeRestartNow()
})

/* ------------------------------------------------------------------- sse */`,
)

// Turn-timeout default 30m -> 60m (operator request, 2026-11-03). The start
// scripts already export AC_TURN_TIMEOUT_MS=60m; this aligns the fallback
// default for env-less runs (pnpm dev / pnpm serve) with them. Anchors are
// single-line ON PURPOSE: indexOf is byte-exact, so a multi-line anchor
// breaks the moment the file uses CRLF line endings.
read('harnesses/process.ts')
replaceOnce(
  'harnesses/process.ts',
  'export const DEFAULT_TURN_TIMEOUT_MS = 30 * 60_000',
  'export const DEFAULT_TURN_TIMEOUT_MS = 60 * 60_000',
)
replaceOnce(
  'harnesses/process.ts',
  'the backstop for genuinely endless turns — 30 minutes, up from 15, because',
  'the backstop for genuinely endless turns — 60 minutes, up from 30, because',
)
replaceOnce(
  'harnesses/process.ts',
  'a turn that was still producing output at 15 minutes got killed mid-reply.',
  'a turn that was still producing output at 30 minutes got killed mid-reply.',
)
replaceOnce(
  'harnesses/process.ts',
  'hit a timeout (idle ≥ 10 min, hard ≥ 30 min)',
  'hit a timeout (idle ≥ 10 min, hard ≥ 60 min)',
)

// 4. write + typecheck (rollback restores every snapshot on failure).
copyFileSync(join(stagedDir, 'restart.ts'), server('restart.ts'))
for (const rel of Object.keys(files)) writeFileSync(files[rel].path, files[rel].new, 'utf8')
log('files written: server/restart.ts (new), orchestrator.ts, index.ts (watch reloading)')

const rollback = (why) => {
  log(`typecheck FAILED - rolling back (${why})`)
  for (const rel of Object.keys(files)) writeFileSync(files[rel].path, files[rel].old, 'utf8')
  rmSync(server('restart.ts'))
  fail('rolled back to pre-apply state (old code reloaded)')
}

try {
  // pnpm is pnpm.cmd on Windows - reach it through cmd.exe.
  execFileSync('cmd.exe', ['/d', '/s', '/c', 'pnpm typecheck'], { cwd: root, stdio: 'inherit' })
} catch (error) {
  rollback(error instanceof Error ? error.message : String(error))
}
log('DONE - typecheck passed, new server code is live (watch reloaded it)')
