import { MEMORY_KIND_LABELS, type Character, type Handoff, type Memory, type Message, type Room, type Skill } from './types.ts'
import { planSkills } from './skills.ts'
import { visibleText } from './mentions.ts'
import { truncate } from './util.ts'

/**
 * Per-message cap inside the transcript each agent sees. Sized for intact
 * delivery of a full review / fix report: real ones run 1.5k–2.5k chars, and
 * the 1_200 this replaced cut them mid-list — review P3 items vanished on
 * their way to the reviewed agent and had to be re-read from the DB by hand.
 * Pathological dumps (a pasted log) are still bounded.
 */
export const MAX_MESSAGE_CHARS = 4_000

/**
 * Per-message cap for task-card messages (B03): the approval message is
 * operator-authored from per-field caps (title 120 + what 4k + why/acceptance
 * 2k) and legitimately runs past the chat cap — cutting it at 4k would drop
 * the acceptance criteria, the one field the assignee must see whole. The
 * transcript budget (18k) still bounds everything downstream.
 */
const TASK_MESSAGE_CHARS = 9_000

/**
 * Whole-transcript budget, filled newest-first. 18k admits four max-length
 * messages plus their header lines — the minimum closing loop
 * (需求 → 修复汇报 → review → 二次修复汇报) must fit uncropped — while
 * ordinary short messages still pack a dozen or more.
 */
export const TRANSCRIPT_CHAR_BUDGET = 18_000

/** Hard ceiling for the whole prompt; see the overflow guard at the bottom. */
export const MAX_TOTAL_PROMPT = 32_000

/**
 * Fold budget (B01): when a resumed turn's increment overflows the
 * transcript budget, the messages the newest-first fill leaves out ride
 * along as a deterministic fold summary (count + oldest-first excerpts, no
 * model call) instead of being dropped silently — a dropped increment is a
 * permanent skip, because the session cursor advances past whatever the
 * prompt represented. Capped so the fold can never crowd out rendered lines.
 */
const FOLD_BUDGET = 800
/** The fold's absolute floor: the one-line count marker always fits. */
const FOLD_MIN_BUDGET = 96
/** Excerpt body per folded message. */
const FOLD_EXCERPT_CHARS = 80
/**
 * Floor for the transcript budget under the 32k guard: one max-length
 * message plus its fold marker. A head (persona/roster/memory) so big that
 * even this doesn't fit is what the last-resort head slice is for — the
 * transcript is the one part the guard never cuts.
 */
const MIN_TRANSCRIPT_BUDGET = 4_600

/** `provider/model` for model strings; plain ids keep the room's default provider. */
export function describeModel(character: Character): string {
  return character.model.trim() || '默认模型'
}

function clockOf(message: Message): string {
  return new Date(message.createdAt).toLocaleTimeString('zh-CN', { hour12: false })
}

/** The speaker part of a transcript line, shared by render and fold excerpts. */
function speakerLabel(message: Message): string {
  if (message.authorType === 'user') {
    const steer = message.meta?.steer
    return steer ? `用户（中途补充给 ${steer.targetName}）` : '用户'
  }
  if (message.authorType === 'system') return '系统'
  const tag = message.meta?.harness ? ` (${message.meta.harness})` : ''
  return `${message.authorName}${tag}`
}

function transcriptLine(message: Message): string {
  const cap = message.meta?.taskId ? TASK_MESSAGE_CHARS : MAX_MESSAGE_CHARS
  const body = truncate(message.content.trim(), cap)
  // Change evidence (SOP gate, P0-3 3a): reviewers see what a turn touched
  // without leaving the transcript. Five paths max — the full list lives on
  // the message meta, this is the reviewer's glance line.
  const changed = message.authorType === 'character' ? (message.meta?.changed ?? []) : []
  const changedTag = changed.length
    ? ` [改动: ${changed.slice(0, 5).join('、')}${changed.length > 5 ? ` 等 ${changed.length} 个文件` : ''}]`
    : ''
  return `[${clockOf(message)}] ${speakerLabel(message)}: ${body}${changedTag}`
}

