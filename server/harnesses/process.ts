import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { basename } from 'node:path'
import { stripAnsi } from '../util.ts'

/**
 * Default hard cap for one agent turn; override with `AC_TURN_TIMEOUT_MS`.
 * The idle watchdog below now catches silent hangs, so the wall-clock cap is
 * the backstop for genuinely endless turns — 30 minutes, up from 15, because
 * a turn that was still producing output at 15 minutes got killed mid-reply.
 */
export const DEFAULT_TURN_TIMEOUT_MS = 30 * 60_000

/**
 * Smallest accepted `AC_TURN_TIMEOUT_MS`: a real agent turn never finishes in
 * under a minute, so anything smaller is almost certainly a unit mistake
 * (e.g. `30` meaning "30 minutes" → 30 ms, killing every turn instantly) and
 * falls back to the default.
 */
export const MIN_TURN_TIMEOUT_MS = 60_000

/**
 * Default idle watchdog: kill a turn after this much *silence* (no
 * stdout/stderr bytes at all), regardless of total runtime; override with
 * `AC_IDLE_TIMEOUT_MS` (`0` / `off` / `none` disables it). 10 minutes
 * tolerates a quiet tool call (npm install, typecheck) yet still reaps a
 * CLI stuck on a dead upstream far sooner than the wall-clock cap ever did.
 */
export const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60_000

/**
 * Smallest accepted `AC_IDLE_TIMEOUT_MS`. Deliberately far below the
 * wall-clock floor (60s): a silent-but-legit tool call may take a minute or
 * two, and a bare small number is almost certainly a unit mistake (`30`
 * meaning "30 seconds" → 30 ms, killing every turn mid-install), so it
 * falls back to the default. Tests exercise the watchdog by passing
 * `idleTimeoutMs` straight to `runProcess`, so the floor doesn't need to
 * accommodate them.
 */
export const MIN_IDLE_TIMEOUT_MS = 10_000

const DURATION = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h)?\s*$/i
const UNIT_MS = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 } as const

function parseDurationMs(env: string | undefined, fallback: number, floor: number): number {
  const match = DURATION.exec(env ?? '')
  if (!match) return fallback
  const unit = (match[2] ?? 'ms').toLowerCase() as keyof typeof UNIT_MS
  const value = Number(match[1]) * UNIT_MS[unit]
  return value >= floor ? value : fallback
}

/**
 * `AC_TURN_TIMEOUT_MS` accepts plain milliseconds (`1800000`) or a duration
 * suffix (`30m`, `90s`, `2h`). The old footguns are gone: values like `30m`,
 * an empty string, 0 or NaN used to disable the timeout silently
 * (`timeoutMs && timeoutMs > 0` became false), and a bare small number meant
 * a sub-second timeout. Anything unparseable or below `MIN_TURN_TIMEOUT_MS`
 * now falls back to the default instead. Every harness must go through this
 * helper — a stray `Number(env)` reintroduces the silent-disable bug.
 */
export function turnTimeoutMs(): number {
  return parseDurationMs(process.env.AC_TURN_TIMEOUT_MS, DEFAULT_TURN_TIMEOUT_MS, MIN_TURN_TIMEOUT_MS)
}

/**
 * `AC_IDLE_TIMEOUT_MS` — same grammar as `AC_TURN_TIMEOUT_MS`, plus an
 * explicit opt-out: `0` / `off` / `none` return 0, meaning the idle guard
 * is off (the wall-clock cap still applies). Unparseable or below-floor
 * values fall back to the default, mirroring `turnTimeoutMs()`'s footgun
 * handling.
 */
export function idleTimeoutMs(): number {
  const raw = (process.env.AC_IDLE_TIMEOUT_MS ?? '').trim().toLowerCase()
  if (raw === '0' || raw === 'off' || raw === 'none') return 0
  return parseDurationMs(raw, DEFAULT_IDLE_TIMEOUT_MS, MIN_IDLE_TIMEOUT_MS)
}

