import type { HarnessKind } from '../types.ts'
import { cannbotAdapter } from './cannbot.ts'
import { customAdapter } from './custom.ts'
import { dshAdapter } from './dsh.ts'
import { hermesAdapter } from './hermes.ts'
import { mockAdapter } from './mock.ts'
import { opencodeAdapter } from './opencode.ts'
import type { HarnessAdapter } from './types.ts'

const adapters: Record<HarnessKind, HarnessAdapter> = {
  mock: mockAdapter,
  opencode: opencodeAdapter,
  cannbot: cannbotAdapter,
  dsh: dshAdapter,
  hermes: hermesAdapter,
  custom: customAdapter,
}

export function getAdapter(kind: HarnessKind): HarnessAdapter {
  return adapters[kind] ?? mockAdapter
}

export function listAdapters(): HarnessAdapter[] {
  return [opencodeAdapter, cannbotAdapter, dshAdapter, hermesAdapter, mockAdapter, customAdapter]
}

/** Model suggestions per harness, cached to keep the character editor snappy. */
export async function listModels(): Promise<Record<string, string[]>> {
  const cache = modelCache
  if (cache && Date.now() - cache.at < 5 * 60_000) return cache.value

  const entries = await Promise.all(
    listAdapters().map(async (adapter) => {
      if (!adapter.listModels) return [adapter.id, [] as string[]] as const
      try {
        return [adapter.id, await adapter.listModels()] as const
      } catch {
        return [adapter.id, [] as string[]] as const
      }
    }),
  )
  const value = Object.fromEntries(entries)
  modelCache = { at: Date.now(), value }
  return value
}

/**
 * Non-blocking model lookup: returns whatever is cached (possibly nothing) and
 * refreshes in the background. Keeping this off the bootstrap path means the
 * chat UI paints immediately instead of waiting on `opencode models`.
 */
export function cachedModels(): Record<string, string[]> {
  if (!modelCache) {
    void listModels().catch(() => {
      /* the next call retries */
    })
  }
  return modelCache?.value ?? {}
}

let modelCache: { at: number; value: Record<string, string[]> } | null = null

export type { HarnessAdapter } from './types.ts'
