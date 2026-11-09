import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { Skill } from './types.ts'

/**
 * B07: on-demand skill injection, as a PURE planning module (the same shape
 * as handoff.ts — no db, no prompt text here beyond the section's own lines).
 * `skills/` at the repo root holds one `.md` per skill; a character's
 * `skills: string[]` selects which ones MAY inject; a turn injects a skill's
 * body only when this round's visible messages hit it (keyword substring or
 * an explicit `@skill:name`), otherwise the prompt carries a one-line
 * catalog only. Room characters opt in per skill — the checkbox is the hard
 * gate; `@skill:B` while only A is checked injects nothing.
 *
 * Nothing here may throw into a turn: `loadSkills` is best-effort and skips
 * broken files with a once-per-path warning, because a stray `skills/` file
 * must never kill a chat round.
 */
export const SKILL_BODY_MAX = 2_000
/** Whole-【技能】-section ceiling (title + catalog line + bodies + marker). */
export const SKILLS_TOTAL_MAX = 4_000
/** Description budget per entry inside the catalog line. */
export const SKILL_CATALOG_DESC_MAX = 40
/** The catalog line itself must stay one line, and this short. */
export const SKILL_CATALOG_LINE_MAX = 400
/** Files larger than this are skipped unread. */
export const SKILL_FILE_MAX_BYTES = 64_000

/**
 * The one-token grammar a skill name must fit — the SAME character class as
 * room call-names (CALL_NAME_SOURCE in mentions.ts), so an `@skill:name`
 * target is always a single @-able token and the explicit-match regex below
 * can share the class.
 */
const SKILL_NAME = /^[A-Za-z0-9_\-\u4e00-\u9fff]{1,64}$/

/** `@skill:name` in prose: bounded like a call-name so `@skill:foo-bar` is one
 *  token. MatchAll-only (it clones the regex, so this shared literal keeps no
 *  lastIndex state between turns). */
const SKILL_EXPLICIT = /(?<![A-Za-z0-9_])@skill:([A-Za-z0-9_\-\u4e00-\u9fff]{1,64})/g

/** Warn-once bookkeeping (module scope): a bad file logs once, not every turn. */
const warnedPaths = new Set<string>()

function warnOnce(path: string, reason: string): void {
  if (warnedPaths.has(path)) return
  warnedPaths.add(path)
  console.warn(`[agent-crowd] skills: 跳过 ${path}（${reason}）`)
}

/** Cap with an ellipsis so every cut is visible in the rendered prompt. */
function cap(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** Deterministic ordering by plain code-unit comparison — no locale drift. */
function byName(a: Skill, b: Skill): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
}

/**
 * Parse one skill file. BOM and CRLF are tolerated; the frontmatter block
 * feeds `yaml.parse`; anything unparsable (no frontmatter, bad YAML, missing
 * or illegal name) returns null — the caller skips and warns once. An empty
 * body is legal: such a skill can only be hit by an explicit `@skill:` and
 * injects no body block.
 */
