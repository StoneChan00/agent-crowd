import express, { type NextFunction, type Request, type Response } from 'express'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as db from './db.ts'
import { broadcast, send, subscribe } from './events.ts'
import { cachedModels, getAdapter, listAdapters, listModels } from './harnesses/index.ts'
import {
  resolveCannbot,
  resolveClaude,
  resolveCodex,
  resolveDsh,
  resolveHermes,
  resolveOpencode,
  type LaunchSpec,
} from './harnesses/bins.ts'
import { dshCredentialStatus } from './harnesses/dsh.ts'
import {
  idleTimeoutMs,
  killPidTree,
  pidMatchesLaunch,
  probePid,
  turnTimeoutMs,
  type LaunchMatch,
} from './harnesses/process.ts'
import { showCommit } from './gitstate.ts'
import * as orchestrator from './orchestrator.ts'
import { pickReviewer } from './reviewers.ts'
import { mediaFileHandler } from './media.ts'
import { listMcps } from './mcps.ts'
import { findRoomTemplate, ROOM_TEMPLATES } from './room-templates.ts'
import { createIsolationWorktree, removeIsolationWorktree } from './worktree.ts'
import * as restart from './restart.ts'
import { DATA_DIR, DEFAULT_WORKSPACE, SKILLS_DIR, WEB_DIST } from './paths.ts'
import { loadSkills } from './skills.ts'
import type { Character, CharacterRole, HarnessKind, Room, RoundReport, Task, Turn } from './types.ts'
import { CHARACTER_ROLES, HARNESS_LABELS } from './types.ts'
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
    case 'claude':
      return resolveClaude()
    case 'codex':
      return resolveCodex()
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

function recoverInterruptedTurns(): Turn[] {
  // 'running' rows are interrupted and swept below; 'queued' rows are left
  // untouched and re-queued after listen (orchestrator.restoreQueues) — they
  // were never started, so their work simply continues instead of dying
  // with the process (P0-2).
  const { interrupted: stale, queued } = db.startupRecovery()
  if (queued.length > 0) {
    console.log(`[agent-crowd] startup recovery: ${queued.length} queued turn(s) will be restored`)
  }
  if (stale.length === 0) return stale
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
      content: `⚠️ 服务器重启，${entry.count} 个进行中的回合已中断${entry.killed > 0 ? `，${entry.killed} 个残留进程已清理` : ''}${entry.skipped > 0 ? `，${entry.skipped} 个进程未能确认归属、已跳过清理` : ''}。有部分产出的回合会自动续跑一次；没有产出的请重新发送。`,
      meta: { generated: true },
    })
  }
  console.log(`[agent-crowd] startup recovery: ${stale.length} interrupted turn(s) swept`)
  return stale
}
const interruptedAtBoot = recoverInterruptedTurns()

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
  const claude = resolveClaude()
  const codex = resolveCodex()
  const info = (kind: HarnessKind, available: boolean, detail: string | null) => ({
    label: HARNESS_LABELS[kind],
    available,
    detail,
    capabilities: getAdapter(kind).capabilities,
  })
  return {
    opencode: info('opencode', Boolean(opencode), opencode?.source ?? null),
    cannbot: info('cannbot', Boolean(cannbot), cannbot?.source ?? null),
    dsh: info('dsh', Boolean(dsh), dsh ? `${dsh.source} · DeepSeek 凭据：${credentialLabel()}` : null),
    hermes: info('hermes', Boolean(hermes), hermes?.source ?? null),
    claude: info('claude', Boolean(claude), claude?.source ?? null),
    codex: info('codex', Boolean(codex), codex?.source ?? null),
    mock: info('mock', true, 'built-in'),
    custom: info('custom', true, 'cmd.exe'),
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

/* MCP visibility: which MCP servers each harness CLI loads from its own
   config (opencode.jsonc / dsh profiles / claude.json / codex toml). */
app.get('/api/mcps', (_req, res) => {
  res.json({ mcps: listMcps() })
})

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

/**
 * SOP gate (P0-3): the room's verification command, run by the SERVER
 * before a changed round may close. Trim, cap at 500 chars; empty is legal
 * (= the gate checks only the review verdict).
 */
function normalizeVerifyCommand(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, 500) : ''
}

