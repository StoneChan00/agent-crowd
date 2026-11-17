import { existsSync, realpathSync } from 'node:fs'
import { extname, join, sep } from 'node:path'
import type { Request, Response } from 'express'
import * as db from './db.ts'

/**
 * In-chat media (M1): characters reference generated files with a
 * `[media] <absolute path>` line — the model only ever writes a PATH, which
 * free-tier models do reliably — and rewriteMediaLines turns it into a
 * short markdown link the browser can actually load through /api/files.
 * The reverse routes (base64 inline, file:// URLs) are dead ends:
 * react-markdown's defaultUrlTransform strips data:/file: src outright, and
 * an inline blob would live in SQLite and ride every later prompt replay.
 *
 * /api/files serves a local file only when, in order:
 *  - the path exists (404),
 *  - its realpath resolves (404) — realpath BEFORE the root check, so `..`
 *    segments and symlinks cannot escape,
 *  - it lands under a whitelisted root: every room's workingDir plus every
 *    character's own cwd (403) — a generated file lives in a room's project
 *    tree, nowhere else,
 *  - the extension is an approved media type (404).
 * sendFile then supplies Content-Type/ETag/Range (video scrubbing needs 206).
 * With AC_HOST=0.0.0.0 this endpoint is readable on the LAN — that is the
 * operator's choice to make, and README says so.
 */

export const MEDIA_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'mp4', 'webm'] as const

export function mediaFileUrl(path: string): string {
  return `/api/files?path=${encodeURIComponent(path)}`
}

function hasMediaExtension(path: string): boolean {
  const extension = extname(path).toLowerCase().replace(/^\./, '')
  return (MEDIA_EXTENSIONS as readonly string[]).includes(extension)
}

/**
 * Turn every `[media] <path>` line into a short markdown media link; paths
 * outside the media-extension whitelist stay verbatim (a model listing a
 * .bat or .log must not mint a servable URL for it). Returns the rewritten
 * text plus the collected absolute paths for meta.attachments — the archive
 * / gallery hook later features can build on.
 */
export function rewriteMediaLines(text: string): { text: string; attachments: string[] } {
  const attachments: string[] = []
  const rewritten = text
    .split('\n')
    .map((line) => {
      const match = line.match(/^\s*\[media\]\s+(\S+)\s*$/)
      if (!match || !hasMediaExtension(match[1])) return line
      attachments.push(match[1])
      const name = match[1].split(/[\\/]/).pop() ?? 'media'
      return `![${name}](${mediaFileUrl(match[1])})`
    })
    .join('\n')
  return { text: rewritten, attachments }
}

function underRoot(candidate: string, roots: string[]): boolean {
  for (const root of roots) {
    if (!existsSync(root)) continue
    let realRoot: string
    try {
      realRoot = realpathSync(root)
    } catch {
      continue
    }
    const a = candidate.toLowerCase()
    const b = realRoot.toLowerCase()
    if (a === b || a.startsWith(b.endsWith(sep) ? b : b + sep)) return true
  }
  return false
}

/** GET /api/files?path=<absolute path> — see the module doc for the gates. */
export function mediaFileHandler(req: Request, res: Response): void {
  const requested = String(req.query.path ?? '')
  if (!requested || !existsSync(requested)) {
    res.status(404).json({ error: '文件不存在' })
    return
  }
  let resolved: string
  try {
    resolved = realpathSync(requested)
  } catch {
    res.status(404).json({ error: '文件不存在' })
    return
  }
  const roots = [
    ...db.listRooms().map((room) => room.workingDir),
    ...db.listAllCharacters().map((character) => character.cwd.trim()),
  ].filter(Boolean)
  if (!underRoot(resolved, roots)) {
    res.status(403).json({ error: '路径不在任何房间的工作目录内' })
    return
  }
  if (!hasMediaExtension(resolved)) {
    res.status(404).json({ error: '仅支持图片与视频文件' })
    return
  }
  res.sendFile(resolved)
}
