import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'

/**
 * The chat markdown pipeline for role replies, in one place:
 *   - gfm: tables / strikethrough / task lists;
 *   - breaks: a single `\n` is a HARD newline, not a CommonMark soft break.
 *
 * Without `breaks` every reply rendered with its newlines collapsed onto
 * one line — and `tsc` / `vite build` both stayed green through that bug.
 * `scripts/markdown-breaks-check.mjs` renders through THIS array (plus a
 * static wiring check on MessageList) so the contract stays observable.
 *
 * Plain-text surfaces (`.system-pill`, `.user-text`, `.live-text`,
 * `.memory-content`) don't go through markdown at all; they keep the same
 * newline contract via `white-space: pre-wrap` + `word-break: break-word`
 * in styles.css, asserted by the same script.
 */
export const markdownRemarkPlugins = [remarkGfm, remarkBreaks]
