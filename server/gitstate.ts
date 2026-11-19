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
import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'

/** Per-command budget; git on a warm repo answers in ~50ms, big repos stay well under 3s. */
const GIT_TIMEOUT_MS = 3_000

export interface WorktreeSnapshot {
  /** False when cwd is not inside a git repo (or git is unusable). */
  available: boolean
  /** Hash over status entries + diffstat + untracked fingerprints; equal digests = nothing changed. */
  digest: string
  /** Dirty paths (untracked included), repo-relative, deduplicated. */
  paths: string[]
  /**
   * Raw `XY path` status entries, the unit the diff below compares. EVERY
   * entry carries a size+mtime fingerprint: content edits can keep the XY
   * code (` M` → ` M`) AND the diffstat numbers (`2 +-` for a 1-line
   * swap for a 1-line swap), so without the fingerprint a dirty file
   * re-edited mid-turn is invisible to both digest inputs.
   */
  entries: Array<{ status: string; path: string; fingerprint?: string }>
}

const UNAVAILABLE: WorktreeSnapshot = { available: false, digest: '', paths: [], entries: [] }

function git(
  cwd: string,
  args: string[],
  timeoutMs = GIT_TIMEOUT_MS,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => resolve({ ok: !error, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }),
    )
  })
}

/**
 * Parse `git status --porcelain=v1 -z --untracked-files=all` output.
 * -z mode: NUL-separated records, no quoting; rename/copy records carry the
 * origin path as one extra NUL-terminated field after the target path.
 * A RENAME origin is recorded as a `D ` entry of its own: every consumer of
 * this snapshot (paths, digests, diffSnapshotPaths → round.changedPaths)
 * must see the old path die, or a staged rename never puts it in the commit
 * set. A copy origin is consumed but NOT recorded — its source still exists.
 */
function parsePorcelainZ(output: string): Array<{ status: string; path: string; fingerprint?: string }> {
  const records = output.split('\0')
  const entries: Array<{ status: string; path: string; fingerprint?: string }> = []
  let index = 0
  while (index < records.length) {
    const record = records[index]
    index += 1
    if (!record) continue
    const status = record.slice(0, 2)
    const path = record.slice(3)
    if (!path) continue
    entries.push({ status, path })
    // R/C records: the next NUL field is the origin path — consume it for
    // both. Only a RENAME origin enters as a deletion (the old path is gone);
    // a copy's source still exists, and recording it would list a path with
    // no net change (C records need status.renames=copies to appear at all).
    if (status.includes('R') || status.includes('C')) {
      const origin = records[index]
      index += 1
      if (origin && status.includes('R')) entries.push({ status: 'D ', path: origin })
    }
  }
  return entries
}

/**
 * Snapshot the worktree containing `cwd`, resolved to the repo root first.
 * The digest folds status entries, `git diff HEAD --stat` and the untracked
 * fingerprints together; the diffstat is best-effort (a fresh repo without
 * commits has no HEAD yet, and status alone still detects every change the
 * gate cares about).
 */
