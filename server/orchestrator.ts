import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import * as db from './db.ts'
import { broadcast } from './events.ts'
import { getAdapter } from './harnesses/index.ts'
import { isTransientFailure, RESUME_BREAKER_LIMIT, resumeAttempts, resumeIdleTimeoutMs, timeoutRecoveryPlan } from './harnesses/process.ts'
import { changedPathsBetween, commitPaths, renderWorktreeDiff, snapshotWorktree } from './gitstate.ts'
import { ALL_MENTION, matchNames, visibleText } from './mentions.ts'
import { buildTurnPromptDetailed } from './prompt.ts'
import { episodeDelivery, memoryQueryFromMessages } from './memory.ts'
import { buildHandoff, type HandoffInput } from './handoff.ts'
import { isIndependentReviewerVerdict, pickReviewer, resolveRoundReviewer } from './reviewers.ts'
// Circular with restart.ts (it imports isBusy): safe - both sides only call
// functions at runtime, never at module top level.
import { maybeRestartNow } from './restart.ts'
import { repoRootCached } from './worktree.ts'
import { gateDecision, parseReviewVerdict, type GateAuthor, type GateBlockReason } from './sop.ts'
import { rewriteMediaLines } from './media.ts'
import { loadSkills } from './skills.ts'
import { SKILLS_DIR } from './paths.ts'
import type { Character, HarnessKind, Message, Room, RoundSummary, Task, ToolTrace, Turn } from './types.ts'
import { tail, truncate } from './util.ts'

interface QueueItem {
  /** Turn row this queue entry persists as (turns double as the queue, P0-2). */
  turnId: string
  characterId: string
  triggerMessageId: string | null
  /** Manual instruction from the "让它发言" button. */
  override?: string
  /**
   * Relay depth: 1 for every target a human message wakes directly (including
   * each member of an @all expansion, and the manual "run" action), +1 for
   * every character-to-character hand-off. The budget check compares this
   * against `room.maxHops`, so @all still reaches everyone in rooms with more
   * enabled characters than maxHops.
   */
  hop: number
  /**
   * Marks the automatic second attempt of a turn that failed with zero
   * output (loop guard: a failure is retried exactly once, never twice).
   */
  retry?: boolean
  /**
   * M3 timeout-recovery rung: 0/undefined = ordinary turn, 1..N = the Nth
   * automatic resume, 2+ with a report instruction = the fresh-session
   * wrap-up round. Persisted on the turn row so a reboot restores the rung;
   * the run's idle budget derives from it (resume turns ride the shorter
   * AC_RESUME_IDLE_TIMEOUT_MS watchdog).
   */
  resumeAttempt?: number
  /**
   * Marks a round-end summary turn. Summary turns are injected by the
   * orchestrator itself (not by any message) and must never count as round
   * activity, so they can't resurrect a round that is being closed out.
   */
  isRoundSummary?: boolean
  /**
   * The round this turn belongs to (SOP gate, P0-3): one roundId per human
   * message / manual run, inherited by every relay hand-off and steer it
   * triggers. Restored turns keep their persisted roundId but own no live
   * RoundState (the reboot cut that round).
   */
  roundId?: string | null
  /** Task card this queued turn executes (B03), inherited by relay hand-offs. */
  taskId?: string | null
  /** B11 blind review: suppress transcript/memory/skills for this turn. */
  blind?: boolean
  /** B12: 1 = this turn continues a restart-interrupted turn (no re-recovery). */
  restartRecovery?: number
}

/** Replay buffer for the running turn, so clients that join mid-turn can catch up. */
interface TurnReplay {
  text: string
  thinking: string[]
  tools: string[]
}

interface ActiveTurn {
  turnId: string
  characterId: string
  controller: AbortController
  startedAt: number
  /** Pid of the running turn's CLI process, set as soon as it spawns. */
  pid?: number
  replay: TurnReplay
}

/** Snapshot of the running turn handed to late/reconnecting clients. */
export interface LiveTurnSnapshot {
  turnId: string
  characterId: string
  text: string
  thinking: string[]
  tools: string[]
  startedAt: number
  /** Pid of the CLI process behind this turn, once it has spawned. */
  pid?: number
}

interface ChainState {
  limitNoticeSent: boolean
}

/**
 * Lifecycle of one conversation round (the chain of turns a single human
 * message / manual run kicks off, including every relay hand-off):
 * - `hadTurn` flips true the moment a real (non-summary) turn starts, so
 *   rounds that never ran anything (e.g. all mentioned characters disabled)
 *   close out without a summary;
 * - `summarizing` marks "the round-end summary is already scheduled/ran" —
 *   it both prevents the summary's own relay echo from re-triggering the
 *   summary and lets the round close cleanly on the next empty-queue visit;
 * - `endReason` is fed into the summary instruction so the summarizer can
 *   say why the round ended;
 * - the SOP-gate fields (`roundId`/`changedPaths`/`verdict`/`verifyState`/
 *   `gateNoticeSent`, P0-3) decide whether a round that CHANGED the worktree
 *   may close: verdict must be pass, and when the room configured a verify
 *   command the server must have run it to a pass. A new human message or
 *   manual run replaces the entry (new round); a manual stop deletes it.
 */
interface RoundState {
  roundId: string
  hadTurn: boolean
  summarizing: boolean
  endReason: 'completed' | 'limit'
  /** Worktree paths any turn of this round changed so far (union, 3a). */
  changedPaths: string[]
  /** Latest REVIEW: verdict seen in this round's character messages (3b). */
  verdict: 'none' | 'pass' | 'changes'
  /** Author of that verdict (B05) — the self-review ban needs WHO passed. */
  verdictAuthor?: GateAuthor | null
  /** Author of the round's last turn that changed the worktree (B05). */
  changedAuthor?: GateAuthor | null
  /** Verification command outcome for this round (3c); 'running' guards re-entry. */
  verifyState: 'none' | 'running' | 'pass' | 'fail'
  /** The gate notice fires at most once per round — repeat blocks stay silent. */
  gateNoticeSent: boolean
  /**
   * S13: the round's auto-commit is in flight. A re-entrant pump visit while
   * the commit awaits (the verify early-return doesn't cover this window)
   * must not run a second commit for the same round — the retry usually
   * degrades to a misleading "nothing to commit" notice, and at worst
   * collides on index.lock.
   */
  autoCommitStarted?: boolean
  /**
   * Terminal state of this round's last NON-SUMMARY turn (B03 review 2):
   * 'ok' | 'error' | 'stopped'. A round that ended in error/stopped must not
   * settle its task card as done — 'done' would read as "the work finished"
   * when the run actually died; the card stays running for a re-dispatch.
   */
  lastTurnOutcome: 'ok' | 'error' | 'stopped'
  /**
   * The round's delivery line for the episode memory (B04): the last real
   * (non-summary) reply, verdict lines stripped, whitespace collapsed, 160
   * chars. Summary turns never overwrite it — memories must not memorialize
   * the summary of the round instead of the round itself.
   */
  lastDelivery?: string
  /** Last real turn's error text (B08) — the failure lesson's root cause. */
  lastError?: string
  /** B11: this round already queued its pre-commit blind review. */
  blindReviewQueued?: boolean
  /** B11: the ineligible-reviewer notice fires at most once per round. */
  blindWarned?: boolean
  /** B14: reviewer chosen from the role pool when no explicit designation. */
  blindReviewer?: { id: string; name: string; harness: HarnessKind }
  /** B15: automatic repair rounds already started for this round. */
  repairCount: number
  /** B15: the message that carried the review verdict (repair feedback). */
  verdictMessageId?: string
  /** Task card this round executes (B03); undefined on ordinary chat rounds. */
  taskId?: string
}

const queues = new Map<string, QueueItem[]>()
const active = new Map<string, ActiveTurn>()
const chains = new Map<string, ChainState>()
const rounds = new Map<string, RoundState>()

/**
 * Verification runs in flight (SOP gate, P0-3), reference counted per room:
 * a human message arriving mid-verify can open a new round whose OWN verify
 * overlaps the first one — with a Set, the FIRST run's finally would drop
 * the room's flag while the second is still running (review round 3), and
 * a pending restart would slip through mid-verify. The counter only clears
 * when the last overlapping run settles.
 */
const verifyRuns = new Map<string, number>()

/** True while the room has a verification command running — the restart drain must wait for it. */
export function gateActive(roomId: string): boolean {
  return (verifyRuns.get(roomId) ?? 0) > 0
}

/**
 * Cross-room execution lock (B10): non-isolated rooms pointing at the same
 * directory must not run turns concurrently — two CLIs writing the same files
 * overwrite each other and mix commits. Isolated rooms have their own
 * worktree, so they get no key and never wait.
 */
const workdirLocks = new Map<string, { roomId: string; count: number }>()

function workdirKey(room: Room): string | null {
  if (room.isolationBranch) return null
  // Key on the REPOSITORY root, not the configured directory: two rooms may
  // point at the same repo through different subdirectories (a common setup)
  // and still overwrite each other's files.
  const root = repoRootCached(room.workingDir) ?? room.workingDir
  return resolve(root).replace(/[\\/]+$/, '').toLowerCase()
}

function acquireWorkdir(room: Room): boolean {
  const key = workdirKey(room)
  if (!key) return true
  const holder = workdirLocks.get(key)
  if (holder && holder.roomId !== room.id) return false
  if (holder) holder.count += 1
  else workdirLocks.set(key, { roomId: room.id, count: 1 })
  return true
}

/**
 * Ref-counted release: one turn's finally can overlap the nested pump that
 * already started the next turn (or the verify command), so the directory is
 * handed to another room only when the LAST holder lets go.
 */
function releaseWorkdir(room: Room): void {
  const key = workdirKey(room)
  if (!key) return
  const holder = workdirLocks.get(key)
  if (!holder || holder.roomId !== room.id) return
  holder.count -= 1
  if (holder.count > 0) return
  workdirLocks.delete(key)
  for (const [otherId, queue] of queues) {
    if (otherId === room.id || queue.length === 0) continue
    const other = db.getRoom(otherId)
    if (other && workdirKey(other) === key) void pump(otherId)
  }
}

/** Fresh round state for a new human message / manual run (SOP gate fields included). */
function newRoundState(taskId?: string): RoundState {
  return {
    roundId: randomUUID(),
    hadTurn: false,
    summarizing: false,
    endReason: 'completed',
    changedPaths: [],
    verdict: 'none',
    verifyState: 'none',
    gateNoticeSent: false,
    lastTurnOutcome: 'ok',
    repairCount: 0,
    taskId,
  }
}

/** Bound the replay buffers so a chatty turn can't grow memory forever (mirrors the UI's tail-60). */
const REPLAY_CAP = 60
/** Upper bound for the replayed text tail. */
const REPLAY_TEXT_CAP = 200_000

/** Verification command budget (SOP gate, P0-3): a room verify must answer within 5 minutes. */
const VERIFY_TIMEOUT_MS = 300_000

/**
 * B15: maximum automatic repair rounds per round after a REVIEW: CHANGES.
 * 0 disables auto-repair entirely. Default 1 = one fix attempt, then a human
 * (or a new message) has to decide.
 */
function autoRepairLimit(): number {
  const raw = Number(process.env.AC_AUTO_REPAIR_LIMIT ?? 1)
  return Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 1
}
/**
 * Fetch limit for a resumed turn's increment (B01). Beyond it (a pathological
 * flood — >1000 messages between two turns of one character) the fetch
 * saturates: the overflow rides along as a fold COUNT (never a silent skip)
 * and a non-user-visible log line, because the user already sees every
 * message in the room.
 */
const RESUME_FETCH_LIMIT = 1_000
/** Rolling output window kept while the command runs; the tail is where a failure explains itself. */
const VERIFY_OUTPUT_CHARS = 4_000
/** Output tail kept for the round_checks row and the gate notice (a TRUE tail — see `tail()`). */
const VERIFY_DETAIL_CHARS = 1_500
/** Grace for the timeout kill to land before the run is force-settled. */
const VERIFY_KILL_BACKSTOP_MS = 10_000

