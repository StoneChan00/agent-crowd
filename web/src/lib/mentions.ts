import type { Character } from '../types'

export type MentionTarget =
  | { kind: 'all' }
  | { kind: 'member'; name: string; color: string }
  /** Not a call-name in this room: the raw token renders as plain text and wakes nobody. */
  | { kind: 'plain' }

/**
 * Resolve one `@token` against the room's characters, for the message body
 * highlight. Kept pure and separate from the component so
 * `scripts/mention-check.mjs` can assert the invariant that matters:
 * **a tinted chip means the router really woke someone, and nothing else.**
 *
 * `all` / `所有人` is a broadcast handled by ALL_MENTION, not by a
 * per-character match. Everything else must EQUAL a call-name (case-
 * insensitive) — a prefix is not a call, so `@鱼头` must not light up 鱼.
 */
export function resolveMention(
  token: string,
  characters: Pick<Character, 'name' | 'aliases' | 'color'>[],
): MentionTarget {
  const needle = token.toLowerCase()
  if (needle === 'all' || token === '所有人') return { kind: 'all' }
  const member = characters.find(
    (item) => item.name.toLowerCase() === needle || item.aliases.some((alias) => alias.toLowerCase() === needle),
  )
  return member ? { kind: 'member', name: member.name, color: member.color } : { kind: 'plain' }
}
