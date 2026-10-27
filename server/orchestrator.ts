import { mkdirSync } from 'node:fs'
import * as db from './db.ts'
import { broadcast } from './events.ts'
import { getAdapter } from './harnesses/index.ts'
import { isTransientFailure } from './harnesses/process.ts'
import { buildTurnPrompt } from './prompt.ts'
import type { Character, HarnessKind, Message, Room, ToolTrace } from './types.ts'
import { truncate } from './util.ts'

interface QueueItem {
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

const queues = new Map<string, QueueItem[]>()
const active = new Map<string, ActiveTurn>()
const chains = new Map<string, ChainState>()

/** Matches `@all` (or `@所有人`) as a whole word on both sides, so `team@all.com` or `@all-hands` won't wake everyone. */
const ALL_MENTION = /(?<![A-Za-z0-9_])@(?:all|所有人)(?![A-Za-z0-9_\u4e00-\u9fff])/i
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

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Case-insensitive `@name` mention with word boundaries on both sides:
 * `@fish` won't match `@fisher` or `boss@fish`, and the CJK-aware trailing
 * boundary keeps `@鱼` from matching `@鱼头`.
 */
function isMentioned(content: string, name: string): boolean {
  if (!name) return false
  return new RegExp(`(?<![A-Za-z0-9_])@${escapeRegExp(name)}(?![A-Za-z0-9_\\u4e00-\\u9fff])`, 'i').test(content)
}

/** Any of the character's call-names (name + aliases) is @'d. */
function matchNames(character: Character, content: string): boolean {
  if (isMentioned(content, character.name)) return true
  return character.aliases.some((alias) => isMentioned(content, alias))
}

/**
 * A human message routes strictly by mention (name or alias):
 * - `@all` / `@所有人` wakes every enabled character;
 * - `@name` / `@alias` wakes only the mentioned characters;
 * - mentioning only disabled characters wakes nobody — a system notice
 *   explains why — instead of falling through to a bystander;
 * - no mention (or a name that matches nobody) falls back to the first
 *   enabled character.
 * The relay budget resets on every human message.
 */
export function handleUserMessage(room: Room, message: Message): void {
  chains.set(room.id, { limitNoticeSent: false })
  const everyone = db.listCharacters(room.id)
  const enabled = everyone.filter((character) => character.enabled)
  let targets: Character[]
  if (ALL_MENTION.test(message.content)) {
    targets = enabled
  } else {
    const mentionedAny = everyone.filter((character) => matchNames(character, message.content))
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
    // Already waiting its turn: re-aim the pending item at the steer note.
    queued.triggerMessageId = message.id
    queued.override = override
  } else {
    if (activeIsTarget) {
      // Kill the in-flight run so the rerun starts right away. The active
      // entry survives until the aborted run settles, so the rerun has to
      // bypass enqueue()'s "already active" dedupe and take the head of the
      // queue (the target was running, so it keeps its position).
      current.controller.abort()
      queue.unshift({ characterId: target.id, triggerMessageId: message.id, hop: 1, override })
    } else {
      queue.push({ characterId: target.id, triggerMessageId: message.id, hop: 1, override })
    }
  }
  queues.set(room.id, queue)
  broadcast(room.id, 'queue', { roomId: room.id, characters: queue.map((item) => item.characterId) })
  void pump(room.id)
}

export function stopRoom(roomId: string): void {
  const current = active.get(roomId)
  if (current) current.controller.abort()
  queues.set(roomId, [])
  chains.delete(roomId)
  broadcast(roomId, 'queue', { roomId, characters: [] })
}

function shouldWake(character: Character, message: Message): boolean {
  if (!character.enabled) return false
  const mention = mentions(character, message.content)
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

function mentions(character: Character, content: string): boolean {
  if (!character.triggers.mention) return false
  return matchNames(character, content)
}

function enqueue(
  roomId: string,
  characterId: string,
  triggerMessageId: string | null,
  hop: number,
  override?: string,
  options?: { allowActive?: boolean; retry?: boolean },
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
  queue.push({ characterId, triggerMessageId, hop, override, retry: options?.retry || undefined })
  queues.set(roomId, queue)
  broadcast(roomId, 'queue', { roomId, characters: queue.map((item) => item.characterId) })
  return true
}

function enqueueFollowers(room: Room, message: Message, nextHop: number): void {
  for (const character of db.listCharacters(room.id)) {
    if (character.id === message.characterId) continue
    if (shouldWake(character, message)) enqueue(room.id, character.id, message.id, nextHop)
  }
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
  queues.set(room.id, [])
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
      broadcast(roomId, 'busy', { roomId, busy: false, characterId: null })
      return
    }
    consumed = true
    broadcast(roomId, 'queue', { roomId, characters: queue.map((entry) => entry.characterId) })

    const character = db.getCharacter(item.characterId)
    if (!character || !character.enabled) {
      void pump(roomId)
      return
    }
    activeCharacterId = character.id
    activeCharacterName = character.name
    activeHarness = character.harness
    if (budgetExceeded(room, item.hop)) {
      broadcast(roomId, 'busy', { roomId, busy: false, characterId: null })
      return
    }

    const turn = db.createTurn({
      roomId,
      characterId: character.id,
      triggerMessageId: item.triggerMessageId,
    })
    activeTurnId = turn.id
    const controller = new AbortController()
    const replay: TurnReplay = { text: '', thinking: [], tools: [] }
    active.set(roomId, {
      turnId: turn.id,
      characterId: character.id,
      controller,
      startedAt: Date.now(),
      replay,
    })
    db.updateTurn(turn.id, { status: 'running' })
    broadcast(roomId, 'turn', { roomId, turnId: turn.id, characterId: character.id, status: 'running' })
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
        if (entry?.turnId !== turn.id) return
        entry.pid = pid
        // Also persist on the turn row: a hard-killed server runs no exit
        // hooks, so this pid is the only handle the boot sweep has to reap
        // the orphaned CLI tree afterwards.
        try {
          db.setTurnPid(turn.id, pid)
        } catch {
          /* db hiccup; the in-memory pid still works for this session */
        }
        broadcast(roomId, 'pid', { roomId, turnId: turn.id, characterId: character.id, pid })
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
          turnId: turn.id,
          characterId: character.id,
          kind: event.kind,
          text: event.text,
        })
      },
    })

    if (controller.signal.aborted) {
      db.updateTurn(turn.id, { status: 'stopped', output: output.text, endedAt: Date.now() })
      broadcast(roomId, 'turn', { roomId, turnId: turn.id, characterId: character.id, status: 'stopped' })
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
            turnId: turn.id,
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
      db.updateTurn(turn.id, {
        status: 'error',
        error: output.error,
        output: output.text,
        endedAt: Date.now(),
      })
      broadcast(roomId, 'turn', { roomId, turnId: turn.id, characterId: character.id, status: 'error' })
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
        turnId: turn.id,
        durationMs: output.durationMs,
        exitCode: output.exitCode,
        pid: output.pid,
        sessionId: output.sessionId,
        tokens: output.tokens,
        thinking: output.thinking ? truncate(output.thinking, 4000) : undefined,
        tools: output.toolTraces as ToolTrace[] | undefined,
        error: output.error,
        generated: true,
      },
    })

    db.updateTurn(turn.id, {
      status: output.error ? 'error' : 'done',
      output: content,
      error: output.error ?? null,
      endedAt: Date.now(),
    })
    broadcast(roomId, 'turn', {
      roomId,
      turnId: turn.id,
      characterId: character.id,
      status: output.error ? 'error' : 'done',
    })
    broadcast(roomId, 'message', { roomId, message })

    // Hand off to whoever listens to this character (developer → reviewer),
    // one relay level deeper than the message that triggered this turn.
    // Errored/truncated turns don't relay: meta.error already flags the reply
    // as possibly incomplete, so chaining the room on a half-finished message
    // would be worse than staying quiet.
    if (!output.error) enqueueFollowers(room, message, item.hop + 1)
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
  }
}
