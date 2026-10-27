import { describeTimeout, idleTimeoutMs, runProcess, turnTimeoutMs } from './process.ts'
import type { AdapterEvent, HarnessAdapter, RunInput, RunOutput } from './types.ts'
import { safeJsonParse } from '../util.ts'
import type { HarnessKind, TurnTokens } from '../types.ts'
import type { LaunchSpec } from './bins.ts'

interface OpencodePart {
  id?: string
  type?: string
  text?: string
  tool?: string
  callID?: string
  title?: string
  state?: { status?: string; title?: string; input?: unknown; output?: string; error?: string }
  tokens?: {
    total?: number
    input?: number
    output?: number
    reasoning?: number
    cache?: { read?: number; write?: number }
  }
}

interface OpencodeEvent {
  type?: string
  sessionID?: string
  part?: OpencodePart
  error?: { name?: string; message?: string; data?: { message?: string } }
  text?: string
}

export interface OpencodeLikeOptions {
  id: HarnessKind
  label: string
  /** Resolve the executable, or null when the CLI is not installed. */
  resolve: () => LaunchSpec | null
  /** CLI flag that auto-approves tool calls. */
  autoApproveFlag: string
  /** Message shown when the binary cannot be found. */
  missingHint: string
  /** Command used to list models (without the binary). */
  modelsArgs?: string[]
}

/**
 * opencode and cannbot are the same CLI lineage: `run --format json` emits one
 * JSON event per line, with whole text parts, tool parts, and token totals.
 * One adapter drives both; only the binary and the auto-approve flag differ.
 */
export function createOpencodeLikeAdapter(options: OpencodeLikeOptions): HarnessAdapter {
  return {
    id: options.id,
    label: options.label,

    async run(input: RunInput): Promise<RunOutput> {
      const spec = options.resolve()
      if (!spec) throw new Error(options.missingHint)

      const started = Date.now()
      const args = [...spec.argsPrefix, 'run', '--format', 'json']
      if (input.character.model.trim()) args.push('--model', input.character.model.trim())
      if (input.character.autoApprove) args.push(options.autoApproveFlag)
      args.push('--dir', input.cwd, input.prompt)

      const textParts: { id: string; text: string }[] = []
      const toolStarted = new Map<string, { name: string; at: number }>()
      const tools: { name: string; ok: boolean; detail?: string; durationMs?: number }[] = []
      let sessionId: string | undefined
      let tokens: TurnTokens | undefined
      let apiError: string | undefined
      let sawJson = false

      const result = await runProcess(spec.command, args, {
        cwd: input.cwd,
        signal: input.signal,
        timeoutMs: turnTimeoutMs(),
        idleTimeoutMs: idleTimeoutMs(),
        onSpawn: input.onSpawn,
        onStdoutLine: (line) => {
          const event = safeJsonParse<OpencodeEvent>(line)
          if (!event) return
          sawJson = true
          if (event.sessionID && !sessionId) sessionId = event.sessionID
          const type = event.type

          if (type === 'error') {
            apiError = event.error?.data?.message ?? event.error?.message ?? `${options.label} 返回未知错误`
            input.emit({ kind: 'status', text: `错误：${apiError}` })
            return
          }

          if (type === 'text') {
            const partId = event.part?.id ?? 'text'
            const text = String(event.part?.text ?? event.text ?? '')
            if (!text) return
            const existing = textParts.find((part) => part.id === partId)
            if (!existing) {
              textParts.push({ id: partId, text })
              input.emit({ kind: 'text', text })
            } else if (text.startsWith(existing.text)) {
              const delta = text.slice(existing.text.length)
              existing.text = text
              if (delta) input.emit({ kind: 'text', text: delta })
            } else {
              existing.text = text
            }
            return
          }

          if (type === 'tool') {
            const part = event.part ?? {}
            const name = String(part.tool ?? part.title ?? 'tool')
            const callId = String(part.callID ?? part.id ?? name)
            const status = part.state?.status
            if (status === 'running' || status === 'pending') {
              if (!toolStarted.has(callId)) {
                toolStarted.set(callId, { name, at: Date.now() })
                input.emit({ kind: 'tool', text: `调用 ${name}` })
              }
            } else if (status === 'completed' || status === 'error') {
              const startedAt = toolStarted.get(callId)
              tools.push({
                name,
                ok: status === 'completed',
                durationMs: startedAt ? Date.now() - startedAt.at : undefined,
                detail: part.state?.title,
              })
              input.emit({ kind: 'tool', text: `${status === 'completed' ? '完成' : '失败'} ${name}` })
            }
            return
          }

          if (type === 'step_finish') {
            const raw = event.part?.tokens
            if (raw) {
              tokens = {
                input: raw.input,
                output: raw.output,
                total: raw.total,
                cacheRead: raw.cache?.read,
                cacheWrite: raw.cache?.write,
              }
            }
          }
        },
      })

      const text = textParts
        .map((part) => part.text)
        .filter((part) => part.trim().length > 0)
        .join('\n\n')

      const stderrTail = result.stderr.trim()
      const error =
        apiError ??
        (result.spawnError ||
          (result.aborted
            ? '已停止'
            : describeTimeout(result) ||
              (result.code !== 0 && !text
                ? stderrTail || `${options.label} 退出码 ${result.code}`
                : undefined)))

      return {
        text,
        sessionId,
        pid: result.pid,
        tokens,
        toolTraces: tools,
        exitCode: result.code ?? -1,
        durationMs: Date.now() - started,
        error: error || undefined,
        thinking: !sawJson && stderrTail ? stderrTail.slice(0, 4000) : undefined,
      }
    },

    async listModels(): Promise<string[]> {
      const spec = options.resolve()
      if (!spec) return []
      const result = await runProcess(spec.command, [...spec.argsPrefix, ...(options.modelsArgs ?? ['models'])], {
        cwd: process.cwd(),
        timeoutMs: 60_000,
      })
      return result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => /^[\w.-]+\/[\w.:/-]+$/.test(line))
    },
  }
}

export type { AdapterEvent }
