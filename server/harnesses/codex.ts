import { resolveCodex } from './bins.ts'
import { describeTimeout, idleTimeoutMs, runProcess, turnTimeoutMs } from './process.ts'
import type { HarnessAdapter, RunInput, RunOutput } from './types.ts'
import type { ToolTrace, TurnTokens } from '../types.ts'
import { safeJsonParse } from '../util.ts'

/** One work item of a codex turn (agent_message / reasoning / command_execution / ...). */
interface CodexItem {
  id?: string
  type?: string
  text?: string
  command?: string
  status?: string
  exit_code?: number | null
  aggregated_output?: string
  /** file_change: list of touched files. */
  changes?: { path?: string; kind?: string }[]
  /** mcp_tool_call: server/tool identity plus result payload. */
  server?: string
  tool?: string
  result?: unknown
  error?: string | null
  /** web_search */
  query?: string
}

interface CodexEvent {
  type?: string
  thread_id?: string
  item?: CodexItem
  message?: string
  error?: { message?: string } | string
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cached_input_tokens?: number
    cache_write_input_tokens?: number
  }
}

/**
 * Codex adapter: `codex exec --json --skip-git-repo-check
 * [--dangerously-bypass-approvals-and-sandbox|--sandbox read-only] [--model M]
 * <prompt>` (resumed turns: `exec resume <id>` + `-c sandbox_mode=read-only`
 * when not autoApprove — see buildCodexArgs). `exec` is codex's one-shot
 * non-interactive mode: JSONL events on stdout (thread.started / turn.started
 * / item.* / turn.completed / error / turn.failed), everything else on stderr.
 *
 * The bypass flag is codex's full-trust equivalent of the house style
 * (opencode --auto / cannbot --dangerously-skip-permissions / hermes --yolo);
 * --full-auto is deprecated upstream, so it is deliberately not used. The
 * parser is defensive by design: unknown event or item types are ignored
 * instead of crashing, so schema drift across codex versions degrades to
 * missing traces rather than a broken turn. The final reply is the
 * concatenation of all completed agent_message items.
 */

/**
 * Session-continuity resume fragment (P0-1): `codex exec resume <id>`
 * continues a recorded conversation. Verified by live probe (bogus id):
 * the session id may sit right after the subcommand (clap accepts
 * positionals before options) and the run then fails fast on the SESSION
 * lookup — exactly the shape the orchestrator's clear-and-rerun-full
 * fallback exists for. Note `exec resume` does NOT accept `--sandbox`
 * (rejected at argv parse, only the bypass flag exists), but it DOES
 * accept `-c` overrides — probe-verified: `exec resume <uuid> -c
 * sandbox_mode=read-only --json --skip-git-repo-check "hi"` parses clean
 * and dies only on the session lookup. So a resumed non-autoApprove turn
 * keeps its read-only guarantee via `-c sandbox_mode=read-only`; letting
 * it ride codex's own default would hand the user's explicit "read-only"
 * choice to whatever `sandbox_mode` the local config happens to carry.
 */
const codexResumeArgs = (id: string): string[] => ['exec', 'resume', id]

/**
 * Pure argv assembly for one codex turn (exported for session-check P3).
 * The assembly point itself is asserted — fragment tests alone let the
 * resume branch silently drop the sandbox guarantee through (review round
 * of P0-1); a full-argv assertion pins every flag's presence and position.
 */
export function buildCodexArgs(input: {
  argsPrefix: string[]
  resumeId?: string
  autoApprove: boolean
  model: string
  prompt: string
}): string[] {
  const args = [
    ...input.argsPrefix,
    ...(input.resumeId ? codexResumeArgs(input.resumeId) : ['exec']),
    '--json',
    '--skip-git-repo-check',
    ...(input.autoApprove
      ? ['--dangerously-bypass-approvals-and-sandbox']
      : input.resumeId
        ? ['-c', 'sandbox_mode=read-only']
        : ['--sandbox', 'read-only']),
  ]
  const model = input.model.trim()
  if (model) args.push('--model', model)
  args.push(input.prompt)
  return args
}