function memoryLine(memory: Memory): string {
  const label = MEMORY_KIND_LABELS[memory.kind]
  return `- ${memory.pinned ? '📌' : `[${label}]`} ${memory.content}`
}

/**
 * Session cursor (P0-1): the (createdAt, seq) of the newest message already
 * delivered into a CLI session. `seq` (the messages table's rowid) is the
 * same-millisecond tiebreaker — `createdAt` alone is not a total order, and a
 * bare `>` on it would permanently skip a sibling message written within the
 * same millisecond (scripted clients double-post that fast; review round 2).
 */
export interface SessionCursor {
  at: number
  seq: number
}

/** Lexicographic (createdAt, seq): the same order the messages query sorts by. */
function isAfterCursor(message: Message, cursor: SessionCursor): boolean {
  return message.createdAt > cursor.at || (message.createdAt === cursor.at && message.seq > cursor.seq)
}

/** Fold header marker — also what the mock smoke seam greps the count from. */
const FOLD_MARK = '〔已折叠'

/**
 * Deterministic fold summary (B01) for increment messages the newest-first
 * render leaves out: count, time range, per-speaker counts, then
 * oldest-first excerpts until the room runs out. No model, no clock drift —
 * same input, same block. `overflow` counts messages older than the fetch
 * window (a pathological flood); they are represented by count only, which
 * is still enough for the cursor to advance honestly.
 */
function foldBlock(dropped: Message[], room: number, overflow: number): string[] {
  if (dropped.length === 0 && overflow === 0) return []
  const total = dropped.length + overflow
  if (dropped.length === 0) return [`${FOLD_MARK} ${total} 条较早的新消息，均在取回窗口之外，仅计数〕`]
  const first = dropped[0]
  const last = dropped[dropped.length - 1]
  const counts = new Map<string, number>()
  for (const message of dropped) counts.set(speakerLabel(message), (counts.get(speakerLabel(message)) ?? 0) + 1)
  const speakers = [...counts.entries()].map(([name, count]) => `${name}×${count}`).join('、')
  const header =
    `${FOLD_MARK} ${total} 条较早的新消息（${clockOf(first)} → ${clockOf(last)}，发言：${speakers}` +
    `${overflow > 0 ? `，另有 ${overflow} 条在取回窗口之外仅计数` : ''}）；以下为最旧几条的开头摘录，其余仅计数不展开〕`
  if (header.length + 1 > room) {
    // Squeezed budget: the count marker alone still represents every dropped
    // message — an excerpt-less fold beats a silent drop. This one-liner is
    // the fold's hard floor (~40 chars, always inside FOLD_MIN_BUDGET) and
    // the one place the block may exceed `room` by a few chars; the 32k
    // guard absorbs it.
    return [`${FOLD_MARK} ${total} 条较早的新消息，因长度预算未逐条展开〕`]
  }
  const lines = [header]
  let used = header.length + 1
  let excerpted = 0
  for (const message of dropped) {
    const line = `[${clockOf(message)}] ${speakerLabel(message)}: ${truncate(message.content.trim(), FOLD_EXCERPT_CHARS)}`
    if (used + line.length > room) break
    lines.push(line)
    used += line.length + 1
    excerpted += 1
  }
  // Overflow stays in the header's own disclosure — counting it here again
  // would read as "N dropped messages went missing" when the header already
  // says they sit beyond the fetch window (review round 1, non-blocking 2).
  const rest = dropped.length - excerpted
  const restLine = `…（其余 ${rest} 条未摘录，仅计入上述总数）`
  if (rest > 0 && used + restLine.length + 1 <= room) lines.push(restLine)
  return lines
}

interface TranscriptPlan {
  /** Fold block (when one was needed) + rendered lines, in display order. */
  lines: string[]
  /** Messages shown verbatim. */
  rendered: Message[]
  /**
   * Everything the prompt represents, verbatim or folded — the only messages
   * the session cursor may advance past. Fresh turns trim silently (a cold
   * start's recency window: nothing trimmed there ever rode the session), so
   * for them `represented` is just the rendered suffix.
   */
  represented: Message[]
  /**
   * Messages carried ONLY by the fold summary: the dropped ones plus any
   * beyond the fetch window (the latter aren't in `represented` — the count
   * marker speaks for them). Purely observability; the cursor never reads it.
   */
  foldedOnly: number
}

