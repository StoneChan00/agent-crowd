import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DATA_DIR } from './paths.ts'
import { loadSeedAvatars } from './seed-avatars.ts'
import {
  buildFailureEpisode,
  buildRoundEpisode,
  escapeLike,
  FAILURE_LESSON_PREFIX,
  ftsQuote,
  planMemoryQuery,
  type RoundEpisodeFacts,
} from './memory.ts'
import { DEFAULT_TRIGGERS,
  type AuthorType,
  type Character,
  type CharacterPreset,
  type CharacterUsage,
  type HarnessKind,
  type Identity,
  type Memory,
  type MemoryKind,
  type MemoryScope,
  type Message,
  type MessageMeta,
  type Room,
  type RoundCheck,
  type RoomUsage,
  type Session,
  type Task,
  type Triggers,
  type Turn,
  type TurnStatus,
  type UsageTotals,
} from './types.ts'
import { pickDefined } from './util.ts'
import { CALL_NAME_SOURCE } from './mentions.ts'

const DB_FILE = join(DATA_DIR, 'agent-crowd.db')

const db = new DatabaseSync(DB_FILE)
db.exec('pragma journal_mode = wal')
db.exec(`
  create table if not exists rooms (
    id text primary key,
    name text not null,
    topic text not null default '',
    working_dir text not null,
    max_hops integer not null default 6,
    verify_command text not null default '',
    reviewer_character_id text,
    created_at integer not null
  );

  create table if not exists characters (
    id text primary key,
    room_id text not null,
    name text not null,
    aliases text not null default '[]',
    avatar text not null default '🤖',
    color text not null default '#8b76f6',
    harness text not null default 'mock',
    model text not null default '',
    persona text not null default '',
    cwd text not null default '',
    triggers text not null default '{}',
    command_template text not null default '',
    auto_approve integer not null default 1,
    enabled integer not null default 1,
    identity_id text,
    preset_id text,
    created_at integer not null
  );
  create index if not exists idx_characters_room on characters(room_id);

  create table if not exists messages (
    id text primary key,
    room_id text not null,
    author_type text not null,
    character_id text,
    author_name text not null,
    author_avatar text not null default '',
    color text not null default '',
    content text not null,
    meta text,
    created_at integer not null
  );
  create index if not exists idx_messages_room on messages(room_id, created_at);

  create table if not exists turns (
    id text primary key,
    room_id text not null,
    character_id text not null,
    status text not null,
    trigger_message_id text,
    output text not null default '',
    error text,
    hop integer not null default 1,
    override text,
    retry integer not null default 0,
    is_round_summary integer not null default 0,
    round_id text,
    changed text,
    started_at integer not null,
    ended_at integer
  );

  create table if not exists round_checks (
    id text primary key,
    room_id text not null,
    round_id text not null,
    kind text not null,
    verdict text not null,
    character_id text,
    message_id text,
    detail text,
    created_at integer not null
  );
  create index if not exists idx_round_checks_round on round_checks(room_id, round_id, kind);

  create table if not exists sessions (
    room_id text not null,
    character_id text not null,
    harness text not null,
    model text not null default '',
    session_id text not null,
    consumed_at integer not null,
    consumed_seq integer not null default 0,
    turns integer not null default 0,
    created_at integer not null,
    updated_at integer not null,
    primary key (room_id, character_id)
  );

  create table if not exists tasks (
    id text primary key,
    room_id text not null,
    title text not null,
    what text not null,
    why text not null default '',
    acceptance text not null default '',
    assignee_id text,
    status text not null default 'proposed',
    created_at integer not null,
    approved_at integer,
    done_at integer,
    round_id text,
    result text
  );
  create index if not exists idx_tasks_room on tasks(room_id, created_at);

  create table if not exists character_presets (
    id text primary key,
    name text not null,
    aliases text not null default '[]',
    avatar text not null default '🤖',
    color text not null default '#8b76f6',
    harness text not null default 'mock',
    model text not null default '',
    persona text not null default '',
    cwd text not null default '',
    triggers text not null default '{}',
    command_template text not null default '',
    auto_approve integer not null default 1,
    created_at integer not null
  );

  create table if not exists meta (
    key text primary key,
    value text not null
  );

  create table if not exists identities (
    id text primary key,
    name text not null,
    avatar text not null default '🤖',
    color text not null default '#8b76f6',
    persona text not null default '',
    created_at integer not null
  );
  create unique index if not exists idx_identities_name on identities(name);

  create table if not exists memories (
    id text primary key,
    scope text not null,
    owner_id text not null,
    kind text not null default 'fact',
    content text not null,
    source_room_id text,
    pinned integer not null default 0,
    use_count integer not null default 0,
    created_at integer not null,
    last_used_at integer,
    content_hash text
  );
  create index if not exists idx_memories_owner on memories(scope, owner_id);
`)

/**
 * `create table if not exists` never touches existing tables, so schema
 * upgrades (aliases, identity_id) need explicit ALTERs that no-op when the
 * column is already there.
 */
function addColumnIfMissing(table: string, column: string, ddl: string): void {
  const row = db.prepare(`pragma table_info(${table})`).all() as { name?: string }[]
  if (row.some((item) => item.name === column)) return
  try {
    db.exec(`alter table ${table} add column ${ddl}`)
  } catch (error) {
    console.error(`[agent-crowd] migration failed (${table}.${column}):`, error instanceof Error ? error.message : error)
  }
}

addColumnIfMissing('characters', 'aliases', "aliases text not null default '[]'")
addColumnIfMissing('character_presets', 'aliases', "aliases text not null default '[]'")
addColumnIfMissing('characters', 'identity_id', 'identity_id text')
// Persists which library template a room character was born from, so the
// "↻ 对齐" refresh knows what to realign against (docs/memory-plan.md L1).
addColumnIfMissing('characters', 'preset_id', 'preset_id text')
// Persisted so the boot sweep can taskkill CLI trees orphaned by a hard kill.
addColumnIfMissing('turns', 'pid', 'pid integer')
// Turns double as the queue (P0-2): these scheduling fields are written at
// enqueue time so a hard-killed server can restore the pending queue on boot.
addColumnIfMissing('turns', 'hop', 'hop integer not null default 1')
addColumnIfMissing('turns', 'override', 'override text')
addColumnIfMissing('turns', 'retry', 'retry integer not null default 0')
addColumnIfMissing('turns', 'resume_attempt', 'resume_attempt integer not null default 0')
addColumnIfMissing('turns', 'is_round_summary', 'is_round_summary integer not null default 0')
// SOP gate (P0-3): per-room verification command + per-round evidence.
addColumnIfMissing('rooms', 'verify_command', "verify_command text not null default ''")
// B09 isolation worktree: source repo + branch the room's worktree was cut
// from. Both empty = the room works directly in working_dir (legacy shape).
addColumnIfMissing('rooms', 'isolation_source', "isolation_source text not null default ''")
addColumnIfMissing('rooms', 'isolation_branch', "isolation_branch text not null default ''")
addColumnIfMissing('turns', 'round_id', 'round_id text')
addColumnIfMissing('turns', 'changed', 'changed text')
// Session continuity (P0-1 review): the cursor's same-millisecond tiebreaker.
// Old rows default to seq 0 — a same-ms sibling of such a cursor re-ships once
// (re-send, never skip), which is exactly the safe direction.
addColumnIfMissing('sessions', 'consumed_seq', 'consumed_seq integer not null default 0')
// Task cards (B03): the approval/dispatch turn and its relay hand-offs carry
// the card id so the round settlement can write the card's state back.
addColumnIfMissing('turns', 'task_id', 'task_id text')

// Self-review ban (B05): the room's designated reviewer column.
addColumnIfMissing('rooms', 'reviewer_character_id', 'reviewer_character_id text')

// B07 on-demand skills: the character's checked skill names, JSON-encoded.
// Default '[]' so every existing row reads as "nothing checked".
addColumnIfMissing('characters', 'skills', "skills text not null default '[]'")

// Task cards (B03 review 1): approval writes `running` synchronously — the
// fleeting `approved` state is no longer produced and had no exit (a swept
// queued turn locked the card out of every action). Any row still sitting in
// `approved` (e.g. a local DB last touched by the pre-fix build) is unlocked
// here. Unconditional on purpose: idempotent, and the table is tiny.
db.prepare("update tasks set status = 'running' where status = 'approved'").run()

// B04 memory search: old databases predate the hash column — the column
// comes first, THEN the unique index (creating the index inside the schema
// block above would crash a pre-B04 boot with a missing-column error).
addColumnIfMissing('memories', 'content_hash', 'content_hash text')
// Partial unique index: manually-created memories carry a null hash and stay
// outside the constraint; automatic episodes dedupe on exact same facts.
db
  .prepare(
    'create unique index if not exists idx_memories_hash on memories(scope, owner_id, content_hash) where content_hash is not null',
  )
  .run()

/**
 * FTS5 availability flag (B04): false → retrieval degrades to LIKE-only.
 * Startup must NEVER die because the search index failed to build.
 */
let memoryFts = false

/**
 * B04 memory search: an external-content FTS5 table over memories with
 * trigram tokenization (the only mode that substring-matches CJK). The
 * triggers are NOT optional — a content table without them matches nothing
 * and reports no error (silent empty search). The unconditional rebuild on
 * boot re-indexes rows written before FTS existed; the table is small.
 */
function initMemorySearch(): void {
  try {
    db.exec(`
      create virtual table if not exists memories_fts using fts5(
        content, content='memories', content_rowid='rowid', tokenize='trigram'
      );
      create trigger if not exists memories_ai after insert on memories begin
        insert into memories_fts(rowid, content) values (new.rowid, new.content);
      end;
      create trigger if not exists memories_ad after delete on memories begin
        insert into memories_fts(memories_fts, rowid, content) values('delete', old.rowid, old.content);
      end;
      create trigger if not exists memories_au after update on memories begin
        insert into memories_fts(memories_fts, rowid, content) values('delete', old.rowid, old.content);
        insert into memories_fts(rowid, content) values (new.rowid, new.content);
      end;
    `)
    db.prepare(`insert into memories_fts(memories_fts) values('rebuild')`).run()
    memoryFts = true
  } catch (error) {
    memoryFts = false
    // A half-initialized index must not intercept writes (B04 review 1):
    // leftover triggers would re-route every memories INSERT into the broken
    // vtable and throw — turning "FTS degraded" into "cannot save memories".
    // Drop them best-effort; if even this fails the index stays inert.
    try {
      db.exec(
        'drop trigger if exists memories_ai; drop trigger if exists memories_ad; drop trigger if exists memories_au;',
      )
    } catch {
      /* nothing further to do — writes may fail loudly, which is visible */
    }
    console.warn(
      `[agent-crowd] memory FTS unavailable, retrieval degrades to LIKE: ${error instanceof Error ? error.message : error}`,
    )
  }
}
initMemorySearch()

