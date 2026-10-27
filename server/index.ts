import express, { type NextFunction, type Request, type Response } from 'express'
import { appendFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import * as db from './db.ts'
import { broadcast, send, subscribe } from './events.ts'
import { cachedModels, listAdapters, listModels } from './harnesses/index.ts'
import { resolveCannbot, resolveDsh, resolveHermes, resolveOpencode, type LaunchSpec } from './harnesses/bins.ts'
import { dshCredentialStatus } from './harnesses/dsh.ts'
import {
  idleTimeoutMs,
  killPidTree,
  pidMatchesLaunch,
  probePid,
  turnTimeoutMs,
  type LaunchMatch,
} from './harnesses/process.ts'
import * as orchestrator from './orchestrator.ts'
import { DATA_DIR, DEFAULT_WORKSPACE, WEB_DIST } from './paths.ts'
import type { Character, HarnessKind, Room } from './types.ts'
import { HARNESS_LABELS } from './types.ts'
import { truncate } from './util.ts'

const PORT = Number(process.env.AC_PORT ?? process.env.PORT ?? 8787)
const HOST = process.env.AC_HOST ?? '127.0.0.1'
/** Process start time, exposed via /api/health so stale servers are detectable. */
const STARTED_AT = Date.now()

/**
 * Crash journal: the 16:41 exit-1 died without leaving a stack anywhere (the
 * console scrollback was the only witness). Every uncaught error lands here
 * with a timestamp so the next crash is diagnosable after the fact.
 */
const CRASH_LOG = join(DATA_DIR, `crash-${PORT}.log`)
function logCrash(kind: string, error: unknown): void {
  const detail = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)
  try {
    appendFileSync(CRASH_LOG, `[${new Date().toISOString()}] ${kind}: ${detail}\n`)
  } catch {
    /* log path gone; console still gets it */
  }
  console.error(`[agent-crowd] ${kind}:`, detail)
}

// Last-resort net, NOT a swallow: routes and pump() handle their own errors,
// so anything reaching here is a bug we haven't named yet. Killing the
// process would take every room down (and tsx watch restarts into the very
// same code), so log-and-continue keeps the rooms alive while the journal
// makes the next occurrence visible.
process.on('uncaughtException', (error) => logCrash('uncaughtException', error))
process.on('unhandledRejection', (reason) => logCrash('unhandledRejection', reason))

db.seedIfEmpty(DEFAULT_WORKSPACE)

/**
 * Startup recovery: a hard kill (tsx watch reload on server edits, crash,
 * reboot) runs no exit hooks, so turns stay 'running' in the DB forever and
 * their CLI process trees survive as orphans that the stop button can no
 * longer reach — the "回复卡住、停止也停止不了" shape. Sweep both: mark the
 * turns interrupted and taskkill the persisted pids — but only after
 * verifying each pid still belongs to us (see pidMatchesLaunch): this sweep
 * runs on EVERY tsx-watch reload, and a pid recycled by an unrelated
 * process would otherwise lose its whole tree to a taskkill /T /F.
 */

/** The launch spec for a harness kind, or null when it runs no process. */
function resolveSpec(harness: HarnessKind): LaunchSpec | null {
  switch (harness) {
    case 'opencode':
      return resolveOpencode()
    case 'cannbot':
      return resolveCannbot()
    case 'dsh':
      return resolveDsh()
    case 'hermes':
      return resolveHermes()
    default:
      return null // mock runs in-process: no pid to own
  }
}

/**
 * Rebuild the launch shape the adapter would have spawned for this
 * character, so the boot sweep can verify a persisted pid is really ours
 * before killing it. null = unidentifiable (mock, deleted character,
 * uninstalled binary) and the sweep must leave the pid alone.
 */
function launchMatchFor(character: Character): LaunchMatch | null {
  if (character.harness === 'custom') {
    // custom runs `cmd /d /s /c <filled template>`; the template's literal
    // chunks survive verbatim in the command line, so the longest one is
    // the marker a recycled pid won't have.
    const template = character.commandTemplate.trim()
    if (!template) return null
    const marker = longestTemplateLiteral(template)
    return { command: process.env.COMSPEC ?? 'cmd.exe', markers: marker ? [marker] : [] }
  }
  const spec = resolveSpec(character.harness)
  return spec ? { command: spec.command, markers: spec.argsPrefix } : null
}