export async function snapshotWorktree(cwd: string): Promise<WorktreeSnapshot> {
  const top = await git(cwd, ['rev-parse', '--show-toplevel'])
  if (!top.ok || !top.stdout.trim()) return UNAVAILABLE
  const root = top.stdout.trim()
  const status = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  if (!status.ok) return UNAVAILABLE
  // The DIFFSTAT cannot be filtered in JS: git abbreviates long paths in its
  // text (`.../ses_...json | 4 +-`), so slicing it is unreliable. Excluded at
  // the command level instead — and the trailing `/**` is load-bearing: a
  // pathspec like `:(exclude)**/.omo` matches only the directory entry, never
  // its contents (this is exactly why the first attempt, `:!**/.omo`,
  // silently excluded nothing; probed on git 2.51).
  const diff = await git(root, [
    'diff',
    'HEAD',
    '--stat',
    '--',
    ':(exclude).omo',
    ':(exclude)**/.omo/**',
  ])
  // Status entries are filtered here in JS — one code path feeding paths,
  // entries and the digest's status part. The opencode-family CLIs write
  // session-continuation files under `.omo/run-continuation/` in their cwd
  // every turn; agent-crowd's own repo ignores `.omo/`, but a user project
  // that does not (e.g. a fresh ComfyUI checkout) would otherwise see them
  // surface as "code changes" — no-change rounds would gate-block on harness
  // state, and a green round's auto-commit would commit it into the user's
  // repo. The digest is rebuilt from the filtered entries (never the raw
  // status text) for the same reason: otherwise pure .omo churn would move
  // the digest, and a moved digest with no attributable diff path degrades
  // changedPathsBetween to the full dirty-path fallback.
  const entries = parsePorcelainZ(status.stdout).filter(
    (entry) => !entry.path.split('/').some((segment) => segment === '.omo'),
  )
  // Every dirty entry gets a size+mtime fingerprint. Three holes it closes:
  // untracked edits never reach `git diff HEAD`; a tracked re-edit can keep
  // its XY code; and a 1-line-for-1-line swap keeps the diffstat numbers
  // (`2 +-`) identical too — status+diffstat alone see none of them. stat
  // failures (file vanished between status and stat) map to a sentinel: a
  // path that disappeared IS a change, not a skip.
  await Promise.all(
    entries.map(async (entry) => {
      try {
        const info = await stat(join(root, entry.path))
        entry.fingerprint = `${info.size}-${Math.round(info.mtimeMs)}`
      } catch {
        entry.fingerprint = 'gone'
      }
    }),
  )
  const digest = createHash('sha1')
    // Rebuilt from the FILTERED entries, never the raw status text — see the
    // .omo filtering comment above for the fallback path this avoids.
    .update(entries.map((entry) => `${entry.status} ${entry.path}`).join('\n'))
    .update('\n--diff--\n')
    .update(diff.ok ? diff.stdout : '')
    .update('\n--fingerprints--\n')
    .update(entries.map((entry) => `${entry.path}=${entry.fingerprint}\n`).join(''))
    .digest('hex')
  return {
    available: true,
    digest,
    paths: [...new Set(entries.map((entry) => entry.path))],
    entries,
  }
}

/**
 * Which paths differ between two snapshots: appeared, disappeared, the git
 * status code changed (e.g. untracked → modified), or a kept-code entry's
 * fingerprint moved (content edited again — ` M` → ` M`, untracked `??` →
 * `??`, both diffstat-invisible). A path that stays `XY`- AND
 * fingerprint-identical in both is not a change, even though it is still
 * dirty.
 */
export function diffSnapshotPaths(before: WorktreeSnapshot, after: WorktreeSnapshot): string[] {
  const beforeByPath = new Map(before.entries.map((entry) => [entry.path, entry]))
  const afterByPath = new Map(after.entries.map((entry) => [entry.path, entry]))
  const changed = new Set<string>()
  for (const [path, entry] of afterByPath) {
    const prior = beforeByPath.get(path)
    if (!prior || prior.status !== entry.status || prior.fingerprint !== entry.fingerprint) {
      changed.add(path)
    }
  }
  for (const [path] of beforeByPath) {
    if (!afterByPath.has(path)) changed.add(path)
  }
  return [...changed]
}

/**
 * The turn-level verdict between two snapshots, as pump() records it:
 * - `null`  — either side unjudgeable (non-git / git broken): "cannot tell",
 *   deliberately NOT "no changes";
 * - `[]`    — equal digests: nothing moved on disk;
 * - non-empty — digest moved. Normally diffSnapshotPaths attributes it, but
 *   a tracked file edited AGAIN keeps its XY code and diffs to `[]` — then
 *   the after snapshot's full dirty set stands in. Imprecise attribution is
 *   the documented trade (p0-plan.md:182: multi-room writes to one repo are
 *   never per-turn exact); a silently ungated change is not.
 */
export function changedPathsBetween(before: WorktreeSnapshot, after: WorktreeSnapshot): string[] | null {
  if (!before.available || !after.available) return null
  if (before.digest === after.digest) return []
  const diff = diffSnapshotPaths(before, after)
  return diff.length > 0 ? diff : after.paths
}

/**
 * Auto-commit on round close (S13): stage exactly the round's changed paths
 * and commit them — and NOTHING else that might already sit in the index.
 * Pure I/O like the rest of this module — the orchestrator decides WHEN,
 * this decides HOW:
 *  - gitignored paths are filtered out first (round change sets legitimately
 *    contain ignored files — local state, build output): committing them is
 *    never wanted, and one ignored path would fail the whole `git add`;
 *  - ghost paths (existed during the round, never tracked, since deleted —
 *    diffSnapshotPaths records them as "before has, after doesn't") are
 *    dropped, not fatal: git has no such pathspec and one would abort the
 *    whole add, losing the round's real work. "Tracked" reads from HEAD, so
 *    staged deletions and rename origins survive the filter and their
 *    removal lands in the commit;
 *  - staging (`add`) and committing (`commit --only`) take different path
 *    sets: add rejects pathspecs that are neither on disk nor in the index
 *    (a staged deletion), commit --only accepts them;
 *  - every pathspec runs with --literal-pathspecs: [/?* in a pathname are
 *    filename characters, never glob magic — app/[id]/page.tsx must not
 *    match the sibling app/i/page.tsx (check-ignore alone must stay
 *    flag-free: it rejects pathspec magic and is literal by itself);
 *  - `--only` also keeps anything the user (or an earlier round) left staged
 *    out of the auto-commit, without losing its staged state;
 *  - the repo's own git identity wins; a machine without one still gets the
 *    commit (agent-crowd fallback), so a green round never fails to land;
 *  - NEVER pushes — pushing stays a user decision, by design.
 */
