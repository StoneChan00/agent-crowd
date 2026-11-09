import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

export const ROOT = resolve(import.meta.dirname, '..')
export const DATA_DIR = resolve(process.env.AC_DATA_DIR ?? join(ROOT, 'data'))
export const RUNTIME_DIR = join(DATA_DIR, 'runtime')
export const DEFAULT_WORKSPACE = join(ROOT, 'workspace')
export const WEB_DIST = join(ROOT, 'dist', 'web')
/**
 * B07: the repo-root skills directory — one `.md` per skill, read fresh on
 * every turn that needs it (no watcher). loadSkills tolerates it being
 * missing entirely, so the directory is created on demand, not at boot.
 */
export const SKILLS_DIR = join(ROOT, 'skills')

mkdirSync(DATA_DIR, { recursive: true })
mkdirSync(RUNTIME_DIR, { recursive: true })
mkdirSync(DEFAULT_WORKSPACE, { recursive: true })

export function runtimeDir(...segments: string[]): string {
  const dir = join(RUNTIME_DIR, ...segments)
  mkdirSync(dir, { recursive: true })
  return dir
}
