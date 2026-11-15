import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Builtin-library avatars: the five 128px PNGs (GLM / DeepSeek / Qwen /
 * Claude / GPT) captured verbatim from the live character library this
 * project ships as its default seed (see builtinPresets in db.ts). Stored as
 * binary files instead of base64 literals — a ~254KB blob in source would be
 * unmaintainable — and rebuilt into data URLs at module load, which is the
 * exact form the avatar column (and the web cropper's export) uses.
 */

function avatarDataUrl(file: string): string {
  const png = readFileSync(fileURLToPath(new URL(`./seed/${file}`, import.meta.url)))
  return `data:image/png;base64,${png.toString('base64')}`
}

export const SEED_AVATAR_GLM = avatarDataUrl('glm.png')
export const SEED_AVATAR_DEEPSEEK = avatarDataUrl('deepseek.png')
export const SEED_AVATAR_QWEN = avatarDataUrl('qwen.png')
export const SEED_AVATAR_CLAUDE = avatarDataUrl('claude.png')
export const SEED_AVATAR_GPT = avatarDataUrl('gpt.png')