/**
 * TEST-ONLY (prompt-check R9): force the FTS availability flag so the
 * degradation path — long terms fall back to LIKE instead of vanishing —
 * can be regression-locked without sabotaging a real index. Never call
 * this from server code.
 */
export function __setMemoryFtsForTests(enabled: boolean): void {
  memoryFts = enabled
}

const now = () => Date.now()

/* ------------------------------------------------------------------ rooms */

function mapRoom(row: Record<string, unknown>): Room {
  return {
    id: String(row.id),
    name: String(row.name),
    topic: String(row.topic ?? ''),
    workingDir: String(row.working_dir),
    maxHops: Number(row.max_hops ?? 6),
    verifyCommand: String(row.verify_command ?? ''),
    reviewerCharacterId:
      row.reviewer_character_id === null || row.reviewer_character_id === undefined
        ? null
        : String(row.reviewer_character_id),
    createdAt: Number(row.created_at),
  }
}

export function listRooms(): Room[] {
  return db.prepare('select * from rooms order by created_at asc').all().map(mapRoom)
}

export function getRoom(id: string): Room | undefined {
  const row = db.prepare('select * from rooms where id = ?').get(id)
  return row ? mapRoom(row) : undefined
}

export function createRoom(input: {
  name: string
  topic?: string
  workingDir: string
  maxHops?: number
  verifyCommand?: string
  reviewerCharacterId?: string | null
}): Room {
  const room: Room = {
    id: randomUUID(),
    name: input.name.trim() || '未命名房间',
    topic: input.topic?.trim() ?? '',
    workingDir: input.workingDir,
    maxHops: clampHops(input.maxHops),
    verifyCommand: clampVerifyCommand(input.verifyCommand),
    reviewerCharacterId: input.reviewerCharacterId ?? null,
    createdAt: now(),
  }
  db.prepare(
    'insert into rooms (id, name, topic, working_dir, max_hops, verify_command, reviewer_character_id, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    room.id,
    room.name,
    room.topic,
    room.workingDir,
    room.maxHops,
    room.verifyCommand,
    room.reviewerCharacterId,
    room.createdAt,
  )
  return room
}

export function updateRoom(
  id: string,
  patch: Partial<Pick<Room, 'name' | 'topic' | 'workingDir' | 'maxHops' | 'verifyCommand' | 'reviewerCharacterId'>>,
): Room | undefined {
  const current = getRoom(id)
  if (!current) return undefined
  const next: Room = {
    ...current,
    ...pickDefined(patch),
    maxHops: patch.maxHops === undefined ? current.maxHops : clampHops(patch.maxHops),
    verifyCommand: patch.verifyCommand === undefined ? current.verifyCommand : clampVerifyCommand(patch.verifyCommand),
    // Null is a legitimate value (clearing the designation) — pickDefined
    // handles it; only undefined means "leave as is".
    reviewerCharacterId:
      patch.reviewerCharacterId === undefined ? current.reviewerCharacterId : patch.reviewerCharacterId || null,
  }
  db.prepare(
    'update rooms set name = ?, topic = ?, working_dir = ?, max_hops = ?, verify_command = ?, reviewer_character_id = ? where id = ?',
  ).run(next.name, next.topic, next.workingDir, next.maxHops, next.verifyCommand, next.reviewerCharacterId, id)
  return next
}

/** Verification commands are operator-supplied one-liners: trim, cap at 500, empty is legal (= gate skips verify). */
function clampVerifyCommand(value: string | undefined): string {
  return (value ?? '').trim().slice(0, 500)
}

export function deleteRoom(id: string): void {
  db.prepare('delete from messages where room_id = ?').run(id)
  db.prepare('delete from turns where room_id = ?').run(id)
  db.prepare('delete from round_checks where room_id = ?').run(id)
  db.prepare('delete from characters where room_id = ?').run(id)
  db.prepare("delete from memories where scope = 'room' and owner_id = ?").run(id)
  // Session rows belong to this room's transcript; the room is going away.
  db.prepare('delete from sessions where room_id = ?').run(id)
  // Task cards belong to the room (B03): no orphans for a deleted room.
  db.prepare('delete from tasks where room_id = ?').run(id)
  db.prepare('delete from rooms where id = ?').run(id)
}

function clampHops(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 6
  return Math.min(30, Math.max(1, Math.round(value)))
}

/* ------------------------------------------------------------- characters */

function parseTriggers(raw: unknown): Triggers {
  if (typeof raw !== 'string' || raw.trim() === '') return { ...DEFAULT_TRIGGERS }
  try {
    const parsed = JSON.parse(raw) as Partial<Triggers>
    return {
      onUser: parsed.onUser ?? DEFAULT_TRIGGERS.onUser,
      onAll: parsed.onAll ?? DEFAULT_TRIGGERS.onAll,
      onCharacters: Array.isArray(parsed.onCharacters) ? parsed.onCharacters.map(String) : [],
      onCharacterNames: Array.isArray(parsed.onCharacterNames) ? parsed.onCharacterNames.map(String) : [],
      keyword: typeof parsed.keyword === 'string' ? parsed.keyword : '',
      mention: parsed.mention ?? DEFAULT_TRIGGERS.mention,
      onRoundEnd: parsed.onRoundEnd ?? false,
    }
  } catch {
    return { ...DEFAULT_TRIGGERS }
  }
}

/** Parse the stored JSON alias list; anything malformed becomes "no aliases". */
function parseAliases(raw: unknown): string[] {
  if (typeof raw !== 'string' || raw.trim() === '') return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

/** Call-names that must never become aliases: `@all` / `@所有人` already mean "everyone". */
const RESERVED_ALIASES = new Set(['all', '所有人'])

/**
 * Trim, strip a leading `@` (users habitually type it), collapse whitespace,
 * cap at 32 chars / 8 entries; drop empties, duplicates, the name itself and
 * reserved words. Case is preserved — conflicts are checked
 * case-insensitively in assertCallNamesFree, matching the /i matcher.
 *
 * A call-name must also fit CALL_NAME_SOURCE (one chip token): an alias with
 * a space or a dot is matched literally by the router, but the web highlight
 * tokenizes at the first outside character — the character would be woken
 * with no chip to show for it. Dropped here like the other invalid entries
 * (reserved words, duplicates), not an error: the editor shows what stuck.
 */
function sanitizeAliases(input: unknown, name: string): string[] {
  if (!Array.isArray(input)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const entry of input) {
    const item = String(entry).trim().replace(/^@+/, '').replace(/\s+/g, ' ').trim().slice(0, 32)
    if (!item || item === name || seen.has(item)) continue
    if (RESERVED_ALIASES.has(item.toLowerCase())) continue
    if (!CALL_NAME_SOURCE.test(item)) continue
    seen.add(item)
    out.push(item)
    if (out.length >= 8) break
  }
  return out
}

/**
 * B07: read-side defense for characters.skills. Legacy rows predate the
 * column (default '[]'), and hand-edited JSON can be anything — bad JSON, a
 * non-array, non-string, empty or whitespace-only elements. Nothing here may
 * stop the character from loading: junk elements are dropped, the rest
 * survives. Keys are canonicalized to lowercase — the skill matcher is
 * case-insensitive, so `code-review` and `Code-Review` must read as ONE
 * entry, never a checked-plus-missing pair (B07 review, non-blocking 3).
 */
function parseSkillsColumn(raw: unknown): string[] {
  if (typeof raw !== 'string' || raw.trim() === '') return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const entry of parsed) {
    if (typeof entry !== 'string') continue
    const name = entry.trim().toLowerCase()
    if (!name || seen.has(name)) continue
    seen.add(name)
    out.push(name)
  }
  return out
}

/**
 * B07: write-side normalization for a skills selection — trim, drop
 * empties, dedupe, preserve order, ≤32 entries, each sliced at 64 chars
 * (the skill-name grammar cap, so a hand-edited long name still matches a
 * real catalog entry after the slice). Keys lowercase for the same reason
 * as parseSkillsColumn above.
 */
function normalizeSkills(input: string[] | undefined): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const entry of input ?? []) {
    const name = String(entry).trim().slice(0, 64).toLowerCase()
    if (!name || seen.has(name) || out.length >= 32) continue
    seen.add(name)
    out.push(name)
  }
  return out
}

/** Raised when a character is about to be stored under a call-name the chip grammar can't highlight. */
export class InvalidCallNameError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidCallNameError'
  }
}

/**
 * A character name is the primary call-name, so it has to be one chip token
 * too (same CALL_NAME_SOURCE as aliases): `@名字` with a space in it wakes
 * the character on the server but can never light up in the bubble. The API
 * layer turns this into a 400 the editor can show inline, exactly like
 * CallNameConflictError.
 */
function assertCallNameShape(name: string): void {
  if (!CALL_NAME_SOURCE.test(name)) {
    throw new InvalidCallNameError(
      `名字「${name}」不能用作 @点名：只能包含中英文、数字、下划线和连字符（不能带空格或符号），否则气泡里无法高亮`,
    )
  }
}

/** Raised when a name/alias would shadow another character's call-name in the same room. */
export class CallNameConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CallNameConflictError'
  }
}

/**
 * A call-name (name or alias) must be unambiguous per room — the mention
 * matcher is case-insensitive, so conflicts are checked case-insensitively
 * too. The API layer turns this into a 400 the editor can show inline.
 */
