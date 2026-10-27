import { execFileSync, execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** A resolved executable invocation: command + fixed args that precede adapter args. */
export interface LaunchSpec {
  command: string
  argsPrefix: string[]
  source: string
}

let npmRootCache: string | null | undefined

/** The global npm prefix's node_modules directory, or null when npm is unavailable. */
export function npmGlobalRoot(): string | null {
  if (npmRootCache !== undefined) return npmRootCache
  try {
    const out = execSync('npm root -g', { encoding: 'utf8', timeout: 20_000, windowsHide: true })
    const line = out
      .split(/\r?\n/)
      .map((part) => part.trim())
      .filter(Boolean)
      .pop()
    npmRootCache = line && existsSync(line) ? line : null
  } catch {
    npmRootCache = null
  }
  return npmRootCache
}

/** First `where` hit that is a real .exe (spawning .cmd without a shell is unreliable). */
function whereExe(name: string): string | null {
  try {
    const out = execFileSync('where.exe', [name], { encoding: 'utf8', timeout: 10_000, windowsHide: true })
    for (const line of out.split(/\r?\n/)) {
      const candidate = line.trim()
      if (candidate && /\.exe$/i.test(candidate)) return candidate
    }
  } catch {
    /* not on PATH */
  }
  return null
}

export function resolveOpencode(): LaunchSpec | null {
  const override = process.env.AC_OPENCODE_BIN
  if (override && existsSync(override)) {
    return { command: override, argsPrefix: [], source: 'AC_OPENCODE_BIN' }
  }
  const exe = whereExe('opencode')
  if (exe) return { command: exe, argsPrefix: [], source: 'where opencode' }
  const root = npmGlobalRoot()
  if (root) {
    const candidate = join(root, 'opencode-ai', 'bin', 'opencode.exe')
    if (existsSync(candidate)) return { command: candidate, argsPrefix: [], source: 'npm global opencode-ai' }
  }
  return null
}

export function resolveDsh(): LaunchSpec | null {
  const override = process.env.AC_DSH_BIN
  if (override && existsSync(override)) {
    if (override.toLowerCase().endsWith('.js')) {
      return { command: process.execPath, argsPrefix: [override], source: 'AC_DSH_BIN' }
    }
    return { command: override, argsPrefix: [], source: 'AC_DSH_BIN' }
  }
  const root = npmGlobalRoot()
  if (root) {
    const candidate = join(root, '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    if (existsSync(candidate)) {
      return { command: process.execPath, argsPrefix: [candidate], source: 'npm global @deepseek-ai/dsh' }
    }
  }
  return null
}

/**
 * CANNBot ships its real binary inside the npm package; the PATH entry is only a
 * .cmd shim, so prefer the packaged .exe and fall back to the shim path.
 */
export function resolveCannbot(): LaunchSpec | null {
  const override = process.env.AC_CANNBOT_BIN
  if (override && existsSync(override)) {
    return { command: override, argsPrefix: [], source: 'AC_CANNBOT_BIN' }
  }
  const exe = whereExe('cannbot')
  if (exe) return { command: exe, argsPrefix: [], source: 'where cannbot' }
  const root = npmGlobalRoot()
  if (root) {
    for (const pkg of ['cannbot-windows-x64', 'cannbot-windows-x64-baseline']) {
      const candidate = join(root, 'cannbot', 'node_modules', pkg, 'bin', 'cannbot.exe')
      if (existsSync(candidate)) return { command: candidate, argsPrefix: [], source: `npm global ${pkg}` }
    }
  }
  return null
}

export function resolveHermes(): LaunchSpec | null {
  const override = process.env.AC_HERMES_BIN
  if (override && existsSync(override)) {
    return { command: override, argsPrefix: [], source: 'AC_HERMES_BIN' }
  }
  const exe = whereExe('hermes')
  if (exe) return { command: exe, argsPrefix: [], source: 'where hermes' }
  const local = join(process.env.LOCALAPPDATA ?? '', 'hermes', 'bin', 'hermes.exe')
  if (existsSync(local)) return { command: local, argsPrefix: [], source: 'hermes install dir' }
  return null
}

/** Absolute path to the harness home used for DSH settings. */
export function dshHome(): string {
  if (process.env.DSH_HOME) return process.env.DSH_HOME
  const userHome = process.env.USERPROFILE ?? process.env.HOME ?? '.'
  return join(userHome, '.dsh')
}

export function opencodeConfigDir(): string {
  if (process.env.OPENCODE_CONFIG_DIR) return process.env.OPENCODE_CONFIG_DIR
  const userHome = process.env.USERPROFILE ?? process.env.HOME ?? '.'
  return join(userHome, '.config', 'opencode')
}
