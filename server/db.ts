import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DATA_DIR } from './paths.ts'
import { DEFAULT_TRIGGERS,
  type AuthorType,
  type Character,
  type CharacterPreset,
  type HarnessKind,
  type Identity,
  type Memory,
  type MemoryKind,
  type MemoryScope,
  type Message,
  type MessageMeta,
  type Room,
  type Triggers,
  type Turn,
  type TurnStatus,
} from './types.ts'
import { pickDefined } from './util.ts'

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
    started_at integer not null,
    ended_at integer
  );

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
    last_used_at integer
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
// Persisted so the boot sweep can taskkill CLI trees orphaned by a hard kill.
addColumnIfMissing('turns', 'pid', 'pid integer')

const now = () => Date.now()

/* ------------------------------------------------------------------ rooms */

function mapRoom(row: Record<string, unknown>): Room {
  return {
    id: String(row.id),
    name: String(row.name),
    topic: String(row.topic ?? ''),
    workingDir: String(row.working_dir),
    maxHops: Number(row.max_hops ?? 6),
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
}): Room {
  const room: Room = {
    id: randomUUID(),
    name: input.name.trim() || '未命名房间',
    topic: input.topic?.trim() ?? '',
    workingDir: input.workingDir,
    maxHops: clampHops(input.maxHops),
    createdAt: now(),
  }
  db.prepare(
    'insert into rooms (id, name, topic, working_dir, max_hops, created_at) values (?, ?, ?, ?, ?, ?)',
  ).run(room.id, room.name, room.topic, room.workingDir, room.maxHops, room.createdAt)
  return room
}

export function updateRoom(id: string, patch: Partial<Pick<Room, 'name' | 'topic' | 'workingDir' | 'maxHops'>>): Room | undefined {
  const current = getRoom(id)
  if (!current) return undefined
  const next: Room = {
    ...current,
    ...pickDefined(patch),
    maxHops: patch.maxHops === undefined ? current.maxHops : clampHops(patch.maxHops),
  }
  db.prepare('update rooms set name = ?, topic = ?, working_dir = ?, max_hops = ? where id = ?').run(
    next.name,
    next.topic,
    next.workingDir,
    next.maxHops,
    id,
  )
  return next
}

export function deleteRoom(id: string): void {
  db.prepare('delete from messages where room_id = ?').run(id)
  db.prepare('delete from turns where room_id = ?').run(id)
  db.prepare('delete from characters where room_id = ?').run(id)
  db.prepare("delete from memories where scope = 'room' and owner_id = ?").run(id)
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
 */
function sanitizeAliases(input: unknown, name: string): string[] {
  if (!Array.isArray(input)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const entry of input) {
    const item = String(entry).trim().replace(/^@+/, '').replace(/\s+/g, ' ').trim().slice(0, 32)
    if (!item || item === name || seen.has(item)) continue
    if (RESERVED_ALIASES.has(item.toLowerCase())) continue
    seen.add(item)
    out.push(item)
    if (out.length >= 8) break
  }
  return out
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
    createdAt: Number(row.created_at),
  }
}

export function listCharacters(roomId: string): Character[] {
  return db
    .prepare('select * from characters where room_id = ? order by created_at asc')
    .all(roomId)
    .map(mapCharacter)
}

export function listAllCharacters(): Character[] {
  return db.prepare('select * from characters order by created_at asc').all().map(mapCharacter)
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
}