function assertCallNamesFree(roomId: string, selfId: string | null, name: string, aliases: string[]): void {
  const taken = new Map<string, string>()
  for (const other of listCharacters(roomId)) {
    if (other.id === selfId) continue
    taken.set(other.name.toLowerCase(), other.name)
    for (const alias of other.aliases) taken.set(alias.toLowerCase(), alias)
  }
  const clash = taken.get(name.toLowerCase())
  if (clash) throw new CallNameConflictError(`名字「${name}」与同房间「${clash}」的名字/别名冲突，@点名会指错人`)
  for (const alias of aliases) {
    const hit = taken.get(alias.toLowerCase())
    if (hit) throw new CallNameConflictError(`别名「@${alias}」与同房间「${hit}」的名字/别名冲突，@点名会指错人`)
  }
}

function mapCharacter(row: Record<string, unknown>): Character {
  const name = String(row.name)
  return {
    id: String(row.id),
    roomId: String(row.room_id),
    name,
    aliases: sanitizeAliases(parseAliases(row.aliases), name),
    avatar: String(row.avatar ?? '🤖'),
    color: String(row.color ?? '#8b76f6'),
    harness: String(row.harness) as HarnessKind,
    model: String(row.model ?? ''),
    persona: String(row.persona ?? ''),
    cwd: String(row.cwd ?? ''),
    triggers: parseTriggers(row.triggers),
    commandTemplate: String(row.command_template ?? ''),
    autoApprove: Number(row.auto_approve ?? 1) === 1,
    enabled: Number(row.enabled ?? 1) === 1,
    identityId: row.identity_id === null || row.identity_id === undefined ? null : String(row.identity_id),
    presetId: row.preset_id === null || row.preset_id === undefined ? null : String(row.preset_id),
    skills: parseSkillsColumn(row.skills),
    createdAt: Number(row.created_at),
  }
}

// created_at alone can tie within the seeding loop's same millisecond, which
// leaves insert order to SQLite's whim — and "first enabled character" (the
// no-@ routing fallback) plus the library order both ride on it. rowid is
// the insertion sequence and breaks the tie deterministically.
const CHAR_ORDER = 'order by created_at asc, rowid asc'

export function listCharacters(roomId: string): Character[] {
  return db.prepare(`select * from characters where room_id = ? ${CHAR_ORDER}`).all(roomId).map(mapCharacter)
}

export function listAllCharacters(): Character[] {
  return db.prepare(`select * from characters ${CHAR_ORDER}`).all().map(mapCharacter)
}

export function getCharacter(id: string): Character | undefined {
  const row = db.prepare('select * from characters where id = ?').get(id)
  return row ? mapCharacter(row) : undefined
}

export interface CharacterInput {
  roomId: string
  name: string
  aliases?: string[]
  avatar?: string
  color?: string
  harness?: HarnessKind
  model?: string
  persona?: string
  cwd?: string
  triggers?: Partial<Triggers>
  commandTemplate?: string
  autoApprove?: boolean
  enabled?: boolean
  /** Library template this character is copied from; null for hand-made characters. */
  presetId?: string | null
  /** B07: checked skill names; absent = leave as-is (update) / none (create). */
  skills?: string[]
}

export function createCharacter(input: CharacterInput): Character {
  const name = input.name.trim() || '新角色'
  assertCallNameShape(name)
  const character: Character = {
    id: randomUUID(),
    roomId: input.roomId,
    name,
    aliases: sanitizeAliases(input.aliases, name),
    avatar: input.avatar?.trim() || '🤖',
    color: input.color?.trim() || '#8b76f6',
    harness: input.harness ?? 'mock',
    model: input.model?.trim() ?? '',
    persona: input.persona ?? '',
    cwd: input.cwd?.trim() ?? '',
    triggers: { ...DEFAULT_TRIGGERS, ...input.triggers },
    commandTemplate: input.commandTemplate ?? '',
    autoApprove: input.autoApprove ?? true,
    enabled: input.enabled ?? true,
    identityId: null,
    presetId: input.presetId ?? null,
    skills: normalizeSkills(input.skills),
    createdAt: now(),
  }
  // Ambiguous call-names would make @mentions wake the wrong character.
  assertCallNamesFree(input.roomId, null, character.name, character.aliases)
  db.prepare(
    `insert into characters
       (id, room_id, name, aliases, avatar, color, harness, model, persona, cwd, triggers, command_template, auto_approve, enabled, preset_id, skills, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    character.id,
    character.roomId,
    character.name,
    JSON.stringify(character.aliases),
    character.avatar,
    character.color,
    character.harness,
    character.model,
    character.persona,
    character.cwd,
    JSON.stringify(character.triggers),
    character.commandTemplate,
    character.autoApprove ? 1 : 0,
    character.enabled ? 1 : 0,
    character.presetId,
    JSON.stringify(character.skills),
    character.createdAt,
  )
  return character
}

export function updateCharacter(id: string, patch: Partial<CharacterInput>): Character | undefined {
  const current = getCharacter(id)
  if (!current) return undefined
  const renamed = patch.name !== undefined && patch.name.trim() !== '' && patch.name.trim() !== current.name
  const nextName = patch.name?.trim() || current.name
  const next: Character = {
    ...current,
    ...pickDefined({
      avatar: patch.avatar?.trim(),
      color: patch.color?.trim(),
      harness: patch.harness,
      model: patch.model?.trim(),
      persona: patch.persona,
      cwd: patch.cwd?.trim(),
      commandTemplate: patch.commandTemplate,
      autoApprove: patch.autoApprove,
      enabled: patch.enabled,
    }),
    name: nextName,
    aliases:
      patch.aliases === undefined
        ? current.aliases.filter((alias) => alias !== nextName)
        : sanitizeAliases(patch.aliases, nextName),
    triggers: patch.triggers ? { ...current.triggers, ...patch.triggers } : current.triggers,
    // B07: skills only change when the patch carries them — the preset
    // "↻ 对齐" refresh routes through here WITHOUT skills, so a re-alignment
    // never silently wipes the room-local selection.
    skills: patch.skills === undefined ? current.skills : normalizeSkills(patch.skills),
  }
  // Only police call-names when they actually change: rooms with legacy
  // duplicate names (created before the check existed) stay editable for
  // unrelated fields instead of failing every PATCH. Same for the shape
  // check — a legacy spaced name only blocks renames, not avatar edits.
  const callNamesChanged =
    next.name !== current.name || JSON.stringify(next.aliases) !== JSON.stringify(current.aliases)
  if (callNamesChanged) {
    assertCallNameShape(next.name)
    assertCallNamesFree(current.roomId, id, next.name, next.aliases)
  }
  db.prepare(
    `update characters set name = ?, aliases = ?, avatar = ?, color = ?, harness = ?, model = ?, persona = ?,
       cwd = ?, triggers = ?, command_template = ?, auto_approve = ?, enabled = ?, skills = ? where id = ?`,
  ).run(
    next.name,
    JSON.stringify(next.aliases),
    next.avatar,
    next.color,
    next.harness,
    next.model,
    next.persona,
    next.cwd,
    JSON.stringify(next.triggers),
    next.commandTemplate,
    next.autoApprove ? 1 : 0,
    next.enabled ? 1 : 0,
    JSON.stringify(next.skills),
    id,
  )

  // Session continuity (P0-1): a harness or model change means the stored
  // CLI session belongs to a different agent — drop the row so the next
  // turn replays the full transcript instead of resuming across a persona
  // break. syncCharacterFromPreset routes through updateCharacter, so the
  // library "↻ 对齐" refresh is swept by the same hook.
  if (next.harness !== current.harness || next.model !== current.model) {
    clearSession(current.roomId, id)
  }

  // Name-based trigger rules are portable, so a rename has to follow through.
  if (renamed) {
    for (const other of listCharacters(current.roomId)) {
      if (other.id === id || !other.triggers.onCharacterNames.includes(current.name)) continue
      updateCharacter(other.id, {
        triggers: {
          ...other.triggers,
          onCharacterNames: other.triggers.onCharacterNames.map((name) =>
            name === current.name ? next.name : name,
          ),
        },
      })
    }
  }

  return next
}

export function deleteCharacter(id: string): void {
  db.prepare('delete from characters where id = ?').run(id)
  // Session continuity (P0-1): the character is gone, its CLI session row
  // must not outlive it (a re-created same-name character is a new agent).
  db.prepare('delete from sessions where character_id = ?').run(id)
  // Task cards (B03) outlive their assignee — the card keeps its content,
  // only the pointer clears; a re-assigned card can be approved again.
  db.prepare('update tasks set assignee_id = null where assignee_id = ?').run(id)
  // Self-review ban (B05): a stale reviewer id would block the room forever
  // (the PASS author can never match a deleted character) — clear it.
  db.prepare('update rooms set reviewer_character_id = null where reviewer_character_id = ?').run(id)
}

/* --------------------------------------------------------------- messages */

function parseMeta(raw: unknown): MessageMeta | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null
  try {
    return JSON.parse(raw) as MessageMeta
  } catch {
    return null
  }
}

function mapMessage(row: Record<string, unknown>): Message {
  return {
    id: String(row.id),
    roomId: String(row.room_id),
    authorType: String(row.author_type) as AuthorType,
    characterId: row.character_id === null ? null : String(row.character_id),
    authorName: String(row.author_name),
    authorAvatar: String(row.author_avatar ?? ''),
    color: String(row.color ?? ''),
    content: String(row.content),
    meta: parseMeta(row.meta),
    createdAt: Number(row.created_at),
    // rowid: monotonic with insert order — the same-ms tiebreaker the session
    // cursor compares on (see Message.seq).
    seq: Number(row.seq ?? row.rowid ?? 0),
  }
}

export function listMessages(roomId: string, limit = 200): Message[] {
  const rows = db
    .prepare(
      'select rowid as seq, * from messages where room_id = ? order by created_at desc, rowid desc limit ?',
    )
    .all(roomId, Math.min(2000, Math.max(1, limit)))
  return rows.map(mapMessage).reverse()
}

/**
 * Single-message fetch by id (B06): relayed turns inject the handoff carried
 * by the message they answer (item.triggerMessageId) — NOT the newest
 * message, which a later user note may have replaced. Reads through the same
 * meta-parsing mapper so meta.handoff round-trips.
 */
export function getMessageById(id: string): Message | undefined {
  const row = db.prepare('select rowid as seq, * from messages where id = ?').get(id)
  return row ? mapMessage(row) : undefined
}

/**
 * After-cursor fetch for resumed turns (B01): strictly newer than the
 * (createdAt, seq) cursor, newest-first window reversed to ascending. The
 * old "recent 80" listMessages window stranded older increments outside
 * memory before the prompt's fold could even see them — one scripted flood
 * of 90 messages lost the oldest 10 outright. Saturation (rows === limit)
 * means older increments exist beyond the window; the caller folds those by
 * count (countMessagesAfter) instead of skipping them.
 */
export function listMessagesAfter(
  roomId: string,
  cursor: { at: number; seq: number },
  limit = 1_000,
): Message[] {
  const rows = db
    .prepare(
      `select rowid as seq, * from messages
       where room_id = ? and (created_at > ? or (created_at = ? and rowid > ?))
       order by created_at desc, rowid desc
       limit ?`,
    )
    .all(roomId, cursor.at, cursor.at, cursor.seq, Math.min(2_000, Math.max(1, limit)))
  return rows.map(mapMessage).reverse()
}

/** How many messages sit strictly after the cursor — the fold's beyond-window count. */
export function countMessagesAfter(roomId: string, cursor: { at: number; seq: number }): number {
  const row = db
    .prepare(
      'select count(*) as c from messages where room_id = ? and (created_at > ? or (created_at = ? and rowid > ?))',
    )
    .get(roomId, cursor.at, cursor.at, cursor.seq) as { c: number } | undefined
  return Number(row?.c ?? 0)
}

export function countMessages(roomId: string): number {
  const row = db.prepare('select count(*) as c from messages where room_id = ?').get(roomId) as
    | { c: number }
    | undefined
  return Number(row?.c ?? 0)
}

function emptyUsage(): UsageTotals {
  return { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
}

function addUsage(target: UsageTotals, tokens: NonNullable<MessageMeta['tokens']>): void {
  const input = tokens.input ?? 0
  const output = tokens.output ?? 0
  target.turns += 1
  target.input += input
  target.output += output
  target.cacheRead += tokens.cacheRead ?? 0
  target.cacheWrite += tokens.cacheWrite ?? 0
  target.total += tokens.total ?? input + output
}

/**
 * Room token usage from the messages already on disk (B08): every assistant
 * message whose harness reported `tokens` contributes. Harnesses that do not
 * report usage (or old messages from before they did) simply contribute
 * nothing — no estimation, no fabricated numbers.
 */
export function getRoomUsage(roomId: string): RoomUsage {
  const live = new Map(listCharacters(roomId).map((character) => [character.id, character]))
  const rows = db
    .prepare(
      `select character_id, author_name, meta from messages
       where room_id = ? and author_type = 'character' and meta is not null
       order by created_at asc, rowid asc`,
    )
    .all(roomId) as { character_id?: string | null; author_name?: string | null; meta?: string | null }[]
  const totals = emptyUsage()
  const byCharacter = new Map<string, CharacterUsage>()
  for (const row of rows) {
    let meta: MessageMeta
    try {
      meta = JSON.parse(String(row.meta)) as MessageMeta
    } catch {
      continue
    }
    if (!meta.tokens) continue
    const characterId = String(row.character_id ?? '')
    const character = live.get(characterId)
    let entry = byCharacter.get(characterId)
    if (!entry) {
      entry = {
        characterId,
        name: character?.name ?? String(row.author_name ?? '未知角色'),
        harness: character?.harness ?? meta.harness ?? 'mock',
        model: character?.model ?? meta.model ?? '',
        ...emptyUsage(),
      }
      byCharacter.set(characterId, entry)
    }
    addUsage(entry, meta.tokens)
    addUsage(totals, meta.tokens)
  }
  return {
    totals,
    characters: [...byCharacter.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name)),
  }
}

export function addMessage(input: {
  roomId: string
  authorType: AuthorType
  characterId?: string | null
  authorName: string
  authorAvatar?: string
  color?: string
  content: string
  meta?: MessageMeta | null
}): Message {
  const message: Message = {
    id: randomUUID(),
    roomId: input.roomId,
    authorType: input.authorType,
    characterId: input.characterId ?? null,
    authorName: input.authorName,
    authorAvatar: input.authorAvatar ?? '',
    color: input.color ?? '',
    content: input.content,
    meta: input.meta ?? null,
    createdAt: now(),
    // Placeholder until the insert below reports the real rowid.
    seq: 0,
  }
  const inserted = db
    .prepare(
      `insert into messages (id, room_id, author_type, character_id, author_name, author_avatar, color, content, meta, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      message.id,
      message.roomId,
      message.authorType,
      message.characterId,
      message.authorName,
      message.authorAvatar,
      message.color,
      message.content,
      message.meta ? JSON.stringify(message.meta) : null,
      message.createdAt,
    )
  // rowid = insertion sequence, the same-ms tiebreaker (Message.seq).
  message.seq = Number(inserted.lastInsertRowid)
  return message
}

export function clearMessages(roomId: string): void {
  db.prepare('delete from messages where room_id = ?').run(roomId)
  db.prepare('delete from turns where room_id = ?').run(roomId)
  db.prepare('delete from round_checks where room_id = ?').run(roomId)
  // Session continuity (P0-1): the transcript the cursor points into is
  // gone — keep the row and the next turn would "resume" past messages the
  // CLI has never seen (they were just deleted).
  db.prepare('delete from sessions where room_id = ?').run(roomId)
}

/* ------------------------------------------------------------------ turns */

/** `turns.changed` JSON: null = unjudgeable (not a git worktree). */
function parseChanged(raw: unknown): string[] | null {
  if (raw === null || raw === undefined) return null
  if (typeof raw !== 'string' || raw.trim() === '') return null
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.map(String) : null
  } catch {
    return null
  }
}