export function parseSkillFile(fileName: string, text: string): Skill | null {
  const clean = text.replace(/^\uFEFF/, '')
  const front = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(clean)
  if (!front) return null
  let parsed: unknown
  try {
    parsed = parseYaml(front[1])
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const record = parsed as Record<string, unknown>
  const name = String(record.name ?? '').trim()
  if (!SKILL_NAME.test(name)) return null
  // Descriptions land inside a ONE-LINE catalog entry — newlines (legal in
  // YAML block scalars) collapse to spaces here so they can never leak one.
  const description = cap(String(record.description ?? '').trim().replace(/\s+/g, ' '), 200)
  // Keywords arrive as a YAML array or a comma string（"审查, kata, 词"）—
  // both full-width and ASCII commas split. Stored lowercased: matching
  // lowercases both sides, and one canonical form keeps `planSkills` dumb.
  const rawKeywords = Array.isArray(record.keywords)
    ? record.keywords
    : typeof record.keywords === 'string' && record.keywords.trim()
      ? record.keywords.split(/[,，]/)
      : []
  const keywords: string[] = []
  for (const raw of rawKeywords) {
    const keyword = String(raw).trim().toLowerCase()
    // Single-character keywords are dropped on purpose: a 1-char keyword is
    // a substring of half the Chinese language and pins the skill onto
    // nearly every round.
    if (keyword.length < 2 || keywords.includes(keyword)) continue
    keywords.push(keyword)
  }
  const body = clean.slice(front[0].length).trim()
  return { name, description, keywords, body }
}

/**
 * Load every valid skill under `dir` (`.md` only, filename order for the
 * duplicate "first wins" rule, name-sorted result). NEVER throws: a missing
 * directory, an unreadable file, oversized content, bad YAML or a duplicate
 * name is a skip + one warning — the turn must survive any `skills/` state.
 */
export function loadSkills(dir: string): Skill[] {
  let files: string[]
  try {
    files = readdirSync(dir)
  } catch {
    return []
  }
  const byKey = new Map<string, Skill>()
  for (const fileName of files.slice().sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (!fileName.toLowerCase().endsWith('.md')) continue
    const filePath = join(dir, fileName)
    try {
      if (statSync(filePath).size > SKILL_FILE_MAX_BYTES) {
        warnOnce(filePath, `超过 ${SKILL_FILE_MAX_BYTES} 字节`)
        continue
      }
      const skill = parseSkillFile(fileName, readFileSync(filePath, 'utf8'))
      if (!skill) {
        warnOnce(filePath, '缺 name / 无 frontmatter / 坏 YAML')
        continue
      }
      const key = skill.name.toLowerCase()
      if (byKey.has(key)) {
        warnOnce(filePath, `技能名 ${skill.name} 已存在，先到先得`)
        continue
      }
      byKey.set(key, skill)
    } catch {
      warnOnce(filePath, '读取失败')
    }
  }
  return [...byKey.values()].sort(byName)
}

export interface SkillsPlan {
  /** The section's lines (title first), ready to join('\n'). */
  lines: string[]
  /** Names whose bodies made it into `lines`, in output order. */
  injected: string[]
  /** Hit skills the budget cut — names, for the 预算用尽 marker. */
  skipped: string[]
}

/**
 * Decide the 【技能】 section. `null` = no section at all (nothing selected,
 * or every selected name is missing from the catalog — stale names are
 * silently ignored, the UI grays them out instead).
 *
 * Hit rules apply ONLY to selected-and-known skills, in CATALOG (name)
 * order — the same input always yields the same prompt regardless of the
 * checkbox order:
 *   1. explicit — `@skill:name` inside `explicitText` (the caller feeds it
 *      `visibleText()` output, so code spans / fences / link labels don't
 *      count, the same boundary as an `@name` call), case-insensitive;
 *   2. keyword  — a lowercased substring of `text` (the caller feeds the
 *      raw visible message contents; CJK matches as a plain substring).
 *
 * Budget: title + catalog line are reserved first, then each hit's block
 * (`### 技能：<name>` + body capped at SKILL_BODY_MAX). The first block
 * that doesn't fit stops the section; the rest land in `skipped` and, when
 * the marker line itself fits, as `（技能正文预算用尽，未注入：a、b）`.
 */
export function planSkills(input: {
  /** Known skills; the caller guarantees name-sorted (loadSkills does). */
  catalog: Skill[]
  /** The character's checked skill names. */
  selected: string[]
  /** Keyword source: this round's visible message contents, joined. */
  text: string
  /** @skill: source: visibleText() of this round's messages that contain it. */
  explicitText: string
}): SkillsPlan | null {
  if (input.selected.length === 0 || input.catalog.length === 0) return null
  const selected = new Set(
    input.selected
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean),
  )
  const available = input.catalog.filter((skill) => selected.has(skill.name.toLowerCase()))
  if (available.length === 0) return null

  const title = `【技能】（已勾选 ${available.length} 个；关键词或 @skill:名字 命中才注入正文）`
  // One catalog line, always exactly one: description ≤ 40 chars, the whole
  // line ≤ 400, ellipsis-terminated when cut.
  const entries = available.map((skill) =>
    `${skill.name}${skill.description ? `（${cap(skill.description, SKILL_CATALOG_DESC_MAX)}）` : ''}`,
  )
  const catalogLine = cap(
    `- 技能目录：${entries.join('、')}`.replace(/[\r\n]+/g, ' '),
    SKILL_CATALOG_LINE_MAX,
  )
  const lines: string[] = [title, catalogLine]
  let used = title.length + 1 + catalogLine.length

  const explicitNames = new Set<string>()
  for (const match of input.explicitText.matchAll(SKILL_EXPLICIT)) {
    explicitNames.add(match[1].toLowerCase())
  }
  const text = input.text.toLowerCase()
  const hits = available.filter(
    (skill) => explicitNames.has(skill.name.toLowerCase()) || skill.keywords.some((keyword) => text.includes(keyword)),
  )

  const injected: string[] = []
  const skipped: string[] = []
  for (let index = 0; index < hits.length; index += 1) {
    const skill = hits[index]
    const block = [
      `### 技能：${skill.name}`,
      // An empty body is legal: the header line alone is the whole block,
      // so an @-only skill still announces itself without a body block.
      ...(skill.body ? [cap(skill.body, SKILL_BODY_MAX)] : []),
    ]
    // Each pushed line costs its length + its '\n' — `used` then equals
    // lines.join('\n').length exactly, the number SKILLS_TOTAL_MAX bounds.
    const blockLen = block.reduce((sum, line) => sum + line.length + 1, 0)
    if (used + blockLen > SKILLS_TOTAL_MAX) {
      skipped.push(...hits.slice(index).map((entry) => entry.name))
      break
    }
    used += blockLen
    lines.push(...block)
    injected.push(skill.name)
  }
  if (skipped.length > 0) {
    const marker = `（技能正文预算用尽，未注入：${skipped.join('、')}）`
    if (used + marker.length + 1 <= SKILLS_TOTAL_MAX) {
      lines.push(marker)
      used += marker.length + 1
    }
  }
  return { lines, injected, skipped }
}
