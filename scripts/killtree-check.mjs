/**
 * Regression check for the process-tree kill: when a `runProcess` timeout
 * fires, the whole tree must die — child AND grandchildren. The 8788 orphan
 * test server (a grandchild that survived `child.kill()`) was exactly this
 * bug, so the check lives in the repo instead of a throwaway script.
 *
 *   node scripts/killtree-check.mjs
 *
 * Spawns `powershell parent.ps1` which runs `powershell child.ps1`; both
 * sleep far longer than the 3s timeout. Both command lines carry a unique
 * marker (the script directory name), so survivors can be counted afterwards.
 * Windows only — elsewhere the tree-kill is a plain SIGKILL, and the check
 * skips so `pnpm test` stays green on any dev box.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '../server/harnesses/process.ts'

if (process.platform !== 'win32') {
  console.log('- killtree: skipped (non-Windows)')
  process.exit(0)
}

const MARKER = `ac-killtree-${process.pid}-${Date.now().toString(36)}`
const dir = mkdtempSync(join(tmpdir(), `${MARKER}-`))
writeFileSync(join(dir, 'parent.ps1'), `& powershell -NoProfile -File "$PSScriptRoot\\child.ps1"\n`)
writeFileSync(join(dir, 'child.ps1'), 'Start-Sleep -Seconds 60\n')

const countSurvivors = () =>
  new Promise((resolve, reject) => {
    const lister = spawn('powershell', [
      '-NoProfile',
      '-Command',
      `@(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${MARKER}*' -and $_.ProcessId -ne $PID }).Count`,
    ])
    let out = ''
    lister.stdout.on('data', (chunk) => (out += chunk))
    lister.on('close', (code) => (code === 0 ? resolve(Number(out.trim()) || 0) : reject(new Error(`lister exit ${code}`))))
    lister.on('error', reject)
  })

try {
  const result = await runProcess('powershell', ['-NoProfile', '-File', join(dir, 'parent.ps1')], {
    cwd: dir,
    timeoutMs: 3_000,
  })

  // taskkill teardown is asynchronous: give the tree a moment before judging.
  let survivors = -1
  for (let attempt = 0; attempt < 6; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 2_000 : 1_500))
    survivors = await countSurvivors()
    if (survivors === 0) break
  }

  const timedOutOk = result.timedOut
  const cleanOk = survivors === 0
  console.log(timedOutOk ? '✓ killtree: 超时触发' : '× killtree: 超时未触发')
  console.log(cleanOk ? '✓ killtree: 进程树零幸存者' : `× killtree: 仍有 ${survivors} 个幸存进程`)
  if (!timedOutOk || !cleanOk) process.exitCode = 1
  else console.log('OK: killtree passed')
} finally {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // a survivor may still hold the scripts; they self-expire with the sleep
  }
}