/** Longest placeholder-free chunk (≥ 4 chars) of a custom command template. */
function longestTemplateLiteral(template: string): string | null {
  const chunks = template
    .split(/\{(?:prompt|model|cwd|name)\}/)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length >= 4)
  if (chunks.length === 0) return null
  return chunks.reduce((best, chunk) => (chunk.length > best.length ? chunk : best))
}

function recoverInterruptedTurns(): void {
  const stale = db.recoverInterruptedTurns()
  if (stale.length === 0) return
  const byRoom = new Map<string, { count: number; killed: number; skipped: number }>()
  for (const item of stale) {
    let killed = 0
    let skipped = 0
    if (item.pid !== null) {
      const probe = probePid(item.pid)
      if (probe) {
        const character = db.getCharacter(item.characterId)
        const match = character ? launchMatchFor(character) : null
        // A real orphan predates this boot; a younger occupant is a recycled pid.
        const bornBeforeBoot = probe.createdAtMs === 0 || probe.createdAtMs <= STARTED_AT
        if (match && bornBeforeBoot && pidMatchesLaunch(probe, match)) {
          killPidTree(item.pid)
          killed = 1
        } else {
          skipped = 1
          const why = !match
            ? 'launch shape unknown (character deleted / mock / binary missing)'
            : !bornBeforeBoot
              ? 'younger than this boot (pid recycled?)'
              : 'image/command line mismatch (pid recycled?)'
          console.warn(`[agent-crowd] recovery: pid ${item.pid} left alone — ${why}`)
        }
      }
      // probe === null: the process is already gone — nothing to kill.
    }
    const entry = byRoom.get(item.roomId) ?? { count: 0, killed: 0, skipped: 0 }
    entry.count += 1
    entry.killed += killed
    entry.skipped += skipped
    byRoom.set(item.roomId, entry)
  }
  for (const [roomId, entry] of byRoom) {
    db.addMessage({
      roomId,
      authorType: 'system',
      authorName: '系统',
      content: `⚠️ 服务器重启，${entry.count} 个进行中的回合已中断${entry.killed > 0 ? `，${entry.killed} 个残留进程已清理` : ''}${entry.skipped > 0 ? `，${entry.skipped} 个进程未能确认归属、已跳过清理` : ''}。需要继续请重新发送，或用「中途补充」补充指令。`,
      meta: { generated: true },
    })
  }
  console.log(`[agent-crowd] startup recovery: ${stale.length} interrupted turn(s) swept`)
}
recoverInterruptedTurns()

const app = express()
app.use(express.json({ limit: '2mb' }))

function asyncRoute(
  handler: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    handler(req, res).catch(next)
  }
}

function fail(res: Response, status: number, message: string): void {
  res.status(status).json({ error: message })
}

function requireRoom(res: Response, id: string): Room | undefined {
  const room = db.getRoom(id)
  if (!room) {
    fail(res, 404, '房间不存在')
    return undefined
  }
  return room
}

function credentialLabel(): string {
  switch (dshCredentialStatus()) {
    case 'env':
      return '环境变量'
    case 'store':
      return '本地凭据存储'
    default:
      return '缺失（dsh 角色会运行失败）'
  }
}

function harnessInfo() {
  const opencode = resolveOpencode()
  const cannbot = resolveCannbot()
  const dsh = resolveDsh()
  const hermes = resolveHermes()
  return {
    opencode: { label: HARNESS_LABELS.opencode, available: Boolean(opencode), detail: opencode?.source ?? null },
    cannbot: { label: HARNESS_LABELS.cannbot, available: Boolean(cannbot), detail: cannbot?.source ?? null },
    dsh: {
      label: HARNESS_LABELS.dsh,
      available: Boolean(dsh),
      detail: dsh ? `${dsh.source} · DeepSeek 凭据：${credentialLabel()}` : null,
    },
    hermes: { label: HARNESS_LABELS.hermes, available: Boolean(hermes), detail: hermes?.source ?? null },
    mock: { label: HARNESS_LABELS.mock, available: true, detail: 'built-in' },
    custom: { label: HARNESS_LABELS.custom, available: true, detail: 'cmd.exe' },
  }
}

/* ------------------------------------------------------------------ system */

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    pid: process.pid,
    startedAt: STARTED_AT,
    turnTimeoutMs: turnTimeoutMs(),
    idleTimeoutMs: idleTimeoutMs(),
    harnesses: harnessInfo(),
    adapters: listAdapters().map((adapter) => adapter.id),
  })
})

