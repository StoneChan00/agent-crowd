import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from './paths.ts'

/**
 * B09 isolation worktrees: two rooms pointed at the same repository overwrite
 * each other's files and mix their commits. An opt-in worktree gives a room
 * its own checkout and branch, so `autoCommitRound` keeps working unchanged
 * while two rooms can run concurrently without touching the same paths.
 *
 * The source repo's uncommitted changes are NOT carried over — a worktree
 * starts from HEAD. The UI says so; callers must not pretend otherwise.
 */

export interface IsolationWorktree {
  /** Repository root the worktree was cut from. */
  source: string
  /** Absolute worktree path (this becomes the room's workingDir). */
  path: string
  /** Branch checked out in the worktree. */
  branch: string
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
  }).trim()
}

/** The repository root containing `dir`, or null when it is not a git repo. */
export function repoRoot(dir: string): string | null {
  try {
    return git(dir, ['rev-parse', '--show-toplevel']) || null
  } catch {
    return null
  }
}

function branchExists(root: string, branch: string): boolean {
  try {
    git(root, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])
    return true
  } catch {
    return false
  }
}

/**
 * Create (or re-attach) the room's worktree under DATA_DIR/worktrees/<roomId>
 * on branch `ac/<roomId-prefix>`. Re-attaching an existing branch keeps the
 * room's earlier commits instead of silently forking from HEAD.
 */
export function createIsolationWorktree(input: { sourceDir: string; roomId: string }): IsolationWorktree {
  const source = repoRoot(input.sourceDir)
  if (!source) {
    throw new Error('工作目录不是 git 仓库，无法创建隔离工作树')
  }
  const worktreesDir = join(DATA_DIR, 'worktrees')
  mkdirSync(worktreesDir, { recursive: true })
  const path = join(worktreesDir, input.roomId)
  if (existsSync(path)) {
    throw new Error(`隔离工作树目录已存在：${path}。请先解除隔离或手动清理。`)
  }
  // UUID prefix is unique per room and path-safe; the room name stays out of
  // the branch because CJK names are not portable git refs.
  const branch = `ac/${input.roomId.slice(0, 8)}`
  if (branchExists(source, branch)) {
    git(source, ['worktree', 'add', path, branch])
  } else {
    git(source, ['worktree', 'add', '-b', branch, path, 'HEAD'])
  }
  return { source, path, branch }
}

/**
 * Remove the worktree registration. The branch is kept on purpose: its
 * commits are the room's work, and the user still needs to review/merge it.
 */
export function removeIsolationWorktree(input: { worktreeDir: string; sourceDir: string }): void {
  const source = repoRoot(input.sourceDir)
  if (!source) {
    throw new Error(`原始仓库不在 git 中，无法移除工作树：${input.sourceDir}`)
  }
  git(source, ['worktree', 'remove', '--force', input.worktreeDir])
  git(source, ['worktree', 'prune'])
}
