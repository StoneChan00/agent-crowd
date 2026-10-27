/**
 * End-to-end smoke test against a running server.
 *
 *   pnpm start          # in another terminal
 *   node scripts/smoke.mjs
 *
 * Covers two flows with mock characters (no model calls):
 *   1. in-room characters: developer speaks -> reviewer is triggered
 *   2. character library: create presets -> add them to a new room ->
 *      name-based trigger resolves to the developer's id -> chain still works
 * Plus: mention routing, hop budget, degraded turns (timeout/error/empty/
 *   stop), mid-turn steer, room settings PATCH, CLI pid surfacing.
 *
 * Everything it creates is deleted again.
 */
const BASE = process.env.AC_BASE ?? 'http://127.0.0.1:8787'

async function req(path, init) {
  const response = await fetch(BASE + path, {
    headers: { 'content-type': 'application/json' },
    ...init,
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${response.status} ${text}`)
  return text ? JSON.parse(text) : null
}

async function waitForReplies(roomId, count) {
  const deadline = Date.now() + 60_000
  let messages = []
  while (Date.now() < deadline) {
    messages = (await req(`/api/rooms/${roomId}/messages?limit=50`)).messages
    const state = await req(`/api/rooms/${roomId}/state`)
    const replies = messages.filter((message) => message.authorType === 'character')
    if (replies.length >= count && !state.busy && state.queuedCharacterIds.length === 0) break
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  return messages
}

/** Raw status check for routes that are expected to fail (req() throws). */
async function statusOf(path, init) {
  const response = await fetch(BASE + path, { headers: { 'content-type': 'application/json' }, ...init })
  await response.text().catch(() => '')
  return response.status
}

/**
 * Opens an SSE stream, PATCHes the room, and resolves with the broadcast
 * `room` payload (null on timeout) — verifies multi-tab sync without a browser.
 */
async function patchAndListen(roomId, patch) {
  const controller = new AbortController()
  const response = await fetch(`${BASE}/api/rooms/${roomId}/events`, { signal: controller.signal })
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  const arrived = new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 10_000)
    void (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          text += decoder.decode(value, { stream: true })
          const match = /event: room\ndata: (.+)\n/.exec(text)
          if (match) {
            clearTimeout(timer)
            resolve(JSON.parse(match[1]).room)
            return
          }
        }
      } catch {
        /* aborted while waiting */
      }
      clearTimeout(timer)
      resolve(null)
    })()
  })
  await new Promise((resolve) => setTimeout(resolve, 300))
  await req(`/api/rooms/${roomId}`, { method: 'PATCH', body: JSON.stringify(patch) })
  const room = await arrived
  controller.abort()
  return room
}

const health = await req('/api/health')
for (const kind of ['cannbot', 'opencode', 'dsh', 'hermes']) {
  const info = health.harnesses[kind]
  console.log(`${info.available ? '✓' : '×'} ${kind}${info.detail ? ` (${info.detail})` : ''}`)
}
if (!Number.isFinite(health.startedAt) || !(health.turnTimeoutMs > 0)) {
  console.log('× health: 缺少 startedAt / turnTimeoutMs（server 代码过旧？）')
  process.exitCode = 1
} else {
  console.log(`✓ health: startedAt=${new Date(health.startedAt).toISOString()} turnTimeoutMs=${health.turnTimeoutMs}`)
}
if (!Number.isInteger(health.pid) || !(health.pid > 0)) {
  console.log('× health: 缺少 server 自身 pid')
  process.exitCode = 1
} else {
  console.log(`✓ health: server pid=${health.pid}`)
}

// Optional end-to-end guard for AC_TURN_TIMEOUT_MS parsing: start the test
// server with e.g. AC_TURN_TIMEOUT_MS=30m and run smoke with
// AC_SMOKE_EXPECT_TIMEOUT_MS=1800000 to verify the suffix resolved correctly.
const expectTimeout = Number(process.env.AC_SMOKE_EXPECT_TIMEOUT_MS)
if (Number.isFinite(expectTimeout) && expectTimeout > 0) {
  const timeoutOk = health.turnTimeoutMs === expectTimeout
  console.log(
    timeoutOk
      ? `✓ health timeout: AC_TURN_TIMEOUT_MS 解析为 ${expectTimeout}ms`
      : `× health timeout: 期望 ${expectTimeout}ms，实际 ${health.turnTimeoutMs}ms`,
  )
  if (!timeoutOk) process.exitCode = 1
}

const createdRooms = []
const createdPresets = []

try {
  /* ---------------------------------------------------- 1. in-room chain */

  const room = await req('/api/rooms', {
    method: 'POST',
    body: JSON.stringify({ name: `smoke-room-${Date.now()}`, workingDir: process.cwd(), maxHops: 4 }),
  })
  createdRooms.push(room.id)

  const developer = await req(`/api/rooms/${room.id}/characters`, {
    method: 'POST',
    body: JSON.stringify({
      name: '开发者',
      harness: 'mock',
      model: 'mock',
      persona: '你是开发者',
      triggers: { onUser: true, onAll: false, onCharacters: [], onCharacterNames: [], keyword: '', mention: true },
    }),
  })
  await req(`/api/rooms/${room.id}/characters`, {
    method: 'POST',
    body: JSON.stringify({
      name: '审查者',
      harness: 'mock',
      model: 'mock',
      persona: '你是审查者',
      triggers: { onUser: false, onAll: false, onCharacters: [developer.id], onCharacterNames: ['开发者'], keyword: '', mention: true },
    }),
  })

  await req(`/api/rooms/${room.id}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content: '实现一个登录接口' }),
  })

  const messages = await waitForReplies(room.id, 2)
  const replies = messages.filter((message) => message.authorType === 'character')
  const inRoomOk =
    replies.length === 2 && replies[0].authorName === '开发者' && replies[1].authorName === '审查者'
  console.log(inRoomOk ? '✓ in-room chain: 开发者 → 审查者' : '× in-room chain failed')
  if (!inRoomOk) process.exitCode = 1

  /* ------------------------------------------------- 2. preset -> room */

  const suffix = Date.now()
  const presetDev = await req('/api/presets', {
    method: 'POST',
    body: JSON.stringify({
      name: `smoke-dev-${suffix}`,
      harness: 'mock',
      model: 'mock',
      persona: '你是开发者',
      triggers: { onUser: true },
    }),
  })
  createdPresets.push(presetDev.id)

  const presetReviewer = await req('/api/presets', {
    method: 'POST',
    body: JSON.stringify({
      name: `smoke-reviewer-${suffix}`,
      harness: 'mock',
      model: 'mock',
      persona: '你是审查者',
      triggers: { onUser: false, onCharacterNames: [presetDev.name] },
    }),
  })
  createdPresets.push(presetReviewer.id)

  const presetRoom = await req('/api/rooms', {
    method: 'POST',
    body: JSON.stringify({ name: `smoke-preset-${suffix}`, workingDir: process.cwd(), maxHops: 4 }),
  })
  createdRooms.push(presetRoom.id)

  const added = await req(`/api/rooms/${presetRoom.id}/characters/from-presets`, {
    method: 'POST',
    body: JSON.stringify({ presetIds: [presetDev.id, presetReviewer.id] }),
  })
  const [addedDev, addedReviewer] = added.created
  const resolved =
    Boolean(addedDev && addedReviewer) &&
    addedDev.harness === 'mock' &&
    addedReviewer.triggers.onCharacterNames.includes(addedDev.name) &&
    addedReviewer.triggers.onCharacters.includes(addedDev.id)
  console.log(resolved ? '✓ preset import: name trigger resolved to id' : '× preset import failed')
  if (!resolved) process.exitCode = 1

  await req(`/api/rooms/${presetRoom.id}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content: '实现一个登录接口' }),
  })
  const presetMessages = await waitForReplies(presetRoom.id, 2)
  const presetReplies = presetMessages.filter((message) => message.authorType === 'character')
  const presetChainOk = presetReplies.length === 2
  console.log(presetChainOk ? '✓ preset chain: 模板角色自动接力' : '× preset chain failed')
  if (!presetChainOk) process.exitCode = 1

  /* ------------------------------------------------ 3. mention routing */

  const routeRoom = await req('/api/rooms', {
    method: 'POST',
    body: JSON.stringify({ name: `smoke-route-${Date.now()}`, workingDir: process.cwd(), maxHops: 6 }),
  })
  createdRooms.push(routeRoom.id)

  const quiet = { onUser: false, onAll: false, onCharacters: [], onCharacterNames: [], keyword: '', mention: false }
  for (const name of ['甲', '乙', '丙']) {
    await req(`/api/rooms/${routeRoom.id}/characters`, {
      method: 'POST',
      body: JSON.stringify({ name, harness: 'mock', model: 'mock', persona: `你是${name}`, triggers: quiet }),
    })
  }

  const characterAuthors = async (roomId) => {
    const list = await req(`/api/rooms/${roomId}/messages?limit=100`)
    return list.messages.filter((message) => message.authorType === 'character').map((message) => message.authorName)
  }

  const systemNotices = async (roomId) => {
    const list = await req(`/api/rooms/${roomId}/messages?limit=100`)
    return list.messages.filter((message) => message.authorType === 'system').map((message) => message.content)
  }

  const waitForTurnEnd = async (roomId) => {
    await new Promise((resolve) => setTimeout(resolve, 300))
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      const state = await req(`/api/rooms/${roomId}/state`)
      if (!state.busy && state.queuedCharacterIds.length === 0) return
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }

  // `@乙` wakes only 乙.
  await req(`/api/rooms/${routeRoom.id}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content: '@乙 只有你回复' }),
  })
  await waitForTurnEnd(routeRoom.id)
  let authors = await characterAuthors(routeRoom.id)
  const mentionOk = authors.length === 1 && authors[0] === '乙'
  console.log(mentionOk ? '✓ mention routing: @乙 只唤醒乙' : `× mention routing failed: ${authors.join(',')}`)
  if (!mentionOk) process.exitCode = 1

  // No mention → the first enabled character (甲).
  await req(`/api/rooms/${routeRoom.id}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content: '这条没有点名' }),
  })
  await waitForTurnEnd(routeRoom.id)
  authors = await characterAuthors(routeRoom.id)
  const firstOk = authors.length === 2 && authors[1] === '甲'
  console.log(firstOk ? '✓ default routing: 无@ 唤醒第一个角色（甲）' : `× default routing failed: ${authors.join(',')}`)
  if (!firstOk) process.exitCode = 1

  // `@all` wakes every character.
  await req(`/api/rooms/${routeRoom.id}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content: '@all 全体注意' }),
  })
  await waitForTurnEnd(routeRoom.id)
  authors = await characterAuthors(routeRoom.id)
  const allSet = new Set(authors.slice(2))
  const allOk = authors.length === 5 && allSet.size === 3
  console.log(allOk ? '✓ @all routing: 全体唤醒' : `× @all routing failed: ${authors.join(',')}`)
  if (!allOk) process.exitCode = 1

  // A disabled character that gets @'d wakes nobody; a system notice explains.
  const disabledChar = await req(`/api/rooms/${routeRoom.id}/characters`, {
    method: 'POST',
    body: JSON.stringify({ name: '丁', harness: 'mock', model: 'mock', persona: '你是丁', triggers: quiet }),
  })
  await req(`/api/characters/${disabledChar.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: false }) })
  await req(`/api/rooms/${routeRoom.id}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content: '@丁 只有你回复' }),
  })
  await waitForTurnEnd(routeRoom.id)
  authors = await characterAuthors(routeRoom.id)
  const notices = await systemNotices(routeRoom.id)
  const disabledOk = authors.length === 5 && notices.some((text) => text.includes('已停用'))
  console.log(
    disabledOk ? '✓ disabled mention: @停用角色 不唤醒旁人（有系统提示）' : `× disabled mention failed: ${authors.join(',')}`,
  )
  if (!disabledOk) process.exitCode = 1

  // `team@all.com` must not wake everyone (leading boundary on @all).
  await req(`/api/rooms/${routeRoom.id}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content: '我的邮箱是 team@all.com，别吵' }),
  })
  await waitForTurnEnd(routeRoom.id)
  authors = await characterAuthors(routeRoom.id)
  const emailOk = authors.length === 6 && authors[5] === '甲'
  console.log(emailOk ? '✓ @all boundary: team@all.com 不唤醒全体' : `× @all boundary failed: ${authors.join(',')}`)
  if (!emailOk) process.exitCode = 1

  // CJK trailing boundary: `@鱼头` must not wake `鱼`.
  const fishRoom = await req('/api/rooms', {
    method: 'POST',
    body: JSON.stringify({ name: `smoke-fish-${Date.now()}`, workingDir: process.cwd(), maxHops: 4 }),
  })
  createdRooms.push(fishRoom.id)
  for (const name of ['鱼', '鱼头']) {
    await req(`/api/rooms/${fishRoom.id}/characters`, {
      method: 'POST',
      body: JSON.stringify({ name, harness: 'mock', model: 'mock', persona: `你是${name}`, triggers: quiet }),
    })
  }
  await req(`/api/rooms/${fishRoom.id}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content: '@鱼头 早' }),
  })
  await waitForTurnEnd(fishRoom.id)
  const fishAuthors = await characterAuthors(fishRoom.id)
  const fishOk = fishAuthors.length === 1 && fishAuthors[0] === '鱼头'
  console.log(fishOk ? '✓ CJK boundary: @鱼头 不唤醒 鱼' : `× CJK boundary failed: ${fishAuthors.join(',')}`)
  if (!fishOk) process.exitCode = 1

  /* ------------------------------------------- 4. @all beyond the hop budget */

  // Direct targets all run at hop 1, so @all must reach every enabled
  // character even when the room has more characters than maxHops.
  const crowdRoom = await req('/api/rooms', {
    method: 'POST',
    body: JSON.stringify({ name: `smoke-crowd-${Date.now()}`, workingDir: process.cwd(), maxHops: 6 }),
  })
  createdRooms.push(crowdRoom.id)
  for (let i = 1; i <= 8; i++) {
    await req(`/api/rooms/${crowdRoom.id}/characters`, {
      method: 'POST',
      body: JSON.stringify({ name: `成员${i}`, harness: 'mock', model: 'mock', persona: `你是成员${i}`, triggers: quiet }),
    })
  }
  await req(`/api/rooms/${crowdRoom.id}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content: '@all 全员集合' }),
  })
  await waitForTurnEnd(crowdRoom.id)
  const crowdAuthors = await characterAuthors(crowdRoom.id)
  const crowdOk = crowdAuthors.length === 8
  console.log(crowdOk ? '✓ @all budget: 8 角色 / maxHops=6 全部被唤醒' : `× @all budget failed: ${crowdAuthors.join(',')}`)
  if (!crowdOk) process.exitCode = 1

  /* ------------------------------------------ 5. degraded turn plumbing */

  const failRoom = await req('/api/rooms', {
    method: 'POST',
    body: JSON.stringify({ name: `smoke-fail-${Date.now()}`, workingDir: process.cwd(), maxHops: 4 }),
  })
  createdRooms.push(failRoom.id)
  const worker = await req(`/api/rooms/${failRoom.id}/characters`, {
    method: 'POST',
    body: JSON.stringify({ name: '模拟工', harness: 'mock', model: 'mock', persona: '模拟专用', triggers: quiet }),
  })
  // Relays on 模拟工: errored turns must NOT wake it (no chaining on truncated
  // content), the clean placeholder turn must.
  await req(`/api/rooms/${failRoom.id}/characters`, {
    method: 'POST',
    body: JSON.stringify({
      name: '接锅侠',
      harness: 'mock',
      model: 'mock',
      persona: '接力观察员',
      triggers: { ...quiet, onCharacters: [worker.id] },
    }),
  })

  const roomMessages = async (roomId) => (await req(`/api/rooms/${roomId}/messages?limit=100`)).messages
  const failAuthors = async () =>
    (await roomMessages(failRoom.id)).filter((message) => message.authorType === 'character').map((message) => message.authorName)

  // Timeout with partial text: the reply is kept but flagged with meta.error.
  await req(`/api/rooms/${failRoom.id}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content: '这次请模拟超时' }),
  })
  await waitForTurnEnd(failRoom.id)
  let msgs = await roomMessages(failRoom.id)
  const partial = msgs.find((message) => message.authorType === 'character' && message.meta?.error)
  const partialOk = Boolean(partial && partial.meta.error === '运行超时' && partial.content.includes('只写了开头一句话'))
  console.log(partialOk ? '✓ truncated turn: 保留部分正文且 meta.error 标记超时' : '× truncated turn failed')
  if (!partialOk) process.exitCode = 1
  let relayAuthors = await failAuthors()
  const noRelayOk = relayAuthors.length === 1 && relayAuthors[0] === '模拟工'
  console.log(noRelayOk ? '✓ error relay: 超时轮不唤醒下游角色' : `× error relay failed: ${relayAuthors.join(',')}`)
  if (!noRelayOk) process.exitCode = 1

  // Error with no text at all: a system notice carrying exit code + duration.
  // A fast zero-text failure is transient, so exactly ONE automatic retry
  // follows; the rerun fails the same way and must not be retried again.
  await req(`/api/rooms/${failRoom.id}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content: '这次请模拟失败' }),
  })
  await waitForTurnEnd(failRoom.id)
  msgs = await roomMessages(failRoom.id)
  const failNotices = msgs.filter((message) => message.authorType === 'system' && message.content.includes('运行失败'))
  const failOk = Boolean(
    failNotices.length === 2 &&
      failNotices[0].content.includes('正在自动重试一次') &&
      !failNotices[1].content.includes('正在自动重试一次') &&
      failNotices.every((notice) => notice.content.includes('exit 7')),
  )
  console.log(failOk ? '✓ failed turn: 快速失败自动重试一次，再次失败不再重试' : `× failed turn failed: ${failNotices.length} notice(s)`)
  if (!failOk) process.exitCode = 1
  relayAuthors = await failAuthors()
  const noRelayAfterFailOk = relayAuthors.length === 1
  console.log(noRelayAfterFailOk ? '✓ error relay: 失败轮不唤醒下游角色' : `× error relay failed: ${relayAuthors.join(',')}`)
  if (!noRelayAfterFailOk) process.exitCode = 1

  // Normal exit but no text: the placeholder carries duration / exit / tool count.
  await req(`/api/rooms/${failRoom.id}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content: '这次请模拟空输出' }),
  })
  await waitForTurnEnd(failRoom.id)
  msgs = await roomMessages(failRoom.id)
  const empty = msgs.filter((message) => message.authorType === 'character').pop()
  const emptyOk = Boolean(empty && empty.content.includes('没有返回正文') && empty.content.includes('exit 0'))
  console.log(emptyOk ? '✓ empty turn: 占位符带耗时/exit/工具次数' : '× empty turn failed')
  if (!emptyOk) process.exitCode = 1
  relayAuthors = await failAuthors()
  const relayOk = relayAuthors.length === 3 && relayAuthors[2] === '接锅侠'
  console.log(relayOk ? '✓ clean relay: 正常轮仍会接力（接锅侠发言）' : `× clean relay failed: ${relayAuthors.join(',')}`)
  if (!relayOk) process.exitCode = 1

  // Stop mid-turn: the partial reply must be preserved and flagged, not
  // vanish together with the live buffer.
  await req(`/api/rooms/${failRoom.id}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content: '这次请模拟慢速' }),
  })
  await new Promise((resolve) => setTimeout(resolve, 1000))
  await req(`/api/rooms/${failRoom.id}/stop`, { method: 'POST', body: JSON.stringify({}) })
  await waitForTurnEnd(failRoom.id)
  msgs = await roomMessages(failRoom.id)
  const stopped = msgs.filter((message) => message.authorType === 'character').pop()
  const stoppedOk = Boolean(stopped && stopped.meta?.error === '已停止' && stopped.content.includes('第1段'))
  console.log(stoppedOk ? '✓ stopped turn: 中断正文保留并打标（不接力）' : '× stopped turn failed')
  if (!stoppedOk) process.exitCode = 1

  /* ------------------------------------------------ 5b. mid-turn steer */

  // Steer mid-turn: the active slow run is aborted (partial kept as a stopped
  // reply) and the target re-runs with the steer note in its prompt — mock
  // echoes the last user line, so the reply text proves the steer arrived.
  await req(`/api/rooms/${failRoom.id}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content: '再演示一次模拟慢速' }),
  })
  await new Promise((resolve) => setTimeout(resolve, 1000))
  const steerMsg = await req(`/api/rooms/${failRoom.id}/steer`, {
    method: 'POST',
    body: JSON.stringify({ targetId: worker.id, content: '中途补充：改用英文并加 DONE 后缀' }),
  })
  await waitForTurnEnd(failRoom.id)
  msgs = await roomMessages(failRoom.id)
  const steerSaved = msgs.find((message) => message.id === steerMsg.id)
  const steerFlagOk = Boolean(steerSaved?.meta?.steer?.targetName === '模拟工')
  console.log(steerFlagOk ? '✓ steer: 补充消息落库并带目标标记' : '× steer: 消息标记缺失')
  if (!steerFlagOk) process.exitCode = 1

  const stoppedTotal = msgs.filter((message) => message.meta?.error === '已停止').length
  const steerInterruptOk = stoppedTotal >= 2
  console.log(
    steerInterruptOk ? '✓ steer: 打断的慢速轮保留了半截回复（已停止标记）' : '× steer: 打断轮未保留半截回复',
  )
  if (!steerInterruptOk) process.exitCode = 1

  const finalWorkerReply = msgs
    .filter((message) => message.authorType === 'character' && message.authorName === '模拟工')
    .pop()
  const steerCarryOk = Boolean(
    finalWorkerReply &&
      !finalWorkerReply.meta?.error &&
      finalWorkerReply.content.includes('中途补充：改用英文并加 DONE 后缀'),
  )
  console.log(steerCarryOk ? '✓ steer: 重跑回合的 prompt 携带补充内容' : '× steer: 重跑未携带补充内容')
  if (!steerCarryOk) process.exitCode = 1

  // Steer while idle behaves like a direct call: the target runs with the
  // note as its trigger.
  await req(`/api/rooms/${failRoom.id}/steer`, {
    method: 'POST',
    body: JSON.stringify({ targetId: worker.id, content: '空闲时补充：回复收到两个字' }),
  })
  await waitForTurnEnd(failRoom.id)
  msgs = await roomMessages(failRoom.id)
  const idleReply = msgs
    .filter((message) => message.authorType === 'character' && message.authorName === '模拟工')
    .pop()
  const idleSteerOk = Boolean(idleReply && idleReply.content.includes('空闲时补充：回复收到两个字'))
  console.log(idleSteerOk ? '✓ steer: 空闲时补充直接唤醒目标' : '× steer: 空闲补充未生效')
  if (!idleSteerOk) process.exitCode = 1

  // Route validation: unknown target → 404, empty content → 400.
  const steerStatuses = await Promise.all([
    statusOf(`/api/rooms/${failRoom.id}/steer`, {
      method: 'POST',
      body: JSON.stringify({ targetId: 'nope', content: 'x' }),
    }),
    statusOf(`/api/rooms/${failRoom.id}/steer`, {
      method: 'POST',
      body: JSON.stringify({ targetId: worker.id, content: '   ' }),
    }),
  ])
  const steerRouteOk = steerStatuses[0] === 404 && steerStatuses[1] === 400
  console.log(
    steerRouteOk
      ? '✓ steer route: 未知目标 404 / 空内容 400'
      : `× steer route: 期望 404/400，实际 ${steerStatuses.join('/')}`,
  )
  if (!steerRouteOk) process.exitCode = 1

  /* ------------------------------------------- 6. room settings PATCH */

  const settingsRoom = await req('/api/rooms', {
    method: 'POST',
    body: JSON.stringify({
      name: `smoke-settings-${Date.now()}`,
      topic: ' 旧主题 ',
      workingDir: process.cwd(),
      maxHops: 4,
    }),
  })
  createdRooms.push(settingsRoom.id)

  // Empty / whitespace-only names are rejected exactly like create.
  const nameStatuses = []
  for (const badName of ['', '   ']) {
    nameStatuses.push(
      await statusOf(`/api/rooms/${settingsRoom.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: badName }),
      }),
    )
  }
  const nameOk = nameStatuses.every((status) => status === 400)
  console.log(
    nameOk
      ? '✓ room PATCH: 空/空白房间名返回 400（与 create 一致）'
      : `× room PATCH: 空名应 400，实际 ${nameStatuses.join(',')}`,
  )
  if (!nameOk) process.exitCode = 1

  // Garbage maxHops normalizes the same way on create and PATCH (both -> 6;
  // previously PATCH turned 0 into 1 via clampHops).
  const hopsProbe = await req('/api/rooms', {
    method: 'POST',
    body: JSON.stringify({ name: `smoke-hops-${Date.now()}`, maxHops: 'abc' }),
  })
  createdRooms.push(hopsProbe.id)
  const hopsPatched = await req(`/api/rooms/${hopsProbe.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ maxHops: 0 }),
  })
  const hopsOk = hopsProbe.maxHops === 6 && hopsPatched.maxHops === 6
  console.log(
    hopsOk
      ? '✓ room maxHops: 非法值在 create/PATCH 统一归一为 6'
      : `× room maxHops: create=${hopsProbe.maxHops} patch=${hopsPatched.maxHops}`,
  )
  if (!hopsOk) process.exitCode = 1

  // An empty workingDir falls back to the default workspace (the UI promises this).
  const dirProbe = await req('/api/rooms', {
    method: 'POST',
    body: JSON.stringify({ name: `smoke-dir-${Date.now()}` }),
  })
  createdRooms.push(dirProbe.id)
  const dirReset = await req(`/api/rooms/${settingsRoom.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ workingDir: '' }),
  })
  const dirOk = dirReset.workingDir === dirProbe.workingDir && dirReset.workingDir !== process.cwd()
  console.log(dirOk ? '✓ room workingDir: 空串恢复默认工作目录' : `× room workingDir: ${dirReset.workingDir}`)
  if (!dirOk) process.exitCode = 1

  // A valid PATCH trims and persists.
  const renamed = await req(`/api/rooms/${settingsRoom.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ name: '  smoke-改名  ', topic: ' 新主题 ', maxHops: 9 }),
  })
  const renameOk = renamed.name === 'smoke-改名' && renamed.topic === '新主题' && renamed.maxHops === 9
  console.log(
    renameOk
      ? '✓ room PATCH: 合法更新 trim 后落库'
      : `× room PATCH: ${renamed.name}/${renamed.topic}/${renamed.maxHops}`,
  )
  if (!renameOk) process.exitCode = 1

  // Room updates are broadcast over SSE so other tabs stay in sync.
  const broadcast = await patchAndListen(settingsRoom.id, { topic: '广播主题' })
  const sseOk = Boolean(broadcast && broadcast.topic === '广播主题')
  console.log(sseOk ? '✓ room SSE: PATCH 广播 room 事件' : '× room SSE: 未收到 room 事件')
  if (!sseOk) process.exitCode = 1

  /* ------------------------------------------- 7. CLI pid surfaced in meta */

  // A custom-harness turn spawns a real cmd.exe, so its reply must carry the
  // child's pid in meta — that's what the UI shows so stray processes can be
  // told apart from live ones.
  const pidRoom = await req('/api/rooms', {
    method: 'POST',
    body: JSON.stringify({ name: `smoke-pid-${Date.now()}`, workingDir: process.cwd(), maxHops: 4 }),
  })
  createdRooms.push(pidRoom.id)
  await req(`/api/rooms/${pidRoom.id}/characters`, {
    method: 'POST',
    body: JSON.stringify({
      name: '回声',
      harness: 'custom',
      model: '',
      persona: 'pid 探针',
      commandTemplate: 'echo smoke-pid-probe',
      triggers: quiet,
    }),
  })
  await req(`/api/rooms/${pidRoom.id}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content: '报告你的 pid' }),
  })
  await waitForReplies(pidRoom.id, 1)
  const pidMessages = (await req(`/api/rooms/${pidRoom.id}/messages?limit=20`)).messages
  const echo = pidMessages.find((message) => message.authorType === 'character')
  const pidOk = Boolean(
    echo && echo.content.includes('smoke-pid-probe') && Number.isInteger(echo.meta?.pid) && echo.meta.pid > 0,
  )
  console.log(pidOk ? `✓ cli pid: 回合消息带 CLI 进程 PID（${echo?.meta?.pid}）` : '× cli pid: meta.pid 缺失')
  if (!pidOk) process.exitCode = 1

  /* ---------------------------------- 8. alias mentions + long-term memory */

  // Aliases wake a character exactly like the primary name; an alias-looking
  // longer name must NOT prefix-match. 路人 is created first so the no-mention
  // fallback lands on it, proving @小千/@qwerty didn't spill over.
  const aliasRoom = await req('/api/rooms', {
    method: 'POST',
    body: JSON.stringify({ name: `smoke-alias-${Date.now()}`, workingDir: process.cwd(), maxHops: 4 }),
  })
  createdRooms.push(aliasRoom.id)
  await req(`/api/rooms/${aliasRoom.id}/characters`, {
    method: 'POST',
    body: JSON.stringify({ name: '路人', harness: 'mock', model: 'mock', persona: '旁观众', triggers: quiet }),
  })
  await req(`/api/rooms/${aliasRoom.id}/characters`, {
    method: 'POST',
    body: JSON.stringify({
      name: '千问',
      aliases: ['小千', 'qw'],
      harness: 'mock',
      model: 'mock',
      persona: '别名测试',
      triggers: quiet,
    }),
  })
  await req(`/api/rooms/${aliasRoom.id}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content: '@小千 用别名喊你' }),
  })
  await waitForTurnEnd(aliasRoom.id)
  let aliasAuthors = await characterAuthors(aliasRoom.id)
  const aliasOk = aliasAuthors.length === 1 && aliasAuthors[0] === '千问'
  console.log(aliasOk ? '✓ alias routing: @别名 只唤醒该角色' : `× alias routing failed: ${aliasAuthors.join(',')}`)
  if (!aliasOk) process.exitCode = 1

  await req(`/api/rooms/${aliasRoom.id}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content: '@qwerty 不该按前缀匹配' }),
  })
  await waitForTurnEnd(aliasRoom.id)
  aliasAuthors = await characterAuthors(aliasRoom.id)
  const aliasBoundaryOk = aliasAuthors.length === 2 && aliasAuthors[1] === '路人'
  console.log(
    aliasBoundaryOk
      ? '✓ alias boundary: @qwerty 不匹配别名 qw（fallback 路人）'
      : `× alias boundary failed: ${aliasAuthors.join(',')}`,
  )
  if (!aliasBoundaryOk) process.exitCode = 1

  // Long-term memory: room-scope notes are shared, identity-scope notes follow
  // the same-named character across rooms (docs/memory-plan.md PR1+PR3).
  const memRoom = await req('/api/rooms', {
    method: 'POST',
    body: JSON.stringify({ name: `smoke-memory-${Date.now()}`, workingDir: process.cwd(), maxHops: 4 }),
  })
  createdRooms.push(memRoom.id)
  const memoryChar = await req(`/api/rooms/${memRoom.id}/characters`, {
    method: 'POST',
    body: JSON.stringify({ name: '记忆侠', harness: 'mock', model: 'mock', persona: '记忆测试', triggers: quiet }),
  })
  const roomMem = await req(`/api/rooms/${memRoom.id}/memories`, {
    method: 'POST',
    body: JSON.stringify({ scope: 'room', kind: 'decision', content: '接口风格统一用 REST，不引入 GraphQL' }),
  })
  const identityMem = await req(`/api/rooms/${memRoom.id}/memories`, {
    method: 'POST',
    body: JSON.stringify({
      scope: 'identity',
      characterId: memoryChar.id,
      kind: 'preference',
      content: '偏好简洁的中文回复',
    }),
  })
  const duplicateMem = await req(`/api/rooms/${memRoom.id}/memories`, {
    method: 'POST',
    body: JSON.stringify({ scope: 'room', kind: 'fact', content: '接口风格统一用 REST，不引入 GraphQL' }),
  })
  const memWriteOk =
    roomMem.memory.scope === 'room' &&
    identityMem.memory.scope === 'identity' &&
    duplicateMem.existed === true &&
    duplicateMem.memory.id === roomMem.memory.id
  console.log(memWriteOk ? '✓ memory write: 落库 + 内容去重（重复写入返回已存在）' : '× memory write failed')
  if (!memWriteOk) process.exitCode = 1

  const probeMessage = await req(`/api/rooms/${memRoom.id}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content: '请模拟记忆' }),
  })
  await waitForTurnEnd(memRoom.id)
  let memReply = (await roomMessages(memRoom.id)).filter((message) => message.authorType === 'character').pop()
  const memInjectOk = Boolean(memReply && memReply.content.includes('长期 1 条，共享 1 条'))
  console.log(memInjectOk ? '✓ memory inject: 角色发言 prompt 携带长期+共享记忆' : `× memory inject failed: ${memReply?.content ?? 'no reply'}`)
  if (!memInjectOk) process.exitCode = 1

  // Cross-room persistence: a same-named character in ANOTHER room sees the
  // identity memory but not this room's shared notes.
  const memRoom2 = await req('/api/rooms', {
    method: 'POST',
    body: JSON.stringify({ name: `smoke-memory2-${Date.now()}`, workingDir: process.cwd(), maxHops: 4 }),
  })
  createdRooms.push(memRoom2.id)
  await req(`/api/rooms/${memRoom2.id}/characters`, {
    method: 'POST',
    body: JSON.stringify({ name: '记忆侠', harness: 'mock', model: 'mock', persona: '另一个房间的同名角色', triggers: quiet }),
  })
  await req(`/api/rooms/${memRoom2.id}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content: '请模拟记忆' }),
  })
  await waitForTurnEnd(memRoom2.id)
  const memReply2 = (await roomMessages(memRoom2.id)).filter((message) => message.authorType === 'character').pop()
  const crossRoomOk = Boolean(memReply2 && memReply2.content.includes('长期 1 条，共享 0 条'))
  console.log(
    crossRoomOk
      ? '✓ cross-room identity: 同名角色在另一房间看到身份记忆（不含房间共享）'
      : `× cross-room identity failed: ${memReply2?.content ?? 'no reply'}`,
  )
  if (!crossRoomOk) process.exitCode = 1

  // API surface: grouped listing, pin/unpin, delete, and the one-click
  // "记住" (user note → shared room memory).
  const memList = await req(`/api/rooms/${memRoom.id}/memories`)
  const listOk =
    memList.room.length === 1 &&
    memList.members.length === 1 &&
    memList.members[0].name === '记忆侠' &&
    memList.members[0].memories.length === 1
  console.log(listOk ? '✓ memory list: 按房间/角色分组返回' : '× memory list failed')
  if (!listOk) process.exitCode = 1

  const pinnedMem = await req(`/api/memories/${roomMem.memory.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ pinned: true }),
  })
  const pinOk = pinnedMem.pinned === true
  console.log(pinOk ? '✓ memory pin: PATCH 钉选生效' : '× memory pin failed')
  if (!pinOk) process.exitCode = 1

  const remembered = await req(`/api/rooms/${memRoom.id}/memories`, {
    method: 'POST',
    body: JSON.stringify({ fromMessageId: probeMessage.id }),
  })
  const rememberOk = remembered.memory.scope === 'room' && remembered.memory.kind === 'fact'
  console.log(rememberOk ? '✓ memory remember: 用户消息一键记入房间共享（fact）' : '× memory remember failed')
  if (!rememberOk) process.exitCode = 1

  await req(`/api/memories/${identityMem.memory.id}`, { method: 'DELETE' })
  const afterDelete = await req(`/api/rooms/${memRoom.id}/memories`)
  const deleteOk = !afterDelete.members[0].memories.some((memory) => memory.id === identityMem.memory.id)
  console.log(deleteOk ? '✓ memory delete: 删除后列表不再包含' : '× memory delete failed')
  if (!deleteOk) process.exitCode = 1

  /* -------- 9. call-name conflicts, >500-char memory dedup, mid-turn re-@ */

  // Two characters must not share a call-name: the API turns the conflict
  // into a 400 the editor can show inline (create AND update paths).
  const conflictRoom = await req('/api/rooms', {
    method: 'POST',
    body: JSON.stringify({ name: `smoke-conflict-${Date.now()}`, workingDir: process.cwd(), maxHops: 4 }),
  })
  createdRooms.push(conflictRoom.id)
  await req(`/api/rooms/${conflictRoom.id}/characters`, {
    method: 'POST',
    body: JSON.stringify({ name: '甲', harness: 'mock', model: 'mock', persona: '原名', triggers: quiet }),
  })
  const conflictCreate = await statusOf(`/api/rooms/${conflictRoom.id}/characters`, {
    method: 'POST',
    body: JSON.stringify({ name: '乙', aliases: ['甲'], harness: 'mock', model: 'mock', persona: '撞名', triggers: quiet }),
  })
  const charB = await req(`/api/rooms/${conflictRoom.id}/characters`, {
    method: 'POST',
    body: JSON.stringify({ name: '乙', harness: 'mock', model: 'mock', persona: '后创建', triggers: quiet }),
  })
  const conflictPatch = await statusOf(`/api/characters/${charB.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ aliases: ['甲'] }),
  })
  const conflictOk = conflictCreate === 400 && conflictPatch === 400
  console.log(
    conflictOk
      ? '✓ call-name conflict: 名字/别名撞车返回 400（create + PATCH）'
      : `× call-name conflict: create=${conflictCreate} patch=${conflictPatch}（期望 400/400）`,
  )
  if (!conflictOk) process.exitCode = 1

  // Dedup must happen on the TRUNCATED content: a >500-char message saved
  // twice used to insert two rows (dedup saw 600 chars, storage saw 500).
  const longContent = '超长记忆'.repeat(150) // 600 chars > 500 cap
  const longFirst = await req(`/api/rooms/${memRoom.id}/memories`, {
    method: 'POST',
    body: JSON.stringify({ scope: 'room', kind: 'fact', content: longContent }),
  })
  const longSecond = await req(`/api/rooms/${memRoom.id}/memories`, {
    method: 'POST',
    body: JSON.stringify({ scope: 'room', kind: 'fact', content: longContent }),
  })
  const longDedupOk = longSecond.existed === true && longSecond.memory.id === longFirst.memory.id
  console.log(longDedupOk ? '✓ long memory dedup: >500 字内容二次写入命中去重' : '× long memory dedup: 插入了重复行')
  if (!longDedupOk) process.exitCode = 1

  // @-ing a character that is mid-turn queues a follow-up run for right
  // after (previously the mention was silently dropped by the dedupe).
  // 慢郎中 runs a ~3s custom command so the busy window is catchable.
  const requeueRoom = await req('/api/rooms', {
    method: 'POST',
    body: JSON.stringify({ name: `smoke-requeue-${Date.now()}`, workingDir: process.cwd(), maxHops: 4 }),
  })
  createdRooms.push(requeueRoom.id)
  await req(`/api/rooms/${requeueRoom.id}/characters`, {
    method: 'POST',
    body: JSON.stringify({
      name: '慢郎中',
      harness: 'custom',
      model: '',
      persona: '慢回合探针',
      commandTemplate: 'ping -n 4 127.0.0.1',
      triggers: quiet,
    }),
  })
  await req(`/api/rooms/${requeueRoom.id}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content: '第一轮' }),
  })
  let sawBusy = false
  for (let i = 0; i < 50; i++) {
    const state = await req(`/api/rooms/${requeueRoom.id}/state`)
    if (state.busy) {
      sawBusy = true
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  if (sawBusy) {
    await req(`/api/rooms/${requeueRoom.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content: '@慢郎中 第二轮追加' }),
    })
    await waitForReplies(requeueRoom.id, 2)
    const requeueAuthors = await characterAuthors(requeueRoom.id)
    const requeueOk = requeueAuthors.length === 2 && requeueAuthors.every((name) => name === '慢郎中')
    console.log(
      requeueOk
        ? '✓ mid-turn re-@: 正在发言时再 @ 会排队追加一轮（2 次回复）'
        : `× mid-turn re-@: 期望 2 轮回复，实际 ${requeueAuthors.join(',')}`,
    )
    if (!requeueOk) process.exitCode = 1
  } else {
    console.log('× mid-turn re-@: 未观察到 busy 窗口（测试自身超时）')
    process.exitCode = 1
  }

  if (process.exitCode !== 1) console.log('\nOK: smoke passed')
} finally {
  for (const id of createdRooms) await req(`/api/rooms/${id}`, { method: 'DELETE' }).catch(() => {})
  for (const id of createdPresets) await req(`/api/presets/${id}`, { method: 'DELETE' }).catch(() => {})
}
