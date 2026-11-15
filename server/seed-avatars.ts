import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Builtin-library avatars: the five 128px PNGs (GLM / DeepSeek / Qwen /
 * Claude / GPT) captured verbatim from the live character library this
 * project ships as its default seed (see builtinPresets in db.ts). Stored as
 * binary files instead of base64 literals — a ~254KB blob in source would be
 * unmaintainable — and rebuilt into data URLs, the exact form the avatar
 * column (and the web cropper's export) uses.
 *
 * Loading is DEFERRED to builtinPresets() and never runs at import time: a
 * repo copy missing server/seed/*.png (partial clone, filtered transfer)
 * must not take the server down before it opens its database — and an
 * already-seeded database never needs the PNGs at all. An unreadable file
 * degrades that one seed slot to an emoji avatar with a loud console error.
 */

function avatarOrEmoji(file: string, fallback: string): string {
  try {
    const png = readFileSync(fileURLToPath(new URL(`./seed/${file}`, import.meta.url)))
    return `data:image/png;base64,${png.toString('base64')}`
  } catch (error) {
    console.error(
      `[agent-crowd] seed avatar ${file} unreadable (${error instanceof Error ? error.message : error}) — seeding ${fallback} instead; check server/seed/ in this copy of the repo`,
    )
    return fallback
  }
}

export function loadSeedAvatars(): { glm: string; deepseek: string; qwen: string; claude: string; gpt: string } {
  return {
    glm: avatarOrEmoji('glm.png', '🤖'),
    deepseek: avatarOrEmoji('deepseek.png', '🔍'),
    qwen: avatarOrEmoji('qwen.png', '📊'),
    claude: avatarOrEmoji('claude.png', '🎨'),
    gpt: avatarOrEmoji('gpt.png', '🚀'),
  }
}
