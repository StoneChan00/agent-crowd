// Server-side restart request queue (staged - to be copied to server/restart.ts
// by scripts/staged/apply-restart.mjs once reviewed; see server-restart-plan.md).
//
// Why this file exists: an external script that polls "wait until all rooms
// idle" self-locks in the 多agent协同 group - the review loop (report ->
// review -> reply) keeps the room busy forever, and a 1500s drain deadline
// aborts with the old watch chain untouched (proven twice on 2026-11-02).
// Here the server holds the pending request instead, and the natural end of
// the relay chain - pump()'s finally on the LAST turn, when queues and active
// turns are all empty - is the millisecond-wide moment the restart fires.
//
// HOW the script is launched (this is load-bearing, proven on this machine
// 2026-11-03, experiments E1-E7): a script spawned as a CHILD of the server
// can NEVER do the kill - killing one's own spawn-parent takes the killer
// down with it, on every spawn topology (node spawn, two-level node chain,
// WMI-spawned driver), with taskkill /F and .NET Process.Kill() alike; the
// script dies mid-phase-2 and phases 3-6 never run (full outage - the exact
// P0-2 failure Deepseek flagged, one level deeper than the /T tree kill he
// saw). Killing NON-ancestors is safe. Therefore the script must have NO
// parent in the tree it kills, and detached spawning is not an option
// either (DETACHED_PROCESS makes PowerShell 5.1 exit 0 without running
// anything - diag A/B/C/E/F, 2026-11-02). The only proven-safe shape: a
// one-shot launcher (this process' child, lives ~1s) invokes WMI
// Win32_Process.Create to launch the REAL script - a WMI-created process
// has no parent in our tree, survives the phase-2 kills, and has no console
// at all, so console-ctrl deaths (0xC000013A, twice via Task Scheduler) are
// structurally unreachable too. E7 verified the exact main-path form:
// WMI-created script taskkills a two-level node chain and finishes alive.
// Cross-run mutual exclusion is the script's job (data/restart-verify.lock,
// see restart-and-verify.ps1) so it also covers external/manual firings.
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as db from './db.ts'
import { broadcast } from './events.ts'
// Circular with orchestrator (it calls maybeRestartNow, we call isBusy): safe
// under ESM late binding - both sides only call functions at runtime, never
// at module top level.
import { isBusy } from './orchestrator.ts'

/** Mirrors server/index.ts (AC_PORT wins, then PORT, then 8787). */
const PORT = Number(process.env.AC_PORT ?? process.env.PORT ?? 8787)
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = join(REPO_ROOT, 'scripts', 'restart-and-verify.ps1')
/**
 * Absolute path everywhere an executable is named - for spawn() itself and
 * as the first token of the WMI CommandLine below (that token is resolved
 * by WmiPrvSE against ITS search path; bare 'powershell.exe' happens to
 * resolve on this machine - lane2 V1, 2026-11-03 - but an absolute path is
 * deterministic and never depends on a mutated PATH).
 */
const POWERSHELL = join(
  process.env.SystemRoot ?? 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
)
/**
 * Soft window in which a second POST /api/restart gets a 409 after a launch.
 * The script's OWN lock (data/restart-verify.lock, pid-liveness checked) is
 * the authoritative cross-run guard; this window only avoids pointless
 * re-launches that the lock would immediately ABORT. Must comfortably cover
 * the script's full budget: 40s phase0 + DrainSeconds (default 3000s) +
 * kill/start/verify (~4min) => 60min.
 *
 * The server never learns the script ABORTed (WMI is fire-and-forget), so
 * this window does NOT lift itself after an abort - `force=true` on the
 * next request is the documented escape (P1, review round 5): it skips and
 * CLEARS `launchedAt`. It never bypasses `pending`/`launching`, the hard
 * anti-double-spawn guards.
 */
const IN_FLIGHT_WINDOW_MS = 60 * 60 * 1000

export interface RestartOptions {
  /**
   * Room whose busy state never blocks the restart. Emergency lane: busy
   * there is ignored, and any turn running there IS interrupted at
   * switchover (the group is told so, via the start notice).
   */
  excludeRoom?: string
  /** Room that receives the script's start notice + RESULT as system messages. */
  notifyRoom?: string
  /** Passed through to the script's -DrainSeconds. */
  drainSeconds?: number
}

let pending: RestartOptions | null = null
/**
 * True while the one-shot WMI launcher is in flight (spawn() returned, its
 * exit/error callback not yet fired - it lives ~1-3s). The gap this closes
 * (P0, review round 4): after maybeRestartNow() nulls `pending` and before
 * the exit callback sets `launchedAt`, BOTH checks in requestRestart were
 * empty - a second POST was accepted, and the route's own
 * maybeRestartNow() re-launched a second WMI script while the first was
 * still being created. The script-side lock must never be the only line of
 * defense (its own acquisition had a Test-Path→Set-Content window). This
 * flag is fully synchronous: requestRestart checks it without any await
 * boundary, and the JS single thread cannot interleave inside it.
 */
