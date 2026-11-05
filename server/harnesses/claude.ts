import { resolveClaude } from './bins.ts'
import { describeTimeout, idleTimeoutMs, runProcess, turnTimeoutMs } from './process.ts'
import type { HarnessAdapter, RunInput, RunOutput } from './types.ts'
import type { ToolTrace, TurnTokens } from '../types.ts'
import { safeJsonParse } from '../util.ts'

/** One content block inside an assistant/user message (Claude Code stream-json). */
interface ClaudeBlock {
  type?: string
  text?: string
  id?: string
  name?: string
  tool_use_id?: string
  content?: unknown
  is_error?: boolean
}

interface ClaudeEvent {
  type?: string
  subtype?: string
  session_id?: string
  model?: string
  message?: { content?: ClaudeBlock[] }
  result?: string
  error?: string
  is_error?: boolean
  attempt?: number
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  }
}

const CLAUDE_MODELS = ['sonnet', 'opus', 'haiku']

/**
 * Session-continuity resume fragment (P0-1): `claude --resume <id>`
 * continues a stored conversation by session id. Flag verified against
 * `claude --help` (`-r, --resume [value]`) and proven live in P7 smoke —
 * coexists with `-p` and `--output-format stream-json`.
 */
const claudeResumeArgs = (id: string): string[] => ['--resume', id]

/**
 * Claude Code adapter: `claude -p <prompt> --output-format stream-json --verbose`.
 * Same stream-json lineage Hermes speaks (system/assistant/user/result), so the
 * parsing mirrors hermes.ts with Claude-specific fields: reply text arrives as
 * `assistant.message.content` text blocks, tool results come back on `user`
 * events, and the final `result` event carries the authoritative reply text
 * plus usage. The prompt rides argv (like opencodeLike) — spawn runs without a
 * shell, so multi-line prompts survive Windows quoting.
 */
export const claudeAdapter: HarnessAdapter = {
  id: 'claude',
  label: 'Claude Code',
  resumeArgs: claudeResumeArgs,

  async run(input: RunInput): Promise<RunOutput> {
    const spec = resolveClaude()
    if (!spec) {
      throw new Error(
        '找不到 Claude Code。请先 `npm install -g @anthropic-ai/claude-code`，或用环境变量 AC_CLAUDE_BIN 指定 claude 可执行文件的完整路径。',
      )
    }

    const started = Date.now()
    const args = [...spec.argsPrefix, '-p', input.prompt, '--output-format', 'stream-json', '--verbose']
    if (input.resume) args.push(...claudeResumeArgs(input.resume.id))
    const model = input.character.model.trim()
    if (model) args.push('--model', model)
    // Mirror codex's read-only fallback: without an explicit mode the global
    // ~/.claude/settings.json defaultMode "acceptEdits" keeps letting a
    // "no auto-approve" character edit files. "default" denies every
    // permission-requiring tool in headless mode (no interactive prompt).
    if (input.character.autoApprove) args.push('--dangerously-skip-permissions')
    else args.push('--permission-mode', 'default')

    let streamed = ''
    let finalText = ''
    let sessionId: string | undefined
    let tokens: TurnTokens | undefined
    let eventError: string | undefined
    const tools: ToolTrace[] = []
    const toolNames = new Map<string, string>()
    const toolStartedAt = new Map<string, number>()
    const announcedTools = new Set<string>()
    let lastAssistantText = ''

    const result = await runProcess(spec.command, args, {
      cwd: input.cwd,
      signal: input.signal,
      timeoutMs: turnTimeoutMs(),
      idleTimeoutMs: idleTimeoutMs(),
      onSpawn: input.onSpawn,
      onStdoutLine: (line) => {
        const event = safeJsonParse<ClaudeEvent>(line)
        if (!event) return // claude emits pure JSONL; anything else is noise
        const type = event.type
        if (type === 'system') {
          if (event.session_id) sessionId = event.session_id
          if (event.subtype === 'api_retry') {
            input.emit({ kind: 'status', text: `API 重试（第 ${event.attempt ?? '?'} 次）` })
          }
          return
        }
        if (type === 'assistant') {
          if (event.session_id) sessionId = event.session_id
          const blocks = event.message?.content ?? []
          const text = blocks
            .filter((block) => block.type === 'text')
            .map((block) => block.text ?? '')
            .join('')
          // stream-json replays the full message on each event: emit only the
          // new tail, same prefix-delta trick as opencodeLike.
          const delta = text.startsWith(lastAssistantText) ? text.slice(lastAssistantText.length) : text
          lastAssistantText = text
          if (delta) {
            streamed += delta
            input.emit({ kind: 'text', text: delta })
          }
          for (const block of blocks) {
            if (block.type === 'tool_use' && block.id) {
              toolNames.set(block.id, block.name ?? 'tool')
              if (!announcedTools.has(block.id)) {
                announcedTools.add(block.id)
                toolStartedAt.set(block.id, Date.now())
                input.emit({ kind: 'tool', text: `调用 ${block.name ?? 'tool'}` })
              }
            }
          }
          return
        }
        if (type === 'user') {
          for (const block of event.message?.content ?? []) {
            if (block.type === 'tool_result' && block.tool_use_id) {
              const name = toolNames.get(block.tool_use_id) ?? 'tool'
              const at = toolStartedAt.get(block.tool_use_id)
              const output = typeof block.content === 'string' ? block.content : JSON.stringify(block.content)
              tools.push({
                name,
                ok: !block.is_error,
                durationMs: at ? Date.now() - at : undefined,
                detail: output?.slice(0, 300),
              })
              input.emit({ kind: 'tool', text: `${block.is_error ? '失败' : '完成'} ${name}` })
            }
          }
          return
        }
        if (type === 'result') {
          if (event.session_id) sessionId = event.session_id
          if (typeof event.result === 'string' && event.result.trim()) finalText = event.result
          if (event.usage) {
            tokens = {
              input: event.usage.input_tokens,
              output: event.usage.output_tokens,
              cacheRead: event.usage.cache_read_input_tokens,
              cacheWrite: event.usage.cache_creation_input_tokens,
            }
          }
          // stream-json error results often carry only subtype+result (e.g.
          // error_max_turns) with no `error` field; without this fallback the
          // error text ends up in finalText, output.error stays empty and the
          // orchestrator records a failed turn as done (mirrors hermes's
          // exit_code fallback).
          if (event.is_error) {
            const detail = typeof event.error === 'string' ? event.error : (typeof event.result === 'string' ? event.result.trim() : '')
            eventError = detail || `claude 返回失败（${event.subtype ?? 'unknown'}）`
          } else if (event.error && !finalText) eventError = event.error
          return
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
            ? stderrTail.slice(-3000) || `claude 退出码 ${result.code}`
            : undefined))

    return {
      text,
      sessionId,
      pid: result.pid,
      tokens,
      toolTraces: tools,
      exitCode: result.code ?? -1,
      durationMs: Date.now() - started,
      error: error || undefined,
    }
  },

  async listModels(): Promise<string[]> {
    return [...CLAUDE_MODELS]
  },
}
