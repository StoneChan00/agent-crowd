import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveHermes } from './bins.ts'
import { describeTimeout, idleTimeoutMs, runProcess, turnTimeoutMs } from './process.ts'
import { runtimeDir } from '../paths.ts'
import { beginTool, createTimeline, endTool } from './timeline.ts'
import type { HarnessAdapter, RunInput, RunOutput } from './types.ts'
import type { TurnTokens } from '../types.ts'
import { safeJsonParse } from '../util.ts'

interface HermesEvent {
  type?: string
  subtype?: string
  text?: string
  session_id?: string
  exit_code?: number
  model?: string
  error?: string
  name?: string
  tool_call_id?: string
  input?: unknown
  output?: string
  is_error?: boolean
  duration_ms?: number
  tokens?: { input?: number; output?: number; total?: number; cache_read?: number; cache_write?: number }
}

const HERMES_MODELS = ['deepseek-flash', 'deepseek/deepseek-flash', 'deepseek/deepseek-v4-pro']

/**
 * Hermes adapter: `hermes chat --query-file <tmp> --format stream-json -Q`.
 * The prompt goes through a file, so quotes/newlines can never be mangled by
 * Windows command-line parsing.
 */
export const hermesAdapter: HarnessAdapter = {
  id: 'hermes',
  label: 'Hermes',
  capabilities: { thinking: false, tools: 'structured', tokens: true, sessionResume: false },

  async run(input: RunInput): Promise<RunOutput> {
    const spec = resolveHermes()
    if (!spec) {
      throw new Error(
        '找不到 Hermes。请确认 `hermes` 在 PATH 中，或用环境变量 AC_HERMES_BIN 指定 hermes.exe 的完整路径。',
      )
    }

    const started = Date.now()
    const dir = runtimeDir('hermes', input.character.id)
    const promptPath = join(dir, `prompt-${Date.now()}.txt`)
    writeFileSync(promptPath, input.prompt, 'utf8')

    const args = [
      ...spec.argsPrefix,
      'chat',
      '--query-file',
      promptPath,
      '--format',
      'stream-json',
      '-Q',
      '--in',
      input.cwd,
    ]
    const model = input.character.model.trim()
    if (model) args.push('--model', model)
    if (input.character.autoApprove) args.push('--yolo')

    let streamed = ''
    let finalText = ''
    let sessionId: string | undefined
    let tokens: TurnTokens | undefined
    let eventError: string | undefined
    const timeline = createTimeline()

    const result = await runProcess(spec.command, args, {
      cwd: input.cwd,
      signal: input.signal,
      timeoutMs: turnTimeoutMs(),
      idleTimeoutMs: input.idleTimeoutMs ?? idleTimeoutMs(),
      onSilence: input.onSilence,
      onSpawn: input.onSpawn,
      onStdoutLine: (line) => {
        const event = safeJsonParse<HermesEvent>(line)
        if (!event) {
          // Non-JSON noise: keep it only as a fallback transcript.
          streamed += line + '\n'
          return
        }
        const type = event.type
        if (type === 'system') {
          if (event.session_id) sessionId = event.session_id
          return
        }
        if (type === 'text') {
          const text = event.text ?? ''
          if (text) {
            streamed += text
            input.emit({ kind: 'text', text })
          }
          return
        }
        if (type === 'tool_use') {
          const name = event.name ?? 'tool'
          const key = event.tool_call_id ?? name
          const inputText =
            typeof event.input === 'string' ? event.input : event.input ? JSON.stringify(event.input) : undefined
          input.emit(beginTool(timeline, key, name, inputText))
          return
        }
        if (type === 'tool_result') {
          const name = event.name ?? 'tool'
          const key = event.tool_call_id ?? name
          input.emit(endTool(timeline, key, name, !event.is_error, event.output, event.duration_ms))
          return
        }
        if (type === 'result') {
          if (event.session_id) sessionId = event.session_id
          if (typeof event.text === 'string' && event.text.trim()) finalText = event.text
          if (event.tokens) {
            // Hermes reports its own total; cache fields are passed through.
            tokens = {
              input: event.tokens.input,
              output: event.tokens.output,
              total: event.tokens.total ?? (event.tokens.input ?? 0) + (event.tokens.output ?? 0),
              cacheRead: event.tokens.cache_read,
              cacheWrite: event.tokens.cache_write,
            }
          }
          if (event.error) eventError = event.error
          if (event.exit_code !== undefined && event.exit_code !== 0 && !eventError) {
            eventError = `hermes 退出码 ${event.exit_code}`
          }
        }
      },
    })

    const text = (finalText || streamed).trim()
    const stderrTail = result.stderr.trim()
    const error =
      eventError ||
      result.spawnError ||
      (result.aborted
        ? '已停止'
        : describeTimeout(result) ||
          (result.code !== 0 && !text
            ? stderrTail.slice(-3000) || `hermes 退出码 ${result.code}`
            : undefined))

    return {
      text,
      sessionId,
      pid: result.pid,
      tokens,
      toolTraces: timeline.tools,
      events: timeline.events,
      exitCode: result.code ?? -1,
      durationMs: Date.now() - started,
      error: error || undefined,
      timedOut: result.timedOut || undefined,
    }
  },

  async listModels(): Promise<string[]> {
    return [...HERMES_MODELS]
  },
}