app.post('/api/rooms', (req, res) => {
  const { name, topic, workingDir, maxHops, verifyCommand } = req.body ?? {}
  if (typeof name !== 'string' || !name.trim()) return fail(res, 400, '房间名不能为空')
  const room = db.createRoom({
    name: name.trim(),
    topic: typeof topic === 'string' ? topic.trim() : '',
    workingDir: normalizeWorkingDir(workingDir),
    maxHops: normalizeMaxHops(maxHops),
    verifyCommand: normalizeVerifyCommand(verifyCommand),
  })
  res.status(201).json(room)
})

app.patch('/api/rooms/:id', (req, res) => {
  const { name, topic, workingDir, maxHops, verifyCommand, reviewerCharacterId, blindReview, defaultResponderId } =
    req.body ?? {}
  if (name !== undefined && (typeof name !== 'string' || !name.trim())) {
    return fail(res, 400, '房间名不能为空')
  }
  // B05: the designated reviewer must be a member of THIS room (null clears).
  if (reviewerCharacterId !== undefined && reviewerCharacterId !== null) {
    if (typeof reviewerCharacterId !== 'string' || !reviewerCharacterId) {
      return fail(res, 400, 'reviewer 必须是本房间的角色，或传 null 取消指定')
    }
    const reviewer = db.getCharacter(reviewerCharacterId)
    if (!reviewer || reviewer.roomId !== req.params.id) {
      return fail(res, 400, '指定 reviewer 必须是本房间的角色')
    }
    // B05b-4: the reviewer must be able to actually speak mid-round — a
    // disabled character or a round-end summarizer can never deliver the
    // PASS the gate waits for; refusing at save time beats an unexplained
    // block on every changed round.
    if (!reviewer.enabled) {
      return fail(res, 400, `指定 reviewer「${reviewer.name}」已停用，请先启用或另选他人`)
    }
    if (reviewer.triggers.onRoundEnd) {
      return fail(res, 400, `指定 reviewer「${reviewer.name}」是轮末总结角色（收尾时才发言），无法给出有效 PASS，请另选他人`)
    }
  }
  const current = db.getRoom(req.params.id)
  if (!current) return fail(res, 404, '房间不存在')
  // B14: default responder must be a room member (null clears).
  if (defaultResponderId !== undefined && defaultResponderId !== null) {
    if (typeof defaultResponderId !== 'string' || !defaultResponderId) {
      return fail(res, 400, '默认响应者必须是本房间的角色，或传 null 取消')
    }
    const responder = db.getCharacter(defaultResponderId)
    if (!responder || responder.roomId !== req.params.id) {
      return fail(res, 400, '默认响应者必须是本房间的角色')
    }
  }
  // B11/B14/B15: explicitly ENABLING blind review needs an eligible reviewer
  // (designation or role pool). Turning it OFF and clearing the reviewer in
  // one PATCH is allowed — otherwise a room whose pool went stale would be
  // unable to save any setting (the checkbox was on, no way to close it).
  // Leaving an existing (now invalid) config untouched is also allowed; the
  // runtime warns and skips blind review rather than deadlocking settings.
  const nextReviewerId =
    reviewerCharacterId === undefined ? current.reviewerCharacterId : reviewerCharacterId || null
  if (blindReview === true && !nextReviewerId) {
    const hasPool = db
      .listCharacters(current.id)
      .some((character) => character.enabled && character.roles.includes('reviewer') && !character.triggers.onRoundEnd)
    if (!hasPool) {
      return fail(res, 400, '开启盲审前必须先指定 reviewer，或给至少一个角色加上「审查」角色标签')
    }
  }
  const room = db.updateRoom(req.params.id, {
    ...(typeof name === 'string' ? { name: name.trim() } : {}),
    ...(typeof topic === 'string' ? { topic: topic.trim() } : {}),
    ...(typeof workingDir === 'string' ? { workingDir: normalizeWorkingDir(workingDir) } : {}),
    ...(maxHops !== undefined ? { maxHops: normalizeMaxHops(maxHops) } : {}),
    ...(verifyCommand !== undefined ? { verifyCommand: normalizeVerifyCommand(verifyCommand) } : {}),
    ...(reviewerCharacterId !== undefined ? { reviewerCharacterId: reviewerCharacterId || null } : {}),
    ...(blindReview !== undefined ? { blindReview: blindReview === true } : {}),
    ...(defaultResponderId !== undefined ? { defaultResponderId: defaultResponderId || null } : {}),
  })
  if (!room) return fail(res, 404, '房间不存在')
  // Other tabs of the same room only hear about settings changes via SSE.
  broadcast(room.id, 'room', { roomId: room.id, room })
  res.json(room)
})