export function isBusy(roomId: string): boolean {
  return active.has(roomId)
}

export function activeCharacter(roomId: string): string | null {
  return active.get(roomId)?.characterId ?? null
}

/** Pid of the CLI process behind the running turn, if it already spawned. */
export function activePid(roomId: string): number | undefined {
  return active.get(roomId)?.pid
}

export function queuedCharacters(roomId: string): string[] {
  return (queues.get(roomId) ?? []).map((item) => item.characterId)
}

/** Snapshot of the room's live round for the observability drawer (B10). */
export function roundSummary(roomId: string): RoundSummary | null {
  const round = rounds.get(roomId)
  if (!round) return null
  return {
    roundId: round.roundId,
    hadTurn: round.hadTurn,
    verdict: round.verdict,
    verifyState: round.verifyState,
    changedPaths: [...round.changedPaths],
    lastTurnOutcome: round.lastTurnOutcome,
    endReason: round.endReason,
  }
}

/** Running-turn snapshot for clients that (re)join mid-turn. */
export function liveTurn(roomId: string): LiveTurnSnapshot | null {
  const entry = active.get(roomId)
  if (!entry) return null
  return {
    turnId: entry.turnId,
    characterId: entry.characterId,
    text: entry.replay.text,
    thinking: [...entry.replay.thinking],
    tools: [...entry.replay.tools],
    startedAt: entry.startedAt,
    pid: entry.pid,
  }
}

/**
 * A human message routes strictly by mention (name or alias):
 * - `@all` / `@所有人` wakes every enabled character;
 * - `@name` / `@alias` wakes only the mentioned characters;
 * - mentioning only disabled characters wakes nobody — a system notice
 *   explains why — instead of falling through to a bystander;
 * - no mention (or a name that matches nobody) falls back to the first
 *   enabled character.
 * Mentions inside code spans/blocks/link labels are quoted text, not calls
 * (`visibleText`), so `` `@GLM` `` in a message asking the user to decide
 * wakes nobody.
 * The relay budget resets on every human message.
 */
export function handleUserMessage(room: Room, message: Message): void {
  chains.set(room.id, { limitNoticeSent: false })
  const round = newRoundState()
  rounds.set(room.id, round)
  const everyone = db.listCharacters(room.id)
  const enabled = everyone.filter((character) => character.enabled)
  // Extract once, match per member: the same text is scanned for every character.
  const plain = visibleText(message.content)
  let targets: Character[]
  if (ALL_MENTION.test(plain)) {
    targets = enabled
  } else {
    const mentionedAny = everyone.filter((character) => matchNames(character, plain))
    const mentioned = mentionedAny.filter((character) => character.enabled)
    if (mentioned.length > 0) {
      targets = mentioned
    } else if (mentionedAny.length > 0) {
      const names = mentionedAny.map((character) => character.name).join('、')
      const notice = db.addMessage({
        roomId: room.id,
        authorType: 'system',
        authorName: '系统',
        content: `被 @ 的角色（${names}）当前已停用，本轮无人响应。`,
      })
      broadcast(room.id, 'message', { roomId: room.id, message: notice })
      targets = []
    } else {
      // B14: an explicit default responder owns the no-@ case; a disabled or
      // deleted designation falls back to the legacy first-enabled rule.
      const preferred = room.defaultResponderId
        ? enabled.find((character) => character.id === room.defaultResponderId)
        : undefined
      targets = preferred ? [preferred] : enabled.slice(0, 1)
    }
  }
  for (const character of targets) {
    // Human intent is explicit: a message aimed at a character that is
    // mid-turn queues a follow-up run for right after, instead of being
    // silently dropped by the dedupe (relay hand-offs keep the dedupe).
    enqueue(room.id, character.id, message.id, 1, undefined, {
      allowActive: true,
      roundId: round.roundId,
    })
  }
  void pump(room.id)
}

/** Queue one character manually (the "让它发言" action). */
/**
 * B12 restart self-healing: continue the turns a hard restart interrupted.
 * Only the PARTIAL-OUTPUT case is auto-recovered — a turn killed before any
 * text is better left to the human (auto-retrying it could redo a side-effect
 * action blindly). The continuation runs as a normal turn in a fresh round;
 * its prompt still carries the transcript (including the partial reply posted
 * below) and the recovery instruction. `restartRecovery=1` prevents a second
 * interruption from looping.
 */
export function recoverInterrupted(turns: Turn[]): void {
  if (process.env.AC_RESTART_RECOVERY === '0') {
    if (turns.length > 0) console.log('[agent-crowd] restart recovery disabled (AC_RESTART_RECOVERY=0)')
    return
  }
  const seenRooms = new Set<string>()
  for (const turn of turns) {
    if (turn.isRoundSummary || turn.restartRecovery > 0) continue
    if (seenRooms.has(turn.roomId)) continue
    const partial = turn.output.trim()
    if (!partial) continue
    const room = db.getRoom(turn.roomId)
    const character = db.getCharacter(turn.characterId)
    if (!room || !character || !character.enabled) continue
    // Pending queued work wins: mixing a recovery round with restored queue
    // turns would attach them to the wrong RoundState. The user already has
    // work waiting; the interrupted turn stays in the normal error path.
    if (db.listQueuedTurns(room.id).length > 0) continue
    seenRooms.add(room.id)

    const partialMessage = db.addMessage({
      roomId: room.id,
      authorType: 'character',
      characterId: character.id,
      authorName: character.name,
      authorAvatar: character.avatar,
      color: character.color,
      content: partial,
      meta: {
        harness: character.harness,
        model: character.model,
        turnId: turn.id,
        generated: true,
        error: '服务器重启中断的部分输出',
      },
    })
    broadcast(room.id, 'message', { roomId: room.id, message: partialMessage })

    const override = [
      '系统恢复任务：你上一回合因服务器重启被强制中断（CLI 进程已结束）。',
      '上面那条带「服务器重启中断的部分输出」标记的消息，是中断前已经产出的内容；请从中断处继续完成原任务。',
      '已完成的部分不要重复，直接补完剩余工作并给出最终回复；如果原任务其实已经完成，明确说明并收尾。',
    ].join('\n')
    chains.set(room.id, { limitNoticeSent: false })
    const round = newRoundState(turn.taskId ?? undefined)
    rounds.set(room.id, round)
    enqueue(room.id, character.id, null, 1, override, {
      allowActive: true,
      roundId: round.roundId,
      taskId: turn.taskId ?? null,
      restartRecovery: 1,
    })
    const notice = db.addMessage({
      roomId: room.id,
      authorType: 'system',
      authorName: '系统',
      content: `🔁 检测到「${character.name}」上一回合因重启中断，已自动续跑一次（保留部分输出）。`,
      meta: { generated: true },
    })
    broadcast(room.id, 'message', { roomId: room.id, message: notice })
    void pump(room.id)
  }
}

export function runCharacter(
  room: Room,
  character: Character,
  override?: string,
  options?: { blind?: boolean },
): void {
  chains.set(room.id, { limitNoticeSent: false })
  const round = newRoundState()
  rounds.set(room.id, round)
  enqueue(room.id, character.id, null, 1, override, {
    allowActive: true,
    roundId: round.roundId,
    blind: options?.blind,
  })
  void pump(room.id)
}

/**
 * Approval / re-dispatch of a task card (B03): open a fresh round bound to
 * the card and wake ONLY the assignee. The assignee is a data field, not
 * text — no @ parsing, no "first enabled character" fallback. A busy room
 * queues the turn behind the running one instead of dropping it.
 */
export function startTaskRound(room: Room, task: Task, message: Message): void {
  const assignee = task.assigneeId ? db.getCharacter(task.assigneeId) : undefined
  if (!task.assigneeId || !assignee) return
  chains.set(room.id, { limitNoticeSent: false })
  const round = newRoundState(task.id)
  rounds.set(room.id, round)
  // The card's round anchor — settlement writes back through this id, and a
  // re-dispatch repoints it before the old round can settle late.
  db.updateTask(task.id, { roundId: round.roundId })
  enqueue(room.id, task.assigneeId, message.id, 1, undefined, {
    allowActive: true,
    roundId: round.roundId,
    taskId: task.id,
  })
  void pump(room.id)
}

/**
 * A mid-turn steer note (「中途补充指令」): the user's extra instruction lands
 * in the transcript and the target re-runs with it baked into the prompt.
 *
 * If the target is the active speaker its in-flight run is aborted first
 * (partial text is preserved as a stopped reply, same as the stop button), so
 * the steer takes effect now instead of after a possibly-long turn. A target
 * that is only queued gets re-aimed at the steer note in place; an idle target
 * is simply woken like a direct call.
 */
export function steer(room: Room, target: Character, message: Message): void {
  const queue = queues.get(room.id) ?? []
  const current = active.get(room.id)
  const activeIsTarget = current?.characterId === target.id
  const interrupted = activeIsTarget ? current.replay.text.trim() : ''
  const override = interrupted
    ? `用户在你上一轮说到一半时插入了补充指令（聊天记录里「用户（中途补充给 ${target.name}）」那条，其后是你被打断的半截回复）。请把补充指令并入本轮要求，给出最终的完整回复。`
    : `用户插入了补充指令（聊天记录里「用户（中途补充给 ${target.name}）」那条）。请把它并入本轮要求后发言。`

  // A steer lands inside the running round when there is one — its turn joins
  // that round's SOP gate accounting (the work it triggers belongs to the
  // round the user is steering). No live round (idle steer) → null: the turn
  // records evidence but no round closes on it.
  const roundId = rounds.get(room.id)?.roundId ?? null

  const queued = queue.find((item) => item.characterId === target.id)
  if (queued) {
    // Already waiting its turn: re-aim the pending item at the steer note,
    // in memory AND on its turn row (a restart restores the row, so the
    // re-aim must survive it).
    queued.triggerMessageId = message.id
    queued.override = override
    db.updateQueuedTurn(queued.turnId, { triggerMessageId: message.id, override })
    queues.set(room.id, queue)
    broadcast(room.id, 'queue', { roomId: room.id, characters: queue.map((item) => item.characterId) })
  } else if (activeIsTarget) {
    // Kill the in-flight run so the rerun starts right away. The active
    // entry survives until the aborted run settles, so the rerun has to
    // bypass enqueue()'s "already active" dedupe and take the head of the
    // queue (the target was running, so it keeps its position).
    current.controller.abort()
    const turn = db.createTurn({
      roomId: room.id,
      characterId: target.id,
      triggerMessageId: message.id,
      hop: 1,
      override,
      roundId,
    })
    queue.unshift({
      turnId: turn.id,
      characterId: target.id,
      triggerMessageId: message.id,
      hop: 1,
      override,
      roundId,
    })
    queues.set(room.id, queue)
    broadcast(room.id, 'queue', { roomId: room.id, characters: queue.map((item) => item.characterId) })
  } else {
    // Idle target: wake it like a direct call. allowActive bypasses the
    // same-character dedupe (unreachable here — that item went through the
    // `queued` branch); enqueue persists the turn row.
    enqueue(room.id, target.id, message.id, 1, override, { allowActive: true, roundId })
  }
  void pump(room.id)
}

export function stopRoom(roomId: string): void {
  const current = active.get(roomId)
  if (current) current.controller.abort()
  // Sweep the queued turn rows too (P0-2): without this a hard kill + reboot
  // would resurrect a round the user asked to silence — 'stopped' rows are
  // never restored by restoreQueues().
  db.markQueuedTurnsStopped(roomId, '用户手动停止')
  queues.set(roomId, [])
  chains.delete(roomId)
  // Manual stop = the user asked for silence: close the round without a
  // summary (the aborted turn's settlement re-pumps into an empty queue).
  rounds.delete(roomId)
  broadcast(roomId, 'queue', { roomId, characters: [] })
}

