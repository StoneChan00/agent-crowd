import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { dshHome, opencodeConfigDir, resolveCannbot, resolveClaude, resolveCodex, resolveDsh, resolveOpencode } from './harnesses/bins.ts'

/**
 * MCP visibility: surface which MCP servers each harness CLI would load.
 *
 * agent-crowd itself loads no MCP — the harness CLIs (opencode/cannbot/dsh/
 * claude/codex) read their own config files at turn time. So this module
 * re-reads those same files on every request (no cache: a config edit shows
 * up on the next refresh) and reports what it finds. Read failures degrade
 * to an `error` string per harness — the endpoint itself never throws.
 *
 * Sources on this machine (verified 2026-11-04):
 * - opencode AND cannbot: `~/.config/opencode/opencode.jsonc` → `mcp` section
 *   (the cannbot binary embeds `.config/opencode` + `opencode.jsonc` — it is
 *   an opencode fork reading the same config).
 * - dsh: `~/.dsh/profiles/<web|headless>/cordis.patch.yml` → entries named
 *   `@deepseek-ai/dsh-mcp-client` (one per surfaced MCP server).
 * - claude: `~/.claude.json` → top-level `mcpServers` + per-project ones.
 * - codex: `~/.codex/config.toml` → `[mcp_servers.<name>]` tables.
 */

export interface McpServerInfo {
  name: string
  /** local / remote, or the dsh transport (stdio). */
  type: string
  enabled: boolean
  /** command line or URL — the human-readable "what it runs". */
  detail: string
  /** profile / project the entry came from, when a file serves several. */
  source?: string
  timeoutMs?: number
}

export interface McpHarnessInfo {
  label: string
  available: boolean
  /** config files consulted (absolute paths, for display). */
  sources: string[]
  servers: McpServerInfo[]
  /** parse failure — shown instead of pretending the list is complete. */
  error?: string
  note?: string
}

/* ------------------------------------------------------------- jsonc parse */

/**
 * Strip `//` and `/* *​/` comments outside strings. String-aware so `https://`
 * inside a quoted value survives. Then JSON.parse.
 */
function stripJsoncComments(text: string): string {
  let out = ''
  let inString = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (inString) {
      out += ch
      if (ch === '\\') {
        if (i + 1 < text.length) {
          out += text[i + 1]
          i += 1
        }
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      continue
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1
      out += '\n'
      continue
    }
    if (ch === '/' && text[i + 1] === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1
      i += 1
      out += ' '
      continue
    }
    out += ch
  }
  return out
}

/** Remove trailing commas before `}` / `]` — outside strings only. */
function stripTrailingCommas(text: string): string {
  let out = ''
  let inString = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (inString) {
      out += ch
      if (ch === '\\') {
        if (i + 1 < text.length) {
          out += text[i + 1]
          i += 1
        }
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      continue
    }
    if (ch === ',') {
      let j = i + 1
      while (j < text.length && /\s/.test(text[j])) j += 1
      if (text[j] === '}' || text[j] === ']') continue // drop the comma
    }
    out += ch
  }
  return out
}

export function parseJsonc(text: string): unknown {
  return JSON.parse(stripTrailingCommas(stripJsoncComments(text)))
}

/* ----------------------------------------------------------------- readers */

interface McpConfigEntry {
  command?: string | string[]
  args?: string[]
  url?: string
  type?: string
  enabled?: boolean
  timeout?: number
}

function describeCommand(entry: McpConfigEntry): string {
  const command = Array.isArray(entry.command) ? entry.command.join(' ') : entry.command
  const withArgs = command && entry.args?.length ? `${command} ${entry.args.join(' ')}` : command
  return withArgs || entry.url || ''
}

function userHome(): string {
  return process.env.USERPROFILE ?? process.env.HOME ?? '.'
}

function readTextIfPresent(path: string): { text: string } | { missing: true } | { error: string } {
  try {
    return { text: readFileSync(path, 'utf8') }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { missing: true }
    return { error: `读取失败：${(error as Error).message}` }
  }
}