app.delete('/api/rooms/:id', (req, res) => {
  const room = db.getRoom(req.params.id)
  if (room?.isolationBranch) {
    return fail(res, 409, '该房间正在使用隔离工作树，请先解除隔离再删除房间')
  }
  orchestrator.stopRoom(req.params.id)
  db.deleteRoom(req.params.id)
  res.json({ ok: true })
})

/* --------------------------------------------------------------- isolation */

/**
 * B09: opt-in git worktree isolation. Two rooms on one repository otherwise
 * overwrite each other's files; this gives the room its own checkout and
 * branch while auto-commit keeps working unchanged.
 */
app.post('/api/rooms/:id/isolation', (req, res) => {
  const room = requireRoom(res, req.params.id)
  if (!room) return
  if (room.isolationBranch) return fail(res, 409, `已启用隔离工作树（${room.isolationBranch}）`)
  if (orchestrator.isBusy(room.id)) return fail(res, 409, '房间有回合在运行，请等它结束后再启用隔离')
  try {
    const worktree = createIsolationWorktree({ sourceDir: room.workingDir, roomId: room.id })
    const updated = db.setRoomIsolation(room.id, {
      workingDir: worktree.path,
      source: worktree.source,
      branch: worktree.branch,
    })
    if (!updated) return fail(res, 404, '房间不存在')
    broadcast(room.id, 'room', { roomId: room.id, room: updated })
    res.json({ room: updated, worktree })
  } catch (error) {
    fail(res, 400, error instanceof Error ? error.message : String(error))
  }
})

app.delete('/api/rooms/:id/isolation', (req, res) => {
  const room = requireRoom(res, req.params.id)
  if (!room) return
  if (!room.isolationBranch) return fail(res, 409, '该房间没有启用隔离工作树')
  if (orchestrator.isBusy(room.id)) return fail(res, 409, '房间有回合在运行，请等它结束后再解除隔离')
  try {
    removeIsolationWorktree({ worktreeDir: room.workingDir, sourceDir: room.isolationSource })
    const updated = db.setRoomIsolation(room.id, null)
    if (!updated) return fail(res, 404, '房间不存在')
    broadcast(room.id, 'room', { roomId: room.id, room: updated })
    res.json({ room: updated })
  } catch (error) {
    fail(res, 400, error instanceof Error ? error.message : String(error))
  }
})

/* --------------------------------------------------------------- templates */

app.get('/api/templates', (_req, res) => {
  res.json({ templates: ROOM_TEMPLATES })
})

