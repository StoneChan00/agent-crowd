# Restart the agent-crowd server (loading committed code) and verify it.
#
#   powershell -File scripts\restart-and-verify.ps1              # full restart + verify
#   powershell -File scripts\restart-and-verify.ps1 -VerifyOnly  # verify only (pre-flight)
#   powershell -File scripts\restart-and-verify.ps1 -Port 8790   # other port
#
# Designed to run DETACHED (Task Scheduler / WMI Win32_Process.Create),
# outside the server's process tree, so killing the old server cannot take
# this script down. Every phase appends to data\restart-verify.log so a
# silent death is never possible again. Phases:
#   0  log begin, sleep 40s (let the scheduling turn land and close)
#   1  drain: wait until every room is idle (no in-flight turn to interrupt)
#   2  kill the listener tree BY PORT (never by stale pid), verify port free
#   3  give the old ancestor chain a moment to exit
#   4  start new server via scripts\start-server.ps1 (own timestamped log)
#   5  poll /api/health, assert claude + codex available
#   6  run ONE real claude round in a temp room, assert meta.exitCode=0,
#      no error, non-empty reply, then delete the temp room
# See docs/devlog/0001-restart-lockout.md for why each phase exists.
param(
  [switch]$VerifyOnly,
  [int]$Port = 8787,
  [int]$DrainSeconds = 1500
)

$root = Split-Path -Parent $PSScriptRoot
$base = "http://127.0.0.1:$Port"
$logFile = Join-Path $root 'data\restart-verify.log'

function Log([string]$msg) {
  try {
    $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
    Add-Content -Path $logFile -Value $line -Encoding ascii
  } catch {}
}

function Get-Health {
  try { return Invoke-RestMethod -Uri "$base/api/health" -TimeoutSec 5 } catch { return $null }
}

function Start-Starter {
  $starter = Join-Path $PSScriptRoot 'start-server.ps1'
  Start-Process -FilePath 'powershell.exe' `
    -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $starter, '-Port', "$Port") `
    -WindowStyle Hidden
}

Log ("BEGIN pid=$PID port=$Port verifyOnly={0}" -f [bool]$VerifyOnly)

if (-not $VerifyOnly) {
  # Phase 0: let the scheduling turn land and close before we touch its host.
  Start-Sleep -Seconds 40

  # Phase 1: drain - do not kill any in-flight turn. Abort (leave the old
  # server running) if rooms stay busy past -DrainSeconds. Default 1500s
  # because the server's AC_TURN_TIMEOUT_MS is 30m; restart is retryable
  # (rerun this script or the scheduled task manually).
  $drainDeadline = (Get-Date).AddSeconds($DrainSeconds)
  $drained = $false
  while ((Get-Date) -lt $drainDeadline) {
    try {
      $rooms = (Invoke-RestMethod -Uri "$base/api/bootstrap" -TimeoutSec 5).rooms
      $busy = @()
      foreach ($r in $rooms) {
        $st = Invoke-RestMethod -Uri "$base/api/rooms/$($r.id)/state" -TimeoutSec 5
        if ($st.busy) { $busy += $r.name }
      }
      if ($busy.Count -eq 0) { $drained = $true; break }
      Log ("phase1 drain: busy rooms: {0}" -f ($busy -join ', '))
    } catch {
      Log "phase1 drain: bootstrap/state unreachable, proceeding"
      $drained = $true
      break
    }
    Start-Sleep -Seconds 5
  }
  if (-not $drained) {
    Log ("phase1 FAIL: rooms still busy after {0}s, aborting (old server left running)" -f $DrainSeconds)
    Log "RESULT: ABORT - busy rooms"
    exit 1
  }
  Log "phase1 ok: all rooms idle"

  # Phase 2: kill the listener tree by port.
  $free = $false
  for ($i = 1; $i -le 5; $i++) {
    $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $conn) { $free = $true; break }
    Log ("phase2 attempt {0}: taskkill tree of pid {1}" -f $i, $conn.OwningProcess)
    taskkill /PID $conn.OwningProcess /T /F 2>&1 | Out-Null
    Start-Sleep -Seconds 2
  }
  if (-not $free) {
    Log "phase2 FAIL: port still occupied after 5 attempts, aborting"
    Log "RESULT: ABORT - port busy"
    exit 1
  }
  Log "phase2 ok: port $Port free"

  # Phase 3: old ancestor chain exits on its own once the server dies; give
  # it a moment (releases the old server log handle, tidiness only).
  $chainDeadline = (Get-Date).AddSeconds(15)
  while ((Get-Date) -lt $chainDeadline) {
    $chain = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -match 'server[/\\]index\.ts' })
    if ($chain.Count -eq 0) { break }
    Start-Sleep -Seconds 1
  }
  Log "phase3 ok: old chain drained"

  # Phase 4: start the new server (own timestamped log - no handle conflicts).
  Start-Starter
  Log "phase4 ok: starter spawned"
}