/**
 * Boot-time queue restore (P0-2): rehydrate the in-memory queues from the
 * 'queued' turn rows a hard-killed server left behind, then resume pumping.
 * Called from index.ts AFTER app.listen — restored items start running the
 * moment this returns, and that must not outrun the port being up.
 *
 * Rows whose room or character is gone (deleted mid-queue, disabled while
 * waiting) are swept to 'stopped' instead of restored — no resurrecting
 * runs the live system would have refused to start.
 *
 * The restored round belongs to no round at all: this function deliberately
 * creates NO `rounds` entry (review fix — the old hadTurn:false entry was
 * flipped back to true by pump() the moment the first restored turn started,
 * so the summary fired anyway). Both pump()'s hadTurn flip and
 * maybeStartRoundSummary()'s no-entry early return no-op on a room without
 * an entry, so pre-restart activity never earns a summary: the reboot
 * already cut that round, and summarizing its remains is noise. A human
 * message or manual run while the restored queue is still draining starts a
 * fresh entry as usual, and only turns after that count toward its summary.
 */
export function restoreQueues(turns: Turn[]): void {
  const byRoom = new Map<string, Turn[]>()
  for (const turn of turns) {
    const list = byRoom.get(turn.roomId) ?? []
    list.push(turn)
    byRoom.set(turn.roomId, list)
  }
  for (const [roomId, roomTurns] of byRoom) {
    const room = db.getRoom(roomId)
    const queue: QueueItem[] = []
    for (const turn of roomTurns) {
      const character = db.getCharacter(turn.characterId)
      const reason = !room
        ? '房间已被删除'
        : !character
          ? '角色已被删除'
          : !character.enabled
            ? '角色已停用'
            : null
      if (reason) {
        db.updateTurn(turn.id, { status: 'stopped', error: reason, endedAt: Date.now() })
        continue
      }
      // Restored items keep their persisted scheduling flags (hop/override/
      // retry/resumeAttempt/isRoundSummary/taskId): a restart must not zero
      // the relay budget, re-aim a steer, re-arm the retry loop guard,
      // demote an M3 recovery rung to an ordinary turn, let a summary turn
      // start relaying, or drop a task card's association.
      queue.push({
        turnId: turn.id,
        characterId: turn.characterId,
        triggerMessageId: turn.triggerMessageId,
        hop: turn.hop,
        override: turn.override ?? undefined,
        retry: turn.retry || undefined,
        resumeAttempt: turn.resumeAttempt || undefined,
        restartRecovery: turn.restartRecovery || undefined,
        isRoundSummary: turn.isRoundSummary || undefined,
        roundId: turn.roundId,
        taskId: turn.taskId,
      })
    }
    if (queue.length === 0) continue
    queues.set(roomId, queue)
    // No `rounds` entry here — see the docblock above: a restored round must
    // drain without a round-end summary (queue-check Q6 pins this).
    chains.set(roomId, { limitNoticeSent: false })
    broadcast(roomId, 'queue', { roomId, characters: queue.map((item) => item.characterId) })
    void pump(roomId)
  }
}

/** The part of a message the wake rules actually read (a real row or a not-yet-saved reply). */
type WakeSubject = Pick<Message, 'authorType' | 'characterId' | 'authorName' | 'content'>

function shouldWake(character: Character, message: WakeSubject, plain: string): boolean {
  if (!character.enabled) return false
  const mention = mentions(character, plain)
  if (message.authorType === 'user') return character.triggers.onUser || mention
  if (message.authorType !== 'character') return false

  const fromListed =
    character.triggers.onAll ||
    (message.characterId !== null && character.triggers.onCharacters.includes(message.characterId)) ||
    (message.authorType === 'character' && character.triggers.onCharacterNames.includes(message.authorName))
  const keyword = character.triggers.keyword.trim().toLowerCase()
  const byKeyword = keyword.length > 0 && message.content.toLowerCase().includes(keyword)
  return fromListed || byKeyword || mention
}

/** Mentions in `plain` — the message's visible text, extracted once by the caller. */
function mentions(character: Character, plain: string): boolean {
  if (!character.triggers.mention) return false
  // Quoted `@name` (code span, fenced block, link label) is a mention in
  // prose, not a call.
  return matchNames(character, plain)
}

function enqueue(
  roomId: string,
  characterId: string,
  triggerMessageId: string | null,
  hop: number,
  override?: string,
  options?: {
    allowActive?: boolean
    retry?: boolean
    isRoundSummary?: boolean
    roundId?: string | null
    taskId?: string | null
    /** M3 recovery rung for this queued turn (0/omitted = ordinary). */
    resumeAttempt?: number
    /** B11 blind review: do not carry chat context into this turn. */
    blind?: boolean
    /** B12 restart recovery: mark the continuation turn. */
    restartRecovery?: number
  },
): boolean {
  const queue = queues.get(roomId) ?? []
  // Relay hand-offs dedupe against the running character (loop guard);
  // explicit human intent (@mention, 让它发言) opts in via allowActive so
  // the message queues a follow-up run instead of vanishing mid-turn.
  // Returns whether the item truly entered the queue — the auto-retry
  // announcer must not promise "正在自动重试一次" when a same-character
  // item was already waiting and this call was a silent no-op.
  if (!options?.allowActive && active.get(roomId)?.characterId === characterId) return false
  if (queue.some((item) => item.characterId === characterId)) return false
  // Persist the entry the moment it enters the queue (turns double as the
  // queue, P0-2): a hard-killed server restores 'queued' rows on boot, so
  // pending work survives the restart instead of vanishing with the heap.
  const turn = db.createTurn({
    roomId,
    characterId,
    triggerMessageId,
    hop,
    override,
    retry: options?.retry || undefined,
    resumeAttempt: options?.resumeAttempt || undefined,
    restartRecovery: options?.restartRecovery || undefined,
    isRoundSummary: options?.isRoundSummary || undefined,
    roundId: options?.roundId ?? null,
    taskId: options?.taskId ?? null,
  })
  queue.push({
    turnId: turn.id,
    characterId,
    triggerMessageId,
    hop,
    override,
    retry: options?.retry || undefined,
    resumeAttempt: options?.resumeAttempt || undefined,
    isRoundSummary: options?.isRoundSummary || undefined,
    roundId: options?.roundId ?? null,
    taskId: options?.taskId ?? null,
    blind: options?.blind || undefined,
    restartRecovery: options?.restartRecovery || undefined,
  })
  queues.set(roomId, queue)
  broadcast(roomId, 'queue', { roomId, characters: queue.map((item) => item.characterId) })
  return true
}

/**
 * M3 timeout-recovery ladder: a timed-out turn is usually a silent long tool
 * call, not a dead session — the CLI's session survives the kill on disk, so
 * recovery RIDES it (incremental, cache-warm) instead of replaying the full
 * transcript. The pure decision lives in process.ts (timeoutRecoveryPlan);
 * this applies its side effects: streak bookkeeping, per-rung instructions,
 * honest notices, and the queue-first-announce-after discipline (P7e).
 */
const timeoutStreaks = new Map<string, { count: number; durations: number[]; lastTool: string }>()

function scheduleTimeoutRecovery(
  roomId: string,
  character: Character,
  item: QueueItem,
  output: {
    timedOut?: boolean
    sessionId?: string
    error?: string
    text: string
    toolTraces?: unknown[]
    durationMs?: number
    timeoutDetail?: { kind: 'idle' | 'hard'; silenceMs: number; lastTool?: { name: string; title: string; runningMs: number } }
  },
  adapter: { resumeArgs?: (id: string) => string[] | null },
): boolean {
  if (!output.timedOut) return false
  const key = `${roomId}:${character.id}`
  const streak = timeoutStreaks.get(key) ?? { count: 0, durations: [], lastTool: '' }
  streak.count += 1
  streak.durations.push(Math.max(1, Math.round((output.durationMs ?? 0) / 60_000)))
  const stuck = output.timeoutDetail?.lastTool
  if (stuck) streak.lastTool = `${stuck.name}${stuck.title ? `（${stuck.title}）` : ''}`
  timeoutStreaks.set(key, streak)

  const attempts = resumeAttempts()
  const action = timeoutRecoveryPlan({
    attempts,
    streakCount: streak.count,
    rung: item.resumeAttempt ?? 0,
    progressed: output.text.trim().length > 0 || (output.toolTraces?.length ?? 0) > 0,
    canResume: Boolean(output.sessionId && adapter.resumeArgs) && process.env.AC_SESSION_RESUME !== '0',
  })

  if (action === 'breaker') {
    // Announce once at trip time; later timeouts settle without another fanfare.
    if (streak.count === RESUME_BREAKER_LIMIT) {
      const notice = db.addMessage({
        roomId,
        authorType: 'system',
        authorName: '系统',
        content: `🛑 ${character.name} 已连续 ${streak.count} 次超时（分别约 ${streak.durations.slice(-RESUME_BREAKER_LIMIT).join('、')} 分钟），自动续跑已熔断，本次按超时结算。${streak.lastTool ? `最近卡住的工具：${streak.lastTool}——请人工排查该命令为何不返回。` : ''}`,
        meta: { generated: true },
      })
      broadcast(roomId, 'message', { roomId, message: notice })
    }
    return false
  }
  if (action === 'settle') return false

  const rung = (item.resumeAttempt ?? 0) + 1
  const idleBudget = resumeIdleTimeoutMs()
  const idleLabel = idleBudget > 0 ? `${Math.round(idleBudget / 60_000)} 分钟静默上限` : '无静默上限'
  let instruction: string
  let noticeText: string
  if (action === 'report') {
    // Zero progress on rung 1 = the session itself is suspect: do not ride it
    // again — clear the row so the report turn runs on a FRESH session.
    db.clearSession(roomId, character.id)
    instruction =
      '系统汇报指令：你的上一回合多次超时且无进展，已为你开启全新会话。不要再执行任何命令或工具，仅根据上下文汇报三件事：①已确认完成的工作 ②怀疑卡住的位置与原因 ③给用户的下一步建议。'
    noticeText = `⏳ ${character.name} 的续跑无进展，已切换全新会话请求一轮纯汇报（不再执行任何命令，${idleLabel}）。`
  } else if (rung === 1) {
    const stuckLine = stuck
      ? `上次卡在工具：${stuck.name}${stuck.title ? `（${truncate(stuck.title, 120)}）` : ''}——禁止原样重跑该命令，换一种方式绕过卡点（例如改用脚本、后台或跳过）。`
      : ''
    instruction = `系统续跑指令（第 1/${attempts} 次）：你的上一回合因超时被截断（进程已被停止，CLI 会话已恢复）。${stuckLine}请从中断处继续完成原任务：已完成的部分不要重复，直接补完剩余工作并给出最终回复。`
    noticeText = `⏳ ${character.name} 的回合超时被截断，已恢复其 CLI 会话自动续跑（第 1/${attempts} 次，${idleLabel}）${stuck ? `；上次卡在工具：${stuck.name}` : ''}。`
  } else {
    instruction = `系统续跑指令（第 ${rung}/${attempts} 次，最后一次）：续跑仍有进展但再次超时。不要再执行任何新的长命令或工具，只把已有结果收尾：汇总已完成的改动与结论，给出最终回复。`
    noticeText = `⏳ ${character.name} 的续跑有进展但再次超时，再续跑一次收尾（第 ${rung}/${attempts} 次，只汇总不执行新命令）。`
  }

  // Queue FIRST, announce after: enqueue silently no-ops when a same-character
  // item is already waiting (a mid-turn @), and the P0-1 discipline (see
  // enqueue's own comment) is to never promise an automatic retry that did
  // not enter the queue — a notice without a ride would also contradict the
  // failure settlement that follows.
  const queued = enqueue(roomId, character.id, item.triggerMessageId, item.hop, instruction, {
    allowActive: true,
    retry: true,
    isRoundSummary: item.isRoundSummary,
    roundId: item.roundId ?? null,
    taskId: item.taskId ?? null,
    resumeAttempt: rung,
  })
  if (!queued) return false
  const notice = db.addMessage({
    roomId,
    authorType: 'system',
    authorName: '系统',
    content: noticeText,
    meta: { generated: true },
  })
  broadcast(roomId, 'message', { roomId, message: notice })
  return true
}