app.get('/api/bootstrap', asyncRoute(async (_req, res) => {
  const rooms = db.listRooms()
  res.json({
    rooms,
    characters: db.listAllCharacters(),
    presets: db.listPresets(),
    harnesses: harnessInfo(),
    models: cachedModels(),
    busy: Object.fromEntries(rooms.map((room) => [room.id, orchestrator.isBusy(room.id)])),
  })
}))

app.get('/api/models', asyncRoute(async (_req, res) => {
  res.json({ models: await listModels(), harnesses: harnessInfo() })
}))

/* ------------------------------------------------------------------- rooms */

/** Shared room-input normalization so create and PATCH behave identically. */
function normalizeWorkingDir(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : DEFAULT_WORKSPACE
}

/**
 * Anything that isn't a finite number >= 1 falls back to the default (6),
 * on both create and PATCH — previously the two routes sanitized garbage
 * differently (create turned 0 into 6, PATCH's clamp turned it into 1).
 */
function normalizeMaxHops(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) && n >= 1 ? Math.min(30, Math.round(n)) : 6
}

app.post('/api/rooms', (req, res) => {
  const { name, topic, workingDir, maxHops } = req.body ?? {}
  if (typeof name !== 'string' || !name.trim()) return fail(res, 400, '房间名不能为空')
  const room = db.createRoom({
    name: name.trim(),
    topic: typeof topic === 'string' ? topic.trim() : '',
    workingDir: normalizeWorkingDir(workingDir),
    maxHops: normalizeMaxHops(maxHops),
  })
  res.status(201).json(room)
})

app.patch('/api/rooms/:id', (req, res) => {
  const { name, topic, workingDir, maxHops } = req.body ?? {}
  if (name !== undefined && (typeof name !== 'string' || !name.trim())) {
    return fail(res, 400, '房间名不能为空')
  }
  const room = db.updateRoom(req.params.id, {
    ...(typeof name === 'string' ? { name: name.trim() } : {}),
    ...(typeof topic === 'string' ? { topic: topic.trim() } : {}),
    ...(typeof workingDir === 'string' ? { workingDir: normalizeWorkingDir(workingDir) } : {}),
    ...(maxHops !== undefined ? { maxHops: normalizeMaxHops(maxHops) } : {}),
  })
  if (!room) return fail(res, 404, '房间不存在')
  // Other tabs of the same room only hear about settings changes via SSE.
  broadcast(room.id, 'room', { roomId: room.id, room })
  res.json(room)
})

app.delete('/api/rooms/:id', (req, res) => {
  orchestrator.stopRoom(req.params.id)
  db.deleteRoom(req.params.id)
  res.json({ ok: true })
})

app.get('/api/rooms/:id/state', (req, res) => {
  const room = requireRoom(res, req.params.id)
  if (!room) return
  res.json({
    roomId: room.id,
    busy: orchestrator.isBusy(room.id),
    activeCharacterId: orchestrator.activeCharacter(room.id),
    /** Pid of the CLI process running the active turn (null when idle). */
    activePid: orchestrator.activePid(room.id) ?? null,
    queuedCharacterIds: orchestrator.queuedCharacters(room.id),
  })
})

app.post('/api/rooms/:id/clear', (req, res) => {
  const room = requireRoom(res, req.params.id)
  if (!room) return
  orchestrator.stopRoom(room.id)
  db.clearMessages(room.id)
  res.json({ ok: true })
})

/* ---------------------------------------------------------------- messages */

app.get('/api/rooms/:id/messages', (req, res) => {
  const room = requireRoom(res, req.params.id)
  if (!room) return
  const limit = Number(req.query.limit ?? 300)
  res.json({ messages: db.listMessages(room.id, Number.isFinite(limit) ? limit : 300) })
})

app.post('/api/rooms/:id/messages', (req, res) => {
  const room = requireRoom(res, req.params.id)
  if (!room) return
  const content = typeof req.body?.content === 'string' ? req.body.content.trim() : ''
  if (!content) return fail(res, 400, '消息不能为空')

  const message = db.addMessage({
    roomId: room.id,
    authorType: 'user',
    authorName: '我',
    content: truncate(content, 20_000),
    meta: null,
  })
  res.status(201).json(message)
  // User messages used to reach other tabs only on reconnect; broadcast so
  // every open tab of the room stays in sync (senders dedupe by message id).
  broadcast(room.id, 'message', { roomId: room.id, message })
  orchestrator.handleUserMessage(room, message)
})