function mapTurn(row: Record<string, unknown>): Turn {
  return {
    id: String(row.id),
    roomId: String(row.room_id),
    characterId: String(row.character_id),
    status: String(row.status) as TurnStatus,
    triggerMessageId: row.trigger_message_id === null ? null : String(row.trigger_message_id),
    output: String(row.output ?? ''),
    error: row.error === null ? null : String(row.error),
    pid: row.pid === null || row.pid === undefined ? null : Number(row.pid),
    hop: Number(row.hop ?? 1) || 1,
    override: row.override === null || row.override === undefined ? null : String(row.override),
    retry: Number(row.retry ?? 0) === 1,
    resumeAttempt: Number(row.resume_attempt ?? 0) || 0,
    isRoundSummary: Number(row.is_round_summary ?? 0) === 1,
    roundId: row.round_id === null || row.round_id === undefined ? null : String(row.round_id),
    taskId: row.task_id === null || row.task_id === undefined ? null : String(row.task_id),
    changed: parseChanged(row.changed),
    startedAt: Number(row.started_at),
    endedAt: row.ended_at === null ? null : Number(row.ended_at),
  }
}

export function createTurn(input: {
  roomId: string
  characterId: string
  triggerMessageId: string | null
  /** Relay depth; persisted so a restart restores the budget instead of zeroing it. */
  hop?: number
  /** Manual instruction (steer note / run button / round summary text). */
  override?: string
  /** Loop-guard flag for the automatic second attempt. */
  retry?: boolean
  /** M3 timeout-recovery rung (0 = ordinary turn); persisted for boot restore. */
  resumeAttempt?: number
  isRoundSummary?: boolean
  /** Round this turn belongs to (SOP gate, P0-3); null on restored/legacy rows. */
  roundId?: string | null
  /** Task card this turn executes (B03); null on ordinary chat turns. */
  taskId?: string | null
}): Turn {
  const turn: Turn = {
    id: randomUUID(),
    roomId: input.roomId,
    characterId: input.characterId,
    status: 'queued',
    triggerMessageId: input.triggerMessageId,
    output: '',
    error: null,
    pid: null,
    hop: input.hop ?? 1,
    override: input.override ?? null,
    retry: input.retry ?? false,
    resumeAttempt: input.resumeAttempt ?? 0,
    isRoundSummary: input.isRoundSummary ?? false,
    roundId: input.roundId ?? null,
    taskId: input.taskId ?? null,
    changed: null,
    startedAt: now(),
    endedAt: null,
  }
  db.prepare(
    `insert into turns
       (id, room_id, character_id, status, trigger_message_id, output, error, hop, override, retry, resume_attempt, is_round_summary, round_id, task_id, changed, started_at, ended_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    turn.id,
    turn.roomId,
    turn.characterId,
    turn.status,
    turn.triggerMessageId,
    '',
    null,
    turn.hop,
    turn.override,
    turn.retry ? 1 : 0,
    turn.resumeAttempt,
    turn.isRoundSummary ? 1 : 0,
    turn.roundId,
    turn.taskId,
    null,
    turn.startedAt,
    null,
  )
  return turn
}

export function updateTurn(
  id: string,
  patch: Partial<Pick<Turn, 'status' | 'output' | 'error' | 'endedAt' | 'changed'>>,
): void {
  const current = db.prepare('select * from turns where id = ?').get(id)
  if (!current) return
  const turn = mapTurn(current)
  const next = { ...turn, ...pickDefined(patch) }
  db.prepare('update turns set status = ?, output = ?, error = ?, ended_at = ?, changed = ? where id = ?').run(
    next.status,
    next.output,
    next.error,
    next.endedAt,
    // null stays null ("unjudgeable"); a changed list is JSON-encoded.
    next.changed === null ? null : JSON.stringify(next.changed),
    id,
  )
}

export function listRunningTurns(roomId: string): Turn[] {
  return db
    .prepare("select * from turns where room_id = ? and status in ('queued','running') order by started_at asc")
    .all(roomId)
    .map(mapTurn)
}

/** Turns that are still waiting in the queue (turns double as the queue, P0-2). */
export function listQueuedTurns(roomId: string): Turn[] {
  return db
    .prepare("select * from turns where room_id = ? and status = 'queued' order by started_at asc")
    .all(roomId)
    .map(mapTurn)
}

/** Every queued turn across all rooms — the boot-time restore source. */
export function listAllQueuedTurns(): Turn[] {
  return db
    .prepare("select * from turns where status = 'queued' order by started_at asc")
    .all()
    .map(mapTurn)
}

/**
 * Compare-and-set a queued turn to 'running': exactly one claimant wins, so a
 * restored in-memory queue can never double-run a row the DB already handed
 * out. Returns false when the row is no longer 'queued' (claimed elsewhere,
 * stopped, or already terminal).
 */
export function claimTurn(id: string): boolean {
  return db.prepare("update turns set status = 'running' where id = ? and status = 'queued'").run(id).changes === 1
}

/**
 * Re-aim a still-queued turn at a new trigger/override (steer hitting a
 * waiting item). True patch semantics: only fields present on the object are
 * written — the old `?? null` coerced a one-field patch into wiping the
 * other (a steer re-aiming only the trigger would have blanked an override
 * persisted earlier). An empty patch changes nothing and reports false.
 * No-op once the turn has been claimed or ended — the steer path then falls
 * back to queueing a fresh turn.
 */
export function updateQueuedTurn(
  id: string,
  patch: { triggerMessageId?: string | null; override?: string | null },
): boolean {
  const sets: string[] = []
  const args: (string | null)[] = []
  if (patch.triggerMessageId !== undefined) {
    sets.push('trigger_message_id = ?')
    args.push(patch.triggerMessageId)
  }
  if (patch.override !== undefined) {
    sets.push('override = ?')
    args.push(patch.override)
  }
  if (sets.length === 0) return false
  return (
    db
      .prepare(`update turns set ${sets.join(', ')} where id = ? and status = 'queued'`)
      .run(...args, id).changes === 1
  )
}

/**
 * Terminal-sweep the pending queue rows of a room (user stop, hop limit,
 * room cleared). Without this a hard kill + reboot would resurrect a round
 * the user had explicitly silenced — 'stopped' rows are never restored.
 */
export function markQueuedTurnsStopped(roomId: string, reason: string): number {
  return Number(
    db
      .prepare(
        "update turns set status = 'stopped', error = ?, ended_at = ? where room_id = ? and status = 'queued'",
      )
      .run(reason, now(), roomId).changes,
  )
}

/** Persist the CLI pid on the turn row the moment it spawns (boot sweep handle). */
export function setTurnPid(id: string, pid: number): void {
  db.prepare('update turns set pid = ? where id = ?').run(pid, id)
}

/**
 * Boot-time sweep (P0-2 split): a hard-killed server (tsx watch reload,
 * crash, reboot) runs no exit hooks, so turns stay 'running' in the DB
 * forever and their CLI process trees survive as orphans the stop button can
 * no longer reach.
 * - `running` rows are marked interrupted (error) and returned so the caller
 *   can taskkill the persisted pids. They are NOT re-run — a half-finished
 *   turn is worse lost than double-run ("宁丢不重").
 * - `queued` rows are left untouched and returned: they were never started,
 *   so the caller re-queues them (orchestrator.restoreQueues) after listen
 *   and the pending work simply continues.
 */
export function startupRecovery(): { interrupted: Turn[]; queued: Turn[] } {
  const interrupted = db
    .prepare("select * from turns where status = 'running'")
    .all()
    .map(mapTurn)
  if (interrupted.length > 0) {
    db.prepare(
      "update turns set status = 'error', error = coalesce(error, '服务器重启，回合中断'), ended_at = ? where status = 'running'",
    ).run(now())
  }
  const queued = db
    .prepare("select * from turns where status = 'queued' order by started_at asc")
    .all()
    .map(mapTurn)
  return { interrupted, queued }
}

/* ----------------------------------------------------------- round checks */

function mapRoundCheck(row: Record<string, unknown>): RoundCheck {
  return {
    id: String(row.id),
    roomId: String(row.room_id),
    roundId: String(row.round_id),
    kind: String(row.kind) === 'verify' ? 'verify' : 'review',
    verdict: String(row.verdict) === 'fail' ? 'fail' : 'pass',
    characterId: row.character_id === null || row.character_id === undefined ? null : String(row.character_id),
    messageId: row.message_id === null || row.message_id === undefined ? null : String(row.message_id),
    detail: row.detail === null || row.detail === undefined ? null : String(row.detail),
    createdAt: Number(row.created_at),
  }
}

/**
 * Record one SOP-gate outcome (P0-3): a parsed review verdict, or a run of
 * the room's verification command. Written as evidence — the gate itself
 * keeps its live state in the orchestrator's RoundState.
 */
export function addRoundCheck(input: {
  roomId: string
  roundId: string
  kind: 'review' | 'verify'
  verdict: 'pass' | 'fail'
  characterId?: string | null
  messageId?: string | null
  detail?: string | null
}): RoundCheck {
  const check: RoundCheck = {
    id: randomUUID(),
    roomId: input.roomId,
    roundId: input.roundId,
    kind: input.kind,
    verdict: input.verdict,
    characterId: input.characterId ?? null,
    messageId: input.messageId ?? null,
    detail: input.detail ?? null,
    createdAt: now(),
  }
  db.prepare(
    `insert into round_checks (id, room_id, round_id, kind, verdict, character_id, message_id, detail, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    check.id,
    check.roomId,
    check.roundId,
    check.kind,
    check.verdict,
    check.characterId,
    check.messageId,
    check.detail,
    check.createdAt,
  )
  return check
}

/** All gate outcomes of one room, oldest first — the room's SOP audit trail. */
export function listRoundChecks(roomId: string): RoundCheck[] {
  return db
    .prepare('select * from round_checks where room_id = ? order by created_at asc')
    .all(roomId)
    .map(mapRoundCheck)
}

/* ---------------------------------------------------------------- sessions */

function mapSession(row: Record<string, unknown>): Session {
  return {
    roomId: String(row.room_id),
    characterId: String(row.character_id),
    harness: String(row.harness) as HarnessKind,
    model: String(row.model ?? ''),
    sessionId: String(row.session_id),
    consumedAt: Number(row.consumed_at),
    consumedSeq: Number(row.consumed_seq ?? 0),
    turns: Number(row.turns ?? 0),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

/** The CLI session one character rides in one room, if a clean turn left one. */
export function getSession(roomId: string, characterId: string): Session | undefined {
  const row = db.prepare('select * from sessions where room_id = ? and character_id = ?').get(roomId, characterId)
  return row ? mapSession(row) : undefined
}

/**
 * Persist (or replace) a character's CLI session row (session continuity,
 * P0-1). Upsert keyed on (room, character): `turns` counts up on replace, so
 * session-check can assert two rode turns end-to-end. The caller passes the
 * cursor the successful prompt actually consumed — (createdAt, seq) of the
 * newest message it carried, never Date.now() (a message arriving mid-turn
 * must stay AFTER the cursor or the next turn would silently skip it).
 */
export function setSession(input: {
  roomId: string
  characterId: string
  harness: HarnessKind
  model: string
  sessionId: string
  consumedAt: number
  consumedSeq: number
}): Session {
  const at = now()
  db.prepare(
    `insert into sessions (room_id, character_id, harness, model, session_id, consumed_at, consumed_seq, turns, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
     on conflict(room_id, character_id) do update set
       harness = excluded.harness,
       model = excluded.model,
       session_id = excluded.session_id,
       consumed_at = excluded.consumed_at,
       consumed_seq = excluded.consumed_seq,
       turns = sessions.turns + 1,
       updated_at = excluded.updated_at`,
  ).run(
    input.roomId,
    input.characterId,
    input.harness,
    input.model,
    input.sessionId,
    input.consumedAt,
    input.consumedSeq,
    at,
    at,
  )
  const stored = getSession(input.roomId, input.characterId)
  if (!stored) throw new Error('session row missing after upsert')
  return stored
}

/**
 * Drop one character's session row. Called when a resumed run fails (the
 * fallback re-runs on the full transcript and the stale row must not poison
 * it) and on harness/model drift (see updateCharacter).
 */
export function clearSession(roomId: string, characterId: string): void {
  db.prepare('delete from sessions where room_id = ? and character_id = ?').run(roomId, characterId)
}

/* ------------------------------------------------------------------- tasks */

function mapTask(row: Record<string, unknown>): Task {
  const status = String(row.status)
  return {
    id: String(row.id),
    roomId: String(row.room_id),
    title: String(row.title),
    what: String(row.what),
    why: String(row.why ?? ''),
    acceptance: String(row.acceptance ?? ''),
    assigneeId: row.assignee_id === null || row.assignee_id === undefined ? null : String(row.assignee_id),
    status: status === 'running' || status === 'done' || status === 'rejected' ? status : 'proposed',
    createdAt: Number(row.created_at),
    approvedAt: row.approved_at === null || row.approved_at === undefined ? null : Number(row.approved_at),
    doneAt: row.done_at === null || row.done_at === undefined ? null : Number(row.done_at),
    roundId: row.round_id === null || row.round_id === undefined ? null : String(row.round_id),
    result: row.result === null || row.result === undefined ? null : String(row.result),
  }
}

export function getTask(id: string): Task | undefined {
  const row = db.prepare('select * from tasks where id = ?').get(id)
  return row ? mapTask(row) : undefined
}

/** A room's cards, newest first — the panel reads this list. */
export function listTasks(roomId: string): Task[] {
  return db
    .prepare('select * from tasks where room_id = ? order by created_at desc')
    .all(roomId)
    .map(mapTask)
}

export function createTask(input: {
  roomId: string
  title: string
  what: string
  why?: string
  acceptance?: string
  assigneeId?: string | null
}): Task {
  const task: Task = {
    id: randomUUID(),
    roomId: input.roomId,
    title: input.title,
    what: input.what,
    why: input.why ?? '',
    acceptance: input.acceptance ?? '',
    assigneeId: input.assigneeId ?? null,
    status: 'proposed',
    createdAt: now(),
    approvedAt: null,
    doneAt: null,
    roundId: null,
    result: null,
  }
  db.prepare(
    `insert into tasks (id, room_id, title, what, why, acceptance, assignee_id, status, created_at, approved_at, done_at, round_id, result)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, null, null, null, null)`,
  ).run(
    task.id,
    task.roomId,
    task.title,
    task.what,
    task.why,
    task.acceptance,
    task.assigneeId,
    task.status,
    task.createdAt,
  )
  return task
}

/**
 * Field patch for a task card (B03). Transition LEGALITY is the API layer's
 * job — this writes whatever it is given, like updateCharacter.
 */
export function updateTask(
  id: string,
  patch: Partial<Pick<Task, 'title' | 'what' | 'why' | 'acceptance' | 'assigneeId' | 'status' | 'approvedAt' | 'doneAt' | 'roundId' | 'result'>>,
): Task | undefined {
  const current = getTask(id)
  if (!current) return undefined
  const next = { ...current, ...pickDefined(patch) }
  db.prepare(
    `update tasks set title = ?, what = ?, why = ?, acceptance = ?, assignee_id = ?, status = ?,
       approved_at = ?, done_at = ?, round_id = ?, result = ? where id = ?`,
  ).run(
    next.title,
    next.what,
    next.why,
    next.acceptance,
    next.assigneeId,
    next.status,
    next.approvedAt,
    next.doneAt,
    next.roundId,
    next.result,
    id,
  )
  return next
}

/**
 * Round settlement write-back (B03): the round a card opened has closed.
 * `done` closes the card; `blocked` (SOP gate refused) and `error` (the
 * round's last turn errored/was stopped, B03 review 2) keep it `running`
 * with the verdict as `result` so the panel offers a re-dispatch. The
 * round_id match is the identity check: a re-dispatched card points at a
 * NEWER round, and the old round's late settlement must not overwrite it.
 */
export function settleTaskByRound(roundId: string, outcome: 'done' | 'blocked' | 'error'): void {
  if (outcome === 'done') {
    db.prepare(
      "update tasks set status = 'done', result = null, done_at = ? where round_id = ? and status in ('approved', 'running')",
    ).run(now(), roundId)
  } else {
    db.prepare(
      "update tasks set status = 'running', result = ?, done_at = null where round_id = ? and status in ('approved', 'running')",
    ).run(outcome, roundId)
  }
}

/* -------------------------------------------------------------- identities */

function mapIdentity(row: Record<string, unknown>): Identity {
  return {
    id: String(row.id),
    name: String(row.name),
    avatar: String(row.avatar ?? '🤖'),
    color: String(row.color ?? '#8b76f6'),
    persona: String(row.persona ?? ''),
    createdAt: Number(row.created_at),
  }
}

export function getIdentity(id: string): Identity | undefined {
  const row = db.prepare('select * from identities where id = ?').get(id)
  return row ? mapIdentity(row) : undefined
}

/**
 * "Same name = same identity": the anchor is created on first sight so every
 * character called e.g. "开发者" in every room shares one memory owner.
 */
export function getOrCreateIdentity(
  name: string,
  seed: { avatar?: string; color?: string; persona?: string } = {},
): Identity {
  const trimmed = name.trim() || '未命名'
  const existing = db.prepare('select * from identities where name = ?').get(trimmed)
  if (existing) return mapIdentity(existing)
  const identity: Identity = {
    id: randomUUID(),
    name: trimmed,
    avatar: seed.avatar?.trim() || '🤖',
    color: seed.color?.trim() || '#8b76f6',
    persona: seed.persona ?? '',
    createdAt: now(),
  }
  db.prepare('insert into identities (id, name, avatar, color, persona, created_at) values (?, ?, ?, ?, ?, ?)').run(
    identity.id,
    identity.name,
    identity.avatar,
    identity.color,
    identity.persona,
    identity.createdAt,
  )
  return identity
}

/**
 * Bind a character to its identity (idempotent): returns the identity and,
 * on first call, persists the binding. Called before every turn so a renamed
 * character keeps its memories — the anchor follows the row, not the name.
 */
export function ensureIdentityForCharacter(character: Character): Identity {
  if (character.identityId) {
    const existing = getIdentity(character.identityId)
    if (existing) return existing
  }
  const identity = getOrCreateIdentity(character.name, {
    avatar: character.avatar,
    color: character.color,
  })
  db.prepare('update characters set identity_id = ? where id = ?').run(identity.id, character.id)
  character.identityId = identity.id
  return identity
}

/* ---------------------------------------------------------------- memories */

const MEMORY_KINDS = new Set<MemoryKind>(['fact', 'decision', 'preference', 'episode', 'lesson'])

function mapMemory(row: Record<string, unknown>): Memory {
  const kind = String(row.kind) as MemoryKind
  const scope = String(row.scope) as MemoryScope
  return {
    id: String(row.id),
    scope: scope === 'room' ? 'room' : 'identity',
    ownerId: String(row.owner_id),
    kind: MEMORY_KINDS.has(kind) ? kind : 'fact',
    content: String(row.content),
    sourceRoomId: row.source_room_id === null || row.source_room_id === undefined ? null : String(row.source_room_id),
    pinned: Number(row.pinned ?? 0) === 1,
    useCount: Number(row.use_count ?? 0),
    createdAt: Number(row.created_at),
    lastUsedAt: row.last_used_at === null || row.last_used_at === undefined ? null : Number(row.last_used_at),
  }
}

export function listMemories(scope: MemoryScope, ownerId: string, limit = 200): Memory[] {
  return db
    .prepare(
      'select * from memories where scope = ? and owner_id = ? order by pinned desc, created_at desc limit ?',
    )
    .all(scope, ownerId, Math.min(500, Math.max(1, limit)))
    .map(mapMemory)
}

export function getMemory(id: string): Memory | undefined {
  const row = db.prepare('select * from memories where id = ?').get(id)
  return row ? mapMemory(row) : undefined
}

/**
 * Add one memory. Exact-duplicate content (same scope+owner) is a no-op that
 * returns the existing entry with `existed: true`, so "记住" buttons and the
 * automatic extraction can't pile up copies. B04: a `contentHash` (the
 * automatic episode's sha256) is checked FIRST — same-facts rounds dedupe
 * before content even enters the picture.
 */
export function addMemory(input: {
  scope: MemoryScope
  ownerId: string
  kind?: MemoryKind
  content: string
  sourceRoomId?: string | null
  pinned?: boolean
  contentHash?: string | null
}): { memory: Memory; existed: boolean } {
  // Truncate BEFORE the duplicate check: the insert stores the truncated
  // text, so deduping on the raw content made a >500-char message insert a
  // second copy on the second "记住" click (the stored row never matched).
  const content = truncateText(input.content.trim(), 500)
  if (!content) throw new Error('记忆内容不能为空')
  const contentHash = input.contentHash ? input.contentHash : null
  if (contentHash) {
    const byHash = db
      .prepare('select * from memories where scope = ? and owner_id = ? and content_hash = ?')
      .get(input.scope, input.ownerId, contentHash)
    if (byHash) return { memory: mapMemory(byHash), existed: true }
  }
  const duplicate = db
    .prepare('select * from memories where scope = ? and owner_id = ? and content = ?')
    .get(input.scope, input.ownerId, content)
  if (duplicate) return { memory: mapMemory(duplicate), existed: true }
  const memory: Memory = {
    id: randomUUID(),
    scope: input.scope,
    ownerId: input.ownerId,
    kind: MEMORY_KINDS.has(input.kind as MemoryKind) ? (input.kind as MemoryKind) : 'fact',
    content: truncateText(content, 500),
    sourceRoomId: input.sourceRoomId ?? null,
    pinned: input.pinned ?? false,
    useCount: 0,
    createdAt: now(),
    lastUsedAt: null,
  }
  db.prepare(
    `insert into memories (id, scope, owner_id, kind, content, source_room_id, pinned, use_count, created_at, last_used_at, content_hash)
     values (?, ?, ?, ?, ?, ?, ?, 0, ?, null, ?)`,
  ).run(
    memory.id,
    memory.scope,
    memory.ownerId,
    memory.kind,
    memory.content,
    memory.sourceRoomId,
    memory.pinned ? 1 : 0,
    memory.createdAt,
    contentHash,
  )
  return { memory, existed: false }
}

/**
 * Record one clean-closed round as a room-scope episode (B04): content
 * assembled by buildRoundEpisode, deduped by its sha256. A no-op returns
 * `existed: true` — repeat rounds with identical facts add nothing.
 */
export function addRoundEpisode(facts: RoundEpisodeFacts): { memory: Memory; existed: boolean } {
  const { content, hash } = buildRoundEpisode(facts)
  return addMemory({
    scope: 'room',
    ownerId: facts.roomId,
    kind: 'episode',
    content,
    sourceRoomId: facts.roomId,
    contentHash: hash,
  })
}

/**
 * Record one failure lesson (B08) and keep only the latest one pinned: the
 * next turn always sees the most recent root cause, while older lessons stay
 * in the room's memory list (searchable, but no longer crowding the prompt).
 * The pinned flag is what guarantees injection — the room's memory budget
 * only limits unpinned entries.
 *
 * A repeated cause (A → B → A) hits the old row by content hash, so the hit
 * itself must be re-pinned and the newer B unpinned; skipping that would keep
 * injecting B after A happened again.
 */
export function addFailureEpisode(input: {
  roomId: string
  cause: string
  changedPaths?: string[]
}): { memory: Memory; existed: boolean } {
  const { content, hash } = buildFailureEpisode(input)
  const result = addMemory({
    scope: 'room',
    ownerId: input.roomId,
    kind: 'lesson',
    content,
    sourceRoomId: input.roomId,
    contentHash: hash,
    pinned: true,
  })
  let memory = result.memory
  if (result.existed && !memory.pinned) {
    db.prepare('update memories set pinned = 1 where id = ?').run(memory.id)
    memory = { ...memory, pinned: true }
  }
  db.prepare(
    `update memories set pinned = 0
     where scope = 'room' and owner_id = ? and kind = 'lesson' and pinned = 1
       and id <> ? and content like ?`,
  ).run(input.roomId, memory.id, `${FAILURE_LESSON_PREFIX}%`)
  return { memory, existed: result.existed }
}

/**
 * Search a memory scope with the raw query (B04): ≥3-code-point terms go to
 * the trigram FTS index, shorter ones to LIKE (with escaping) — the union,
 * FTS order first. Exported for prompt-check. An empty/short-to-nothing
 * query yields [] without touching the indexes.
 */
export function searchMemoryIds(
  scope: MemoryScope,
  ownerId: string,
  rawQuery: string | null | undefined,
  limit = 100,
): string[] {
  const plan = planMemoryQuery(rawQuery)
  if (!plan) return []
  const ids: string[] = []
  const seen = new Set<string>()
  let ftsRan = false
  if (memoryFts && plan.ftsTerms.length > 0) {
    try {
      const match = plan.ftsTerms.map(ftsQuote).join(' ')
      const rows = db
        .prepare(
          `select m.id as id from memories_fts f join memories m on m.rowid = f.rowid
           where memories_fts match ? and m.scope = ? and m.owner_id = ?
           order by bm25(memories_fts), m.pinned desc, m.created_at desc limit ?`,
        )
        .all(match, scope, ownerId, limit) as { id: string }[]
      for (const row of rows) {
        if (!seen.has(row.id)) {
          seen.add(row.id)
          ids.push(row.id)
        }
      }
      ftsRan = true
    } catch (error) {
      // A broken index must not take retrieval down with it — LIKE still runs.
      console.warn(
        `[agent-crowd] memory FTS query failed, LIKE only: ${error instanceof Error ? error.message : error}`,
      )
    }
  }
  // B04 review 1: when the FTS leg never ran (index off at startup, or its
  // query just threw), the long terms DEGRADE to LIKE — silently dropping
  // them is how "续传游标" became unfindable with FTS disabled. When FTS did
  // run, its terms had their chance and stay out of the LIKE leg.
  const likeTerms = ftsRan ? plan.likeTerms : [...new Set([...plan.likeTerms, ...plan.ftsTerms])]
  if (likeTerms.length > 0) {
    const clauses = likeTerms.map(() => "content like ? escape '\\'").join(' or ')
    const rows = db
      .prepare(
        `select id from memories where scope = ? and owner_id = ? and (${clauses})
         order by pinned desc, created_at desc limit ?`,
      )
      .all(scope, ownerId, ...likeTerms.map((term) => `%${escapeLike(term)}%`), limit) as { id: string }[]
    for (const row of rows) {
      if (!seen.has(row.id)) {
        seen.add(row.id)
        ids.push(row.id)
      }
    }
  }
  return ids
}

export function updateMemory(
  id: string,
  patch: { content?: string; kind?: MemoryKind; pinned?: boolean },
): Memory | undefined {
  const raw = db.prepare('select * from memories where id = ?').get(id) as Record<string, unknown> | undefined
  const current = raw ? mapMemory(raw) : undefined
  if (!current || !raw) return undefined
  const next: Memory = {
    ...current,
    content: patch.content !== undefined ? truncateText(patch.content.trim(), 500) || current.content : current.content,
    kind: patch.kind !== undefined && MEMORY_KINDS.has(patch.kind) ? patch.kind : current.kind,
    pinned: patch.pinned ?? current.pinned,
  }
  // Editing the content means a human took over this memory (B04): its hash
  // stops matching the automatic episode, so future rounds with the same
  // facts write their own entry instead of silently no-oping against the
  // edited row. Pinned/kind edits keep the hash. The comparison runs on the
  // FINAL content: a whitespace-only patch falls back to the old value and
  // must not null the hash (B04 review, non-blocking 4).
  const contentChanged = next.content !== current.content
  const keptHash = typeof raw.content_hash === 'string' ? raw.content_hash : null
  db.prepare(`update memories set content = ?, kind = ?, pinned = ?, content_hash = ? where id = ?`).run(
    next.content,
    next.kind,
    next.pinned ? 1 : 0,
    contentChanged ? null : keptHash,
    id,
  )
  return next
}

export function deleteMemory(id: string): void {
  db.prepare('delete from memories where id = ?').run(id)
}

/** Mark memories as used this turn, for later eviction/ranking. */
export function touchMemories(ids: string[]): void {
  if (ids.length === 0) return
  const statement = db.prepare('update memories set use_count = use_count + 1, last_used_at = ? where id = ?')
  const at = now()
  for (const id of ids) statement.run(at, id)
}

/**
 * Pick which memories make it into the prompt: pinned entries always ride
 * along, the rest fill the remaining budget newest-first. Hard budgets keep
 * memory from crowding out the transcript (see docs/memory-plan.md).
 *
 * B04 retrieval ranking (optional `query`): pinned (recency) → search hits
 * (FTS/LIKE order) → the rest (recency). Hits outside the `listMemories`
 * window are dropped rather than re-queried — the recency list is the
 * universe. No query = the pre-B04 behavior, verbatim.
 */
export function pickMemoriesForPrompt(
  identityId: string | null,
  roomId: string,
  budgets: { identity: number; room: number } = { identity: 1_200, room: 800 },
  query?: string | null,
): { identity: Memory[]; room: Memory[] } {
  const pick = (scope: MemoryScope, ownerId: string, budget: number, rawQuery: string | null | undefined): Memory[] => {
    if (!ownerId) return []
    const all = listMemories(scope, ownerId)
    let ranked = all
    if (rawQuery !== undefined && rawQuery !== null) {
      const hitIds = new Set(searchMemoryIds(scope, ownerId, rawQuery))
      const pinned = all.filter((memory) => memory.pinned)
      const unpinned = all.filter((memory) => !memory.pinned)
      const hits = unpinned.filter((memory) => hitIds.has(memory.id))
      const rest = unpinned.filter((memory) => !hitIds.has(memory.id))
      ranked = [...pinned, ...hits, ...rest]
    }
    const chosen: Memory[] = []
    let used = 0
    for (const memory of ranked) {
      // ranked is pinned-first already; only stop skipping once past the pinned block
      if (!memory.pinned && used + memory.content.length > budget) continue
      chosen.push(memory)
      used += memory.content.length
      if (used > budget + 4_000) break
    }
    return chosen
  }
  return {
    identity: identityId ? pick('identity', identityId, budgets.identity, query) : [],
    room: pick('room', roomId, budgets.room, query),
  }
}

function truncateText(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text
}

/* ------------------------------------------------------------------- meta */

function getMeta(key: string): string | null {
  const row = db.prepare('select value from meta where key = ?').get(key) as { value?: string } | undefined
  return row?.value ?? null
}

function setMeta(key: string, value: string): void {
  db.prepare('insert into meta (key, value) values (?, ?) on conflict(key) do update set value = excluded.value').run(
    key,
    value,
  )
}

/* ---------------------------------------------------------- character lib */

function mapPreset(row: Record<string, unknown>): CharacterPreset {
  const name = String(row.name)
  return {
    id: String(row.id),
    name,
    aliases: sanitizeAliases(parseAliases(row.aliases), name),
    avatar: String(row.avatar ?? '🤖'),
    color: String(row.color ?? '#8b76f6'),
    harness: String(row.harness) as HarnessKind,
    model: String(row.model ?? ''),
    persona: String(row.persona ?? ''),
    cwd: String(row.cwd ?? ''),
    triggers: parseTriggers(row.triggers),
    commandTemplate: String(row.command_template ?? ''),
    autoApprove: Number(row.auto_approve ?? 1) === 1,
    createdAt: Number(row.created_at),
  }
}

export interface PresetInput {
  name: string
  aliases?: string[]
  avatar?: string
  color?: string
  harness?: HarnessKind
  model?: string
  persona?: string
  cwd?: string
  triggers?: Partial<Triggers>
  commandTemplate?: string
  autoApprove?: boolean
}

export function listPresets(): CharacterPreset[] {
  return db.prepare('select * from character_presets order by created_at asc, rowid asc').all().map(mapPreset)
}

export function countPresets(): number {
  const row = db.prepare('select count(*) as c from character_presets').get() as { c: number } | undefined
  return Number(row?.c ?? 0)
}

export function getPreset(id: string): CharacterPreset | undefined {
  const row = db.prepare('select * from character_presets where id = ?').get(id)
  return row ? mapPreset(row) : undefined
}

export function createPreset(input: PresetInput): CharacterPreset {
  const name = input.name.trim() || '新角色'
  const preset: CharacterPreset = {
    id: randomUUID(),
    name,
    aliases: sanitizeAliases(input.aliases, name),
    avatar: input.avatar?.trim() || '🤖',
    color: input.color?.trim() || '#8b76f6',
    harness: input.harness ?? 'mock',
    model: input.model?.trim() ?? '',
    persona: input.persona ?? '',
    cwd: input.cwd?.trim() ?? '',
    triggers: { ...DEFAULT_TRIGGERS, ...input.triggers },
    commandTemplate: input.commandTemplate ?? '',
    autoApprove: input.autoApprove ?? true,
    createdAt: now(),
  }
  db.prepare(
    `insert into character_presets
       (id, name, aliases, avatar, color, harness, model, persona, cwd, triggers, command_template, auto_approve, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    preset.id,
    preset.name,
    JSON.stringify(preset.aliases),
    preset.avatar,
    preset.color,
    preset.harness,
    preset.model,
    preset.persona,
    preset.cwd,
    JSON.stringify(preset.triggers),
    preset.commandTemplate,
    preset.autoApprove ? 1 : 0,
    preset.createdAt,
  )
  return preset
}

export function updatePreset(id: string, patch: Partial<PresetInput>): CharacterPreset | undefined {
  const current = getPreset(id)
  if (!current) return undefined
  const nextName = patch.name?.trim() || current.name
  const next: CharacterPreset = {
    ...current,
    ...pickDefined({
      avatar: patch.avatar?.trim(),
      color: patch.color?.trim(),
      harness: patch.harness,
      model: patch.model?.trim(),
      persona: patch.persona,
      cwd: patch.cwd?.trim(),
      commandTemplate: patch.commandTemplate,
      autoApprove: patch.autoApprove,
    }),
    name: nextName,
    aliases:
      patch.aliases === undefined
        ? current.aliases.filter((alias) => alias !== nextName)
        : sanitizeAliases(patch.aliases, nextName),
    triggers: patch.triggers ? { ...current.triggers, ...patch.triggers } : current.triggers,
  }
  db.prepare(
    `update character_presets set name = ?, aliases = ?, avatar = ?, color = ?, harness = ?, model = ?, persona = ?,
       cwd = ?, triggers = ?, command_template = ?, auto_approve = ? where id = ?`,
  ).run(
    next.name,
    JSON.stringify(next.aliases),
    next.avatar,
    next.color,
    next.harness,
    next.model,
    next.persona,
    next.cwd,
    JSON.stringify(next.triggers),
    next.commandTemplate,
    next.autoApprove ? 1 : 0,
    id,
  )
  return next
}

export function deletePreset(id: string): void {
  db.prepare('delete from character_presets where id = ?').run(id)
}

/** Copy a library template into a room, resolving name-based triggers to ids. */
export function createCharacterFromPreset(preset: CharacterPreset, roomId: string): Character {
  const members = listCharacters(roomId)
  const ids = preset.triggers.onCharacterNames
    .map((name) => members.find((member) => member.name === name)?.id)
    .filter((id): id is string => Boolean(id))
  return createCharacter({
    roomId,
    name: preset.name,
    aliases: preset.aliases,
    avatar: preset.avatar,
    color: preset.color,
    harness: preset.harness,
    model: preset.model,
    persona: preset.persona,
    cwd: preset.cwd,
    triggers: { ...preset.triggers, onCharacters: ids },
    commandTemplate: preset.commandTemplate,
    autoApprove: preset.autoApprove,
    presetId: preset.id,
  })
}

/** Add presets to a room in order, skipping names the room already has. */
export function addPresetsToRoom(
  roomId: string,
  presetIds: string[],
): { created: Character[]; skipped: string[] } {
  const created: Character[] = []
  const skipped: string[] = []
  const existing = new Set(listCharacters(roomId).map((character) => character.name))
  for (const id of presetIds) {
    const preset = getPreset(id)
    if (!preset) {
      skipped.push(`未知角色 ${id}`)
      continue
    }
    if (existing.has(preset.name)) {
      skipped.push(preset.name)
      continue
    }
    let character: Character
    try {
      character = createCharacterFromPreset(preset, roomId)
    } catch (error) {
      // One conflicting (or unhighlightable) template shouldn't sink the
      // whole batch import.
      if (error instanceof CallNameConflictError || error instanceof InvalidCallNameError) {
        skipped.push(`${preset.name}（${error.message}）`)
        continue
      }
      throw error
    }
    created.push(character)
    existing.add(character.name)
  }
  return { created, skipped }
}

/**
 * Re-align a room character with the library template it was copied from.
 * The template owns looks/persona/harness/model/triggers; room-local state
 * (enabled, identity binding, message history) is left untouched. Name-based
 * relay rules are resolved against this room again, exactly like an import.
 */
export function syncCharacterFromPreset(character: Character, preset: CharacterPreset): Character {
  const members = listCharacters(character.roomId)
  const ids = preset.triggers.onCharacterNames
    .map((name) => members.find((member) => member.id !== character.id && member.name === name)?.id)
    .filter((id): id is string => Boolean(id))
  const next = updateCharacter(character.id, {
    name: preset.name,
    aliases: preset.aliases,
    avatar: preset.avatar,
    color: preset.color,
    harness: preset.harness,
    model: preset.model,
    persona: preset.persona,
    cwd: preset.cwd,
    triggers: { ...preset.triggers, onCharacters: ids },
    commandTemplate: preset.commandTemplate,
    autoApprove: preset.autoApprove,
  })
  if (!next) throw new Error('角色不存在')
  db.prepare('update characters set preset_id = ? where id = ?').run(preset.id, character.id)
  return { ...next, presetId: preset.id }
}

/** Snapshot a room character into a portable library template. */
function characterToPreset(character: Character, members: Character[]): PresetInput {
  const names = character.triggers.onCharacters
    .map((id) => members.find((member) => member.id === id)?.name)
    .filter((name): name is string => Boolean(name))
  return {
    name: character.name,
    aliases: character.aliases,
    avatar: character.avatar,
    color: character.color,
    harness: character.harness,
    model: character.model,
    persona: character.persona,
    cwd: character.cwd,
    triggers: {
      ...character.triggers,
      onCharacters: [],
      onCharacterNames: [...new Set([...character.triggers.onCharacterNames, ...names])],
    },
    commandTemplate: character.commandTemplate,
    autoApprove: character.autoApprove,
  }
}

/* ------------------------------------------------------------------- seed */

/**
 * Default character library, captured verbatim from the live library on
 * 2026-11-15 (avatars: server/seed/*.png). Re-capture here if the defaults
 * should follow a future library edit. GLM keeps the old 开发者 template's
 * AC_SEED_DEV_MODEL hook (README: 示例房间实现角色的模型).
 */
function builtinPresets(): PresetInput[] {
  const avatars = loadSeedAvatars()
  return [
    {
      name: 'GLM',
      avatar: avatars.glm,
      color: '#000000',
      harness: 'cannbot',
      model: process.env.AC_SEED_DEV_MODEL ?? 'cannbot/glm-5.3',
      persona: [
        '你是一名严谨的全栈工程师，负责在项目目录里把需求实现出来。',
        '你偏好小步提交：先读代码、再改、最后自己验证。',
        '完成后用中文简要汇报：改了哪些文件、怎么验证的、还有什么风险。',
      ].join('\n'),
      triggers: { onUser: true },
    },
    {
      name: 'DeepSeek',
      avatar: avatars.deepseek,
      color: '#4f9cf9',
      harness: 'dsh',
      model: 'deepseek-flash',
      persona: [
        '你是一名资深代码审查者，只做 review，不直接改代码。',
        '看到开发者的完成汇报后，主动去读相关文件，检查正确性、边界情况、可维护性。',
        '输出结构化的 review：先说结论（通过 / 需修改），再列具体问题（文件:行 + 原因 + 建议），最后给一句总体评价。',
        '如果没有发现问题，也要说明你检查了哪些点。',
      ].join('\n'),
      // Mention-only by design (the old 审查者 auto-followed 开发者): review
      // is invoked with an explicit `@DeepSeek`, as in the captured library.
      triggers: { onUser: false, mention: true },
    },
    {
      name: 'Qwen',
      avatar: avatars.qwen,
      color: '#2dd4bf',
      harness: 'cannbot',
      model: 'cannbot/qwen3.8-max',
      persona:
        '你是团队里的全能助手，擅长查资料、跑命令、整理结论。被 @ 时响应；每轮对话结束后，你会作为轮值总结者发一条本轮总结（做了什么、遗留了什么）。',
      // Per-round summarizer: every cleanly-closed round ends with a Qwen
      // summary (orchestrator round drain). Side effect to remember: the SOP
      // gate excludes round summarizers from reviewer eligibility.
      triggers: { onUser: false, mention: true, onRoundEnd: true },
    },
    {
      name: 'Claude',
      aliases: ['克劳德'],
      avatar: avatars.claude,
      color: '#f97316',
      harness: 'claude',
      model: '',
      persona: '你是团队里的全能助手，擅长查资料、跑命令、整理结论。只在被 @ 时发言。',
      triggers: { onUser: true },
    },
    {
      name: 'GPT',
      avatar: avatars.gpt,
      color: '#ffffff',
      harness: 'codex',
      model: '',
      persona: '你是团队里的全能助手，擅长查资料、跑命令、整理结论。只在被 @ 时发言。',
      triggers: { onUser: true },
    },
  ]
}

/** Seed the character library once, deriving templates from existing rooms if any. */
export function ensurePresets(): void {
  if (getMeta('presets_seeded') === '1') return
  if (countPresets() > 0) {
    setMeta('presets_seeded', '1')
    return
  }

  const characters = listAllCharacters()
  if (characters.length === 0) {
    for (const preset of builtinPresets()) createPreset(preset)
  } else {
    const seen = new Set<string>()
    for (const character of characters) {
      if (seen.has(character.name)) continue
      const members = listCharacters(character.roomId)
      const preset = createPreset(characterToPreset(character, members))
      seen.add(preset.name)
    }
  }
  setMeta('presets_seeded', '1')
}

/** Backfill name-based trigger references for characters created before they existed. */
export function backfillTriggerNames(): void {
  if (getMeta('trigger_names_backfilled') === '1') return
  for (const character of listAllCharacters()) {
    if (character.triggers.onCharacters.length === 0) continue
    if (character.triggers.onCharacterNames.length > 0) continue
    const members = listCharacters(character.roomId)
    const names = character.triggers.onCharacters
      .map((id) => members.find((member) => member.id === id)?.name)
      .filter((name): name is string => Boolean(name))
    if (names.length > 0) {
      updateCharacter(character.id, { triggers: { ...character.triggers, onCharacterNames: names } })
    }
  }
  setMeta('trigger_names_backfilled', '1')
}

/**
 * One-time pass over existing characters to bind each of them to an identity
 * (same name = same identity), so cross-room memory starts working for data
 * that predates the identities table.
 */
export function backfillIdentities(): void {
  if (getMeta('identities_backfilled') === '1') return
  for (const character of listAllCharacters()) {
    if (character.identityId && getIdentity(character.identityId)) continue
    ensureIdentityForCharacter(character)
  }
  setMeta('identities_backfilled', '1')
}

export function seedIfEmpty(defaultWorkingDir: string): void {
  ensurePresets()
  backfillTriggerNames()
  backfillIdentities()

  const existing = db.prepare('select count(*) as c from rooms').get() as { c: number }
  if (Number(existing.c) > 0) return

  const room = createRoom({
    name: '开发小队',
    topic: '提需求 → GLM 实现 → DeepSeek review',
    workingDir: defaultWorkingDir,
    maxHops: 6,
  })

  for (const preset of listPresets()) {
    createCharacterFromPreset(preset, room.id)
  }

  addMessage({
    roomId: room.id,
    authorType: 'system',
    authorName: '系统',
    content:
      '房间已创建。没人被 @ 时由第一个启用的角色 GLM（CANNBot / glm-5.3）接手；`@DeepSeek` 点名 review，`@Qwen`、`@Claude`、`@GPT` 也在待命（`@克劳德` 是 Claude 的别名）；每轮对话干净收尾后，Qwen 会自动发一条本轮总结，review 通过的代码改动会由系统自动提交到工作目录所在的 git 仓库（push 始终等你确认）。这些角色都来自「角色库」，可以先去角色库统一维护，再一键加进新房间。',
    meta: { generated: true },
  })
}
