import type {
  Bootstrap,
  Character,
  CharacterPreset,
  HarnessMap,
  McpMap,
  Memory,
  Message,
  Room,
  RoomObservability,
  RoomTemplate,
  RoomUsage,
  RoundReport,
  SkillInfo,
  Task,
  TaskStatus,
} from '../types'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
  const text = await response.text()
  const data = text ? JSON.parse(text) : null
  if (!response.ok) {
    throw new Error(data?.error ?? `${response.status} ${response.statusText}`)
  }
  return data as T
}

export const api = {
  bootstrap: () => request<Bootstrap>('/api/bootstrap'),

  messages: (roomId: string, limit = 300) =>
    request<{ messages: Message[] }>(`/api/rooms/${roomId}/messages?limit=${limit}`),

  sendMessage: (roomId: string, content: string) =>
    request<Message>(`/api/rooms/${roomId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content }),
    }),

  /** Mid-turn steer note: aborts the target's active run and re-runs it. */
  steer: (roomId: string, targetId: string, content: string) =>
    request<Message>(`/api/rooms/${roomId}/steer`, {
      method: 'POST',
      body: JSON.stringify({ targetId, content }),
    }),

  stopRoom: (roomId: string) =>
    request<{ ok: boolean }>(`/api/rooms/${roomId}/stop`, { method: 'POST' }),

  clearRoom: (roomId: string) =>
    request<{ ok: boolean }>(`/api/rooms/${roomId}/clear`, { method: 'POST' }),

  createRoom: (input: { name: string; topic?: string; workingDir: string; maxHops?: number; verifyCommand?: string }) =>
    request<Room>('/api/rooms', { method: 'POST', body: JSON.stringify(input) }),

  updateRoom: (roomId: string, patch: Partial<Room>) =>
    request<Room>(`/api/rooms/${roomId}`, { method: 'PATCH', body: JSON.stringify(patch) }),

  deleteRoom: (roomId: string) =>
    request<{ ok: boolean }>(`/api/rooms/${roomId}`, { method: 'DELETE' }),

  createCharacter: (roomId: string, input: Partial<Character>) =>
    request<Character>(`/api/rooms/${roomId}/characters`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  updateCharacter: (characterId: string, patch: Partial<Character>) =>
    request<Character>(`/api/characters/${characterId}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  deleteCharacter: (characterId: string) =>
    request<{ ok: boolean }>(`/api/characters/${characterId}`, { method: 'DELETE' }),

  addPresetsToRoom: (roomId: string, presetIds: string[]) =>
    request<{ created: Character[]; skipped: string[] }>(`/api/rooms/${roomId}/characters/from-presets`, {
      method: 'POST',
      body: JSON.stringify({ presetIds }),
    }),

  /** Re-copy the linked library template onto this room character. */
  syncCharacterFromPreset: (characterId: string) =>
    request<Character>(`/api/characters/${characterId}/sync-preset`, { method: 'POST' }),

  /** B07: the skills/ catalog (body-less), for the editor's checkbox list. */
  skills: () => request<{ dir: string; skills: SkillInfo[] }>('/api/skills'),

  presets: () => request<{ presets: CharacterPreset[] }>('/api/presets'),

  createPreset: (input: Partial<CharacterPreset>) =>
    request<CharacterPreset>('/api/presets', { method: 'POST', body: JSON.stringify(input) }),

  updatePreset: (presetId: string, patch: Partial<CharacterPreset>) =>
    request<CharacterPreset>(`/api/presets/${presetId}`, { method: 'PATCH', body: JSON.stringify(patch) }),

  deletePreset: (presetId: string) =>
    request<{ ok: boolean }>(`/api/presets/${presetId}`, { method: 'DELETE' }),

  runCharacter: (characterId: string, prompt?: string) =>
    request<{ ok: boolean }>(`/api/characters/${characterId}/run`, {
      method: 'POST',
      body: JSON.stringify({ prompt }),
    }),

  models: () => request<{ models: Record<string, string[]>; harnesses: HarnessMap }>('/api/models'),

  /** Which MCP servers each harness CLI loads (read from its own config). */
  mcps: () => request<{ mcps: McpMap }>('/api/mcps'),

  /** B08: per-character token usage for a room (harness-reported only). */
  usage: (roomId: string) => request<RoomUsage>(`/api/rooms/${roomId}/usage`),

  /** B10: live round, persisted checks and crash tail for the status drawer. */
  observability: (roomId: string) => request<RoomObservability>(`/api/rooms/${roomId}/observability`),

  /** B11: finished-round evidence reports, newest first. */
  rounds: (roomId: string, limit = 20) =>
    request<{ rounds: RoundReport[] }>(`/api/rooms/${roomId}/rounds?limit=${limit}`),

  /** B11: the round's auto-commit rendered as stat + patch. */
  roundDiff: (roomId: string, roundId: string) =>
    request<{ hash: string; text: string; truncated: boolean }>(
      `/api/rooms/${roomId}/rounds/${roundId}/diff`,
    ),

  /** B11: advisory blind review of a committed round (request + diff only). */
  blindReview: (roomId: string, roundId: string) =>
    request<{ ok: boolean; reviewer: { id: string; name: string; harness: string }; hash: string }>(
      `/api/rooms/${roomId}/rounds/${roundId}/blind-review`,
      { method: 'POST' },
    ),

  /** B09: opt-in git worktree isolation (own checkout + branch per room). */
  isolateRoom: (roomId: string) =>
    request<{ room: Room; worktree: { source: string; path: string; branch: string } }>(
      `/api/rooms/${roomId}/isolation`,
      { method: 'POST' },
    ),

  unisolateRoom: (roomId: string) =>
    request<{ room: Room }>(`/api/rooms/${roomId}/isolation`, { method: 'DELETE' }),

  /** B09: scenario templates (dev squad / writing room / research cell). */
  templates: () => request<{ templates: RoomTemplate[] }>('/api/templates'),

  applyTemplate: (roomId: string, templateId: string) =>
    request<{ created: Character[]; skipped: string[]; errors: string[] }>(
      `/api/rooms/${roomId}/templates/${templateId}`,
      { method: 'POST' },
    ),

  /* Long-term memory (docs/memory-plan.md): room-scope = shared, identity-scope = per character. */
  memories: (roomId: string) =>
    request<{
      room: Memory[]
      members: { characterId: string; name: string; identityId: string; memories: Memory[] }[]
    }>(`/api/rooms/${roomId}/memories`),

  addMemory: (
    roomId: string,
    input: { scope: 'room' | 'identity'; characterId?: string; kind?: string; content: string; pinned?: boolean },
  ) =>
    request<{ memory: Memory; existed: boolean }>(`/api/rooms/${roomId}/memories`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  /** One-click "记住" on a message: scope/kind derived server-side from the author. */
  rememberMessage: (roomId: string, messageId: string) =>
    request<{ memory: Memory; existed: boolean }>(`/api/rooms/${roomId}/memories`, {
      method: 'POST',
      body: JSON.stringify({ fromMessageId: messageId }),
    }),

  updateMemory: (memoryId: string, patch: { content?: string; kind?: string; pinned?: boolean }) =>
    request<Memory>(`/api/memories/${memoryId}`, { method: 'PATCH', body: JSON.stringify(patch) }),

  deleteMemory: (memoryId: string) =>
    request<{ ok: boolean }>(`/api/memories/${memoryId}`, { method: 'DELETE' }),

  /* Task cards (B03): proposed → running (approval runs the assignee,
     synchronously) → done; a gate-blocked or errored round leaves the card
     running for a re-dispatch. */
  tasks: (roomId: string) => request<{ tasks: Task[] }>(`/api/rooms/${roomId}/tasks`),

  createTask: (
    roomId: string,
    input: { title: string; what: string; why?: string; acceptance?: string; assigneeId?: string | null },
  ) =>
    request<Task>(`/api/rooms/${roomId}/tasks`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  /** `status` here is a transition REQUEST, not a state readback: the server
   * maps 'approved' to the approve action (which writes `running`). */
  updateTask: (
    taskId: string,
    patch: Partial<Pick<Task, 'title' | 'what' | 'why' | 'acceptance' | 'assigneeId'>> & {
      status?: TaskStatus | 'approved'
    },
  ) => request<Task>(`/api/tasks/${taskId}`, { method: 'PATCH', body: JSON.stringify(patch) }),

  dispatchTask: (taskId: string) => request<Task>(`/api/tasks/${taskId}/dispatch`, { method: 'POST' }),
}