export function createCharacter(input: CharacterInput): Character {
  const name = input.name.trim() || '新角色'
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
    createdAt: now(),
  }
  // Ambiguous call-names would make @mentions wake the wrong character.
  assertCallNamesFree(input.roomId, null, character.name, character.aliases)
  db.prepare(
    `insert into characters
       (id, room_id, name, aliases, avatar, color, harness, model, persona, cwd, triggers, command_template, auto_approve, enabled, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
  }
  // Only police call-names when they actually change: rooms with legacy
  // duplicate names (created before the check existed) stay editable for
  // unrelated fields instead of failing every PATCH.
  const callNamesChanged =
    next.name !== current.name || JSON.stringify(next.aliases) !== JSON.stringify(current.aliases)
  if (callNamesChanged) assertCallNamesFree(current.roomId, id, next.name, next.aliases)
  db.prepare(
    `update characters set name = ?, aliases = ?, avatar = ?, color = ?, harness = ?, model = ?, persona = ?,
       cwd = ?, triggers = ?, command_template = ?, auto_approve = ?, enabled = ? where id = ?`,
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
    id,
  )

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
  }
}

export function listMessages(roomId: string, limit = 200): Message[] {
  const rows = db
    .prepare('select * from messages where room_id = ? order by created_at desc, rowid desc limit ?')
    .all(roomId, Math.min(2000, Math.max(1, limit)))
  return rows.map(mapMessage).reverse()
}

export function countMessages(roomId: string): number {
  const row = db.prepare('select count(*) as c from messages where room_id = ?').get(roomId) as
    | { c: number }
    | undefined
  return Number(row?.c ?? 0)
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
  }
  db.prepare(
    `insert into messages (id, room_id, author_type, character_id, author_name, author_avatar, color, content, meta, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
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
  return message
}

export function clearMessages(roomId: string): void {
  db.prepare('delete from messages where room_id = ?').run(roomId)
  db.prepare('delete from turns where room_id = ?').run(roomId)
}

/* ------------------------------------------------------------------ turns */

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
    startedAt: Number(row.started_at),
    endedAt: row.ended_at === null ? null : Number(row.ended_at),
  }
}

