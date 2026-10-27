import type { Bootstrap, Character, CharacterPreset, HarnessMap, Memory, Message, Room } from '../types'

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

  createRoom: (input: { name: string; topic?: string; workingDir: string; maxHops?: number }) =>
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
}
