import type { HarnessAdapter, RunInput, RunOutput } from './types.ts'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Mock adapter: no API key, no subprocess. It streams a canned reply so the
 * chat room and the hand-off chain can be exercised offline.
 */
export const mockAdapter: HarnessAdapter = {
  id: 'mock',
  label: 'Mock',

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
      return { text: slowText, exitCode: 0, durationMs: Date.now() - started }
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
      return { text: reply, exitCode: 0, durationMs: Date.now() - started, tokens: { input: 0, output: reply.length, total: reply.length } }
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
      exitCode: 0,
      durationMs: Date.now() - started,
      tokens: { input: 0, output: reply.length, total: reply.length },
    }
  },

  async listModels(): Promise<string[]> {
    return ['mock']
  },
}