/* ------------------------------------------------------------------- steer */

/**
 * Mid-turn supplementary instruction: saved as a flagged user message, then
 * the target character re-runs with it in the prompt. When the target is the
 * active speaker its current run is aborted first (see orchestrator.steer).
 */
app.post('/api/rooms/:id/steer', (req, res) => {
  const room = requireRoom(res, req.params.id)
  if (!room) return
  const content = typeof req.body?.content === 'string' ? req.body.content.trim() : ''
  if (!content) return fail(res, 400, '补充内容不能为空')
  const targetId = typeof req.body?.targetId === 'string' ? req.body.targetId : ''
  const character = db.listCharacters(room.id).find((item) => item.id === targetId)
  if (!character) return fail(res, 404, '目标角色不存在')
  if (!character.enabled) return fail(res, 400, '目标角色已停用')

  const message = db.addMessage({
    roomId: room.id,
    authorType: 'user',
    authorName: '我',
    content: truncate(content, 20_000),
    meta: { steer: { targetId: character.id, targetName: character.name } },
  })
  res.status(201).json(message)
  broadcast(room.id, 'message', { roomId: room.id, message })
  orchestrator.steer(room, character, message)
})

/* ---------------------------------------------------------------- memories */

/**
 * Long-term memory management (docs/memory-plan.md): room-scope notes are
 * shared by every member, identity-scope notes follow the character across
 * rooms. Both get injected into every turn's prompt.
 */
app.get('/api/rooms/:id/memories', (req, res) => {
  const room = requireRoom(res, req.params.id)
  if (!room) return
  const members = db.listCharacters(room.id).map((character) => {
    const identity = db.ensureIdentityForCharacter(character)
    return {
      characterId: character.id,
      name: character.name,
      identityId: identity.id,
      memories: db.listMemories('identity', identity.id),
    }
  })
  res.json({ room: db.listMemories('room', room.id), members })
})

app.post('/api/rooms/:id/memories', (req, res) => {
  const room = requireRoom(res, req.params.id)
  if (!room) return
  const body = req.body ?? {}

  // "记住这条消息": content/scope/kind derived from the message itself —
  // a character's reply becomes its private episode, a user note becomes a
  // shared room fact.
  if (typeof body.fromMessageId === 'string') {
    const message = db
      .listMessages(room.id, 2000)
      .find((item) => item.id === body.fromMessageId)
    if (!message) return fail(res, 404, '消息不存在')
    const target = message.characterId ? db.getCharacter(message.characterId) : undefined
    const result = target
      ? db.addMemory({
          scope: 'identity',
          ownerId: db.ensureIdentityForCharacter(target).id,
          kind: 'episode',
          content: message.content,
          sourceRoomId: room.id,
        })
      : db.addMemory({
          scope: 'room',
          ownerId: room.id,
          kind: 'fact',
          content: message.content,
          sourceRoomId: room.id,
        })
    res.status(201).json({ ...result, scope: result.memory.scope })
    return
  }

  const content = typeof body.content === 'string' ? body.content.trim() : ''
  if (!content) return fail(res, 400, '记忆内容不能为空')
  const scope = body.scope === 'room' ? 'room' : body.scope === 'identity' ? 'identity' : null
  if (!scope) return fail(res, 400, 'scope 必须是 room 或 identity')

  let ownerId = room.id
  if (scope === 'identity') {
    const character = typeof body.characterId === 'string' ? db.getCharacter(body.characterId) : undefined
    if (!character || character.roomId !== room.id) return fail(res, 404, '目标角色不存在')
    ownerId = db.ensureIdentityForCharacter(character).id
  }
  const result = db.addMemory({
    scope,
    ownerId,
    kind: body.kind,
    content,
    sourceRoomId: room.id,
    pinned: body.pinned === true,
  })
  res.status(201).json({ ...result, scope: result.memory.scope })
})