export interface CommitPathsResult {
  ok: boolean
  /** Nothing to commit: every path gitignored/vanished, or no net change. */
  skipped?: 'ignored' | 'empty'
  hash?: string
  subject?: string
  /** Paths actually inside the commit (name-only listing of the new HEAD). */
  files?: string[]
  error?: string
}

/** Staging + commit can outrun a status probe on cold Windows spawns. */
const COMMIT_TIMEOUT_MS = 30_000

/** Diff view cap: enough for a normal round, small enough for one HTTP response. */
const SHOW_MAX_CHARS = 200_000

/**
 * B11 delivery report: render one commit as stat + patch. Read-only, hash-only
 * (`/^[0-9a-f]{7,40}$/`) — callers never pass a path or a git option here.
 */
export async function showCommit(
  cwd: string,
  hash: string,
): Promise<{ ok: boolean; text: string; truncated: boolean; error?: string }> {
  if (!/^[0-9a-f]{7,40}$/i.test(hash)) return { ok: false, text: '', truncated: false, error: '非法 commit hash' }
  const top = await git(cwd, ['rev-parse', '--show-toplevel'])
  if (!top.ok || !top.stdout.trim()) return { ok: false, text: '', truncated: false, error: '非 git 仓库或 git 不可用' }
  const shown = await git(
    top.stdout.trim(),
    ['show', '--no-color', '--stat', '--patch', '--format=commit %H%nAuthor: %an%nDate: %ad%n%n%s%n%b', hash],
    COMMIT_TIMEOUT_MS,
  )
  if (!shown.ok) {
    return { ok: false, text: '', truncated: false, error: shown.stderr.trim() || '读取 commit 失败' }
  }
  const full = shown.stdout
  return {
    ok: true,
    text: full.length > SHOW_MAX_CHARS ? `${full.slice(0, SHOW_MAX_CHARS)}\n…（diff 已截断）` : full,
    truncated: full.length > SHOW_MAX_CHARS,
  }
}

