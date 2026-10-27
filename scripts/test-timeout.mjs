/**
 * Unit + behavioral tests for the turn limits in `process.ts` — the single
 * source of truth every harness must use for `AC_TURN_TIMEOUT_MS` /
 * `AC_IDLE_TIMEOUT_MS`. Guards the footguns that bit us:
 *   - `30m` used to parse as NaN and silently DISABLE the timeout;
 *   - a bare `30` (meaning "30 minutes" in the operator's head) meant 30 ms,
 *     killing every turn instantly;
 *   - hermes once bypassed this helper and reintroduced both bugs;
 *   - a turn that kept streaming used to die at the wall-clock cap
 *     mid-reply — the idle watchdog must kill only SILENT processes;
 *   - the auto-retry gate must re-run FAST zero-text failures but never
 *     timeouts (rerunning a hang just doubles the wait);
 *   - the boot sweep must verify a persisted pid still belongs to us
 *     before taskkill /T /F (pid recycling after a crash/reload is real).
 *
 *   node scripts/test-timeout.mjs
 */
import {
  runProcess,
  turnTimeoutMs,
  idleTimeoutMs,
  DEFAULT_TURN_TIMEOUT_MS,
  DEFAULT_IDLE_TIMEOUT_MS,
  isTransientFailure,
  pidMatchesLaunch,
  probePid,
  RETRY_MAX_TRANSIENT_MS,
} from '../server/harnesses/process.ts'

let failed = 0
const cases = [
  ['unset → default', undefined, DEFAULT_TURN_TIMEOUT_MS],
  ['empty string → default', '', DEFAULT_TURN_TIMEOUT_MS],
  ['garbage → default', 'abc', DEFAULT_TURN_TIMEOUT_MS],
  ['zero → default', '0', DEFAULT_TURN_TIMEOUT_MS],
  ['negative → default', '-5', DEFAULT_TURN_TIMEOUT_MS],
  ['plain ms passes through', '1800000', 1800000],
  ['suffix m', '30m', 1800000],
  ['suffix s', '90s', 90000],
  ['suffix h', '2h', 7200000],
  ['explicit ms suffix', '120000ms', 120000],
  ['float duration', '1.5m', 90000],
  ['bare small number is a unit mistake → default', '30', DEFAULT_TURN_TIMEOUT_MS],
  ['below the 60s floor → default', '45s', DEFAULT_TURN_TIMEOUT_MS],
]

for (const [name, value, expected] of cases) {
  if (value === undefined) delete process.env.AC_TURN_TIMEOUT_MS
  else process.env.AC_TURN_TIMEOUT_MS = value
  const actual = turnTimeoutMs()
  if (actual === expected) {
    console.log(`✓ ${name}`)
  } else {
    console.log(`× ${name}: expected ${expected}, got ${actual}`)
    failed += 1
  }
}

const idleCases = [
  ['idle: unset → default', undefined, DEFAULT_IDLE_TIMEOUT_MS],
  ['idle: empty string → default', '', DEFAULT_IDLE_TIMEOUT_MS],
  ['idle: garbage → default', 'abc', DEFAULT_IDLE_TIMEOUT_MS],
  ['idle: off → disabled', 'off', 0],
  ['idle: none → disabled', 'none', 0],
  ['idle: 0 → disabled', '0', 0],
  ['idle: below the 10s floor → default', '5s', DEFAULT_IDLE_TIMEOUT_MS],
  ['idle: bare small number is a unit mistake → default', '30', DEFAULT_IDLE_TIMEOUT_MS],
  ['idle: at the floor passes', '10s', 10_000],
  ['idle: suffix s', '20s', 20_000],
  ['idle: suffix m', '8m', 480_000],
  ['idle: suffix h', '1h', 3_600_000],
  ['idle: plain ms passes through', '45000', 45_000],
]

for (const [name, value, expected] of idleCases) {
  if (value === undefined) delete process.env.AC_IDLE_TIMEOUT_MS
  else process.env.AC_IDLE_TIMEOUT_MS = value
  const actual = idleTimeoutMs()
  if (actual === expected) {
    console.log(`✓ ${name}`)
  } else {
    console.log(`× ${name}: expected ${expected}, got ${actual}`)
    failed += 1
  }
}

