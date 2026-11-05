import { createHash } from 'node:crypto'
import type { Message } from './types.ts'
import { stripVerdictLines } from './sop.ts'

/**
 * B04 round-end memory: pure helpers only — no db, no orchestrator imports
 * (sop.ts's verdict-line stripper is pure line logic and is imported so the
 * "what is gate protocol" judgment has exactly ONE home). The zero-model
 * episode is assembled from structured facts the round already carries
 * (changed paths, review verdict, verify outcome, the last delivery line);
 * retrieval planning splits the raw query into FTS-able (≥3 code points,
 * trigram-substring capable) and LIKE-only (short CJK) terms. Everything
 * here is deterministic and unit-testable in isolation.
 */

/**
 * The round's delivery line: gate-protocol verdict lines stripped (every
 * shape the parser accepts, including whole-line code spans — B04 review 3),
 * whitespace collapsed, first 160 chars. Applied both when the round records
 * its last delivery and again inside buildRoundEpisode (idempotent — the two
 * layers must agree even if one changes). A verdict-ONLY message ("REVIEW:
 * PASS" alone, backticked or not) strips to the empty string — callers use
 * that to decide NOT to overwrite the round's real delivery.
 */
export function episodeDelivery(text: string): string {
  return stripVerdictLines(text)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160)
}

export interface RoundEpisodeFacts {
  roomId: string
  changedPaths: string[]
  verify: 'pass' | 'none'
  delivery: string
}

/** Content cap: stays inside addMemory's 500-truncate so the hash the
 *  uniqueness index guards is exactly what the row stores. */
const EPISODE_MAX_CHARS = 480
/** Paths listed verbatim before the "等 N 个" rollover. */
const EPISODE_PATH_LIMIT = 6

/**
 * One line of structured facts — deliberately free of timestamps and
 * roundIds: identical facts (same changes, same verdict, same delivery)
 * produce the same hash, so an exact-repeat round is a no-op instead of a
 * second memory. Per-round distinctness is a B04b concern.
 */
export function buildRoundEpisode(facts: RoundEpisodeFacts): { content: string; hash: string } {
  const paths = [...facts.changedPaths].sort()
  const listed = paths.slice(0, EPISODE_PATH_LIMIT).join('、')
  const pathText = paths.length > EPISODE_PATH_LIMIT ? `${listed} 等 ${paths.length} 个` : listed
  const content = `本轮完成：改动 ${pathText || '（无）'}；review PASS；verify ${
    facts.verify === 'pass' ? '通过' : '未配置验证'
  }；交付：${episodeDelivery(facts.delivery)}`.slice(0, EPISODE_MAX_CHARS)
  return { content, hash: createHash('sha256').update(content).digest('hex') }
}

/** Escape a LIKE term; the SQL side pairs this with `escape '\'`. */
export function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}

/** Wrap an FTS5 phrase; double internal quotes per FTS5 string syntax. */
export function ftsQuote(term: string): string {
  return `"${term.replace(/"/g, '""')}"`
}

export interface MemoryQuery {
  /** ≥3-code-point terms — trigram FTS can substring-match these. */
  ftsTerms: string[]
  /** Short terms (mostly 2-char CJK) — trigram can't see them, LIKE must. */
  likeTerms: string[]
}

const QUERY_MAX_CHARS = 200
const QUERY_MAX_TERMS = 8
const TERM_MAX_CHARS = 60

/**
 * Split a raw query into FTS and LIKE terms. null = no usable terms: the
 * caller keeps the pre-B04 behavior (pinned + recency, no search at all).
 */
export function planMemoryQuery(raw: string | null | undefined): MemoryQuery | null {
  const normalized = (raw ?? '').replace(/\s+/g, ' ').trim().slice(0, QUERY_MAX_CHARS)
  if (!normalized) return null
  const ftsTerms: string[] = []
  const likeTerms: string[] = []
  const seen = new Set<string>()
  for (const token of normalized.split(' ')) {
    const term = token.slice(0, TERM_MAX_CHARS)
    if (!term || seen.has(term)) continue
    seen.add(term)
    if ([...term].length >= 3) ftsTerms.push(term)
    else likeTerms.push(term)
    if (ftsTerms.length + likeTerms.length >= QUERY_MAX_TERMS) break
  }
  if (ftsTerms.length === 0 && likeTerms.length === 0) return null
  return { ftsTerms, likeTerms }
}

/**
 * The search query for a turn: the LAST user message in the fetched window,
 * or the latest task-card message (approval / re-dispatch — the card body is
 * what this round is about). Falls back to the very last message; empty
 * input yields '' (= no search).
 */
export function memoryQueryFromMessages(messages: Message[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.authorType === 'user' || message.meta?.taskId) return message.content
  }
  return messages.at(-1)?.content ?? ''
}
