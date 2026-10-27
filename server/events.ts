import type { Response } from 'express'

interface Subscriber {
  roomId: string
  res: Response
}

const subscribers = new Set<Subscriber>()

/** Attach an SSE client to one room (or '*' for every room). */
export function subscribe(roomId: string, res: Response): () => void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.write('retry: 3000\n\n')

  const subscriber: Subscriber = { roomId, res }
  subscribers.add(subscriber)

  // Idempotent teardown: registered here on res close/error AND in index.ts
  // on req close/error, so any of the four paths can run first without the
  // others double-unsubscribing harmfully.
  const cleanup = () => {
    clearInterval(heartbeat)
    subscribers.delete(subscriber)
    try {
      res.end()
    } catch {
      /* already closed */
    }
  }

  const heartbeat = setInterval(() => {
    if (res.writableEnded || res.destroyed) {
      cleanup()
      return
    }
    try {
      res.write(': ping\n\n')
    } catch {
      /* client is gone; cleanup happens on close */
    }
  }, 15_000)

  // A dropped connection (network cut, tab kill, proxy reset) surfaces as an
  // async 'error' event on the response — with no listener that's an
  // uncaughtException that takes the whole server down (`exited with code 1`).
  // 'close' fires on normal teardowns; both routes lead to cleanup.
  res.on('error', cleanup)
  res.on('close', cleanup)

  return cleanup
}

/** Write one SSE frame to a single client. */
export function send(res: Response, event: string, data: unknown): void {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  } catch {
    /* client already gone; the close handler unsubscribes */
  }
}

export function broadcast(roomId: string, event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  for (const subscriber of subscribers) {
    if (subscriber.roomId !== roomId && subscriber.roomId !== '*') continue
    try {
      subscriber.res.write(payload)
    } catch {
      /* drop broken pipe; the close handler unsubscribes */
    }
  }
}

export function subscriberCount(roomId?: string): number {
  if (!roomId) return subscribers.size
  let count = 0
  for (const subscriber of subscribers) {
    if (subscriber.roomId === roomId) count += 1
  }
  return count
}