/** Newest-first fill: the index rendered starts at (0 = everything fit). */
function fillNewestFirst(visible: Message[], budget: number): { dropIndex: number; used: number } {
  let used = 0
  for (let index = visible.length - 1; index >= 0; index -= 1) {
    const line = transcriptLine(visible[index])
    if (used + line.length > budget) return { dropIndex: index + 1, used }
    used += line.length + 1
  }
  return { dropIndex: 0, used }
}

function planTranscript(visible: Message[], budget: number, fold: boolean, overflow: number): TranscriptPlan {
  if (visible.length === 0 && overflow === 0) return { lines: [], rendered: [], represented: [], foldedOnly: 0 }
  // The newest message (this turn's trigger) always renders; when a fold is
  // possible, its count marker reserves room too. A budget below this floor
  // is a mis-sized budget, not a license to drop the trigger.
  const newestLen = visible.length ? transcriptLine(visible[visible.length - 1]).length : 0
  const effective = Math.max(budget, newestLen + (fold ? FOLD_MIN_BUDGET : 0) + 2)
  const plainIndex = (fill: { dropIndex: number }): number =>
    visible.length === 0 ? 0 : fill.dropIndex >= visible.length ? visible.length - 1 : fill.dropIndex
  const pass1 = fillNewestFirst(visible, effective)
  if (!fold || (pass1.dropIndex === 0 && overflow === 0)) {
    // Everything fits — or a fresh turn, where the trim is the cold start's
    // recency window, not a skip.
    const rendered = visible.slice(plainIndex(pass1))
    return { lines: rendered.map(transcriptLine), rendered, represented: rendered, foldedOnly: 0 }
  }
  // Overflow on a resumed turn (B01): re-fill with the fold budget reserved,
  // then fold everything older into the deterministic summary above. Nothing
  // is dropped silently, so the cursor may advance to the newest the prompt
  // carries — represented = rendered + folded, never more.
  const reserve = Math.min(FOLD_BUDGET, Math.max(FOLD_MIN_BUDGET, Math.floor(effective / 8)))
  const renderBudget = Math.max(effective - reserve, newestLen + 1)
  const pass2 = fillNewestFirst(visible, renderBudget)
  const start = plainIndex(pass2)
  const rendered = visible.slice(start)
  const dropped = visible.slice(0, start)
  const foldRoom = Math.min(FOLD_BUDGET, Math.max(FOLD_MIN_BUDGET, effective - pass2.used - 2))
  const block = foldBlock(dropped, foldRoom, overflow)
  return {
    lines: [...block, ...rendered.map(transcriptLine)],
    rendered,
    represented: block.length > 0 ? [...dropped, ...rendered] : rendered,
    foldedOnly: (block.length > 0 ? dropped.length : 0) + overflow,
  }
}

/**
 * buildTurnPrompt's result (B01): the prompt text plus what it represented.
 */
export interface TurnPromptBuild {
  prompt: string
  /**
   * Cursor over everything the prompt represented — rendered or folded. The
   * orchestrator persists THIS (never "newest of what was fetched"): a
   * cursor past a message the prompt didn't represent is a permanent skip.
   */
  nextCursor: SessionCursor
  /**
   * Increment messages carried only by the fold summary: the dropped ones
   * plus any beyond the fetch window (count-only). Observability — the
   * cursor is derived from `nextCursor` alone.
   */
  foldedCount: number
}

/**
 * Compose the single prompt that carries room context + persona into a
 * harness one-shot run, and report what it represented. Kept deliberately
 * explicit: every harness sees the same "you are a chat member" contract.
 */