let launching = false
/**
 * Timestamp of the last SUCCESSFUL WMI launch (launcher exited 0). 0 = none.
 * Replaces the old child-handle flag: we have no child relationship with the
 * launched script (that is the whole point of WMI), so its exit is
 * invisible - after the window expires a new request is accepted and the
 * script-side lock decides if a run is actually still in flight.
 */
let launchedAt = 0

export function pendingRestart(): RestartOptions | null {
  return pending
}

/**
 * Why a restart request was refused - the route maps each value to a TRUE
 * user-facing message (P1, review round 5: a window-blocked retry used to
 * hear "已有待执行的重启请求", a lie - nothing was pending, the script had
 * ABORTed and the server could not know).
 */
export type RestartRejectReason =
  | 'invalid-room-name'
  | 'pending'
  | 'launching'
  | 'in-flight-window'

/**
 * Queue a restart for the next all-idle moment. Idempotent: a second call
 * while one is pending (or a launcher in flight, or within the soft
 * in-flight window after a launch) is rejected so the API can surface a 409
 * instead of double-launching scripts the lock would just ABORT anyway.
 * `force` only lifts that soft window - the escape hatch for "the script
 * ABORTed, retry now": it skips and clears `launchedAt`, but never bypasses
 * `pending`/`launching` (a force that jumped those would race two scripts
 * exactly like the P0 gap did).
 */
