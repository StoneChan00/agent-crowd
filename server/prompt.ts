import { MEMORY_KIND_LABELS, type Character, type Memory, type Message, type Room } from './types.ts'
import { truncate } from './util.ts'

const TRANSCRIPT_CHAR_BUDGET = 9_000
const MAX_MESSAGE_CHARS = 1_200
const MAX_TOTAL_PROMPT = 24_000

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
  return `[${clock}] ${message.authorName}${tag}: ${body}`
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
    '4. 做完了要如实汇报；需要别人接手时，用 @名字 点名（例如 @审查者）。',
    '5. 除非任务本身要求，否则保持简洁。',
    '',
    '【最近的群聊记录】',
    recent.join('\n') || '（空）',
    '',
  ].join('\n')

  const instruction =
    input.override?.trim() ||
    `现在轮到你（${character.name}）发言。请直接给出你要发到群里的那条消息。`

  const prompt = `${header}\n【现在轮到你】\n${instruction}\n`
  return prompt.length > MAX_TOTAL_PROMPT
    ? prompt.slice(0, MAX_TOTAL_PROMPT) + '\n…（上下文过长已截断）'
    : prompt
}
