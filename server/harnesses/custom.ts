import { describeTimeout, idleTimeoutMs, runProcess, turnTimeoutMs } from './process.ts'
import type { HarnessAdapter, RunInput, RunOutput } from './types.ts'

/**
 * Escape hatch for harnesses without a built-in adapter. The template is run by
 * cmd.exe, with these placeholders substituted:
 *   {prompt} {model} {cwd} {name}
 */
export const customAdapter: HarnessAdapter = {
  id: 'custom',
  label: '自定义命令',

  async run(input: RunInput): Promise<RunOutput> {
    const template = input.character.commandTemplate.trim()
    if (!template) throw new Error('custom harness 需要填写命令模板，例如：my-cli --model {model} "{prompt}"')

    const filled = template
      .replaceAll('{prompt}', input.prompt.replace(/"/g, '\\"'))
      .replaceAll('{model}', input.character.model)
      .replaceAll('{cwd}', input.cwd)
      .replaceAll('{name}', input.character.name)

    const started = Date.now()
    let stdout = ''

    const result = await runProcess(process.env.COMSPEC ?? 'cmd.exe', ['/d', '/s', '/c', filled], {
      cwd: input.cwd,
      signal: input.signal,
      timeoutMs: turnTimeoutMs(),
      idleTimeoutMs: idleTimeoutMs(),
      onSpawn: input.onSpawn,
      onStdoutLine: (line) => {
        stdout += line + '\n'
        input.emit({ kind: 'text', text: line + '\n' })
      },
      onStderrLine: (line) => {
        input.emit({ kind: 'thinking', text: line })
      },
    })

    const text = stdout.trim()
    const error =
      result.spawnError ||
      (result.aborted
        ? '已停止'
        : describeTimeout(result) ||
          (result.code !== 0 && !text
            ? result.stderr.trim().slice(-2000) || `退出码 ${result.code}`
            : undefined))

    return {
      text,
      pid: result.pid,
      exitCode: result.code ?? -1,
      durationMs: Date.now() - started,
      error: error || undefined,
    }
  },
}