/** opencode.jsonc `mcp` section — shared by the opencode and cannbot harnesses. */
function readOpencodeStyleConfig(): McpHarnessInfo & { path: string } {
  const path = join(opencodeConfigDir(), 'opencode.jsonc')
  const result: McpHarnessInfo & { path: string } = {
    label: '',
    available: true,
    sources: [path],
    servers: [],
    path,
  }
  const read = readTextIfPresent(path)
  if ('missing' in read) {
    result.note = '配置文件不存在（该 CLI 未配置任何 MCP）'
    return result
  }
  if ('error' in read) {
    result.error = read.error
    return result
  }
  try {
    const config = parseJsonc(read.text) as { mcp?: Record<string, McpConfigEntry> }
    const mcp = config.mcp ?? {}
    result.servers = Object.entries(mcp).map(([name, entry]) => ({
      name,
      type: String(entry.type ?? (entry.url ? 'remote' : 'local')),
      enabled: entry.enabled !== false,
      detail: describeCommand(entry),
      timeoutMs: entry.timeout,
    }))
  } catch (error) {
    result.error = `解析失败：${(error as Error).message}`
  }
  return result
}

/** dsh profile patch: `@deepseek-ai/dsh-mcp-client` entries per profile. */
function readDshConfig(): McpHarnessInfo {
  const profiles = ['web', 'headless']
  const info: McpHarnessInfo = { label: 'DSH', available: Boolean(resolveDsh()), sources: [], servers: [] }
  for (const profile of profiles) {
    const path = join(dshHome(), 'profiles', profile, 'cordis.patch.yml')
    info.sources.push(path)
    const read = readTextIfPresent(path)
    if ('missing' in read) continue
    if ('error' in read) {
      info.error = read.error
      continue
    }
    try {
      // Top-level YAML array of loader patch entries; `!!js` expressions are
      // dsh's own extension — a file using them fails `yaml` parsing and
      // surfaces as an error instead of a silently wrong list. Entries come
      // in two shapes: direct config rows ({id, name, config}) and
      // `- insert:` wrappers carrying a list of rows (`dsh plugin add` writes
      // the wrapper shape) — unwrap both.
      const doc = parseYaml(read.text) as unknown
      if (!Array.isArray(doc)) continue
      const candidates: unknown[] = []
      for (const entry of doc) {
        candidates.push(entry)
        const wrapper = entry as { insert?: unknown }
        if (Array.isArray(wrapper?.insert)) candidates.push(...wrapper.insert)
      }
      for (const raw of candidates) {
        const candidate = raw as { id?: string; name?: string; config?: McpConfigEntry & { serverName?: string; transport?: string } }
        const isMcpClient = candidate.name === '@deepseek-ai/dsh-mcp-client' || candidate.config?.transport !== undefined
        if (!isMcpClient) continue
        info.servers.push({
          name: candidate.config?.serverName ?? candidate.id ?? 'mcp',
          type: candidate.config?.transport ?? 'stdio',
          enabled: true,
          detail: describeCommand(candidate.config ?? {}),
          source: profile,
        })
      }
    } catch (error) {
      info.error = `${profile}：${(error as Error).message}`
    }
  }
  if (info.servers.length === 0 && !info.error) info.note = '两个 profile 均未配置 MCP'
  return info
}

