import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { HarnessAdapter, RunInput, RunOutput } from './types.ts'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Deterministic session id per character (session continuity, P0-1): every
 * clean mock turn reports one, so the sessions table and the resume path can
 * be exercised end-to-end offline (session-check P4-P6).
 */
const mockSessionId = (characterId: string): string => `mock-${characterId.slice(0, 8)}`

/**
 * Mock adapter: no API key, no subprocess. It streams a canned reply so the
 * chat room and the hand-off chain can be exercised offline.
 */
export const mockAdapter: HarnessAdapter = {
  id: 'mock',
  label: 'Mock',
  // Symbolic only — mock runs in-process, nothing is ever spawned. The
  // fragment exists so the orchestrator's resume capability gate (and
  // session-check P3) treat mock as resume-capable; the seam itself reads
  // input.resume directly.
  resumeArgs: (id: string): string[] => ['--session', id],

  async run(input: RunInput): Promise<RunOutput> {
    const started = Date.now()
    // Steer notes render as `用户（中途补充给 X）: …`, so allow a suffix
    // between 用户 and the colon — the steer rerun must see the newest line.
    const lastUser = [...input.prompt.matchAll(/\] 用户[^:\n]*: ([^\n]*)/g)].pop()?.[1] ?? ''
    // Test seams for smoke.mjs: simulate the three degraded outcomes a real
    // CLI can produce, so the orchestrator's error plumbing stays testable
    // offline (partial text + timeout, error with no text, empty output).
    if (lastUser.includes('模拟超时')) {
      const text = '只写了开头一句话'
      input.emit({ kind: 'text', text })
      return { text, exitCode: -1, durationMs: Date.now() - started, error: '运行超时' }
    }
    if (lastUser.includes('模拟失败')) {
      return { text: '', exitCode: 7, durationMs: Date.now() - started, error: 'boom（模拟失败）' }
    }
    if (lastUser.includes('模拟空输出')) {
      return { text: '', exitCode: 0, durationMs: Date.now() - started, tokens: { input: 0, output: 0, total: 0 } }
    }
    if (lastUser.includes('模拟慢速')) {
      // Streams a chunk every 400ms for ~5s so smoke can hit the stop button
      // mid-turn and verify the partial reply is preserved.
      let slowText = ''
      for (let i = 1; i <= 12; i++) {
        if (input.signal.aborted) {
          return { text: slowText, exitCode: 130, durationMs: Date.now() - started, error: '已停止' }
        }
        const chunk = `第${i}段 `
        slowText += chunk
        input.emit({ kind: 'text', text: chunk })
        await sleep(400)
      }
      return { text: slowText, exitCode: 0, sessionId: mockSessionId(input.character.id), durationMs: Date.now() - started }
    }
    if (lastUser.includes('模拟记忆')) {
      // Echoes how many long-term memory entries the prompt carried, so smoke
      // can verify the identity/room injection chain end-to-end.
      const countSection = (label: string): number => {
        const at = input.prompt.indexOf(label)
        if (at < 0) return 0
        const rest = input.prompt.slice(at + label.length)
        const end = rest.indexOf('\n【')
        const section = end > 0 ? rest.slice(0, end) : rest
        return (section.match(/^- /gm) ?? []).length
      }
      const identityCount = countSection('【你的长期记忆】')
      const roomCount = countSection('【房间共享记忆】')
      const reply = `（mock 模式）记忆注入：长期 ${identityCount} 条，共享 ${roomCount} 条`
      for (const chunk of reply.match(/[\s\S]{1,12}/g) ?? []) {
        if (input.signal.aborted) {
          return { text: reply, exitCode: 130, durationMs: Date.now() - started, error: '已停止' }
        }
        input.emit({ kind: 'text', text: chunk })
        await sleep(25)
      }
      return { text: reply, exitCode: 0, sessionId: mockSessionId(input.character.id), durationMs: Date.now() - started, tokens: { input: 0, output: reply.length, total: reply.length } }
    }
    // Test seam for queue-check: the 【现在轮到你】 instruction carries the
    // override a steer persisted on the turn row. When it carries the marker,
    // echo it verbatim so the override's hard-kill → restore round-trip can
    // be asserted from the reply alone (the transcript's user line knows
    // nothing about it).
    const instruction = input.prompt.split('【现在轮到你】\n')[1]?.trimEnd() ?? ''
    if (instruction.includes('回显指令')) {
      const reply = `（mock 模式）指令回显：${instruction}`
      for (const chunk of reply.match(/[\s\S]{1,12}/g) ?? []) {
        if (input.signal.aborted) {
          return { text: reply, exitCode: 130, durationMs: Date.now() - started, error: '已停止' }
        }
        input.emit({ kind: 'text', text: chunk })
        await sleep(25)
      }
      return { text: reply, exitCode: 0, sessionId: mockSessionId(input.character.id), durationMs: Date.now() - started, tokens: { input: 0, output: reply.length, total: reply.length } }
    }
    // Test seams for session-check (P0-1): persona is the behavior switch,
    // same convention as the SOP seams below — other personas resume just
    // fine (their normal replies simply ride the incremental prompt).
    //   MOCK-续传    → a resumed turn replies RESUME-OK with the transcript
    //                  line count + the newest user line, so the check can
    //                  prove the prompt carried ONLY post-cursor messages
    //                  (a full replay would count more lines)
    //   MOCK-会话失效 → a resumed turn dies with "session not found" (zero
    //                  text, fast exit), exercising the orchestrator's
    //                  clear-and-rerun-full fallback
    if (input.resume && input.character.persona.includes('MOCK-会话失效')) {
      return { text: '', exitCode: 8, durationMs: Date.now() - started, error: 'session not found（模拟会话失效）' }
    }
    if (input.resume && input.character.persona.includes('MOCK-续传')) {
      const section = input.prompt.slice(
        input.prompt.indexOf('【最近的群聊记录】'),
        input.prompt.indexOf('\n【现在轮到你】'),
      )
      const newLines = section
        .split('\n')
        .filter((line) => line.trim() && !line.startsWith('【')).length
      // Fold observability (B01): the resumed prompt folds increment
      // messages the budget couldn't render — the count (and whether any sat
      // beyond the fetch window) is what the check asserts on.
      const foldTotal = Number(section.match(/〔已折叠 (\d+) 条/)?.[1] ?? 0)
      const beyondWindow = section.includes('取回窗口之外')
      const reply = `（mock 模式）RESUME-OK：续传会话 ${input.resume.id}，本轮新消息 ${newLines} 条（其中折叠 ${foldTotal} 条${beyondWindow ? '，含取回窗口外计数' : ''}），最新用户消息：${lastUser.slice(0, 80)}`
      for (const chunk of reply.match(/[\s\S]{1,12}/g) ?? []) {
        input.emit({ kind: 'text', text: chunk })
        await sleep(10)
      }
      return { text: reply, exitCode: 0, sessionId: input.resume.id, durationMs: Date.now() - started, tokens: { input: 0, output: reply.length, total: reply.length } }
    }
    // Round 1 of the 续传 scenario: a SINGLE-LINE reply, so the next turn's
    // line count is unambiguous (incremental 2 vs full replay 3 — the
    // default multi-line reply would make both counts shift by its own
    // line count and hide the difference).
    if (!input.resume && input.character.persona.includes('MOCK-续传')) {
      const reply = `（mock 模式）${input.character.name} 已建立会话，本轮全量收到：${lastUser.slice(0, 80)}`
      for (const chunk of reply.match(/[\s\S]{1,12}/g) ?? []) {
        input.emit({ kind: 'text', text: chunk })
        await sleep(10)
      }
      return { text: reply, exitCode: 0, sessionId: mockSessionId(input.character.id), durationMs: Date.now() - started, tokens: { input: 0, output: reply.length, total: reply.length } }
    }
    // Test seams for sop-check (SOP gate, P0-3): the character's PERSONA is
    // the behavior switch — one character per role in the fixture, no
    // prompt-text coupling to the user message.
    //   MOCK-写文件    → really writes a file into cwd (change evidence, 3a)
    //   MOCK-评审通过  → replies ending with a standalone `REVIEW: PASS` (3b)
    //   MOCK-评审返修  → replies ending with a standalone `REVIEW: CHANGES`
    if (input.character.persona.includes('MOCK-写文件')) {
      const file = `mock-${input.character.id.slice(0, 8)}.txt`
      writeFileSync(join(input.cwd, file), `written by ${input.character.name} at ${new Date().toISOString()}\n`)
      const reply = `（mock 模式）${input.character.name} 已在工作目录写入 ${file}。`
      for (const chunk of reply.match(/[\s\S]{1,12}/g) ?? []) {
        input.emit({ kind: 'text', text: chunk })
        await sleep(10)
      }
      return { text: reply, exitCode: 0, sessionId: mockSessionId(input.character.id), durationMs: Date.now() - started, tokens: { input: 0, output: reply.length, total: reply.length } }
    }
    if (input.character.persona.includes('MOCK-评审')) {
      const verdict = input.character.persona.includes('MOCK-评审返修') ? 'REVIEW: CHANGES' : 'REVIEW: PASS'
      const reply = `（mock 模式）${input.character.name} 的 review：改动看起来没问题，同意收尾。\n${verdict}`
      for (const chunk of reply.match(/[\s\S]{1,12}/g) ?? []) {
        input.emit({ kind: 'text', text: chunk })
        await sleep(10)
      }
      return { text: reply, exitCode: 0, sessionId: mockSessionId(input.character.id), durationMs: Date.now() - started, tokens: { input: 0, output: reply.length, total: reply.length } }
    }
    const reply = [
      `（mock 模式）我是 **${input.character.name}**，收到任务：${lastUser.slice(0, 120) || '（群聊上下文）'}`,
      '',
      '这条消息由 mock harness 生成，不会调用任何真实模型。',
      `把角色配置里的 harness 改成 \`opencode\` / \`dsh\` / \`hermes\`，再填上 model，我就能真的干活了。`,
      '',
      `任务已处理完毕，@审查者 请看一下。`,
    ].join('\n')

    for (const chunk of reply.match(/[\s\S]{1,12}/g) ?? []) {
      if (input.signal.aborted) {
        return {
          text: reply,
          exitCode: 130,
          durationMs: Date.now() - started,
          error: '已停止',
        }
      }
      input.emit({ kind: 'text', text: chunk })
      await sleep(25)
    }

    return {
      text: reply,
      sessionId: mockSessionId(input.character.id),
      exitCode: 0,
      durationMs: Date.now() - started,
      tokens: { input: 0, output: reply.length, total: reply.length },
    }
  },

  async listModels(): Promise<string[]> {
    return ['mock']
  },
}