app.patch('/api/memories/:id', (req, res) => {
  const memory = db.getMemory(req.params.id)
  if (!memory) return fail(res, 404, '记忆不存在')
  const body = req.body ?? {}
  res.json(
    db.updateMemory(memory.id, {
      ...(body.content !== undefined ? { content: String(body.content) } : {}),
      ...(body.kind !== undefined ? { kind: body.kind } : {}),
      ...(body.pinned !== undefined ? { pinned: Boolean(body.pinned) } : {}),
    }),
  )
})

app.delete('/api/memories/:id', (req, res) => {
  const memory = db.getMemory(req.params.id)
  if (!memory) return fail(res, 404, '记忆不存在')
  db.deleteMemory(memory.id)
  res.json({ ok: true })
})

/* ------------------------------------------------------------------- sse */

app.get('/api/rooms/:id/events', (req, res) => {
  const room = requireRoom(res, req.params.id)
  if (!room) return
  const unsubscribe = subscribe(room.id, res)
  // SSE events are fire-and-forget, so a client that (re)connects mid-turn
  // misses busy/queue/delta. Catch it up with the current room state and a
  // replay snapshot of the running turn (text/thinking streamed so far).
  send(res, 'busy', {
    roomId: room.id,
    busy: orchestrator.isBusy(room.id),
    characterId: orchestrator.activeCharacter(room.id),
  })
  send(res, 'queue', { roomId: room.id, characters: orchestrator.queuedCharacters(room.id) })
  const snapshot = orchestrator.liveTurn(room.id)
  if (snapshot) {
    send(res, 'turn', {
      roomId: room.id,
      turnId: snapshot.turnId,
      characterId: snapshot.characterId,
      status: 'running',
    })
    send(res, 'replay', { roomId: room.id, turn: snapshot })
  }
  req.on('close', unsubscribe)
  req.on('error', unsubscribe)
})

/* --------------------------------------------------------------- presets */

app.get('/api/presets', (_req, res) => {
  res.json({ presets: db.listPresets() })
})

app.post('/api/presets', (req, res) => {
  const body = req.body ?? {}
  if (typeof body.name !== 'string' || !body.name.trim()) return fail(res, 400, '角色名不能为空')
  const preset = db.createPreset({
    name: body.name,
    aliases: Array.isArray(body.aliases) ? body.aliases : undefined,
    avatar: body.avatar,
    color: body.color,
    harness: body.harness as HarnessKind,
    model: body.model,
    persona: body.persona,
    cwd: body.cwd,
    triggers: body.triggers,
    commandTemplate: body.commandTemplate,
    autoApprove: body.autoApprove,
  })
  res.status(201).json(preset)
})

app.patch('/api/presets/:id', (req, res) => {
  const current = db.getPreset(req.params.id)
  if (!current) return fail(res, 404, '角色不存在')
  const body = req.body ?? {}
  const preset = db.updatePreset(current.id, {
    ...(body.name !== undefined ? { name: String(body.name) } : {}),
    ...(body.aliases !== undefined ? { aliases: Array.isArray(body.aliases) ? body.aliases : [] } : {}),
    ...(body.avatar !== undefined ? { avatar: String(body.avatar) } : {}),
    ...(body.color !== undefined ? { color: String(body.color) } : {}),
    ...(body.harness !== undefined ? { harness: body.harness as HarnessKind } : {}),
    ...(body.model !== undefined ? { model: String(body.model) } : {}),
    ...(body.persona !== undefined ? { persona: String(body.persona) } : {}),
    ...(body.cwd !== undefined ? { cwd: String(body.cwd) } : {}),
    ...(body.triggers !== undefined ? { triggers: body.triggers } : {}),
    ...(body.commandTemplate !== undefined ? { commandTemplate: String(body.commandTemplate) } : {}),
    ...(body.autoApprove !== undefined ? { autoApprove: Boolean(body.autoApprove) } : {}),
  })
  res.json(preset)
})

app.delete('/api/presets/:id', (req, res) => {
  const preset = db.getPreset(req.params.id)
  if (!preset) return fail(res, 404, '角色不存在')
  db.deletePreset(preset.id)
  res.json({ ok: true })
})

/* -------------------------------------------------------------- characters */

