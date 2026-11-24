import type { Character, HarnessKind } from './types.ts'

/**
 * B14: one reviewer-selection rule shared by auto blind review and the
 * post-commit blind-review endpoint.
 *
 * 1. A designated reviewer is authoritative — if it is ineligible we return
 *    nothing (the gate would reject a stand-in anyway) and the caller warns.
 * 2. Otherwise prefer characters tagged `reviewer`, then fall back to any
 *    eligible character so rooms predating role tags keep working.
 * 3. Eligibility: enabled, not a round-end summarizer, not the author, and a
 *    different harness from the author.
 */
export interface ReviewerChoice {
  reviewer: Character | null
  reason?: 'designated-ineligible' | 'no-candidate'
}

export function pickReviewer(input: {
  characters: Character[]
  designatedId: string | null | undefined
  author: { id: string; harness: string } | null
}): ReviewerChoice {
  const eligible = (character: Character): boolean =>
    character.enabled &&
    !character.triggers.onRoundEnd &&
    (input.author === null || (character.id !== input.author.id && character.harness !== input.author.harness))

  if (input.designatedId) {
    const designated = input.characters.find((character) => character.id === input.designatedId)
    if (!designated || !eligible(designated)) return { reviewer: null, reason: 'designated-ineligible' }
    return { reviewer: designated }
  }

  const tagged = input.characters.find((character) => character.roles.includes('reviewer') && eligible(character))
  if (tagged) return { reviewer: tagged }
  const fallback = input.characters.find(eligible)
  return fallback ? { reviewer: fallback } : { reviewer: null, reason: 'no-candidate' }
}

/**
 * B15: only an INDEPENDENT reviewer's CHANGES may trigger automatic repair.
 * The verdict must come from the reviewer this round actually used (explicit
 * designation or the pool selection), and must differ from the implementer —
 * same character or same harness is not independent.
 */
export function isIndependentReviewerVerdict(input: {
  verdictAuthor: { id: string; harness: string } | null | undefined
  changedAuthor: { id: string; harness: string } | null | undefined
  designatedId: string | null | undefined
  poolReviewerId: string | null | undefined
}): boolean {
  if (!input.verdictAuthor || !input.changedAuthor) return false
  if (input.verdictAuthor.id === input.changedAuthor.id) return false
  if (input.verdictAuthor.harness === input.changedAuthor.harness) return false
  const expected = input.designatedId || input.poolReviewerId || null
  return expected !== null && input.verdictAuthor.id === expected
}

export interface ResolvedReviewer {
  reviewer: { id: string; name: string; harness: HarnessKind } | null
  eligible: boolean
}

/**
 * B15: re-read the reviewer's CURRENT state at gate time. A pool reviewer
 * that was deleted/disabled (or had its harness changed) after being queued
 * must not be trusted from the enqueue-time snapshot. Missing pool reviewer
 * fails closed; a missing DESIGNATED reviewer keeps the legacy "no
 * designation" behavior (deleteCharacter already clears the pointer).
 */
export function resolveRoundReviewer(input: {
  designatedId: string | null | undefined
  poolReviewer: { id: string; name: string; harness: HarnessKind } | null | undefined
  characters: Character[]
}): ResolvedReviewer {
  if (input.designatedId) {
    const designated = input.characters.find((character) => character.id === input.designatedId)
    if (!designated) return { reviewer: null, eligible: true }
    return {
      reviewer: { id: designated.id, name: designated.name, harness: designated.harness },
      eligible: designated.enabled && !designated.triggers.onRoundEnd,
    }
  }
  if (input.poolReviewer) {
    const pool = input.poolReviewer
    const current = input.characters.find((character) => character.id === pool.id)
    if (!current) return { reviewer: pool, eligible: false }
    return {
      reviewer: { id: current.id, name: current.name, harness: current.harness },
      eligible: current.enabled && !current.triggers.onRoundEnd,
    }
  }
  return { reviewer: null, eligible: true }
}