# Phase 5: health poll (80s, plus one respawn + 60s in full mode).
$healthy = $false
$h = $null
for ($i = 1; $i -le 40; $i++) {
  Start-Sleep -Seconds 2
  $h = Get-Health
  if ($h -and $h.ok) { $healthy = $true; break }
}
if (-not $healthy -and -not $VerifyOnly) {
  Log "phase5: not healthy in 80s, respawning starter once"
  Start-Starter
  for ($i = 1; $i -le 30; $i++) {
    Start-Sleep -Seconds 2
    $h = Get-Health
    if ($h -and $h.ok) { $healthy = $true; break }
  }
}
if (-not $healthy) { Log "RESULT: FAIL - server not healthy"; exit 1 }
$boot = [DateTimeOffset]::FromUnixTimeMilliseconds([long]$h.startedAt).ToLocalTime().ToString('yyyy-MM-dd HH:mm:ss')
Log ("phase5 ok: pid={0} startedAt={1}" -f $h.pid, $boot)
$claudeOk = [bool]$h.harnesses.claude.available
$codexOk = [bool]$h.harnesses.codex.available
Log ("phase5 harnesses: claude.available={0} codex.available={1}" -f $claudeOk, $codexOk)
if (-not ($claudeOk -and $codexOk)) { Log "RESULT: FAIL - claude/codex not available"; exit 1 }

# Phase 6: one real claude round in a temp room (auto-deleted in finally).
# Exit code: 0 only on a full PASS; every FAIL/ABORT/catch path exits 1 so
# Task Scheduler's LastTaskResult is a trustworthy machine-readable signal.
$roomId = $null
$rc = 0
try {
  $stamp = Get-Date -Format 'HHmmss'
  $roomBody = @{ name = "restart-verify-$stamp"; topic = 'restart verification, auto-cleaned' } | ConvertTo-Json
  $room = Invoke-RestMethod -Method Post -Uri "$base/api/rooms" -ContentType 'application/json' `
    -Body ([System.Text.Encoding]::UTF8.GetBytes($roomBody)) -TimeoutSec 10
  $roomId = $room.id
  Log "phase6 room created: $roomId"

  $charBody = @{
    name = 'probe-claude'
    harness = 'claude'
    persona = 'You are a restart verification probe. Follow the instruction exactly.'
    autoApprove = $true
    enabled = $true
  } | ConvertTo-Json
  $char = Invoke-RestMethod -Method Post -Uri "$base/api/rooms/$roomId/characters" -ContentType 'application/json' `
    -Body ([System.Text.Encoding]::UTF8.GetBytes($charBody)) -TimeoutSec 10
  Log ("phase6 character created: {0} harness={1}" -f $char.id, $char.harness)

  $runBody = @{ prompt = 'Reply with exactly VERIFY-OK and nothing else. Do not call any tools, do not read or write any files.' } | ConvertTo-Json
  Invoke-RestMethod -Method Post -Uri "$base/api/characters/$($char.id)/run" -ContentType 'application/json' `
    -Body ([System.Text.Encoding]::UTF8.GetBytes($runBody)) -TimeoutSec 10 | Out-Null
  Log "phase6 run queued"

  $roundDeadline = (Get-Date).AddSeconds(180)
  $reply = $null
  while ((Get-Date) -lt $roundDeadline) {
    Start-Sleep -Seconds 3
    $st = $null
    try { $st = Invoke-RestMethod -Uri "$base/api/rooms/$roomId/state" -TimeoutSec 5 } catch {}
    $msgs = $null
    try { $msgs = (Invoke-RestMethod -Uri "$base/api/rooms/$roomId/messages?limit=20" -TimeoutSec 5).messages } catch {}
    if ($msgs) { $reply = @($msgs | Where-Object { $_.authorName -eq 'probe-claude' })[-1] }
    if ($reply -and $st -and (-not $st.busy)) { break }
  }
  if (-not $reply) { Log "phase6 FAIL: no probe reply within 180s"; Log "RESULT: FAIL - claude round timeout"; exit 1 }

  $metaJson = ''
  if ($reply.meta) { $metaJson = $reply.meta | ConvertTo-Json -Depth 5 -Compress }
  $text = [string]$reply.content
  $short = $text -replace '\s+', ' '
  if ($short.Length -gt 100) { $short = $short.Substring(0, 100) }
  Log "phase6 reply text: $short"
  Log "phase6 reply meta: $metaJson"

  $exitOk = ($null -ne $reply.meta) -and ($null -ne $reply.meta.exitCode) -and ([int]$reply.meta.exitCode -eq 0)
  $errText = ''
  if ($reply.meta -and $reply.meta.error) { $errText = [string]$reply.meta.error }
  $noErr = ($errText.Trim().Length -eq 0)
  $hasText = ($text.Trim().Length -gt 0)
  if ($exitOk -and $noErr -and $hasText) {
    Log "RESULT: PASS - restart + health + claude round all verified"
  } else {
    Log ("RESULT: FAIL - exitOk={0} noErr={1} hasText={2}" -f $exitOk, $noErr, $hasText)
    $rc = 1
  }
} catch {
  Log ("phase6 ERROR: {0}" -f $_.Exception.Message)
  Log "RESULT: FAIL - claude round errored"
  $rc = 1
} finally {
  if ($roomId) {
    try {
      Invoke-RestMethod -Method Delete -Uri "$base/api/rooms/$roomId" -TimeoutSec 10 | Out-Null
      Log "phase6 cleanup: room deleted"
    } catch { Log ("phase6 cleanup FAILED: {0}" -f $_.Exception.Message) }
  }
}
Log "END"
exit $rc