export function createTurn(input: {
  roomId: string
  characterId: string
  triggerMessageId: string | null
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
    startedAt: now(),
    endedAt: null,
  }
  db.prepare(
    'insert into turns (id, room_id, character_id, status, trigger_message_id, output, error, started_at, ended_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(turn.id, turn.roomId, turn.characterId, turn.status, turn.triggerMessageId, '', null, turn.startedAt, null)
  return turn
}

export function updateTurn(
  id: string,
  patch: Partial<Pick<Turn, 'status' | 'output' | 'error' | 'endedAt'>>,
): void {
  const current = db.prepare('select * from turns where id = ?').get(id)
  if (!current) return
  const turn = mapTurn(current)
  const next = { ...turn, ...pickDefined(patch) }
  db.prepare('update turns set status = ?, output = ?, error = ?, ended_at = ? where id = ?').run(
    next.status,
    next.output,
    next.error,
    next.endedAt,
    id,
  )
}

export function listRunningTurns(roomId: string): Turn[] {
  return db
    .prepare("select * from turns where room_id = ? and status in ('queued','running') order by started_at asc")
    .all(roomId)
    .map(mapTurn)
}

/** Persist the CLI pid on the turn row the moment it spawns (boot sweep handle). */
export function setTurnPid(id: string, pid: number): void {
  db.prepare('update turns set pid = ? where id = ?').run(pid, id)
}

/**
 * Boot-time sweep: a hard-killed server (tsx watch reload, crash, reboot)
 * runs no exit hooks, so turns stay 'queued'/'running' in the DB forever and
 * their CLI process trees survive as orphans the stop button can no longer
 * reach. Mark them interrupted and hand the persisted pids back so the
 * caller can taskkill the orphaned trees.
 */
export function recoverInterruptedTurns(): { roomId: string; characterId: string; pid: number | null }[] {
  const stale = db
    .prepare("select * from turns where status in ('queued','running')")
    .all()
    .map(mapTurn)
  if (stale.length === 0) return []
  db.prepare(
    "update turns set status = 'error', error = coalesce(error, '服务器重启，回合中断'), ended_at = ? where status in ('queued','running')",
  ).run(now())
  return stale.map((turn) => ({ roomId: turn.roomId, characterId: turn.characterId, pid: turn.pid }))
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

const MEMORY_KINDS = new Set<MemoryKind>(['fact', 'decision', 'preference', 'episode'])

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
 * future automatic extraction can't pile up copies.
 */
export function addMemory(input: {
  scope: MemoryScope
  ownerId: string
  kind?: MemoryKind
  content: string
  sourceRoomId?: string | null
  pinned?: boolean
}): { memory: Memory; existed: boolean } {
  // Truncate BEFORE the duplicate check: the insert stores the truncated
  // text, so deduping on the raw content made a >500-char message insert a
  // second copy on the second "记住" click (the stored row never matched).
  const content = truncateText(input.content.trim(), 500)
  if (!content) throw new Error('记忆内容不能为空')
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
    `insert into memories (id, scope, owner_id, kind, content, source_room_id, pinned, use_count, created_at, last_used_at)
     values (?, ?, ?, ?, ?, ?, ?, 0, ?, null)`,
  ).run(
    memory.id,
    memory.scope,
    memory.ownerId,
    memory.kind,
    memory.content,
    memory.sourceRoomId,
    memory.pinned ? 1 : 0,
    memory.createdAt,
  )
  return { memory, existed: false }
}

export function updateMemory(
  id: string,
  patch: { content?: string; kind?: MemoryKind; pinned?: boolean },
): Memory | undefined {
  const current = getMemory(id)
  if (!current) return undefined
  const next: Memory = {
    ...current,
    content: patch.content !== undefined ? truncateText(patch.content.trim(), 500) || current.content : current.content,
    kind: patch.kind !== undefined && MEMORY_KINDS.has(patch.kind) ? patch.kind : current.kind,
    pinned: patch.pinned ?? current.pinned,
  }
  db.prepare('update memories set content = ?, kind = ?, pinned = ? where id = ?').run(
    next.content,
    next.kind,
    next.pinned ? 1 : 0,
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
 */
export function pickMemoriesForPrompt(
  identityId: string | null,
  roomId: string,
  budgets: { identity: number; room: number } = { identity: 1_200, room: 800 },
): { identity: Memory[]; room: Memory[] } {
  const pick = (scope: MemoryScope, ownerId: string, budget: number): Memory[] => {
    if (!ownerId) return []
    const all = listMemories(scope, ownerId)
    const chosen: Memory[] = []
    let used = 0
    for (const memory of all) {
      // all is pinned-first already; only stop skipping once past the pinned block
      if (!memory.pinned && used + memory.content.length > budget) continue
      chosen.push(memory)
      used += memory.content.length
      if (used > budget + 4_000) break
    }
    return chosen
  }
  return {
    identity: identityId ? pick('identity', identityId, budgets.identity) : [],
    room: pick('room', roomId, budgets.room),
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
  return db.prepare('select * from character_presets order by created_at asc').all().map(mapPreset)
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
      // One conflicting template shouldn't sink the whole batch import.
      if (error instanceof CallNameConflictError) {
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

function builtinPresets(): PresetInput[] {
  return [
    {
      name: '开发者',
      avatar: '🛠️',
      color: '#f97316',
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
      name: '审查者',
      avatar: '🔍',
      color: '#8b76f6',
      harness: 'dsh',
      model: 'deepseek-flash',
      persona: [
        '你是一名资深代码审查者，只做 review，不直接改代码。',
        '看到开发者的完成汇报后，主动去读相关文件，检查正确性、边界情况、可维护性。',
        '输出结构化的 review：先说结论（通过 / 需修改），再列具体问题（文件:行 + 原因 + 建议），最后给一句总体评价。',
        '如果没有发现问题，也要说明你检查了哪些点。',
      ].join('\n'),
      triggers: { onUser: false, onCharacterNames: ['开发者'] },
    },
    {
      name: '赫尔墨斯',
      avatar: '🪽',
      color: '#2dd4bf',
      harness: 'hermes',
      model: 'deepseek-flash',
      persona: '你是团队里的全能助手，擅长查资料、跑命令、整理结论。只在被 @ 时发言。',
      triggers: { onUser: false, mention: true },
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
    topic: '提需求 → 开发者实现 → 审查者 review',
    workingDir: defaultWorkingDir,
    maxHops: 6,
  })

  for (const preset of listPresets()) {
    const character = createCharacterFromPreset(preset, room.id)
    if (preset.name === '赫尔墨斯') updateCharacter(character.id, { enabled: false })
  }

  addMessage({
    roomId: room.id,
    authorType: 'system',
    authorName: '系统',
    content:
      '房间已创建。开发者（CANNBot / glm-5.3）会响应你的每条消息；它发言后，审查者（DeepSeek Harness）会自动接手 review。这些角色都来自「角色库」，可以先去角色库统一维护，再一键加进新房间。',
    meta: { generated: true },
  })
}