export const codexAdapter: HarnessAdapter = {
  id: 'codex',
  label: 'Codex',
  resumeArgs: codexResumeArgs,

  async run(input: RunInput): Promise<RunOutput> {
    const spec = resolveCodex()
    if (!spec) {
      throw new Error(
        '找不到 Codex CLI。请先 `npm install -g @openai/codex`，或用环境变量 AC_CODEX_BIN 指定 codex 可执行文件的完整路径。',
      )
    }

    const started = Date.now()
    const args = buildCodexArgs({
      argsPrefix: spec.argsPrefix,
      resumeId: input.resume?.id,
      autoApprove: input.character.autoApprove,
      model: input.character.model,
      prompt: input.prompt,
    })

    const agentMessages: string[] = []
    let sessionId: string | undefined
    let tokens: TurnTokens | undefined
    let eventError: string | undefined
    const tools: ToolTrace[] = []
    const toolStartedAt = new Map<string, number>()

    const result = await runProcess(spec.command, args, {
      cwd: input.cwd,
      signal: input.signal,
      timeoutMs: turnTimeoutMs(),
      idleTimeoutMs: input.idleTimeoutMs ?? idleTimeoutMs(),
      onSilence: input.onSilence,
      onSpawn: input.onSpawn,
      onStdoutLine: (line) => {
        const event = safeJsonParse<CodexEvent>(line)
        if (!event) return
        const type = event.type
        if (type === 'thread.started') {
          if (event.thread_id) sessionId = event.thread_id
          return
        }
        if (type === 'item.started') {
          const item = event.item
          if (item?.type === 'command_execution' && item.command) {
            const key = item.id ?? item.command
            toolStartedAt.set(key, Date.now())
            input.emit({ kind: 'tool', text: `运行 ${item.command.slice(0, 80)}` })
          }
          return
        }
        if (type === 'item.completed') {
          const item = event.item
          if (!item) return
          if (item.type === 'agent_message') {
            const text = item.text ?? ''
            if (text) {
              agentMessages.push(text)
              input.emit({ kind: 'text', text })
            }
            return
          }
          if (item.type === 'reasoning') {
            const text = item.text ?? ''
            if (text) input.emit({ kind: 'thinking', text: text.slice(0, 400) })
            return
          }
          if (item.type === 'command_execution') {
            const name = (item.command ?? 'command').slice(0, 80)
            const key = item.id ?? name
            const at = toolStartedAt.get(key)
            const ok = item.status !== 'failed' && (item.exit_code ?? 0) === 0
            tools.push({
              name,
              ok,
              durationMs: at ? Date.now() - at : undefined,
              detail: (item.aggregated_output ?? '').slice(0, 300),
            })
            input.emit({ kind: 'tool', text: `${ok ? '完成' : '失败'} ${name}` })
            return
          }
          if (item.type === 'file_change') {
            const paths = (item.changes ?? [])
              .map((change) => change.path ?? '')
              .filter(Boolean)
              .join(', ')
            tools.push({ name: 'file_change', ok: item.status !== 'failed', detail: paths.slice(0, 300) })
            input.emit({ kind: 'tool', text: paths ? `修改文件 ${paths.slice(0, 80)}` : '修改文件' })
            return
          }
          if (item.type === 'mcp_tool_call') {
            const name = `${item.server ?? 'mcp'}/${item.tool ?? 'tool'}`
            const failed = Boolean(item.error) || item.status === 'failed'
            const detailSource =
              item.error ??
              (typeof item.result === 'string' ? item.result : item.result ? JSON.stringify(item.result) : '')
            tools.push({ name, ok: !failed, detail: detailSource.slice(0, 300) })
            input.emit({ kind: 'tool', text: `${failed ? '失败' : '完成'} ${name}` })
            return
          }
          if (item.type === 'web_search') {
            const query = item.query ?? ''
            tools.push({ name: 'web_search', ok: true, detail: query.slice(0, 300) })
            input.emit({ kind: 'tool', text: query ? `搜索 ${query.slice(0, 60)}` : '联网搜索' })
            return
          }
          return
        }
        if (type === 'turn.completed') {
          if (event.usage) {
            tokens = {
              input: event.usage.input_tokens,
              output: event.usage.output_tokens,
              cacheRead: event.usage.cached_input_tokens,
              cacheWrite: event.usage.cache_write_input_tokens,
            }
          }
          return
        }
        if (type === 'error') {
          if (event.message && !eventError) eventError = event.message
          return
        }
        if (type === 'turn.failed') {
          const message = typeof event.error === 'string' ? event.error : event.error?.message
          if (message) eventError = message
          return
        }
      },
    })

    const text = agentMessages.join('\n\n').trim()
    const stderrTail = result.stderr.trim()
    const error =
      eventError ||
      result.spawnError ||
      (result.aborted
        ? '已停止'
        : describeTimeout(result) ||
          (result.code !== 0 && !text
            ? stderrTail.slice(-3000) || `codex 退出码 ${result.code}`
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
      timedOut: result.timedOut || undefined,
    }
  },
}
