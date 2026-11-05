import { mkdirSync } from 'node:fs'
import * as db from './db.ts'
import { broadcast } from './events.ts'
import { getAdapter } from './harnesses/index.ts'
import { isTransientFailure } from './harnesses/process.ts'
import { ALL_MENTION, matchNames, visibleText } from './mentions.ts'
import { buildTurnPrompt } from './prompt.ts'
// Circular with restart.ts (it imports isBusy): safe - both sides only call
// functions at runtime, never at module top level.
import { maybeRestartNow } from './restart.ts'
import type { Character, HarnessKind, Message, Room, ToolTrace, Turn } from './types.ts'
import { truncate } from './util.ts'

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
   * Marks a round-end summary turn. Summary turns are injected by the
   * orchestrator itself (not by any message) and must never count as round
   * activity, so they can't resurrect a round that is being closed out.
   */
  isRoundSummary?: boolean
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
 *   say why the round ended.
 * A new human message or manual run replaces the entry (new round); a manual
 * stop deletes it (deliberately silenced — the user asked for silence).
 */
interface RoundState {
  hadTurn: boolean
  summarizing: boolean
  endReason: 'completed' | 'limit'
}

const queues = new Map<string, QueueItem[]>()
const active = new Map<string, ActiveTurn>()
const chains = new Map<string, ChainState>()
const rounds = new Map<string, RoundState>()

/** Bound the replay buffers so a chatty turn can't grow memory forever (mirrors the UI's tail-60). */
const REPLAY_CAP = 60
/** Upper bound for the replayed text tail. */
const REPLAY_TEXT_CAP = 200_000

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
  rounds.set(room.id, { hadTurn: false, summarizing: false, endReason: 'completed' })
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
      targets = enabled.slice(0, 1)
    }
  }
  for (const character of targets) {
    // Human intent is explicit: a message aimed at a character that is
    // mid-turn queues a follow-up run for right after, instead of being
    // silently dropped by the dedupe (relay hand-offs keep the dedupe).
    enqueue(room.id, character.id, message.id, 1, undefined, { allowActive: true })
  }
  void pump(room.id)
}

/** Queue one character manually (the "让它发言" action). */
export function runCharacter(room: Room, character: Character, override?: string): void {
  chains.set(room.id, { limitNoticeSent: false })
  rounds.set(room.id, { hadTurn: false, summarizing: false, endReason: 'completed' })
  enqueue(room.id, character.id, null, 1, override, { allowActive: true })
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
    })
    queue.unshift({
      turnId: turn.id,
      characterId: target.id,
      triggerMessageId: message.id,
      hop: 1,
      override,
    })
    queues.set(room.id, queue)
    broadcast(room.id, 'queue', { roomId: room.id, characters: queue.map((item) => item.characterId) })
  } else {
    // Idle target: wake it like a direct call. allowActive bypasses the
    // same-character dedupe (unreachable here — that item went through the
    // `queued` branch); enqueue persists the turn row.
    enqueue(room.id, target.id, message.id, 1, override, { allowActive: true })
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
 * The restored round starts with `hadTurn: false` on purpose: the reboot
 * already interrupted the round these items belonged to, so when they drain
 * there is nothing new to summarize — no summary is fired for pre-restart
 * activity.
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
      // retry/isRoundSummary): a restart must not zero the relay budget,
      // re-aim a steer, re-arm the retry loop guard, or let a summary turn
      // start relaying.
      queue.push({
        turnId: turn.id,
        characterId: turn.characterId,
        triggerMessageId: turn.triggerMessageId,
        hop: turn.hop,
        override: turn.override ?? undefined,
        retry: turn.retry || undefined,
        isRoundSummary: turn.isRoundSummary || undefined,
      })
    }
    if (queue.length === 0) continue
    queues.set(roomId, queue)
    chains.set(roomId, { limitNoticeSent: false })
    rounds.set(roomId, { hadTurn: false, summarizing: false, endReason: 'completed' })
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
  options?: { allowActive?: boolean; retry?: boolean; isRoundSummary?: boolean },
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
    isRoundSummary: options?.isRoundSummary || undefined,
  })
  queue.push({
    turnId: turn.id,
    characterId,
    triggerMessageId,
    hop,
    override,
    retry: options?.retry || undefined,
    isRoundSummary: options?.isRoundSummary || undefined,
  })
  queues.set(roomId, queue)
  broadcast(roomId, 'queue', { roomId, characters: queue.map((item) => item.characterId) })
  return true
}