/**
 * Queue the members this reply hands off to, one relay level deeper. The list
 * is computed before the message is stored (see `pump`) so the row can carry
 * `meta.relayTo`, which is what the UI shows as "接力 → …": the browser
 * displays the router's own verdict instead of re-deriving the trigger rules.
 * Hand-offs inherit the triggering turn's roundId — one round, one gate —
 * and its taskId (B03): a relayed reviewer works the same card.
 */
function enqueueFollowers(
  roomId: string,
  messageId: string,
  followers: Character[],
  nextHop: number,
  roundId: string | null,
  taskId: string | null,
): void {
  for (const follower of followers) enqueue(roomId, follower.id, messageId, nextHop, undefined, { roundId, taskId })
}

/**
 * The hand-off budget is measured in relay depth (`QueueItem.hop`), not in
 * turn count: every character a human message calls directly — including each
 * member of an @all expansion — runs at hop 1, and only character-to-character
 * hand-offs go deeper. So @all in a room with more enabled characters than
 * maxHops still reaches everyone, while runaway relay chains stay bounded.
 */
function budgetExceeded(room: Room, hop: number): boolean {
  if (hop <= room.maxHops) return false
  const state = chains.get(room.id) ?? { limitNoticeSent: false }
  if (state.limitNoticeSent) return true
  chains.set(room.id, { limitNoticeSent: true })
  const round = rounds.get(room.id)
  if (round) round.endReason = 'limit'
  queues.set(room.id, [])
  // Same persistence rule as stopRoom: the dropped items must stay dropped
  // across a restart, or a reboot would re-run a chain the budget just cut.
  db.markQueuedTurnsStopped(room.id, `本轮接力已达上限（${room.maxHops} 层）`)
  const message = db.addMessage({
    roomId: room.id,
    authorType: 'system',
    authorName: '系统',
    content: `本轮接力已达上限（${room.maxHops} 层），为避免死循环已自动停止。发一条新消息即可开始新一轮。`,
  })
  broadcast(room.id, 'message', { roomId: room.id, message })
  broadcast(room.id, 'queue', { roomId: room.id, characters: [] })
  return true
}

/**
 * Run the room's verification command (SOP gate 3c, P0-3). Shell semantics,
 * the room's workingDir, a hard 300s budget, output tail 1_500 for the
 * notice. The room id sits in `verifyRuns` (reference counted) for the
 * whole run — that flag is what keeps the restart drain (restart.ts) and
 * /state's `gate` honest while a verify is in flight.
 */