// Behavioral: the idle watchdog kills a SILENT process at the idle limit and
// labels the kill 'idle'. Values below the env floor are fine here — the
// floor only guards env parsing, `runProcess` takes the number as-is.
{
  const started = Date.now()
  const silent = await runProcess(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
    cwd: import.meta.dirname,
    idleTimeoutMs: 1_500,
  })
  const elapsed = Date.now() - started
  const ok = silent.timedOut && silent.timeoutKind === 'idle' && elapsed < 20_000
  if (ok) {
    console.log('✓ idle: silent process killed at the idle limit')
  } else {
    console.log(`× idle: silent process not reaped (timedOut=${silent.timedOut} kind=${silent.timeoutKind} elapsed=${elapsed}ms)`)
    failed += 1
  }
}

// Behavioral: every output chunk re-arms the idle timer, so a process that
// streams steadily (gaps well under the idle limit) runs to completion and
// is NOT killed as idle.
{
  const script = 'for (let i = 0; i < 4; i++) { setTimeout(() => process.stdout.write(String(i) + "\\n"), i * 400) }'
  const chatty = await runProcess(process.execPath, ['-e', script], {
    cwd: import.meta.dirname,
    idleTimeoutMs: 1_500,
  })
  const ok = !chatty.timedOut && chatty.code === 0 && chatty.stdout.trim() === '0\n1\n2\n3'
  if (ok) {
    console.log('✓ idle: streaming process re-arms the watchdog and finishes cleanly')
  } else {
    console.log(`× idle: streaming process was killed or corrupted (timedOut=${chatty.timedOut} kind=${chatty.timeoutKind} code=${chatty.code} stdout=${JSON.stringify(chatty.stdout)})`)
    failed += 1
  }
}

// ---------------------------------------------------------------- retry gate
// The orchestrator auto-retries a zero-text failure only when it died fast;
// a timeout (idle ≥ 10 min, hard ≥ 30 min) must NOT be retried — rerunning
// a hung upstream would just double the wait for the same death.
const transientCases = [
  ['retry gate: fast zero-text error is transient', { error: 'boom', text: '', durationMs: 11_000 }, true],
  ['retry gate: missing duration counts as fast', { error: 'boom', text: '' }, true],
  ['retry gate: idle-timeout duration is excluded', { error: '运行超时（10 分钟无输出）', text: '', durationMs: 600_000 }, false],
  ['retry gate: hard-timeout duration is excluded', { error: '运行超时（总时长超过 30 分钟）', text: '', durationMs: 1_800_000 }, false],
  ['retry gate: exactly at the cutoff is excluded', { error: 'boom', text: '', durationMs: RETRY_MAX_TRANSIENT_MS }, false],
  ['retry gate: partial text is never retried', { error: 'boom', text: '半截回复', durationMs: 5_000 }, false],
  ['retry gate: a clean run is never retried', { text: '', durationMs: 5_000 }, false],
]

for (const [name, output, expected] of transientCases) {
  const actual = isTransientFailure(output)
  if (actual === expected) {
    console.log(`✓ ${name}`)
  } else {
    console.log(`× ${name}: expected ${expected}, got ${actual}`)
    failed += 1
  }
}

