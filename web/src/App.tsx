import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Bootstrap, Character, CharacterPreset, Message, Room } from './types'
import { api } from './lib/api'
import { Sidebar } from './components/Sidebar'
import { ChatHeader } from './components/ChatHeader'
import { MessageList, type LiveTurn } from './components/MessageList'
import { Composer } from './components/Composer'
import { CharacterPanel } from './components/CharacterPanel'
import { CharacterEditor, type CharacterDraft } from './components/CharacterEditor'
import { RoomSettings } from './components/RoomSettings'
import { LibraryView } from './components/LibraryView'
import { PresetPicker } from './components/PresetPicker'

export default function App() {
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null)
  const [roomId, setRoomId] = useState<string | null>(null)
  const [view, setView] = useState<'chat' | 'library'>('chat')
  const [messages, setMessages] = useState<Message[]>([])
  const [live, setLive] = useState<LiveTurn | null>(null)
  const [busy, setBusy] = useState(false)
  const [activeCharacterId, setActiveCharacterId] = useState<string | null>(null)
  const [queue, setQueue] = useState<string[]>([])
  const [connected, setConnected] = useState(false)
  const [notice, setNotice] = useState('')
  const [panelOpen, setPanelOpen] = useState(false)

  const [editingCharacter, setEditingCharacter] = useState<Character | null | undefined>(undefined)
  const [editingPreset, setEditingPreset] = useState<CharacterPreset | null | undefined>(undefined)
  const [pickingPresets, setPickingPresets] = useState(false)
  const [roomForm, setRoomForm] = useState<'create' | 'edit' | null>(null)

  const rooms = bootstrap?.rooms ?? []
  const presets = bootstrap?.presets ?? []
  const allCharacters = bootstrap?.characters ?? []
  const characters = useMemo(
    () => allCharacters.filter((character) => character.roomId === roomId),
    [allCharacters, roomId],
  )
  const room = rooms.find((item) => item.id === roomId) ?? null

  const refresh = useCallback(async () => {
    const data = await api.bootstrap()
    setBootstrap(data)
    setRoomId((current) => {
      if (current && data.rooms.some((item) => item.id === current)) return current
      return data.rooms[0]?.id ?? null
    })
    // Model suggestions load out-of-band so the first paint stays instant.
    api
      .models()
      .then((models) => setBootstrap((current) => (current ? { ...current, models: models.models } : current)))
      .catch(() => {
        /* suggestions are optional */
      })
    return data
  }, [])

  useEffect(() => {
    refresh().catch((error) => setNotice(`加载失败：${error instanceof Error ? error.message : error}`))
  }, [refresh])

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(''), 4500)
    return () => clearTimeout(timer)
  }, [notice])

  // Messages + SSE follow the selected room.
  useEffect(() => {
    if (!roomId) {
      setMessages([])
      setLive(null)
      setBusy(false)
      setActiveCharacterId(null)
      return
    }

    let cancelled = false
    setMessages([])
    setLive(null)
    setBusy(false)
    setActiveCharacterId(null)

    // Pull messages on every (re)connect and merge by id: the initial load
    // races against SSE appends, and a reconnect must recover any `message`
    // broadcast missed while the connection was down.
    const pullMessages = () => {
      api
        .messages(roomId)
        .then((data) => {
          if (cancelled) return
          setMessages((current) => {
            if (current.length === 0) return data.messages
            const byId = new Map(current.map((message) => [message.id, message]))
            for (const message of data.messages) byId.set(message.id, message)
            return [...byId.values()].sort((a, b) => a.createdAt - b.createdAt)
          })
        })
        .catch((error) => setNotice(`读取消息失败：${error instanceof Error ? error.message : error}`))
    }

    const source = new EventSource(`/api/rooms/${roomId}/events`)
    source.onopen = () => {
      setConnected(true)
      pullMessages()
    }
    source.onerror = () => setConnected(false)

    source.addEventListener('message', (event) => {
      const payload = JSON.parse((event as MessageEvent).data) as { message: Message }
      setMessages((current) =>
        current.some((item) => item.id === payload.message.id) ? current : [...current, payload.message],
      )
    })

    source.addEventListener('delta', (event) => {
      const payload = JSON.parse((event as MessageEvent).data) as {
        turnId: string
        characterId: string
        kind: 'text' | 'thinking' | 'tool' | 'status'
        text: string
      }
      setLive((current) => {
        if (!current || current.turnId !== payload.turnId) {
          return {
            turnId: payload.turnId,
            characterId: payload.characterId,
            text: payload.kind === 'text' ? payload.text : '',
            thinking: payload.kind === 'thinking' ? [payload.text] : [],
            tools: payload.kind === 'tool' || payload.kind === 'status' ? [payload.text] : [],
            startedAt: Date.now(),
          }
        }
        if (payload.kind === 'text') return { ...current, text: current.text + payload.text }
        if (payload.kind === 'thinking')
          return { ...current, thinking: [...current.thinking, payload.text].slice(-60) }
        return { ...current, tools: [...current.tools, payload.text].slice(-60) }
      })
    })

    source.addEventListener('replay', (event) => {
      const payload = JSON.parse((event as MessageEvent).data) as { turn: LiveTurn }
      // The snapshot was taken server-side the moment this connection was
      // established, so it is at least as complete as anything held locally
      // (including the empty placeholder the `turn` event just created).
      // Replace unconditionally; deltas that arrive later keep appending.
      setLive(() => payload.turn)
    })

    source.addEventListener('turn', (event) => {
      const payload = JSON.parse((event as MessageEvent).data) as {
        turnId: string
        characterId: string
        status: 'running' | 'done' | 'error' | 'stopped'
      }
      if (payload.status === 'running') {
        setLive((current) =>
          current?.turnId === payload.turnId
            ? current
            : {
                turnId: payload.turnId,
                characterId: payload.characterId,
                text: '',
                thinking: [],
                tools: [],
                startedAt: Date.now(),
              },
        )
      } else {
        setLive((current) => (current?.turnId === payload.turnId ? null : current))
      }
    })

    source.addEventListener('busy', (event) => {
      const payload = JSON.parse((event as MessageEvent).data) as { busy: boolean; characterId: string | null }
      setBusy(payload.busy)
      setActiveCharacterId(payload.characterId ?? null)
      if (!payload.busy) setLive(null)
    })

    source.addEventListener('queue', (event) => {
      const payload = JSON.parse((event as MessageEvent).data) as { characters: string[] }
      setQueue(payload.characters)
    })

    // The CLI pid for the running turn, announced as soon as the harness
    // process spawns — shown next to the "工作中" badge so stray processes
    // can be told apart from live ones.
    source.addEventListener('pid', (event) => {
      const payload = JSON.parse((event as MessageEvent).data) as { turnId: string; pid: number }
      setLive((current) => (current?.turnId === payload.turnId ? { ...current, pid: payload.pid } : current))
    })

    // Settings changes (from this tab or another one) arrive as `room`
    // broadcasts, so every open tab's sidebar/title/staying room stay in sync.
    source.addEventListener('room', (event) => {
      const payload = JSON.parse((event as MessageEvent).data) as { room: Room }
      setBootstrap((current) => {
        if (!current) return current
        const known = current.rooms.some((item) => item.id === payload.room.id)
        return {
          ...current,
          rooms: known
            ? current.rooms.map((item) => (item.id === payload.room.id ? payload.room : item))
            : [...current.rooms, payload.room],
        }
      })
    })

    return () => {
      cancelled = true
      source.close()
      setConnected(false)
    }
  }, [roomId])

  const send = async (content: string) => {
    if (!roomId) return
    try {
      const message = await api.sendMessage(roomId, content)
      setMessages((current) => (current.some((item) => item.id === message.id) ? current : [...current, message]))
    } catch (error) {
      setNotice(`发送失败：${error instanceof Error ? error.message : error}`)
    }
  }

  // Steer: a mid-turn supplementary note aimed at the active speaker. The
  // server aborts its current run and re-runs it with the note in the prompt.
  const steer = async (targetId: string, content: string) => {
    if (!roomId) return
    try {
      const message = await api.steer(roomId, targetId, content)
      setMessages((current) => (current.some((item) => item.id === message.id) ? current : [...current, message]))
    } catch (error) {
      setNotice(`补充失败：${error instanceof Error ? error.message : error}`)
    }
  }

  // "记住": file a message into long-term memory — a character's reply becomes
  // that character's cross-room identity note, a user note becomes shared room
  // memory. Every future turn's prompt carries it (hard-budgeted).
  const rememberMessage = async (message: Message) => {
    if (!roomId) return
    try {
      const result = await api.rememberMessage(roomId, message.id)
      const where = message.characterId ? `「${message.authorName}」的跨房间长期记忆` : '房间共享记忆'
      setNotice(result.existed ? `这条已经在${where}里了` : `已记入${where}`)
    } catch (error) {
      setNotice(`记住失败：${error instanceof Error ? error.message : error}`)
    }
  }

  const selectRoom = (id: string) => {
    setRoomId(id)
    setView('chat')
  }

  /* ---------------------------------------------------------- characters */

  const saveCharacter = async (draft: CharacterDraft) => {
    if (editingCharacter) {
      await api.updateCharacter(editingCharacter.id, draft)
    } else if (roomId) {
      await api.createCharacter(roomId, draft)
    }
    await refresh()
  }

  const deleteCharacter = async () => {
    if (!editingCharacter) return
    await api.deleteCharacter(editingCharacter.id)
    await refresh()
  }

  const toggleCharacter = async (character: Character, enabled: boolean) => {
    try {
      await api.updateCharacter(character.id, { enabled })
      await refresh()
    } catch (error) {
      setNotice(`更新失败：${error instanceof Error ? error.message : error}`)
    }
  }

  const runCharacter = async (character: Character) => {
    try {
      await api.runCharacter(character.id)
      setNotice(`已让「${character.name}」读一遍群聊并发言`)
    } catch (error) {
      setNotice(`触发失败：${error instanceof Error ? error.message : error}`)
    }
  }

  /* ------------------------------------------------------------- presets */

  const savePreset = async (draft: CharacterDraft) => {
    if (editingPreset) {
      await api.updatePreset(editingPreset.id, draft)
    } else {
      await api.createPreset(draft)
    }
    await refresh()
  }

  const deletePreset = async () => {
    if (!editingPreset) return
    await api.deletePreset(editingPreset.id)
    await refresh()
  }

  const addPresets = async (presetIds: string[]) => {
    if (!roomId) return
    try {
      const result = await api.addPresetsToRoom(roomId, presetIds)
      await refresh()
      const skipped = result.skipped.length ? `，跳过：${result.skipped.join('、')}` : ''
      setNotice(`已添加 ${result.created.length} 个角色${skipped}`)
    } catch (error) {
      setNotice(`添加失败：${error instanceof Error ? error.message : error}`)
      throw error
    }
  }

  /* --------------------------------------------------------------- rooms */

  const stop = async () => {
    if (!roomId) return
    await api.stopRoom(roomId)
  }

  const clear = async () => {
    if (!roomId) return
    if (!window.confirm('清空这个房间的全部聊天记录？')) return
    await api.clearRoom(roomId)
    setMessages([])
    setLive(null)
  }

  const saveRoom = async (draft: { name: string; topic: string; workingDir: string; maxHops: number }) => {
    if (roomForm === 'create') {
      const created = await api.createRoom({ ...draft, workingDir: draft.workingDir || room?.workingDir || '' })
      await refresh()
      setRoomId(created.id)
      setView('chat')
      return
    }
    if (!roomId) return
    const updated = await api.updateRoom(roomId, draft)
    await refresh()
    if (updated) setNotice('房间设置已保存')
  }

  const deleteRoom = async () => {
    if (!roomId) return
    if (!window.confirm('删除这个房间及其全部角色和消息？')) return
    await api.deleteRoom(roomId)
    await refresh()
  }

  if (!bootstrap) {
    return (
      <div className="boot">
        <div className="boot-mark">◍</div>
        <p>正在加载群聊…</p>
      </div>
    )
  }

  const libraryMode = view === 'library'

  return (
    <div className={`app${panelOpen ? ' panel-open' : ''}${libraryMode ? ' app-library' : ''}`}>
      <Sidebar
        rooms={rooms}
        characters={allCharacters}
        selectedRoomId={roomId}
        harnesses={bootstrap.harnesses}
        connected={connected}
        view={view}
        presetCount={presets.length}
        onSelect={selectRoom}
        onNewRoom={() => setRoomForm('create')}
        onViewChange={setView}
      />

      <main className={`main${libraryMode ? ' main-library' : ''}`}>
        {libraryMode ? (
          <LibraryView
            presets={presets}
            harnesses={bootstrap.harnesses}
            onCreate={() => setEditingPreset(null)}
            onEdit={(preset) => setEditingPreset(preset)}
            onDelete={(preset) => {
              if (!window.confirm(`删除角色库模板「${preset.name}」？已加入房间的副本不受影响。`)) return
              void api
                .deletePreset(preset.id)
                .then(refresh)
                .catch((error) => setNotice(`删除失败：${error instanceof Error ? error.message : error}`))
            }}
          />
        ) : (
          <>
            <ChatHeader
              room={room}
              characters={characters}
              busy={busy}
              activeCharacterId={activeCharacterId}
              queueLength={queue.length}
              onStop={stop}
              onClear={clear}
              onEditRoom={() => setRoomForm('edit')}
              onTogglePanel={() => setPanelOpen((open) => !open)}
            />

            <MessageList
              messages={messages}
              characters={characters}
              live={live}
              activeCharacterId={activeCharacterId}
              roomId={roomId}
              onRemember={rememberMessage}
            />

            <Composer
              key={roomId ?? 'no-room'}
              characters={characters}
              disabled={!room}
              roomId={roomId}
              onSend={send}
              busy={busy}
              activeCharacter={characters.find((item) => item.id === activeCharacterId) ?? null}
              onSteer={steer}
            />
          </>
        )}
      </main>

      {!libraryMode && (
        <CharacterPanel
          characters={characters}
          members={characters}
          harnesses={bootstrap.harnesses}
          activeCharacterId={activeCharacterId}
          onAdd={() => setEditingCharacter(null)}
          onPickFromLibrary={() => setPickingPresets(true)}
          onEdit={(character) => setEditingCharacter(character)}
          onRun={runCharacter}
          onToggle={toggleCharacter}
        />
      )}

      {notice && <div className="toast">{notice}</div>}

      {editingCharacter !== undefined && room && (
        <CharacterEditor
          mode="room"
          character={editingCharacter}
          room={room}
          members={characters}
          models={bootstrap.models}
          harnesses={bootstrap.harnesses}
          onClose={() => setEditingCharacter(undefined)}
          onSave={saveCharacter}
          onDelete={editingCharacter ? deleteCharacter : undefined}
        />
      )}

      {editingPreset !== undefined && (
        <CharacterEditor
          mode="library"
          character={editingPreset}
          models={bootstrap.models}
          harnesses={bootstrap.harnesses}
          onClose={() => setEditingPreset(undefined)}
          onSave={savePreset}
          onDelete={editingPreset ? deletePreset : undefined}
        />
      )}

      {pickingPresets && room && (
        <PresetPicker
          presets={presets}
          existingNames={characters.map((character) => character.name)}
          roomName={room.name}
          onClose={() => setPickingPresets(false)}
          onAdd={addPresets}
        />
      )}

      {roomForm && (
        <RoomSettings
          room={roomForm === 'edit' ? room : null}
          canDelete={Boolean(room)}
          onClose={() => setRoomForm(null)}
          onSave={saveRoom}
          onDelete={deleteRoom}
        />
      )}
    </div>
  )
}