export function buildTurnPromptDetailed(input: {
  room: Room
  character: Character
  characters: Character[]
  messages: Message[]
  cwd: string
  override?: string
  /** Long-term memory: the character's cross-room identity notes + this room's shared notes. */
  memories?: { identity: Memory[]; room: Memory[] }
  /**
   * Session cursor (P0-1): with `resumed`, only messages strictly after this
   * cursor land in the transcript — the CLI's own session already carries
   * the older context. Undefined / {at: 0, seq: 0} = everything.
   */
  since?: SessionCursor
  /** True when this turn rides the character's persisted CLI session (P0-1). */
  resumed?: boolean
  /**
   * B06: the five-tuple relay context carried by the message this turn
   * answers (its meta.handoff). Rendered as a HEAD section (after the
   * memory sections, before the chat rules) — deliberately NOT in the
   * transcript, so B01's budget fold can never eat it and resumed turns
   * carry it too. Empty fields render as omitted lines.
   */
  handoff?: Handoff
  /**
   * B07: this turn's available skill catalog (name-sorted — loadSkills
   * does that), orchestrator-loaded fresh per turn. Absent = no skills.
   * Only CHECKED skills (character.skills) can inject, and only when this
   * round's visible messages hit them.
   */
  skills?: Skill[]
  /**
   * B01: messages older than the resumed fetch window (a pathological flood
   * — more than the orchestrator's fetch limit arrived in one gap). They are
   * folded by COUNT only; the alternative (fetching newest-only and
   * advancing the cursor regardless) would skip them without even a count.
   */
  foldOverflow?: number
  /**
   * B11 blind review: show ONLY the persona and the caller's override
   * (request + diff). Chat history, memory, handoff and skills are omitted —
   * the point is to judge the diff without the implementer's narrative.
   */
  blind?: boolean
}): TurnPromptBuild {
  const { room, character, cwd } = input
  const blind = input.blind === true
  const others = input.characters.filter((member) => member.id !== character.id)

  // Session continuity (P0-1): a resumed turn ships ONLY what arrived after
  // the cursor. The comparison is (createdAt, seq) — a bare createdAt filter
  // would swallow same-millisecond siblings of the cursor message.
  const since: SessionCursor = input.since ?? { at: 0, seq: 0 }
  const visible = blind
    ? []
    : input.resumed
      ? input.messages.filter((message) => isAfterCursor(message, since))
      : input.messages

  const displayName = (member: Character): string => {
    const extras = member.aliases.length ? `（可 @别名：${member.aliases.join('、')}）` : ''
    return `${member.name}${extras}`
  }

  const roster = others.length
    ? others.map((member) => `- ${displayName(member)}（${member.harness} / ${describeModel(member)}）`).join('\n')
    : '（暂无其他成员）'

  const nickname = character.aliases.length
    ? `${character.name}（别名：${character.aliases.join('、')}）`
    : character.name

  const memorySections: string[] = []
  if (!blind && input.memories?.identity.length) {
    memorySections.push(
      '【你的长期记忆】（跨房间随身携带，钉选📌条目最重要）',
      input.memories.identity.map(memoryLine).join('\n'),
      '',
    )
  }
  if (!blind && input.memories?.room.length) {
    memorySections.push(
      '【房间共享记忆】（本房间团队的公共事实与决议）',
      input.memories.room.map(memoryLine).join('\n'),
      '',
    )
  }

  // B06: the handoff section rides in the HEAD (never the transcript — the
  // budget fold must not eat it; resumed turns carry it too). Empty fields
  // are omitted lines, so a handoff always renders at least Next Action —
  // the one line the receiver cannot act without; What itself may be empty
  // (a verdict-only relay with no prior round delivery).
  const handoffSection: string[] = []
  if (!blind && input.handoff) {
    handoffSection.push(
      '【交接】（上一棒交给你的现场；接力事实，接手前先读）',
      // Every field is an omitted line when empty (B06 review 3): a
      // verdict-only relay with no prior round delivery renders just the
      // header + Next Action — never a bare `- What：` with nothing after
      // the colon.
      ...(input.handoff.what ? [`- What：${input.handoff.what}`] : []),
      ...(input.handoff.why ? [`- Why：${input.handoff.why}`] : []),
      ...(input.handoff.tradeoff ? [`- Tradeoff：${input.handoff.tradeoff}`] : []),
      ...(input.handoff.openQuestions ? [`- Open Questions：${input.handoff.openQuestions}`] : []),
      `- Next Action：${input.handoff.nextAction}`,
      '',
    )
  }

  // B07: the skills section rides in the HEAD after the handoff, before the
  // chat rules — the fold can never eat it and resumed turns carry it too.
  // Matching sources are THIS round's visible messages (the same corpus the
  // transcript renders): keywords read the raw contents, `@skill:` reads
  // visibleText() output so code spans / fences don't count (the same
  // boundary as an @name call), and only messages whose raw text contains
  // "@skill:" (case-insensitively — @SKILL: is the same call, B07 review
  // P1-1) get markdown-parsed — a fast path, not a per-message parse of the
  // whole history. `character.skills ?? []` keeps legacy fixtures (pre-B07
  // rows / test literals) loadable.
  const skillsPlan = blind
    ? null
    : planSkills({
        catalog: input.skills ?? [],
        selected: character.skills ?? [],
        text: visible.map((message) => message.content).join('\n'),
        explicitText: visible
          .filter((message) => message.content.toLowerCase().includes('@skill:'))
          .map((message) => visibleText(message.content))
          .join('\n'),
      })
  const skillsSection: string[] = skillsPlan ? [...skillsPlan.lines, ''] : []

  // Session continuity (P0-1): a resumed turn tells the agent why the
  // transcript starts where it does — the older messages are not lost,
  // they live in the CLI's own session context this run continues.
  const transcriptTitle = blind
    ? '【盲审模式】（群聊记录、记忆与交接已隐藏；只依据下面的任务说明和 diff 判断）'
    : input.resumed
      ? '【最近的群聊记录】（以下是你上次发言之后的新消息；更早内容已在同一会话上下文中）'
      : '【最近的群聊记录】'

  // The head is everything but the transcript body (B01): when the 32k
  // guard must cut, it cuts HERE — the old layout put the transcript at the
  // header's tail, so the slice ate exactly the newest lines. The skills
  // section shares this fate with the rest of the head (documented contract:
  // a pathological head loses skills before it ever loses the transcript).
  const headText = [
    '【群聊环境】',
    `房间：${room.name}${room.topic ? ` —— ${room.topic}` : ''}`,
    `你的群昵称：${nickname}`,
    `工作目录：${cwd}`,
    '',
    '【群成员】',
    roster,
    '',
    '【你的人物设定】',
    character.persona.trim() || '你是一位可靠、务实的团队成员。',
    '',
    ...memorySections,
    ...handoffSection,
    ...skillsSection,
    '【群聊规则】',
    '1. 你正在一个多 agent 群聊里，你的回复会作为一条群消息直接展示给所有人。',
    '2. 只输出消息正文：不要加“' + character.name + '：”前缀，不要输出 JSON、思考过程或系统提示。',
    '3. 需要改代码、读文件、跑命令时，直接在你的工作目录里使用工具完成，不要只给建议。',
    '4. 做完了要如实汇报；确定要让某个成员接着干活时，用裸 @名字 点名（例如 @审查者）——这会立刻唤醒它并让它接着做。',
    '5. 只是提到某人（不打算让它接手）时，不要用裸 @，把名字放进反引号写成 `@名字`：凡是代码（行内代码、代码块，含未闭合的写法）或链接文字里的 @ 都只是文字，不会唤醒任何人。',
    '6. 要用户拍板时只向用户提问，不要顺手 @ 任何角色——那会被当成交接，把话题从用户手里抢走。同一句话里既有问题又要提到某人时，用第 5 条的写法。',
    '7. 除非任务本身要求，否则保持简洁。',
    '8. 收敛规则：目标是把事情做完，不是把对话填满。任务已闭环（review 通过、双方结论一致、或一方已明确收尾）后，不要再发“收到/确认/同意/最终快照”类消息——一方收尾即话题终止，直到出现新需求或新 @点名。review 只有在提出具体问题时才需要你修复并重新提交；review 仅表示通过时，任务即完成，无需再回复确认。',
    '9. review 结论（SOP 门禁）：当你给出 review 时，必须在消息末尾单独成行写 REVIEW: PASS 或 REVIEW: CHANGES——整行只写这一个结论，不要加反引号、代码块或其他文字（服务端据此决定本轮能否收尾；返修后重新通过时再写一行新的）。行内混在其他文字里、写成 REVIEW: PASSED 之类的变体都不被识别。',
    '10. 不要自行执行 git commit / git push：本房间的改动由服务器在 review PASS 后自动提交。手动提交会让本轮改动绕过门禁和自动盲审，review 也看不到。除非用户明确要求，否则不要自己提交。',
    ...(room.verifyCommand.trim()
      ? [
          '11. 本房间配置了验证命令（收尾门禁）：服务端会在轮末收尾前自动运行它，你不需要自己跑测试来证明改动没问题——把改动和 review 结论本身做好即可。',
        ]
      : []),
    '',
    '',
  ].join('\n')

  // The tail is the one part the overflow guard never cuts, so a tail larger
  // than the ceiling itself would slip through unbounded: a 40k override
  // produced a 40_022-char prompt and blew the 32_767-char argv limit of the
  // spawned CLI before it emitted a single event. An override is steering
  // text on the scale of one chat message — cap it as such; a blank override
  // still falls back to the default instruction.
  const override = truncate(input.override?.trim() ?? '', MAX_MESSAGE_CHARS)
  const instruction =
    override || `现在轮到你（${character.name}）发言。请直接给出你要发到群里的那条消息。`

  const tail = `\n【现在轮到你】\n${instruction}\n`

  // Transcript budget (B01): the 18k default, squeezed down when the fixed
  // parts (head + title + tail) crowd the 32k ceiling — and never below the
  // floor (one max-length message + fold marker). Only a head that crowds
  // out even the floor triggers the last-resort slice below; the transcript
  // is the LAST thing to shrink and the one thing never cut.
  const fixed = headText.length + transcriptTitle.length + 2 + tail.length
  const budget = Math.max(Math.min(TRANSCRIPT_CHAR_BUDGET, MAX_TOTAL_PROMPT - fixed), MIN_TRANSCRIPT_BUDGET)
  const plan = planTranscript(visible, budget, input.resumed === true, input.foldOverflow ?? 0)
  const bodyText = blind
    ? '（盲审：不提供聊天上下文，请只依据任务说明与 diff）'
    : plan.lines.join('\n') || (input.resumed ? '（无新消息）' : '（空）')
  const section = `${transcriptTitle}\n${bodyText}`

  let prompt = headText + section + '\n' + tail
  if (prompt.length > MAX_TOTAL_PROMPT) {
    // Last-resort guard (a giant persona, an exploding roster): cut the head —
    // never the transcript (the trigger and the fold live there, B01) and
    // never the tail (the "now it's your turn" instruction is the one part
    // the agent cannot act without).
    const cut = '\n…（上下文过长已截断）\n'
    const headRoom = Math.max(0, MAX_TOTAL_PROMPT - tail.length - section.length - cut.length)
    prompt = headText.slice(0, headRoom) + cut + section + tail
  }
  return {
    prompt,
    nextCursor: nextSessionCursor(plan.represented, since),
    foldedCount: plan.foldedOnly,
  }
}

/** The one-string entry point (pure-layer tests keep their old shape). */
export function buildTurnPrompt(input: Parameters<typeof buildTurnPromptDetailed>[0]): string {
  return buildTurnPromptDetailed(input).prompt
}

/**
 * The max (createdAt, seq) over `messages` — used by the prompt layer to
 * compute the cursor a build leaves behind (see buildTurnPromptDetailed:
 * the orchestrator persists that value, computed over what the prompt
 * REPRESENTED, never over what was merely fetched).
 */
export function nextSessionCursor(messages: Message[], since: SessionCursor): SessionCursor {
  let cursor: SessionCursor = since
  for (const message of messages) {
    if (isAfterCursor(message, cursor)) cursor = { at: message.createdAt, seq: message.seq }
  }
  return cursor
}