export async function commitPaths(
  cwd: string,
  paths: string[],
  message: { subject: string; body: (keptPaths: string[]) => string },
): Promise<CommitPathsResult> {
  const top = await git(cwd, ['rev-parse', '--show-toplevel'])
  if (!top.ok || !top.stdout.trim()) return { ok: false, error: '非 git 仓库或 git 不可用' }
  const root = top.stdout.trim()
  const unique = [...new Set(paths.filter(Boolean))]
  if (unique.length === 0) return { ok: true, skipped: 'empty' }

  // HEAD tracking FIRST — before any ignore filtering. check-ignore reads
  // index/worktree only, so a file that was force-added past .gitignore and
  // since staged-for-deletion (gone from the index, gone from disk, still in
  // HEAD) reads as "ignored"; letting that verdict run would silently drop a
  // real deletion and, once the next round's snapshot normalizes it, lose it
  // forever. A path tracked in HEAD is never a fresh ignored file — the
  // ignore check only gets the paths HEAD does not know.
  const headTree = await git(
    root,
    ['--literal-pathspecs', '-c', 'core.quotePath=false', 'ls-tree', '-r', '-z', '--name-only', 'HEAD', '--', ...unique],
  )
  const headTracked = new Set(
    (headTree.ok ? headTree.stdout : '')
      .split('\0')
      .map((line) => line.trim())
      .filter(Boolean),
  )

  // check-ignore exits 0 when SOME path is ignored (stdout lists them, one
  // per line) and 1 when none is — both fine; only a crashed git is a failure.
  // (No -z here: on current git it is fatal without --stdin; quotePath=false
  // keeps non-ASCII paths from coming back octal-escaped and missing the set.
  // Also NO --literal-pathspecs here: check-ignore rejects pathspec magic
  // outright ("fatal: pathspec magic not supported") and already takes its
  // arguments as literal pathnames — the flag belongs on add/commit/ls-*,
  // where a path like app/[id]/page.tsx would otherwise glob-match siblings.
  // A filename with an embedded newline still slips past the line split —
  // the consequence is a loud git-add failure notice, never a wrong commit.)
  const ignoreCandidates = unique.filter((path) => !headTracked.has(path))
  const ignored = new Set()
  if (ignoreCandidates.length > 0) {
    const ignoreCheck = await git(root, ['-c', 'core.quotePath=false', 'check-ignore', '--', ...ignoreCandidates])
    for (const line of (ignoreCheck.ok ? ignoreCheck.stdout : '').split('\n')) {
      const trimmed = line.trim()
      if (trimmed) ignored.add(trimmed)
    }
  }
  const addable = unique.filter((path) => !ignored.has(path))
  if (addable.length === 0) return { ok: true, skipped: 'ignored' }

  // The index set completes "tracked": it feeds the add filter below, and an
  // index-only (ls-files) notion of tracked was exactly the bug the HEAD set
  // above fixes. HEAD is unborn on a fresh repo: ls-tree fails, headTracked
  // is empty, and index+disk carry the root commit.
  const indexFiles = await git(
    root,
    ['--literal-pathspecs', '-c', 'core.quotePath=false', 'ls-files', '--', ...addable],
  )
  const indexTracked = new Set(
    (indexFiles.ok ? indexFiles.stdout : '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
  )
  const onDisk = (path: string) => existsSync(join(root, path))
  // Commit set: HEAD-tracked ∪ index-tracked ∪ exists-on-disk. Ghosts (never
  // tracked, since deleted) drop out; staged deletions and rename origins
  // survive via HEAD; tracked-but-deleted paths survive for deletion commits.
  const kept = addable.filter((path) => headTracked.has(path) || indexTracked.has(path) || onDisk(path))
  if (kept.length === 0) return { ok: true, skipped: 'empty' }

  // Supply identity only where the repo has none, so a set-up machine's git
  // log attribution stays untouched.
  const [name, email] = await Promise.all([
    git(root, ['config', '--get', 'user.name']),
    git(root, ['config', '--get', 'user.email']),
  ])
  const identity = [
    ...(name.ok && name.stdout.trim() ? [] : ['-c', 'user.name=agent-crowd']),
    ...(email.ok && email.stdout.trim() ? [] : ['-c', 'user.email=agent-crowd@round.local']),
  ]

  // Staging and committing take DIFFERENT path sets: `git add` rejects a
  // pathspec that is neither on disk nor in the index (a staged deletion or
  // rename origin) with a fatal that would abort the whole batch, while
  // `commit --only` accepts it and commits the staged removal just fine.
  // Both run with --literal-pathspecs: [/?* in a path are filename
  // characters, never glob magic — without the flag, app/[id]/page.tsx
  // matches the sibling app/i/page.tsx and swallows its staged WIP.
  const addPaths = kept.filter((path) => indexTracked.has(path) || onDisk(path))
  if (addPaths.length > 0) {
    const add = await git(root, ['--literal-pathspecs', 'add', '-A', '--', ...addPaths], COMMIT_TIMEOUT_MS)
    if (!add.ok) return { ok: false, error: `git add 失败：${add.stderr.trim() || '未知原因'}` }
  }
  // --only: commit JUST the kept paths — pre-staged unrelated entries stay
  // staged and out of the auto-commit.
  const commit = await git(
    root,
    [...identity, '--literal-pathspecs', 'commit', '--only', '-m', message.subject, '-m', message.body(kept), '--', ...kept],
    COMMIT_TIMEOUT_MS,
  )
  if (!commit.ok) {
    if (commit.stdout.includes('nothing to commit')) return { ok: true, skipped: 'empty' }
    return { ok: false, error: `git commit 失败：${(commit.stderr || commit.stdout).trim() || '未知原因'}` }
  }
  const hash = await git(root, ['rev-parse', '--short', 'HEAD'])
  // --no-renames: a rename must list BOTH paths (deletion + addition), not
  // collapse to the new name — the notice's file count and the S13 contract
  // read this as "paths that differ", which a detected rename hides half of.
  const listed = await git(root, ['show', '--name-only', '--no-renames', '--format=', 'HEAD'])
  const files = listed.ok
    ? listed.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
    : []
  return { ok: true, hash: hash.ok ? hash.stdout.trim() : '', subject: message.subject, files }
}