app.post('/api/rooms/:id/characters', (req, res) => {
  const room = requireRoom(res, req.params.id)
  if (!room) return
  const body = req.body ?? {}
  if (typeof body.name !== 'string' || !body.name.trim()) return fail(res, 400, '角色名不能为空')

  const harness = String(body.harness ?? 'mock') as HarnessKind
  try {
    const character = db.createCharacter({
      roomId: room.id,
      name: body.name,
      aliases: Array.isArray(body.aliases) ? body.aliases : undefined,
      avatar: body.avatar,
      color: body.color,
      harness,
      model: body.model,
      persona: body.persona,
      cwd: body.cwd,
      triggers: body.triggers,
      commandTemplate: body.commandTemplate,
      autoApprove: body.autoApprove,
      enabled: body.enabled,
    })
    res.status(201).json(character)
  } catch (error) {
    // Ambiguous call-name (name/alias shadows a sibling) is a user-input
    // problem, not a server error — surface it as a 400 the editor shows.
    if (error instanceof db.CallNameConflictError) return fail(res, 400, error.message)
    throw error
  }
})

app.post('/api/rooms/:id/characters/from-presets', (req, res) => {
  const room = requireRoom(res, req.params.id)
  if (!room) return
  const presetIds = Array.isArray(req.body?.presetIds) ? req.body.presetIds.map(String) : []
  if (presetIds.length === 0) return fail(res, 400, '请选择至少一个角色')
  res.status(201).json(db.addPresetsToRoom(room.id, presetIds))
})

app.patch('/api/characters/:id', (req, res) => {
  const current = db.getCharacter(req.params.id)
  if (!current) return fail(res, 404, '角色不存在')
  const body = req.body ?? {}
  try {
    const character = db.updateCharacter(current.id, {
      ...(body.name !== undefined ? { name: String(body.name) } : {}),
      ...(body.aliases !== undefined ? { aliases: Array.isArray(body.aliases) ? body.aliases : [] } : {}),
      ...(body.avatar !== undefined ? { avatar: String(body.avatar) } : {}),
      ...(body.color !== undefined ? { color: String(body.color) } : {}),
      ...(body.harness !== undefined ? { harness: body.harness as HarnessKind } : {}),
      ...(body.model !== undefined ? { model: String(body.model) } : {}),
      ...(body.persona !== undefined ? { persona: String(body.persona) } : {}),
      ...(body.cwd !== undefined ? { cwd: String(body.cwd) } : {}),
      ...(body.triggers !== undefined ? { triggers: body.triggers } : {}),
      ...(body.commandTemplate !== undefined ? { commandTemplate: String(body.commandTemplate) } : {}),
      ...(body.autoApprove !== undefined ? { autoApprove: Boolean(body.autoApprove) } : {}),
      ...(body.enabled !== undefined ? { enabled: Boolean(body.enabled) } : {}),
    })
    res.json(character)
  } catch (error) {
    if (error instanceof db.CallNameConflictError) return fail(res, 400, error.message)
    throw error
  }
})

app.delete('/api/characters/:id', (req, res) => {
  const character = db.getCharacter(req.params.id)
  if (!character) return fail(res, 404, '角色不存在')
  db.deleteCharacter(character.id)
  res.json({ ok: true })
})

app.post('/api/characters/:id/run', (req, res) => {
  const character = db.getCharacter(req.params.id)
  if (!character) return fail(res, 404, '角色不存在')
  const room = requireRoom(res, character.roomId)
  if (!room) return
  const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : ''
  orchestrator.runCharacter(room, character, prompt || undefined)
  res.json({ ok: true, queued: true })
})

app.post('/api/rooms/:id/stop', (req, res) => {
  const room = requireRoom(res, req.params.id)
  if (!room) return
  orchestrator.stopRoom(room.id)
  res.json({ ok: true })
})

/* ------------------------------------------------------------------ static */

if (existsSync(WEB_DIST)) {
  app.use(express.static(WEB_DIST))
  app.get(/^(?!\/api).*/, (_req, res) => {
    res.sendFile(join(WEB_DIST, 'index.html'))
  })
}

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const reason = error instanceof Error ? error.message : String(error)
  console.error('[agent-crowd] unhandled:', reason)
  if (!res.headersSent) res.status(500).json({ error: reason })
})

app.listen(PORT, HOST, () => {
  const info = harnessInfo()
  console.log(`\n  agent-crowd  →  http://${HOST}:${PORT}`)
  for (const [kind, meta] of Object.entries(info)) {
    console.log(`  ${meta.available ? '✓' : '×'} ${kind.padEnd(9)} ${meta.detail ?? ''}`)
  }
  console.log('')
})
