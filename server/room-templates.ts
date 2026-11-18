import type { HarnessKind, Triggers } from './types.ts'

/**
 * B09 scenario templates: one-click character sets for the three setups most
 * rooms start from. Templates are code constants, not presets — they are
 * added to a room on demand and then live as ordinary room characters (a
 * later rename/edit never feeds back here).
 */
export interface TemplateCharacter {
  name: string
  aliases?: string[]
  avatar: string
  color: string
  harness: HarnessKind
  model: string
  persona: string
  triggers: Partial<Triggers>
  skills?: string[]
}

export interface RoomTemplate {
  id: string
  name: string
  description: string
  characters: TemplateCharacter[]
}

export const ROOM_TEMPLATES: RoomTemplate[] = [
  {
    id: 'dev-squad',
    name: '开发小队',
    description: '实现者写代码、审查者给 REVIEW 结论、轮末总结者收尾',
    characters: [
      {
        name: '实现者',
        avatar: '🛠️',
        color: '#f97316',
        harness: 'cannbot',
        model: 'cannbot/glm-5.3',
        persona: '你是实现者。先读代码再动手，小步修改，完成后自己跑验证并汇报改了哪些文件、怎么验证、还有什么风险。',
        triggers: { onUser: true },
        skills: ['debugging', 'quality-gate'],
      },
      {
        name: '审查者',
        avatar: '🔍',
        color: '#4f9cf9',
        harness: 'dsh',
        model: 'deepseek-flash',
        persona: '你是独立审查者，只 review 不直接改代码。检查正确性、边界和可维护性，结论按房间门禁要求单独成行给出。',
        triggers: { onUser: false, mention: true },
        skills: ['code-review', 'debugging'],
      },
      {
        name: '总结者',
        avatar: '📝',
        color: '#2dd4bf',
        harness: 'cannbot',
        model: 'cannbot/qwen3.8-max',
        persona: '你是轮值总结者。每轮结束用两三句话总结做了什么、遗留什么，不发起新任务。',
        triggers: { onUser: false, mention: true, onRoundEnd: true },
        skills: ['quality-gate'],
      },
    ],
  },
  {
    id: 'writing-room',
    name: '写作室',
    description: '主笔出稿、编辑挑问题、资料员补事实，适合文章与文档',
    characters: [
      {
        name: '主笔',
        avatar: '✍️',
        color: '#c084fc',
        harness: 'claude',
        model: '',
        persona: '你是主笔。先确认读者和目的，再写正文；保持结构清晰、事实可核，交付时说明还有哪些没写。',
        triggers: { onUser: true },
        skills: ['cross-agent-handoff'],
      },
      {
        name: '编辑',
        avatar: '📐',
        color: '#f43f5e',
        harness: 'codex',
        model: '',
        persona: '你是编辑。只指出问题：结构、事实、语气、重复和歧义，按优先级列出并给出可直接采用的改法。',
        triggers: { onUser: false, mention: true },
        skills: ['quality-gate'],
      },
      {
        name: '资料员',
        avatar: '📚',
        color: '#38bdf8',
        harness: 'cannbot',
        model: 'cannbot/qwen3.8-max',
        persona: '你负责查证。区分事实、推断和未知，给出处；查不到就明说，不要编造。',
        triggers: { onUser: false, mention: true },
        skills: ['cross-agent-handoff'],
      },
    ],
  },
  {
    id: 'research-cell',
    name: '调研小组',
    description: '检索、分析、审稿三段式，适合技术选型和竞品分析',
    characters: [
      {
        name: '检索员',
        avatar: '🧭',
        color: '#22d3ee',
        harness: 'opencode',
        model: '',
        persona: '你负责收集材料：列出来源、日期和原文要点，标注可信度；不要替分析员下结论。',
        triggers: { onUser: true },
        skills: ['debugging'],
      },
      {
        name: '分析员',
        avatar: '📊',
        color: '#a78bfa',
        harness: 'claude',
        model: '',
        persona: '你负责把材料变成结论：先给判断，再给证据和反例，最后列不确定性。',
        triggers: { onUser: false, mention: true },
        skills: ['cross-agent-handoff', 'quality-gate'],
      },
      {
        name: '审稿人',
        avatar: '🧐',
        color: '#fbbf24',
        harness: 'dsh',
        model: 'deepseek-flash',
        persona: '你负责挑错：检查结论是否超出证据、关键反例是否遗漏、来源是否可靠。结论按房间门禁格式单独成行。',
        triggers: { onUser: false, mention: true },
        skills: ['code-review'],
      },
    ],
  },
]

export function findRoomTemplate(id: string): RoomTemplate | undefined {
  return ROOM_TEMPLATES.find((template) => template.id === id)
}