/** Human label for whichever limit ended a turn (fed into error messages). */
export function describeTimeout(result: { timedOut: boolean; timeoutKind?: 'idle' | 'hard' }): string | undefined {
  if (!result.timedOut) return undefined
  const say = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1_000)} 秒` : `${Math.round(ms / 60_000)} 分钟`)
  return result.timeoutKind === 'idle'
    ? `运行超时（${say(idleTimeoutMs())} 无输出）`
    : `运行超时（总时长超过 ${say(turnTimeoutMs())}）`
}

/* ------------------------------------------------ failure & pid ownership */

/**
 * A zero-text failure is auto-retried only when it died FAST: a transient
 * CLI hiccup or upstream API error surfaces within seconds, while anything
 * that ran past this mark hit a timeout (idle ≥ 10 min, hard ≥ 30 min) —
 * re-running a hung upstream would just make the user wait twice for the
 * same death. Orchestrator-level policy, kept here so tests can import it
 * without dragging in the database.
 */
export const RETRY_MAX_TRANSIENT_MS = 120_000

/** True when a failed run looks transient enough to be worth one automatic retry. */
export function isTransientFailure(output: { error?: string; text: string; durationMs?: number }): boolean {
  if (!output.error) return false
  if (output.text.trim()) return false
  return (output.durationMs ?? 0) < RETRY_MAX_TRANSIENT_MS
}

/** What the boot sweep managed to learn about a bare pid. */
export interface PidProbe {
  pid: number
  /** Image name, e.g. `node.exe`. */
  name: string
  /** Full command line; empty when only the tasklist fallback answered. */
  commandLine: string
  /** Process creation time (epoch ms); 0 when unknown. */
  createdAtMs: number
}

/** Hosts that run half the machine; a bare image-name match proves nothing for them. */
const GENERIC_HOSTS = new Set(['node.exe', 'cmd.exe', 'powershell.exe', 'pwsh.exe'])

/**
 * Probe a bare pid: image name, command line, creation time. Sync on
 * purpose — the only caller is the boot sweep, which runs once before the
 * server accepts traffic. PowerShell CIM first (name + command line +
 * creation date as one JSON blob — JSON because argv can contain
 * newlines: most adapters pass the whole prompt through the command
 * line); tasklist name-only as a fallback. Returns null when the process
 * is gone or cannot be probed at all.
 */
export function probePid(pid: number): PidProbe | null {
  if (process.platform !== 'win32') return null
  try {
    const script =
      '[Console]::OutputEncoding=[Text.Encoding]::UTF8; ' +
      `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; ` +
      "if ($p) { $t = ''; if ($p.CreationDate) { $t = $p.CreationDate.ToString('o') }; " +
      '[pscustomobject]@{ name = $p.Name; commandLine = [string]$p.CommandLine; createdAt = $t } ' +
      '| ConvertTo-Json -Compress }'
    const out = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      timeout: 15_000,
      windowsHide: true,
    })
    if (out.status === 0 && out.stdout.trim()) {
      const parsed = JSON.parse(out.stdout) as { name?: string; commandLine?: string; createdAt?: string }
      if (parsed.name) {
        return {
          pid,
          name: parsed.name,
          commandLine: parsed.commandLine ?? '',
          createdAtMs: parsed.createdAt ? Date.parse(parsed.createdAt) : 0,
        }
      }
    }
  } catch {
    /* fall through to the tasklist fallback */
  }
  try {
    const out = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
    })
    const match = /^"([^"]+)"/.exec(out.stdout.trim())
    if (match) return { pid, name: match[1], commandLine: '', createdAtMs: 0 }
  } catch {
    /* both probes failed — the caller treats this as "cannot verify" */
  }
  return null
}

/** The launch shape the boot sweep expects a persisted pid to still match. */
export interface LaunchMatch {
  command: string
  /** Extra substrings the command line must contain (script path, template literal). */
  markers?: string[]
}

/**
 * Does the probed pid look like a process spawned from this spec? The boot
 * sweep only owns a bare pid from the DB, and between a crash and the
 * reboot that pid may have been recycled by an unrelated process — the
 * sweep runs on every tsx-watch reload, so the window is real. Require the
 * image name to match and, whenever a command line was probed, that it
 * contains the spec's command path and markers. Generic hosts (node.exe,
 * cmd.exe) never match without a marker or without a command line at all:
 * better to leave an orphan behind than taskkill /T /F someone else's tree.
 */
export function pidMatchesLaunch(probe: PidProbe | null, match: LaunchMatch): boolean {
  if (!probe) return false
  const expectedName = basename(match.command).toLowerCase()
  if (probe.name.toLowerCase() !== expectedName) return false
  const generic = GENERIC_HOSTS.has(expectedName)
  const markers = (match.markers ?? []).filter((marker) => marker.trim().length > 0)
  const line = probe.commandLine.trim().toLowerCase()
  if (!line) {
    // tasklist fallback / access denied: a distinctive image name is the
    // best evidence we will get.
    return !generic
  }
  if (!line.includes(match.command.toLowerCase())) return false
  if (generic && markers.length === 0) return false
  return markers.every((marker) => line.includes(marker.toLowerCase()))
}

/** Live child processes, so the server can reap whole trees on exit. */
const activeChildren = new Set<ChildProcess>()
let exitHookInstalled = false

/**
 * `child.kill()` only signals the direct child. On Windows the grandchildren
 * a CLI spawns (dev servers, test runners, ...) survive as orphans — the
 * stray 8788 test server was exactly that. `taskkill /PID <pid> /T /F` takes
 * the whole tree down instead. `spawn()` creates the taskkill process
 * synchronously, so this works even from the sync-only `exit` hook.
 */
function killTree(child: ChildProcess | undefined): void {
  const pid = child?.pid
  if (!pid) return
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    // Two ways taskkill can fail to reap the tree, both of which would leave
    // the child alive with `close` never firing — the room stays busy forever:
    // 1. taskkill itself couldn't spawn (missing binary, perms) → 'error';
    // 2. taskkill ran but exited non-zero (AV interception, wrong session —
    //    seen on this machine) → 'close' with a non-zero code.
    // Either way fall back to a direct kill so the child at least gets signalled.
    killer.on('error', () => {
      try {
        child.kill('SIGKILL')
      } catch {
        // already gone
      }
    })
    killer.on('close', (code) => {
      if (code === 0) return
      try {
        child.kill('SIGKILL')
      } catch {
        // already gone
      }
    })
    return
  }
  try {
    child.kill('SIGKILL')
  } catch {
    // already gone
  }
}

function reapAllChildren(): void {
  for (const child of [...activeChildren]) killTree(child)
}

/**
 * Kill a whole process tree by bare pid (Windows: taskkill /T /F). Used by
 * the boot sweep to reap CLI trees orphaned by a hard-killed server — the
 * stop button died with that server, so the persisted turn pid is the only
 * remaining handle. Best-effort: an already-dead pid simply fails quietly.
 */
export function killPidTree(pid: number): void {
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    // taskkill itself couldn't spawn → at least signal the direct pid.
    killer.on('error', () => {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // already gone
      }
    })
    return
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // already gone
  }
}

function installExitHook(): void {
  if (exitHookInstalled) return
  exitHookInstalled = true
  process.on('exit', reapAllChildren)
}

export interface ProcessOptions {
  cwd: string
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
  timeoutMs?: number
  /** Idle watchdog: kill the tree after this much silence (no output bytes). */
  idleTimeoutMs?: number
  onStdoutLine?: (line: string) => void
  onStderrLine?: (line: string) => void
  /** Fires once with the spawned child's pid, so callers can surface it. */
  onSpawn?: (pid: number) => void
}

export interface ProcessResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  /** Which limit fired: silent-too-long ('idle') or total runtime ('hard'). */
  timeoutKind?: 'idle' | 'hard'
  aborted: boolean
  spawnError?: string
  /** Pid of the spawned child; absent when the signal aborted before spawn. */
  pid?: number
}

/**
 * Run a child process without a shell and stream back line-delimited output.
 * Passing argv directly (never a shell string) keeps multi-line prompts safe.
 * Timeout and abort terminate the entire process tree, not just the child.
 */
export function runProcess(
  command: string,
  args: string[],
  options: ProcessOptions,
): Promise<ProcessResult> {
  return new Promise((resolvePromise) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    /** Which limit fired when `timedOut` is true. */
    let timeoutKind: 'idle' | 'hard' | undefined
    let aborted = false
    let settled = false
    let child: ChildProcess | undefined

    const finish = (code: number | null, spawnError?: string) => {
      if (settled) return
      settled = true
      if (child) activeChildren.delete(child)
      cleanup()
      resolvePromise({ code, stdout, stderr, timedOut, timeoutKind, aborted, spawnError, pid: child?.pid })
    }

    const timer =
      options.timeoutMs && options.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true
            timeoutKind = 'hard'
            killTree(child)
          }, options.timeoutMs)
        : undefined

    // Idle watchdog: every stdout/stderr byte re-arms it, so a turn that
    // keeps producing — however slowly — survives up to the hard cap, while
    // a CLI that goes silent (hung on a dead upstream, stuck in a tool) is
    // reaped at the idle limit instead of squatting on the room all the way
    // to the wall clock.
    let idleTimer: ReturnType<typeof setTimeout> | undefined
    const armIdle = () => {
      if (settled) return
      if (!options.idleTimeoutMs || options.idleTimeoutMs <= 0) return
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        timedOut = true
        timeoutKind = 'idle'
        killTree(child)
      }, options.idleTimeoutMs)
    }

    const onAbort = () => {
      aborted = true
      killTree(child)
    }

    function cleanup() {
      if (timer) clearTimeout(timer)
      if (idleTimer) clearTimeout(idleTimer)
      options.signal?.removeEventListener('abort', onAbort)
    }

    if (options.signal?.aborted) {
      aborted = true
      cleanup()
      resolvePromise({ code: null, stdout: '', stderr: '', timedOut: false, aborted: true })
      return
    }
    options.signal?.addEventListener('abort', onAbort)

    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      installExitHook()
      activeChildren.add(child)
      if (child.pid) options.onSpawn?.(child.pid)
      armIdle()
    } catch (error) {
      finish(null, error instanceof Error ? error.message : String(error))
      return
    }

    child.on('error', (error) => finish(null, error.message))
    child.on('close', (code) => finish(code))

    if (child.stdout) {
      let buffer = ''
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        armIdle()
        stdout += chunk
        buffer += chunk
        let index = buffer.indexOf('\n')
        while (index >= 0) {
          const line = stripAnsi(buffer.slice(0, index)).replace(/\r$/, '')
          buffer = buffer.slice(index + 1)
          if (line.length > 0) options.onStdoutLine?.(line)
          index = buffer.indexOf('\n')
        }
      })
      child.stdout.on('end', () => {
        const tail = stripAnsi(buffer).replace(/\r$/, '')
        if (tail.length > 0) options.onStdoutLine?.(tail)
      })
    }

    if (child.stderr) {
      let buffer = ''
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => {
        armIdle()
        stderr += chunk
        buffer += chunk
        let index = buffer.indexOf('\n')
        while (index >= 0) {
          const line = stripAnsi(buffer.slice(0, index)).replace(/\r$/, '')
          buffer = buffer.slice(index + 1)
          if (line.length > 0) options.onStderrLine?.(line)
          index = buffer.indexOf('\n')
        }
      })
      child.stderr.on('end', () => {
        const tail = stripAnsi(buffer).replace(/\r$/, '')
        if (tail.length > 0) options.onStderrLine?.(tail)
      })
    }
  })
}
