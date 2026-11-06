/**
 * B05b-1: chain-scoped restart paths contract.
 *
 * The restart chain (restart-and-verify.ps1 → start-server.ps1) used to pin
 * its log, its cross-run lock, and the replacement server's own log files to
 * the REPO's data\ — so a test-triggered restart wrote evidence into the
 * production data dir and contended the production restart lock (same
 * pollution class as the 2026-11-06 zombie incident). Both scripts now
 * derive a $dataRoot from -DataDir (repo-root-resolved, never cwd) with the
 * repo default as fallback, and expose -ShowPaths to print the derived
 * paths with ZERO side effects (no dir creation, no log write, no lock, no
 * server start).
 *
 * This check locks, via -ShowPaths:
 *   R1  restart-and-verify without -DataDir → LOG/LOCK in <repo>\data
 *   R2  restart-and-verify with -DataDir    → LOG/LOCK in that dir
 *   S1  start-server without -DataDir       → LOG/LATEST in <repo>\data
 *   S2  start-server with -DataDir          → LOG/LATEST in that dir
 *   P1  the four probes leave the production data\ file set untouched
 *
 *   node scripts/restart-path-check.mjs
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const IS_WIN = process.platform === 'win32'

let passed = 0
let failed = 0
function check(name, ok, detail = '') {
  if (ok) {
    passed += 1
    console.log(`✓ ${name}`)
  } else {
    failed += 1
    console.log(`× ${name}${detail ? `: ${detail}` : ''}`)
  }
}

if (!IS_WIN) {
  console.log('restart-path-check: Windows-only (PowerShell scripts) — skipped')
  process.exit(0)
}

const probe = (script, args) => {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(ROOT, 'scripts', script), '-ShowPaths', ...args], {
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
  })
  if (result.status !== 0) {
    throw new Error(`${script} ${args.join(' ')} -> exit ${result.status}: ${result.stderr}`)
  }
  const out = {}
  for (const line of result.stdout.trim().split(/\r?\n/)) {
    const at = line.indexOf('=')
    if (at > 0) out[line.slice(0, at)] = line.slice(at + 1)
  }
  return out
}

const prodData = join(ROOT, 'data')
// Fresh-clone guard (review suggestion 4): data/ is gitignored and doesn't
// exist before the first server boot; create it so the before/after file-set
// probe works on a pristine checkout instead of dying on ENOENT.
mkdirSync(prodData, { recursive: true })
const before = new Set(readdirSync(prodData))

// R1: no -DataDir → repo default (behavior identical to pre-B05b-1).
const r1 = probe('restart-and-verify.ps1', [])
check(
  'R1 无 -DataDir：restart 的 LOG/LOCK 落仓库默认 data',
  r1.LOG === join(prodData, 'restart-verify.log') && r1.LOCK === join(prodData, 'restart-verify.lock'),
  JSON.stringify(r1),
)

// R2: -DataDir → chain-scoped paths, repo-root-relative resolution.
const tempDir = mkdtempSync(join(tmpdir(), 'ac-rpcheck-'))
try {
  const r2 = probe('restart-and-verify.ps1', ['-DataDir', tempDir])
  check(
    'R2 有 -DataDir：restart 的 LOG/LOCK 跟随数据目录',
    r2.LOG === join(tempDir, 'restart-verify.log') && r2.LOCK === join(tempDir, 'restart-verify.lock'),
    JSON.stringify(r2),
  )

  // Relative -DataDir resolves against the repo root, never cwd.
  const r2rel = probe('restart-and-verify.ps1', ['-DataDir', 'workspace\\.rpcheck-rel'])
  check(
    'R2b 相对 -DataDir 按仓库根解析（不依赖 cwd）',
    r2rel.LOCK === join(ROOT, 'workspace', '.rpcheck-rel', 'restart-verify.lock'),
    JSON.stringify(r2rel),
  )

  // S1: start-server without -DataDir → repo default.
  const s1 = probe('start-server.ps1', ['-Port', '39997'])
  check(
    'S1 无 -DataDir：start-server 的 LOG/LATEST 落仓库默认 data',
    s1.LOG.startsWith(join(prodData, 'server-39997-')) && s1.LOG.endsWith('.log') && s1.LATEST === join(prodData, 'server-39997-latest.txt'),
    JSON.stringify(s1),
  )

  // S2: start-server with -DataDir → chain-scoped.
  const s2 = probe('start-server.ps1', ['-Port', '39997', '-DataDir', tempDir])
  check(
    'S2 有 -DataDir：start-server 的 LOG/LATEST 跟随数据目录',
    s2.LOG.startsWith(join(tempDir, 'server-39997-')) && s2.LATEST === join(tempDir, 'server-39997-latest.txt'),
    JSON.stringify(s2),
  )
} finally {
  try {
    rmSync(tempDir, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
}

// P1: the four probes must not touch the production data dir.
mkdirSync(prodData, { recursive: true })
const after = new Set(readdirSync(prodData))
const added = [...after].filter((name) => !before.has(name))
const removed = [...before].filter((name) => !after.has(name))
check(
  'P1 探针全程零副作用：生产 data 无新增/删除',
  added.length === 0 && removed.length === 0,
  `added=${JSON.stringify(added)} removed=${JSON.stringify(removed)}`,
)

if (failed > 0) {
  console.log(`\n${failed} case(s) failed`)
  process.exitCode = 1
} else {
  console.log(`\nOK: restart path contract passed (${passed}/${passed})`)
}
