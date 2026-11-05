import { MEMORY_KIND_LABELS, type Character, type Memory, type Message, type Room } from './types.ts'
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
 * Whole-transcript budget, filled newest-first. 18k admits four max-length
 * messages plus their header lines — the minimum closing loop
 * (需求 → 修复汇报 → review → 二次修复汇报) must fit uncropped — while
 * ordinary short messages still pack a dozen or more.
 */
export const TRANSCRIPT_CHAR_BUDGET = 18_000

/** Hard ceiling for the whole prompt; see the overflow guard at the bottom. */
export const MAX_TOTAL_PROMPT = 32_000

/** `provider/model` for model strings; plain ids keep the room's default provider. */
export function describeModel(character: Character): string {
  return character.model.trim() || '默认模型'
}

function transcriptLine(message: Message): string {
  const clock = new Date(message.createdAt).toLocaleTimeString('zh-CN', { hour12: false })
  const body = truncate(message.content.trim(), MAX_MESSAGE_CHARS)
  if (message.authorType === 'user') {
    const steer = message.meta?.steer
    const who = steer ? `用户（中途补充给 ${steer.targetName}）` : '用户'
    return `[${clock}] ${who}: ${body}`
  }
  if (message.authorType === 'system') return `[${clock}] 系统: ${body}`
  const tag = message.meta?.harness ? ` (${message.meta.harness})` : ''
  // Change evidence (SOP gate, P0-3 3a): reviewers see what a turn touched
  // without leaving the transcript. Five paths max — the full list lives on
  // the message meta, this is the reviewer's glance line.
  const changed = message.meta?.changed ?? []
  const changedTag = changed.length
    ? ` [改动: ${changed.slice(0, 5).join('、')}${changed.length > 5 ? ` 等 ${changed.length} 个文件` : ''}]`
    : ''
  return `[${clock}] ${message.authorName}${tag}: ${body}${changedTag}`
}

function memoryLine(memory: Memory): string {
  const label = MEMORY_KIND_LABELS[memory.kind]
  return `- ${memory.pinned ? '📌' : `[${label}]`} ${memory.content}`
}

/**
 * Compose the single prompt that carries room context + persona into a
 * harness one-shot run. Kept deliberately explicit: every harness sees the same
 * "you are a chat member" contract.
 */
export function buildTurnPrompt(input: {
  room: Room
  character: Character
  characters: Character[]
  messages: Message[]
  cwd: string
  override?: string
  /** Long-term memory: the character's cross-room identity notes + this room's shared notes. */
  memories?: { identity: Memory[]; room: Memory[] }
}): string {
  const { room, character, messages, cwd } = input
  const others = input.characters.filter((member) => member.id !== character.id)

  const recent: string[] = []
  let used = 0
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const line = transcriptLine(messages[index])
    if (used + line.length > TRANSCRIPT_CHAR_BUDGET) break
    recent.unshift(line)
    used += line.length + 1
  }

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
  if (input.memories?.identity.length) {
    memorySections.push(
      '【你的长期记忆】（跨房间随身携带，钉选📌条目最重要）',
      input.memories.identity.map(memoryLine).join('\n'),
      '',
    )
  }
  if (input.memories?.room.length) {
    memorySections.push(
      '【房间共享记忆】（本房间团队的公共事实与决议）',
      input.memories.room.map(memoryLine).join('\n'),
      '',
    )
  }

  const header = [
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
    ...(room.verifyCommand.trim()
      ? [
          '10. 本房间配置了验证命令（收尾门禁）：服务端会在轮末收尾前自动运行它，你不需要自己跑测试来证明改动没问题——把改动和 review 结论本身做好即可。',
        ]
      : []),
    '',
    '【最近的群聊记录】',
    recent.join('\n') || '（空）',
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
  const prompt = header + tail
  if (prompt.length <= MAX_TOTAL_PROMPT) return prompt
  // Last-resort guard (a giant persona, an exploding roster): cut the header —
  // never the tail. The "now it's your turn" instruction is the one part the
  // agent cannot act without, so it must survive even the overflow path.
  return header.slice(0, Math.max(0, MAX_TOTAL_PROMPT - tail.length)) + '\n…（上下文过长已截断）' + tail
}