/** ~/.claude.json: top-level mcpServers + per-project mcpServers. */
function readClaudeConfig(): McpHarnessInfo {
  const path = join(userHome(), '.claude.json')
  const info: McpHarnessInfo = { label: 'Claude Code', available: Boolean(resolveClaude()), sources: [path], servers: [] }
  const read = readTextIfPresent(path)
  if ('missing' in read) {
    info.note = '配置文件不存在（未安装或未配置）'
    return info
  }
  if ('error' in read) {
    info.error = read.error
    return info
  }
  try {
    const config = JSON.parse(read.text) as {
      mcpServers?: Record<string, McpConfigEntry>
      projects?: Record<string, { mcpServers?: Record<string, McpConfigEntry> }>
    }
    for (const [name, entry] of Object.entries(config.mcpServers ?? {})) {
      info.servers.push({
        name,
        type: String(entry.type ?? (entry.url ? 'remote' : 'local')),
        enabled: true,
        detail: describeCommand(entry),
        source: '全局',
      })
    }
    for (const [project, room] of Object.entries(config.projects ?? {})) {
      for (const [name, entry] of Object.entries(room.mcpServers ?? {})) {
        info.servers.push({
          name,
          type: String(entry.type ?? (entry.url ? 'remote' : 'local')),
          enabled: true,
          detail: describeCommand(entry),
          source: project,
        })
      }
    }
    if (info.servers.length === 0) info.note = '未配置任何 MCP 服务器'
  } catch (error) {
    info.error = `解析失败：${(error as Error).message}`
  }
  return info
}

/** ~/.codex/config.toml: [mcp_servers.<name>] tables — light scan, display-only. */
function readCodexConfig(): McpHarnessInfo {
  const path = join(userHome(), '.codex', 'config.toml')
  const info: McpHarnessInfo = { label: 'Codex', available: Boolean(resolveCodex()), sources: [path], servers: [] }
  const read = readTextIfPresent(path)
  if ('missing' in read) {
    info.note = '配置文件不存在（未安装或未配置）'
    return info
  }
  if ('error' in read) {
    info.error = read.error
    return info
  }
  const tableRe = /^\[mcp_servers\.([A-Za-z0-9_-]+)\]\s*$/gm
  const tables: { name: string; start: number; end: number }[] = []
  for (const match of read.text.matchAll(tableRe)) {
    tables.push({ name: match[1], start: match.index ?? 0, end: 0 })
  }
  for (let i = 0; i < tables.length; i += 1) {
    tables[i].end = i + 1 < tables.length ? tables[i + 1].start : read.text.length
  }
  for (const table of tables) {
    const body = read.text.slice(table.start, table.end)
    const command = /^\s*command\s*=\s*"([^"]*)"/m.exec(body)?.[1]
    const args = /^\s*args\s*=\s*\[([^\]]*)\]/m.exec(body)?.[1] ?? ''
    const url = /^\s*url\s*=\s*"([^"]*)"/m.exec(body)?.[1]
    const detail = url ?? [command, args.replace(/"/g, '')].filter(Boolean).join(' ').trim()
    info.servers.push({ name: table.name, type: url ? 'remote' : 'local', enabled: true, detail })
  }
  if (info.servers.length === 0) info.note = '未配置任何 MCP 服务器'
  return info
}

/* ------------------------------------------------------------------- entry */

export function listMcps(): Record<string, McpHarnessInfo> {
  const shared = readOpencodeStyleConfig()
  const opencode: McpHarnessInfo = {
    label: 'OpenCode',
    available: Boolean(resolveOpencode()),
    sources: shared.sources,
    servers: shared.servers,
    error: shared.error,
    note: shared.note,
  }
  const cannbot: McpHarnessInfo = {
    label: 'CANNBot',
    available: Boolean(resolveCannbot()),
    sources: shared.sources,
    servers: shared.servers,
    error: shared.error,
    note: shared.note,
  }
  // The CANNBot platform injects built-in MCPs (context7 / websearch …) via
  // its gateway at runtime — they appear in sessions but in no local config
  // file. Say so instead of listing a silently incomplete set.
  if (!cannbot.error) {
    cannbot.note = [
      '与 OpenCode 共用同一份配置文件（同为 opencode 系 CLI）。',
      '平台网关还会动态注入内置 MCP（如 context7、websearch），不在本地配置文件中，故不列在此表。',
    ].join('')
  }
  return {
    opencode,
    cannbot,
    dsh: readDshConfig(),
    claude: readClaudeConfig(),
    codex: readCodexConfig(),
  }
}