export function requestRestart(
  options: RestartOptions,
  force = false,
): { ok: boolean; reason?: RestartRejectReason } {
  // These values end up inside a WMI CommandLine built by the launcher;
  // quotes would break it. Room names here never legitimately need them.
  for (const value of [options.excludeRoom, options.notifyRoom]) {
    if (value !== undefined && /["']/.test(value)) return { ok: false, reason: 'invalid-room-name' }
  }
  if (pending) return { ok: false, reason: 'pending' }
  // Launcher in flight (~1-3s between pending=null and launchedAt being set):
  // refuse here so the API surfaces 409 - the script-side lock is the LAST
  // line of defense, never the only one (P0, review round 4).
  if (launching) return { ok: false, reason: 'launching' }
  if (launchedAt > 0 && !force && Date.now() - launchedAt < IN_FLIGHT_WINDOW_MS) {
    return { ok: false, reason: 'in-flight-window' }
  }
  if (force && launchedAt > 0) {
    console.log('[agent-crowd] restart: force=true cleared the soft in-flight window')
  }
  launchedAt = 0
  pending = { ...options }
  return { ok: true }
}

/** Escape for a PowerShell single-quoted string literal ('' for '). */
const psq = (s: string): string => `'${s.replace(/'/g, "''")}'`

/**
 * Quote one argument for the WMI CommandLine (CreateProcess-style parsing):
 * values with spaces get double quotes; double quotes are already rejected
 * in requestRestart, so they can never appear here.
 */
const shellWord = (s: string): string => (/[ \t]/.test(s) ? `"${s}"` : s)

/**
 * Execute a pending restart if every room (minus excludeRoom) is idle right
 * now. Called from index.ts right after POST /api/restart responds, and from
 * orchestrator pump()'s finally - i.e. at the end of EVERY turn. The whole
 * check -> notice -> spawn path is synchronous, so no new turn can start in
 * the middle of it (JS runs to completion between events); the only
 * in-flight interruption still possible is the one excludeRoom signed up
 * for. After the launch, the server STAYS UP (still serving traffic) until
 * the script's phase 2 kills it together with the whole watch chain.
 */
export function maybeRestartNow(): void {
  const options = pending
  if (!options) return
  // Defensive invariant: while a launcher is in flight pending stays null (a
  // failure callback clears the flag before restoring the request), so this
  // should be unreachable - but a re-entry here would double-launch.
  if (launching) return
  const rooms = db.listRooms()
  const busyRooms = rooms.filter((room) => room.name !== options.excludeRoom && isBusy(room.id))
  if (busyRooms.length > 0) return // not idle yet; the next pump() finally retries

  pending = null
  // Occupy the in-flight slot in the SAME synchronous block that nulls
  // pending: from the next event-loop tick until the exit callback below,
  // requestRestart must keep refusing. There is no interleaving inside
  // this function (it runs to completion), so this closes the whole gap.
  launching = true
  // Last chance to be heard: every room (excluded or not) gets a system
  // notice while the server can still write to the db.
  for (const room of rooms) {
    const notice = db.addMessage({
      roomId: room.id,
      authorType: 'system',
      authorName: '系统',
      content: '🔁 服务器重启中（加载已部署代码）：几秒中断后自动恢复，期间请勿发消息，完成后会播报验证结果。',
      meta: { generated: true },
    })
    broadcast(room.id, 'message', { roomId: room.id, message: notice })
  }

  // Proof of ownership for the script's phase 2: it must see THIS pid still
  // listening on the port before it kills anything. A mismatch means the
  // port changed hands (watch reload re-spawned a server / a stranger took
  // it) and the script aborts instead of killing someone else's chain.
  // POWERSHELL, never a bare 'powershell.exe': the first CommandLine token
  // is resolved by WmiPrvSE, not by us - same absolute-path rule as the
  // spawn() call that runs the launcher itself.
  const scriptArgs = [
    POWERSHELL, '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', SCRIPT,
    '-Port', String(PORT),
    '-TakeoverPid', String(process.pid),
  ]
  if (options.excludeRoom) scriptArgs.push('-ExcludeRoom', options.excludeRoom)
  if (options.notifyRoom) scriptArgs.push('-NotifyRoom', options.notifyRoom)
  if (options.drainSeconds) scriptArgs.push('-DrainSeconds', String(options.drainSeconds))
  const commandLine = scriptArgs.map(shellWord).join(' ')

  // One-shot launcher (a ~1s child of this process - it is dead long before
  // phase 2, and it kills nothing): WMI-creates the real script. -EncodedCommand
  // (base64 UTF-16LE) sidesteps every quoting/escaping pitfall, including
  // Chinese room names. The launcher exiting 0 means Win32_Process.Create
  // returned ReturnValue 0 (process created); non-zero means the launch
  // failed - then the request goes back to pending for the next idle moment.
  const launcherCode = [
    `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${psq(commandLine)} }`,
    'if ($r.ReturnValue -ne 0) { exit 1 }',
    'exit 0',
  ].join('; ')
  const encoded = Buffer.from(launcherCode, 'utf16le').toString('base64')

  let launcher
  try {
    launcher = spawn(
      POWERSHELL,
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      // stderr piped, not ignored: a refused WMI create must be able to say
      // WHY. The 2026-11-03 morning round saw "launcher exit 1" with the
      // cause swallowed by stdio:'ignore'; the buffered tail only surfaces
      // on failure, so the routine CLIXML progress noise stays silent.
      { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, cwd: REPO_ROOT },
    )
    launcher.unref()
  } catch (error) {
    // Spawn threw synchronously (bad args / broken env): keep the request
    // pending so the next turn end retries, and leave the server running.
    launching = false
    pending = { ...options }
    console.error('[agent-crowd] restart: launcher spawn threw, request kept pending:', error)
    return
  }
  if (typeof launcher.pid !== 'number') {
    // ENOENT-style failures land as an async 'error' event, which the
    // handlers below only log; a missing pid is their synchronous tell.
    launching = false
    pending = { ...options }
    console.error('[agent-crowd] restart: launcher spawn produced no pid, request kept pending')
    return
  }
  const backToPending = (why: string) => {
    // The in-flight slot is free again; put the request back UNLESS a newer
    // POST already queued its own request while the launcher was in flight
    // - never clobber that (with `launching` refusing second POSTs this is
    // pure defense, but keep it: fail-safe, not luck-safe).
    launching = false
    if (pending === null) pending = { ...options }
    console.error(`[agent-crowd] restart: ${why}`)
  }
  let stderrTail = ''
  launcher.stderr?.on('data', (chunk) => {
    stderrTail = (stderrTail + String(chunk)).slice(-2000)
  })
  launcher.on('error', (error) => backToPending(`launcher errored, request kept pending: ${error}`))
  launcher.on('exit', (code) => {
    if (code === 0) {
      // WMI create succeeded: the soft window takes over from the flag.
      launching = false
      launchedAt = Date.now()
      return
    }
    backToPending(
      `launcher exited code=${code} (WMI create refused), request kept pending;` +
        ` launcher stderr tail: ${stderrTail.trim().slice(-400)}`,
    )
  })
  // From here on the script is on its own: it kills this process (and the
  // watch chain above it) at phase 2, having proven by -TakeoverPid that the
  // port is still ours, and posts its verdict to the rooms via -NotifyRoom.
  // KEEP SERVING until then - exiting earlier would leave the port unowned
  // while the tsx watch stays armed, and the next server/*.ts save would
  // respawn a second server into a port race (the exact failure mode this
  // restart exists to remove).
}