async function runVerifyCommand(
  room: Room,
): Promise<{ ok: boolean; exitCode: number | null; output: string; timedOut: boolean }> {
  verifyRuns.set(room.id, (verifyRuns.get(room.id) ?? 0) + 1)
  try {
    return await new Promise((resolve) => {
      const child = spawn(room.verifyCommand.trim(), {
        shell: true,
        cwd: room.workingDir,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let output = ''
      let timedOut = false
      let settled = false
      const append = (chunk: Buffer) => {
        output = (output + chunk.toString('utf8')).slice(-VERIFY_OUTPUT_CHARS)
      }
      child.stdout?.on('data', append)
      child.stderr?.on('data', append)
      let backstop: ReturnType<typeof setTimeout> | null = null
      const finish = (exitCode: number | null) => {
        if (settled) return
        settled = true
        if (backstop) clearTimeout(backstop)
        clearTimeout(timer)
        resolve({ ok: !timedOut && exitCode === 0, exitCode, output, timedOut })
      }
      const timer = setTimeout(() => {
        timedOut = true
        if (process.platform === 'win32' && child.pid) {
          spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
        } else {
          child.kill('SIGKILL')
        }
        // Backstop: a kill that doesn't take (unkillable process, Windows
        // grief) would leave this promise pending forever, and with it
        // verifyRuns — gateActive — holding the restart drain hostage for
        // the life of the server. Settle regardless, 10s after the kill.
        backstop = setTimeout(() => finish(null), VERIFY_KILL_BACKSTOP_MS)
      }, VERIFY_TIMEOUT_MS)
      child.on('error', () => finish(null))
      child.on('close', (code) => finish(code))
    })
  } finally {
    // Reference-counted release: overlapping verifies for one room only
    // clear the flag when the LAST one settles (see verifyRuns above).
    const remaining = (verifyRuns.get(room.id) ?? 1) - 1
    if (remaining > 0) verifyRuns.set(room.id, remaining)
    else verifyRuns.delete(room.id)
  }
}

/** One gate notice per round: what blocked the close, in one system message. */
function sendGateNotice(roomId: string, content: string): void {
  const message = db.addMessage({
    roomId,
    authorType: 'system',
    authorName: '系统',
    content,
    meta: { generated: true },
  })
  broadcast(roomId, 'message', { roomId, message })
}

/**
 * Render a gate block reason as notice text (B05). RENDERING only — the
 * decision itself lives in sop.ts's gateDecision, the one place. Names are
 * best-effort: a deleted character shows as its id's placeholder.
 */
function gateBlockNotice(
  reason: GateBlockReason,
  round: RoundState,
  reviewer: { id: string; name: string } | null | undefined,
): string {
  const nameOf = (author: GateAuthor | null | undefined): string => {
    if (!author) return '（未知）'
    const character = db.getCharacter(author.id)
    return character ? character.name : '（已删除角色）'
  }
  switch (reason) {
    case 'self-review':
      return `REVIEW: PASS 来自实现者本人（${nameOf(round.verdictAuthor)}），自审无效，本轮不做轮末总结。`
    case 'wrong-reviewer':
      return `REVIEW: PASS 非指定 reviewer（应为 ${reviewer ? reviewer.name : '（已删除角色）'}，实际 ${nameOf(round.verdictAuthor)}），本轮不做轮末总结。`
    case 'reviewer-ineligible':
      return `指定 reviewer（${reviewer ? reviewer.name : '（已删除角色）'}）已停用或为轮末总结角色，无法给出有效 PASS；请到「房间设置」重新指定 reviewer（或启用该角色），本轮不做轮末总结。`
    case 'same-harness':
      return `reviewer 与实现者同一 harness（${round.changedAuthor?.harness ?? '未知'}），同一模型家族不构成独立判断，本轮不做轮末总结。`
    case 'no-author':
      return `REVIEW: PASS 缺少作者信息（内部状态异常，宁可拦截），本轮不做轮末总结。`
    case 'changes':
      return '最后一条 review 结论为 REVIEW: CHANGES，本轮不做轮末总结。'
    case 'verify-fail':
      return '验证命令未通过，本轮不做轮末总结。'
    default:
      return '本轮有代码改动，但没有 review 结论（需要 review 角色单独一行给出 REVIEW: PASS）。'
  }
}

/**
 * Task-card settlement (B03): write the card's state back when the round it
 * opened closes. Round identity first (the P0-3 discipline): only the round
 * CURRENTLY registered under this room may settle — a replaced entry (new
 * human message, re-dispatch) never writes, so a displaced card keeps
 * `running` for its re-dispatch instead of being falsely closed.
 */
function settleTaskForRound(roomId: string, round: RoundState, outcome: 'done' | 'blocked' | 'error'): void {
  if (!round.taskId) return
  if (rounds.get(roomId) !== round) return
  db.settleTaskByRound(round.roundId, outcome)
}

/**
 * The round's work is done AND approved (B04 + S13 share this predicate):
 * work happened (hadTurn), it left code evidence (changedPaths), the review
 * verdict is PASS, verify (when configured) did not fail, and the last real
 * turn ended ok. Everything else — blocked, errored, stopped, chat-only — is
 * not "finished work": no episode, no auto-commit.
 */
function roundWorkApproved(round: RoundState): boolean {
  return (
    round.hadTurn &&
    round.changedPaths.length > 0 &&
    round.verdict === 'pass' &&
    round.verifyState !== 'fail' &&
    round.lastTurnOutcome === 'ok'
  )
}

/**
 * Normal-close settlement (B03 review 2): a round whose last real turn ended
 * in error or was stopped never closes its card as done — the card keeps
 * `running` with `result='error'` so the panel offers a re-dispatch instead
 * of a false "已完成".
 */
function settleTaskClosed(roomId: string, round: RoundState): void {
  settleTaskForRound(roomId, round, round.lastTurnOutcome === 'ok' ? 'done' : 'error')
}

/** Short, actionable root causes for the failure lesson (B08). */
const GATE_LESSON_TEXT: Record<GateBlockReason, string> = {
  'no-verdict': '有代码改动但没有 review 结论，需要 review 角色单独一行给出 REVIEW: PASS',
  changes: '最后一条 review 结论是 REVIEW: CHANGES',
  'no-author': 'REVIEW: PASS 缺少作者信息，无法验证独立性',
  'self-review': '实现者本人给出 REVIEW: PASS，自审无效',
  'wrong-reviewer': 'REVIEW: PASS 不是指定 reviewer 给出',
  'reviewer-ineligible': '指定 reviewer 已停用或是轮末总结角色，无法给出有效 PASS',
  'same-harness': 'reviewer 与实现者使用同一 harness，不构成独立判断',
  'verify-fail': '验证命令未通过',
}

/**
 * Best-effort failure lesson: a round that never closes cleanly still leaves
 * its root cause in room memory, so the next attempt starts from it. A
 * memory failure must never take the round settlement down.
 */
function recordFailureLesson(roomId: string, round: RoundState, cause: string): void {
  try {
    db.addFailureEpisode({ roomId, cause, changedPaths: round.changedPaths, roundId: round.roundId })
  } catch (error) {
    console.warn(
      `[agent-crowd] failure lesson memory failed (${roomId}): ${error instanceof Error ? error.message : error}`,
    )
  }
}

/**
 * B04: the round's normal close — one funnel for all three clean-close
 * sites. Order matters: settle the task card first (B03 semantics
 * unchanged), then record the round as a room-scope episode (best-effort: a
 * memory failure logs and moves on — it must never take the card settlement
 * or the round's removal down with it), then drop the round.
 *
 * The episode only fires on a CLEAN, CHANGED, APPROVED round
 * (roundWorkApproved). Everything else — blocked, errored, stopped, pure
 * chat — is not "finished work" and writes nothing. (A hop-limited round
 * whose last turn still ended ok with a PASS verdict DOES write: the work
 * happened and was approved — only the relay chain was cut short.)
 */
function closeRoundNormally(roomId: string, round: RoundState): void {
  settleTaskClosed(roomId, round)
  if (roundWorkApproved(round)) {
    try {
      db.addRoundEpisode({
        roomId,
        changedPaths: round.changedPaths,
        verify: round.verifyState === 'pass' ? 'pass' : 'none',
        delivery: round.lastDelivery ?? '',
        roundId: round.roundId,
      })
    } catch (error) {
      console.warn(
        `[agent-crowd] round episode memory failed (${roomId}): ${error instanceof Error ? error.message : error}`,
      )
    }
  } else if (round.lastTurnOutcome === 'error') {
    recordFailureLesson(roomId, round, `角色回合执行失败：${round.lastError ?? '（没有错误信息）'}`)
  }
  rounds.delete(roomId)
}

/**
 * Auto-commit on clean close (S13): a round whose work is done and approved
 * lands as one commit of exactly its changed paths — deterministic server
 * behavior at the round's drain point (the same moment a summarizer speaks),
 * never delegated to an agent turn that could mis-run git, and NEVER a push:
 * pushing stays a user decision, the notice says how to ask. Failure degrades
 * to a notice; the round closes regardless.
 */
async function autoCommitRound(room: Room, round: RoundState): Promise<void> {
  const subject = `auto: ${truncate((round.lastDelivery ?? '').trim(), 66) || '本轮改动（review PASS）'}`
  const reviewer = round.verdictAuthor ? db.getCharacter(round.verdictAuthor.id) : undefined
  // The body lists the paths that actually go INTO the commit (kept), not the
  // raw round change set — ghosts and ignored files were filtered out by then.
  const buildBody = (keptPaths: string[]) =>
    [
      `改动: ${keptPaths.slice(0, 8).join('、')}${keptPaths.length > 8 ? ` 等 ${keptPaths.length} 个` : ''}`,
      `REVIEW: PASS（${reviewer?.name ?? '未知角色'}）`,
      'agent-crowd 轮次收尾自动提交；push 未执行，等用户确认。',
    ].join('\n')
  // Hold the gate flag through the commit: /state must keep answering
  // gate=running across the await — without it, a waitIdle poll between
  // "verify settled" and "summary queued" catches a fleeting idle and
  // observes a round that isn't closed yet. Same reference-count reasoning
  // as verifyRuns (overlapping rounds), and a pending restart drains behind
  // it too.
  verifyRuns.set(room.id, (verifyRuns.get(room.id) ?? 0) + 1)
  try {
    const result = await commitPaths(room.workingDir, round.changedPaths, { subject, body: buildBody })
    if (result.skipped === 'ignored') {
      sendGateNotice(room.id, 'ℹ️ 本轮改动均为被 gitignore 的文件，自动提交跳过。')
    } else if (result.skipped === 'empty') {
      sendGateNotice(room.id, 'ℹ️ 没有可提交的新改动（可能已被提交过），自动提交跳过。')
    } else if (!result.ok) {
      sendGateNotice(room.id, `⚠️ 自动提交失败：${result.error ?? '未知原因'}。改动仍在工作区，可手动提交。`)
    } else {
      const fileCount = result.files?.length ?? round.changedPaths.length
      // B11: persist the commit hash as round evidence, so the report/diff
      // view can find it long after the round's in-memory state is gone.
      if (result.hash) {
        db.addRoundCheck({
          roomId: room.id,
          roundId: round.roundId,
          kind: 'commit',
          verdict: 'pass',
          detail: result.hash,
        })
      }
      sendGateNotice(
        room.id,
        `📦 本轮改动已自动提交：${result.hash} ${subject}（${fileCount} 个文件）。push 未执行，需要推送时说一声即可。`,
      )
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    console.warn(`[agent-crowd] auto-commit failed (${room.id}): ${reason}`)
    sendGateNotice(room.id, `⚠️ 自动提交失败：${reason}。改动仍在工作区，可手动提交。`)
  } finally {
    const remaining = (verifyRuns.get(room.id) ?? 1) - 1
    if (remaining > 0) verifyRuns.set(room.id, remaining)
    else verifyRuns.delete(room.id)
  }
}

/**
 * Round-end summary: called from pump()'s empty-queue branch, i.e. the
 * moment a round that ran at least one turn has nothing left to run —
 * with the SOP gate (P0-3 3c) in front of it: a round that changed the
 * worktree only closes when its LAST review verdict is pass and (when the
 * room configured one) the verification command passed. Blocked rounds get
 * one notice and are deleted without a summary and without re-queueing —
 * the follow-up (fix, review, new round) belongs to the next human/character
 * message, not to an automatic loop that would gate itself forever.
 *
 * The gate is async only when it actually runs the verify command; chat-only
 * and already-passing rounds close as cheaply as before.
 *
 * Idempotent per round: the `summarizing` flag makes the summary's own
 * settlement (and any relay echo of the summary message) close the round
 * instead of triggering a second summary. Returns whether summary items
 * entered the queue, so the caller can keep pumping instead of flashing
 * the room idle.
 */
async function maybeStartRoundSummary(roomId: string): Promise<boolean> {
  const round = rounds.get(roomId)
  if (!round) return false
  if (round.verifyState === 'running') {
    // A verify from this round is still in flight (its own await will carry
    // on here); re-entering now would double-run the command.
    return false
  }
  if (!round.hadTurn || round.summarizing) {
    // Nothing to summarize (or the summary already ran): close the round.
    // The summarizing branch is the summary's own settlement closing the
    // loop — the card's round finished normally, and a clean+changed+PASS
    // round records its episode (B04). A round that never ran anything
    // (assignee vanished before the turn started) leaves its card `running`
    // for a re-dispatch instead of falsely closing it — and writes no
    // memory (nothing happened).
    if (round.summarizing) closeRoundNormally(roomId, round)
    else rounds.delete(roomId)
    return false
  }
  const room = db.getRoom(roomId)
  if (!room) {
    rounds.delete(roomId)
    return false
  }

  // ---- SOP gate (P0-3 3c): only rounds that changed the worktree pass through.
  if (round.changedPaths.length > 0) {
    // B05: the room's designated reviewer, when one is configured. A stale id
    // (deleted character) reads as no designation — the hard rule still holds.
    // B05b-4: a DISABLED or summarizer-only reviewer is kept (not silently
    // cleared) and the gate blocks with an actionable reason instead.
    // B14/B15: the reviewer for this round is authoritative — re-read its
    // CURRENT record at gate time (pool snapshots can go stale: disabled,
    // deleted, or re-harnessed after the review was queued).
    const resolvedReviewer = resolveRoundReviewer({
      designatedId: room.reviewerCharacterId,
      poolReviewer: round.blindReviewer,
      characters: db.listCharacters(roomId),
    })
    const reviewerCharacter = resolvedReviewer.reviewer
    const reviewerEligible = resolvedReviewer.eligible
    const decision = gateDecision({
      changed: round.changedPaths.length,
      verifyRequired: room.verifyCommand.trim().length > 0,
      verify: round.verifyState === 'pass' || round.verifyState === 'fail' ? round.verifyState : 'none',
      verdict: round.verdict,
      verdictAuthor: round.verdictAuthor,
      changedAuthor: round.changedAuthor,
      reviewer: reviewerCharacter ? { id: reviewerCharacter.id, harness: reviewerCharacter.harness } : null,
      reviewerEligible,
    })
    if (decision.action === 'block') {
      // B15: a REVIEW: CHANGES gets ONE automatic repair round for the
      // implementer. The round stays alive; the repair turn's diff resets
      // blindReviewQueued so the same reviewer reviews again. At the limit
      // this falls through to the normal blocked path.
      const repairLimit = autoRepairLimit()
      const repairAuthor = round.changedAuthor ? db.getCharacter(round.changedAuthor.id) : undefined
      if (
        decision.reason === 'changes' &&
        // B15: only an independent reviewer's CHANGES may trigger repair —
        // same character / same harness / a random third party burns a turn
        // without a trustworthy re-review (and task-check's 返修演练 depends
        // on the self-review distinction). Blind review must be on because
        // the promise is "修复后自动重新盲审".
        room.blindReview &&
        isIndependentReviewerVerdict({
          verdictAuthor: round.verdictAuthor,
          changedAuthor: round.changedAuthor,
          designatedId: room.reviewerCharacterId,
          poolReviewerId: round.blindReviewer?.id,
        }) &&
        repairLimit > 0 &&
        round.repairCount < repairLimit &&
        repairAuthor?.enabled &&
        rounds.get(roomId) === round
      ) {
        round.repairCount += 1
        round.blindReviewQueued = false
        round.blindWarned = false
        const feedbackMessage = round.verdictMessageId ? db.getMessageById(round.verdictMessageId) : undefined
        const feedback = (feedbackMessage?.content ?? '').trim().slice(0, 2_000)
        const override = [
          '系统返修任务：reviewer 最后给出了 REVIEW: CHANGES。',
          feedback ? `【review 意见】\n${feedback}` : '【review 意见】（未找到原文，请查看最近的群聊记录）',
          '请根据 review 意见修复本轮改动；不要自行提交，修复后服务器会重新盲审，PASS 后自动提交。',
        ].join('\n\n')
        enqueue(roomId, repairAuthor.id, null, 1, override, {
          allowActive: true,
          roundId: round.roundId,
          taskId: round.taskId,
        })
        sendGateNotice(
          roomId,
          `↩️ 已自动排入返修回合（${round.repairCount}/${repairLimit}）：${repairAuthor.name} 根据 review 意见修复，修复后自动重新盲审。`,
        )
        return true
      }
      if (!round.gateNoticeSent) {
        round.gateNoticeSent = true
        // A block always carries a reason (close/run-verify carry null).
        const reasonText = decision.reason
          ? gateBlockNotice(decision.reason, round, reviewerCharacter)
          : '本轮被门禁拦截。'
        sendGateNotice(
          roomId,
          `🚧 SOP 门禁：${reasonText}改动文件：${round.changedPaths.slice(0, 5).join('、')}${round.changedPaths.length > 5 ? ` 等 ${round.changedPaths.length} 个` : ''}。请继续处理，处理完成后重新给出 review 结论即可收尾。`,
        )
      }
      // A CHANGES verdict already had its one automatic repair attempt above.
      // At the cap there is no summary and no further re-queue: the next
      // human/character message starts the next round (auto-requeue here
      // would gate-loop forever). The card stays `running` with
      // `result='blocked'` (B03) so the panel offers a re-dispatch instead of
      // a false done.
      recordFailureLesson(
        roomId,
        round,
        decision.reason ? GATE_LESSON_TEXT[decision.reason] : '本轮被 SOP 门禁拦截',
      )
      settleTaskForRound(roomId, round, 'blocked')
      rounds.delete(roomId)
      return false
    }
    if (decision.action === 'run-verify') {
      round.verifyState = 'running'
      const result = await runVerifyCommand(room)
      // The round the verify belonged to may have been replaced while the
      // command ran (a new human message opens a new round): the outcome is
      // still recorded against its roundId, but only the SAME round object
      // may close on it.
      db.addRoundCheck({
        roomId,
        roundId: round.roundId,
        kind: 'verify',
        verdict: result.ok ? 'pass' : 'fail',
        // exit line always survives; the output part keeps its TRUE tail —
        // a head-keeping cap drops exactly the lines that explain the death.
        detail: `${result.timedOut ? '（超时被终止）' : ''}exit ${result.exitCode ?? 'spawn-error'}\n${tail(result.output.trim(), VERIFY_DETAIL_CHARS)}`,
      })
      if (rounds.get(roomId) !== round) return false
      if (!result.ok) {
        round.verifyState = 'fail'
        if (!round.gateNoticeSent) {
          round.gateNoticeSent = true
          sendGateNotice(
            roomId,
            `🚧 SOP 门禁：验证命令未通过（exit ${result.exitCode ?? 'spawn-error'}${result.timedOut ? '，运行超时被终止' : ''}），本轮不做轮末总结。输出尾部：\n${tail(result.output.trim() || '（无输出）', VERIFY_DETAIL_CHARS)}`,
          )
        }
        recordFailureLesson(
          roomId,
          round,
          `验证命令未通过（exit ${result.exitCode ?? 'spawn-error'}${result.timedOut ? '，超时' : ''}）：${
            tail(result.output.trim() || '（无输出）', 160)
          }`,
        )
        settleTaskForRound(roomId, round, 'blocked')
        rounds.delete(roomId)
        return false
      }
      round.verifyState = 'pass'
      sendGateNotice(roomId, `✅ SOP 门禁：验证命令通过（exit ${result.exitCode}），本轮开始收尾总结。`)
      // fall through to the summary below.
    }
    // decision === 'close' → straight to the summary below.
  }

  // S13 auto-commit: work that cleared the gate lands as one commit before
  // the summary queues (the summarizer then reports it in the round
  // summary). Never a push — see autoCommitRound. autoCommitStarted guards
  // the await window against a re-entrant pump visit.
  if (roundWorkApproved(round) && !round.autoCommitStarted) {
    round.autoCommitStarted = true
    await autoCommitRound(room, round)
  }
  if (rounds.get(roomId) !== round) return false

  const summarizers = db.listCharacters(roomId).filter((character) => character.enabled && character.triggers.onRoundEnd)
  if (summarizers.length === 0) {
    // No summarizer configured: the round still closed — settle by its last
    // turn's outcome (B03 review 2: an errored round is NOT a done card),
    // and record the episode on a clean+changed+PASS close (B04).
    closeRoundNormally(roomId, round)
    return false
  }
  round.summarizing = true
  const reason =
    round.endReason === 'limit'
      ? `本轮对话因接力达到上限（${room.maxHops} 层）被系统自动停止`
      : '本轮对话已结束（各方发言完毕，没有角色再接力）'
  const override = [
    '系统轮末总结任务：请你作为本房间的轮值总结者发言。',
    `${reason}。`,
    '请回顾【最近的群聊记录】里本轮的内容（从最近一条用户消息开始，到上一条消息为止），发一条简短的轮末总结，必须包含两部分：',
    '1. 这轮做了什么：关键需求、进展、决定与产出（如代码改动、验证结果）',
    '2. 遗留了什么：未完成事项、风险与下一步建议',
    '只输出总结正文，保持简洁；若本轮无实质内容，一两句话说明即可。不要使用工具，不要发起新任务，不要 @ 任何角色（避免把总结变成新一轮接力）。',
  ].join('\n')
  let queued = false
  for (const character of summarizers) {
    queued = enqueue(roomId, character.id, null, 1, override, { isRoundSummary: true, roundId: round.roundId }) || queued
  }
  if (!queued) {
    // Every summarizer vanished mid-flight (deleted/disabled): close the round.
    closeRoundNormally(roomId, round)
    return false
  }
  return true
}

async function pump(roomId: string): Promise<void> {
  if (active.has(roomId)) return
  // State visible to catch/finally even when the pre-run bookkeeping itself
  // throws. Before this, anything between `queue.shift()` and the old inner
  // `try {` escaped `void pump()` as an unhandled rejection (Node kills the
  // process — the 16:41 exit-1 crash), and a throw after `active.set()` left
  // the room busy forever with a stop button that could no longer reach it.
  let activeTurnId: string | null = null
  let activeCharacterId: string | null = null
  let activeCharacterName = '未知角色'
  let activeHarness: HarnessKind | undefined = undefined
  let consumed = false
  // Round identity for the catch handler (B03 review 3): a scheduling
  // exception must leave its round's outcome as 'error', or the task card
  // that round executes would settle as done on a crashed turn. Hoisted for
  // the same reason as activeTurnId — the catch cannot see try-scoped vars.
  let activeRoundId: string | null = null
  let activeIsSummary = false
  /** Room whose directory lock this pump holds (B10); released in finally. */
  let activeRoom: Room | null = null
  try {
    const room = db.getRoom(roomId)
    if (!room) return

    const queue = queues.get(roomId) ?? []
    if (queue.length === 0) {
      queues.set(roomId, queue)
      // The close-out may run the room's verify command in this directory —
      // hold the same lock so it cannot overlap another room's turn.
      if (rounds.has(roomId)) {
        if (!acquireWorkdir(room)) return
        activeRoom = room
      }
      // Empty queue + no active turn: the round (if one was running) just
      // ended — either drained naturally or cut by the hop budget. Fire the
      // round-end summary (through the SOP gate) before declaring the room
      // idle, so the summary turn starts without a busy→idle→busy flicker.
      // The gate may run the room's verify command first — await it.
      if (await maybeStartRoundSummary(roomId)) return void pump(roomId)
      // That await can straddle a new human message: by now ITS pump() may
      // have a turn running (or fresh items queued). Broadcasting idle HERE
      // would flash the room dark mid-turn — the web client drops the live
      // view on busy:false. Re-read the room state instead of trusting the
      // empty queue we saw before the gate went async.
      if (!active.has(roomId) && (queues.get(roomId) ?? []).length === 0) {
        broadcast(roomId, 'busy', { roomId, busy: false, characterId: null })
      }
      return
    }
    // B10: another room on the same directory is running — leave this turn
    // queued. Its release path wakes us; do not shift or broadcast.
    if (!acquireWorkdir(room)) return
    activeRoom = room
    const item = queue.shift()
    queues.set(roomId, queue)
    if (!item) return
    consumed = true
    broadcast(roomId, 'queue', { roomId, characters: queue.map((entry) => entry.characterId) })

    const character = db.getCharacter(item.characterId)
    if (!character || !character.enabled) {
      // The dequeued turn's row must reach a terminal state too: a 'queued'
      // row left behind would resurrect this run on the next boot.
      db.updateTurn(item.turnId, {
        status: 'stopped',
        error: !character ? '角色已被删除' : '角色已停用',
        endedAt: Date.now(),
      })
      void pump(roomId)
      return
    }
    activeCharacterId = character.id
    activeCharacterName = character.name
    activeHarness = character.harness
    if (budgetExceeded(room, item.hop)) {
      // The over-budget item itself is swept to 'stopped' as well —
      // budgetExceeded already terminal-swept the rest of the queue's rows.
      db.updateTurn(item.turnId, {
        status: 'stopped',
        error: `接力达到上限（hop ${item.hop} > ${room.maxHops} 层）`,
        endedAt: Date.now(),
      })
      broadcast(roomId, 'busy', { roomId, busy: false, characterId: null })
      return
    }

    // The turn row was persisted as 'queued' at enqueue time (turns double
    // as the queue, P0-2). Claim it compare-and-set: a false return means
    // the row is no longer 'queued' (claimed or swept elsewhere — e.g. a
    // stop racing this pump), so the in-memory entry is dropped rather than
    // double-run.
    if (!db.claimTurn(item.turnId)) {
      void pump(roomId)
      return
    }
    const turnId = item.turnId
    activeTurnId = turnId
    activeRoundId = item.roundId ?? null
    activeIsSummary = item.isRoundSummary ?? false
    const controller = new AbortController()
    const replay: TurnReplay = { text: '', thinking: [], tools: [] }
    /** B12: throttle partial-output checkpoints (hard kill writes nothing). */
    let lastCheckpointAt = 0
    active.set(roomId, {
      turnId,
      characterId: character.id,
      controller,
      startedAt: Date.now(),
      replay,
    })
    // A real turn is running: the round it belongs to has substance, so its
    // end deserves a summary. Summary turns (and anything running while the
    // summary is already scheduled) don't flip the flag — they are the
    // round's closing act, not new activity.
    const round = rounds.get(roomId)
    if (round && round.roundId === item.roundId && !round.summarizing && !item.isRoundSummary) round.hadTurn = true
    broadcast(roomId, 'turn', { roomId, turnId, characterId: character.id, status: 'running' })
    broadcast(roomId, 'busy', { roomId, busy: true, characterId: character.id })

    const cwd = character.cwd.trim() || room.workingDir

    mkdirSync(cwd, { recursive: true })
    // Before-snapshot (SOP gate 3a): bracket the turn's own CLI run so the
    // after-snapshot can tell WHICH paths this turn touched. Shot at the
    // repo root (see gitstate.ts) — the room cwd is usually a subdirectory.
    // Unjudgeable worktrees simply leave the turn's `changed` null.
    const before = await snapshotWorktree(cwd)
    const characters = db.listCharacters(roomId)
    // Session continuity (P0-1): the same character in the same room rides
    // the CLI's own session when a stored row still matches its harness and
    // model AND the adapter declared a resume fragment (flags verified
    // against each CLI's --help before being declared — never guessed).
    // Anything off — no row, harness/model drift, unsupported adapter, or
    // the AC_SESSION_RESUME=0 kill switch — replays the full transcript with
    // zero behavior change.
    const adapter = getAdapter(character.harness)
    const session = db.getSession(room.id, character.id)
    const useResume =
      !item.blind &&
      session !== undefined &&
      adapter.resumeArgs !== undefined &&
      process.env.AC_SESSION_RESUME !== '0' &&
      session.harness === character.harness &&
      session.model === character.model
    const since = useResume && session ? { at: session.consumedAt, seq: session.consumedSeq } : { at: 0, seq: 0 }
    // B01: a resumed turn fetches BY CURSOR — the old recent-80 window left
    // older increments stranded outside memory, where neither the render nor
    // the fold could see them. Fresh turns keep the cold-start recency
    // window: nothing older ever rode the new session.
    const fetched = useResume
      ? db.listMessagesAfter(room.id, since, RESUME_FETCH_LIMIT)
      : db.listMessages(roomId, 80)
    // Pathological flood beyond the fetch window: the overflow is folded by
    // COUNT (never silently skipped); the log line is the only trace because
    // the user already sees every message in the room.
    const foldOverflow =
      useResume && fetched.length >= RESUME_FETCH_LIMIT
        ? Math.max(0, db.countMessagesAfter(room.id, since) - fetched.length)
        : 0
    if (foldOverflow > 0) {
      console.warn(
        `[agent-crowd] ${room.name}/${character.name}: 新消息超过取回窗口（${RESUME_FETCH_LIMIT}），${foldOverflow} 条仅以计数进入折叠摘要`,
      )
    }
    // Long-term memory rides along on every turn: the character's cross-room
    // identity memories plus this room's shared notes, both hard-budgeted so
    // they never crowd out the transcript (see docs/memory-plan.md). B04:
    // picked AFTER the fetch so retrieval can key on this round's own query —
    // the last user message, or the task-card body on card rounds; a summary
    // round keys on the round's trigger, never on the summary itself.
    const identity = db.ensureIdentityForCharacter(character)
    const memoryQuery = memoryQueryFromMessages(fetched)
    const memories = item.blind
      ? { identity: [], room: [] }
      : db.pickMemoriesForPrompt(identity.id, room.id, undefined, memoryQuery)
    // The prompt layer owns both the text and what it represented (B01): the
    // cursor below is computed from the messages the prompt actually carries
    // (rendered or folded), never from what was merely fetched — a cursor
    // past an unrepresented message would skip it forever. Messages arriving
    // DURING the run stay after the cursor and re-ship next turn; computing
    // it from `Date.now()` instead would swallow them silently.
    // B06: relayed turns inject the five-tuple handoff carried by the message
    // they ANSWER (item.triggerMessageId — deliberately not "the newest
    // message": a later user note may have landed while this turn sat
    // queued, and the handoff describes the relay it inherits, not the
    // latest room state). Fresh user-triggered turns read a user message →
    // no meta.handoff → no section, exactly as before.
    const triggerHandoff =
      !item.blind && item.triggerMessageId !== null
        ? db.getMessageById(item.triggerMessageId)?.meta?.handoff ?? null
        : null
    // B07: skills inject on demand — the catalog is read FRESH from the
    // repo-root skills/ on every turn that has anything checked (no
    // watcher, no cache). loadSkills is best-effort by contract: it never
    // throws, so a broken skills/ directory can't kill a round — bad files
    // were skipped with a one-time warning inside.
    const skillCatalog = !item.blind && character.skills.length > 0 ? loadSkills(SKILLS_DIR) : []
    const built = buildTurnPromptDetailed({
      room,
      character,
      characters,
      messages: fetched,
      cwd,
      override: item.override,
      memories,
      since,
      resumed: useResume,
      foldOverflow,
      handoff: triggerHandoff ?? undefined,
      skills: skillCatalog,
      blind: item.blind,
    })
    const prompt = built.prompt
    db.touchMemories([...memories.identity, ...memories.room].map((memory) => memory.id))
    /** M3 liveness: guards the single suspected-stall system message. */
    let silenceWarned = false

    const output = await adapter.run({
      character,
      room,
      prompt,
      cwd,
      resume: useResume && session ? { id: session.sessionId } : undefined,
      signal: controller.signal,
      // M3: recovery turns (rung >= 1) ride their own much shorter idle
      // watchdog so a stuck resume settles in minutes, not another full
      // idle window.
      idleTimeoutMs: (item.resumeAttempt ?? 0) > 0 ? resumeIdleTimeoutMs() : undefined,
      // M3 liveness: report-only silence warnings at 50%/85% of the idle
      // budget — the kill timer itself stays byte-accurate (process.ts).
      onSilence: (info) => {
        const kind = info.fraction >= 0.85 ? 'suspected_stall' : 'alive_but_silent'
        broadcast(roomId, 'liveness', {
          roomId,
          characterId: character.id,
          kind,
          silenceMs: info.silenceMs,
          thresholdMs: info.thresholdMs,
        })
        // At most ONE in-chat warning per turn, at the suspected-stall mark:
        // the 50% ping is an SSE event for the UI, not a message.
        if (kind === 'suspected_stall' && !silenceWarned) {
          silenceWarned = true
          const notice = db.addMessage({
            roomId,
            authorType: 'system',
            authorName: '系统',
            content: `⚠️ ${character.name} 的回合已静默 ${Math.max(1, Math.round(info.silenceMs / 60_000))} 分钟，疑似卡在某个长时间无输出的命令上。可继续等待自动超时，或用停止按钮中断。`,
            meta: { generated: true },
          })
          broadcast(roomId, 'message', { roomId, message: notice })
        }
      },
      // Surface the CLI pid the moment it spawns: stored on the active turn
      // (for /state and reconnect snapshots) and broadcast so open clients
      // can show it while the turn runs.
      onSpawn: (pid) => {
        const entry = active.get(roomId)
        if (entry?.turnId !== turnId) return
        entry.pid = pid
        // Also persist on the turn row: a hard-killed server runs no exit
        // hooks, so this pid is the only handle the boot sweep has to reap
        // the orphaned CLI tree afterwards.
        try {
          db.setTurnPid(turnId, pid)
        } catch {
          /* db hiccup; the in-memory pid still works for this session */
        }
        broadcast(roomId, 'pid', { roomId, turnId, characterId: character.id, pid })
      },
      emit: (event) => {
        if (event.kind === 'text') {
          replay.text = (replay.text + event.text).slice(-REPLAY_TEXT_CAP)
        } else if (event.kind === 'thinking') {
          replay.thinking.push(event.text)
          if (replay.thinking.length > REPLAY_CAP) replay.thinking.splice(0, replay.thinking.length - REPLAY_CAP)
        } else {
          replay.tools.push(event.text)
          if (replay.tools.length > REPLAY_CAP) replay.tools.splice(0, replay.tools.length - REPLAY_CAP)
        }
        // B12: a hard kill runs no exit hook, so streamed text only survives
        // a restart if it is checkpointed while the turn runs. 2s is enough
        // for the recovery prompt to keep the useful tail; the final write
        // still stores the full output.
        const checkpointAt = Date.now()
        if (replay.text && checkpointAt - lastCheckpointAt >= 2_000) {
          lastCheckpointAt = checkpointAt
          try {
            db.updateTurn(turnId, { output: replay.text })
          } catch {
            /* db hiccup — the final write still runs on a clean exit */
          }
        }
        // B13: forward the whole structured event; legacy clients only read
        // kind/text, the CLI timeline also gets phase/tool fields.
        broadcast(roomId, 'delta', {
          ...event,
          roomId,
          turnId,
          characterId: character.id,
        })
      },
    })

    if (controller.signal.aborted) {
      // The round's last real turn was stopped (B03 review 2): never settles
      // its card as done. A steer re-run overwrites this with its own outcome.
      if (round && round.roundId === item.roundId && !item.isRoundSummary) round.lastTurnOutcome = 'stopped'
      db.updateTurn(turnId, { status: 'stopped', output: output.text, endedAt: Date.now() })
      broadcast(roomId, 'turn', { roomId, turnId, characterId: character.id, status: 'stopped' })
      // Keep whatever streamed before the stop: without this the text vanished
      // together with the live buffer. meta.error flags it as incomplete.
      if (output.text.trim()) {
        const stoppedMedia = rewriteMediaLines(output.text)
        const stopped = db.addMessage({
          roomId,
          authorType: 'character',
          characterId: character.id,
          authorName: character.name,
          authorAvatar: character.avatar,
          color: character.color,
          content: stoppedMedia.text,
          meta: {
            harness: character.harness,
            model: character.model,
            turnId,
            durationMs: output.durationMs,
            exitCode: output.exitCode,
            pid: output.pid,
            error: '已停止',
            generated: true,
            ...(stoppedMedia.attachments.length > 0 ? { attachments: stoppedMedia.attachments } : {}),
          },
        })
        broadcast(roomId, 'message', { roomId, message: stopped })
      }
      return
    }

    if (output.error && !output.text.trim()) {
      // The round's last real turn errored (B03 review 2).
      if (round && round.roundId === item.roundId && !item.isRoundSummary) {
        round.lastTurnOutcome = 'error'
        round.lastError = output.error
      }
      db.updateTurn(turnId, {
        status: 'error',
        error: output.error,
        output: output.text,
        endedAt: Date.now(),
      })
      broadcast(roomId, 'turn', { roomId, turnId, characterId: character.id, status: 'error' })
      // M2: a TIMEOUT (not a CLI rejection) keeps the session and rides one
      // resume instead of settling. The error path returns above, so the
      // session row the resume turn rides is written HERE. Bookkeeping is
      // decoupled from the ride: `AC_SESSION_RESUME=0` or an already-retried
      // turn still records the killed CLI's surviving session (the same
      // record-only rule P6 pins for the normal path); the switch gates the
      // RIDE, not the row.
      if (!item.blind && output.timedOut && output.sessionId) {
        db.setSession({
          roomId,
          characterId: character.id,
          harness: character.harness,
          model: character.model,
          sessionId: output.sessionId,
          consumedAt: built.nextCursor.at,
          consumedSeq: built.nextCursor.seq,
        })
      }
      if (!item.blind && scheduleTimeoutRecovery(roomId, character, item, output, adapter)) return
      // Session-continuity fallback (P0-1): a turn that died resuming its
      // CLI session clears the row first, so the rerun (and every later
      // turn) replays the FULL transcript. A resume rejection is plumbing,
      // not the model — it is always worth one fallback rerun, transient or
      // not, still under the same `item.retry` loop guard (never two).
      // And the rerun's reply IS the answer the user asked for, so no
      // failure notice goes out when the fallback is queued.
      // M2: a TIMEOUT is not a resume rejection — the CLI session survives
      // the kill, so the row must too (a zero-text timeout on the resume
      // ride reaches here with item.retry set; wiping the row would turn
      // every later turn into a full replay).
      if (useResume && !output.timedOut) db.clearSession(roomId, character.id)
      const fallbackRetry = useResume && !item.retry
      const retryQueued =
        (fallbackRetry || isTransientFailure(output)) &&
        !item.retry &&
        db.getCharacter(character.id) !== undefined &&
        enqueue(roomId, character.id, item.triggerMessageId, item.hop, item.override, {
          allowActive: true,
          retry: true,
          isRoundSummary: item.isRoundSummary,
          roundId: item.roundId ?? null,
          // The retry re-runs THIS turn's work — it keeps the card link
          // (B03 review 2: a restart between error and retry must not
          // orphan the association).
          taskId: item.taskId ?? null,
        })
      if (fallbackRetry && retryQueued) return
      const message = db.addMessage({
        roomId,
        authorType: 'system',
        authorName: '系统',
        content: `⚠️ ${character.name}（${character.harness}）运行失败：${truncate(output.error, 800)}（exit ${output.exitCode}，耗时 ${Math.round((output.durationMs ?? 0) / 1000)} 秒）${retryQueued ? '，正在自动重试一次' : ''}`,
        meta: { harness: character.harness, model: character.model, pid: output.pid, error: output.error },
      })
      broadcast(roomId, 'message', { roomId, message })
      return
    }

    // A turn that produced partial text before an error (e.g. the hard
    // timeout) still lands as the character's message, but carries
    // meta.error so the UI can flag it as possibly incomplete. A turn with
    // no text at all gets an informative placeholder instead of a bare one.
    const content =
      output.text.trim() ||
      `（${character.name} 没有返回正文 · 耗时 ${Math.round((output.durationMs ?? 0) / 1000)} 秒 · exit ${output.exitCode} · 工具调用 ${output.toolTraces?.length ?? 0} 次）`
    // M1 media: `[media] <path>` lines become short markdown links served by
    // /api/files (relay/handoff below read the rewritten text, so a media
    // line never leaks into delivery or a follow-up prompt as a raw path).
    const media = rewriteMediaLines(content)
    // Who this reply hands off to (developer → reviewer), one relay level
    // deeper than the message that triggered this turn. Computed BEFORE the
    // row is written so `meta.relayTo` can carry the truth — the UI shows
    // "接力 → GLM" from it instead of re-implementing `shouldWake`.
    // Errored/truncated turns don't relay: meta.error already flags the reply
    // as possibly incomplete, so chaining the room on a half-finished message
    // would be worse than staying quiet. Round-summary turns never relay
    // either: the summary is a wrap-up, and relaying it would let a summary
    // wake up followers (anyone listening on the summarizer), turning the
    // "last word" into a new relay round.
    const relays = !output.error && !item.isRoundSummary
    // Extract once, match per member — the same shape as the user-message
    // router above, so a room of ten members parses ten names, not ten
    // markdown trees.
    const plain = relays ? visibleText(media.text) : ''
    const followers = relays
      ? db
          .listCharacters(room.id)
          .filter(
            (member) =>
              member.id !== character.id &&
              shouldWake(
                member,
                {
                  authorType: 'character',
                  characterId: character.id,
                  authorName: character.name,
                  content: media.text,
                },
                plain,
              ),
          )
      : []

    // After-snapshot (SOP gate 3a): what did THIS turn change on disk? Only
    // successful turns are judged — stopped/error turns keep whatever their
    // CLI partially did, and pinning that noise onto the round's evidence
    // would block closes on half-finished work. Unjudgeable (non-git) stays
    // null; equal digests short-circuit to "no changes"; a digest that moved
    // without a attributable diff degrades to the after snapshot's dirty set
    // (see changedPathsBetween — a tracked file edited again keeps its XY
    // code, and an ungated change is worth more than precise attribution).
    let changedPaths: string[] | null = null
    if (before.available) {
      const after = await snapshotWorktree(cwd)
      changedPaths = changedPathsBetween(before, after)
    }

    // B06 handoff: this reply hands the room to its followers — attach the
    // five-tuple so the relayed turns can inject it (see the pump-side
    // comment). Only relayed replies carry one (no followers → nothing to
    // hand off; summary turns never relay). The inputs are the WHITELIST:
    // the round's delivery INCLUDING this turn's (stripped of the verdict
    // line), the round's cumulative changed paths INCLUDING this turn's, and
    // the task card's why/acceptance when this round executes a card. No
    // gate conclusions — the gate runs at queue-drain, not here.
    // Round guard on EVERY round-sourced input (B06 review 5): a new human
    // message while the followers sit queued replaces the live round —
    // falling back to the NEW round's delivery/verify state would describe
    // a relay this handoff never inherited.
    const ownRound = round && round.roundId === item.roundId ? round : null
    const handoff =
      followers.length > 0
        ? buildHandoff({
            lastDelivery: episodeDelivery(media.text) || ownRound?.lastDelivery || '',
            changedPaths: [...(ownRound?.changedPaths ?? []), ...(changedPaths ?? [])],
            taskId: item.taskId ?? null,
            taskWhy: item.taskId ? (db.getTask(item.taskId)?.why ?? null) : null,
            taskAcceptance: item.taskId ? (db.getTask(item.taskId)?.acceptance ?? null) : null,
            verifyConfigured: room.verifyCommand.trim().length > 0,
            // No own round at settle time (replaced mid-flight / restored
            // turn) = its verify never ran → pending, the conservative truth.
            verifyPending: (ownRound?.verifyState ?? 'none') === 'none',
          })
        : null

    const message = db.addMessage({
      roomId,
      authorType: 'character',
      characterId: character.id,
      authorName: character.name,
      authorAvatar: character.avatar,
      color: character.color,
      content: media.text,
      meta: {
        harness: character.harness,
        model: character.model,
        turnId,
        durationMs: output.durationMs,
        exitCode: output.exitCode,
        pid: output.pid,
        sessionId: output.sessionId,
        tokens: output.tokens,
        thinking: output.thinking ? truncate(output.thinking, 4000) : undefined,
        tools: output.toolTraces as ToolTrace[] | undefined,
        events: output.events?.length ? output.events.slice(-200) : undefined,
        error: output.error,
        relayTo: followers.length > 0 ? followers.map((member) => member.name) : undefined,
        // Session continuity (P0-1): flags whether this reply came from a
        // resumed CLI session (incremental prompt) or a full replay.
        resume: useResume || undefined,
        generated: true,
        // M1: absolute paths behind the rewritten media links — the archive /
        // gallery hook later features can build on.
        ...(media.attachments.length > 0 ? { attachments: media.attachments } : {}),
        ...(changedPaths && changedPaths.length > 0 ? { changed: changedPaths } : {}),
        // B06: the five-tuple relay context — see the handoff block above.
        ...(handoff ? { handoff } : {}),
      },
    })

    db.updateTurn(turnId, {
      status: output.error ? 'error' : 'done',
      output: content,
      error: output.error ?? null,
      endedAt: Date.now(),
      changed: changedPaths,
    })
    // The round's last real turn settled (B03 review 2): a reply that landed
    // with meta.error counts as an errored outcome — the card must not close
    // as done on a possibly-incomplete run. The same spot records the round's
    // delivery line for the episode memory (B04) — but a verdict-ONLY reply
    // ("REVIEW: PASS" alone, the gate convention's minimal reviewer) strips
    // to an empty string and must NOT wipe the real delivery above it
    // (B04 review 2), or the next same-facts round would dedupe against a
    // blanked episode.
    if (round && round.roundId === item.roundId && !item.isRoundSummary) {
      round.lastTurnOutcome = output.error ? 'error' : 'ok'
      const delivery = episodeDelivery(content)
      if (delivery) round.lastDelivery = delivery
    }
    broadcast(roomId, 'turn', {
      roomId,
      turnId,
      characterId: character.id,
      status: output.error ? 'error' : 'done',
    })
    broadcast(roomId, 'message', { roomId, message })

    // Review verdict (SOP gate 3b): any character may end a message with a
    // standalone REVIEW: line — the round's LATEST verdict wins, and every
    // verdict lands in round_checks as audit evidence. The table's verdict
    // column speaks pass/fail, so CHANGES maps to 'fail' with the original
    // line kept in detail.
    const verdict = parseReviewVerdict(content)
    if (verdict) {
      if (item.roundId) {
        db.addRoundCheck({
          roomId,
          roundId: item.roundId,
          kind: 'review',
          verdict: verdict === 'pass' ? 'pass' : 'fail',
          characterId: character.id,
          messageId: message.id,
          detail: verdict === 'pass' ? 'REVIEW: PASS' : 'REVIEW: CHANGES',
        })
      }
      // Summary turns are not reviews (B05): they run AFTER the gate passed;
      // letting them overwrite the verdict (or pose as its author) could
      // flip a settled round's judgment.
      if (round && round.roundId === item.roundId && !item.isRoundSummary) {
        round.verdict = verdict
        round.verdictAuthor = { id: character.id, harness: character.harness }
        round.verdictMessageId = message.id
      }
    }
    // Fold this turn's changes into the round's evidence (3a): the gate at
    // close time judges the round's CUMULATIVE footprint, not per-turn.
    // changedPathsBetween returns an EMPTY ARRAY for a no-change turn — a
    // truthiness check here would overwrite changedAuthor on every reply
    // (the B05 probe: the reviewer became the "implementer" and its PASS read
    // as self-review). Length, not truthiness.
    if (round && round.roundId === item.roundId && changedPaths && changedPaths.length > 0) {
      for (const path of changedPaths) {
        if (!round.changedPaths.includes(path)) round.changedPaths.push(path)
      }
      // B05: the "implementer" the PASS must not come from — the author of
      // the round's LAST turn that changed the worktree. Summary turns are
      // excluded (they are the round's closing act, not its work).
      if (!item.isRoundSummary) {
        round.changedAuthor = { id: character.id, harness: character.harness }
      }
    }
    // B11 pre-commit blind review: once a changed, successful turn settles,
    // queue the designated independent reviewer with ONLY the request + the
    // current worktree diff. Its verdict is what the SOP gate will read, so
    // the round can still close (and auto-commit) without a chat-context
    // review. Runs at most once per round; blind turns never re-trigger it.
    if (
      room.blindReview &&
      !item.blind &&
      !item.isRoundSummary &&
      !output.error &&
      round &&
      round.roundId === item.roundId &&
      !round.blindReviewQueued &&
      changedPaths &&
      changedPaths.length > 0
    ) {
      const choice = pickReviewer({
        characters: db.listCharacters(roomId),
        designatedId: room.reviewerCharacterId,
        author: { id: character.id, harness: character.harness },
      })
      if (!choice.reviewer) {
        if (!round.blindWarned) {
          round.blindWarned = true
          sendGateNotice(
            roomId,
            choice.reason === 'designated-ineligible'
              ? '⚠️ 已开启盲审，但指定 reviewer 不可用（停用 / 轮末总结角色 / 与实现者同 harness），本轮按原流程处理。'
              : '⚠️ 已开启盲审，但没有符合条件的独立 reviewer（启用、非总结角色、与实现者不同 harness），本轮按原流程处理。',
          )
        }
      } else if (rounds.get(roomId) === round) {
        const reviewer = choice.reviewer
        round.blindReviewQueued = true
        // B14: bind the pool-selected reviewer to this round so the gate
        // checks ITS verdict and harness, not just "someone other than the
        // implementer".
        round.blindReviewer = { id: reviewer.id, name: reviewer.name, harness: reviewer.harness }
        const diff = await renderWorktreeDiff(cwd, round.changedPaths, 2_400)
        if (rounds.get(roomId) !== round) return
        const request = [...fetched].reverse().find((entry) => entry.authorType === 'user')?.content?.trim() ?? ''
        const override = [
          '【盲审任务】你是独立 reviewer。群聊记录、记忆与交接已被隐藏，只能依据下面的需求和 diff 判断，不要假设实现者的叙述。',
          `【原始需求】\n${request.slice(0, 600) || '（未记录原始需求）'}`,
          `【改动文件】\n${round.changedPaths.join('\n') || '（无）'}`,
          `【Diff】\n${diff || '（无文本 diff，可能是二进制文件）'}`,
          '请检查正确性、边界条件、回归风险与需求覆盖；不要改代码。最后单独一行给出 REVIEW: PASS 或 REVIEW: CHANGES。',
        ].join('\n\n')
        enqueue(roomId, reviewer.id, message.id, item.hop, override, {
          allowActive: true,
          blind: true,
          roundId: item.roundId,
          taskId: item.taskId,
        })
        sendGateNotice(roomId, `🔍 已排入盲审：${reviewer.name} 只接收原始需求与 diff，结论决定本轮能否收尾。`)
      }
    }
    // Session continuity (P0-1): a clean turn that surfaced a CLI session id
    // (re)writes the row; the cursor is what this prompt actually represented
    // — rendered or folded (B01), computed by the prompt layer over the
    // messages it carried. Errored and stopped turns never advance the
    // cursor — the next run re-sends rather than silently skipping
    // (duplication is recoverable, a skip is not). Rows are written even
    // under AC_SESSION_RESUME=0: the switch disables the RIDE, not the
    // bookkeeping, so flipping it back on resumes seamlessly.
    // M2 exception: a TIMED-OUT turn also writes the row — the CLI session
    // survives the kill and the model DID consume the input this prompt
    // represented, so the cursor advance is honest; without the row the
    // timeout resume below would find nothing to ride.
    if (!item.blind && (!output.error || output.timedOut) && output.sessionId) {
      db.setSession({
        roomId,
        characterId: character.id,
        harness: character.harness,
        model: character.model,
        sessionId: output.sessionId,
        consumedAt: built.nextCursor.at,
        consumedSeq: built.nextCursor.seq,
      })
    }
    enqueueFollowers(roomId, message.id, followers, item.hop + 1, item.roundId ?? null, item.taskId ?? null)
    // M3: a timed-out turn with partial text lands as-is (meta.error flags
    // the truncation) and the session row survives — the ladder decides the
    // next rung (resume / report / breaker). A clean turn resets the
    // room+character timeout streak (one success clears the breaker).
    if (output.error) {
      scheduleTimeoutRecovery(roomId, character, item, output, adapter)
    } else {
      timeoutStreaks.delete(`${roomId}:${character.id}`)
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    console.error(`[agent-crowd] pump(${roomId}) failed:`, reason)
    if (activeTurnId !== null) {
      // A crashed turn is an errored outcome (B03 review 3): anything that
      // ESCAPES the adapter or the scheduling around it — a missing CLI
      // binary throwing inside run(), mkdirSync EEXIST on a cwd pointing at
      // a file, a snapshot failure — never reaches the output.error branch
      // above, and without this the round would settle its task card as
      // done on a crashed turn. Round identity re-checked live: if the
      // entry was replaced mid-crash, the old round never settles (the card
      // stays running for a re-dispatch — the safe direction).
      const round = rounds.get(roomId)
      if (round && round.roundId === activeRoundId && !activeIsSummary) {
        round.lastTurnOutcome = 'error'
        round.lastError = reason
      }
      // Best-effort state repair — the db may itself be what's broken, so
      // each step is guarded; a second throw here would defeat the handler.
      try {
        db.updateTurn(activeTurnId, { status: 'error', error: reason, endedAt: Date.now() })
      } catch {
        /* db broken */
      }
      try {
        broadcast(roomId, 'turn', { roomId, turnId: activeTurnId, characterId: activeCharacterId, status: 'error' })
      } catch {
        /* sse broken */
      }
      try {
        const message = db.addMessage({
          roomId,
          authorType: 'system',
          authorName: '系统',
          content: `⚠️ ${activeCharacterName} 回合调度异常：${truncate(reason, 800)}`,
          meta: { harness: activeHarness, error: reason },
        })
        broadcast(roomId, 'message', { roomId, message })
      } catch {
        /* db broken */
      }
    }
  } finally {
    if (activeTurnId !== null && active.get(roomId)?.turnId === activeTurnId) active.delete(roomId)
    if (activeTurnId !== null) broadcast(roomId, 'busy', { roomId, busy: false, characterId: null })
    // Continue with the rest of the queue — but only when an item was
    // consumed here: re-pumping the empty-queue path would schedule itself
    // forever (each no-op pump would queue the next).
    if (consumed) void pump(roomId)
    // B10: release this pump's own ref; a nested pump (next turn / verify)
    // holds its own, so other rooms only gain the directory at count zero.
    if (activeRoom) releaseWorkdir(activeRoom)
    // The relay chain reached its end and every queue is empty: this is the
    // all-idle moment a pending POST /api/restart waits for (server/restart.ts).
    maybeRestartNow()
  }
}
