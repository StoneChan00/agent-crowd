/**
 * Worktree snapshot (SOP gate 3a, P0-3): what changed on disk while a turn
 * ran. Pure I/O — no db, no orchestrator imports — so the check script can
 * import it directly.
 *
 * The one load-bearing detail: a room's workingDir is usually a SUBDIRECTORY
 * of the repo (this project's own group room runs inside `workspace/`). Git
 * resolves `rev-parse --show-toplevel` from any directory inside the repo, so
 * running `git status` in cwd only would see workspace files and silently
 * miss every change under `server/` — exactly the evidence the gate needs.
 * All git commands therefore run at the repo root.
 *
 * `execFile` (never execSync) with a 3s budget per command: a turn's before/
 * after snapshots bracket the room's own CLI run, and a wedged git must not
 * stall the pump loop on top of it. Non-git working dirs are a normal
 * configuration (any plain folder), reported as `available: false` — the
 * caller then records "cannot judge" instead of guessing.
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'

/** Per-command budget; git on a warm repo answers in ~50ms, big repos stay well under 3s. */
const GIT_TIMEOUT_MS = 3_000

export interface WorktreeSnapshot {
  /** False when cwd is not inside a git repo (or git is unusable). */
  available: boolean
  /** Hash over status entries + diffstat; equal digests = nothing changed. */
  digest: string
  /** Dirty paths (untracked included), repo-relative, deduplicated. */
  paths: string[]
  /** Raw `XY path` status entries, the unit the diff below compares. */
  entries: Array<{ status: string; path: string }>
}

const UNAVAILABLE: WorktreeSnapshot = { available: false, digest: '', paths: [], entries: [] }

function git(cwd: string, args: string[]): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => resolve({ ok: !error, stdout: String(stdout ?? '') }),
    )
  })
}

/**
 * Parse `git status --porcelain=v1 -z --untracked-files=all` output.
 * -z mode: NUL-separated records, no quoting; rename/copy records carry the
 * origin path as one extra NUL-terminated field after the target path.
 */
function parsePorcelainZ(output: string): Array<{ status: string; path: string }> {
  const records = output.split('\0')
  const entries: Array<{ status: string; path: string }> = []
  let index = 0
  while (index < records.length) {
    const record = records[index]
    index += 1
    if (!record) continue
    const status = record.slice(0, 2)
    const path = record.slice(3)
    if (!path) continue
    entries.push({ status, path })
    // R/C records: the next NUL field is the origin path — consume it.
    if (status.includes('R') || status.includes('C')) index += 1
  }
  return entries
}

/**
 * Snapshot the worktree containing `cwd`, resolved to the repo root first.
 * The digest folds status entries and `git diff HEAD --stat` together; the
 * diffstat is best-effort (a fresh repo without commits has no HEAD yet, and
 * status alone still detects every change the gate cares about).
 */
export async function snapshotWorktree(cwd: string): Promise<WorktreeSnapshot> {
  const top = await git(cwd, ['rev-parse', '--show-toplevel'])
  if (!top.ok || !top.stdout.trim()) return UNAVAILABLE
  const root = top.stdout.trim()
  const status = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  if (!status.ok) return UNAVAILABLE
  const diff = await git(root, ['diff', 'HEAD', '--stat'])
  const entries = parsePorcelainZ(status.stdout)
  const digest = createHash('sha1')
    .update(status.stdout)
    .update('\n--diff--\n')
    .update(diff.ok ? diff.stdout : '')
    .digest('hex')
  return {
    available: true,
    digest,
    paths: [...new Set(entries.map((entry) => entry.path))],
    entries,
  }
}

/**
 * Which paths differ between two snapshots: appeared, disappeared, or the
 * git status code changed (e.g. untracked → modified). A path that stays
 * `XY`-identical in both is not a change, even though it is still dirty.
 */
export function diffSnapshotPaths(before: WorktreeSnapshot, after: WorktreeSnapshot): string[] {
  const beforeByPath = new Map(before.entries.map((entry) => [entry.path, entry.status]))
  const afterPaths = new Map(after.entries.map((entry) => [entry.path, entry.status]))
  const changed = new Set<string>()
  for (const [path, status] of afterPaths) {
    if (beforeByPath.get(path) !== status) changed.add(path)
  }
  for (const [path] of beforeByPath) {
    if (!afterPaths.has(path)) changed.add(path)
  }
  return [...changed]
}