// ------------------------------------------------------------ pid ownership
// The boot sweep only owns a bare pid from the DB; between a crash and the
// reboot that pid may have been recycled by an unrelated process. These
// cases pin the matching rules that decide taskkill vs. leave-alone.
{
  const nodeProbe = {
    pid: 4242,
    name: 'node.exe',
    commandLine: '"D:\\nodejs\\node.exe" "D:\\npm\\@deepseek-ai\\dsh\\lib\\bin.js" --profile headless 任务',
    createdAtMs: 1,
  }
  const cannbotProbe = { pid: 4243, name: 'cannbot.exe', commandLine: '"D:\\tools\\cannbot.exe" run --format json', createdAtMs: 1 }
  const cmdProbe = {
    pid: 4244,
    name: 'cmd.exe',
    commandLine: '"C:\\Windows\\system32\\cmd.exe" /d /s /c my-cli --model x "任务"',
    createdAtMs: 1,
  }
  const matchCases = [
    ['pid: node + script marker matches', nodeProbe, { command: 'D:\\nodejs\\node.exe', markers: ['D:\\npm\\@deepseek-ai\\dsh\\lib\\bin.js'] }, true],
    ['pid: generic host without a marker never matches', nodeProbe, { command: 'D:\\nodejs\\node.exe' }, false],
    ['pid: generic host with a wrong marker is rejected', nodeProbe, { command: 'D:\\nodejs\\node.exe', markers: ['D:\\other\\cli.js'] }, false],
    ['pid: wrong image name is rejected', nodeProbe, { command: 'D:\\tools\\cannbot.exe' }, false],
    ['pid: distinctive exe + command path matches', cannbotProbe, { command: 'D:\\tools\\cannbot.exe' }, true],
    ['pid: distinctive exe matches case-insensitively', { ...cannbotProbe, name: 'CANNBOT.EXE' }, { command: 'D:\\tools\\Cannbot.exe' }, true],
    ['pid: tasklist fallback (no command line) matches a distinctive exe', { ...cannbotProbe, commandLine: '' }, { command: 'D:\\tools\\cannbot.exe' }, true],
    ['pid: tasklist fallback never matches a generic host', { ...nodeProbe, commandLine: '' }, { command: 'D:\\nodejs\\node.exe', markers: ['D:\\npm\\@deepseek-ai\\dsh\\lib\\bin.js'] }, false],
    ['pid: a gone process (null probe) never matches', null, { command: 'D:\\tools\\cannbot.exe' }, false],
    ['pid: custom cmd.exe + template literal matches', cmdProbe, { command: 'C:\\Windows\\system32\\cmd.exe', markers: ['my-cli --model'] }, true],
  ]

  for (const [name, probe, match, expected] of matchCases) {
    const actual = pidMatchesLaunch(probe, match)
    if (actual === expected) {
      console.log(`✓ ${name}`)
    } else {
      console.log(`× ${name}: expected ${expected}, got ${actual}`)
      failed += 1
    }
  }
}

// Behavioral (Windows): probePid() resolves THIS process as node.exe with
// the test script on its command line — validates the CIM/JSON plumbing
// end to end, including the UTF-8 console encoding fix.
if (process.platform === 'win32') {
  {
    const self = probePid(process.pid)
    const ok =
      self !== null &&
      self.name.toLowerCase() === 'node.exe' &&
      self.commandLine.includes('test-timeout') &&
      self.createdAtMs > 0 &&
      self.createdAtMs <= Date.now()
    console.log(ok ? '✓ pid probe: sees this node process (CIM path works)' : `× pid probe: self probe failed: ${JSON.stringify(self)}`)
    if (!ok) failed += 1
  }

  // Behavioral (Windows): a live child spawned through runProcess is
  // recognized as ours (node + its argv marker) and NOT as a stranger —
  // the exact decision the boot sweep makes before taskkill.
  {
    const controller = new AbortController()
    let childPid = 0
    const run = runProcess(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
      cwd: import.meta.dirname,
      signal: controller.signal,
      idleTimeoutMs: 60_000,
      onSpawn: (pid) => {
        childPid = pid
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 800))
    const probe = childPid ? probePid(childPid) : null
    const asPlainNode = pidMatchesLaunch(probe, { command: process.execPath })
    const asNodeWithMarker = pidMatchesLaunch(probe, { command: process.execPath, markers: ['-e'] })
    const asCannbot = pidMatchesLaunch(probe, { command: 'C:\\Windows\\System32\\cannbot.exe' })
    controller.abort()
    const finished = await run
    const ok = probe !== null && !asPlainNode && asNodeWithMarker && !asCannbot && finished.aborted
    console.log(
      ok
        ? '✓ pid probe: live child verified as ours, strangers rejected'
        : `× pid probe: child decision wrong (probe=${JSON.stringify(probe)} plainNode=${asPlainNode} withMarker=${asNodeWithMarker} cannbot=${asCannbot})`,
    )
    if (!ok) failed += 1
  }
} else {
  console.log('⚠ pid probe tests skipped (non-Windows)')
}

if (failed) {
  console.log(`\n${failed} case(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nOK: timeout parsing + idle watchdog + retry gate + pid ownership passed')
}