/**
 * Queue the members this reply hands off to, one relay level deeper. The list
 * is computed before the message is stored (see `pump`) so the row can carry
 * `meta.relayTo`, which is what the UI shows as "接力 → …": the browser
 * displays the router's own verdict instead of re-deriving the trigger rules.
 */
function enqueueFollowers(roomId: string, messageId: string, followers: Character[], nextHop: number): void {
  for (const character of followers) enqueue(roomId, character.id, messageId, nextHop)
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
 * Round-end summary: called from pump()'s empty-queue branch, i.e. the
 * moment a round that ran at least one turn has nothing left to run. Every
 * enabled character with `triggers.onRoundEnd` is queued with a
 * summarization instruction (the hop budget doesn't apply — the summary is
 * orchestrator bookkeeping, not part of the relay chain it closes).
 *
 * Idempotent per round: the `summarizing` flag makes the summary's own
 * settlement (and any relay echo of the summary message) close the round
 * instead of triggering a second summary. Returns whether summary items
 * entered the queue, so the caller can keep pumping instead of flashing
 * the room idle.
 */
function maybeStartRoundSummary(roomId: string): boolean {
  const round = rounds.get(roomId)
  if (!round) return false
  if (!round.hadTurn || round.summarizing) {
    // Nothing to summarize (or the summary already ran): close the round.
    rounds.delete(roomId)
    return false
  }
  const room = db.getRoom(roomId)
  if (!room) {
    rounds.delete(roomId)
    return false
  }
  const summarizers = db.listCharacters(roomId).filter((character) => character.enabled && character.triggers.onRoundEnd)
  if (summarizers.length === 0) {
    rounds.delete(roomId)
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
    queued = enqueue(roomId, character.id, null, 1, override, { isRoundSummary: true }) || queued
  }
  if (!queued) {
    // Every summarizer vanished mid-flight (deleted/disabled): close the round.
    rounds.delete(roomId)
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
  try {
    const room = db.getRoom(roomId)
    if (!room) return

    const queue = queues.get(roomId) ?? []
    const item = queue.shift()
    queues.set(roomId, queue)
    if (!item) {
      // Empty queue + no active turn: the round (if one was running) just
      // ended — either drained naturally or cut by the hop budget. Fire the
      // round-end summary before declaring the room idle, so the summary
      // turn starts without a busy→idle→busy flicker.
      if (maybeStartRoundSummary(roomId)) return void pump(roomId)
      broadcast(roomId, 'busy', { roomId, busy: false, characterId: null })
      return
    }
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
    const controller = new AbortController()
    const replay: TurnReplay = { text: '', thinking: [], tools: [] }
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
    if (round && !round.summarizing && !item.isRoundSummary) round.hadTurn = true
    broadcast(roomId, 'turn', { roomId, turnId, characterId: character.id, status: 'running' })
    broadcast(roomId, 'busy', { roomId, busy: true, characterId: character.id })

    const cwd = character.cwd.trim() || room.workingDir

    mkdirSync(cwd, { recursive: true })
    const messages = db.listMessages(roomId, 80)
    const characters = db.listCharacters(roomId)
    // Long-term memory rides along on every turn: the character's cross-room
    // identity memories plus this room's shared notes, both hard-budgeted so
    // they never crowd out the transcript (see docs/memory-plan.md).
    const identity = db.ensureIdentityForCharacter(character)
    const memories = db.pickMemoriesForPrompt(identity.id, room.id)
    const prompt = buildTurnPrompt({ room, character, characters, messages, cwd, override: item.override, memories })
    db.touchMemories([...memories.identity, ...memories.room].map((memory) => memory.id))
    const adapter = getAdapter(character.harness)

    const output = await adapter.run({
      character,
      room,
      prompt,
      cwd,
      signal: controller.signal,
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
        broadcast(roomId, 'delta', {
          roomId,
          turnId,
          characterId: character.id,
          kind: event.kind,
          text: event.text,
        })
      },
    })

    if (controller.signal.aborted) {
      db.updateTurn(turnId, { status: 'stopped', output: output.text, endedAt: Date.now() })
      broadcast(roomId, 'turn', { roomId, turnId, characterId: character.id, status: 'stopped' })
      // Keep whatever streamed before the stop: without this the text vanished
      // together with the live buffer. meta.error flags it as incomplete.
      if (output.text.trim()) {
        const stopped = db.addMessage({
          roomId,
          authorType: 'character',
          characterId: character.id,
          authorName: character.name,
          authorAvatar: character.avatar,
          color: character.color,
          content: output.text,
          meta: {
            harness: character.harness,
            model: character.model,
            turnId,
            durationMs: output.durationMs,
            exitCode: output.exitCode,
            pid: output.pid,
            error: '已停止',
            generated: true,
          },
        })
        broadcast(roomId, 'message', { roomId, message: stopped })
      }
      return
    }

    if (output.error && !output.text.trim()) {
      db.updateTurn(turnId, {
        status: 'error',
        error: output.error,
        output: output.text,
        endedAt: Date.now(),
      })
      broadcast(roomId, 'turn', { roomId, turnId, characterId: character.id, status: 'error' })
      // A turn that died without a single character of text is worth ONE
      // automatic retry only when it also died FAST (isTransientFailure):
      // a transient CLI hiccup / upstream API error surfaces within
      // seconds, while a timeout by definition ran at least the idle limit
      // — re-running a hung upstream would just double the wait for the
      // same death. `item.retry` is the loop guard: a retry that fails
      // again falls through for good. User-stopped turns return earlier
      // and never reach this; a character deleted mid-run is not
      // re-summoned. The retry can still be dropped by enqueue() when this
      // character is already queued (the user's own @ then serves as the
      // rerun), so the promise below is only made when the retry truly
      // entered the queue.
      const retryQueued =
        isTransientFailure(output) &&
        !item.retry &&
        db.getCharacter(character.id) !== undefined &&
        enqueue(roomId, character.id, item.triggerMessageId, item.hop, item.override, {
          allowActive: true,
          retry: true,
          isRoundSummary: item.isRoundSummary,
        })
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
    const plain = relays ? visibleText(content) : ''
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
                  content,
                },
                plain,
              ),
          )
      : []
    const message = db.addMessage({
      roomId,
      authorType: 'character',
      characterId: character.id,
      authorName: character.name,
      authorAvatar: character.avatar,
      color: character.color,
      content,
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
        error: output.error,
        relayTo: followers.length > 0 ? followers.map((member) => member.name) : undefined,
        generated: true,
      },
    })

    db.updateTurn(turnId, {
      status: output.error ? 'error' : 'done',
      output: content,
      error: output.error ?? null,
      endedAt: Date.now(),
    })
    broadcast(roomId, 'turn', {
      roomId,
      turnId,
      characterId: character.id,
      status: output.error ? 'error' : 'done',
    })
    broadcast(roomId, 'message', { roomId, message })
    enqueueFollowers(roomId, message.id, followers, item.hop + 1)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    console.error(`[agent-crowd] pump(${roomId}) failed:`, reason)
    if (activeTurnId !== null) {
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
    // The relay chain reached its end and every queue is empty: this is the
    // all-idle moment a pending POST /api/restart waits for (server/restart.ts).
    maybeRestartNow()
  }
}