/** Add a scenario template's characters, skipping names already in the room. */
app.post('/api/rooms/:id/templates/:templateId', (req, res) => {
  const room = requireRoom(res, req.params.id)
  if (!room) return
  const template = findRoomTemplate(req.params.templateId)
  if (!template) return fail(res, 404, '场景模板不存在')
  const existing = new Set(db.listCharacters(room.id).map((character) => character.name))
  const created: Character[] = []
  const skipped: string[] = []
  const errors: string[] = []
  for (const spec of template.characters) {
    if (existing.has(spec.name)) {
      skipped.push(spec.name)
      continue
    }
    try {
      created.push(
        db.createCharacter({
          roomId: room.id,
          name: spec.name,
          aliases: spec.aliases,
          avatar: spec.avatar,
          color: spec.color,
          harness: spec.harness,
          model: spec.model,
          persona: spec.persona,
          triggers: spec.triggers,
          skills: spec.skills,
        }),
      )
    } catch (error) {
      errors.push(`${spec.name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  res.json({ created, skipped, errors })
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
    /** SOP gate (P0-3): 'running' while the room's verification command executes. */
    gate: orchestrator.gateActive(room.id) ? 'running' : 'idle',
  })
})

/** B11 per-round evidence + diff: what the round changed and why it closed. */
function withCharacterNames(roomId: string, reports: RoundReport[]): RoundReport[] {
  const names = new Map(db.listCharacters(roomId).map((character) => [character.id, character.name]))
  return reports.map((report) => ({
    ...report,
    checks: report.checks.map((check) => ({
      ...check,
      characterName: check.characterId ? (names.get(check.characterId) ?? '（已删除角色）') : null,
    })),
  }))
}

app.get('/api/rooms/:id/rounds', (req, res) => {
  const room = requireRoom(res, req.params.id)
  if (!room) return
  const limit = Number(req.query.limit ?? 20)
  res.json({ rounds: withCharacterNames(room.id, db.listRoundReports(room.id, Number.isFinite(limit) ? limit : 20)) })
})

app.get('/api/rooms/:id/rounds/:roundId/diff', asyncRoute(async (req, res) => {
  const room = requireRoom(res, String(req.params.id))
  if (!room) return
  const roundId = String(req.params.roundId)
  const report = db.listRoundReports(room.id, 100).find((item) => item.roundId === roundId)
  if (!report) return fail(res, 404, '轮次不存在')
  if (!report.commitHash) return fail(res, 409, '这一轮没有自动提交，没有 diff 可看')
  const shown = await showCommit(room.workingDir, report.commitHash)
  if (!shown.ok) return fail(res, 400, shown.error ?? '读取 diff 失败')
  res.json({ hash: report.commitHash, text: shown.text, truncated: shown.truncated })
}))

/**
 * B11 advisory blind review: an independent reviewer reads only the original
 * request + the round's commit diff, never the chat transcript. It runs as a
 * normal (blind) turn — the verdict is posted as a new message; the already
 * closed round is not rewritten.
 */
app.post('/api/rooms/:id/rounds/:roundId/blind-review', asyncRoute(async (req, res) => {
  const room = requireRoom(res, String(req.params.id))
  if (!room) return
  if (orchestrator.isBusy(room.id)) return fail(res, 409, '房间有回合在运行，请等空闲后再盲审')
  const roundId = String(req.params.roundId)
  const report = db.listRoundReports(room.id, 100).find((item) => item.roundId === roundId)
  if (!report) return fail(res, 404, '轮次不存在')
  if (!report.commitHash) return fail(res, 409, '这一轮没有自动提交，没有 diff 可供盲审')

  const author = report.authorCharacterId ? db.getCharacter(report.authorCharacterId) : undefined
  const choice = pickReviewer({
    characters: db.listCharacters(room.id),
    designatedId: room.reviewerCharacterId,
    author: author ? { id: author.id, harness: author.harness } : null,
  })
  const reviewer = choice.reviewer
  if (!reviewer) return fail(res, 400, '没有可用的独立 reviewer（需要启用、非总结角色、且与实现者不同 harness）')

  const shown = await showCommit(room.workingDir, report.commitHash)
  if (!shown.ok) return fail(res, 400, shown.error ?? '读取 diff 失败')
  const request = report.requestMessageId ? db.getMessageById(report.requestMessageId) : undefined
  const spec = (request?.content?.trim() || report.delivery || '（未记录原始需求）').slice(0, 600)
  const diff = shown.text.slice(0, 2400)
  const override = [
    '【盲审任务】你是独立 reviewer。群聊记录、记忆与交接已被隐藏，只能依据下面的需求和 diff 判断，不要假设实现者的叙述。',
    `【原始需求】\n${spec}`,
    `【改动文件】\n${report.changedPaths.length ? report.changedPaths.join('\n') : '（无）'}`,
    `【Diff${shown.truncated || shown.text.length > diff.length ? '（已截断）' : ''}】\n${diff}`,
    '请检查正确性、边界条件、回归风险与需求覆盖；不要改代码。最后单独一行给出 REVIEW: PASS 或 REVIEW: CHANGES。',
  ].join('\n\n')
  orchestrator.runCharacter(room, reviewer, override, { blind: true })
  res.json({ ok: true, reviewer: { id: reviewer.id, name: reviewer.name, harness: reviewer.harness }, hash: report.commitHash })
}))

/** B10 observability drawer: live round + persisted checks + crash tail. */
app.get('/api/rooms/:id/observability', (req, res) => {
  const room = requireRoom(res, req.params.id)
  if (!room) return
  const activeCharacterId = orchestrator.activeCharacter(room.id)
  const queuedCharacterIds = orchestrator.queuedCharacters(room.id)
  const nameOf = (id: string | null | undefined): string | null => {
    if (!id) return null
    return db.getCharacter(id)?.name ?? '（已删除角色）'
  }
  let crash: string[] = []
  try {
    if (existsSync(CRASH_LOG)) {
      crash = readFileSync(CRASH_LOG, 'utf8').trim().split(/\r?\n/).filter(Boolean).slice(-20)
    }
  } catch {
    crash = []
  }
  res.json({
    state: {
      busy: orchestrator.isBusy(room.id),
      activeCharacterId,
      activeCharacterName: nameOf(activeCharacterId),
      activePid: orchestrator.activePid(room.id) ?? null,
      gate: orchestrator.gateActive(room.id) ? 'running' : 'idle',
      queuedCharacterIds,
      queuedNames: queuedCharacterIds.map((id) => nameOf(id) ?? '（已删除角色）'),
    },
    round: orchestrator.roundSummary(room.id),
    checks: db.listRoundChecks(room.id).slice(-40).reverse(),
    crash,
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

/* ------------------------------------------------------------------- usage */

/** Per-character token usage for a room, aggregated from harness-reported data. */
app.get('/api/rooms/:id/usage', (req, res) => {
  const room = requireRoom(res, req.params.id)
  if (!room) return
  res.json(db.getRoomUsage(room.id))
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
          sourceMessageId: message.id,
        })
      : db.addMemory({
          scope: 'room',
          ownerId: room.id,
          kind: 'fact',
          content: message.content,
          sourceRoomId: room.id,
          sourceMessageId: message.id,
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

/* ---------------------------------------------------------------- restart */

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

// B07: the skills catalog for the editor's checkbox list. Body-less entries
// only (a full skill body has no business riding every editor open), name-
// sorted. loadSkills never throws — a missing skills/ directory is a normal
// state and answers 200 + [], the UI explains where to put files.
app.get('/api/skills', (_req, res) => {
  const skills = loadSkills(SKILLS_DIR).map((skill) => ({
    name: skill.name,
    description: skill.description,
    keywords: skill.keywords,
  }))
  res.json({ dir: SKILLS_DIR, skills })
})

app.post('/api/rooms/:id/characters', (req, res) => {
  const room = requireRoom(res, req.params.id)
  if (!room) return
  const body = req.body ?? {}
  if (typeof body.name !== 'string' || !body.name.trim()) return fail(res, 400, '角色名不能为空')
  // B07: a malformed skills payload is a client bug, not a silent "no
  // skills" — dropping it here would wipe a real selection invisibly.
  if (body.skills !== undefined && !Array.isArray(body.skills)) return fail(res, 400, 'skills 必须是字符串数组')
  // B14: roles follow the same shape rule — a malformed payload must be a
  // 400, never a silent "no roles" wipe.
  if (body.roles !== undefined && !Array.isArray(body.roles)) return fail(res, 400, 'roles 必须是字符串数组')
  const inputRoles = Array.isArray(body.roles)
    ? body.roles.map((role: unknown) => String(role).trim().toLowerCase())
    : undefined
  const unknownRoles = inputRoles?.filter((role: string) => !(CHARACTER_ROLES as readonly string[]).includes(role)) ?? []
  if (unknownRoles.length > 0) return fail(res, 400, `未知角色标签：${unknownRoles.join('、')}`)

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
      skills: body.skills !== undefined ? body.skills.map(String) : undefined,
      roles: inputRoles as CharacterRole[] | undefined,
    })
    res.status(201).json(character)
  } catch (error) {
    // Ambiguous call-name (name/alias shadows a sibling) or a name the chip
    // grammar can't highlight is a user-input problem, not a server error —
    // surface it as a 400 the editor shows.
    if (error instanceof db.CallNameConflictError || error instanceof db.InvalidCallNameError) {
      return fail(res, 400, error.message)
    }
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

app.post('/api/characters/:id/sync-preset', (req, res) => {
  const character = db.getCharacter(req.params.id)
  if (!character) return fail(res, 404, '角色不存在')
  // Linked characters know their template. Legacy rows (created before
  // preset_id existed) can adopt a unique same-name template instead.
  const linked = character.presetId ? db.getPreset(character.presetId) : undefined
  const sameName = linked ? [] : db.listPresets().filter((preset) => preset.name === character.name)
  const preset = linked ?? (sameName.length === 1 ? sameName[0] : undefined)
  if (!preset) {
    return fail(
      res,
      409,
      character.presetId
        ? '角色库里的模板已被删除，无法对齐；请先在角色库重建同名模板'
        : '这个角色不是从角色库添加的（也没有唯一的同名模板），无法对齐',
    )
  }
  try {
    res.json(db.syncCharacterFromPreset(character, preset))
  } catch (error) {
    if (error instanceof db.CallNameConflictError || error instanceof db.InvalidCallNameError) {
      return fail(res, 400, error.message)
    }
    throw error
  }
})

app.patch('/api/characters/:id', (req, res) => {
  const current = db.getCharacter(req.params.id)
  if (!current) return fail(res, 404, '角色不存在')
  const body = req.body ?? {}
  // B07: same shape rule as POST — a non-array skills patch is a 400, never
  // a silent selection wipe.
  if (body.skills !== undefined && !Array.isArray(body.skills)) return fail(res, 400, 'skills 必须是字符串数组')
  if (body.roles !== undefined && !Array.isArray(body.roles)) return fail(res, 400, 'roles 必须是字符串数组')
  const inputRoles = Array.isArray(body.roles)
    ? body.roles.map((role: unknown) => String(role).trim().toLowerCase())
    : undefined
  const unknownRoles = inputRoles?.filter((role: string) => !(CHARACTER_ROLES as readonly string[]).includes(role)) ?? []
  if (unknownRoles.length > 0) return fail(res, 400, `未知角色标签：${unknownRoles.join('、')}`)
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
      ...(body.skills !== undefined ? { skills: body.skills.map(String) } : {}),
      ...(inputRoles !== undefined ? { roles: inputRoles as CharacterRole[] } : {}),
    })
    res.json(character)
  } catch (error) {
    if (error instanceof db.CallNameConflictError || error instanceof db.InvalidCallNameError) {
      return fail(res, 400, error.message)
    }
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

/* ------------------------------------------------------------------- tasks */

/** Field caps (B03): everything lands truncated in the DB, never in the UI. */
function normalizeTaskField(value: unknown, max: number): string {
  return typeof value === 'string' ? truncate(value.trim(), max) : ''
}

/** The assignee must be an enabled member of this room — checked on create, edit AND approve/dispatch. */
function requireAssignee(res: Response, roomId: string, assigneeId: string | null): Character | undefined {
  if (!assigneeId) {
    fail(res, 400, '卡片没有负责人，请先指定负责人')
    return undefined
  }
  const character = db.getCharacter(assigneeId)
  if (!character || character.roomId !== roomId) {
    fail(res, 400, '负责人必须是本房间的角色')
    return undefined
  }
  if (!character.enabled) {
    fail(res, 400, '负责人已停用，请先启用或换人')
    return undefined
  }
  return character
}

/**
 * The card's message body (B03): ONE system message carries the whole card,
 * and that message IS the prompt truth — no second serialization layer. The
 * assignee line is display only; the wake is by id (startTaskRound).
 */
function taskCardContent(task: Task, assigneeName: string, prefix: string): string {
  return [
    `${prefix}${task.title}`,
    task.what,
    task.why ? `为什么：${task.why}` : '',
    task.acceptance ? `验收标准：${task.acceptance}` : '',
    `负责人：@${assigneeName}`,
  ]
    .filter(Boolean)
    .join('\n')
}

app.get('/api/rooms/:id/tasks', (req, res) => {
  const room = requireRoom(res, req.params.id)
  if (!room) return
  res.json({ tasks: db.listTasks(room.id) })
})

app.get('/api/tasks/:id', (req, res) => {
  const task = db.getTask(req.params.id)
  if (!task) return fail(res, 404, '任务卡不存在')
  res.json(task)
})

app.post('/api/rooms/:id/tasks', (req, res) => {
  const room = requireRoom(res, req.params.id)
  if (!room) return
  const body = req.body ?? {}
  const title = normalizeTaskField(body.title, 120)
  const what = normalizeTaskField(body.what, 4_000)
  if (!title) return fail(res, 400, '任务标题不能为空')
  if (!what) return fail(res, 400, '任务内容（要做什么）不能为空')
  const assigneeId = typeof body.assigneeId === 'string' && body.assigneeId ? body.assigneeId : null
  if (assigneeId && !requireAssignee(res, room.id, assigneeId)) return
  const task = db.createTask({
    roomId: room.id,
    title,
    what,
    why: normalizeTaskField(body.why, 2_000),
    acceptance: normalizeTaskField(body.acceptance, 2_000),
    assigneeId,
  })
  broadcast(room.id, 'task', { roomId: room.id, task })
  res.status(201).json(task)
})

app.patch('/api/tasks/:id', (req, res) => {
  const task = db.getTask(req.params.id)
  if (!task) return fail(res, 404, '任务卡不存在')
  const room = requireRoom(res, task.roomId)
  if (!room) return
  const body = req.body ?? {}
  const nextStatus = typeof body.status === 'string' ? body.status : undefined

  if (nextStatus === 'approved') {
    if (task.status !== 'proposed') return fail(res, 409, `只有待批准的卡片才能批准（当前：${task.status}）`)
    const assignee = requireAssignee(res, room.id, task.assigneeId)
    if (!assignee) return
    // One synchronous section: state flip → card message → assignee turn.
    // Rejection and dispatch never reach here twice (409 above), so exactly
    // one round and one assignee turn per approval — idempotence by state.
    // The card goes straight to `running` (B03 review 1): the old fleeting
    // `approved` state had NO exit — a queued turn swept by a stop (or an
    // assignee disabled mid-queue) left the card neither terminal nor
    // actionable. `running` always keeps the re-dispatch door open.
    const approved = db.updateTask(task.id, { status: 'running', approvedAt: Date.now(), result: null, doneAt: null })
    const message = db.addMessage({
      roomId: room.id,
      authorType: 'system',
      authorName: '系统',
      content: taskCardContent(approved ?? task, assignee.name, '【任务卡】'),
      meta: { generated: true, taskId: task.id },
    })
    broadcast(room.id, 'message', { roomId: room.id, message })
    orchestrator.startTaskRound(room, approved ?? task, message)
    const updated = db.getTask(task.id)
    if (updated) broadcast(room.id, 'task', { roomId: room.id, task: updated })
    return res.json(updated)
  }

  if (nextStatus === 'rejected') {
    if (task.status !== 'proposed') return fail(res, 409, `只有待批准的卡片才能驳回（当前：${task.status}）`)
    // Rejection triggers NOTHING: no round, no message — the card itself
    // stays queryable (T4).
    const updated = db.updateTask(task.id, { status: 'rejected' })
    if (updated) broadcast(room.id, 'task', { roomId: room.id, task: updated })
    return res.json(updated)
  }

  if (nextStatus !== undefined) {
    return fail(res, 409, '状态只能通过批准（approved）或驳回（rejected）变更；进行中的卡片用重新派发')
  }

  // Plain field edit — content fields only while proposed (they already
  // shipped to the prompt; editing them retroactively would desync the
  // transcript). The ASSIGNEE may be re-pointed on any non-terminal card:
  // that is the exit for a disabled/deleted assignee mid-run (B03 review 1
  // — a stuck card must always keep at least one usable action).
  if (task.status === 'done' || task.status === 'rejected') {
    return fail(res, 409, '已完结的卡片不能修改')
  }
  const contentEdit =
    body.title !== undefined || body.what !== undefined || body.why !== undefined || body.acceptance !== undefined
  if (contentEdit && task.status !== 'proposed') {
    return fail(res, 409, '内容字段只有待批准的卡片才能修改；进行中的卡片可换负责人后重新派发')
  }
  const title = body.title !== undefined ? normalizeTaskField(body.title, 120) : task.title
  const what = body.what !== undefined ? normalizeTaskField(body.what, 4_000) : task.what
  if (!title) return fail(res, 400, '任务标题不能为空')
  if (!what) return fail(res, 400, '任务内容（要做什么）不能为空')
  const assigneeId =
    body.assigneeId !== undefined
      ? typeof body.assigneeId === 'string' && body.assigneeId
        ? body.assigneeId
        : null
      : task.assigneeId
  if (assigneeId && !requireAssignee(res, room.id, assigneeId)) return
  const updated = db.updateTask(task.id, {
    ...(body.title !== undefined ? { title } : {}),
    ...(body.what !== undefined ? { what } : {}),
    ...(body.why !== undefined ? { why: normalizeTaskField(body.why, 2_000) } : {}),
    ...(body.acceptance !== undefined ? { acceptance: normalizeTaskField(body.acceptance, 2_000) } : {}),
    ...(body.assigneeId !== undefined ? { assigneeId } : {}),
  })
  if (updated) broadcast(room.id, 'task', { roomId: room.id, task: updated })
  res.json(updated)
})

app.post('/api/tasks/:id/dispatch', (req, res) => {
  const task = db.getTask(req.params.id)
  if (!task) return fail(res, 404, '任务卡不存在')
  const room = requireRoom(res, task.roomId)
  if (!room) return
  if (task.status !== 'running') return fail(res, 409, '只有进行中的卡片才能重新派发')
  const assignee = requireAssignee(res, room.id, task.assigneeId)
  if (!assignee) return
  // Clear the blocked verdict and re-send the card: the assignee's next
  // prompt (often a resumed session) must carry the card again in full.
  const redispatched = db.updateTask(task.id, { result: null, doneAt: null })
  const message = db.addMessage({
    roomId: room.id,
    authorType: 'system',
    authorName: '系统',
    content: taskCardContent(redispatched ?? task, assignee.name, '【任务卡·重新派发】'),
    meta: { generated: true, taskId: task.id },
  })
  broadcast(room.id, 'message', { roomId: room.id, message })
  orchestrator.startTaskRound(room, redispatched ?? task, message)
  const updated = db.getTask(task.id)
  if (updated) broadcast(room.id, 'task', { roomId: room.id, task: updated })
  res.json(updated)
})

/* ------------------------------------------------------------------ static */

// M1 media: serves generated images/videos for the rewritten markdown links.
// Mounted BEFORE the static/SPA block — and /api is explicitly excluded from
// the SPA fallback below, so this route keeps priority either way.
app.get('/api/files', mediaFileHandler)

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
  // Restore the queue a hard-killed server left behind (P0-2). AFTER listen
  // on purpose: restored items start pumping the moment this returns, and
  // the turns they spawn must not outrun the port they answer through.
  const queuedTurns = db.listAllQueuedTurns()
  if (queuedTurns.length > 0) orchestrator.restoreQueues(queuedTurns)
  // B12: continue turns a hard restart interrupted (partial output only).
  if (interruptedAtBoot.length > 0) orchestrator.recoverInterrupted(interruptedAtBoot)
})
