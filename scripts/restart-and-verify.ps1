# Restart the agent-crowd server (loading committed code) and verify it.
#
#   powershell -File scripts\restart-and-verify.ps1              # full restart + verify
#   powershell -File scripts\restart-and-verify.ps1 -VerifyOnly  # verify only (pre-flight)
#   powershell -File scripts\restart-and-verify.ps1 -Port 8790   # other port
#
#   -ExcludeRoom <name>  drain ignores this room's busy state - busy there
#                        will NOT block the restart, and the room's in-flight
#                        turn WILL be interrupted at switchover (emergency lane)
#   -NotifyRoom   <name>  the start notice and the RESULT line are ALSO posted
#                        into that room as system messages via
#                        POST /api/rooms/:id/system, so the group sees the
#                        outcome without anyone reading the log. On servers
#                        without that API (or with the server down) the post
#                        degrades to a logged skip - never fatal.
#   -TakeoverPid  <pid>   the server pid that spawned us (main path). Phase 2
#                        asserts the port's listener IS that pid before
#                        killing anything: a mismatch means the port changed
#                        hands (watch reload / stranger) and the run ABORTS
#                        instead of killing someone else's chain. The server
#                        side promises to stay alive (still serving) until
#                        phase 2 kills it - see scripts/staged/restart.ts.
#                        With -VerifyOnly this runs as a read-only pre-flight
#                        check (external pre-flights pass no pid, skip it).
#
# MAIN PATH (server restart.ts): we are created via WMI Win32_Process.Create
# through a one-shot launcher - we have NO parent in the server's process
# tree and NO console at all (both proven necessary on this machine:
# DETACHED_PROCESS makes PowerShell 5.1 exit 0 without running anything, and
# a script spawned as the server's child dies the moment it kills its own
# spawn-parent - experiments E1-E7, 2026-11-03; killing NON-ancestors is
# safe). External/manual runs (Task Scheduler, an interactive shell) are
# ordinary console processes OUTSIDE the watch chain they kill - equally
# safe. Phase 2 still carves our own subtree out of the kill set anyway:
# pure defense against anyone ever launching this script from inside the
# tree it is about to kill. Cross-run mutual exclusion: a full restart
# (not -VerifyOnly) holds data\restart-verify.lock (pid + start time;
# stale if the pid is gone or older than 90min) for its whole life, so a
# second launch - POST /api/restart retry, scheduled task, manual - ABORTs
# immediately instead of racing the first (acquisition is atomic: CREATE_NEW
# for a fresh lock, RENAME-claim for a stale one - see the lock block). Every
# phase appends to
# data\restart-verify.log so a silent death is never possible again. Phases:
#   0  log begin, sleep 40s (let the scheduling turn land and close)
#   1  drain: wait until every room is idle (no in-flight turn to interrupt)
#   2  kill the port-owner chain BY PORT: the listener plus its node.exe
#      ancestors (a tsx watch parent lives ABOVE the listener), port free.
#      The listener's subtree dies as an explicit pid set MINUS this
#      script's own subtree (main path: we are a detached CHILD of the
#      listener). With -TakeoverPid the listener must BE that pid (else
#      abort).
#   3  verify every killed pid is gone and the port stays free
#   4  start new server via scripts\start-server.ps1 (own timestamped log)
#   5  poll /api/health, assert claude + codex available
#   6  run ONE real claude round in a temp room, assert meta.exitCode=0,
#      no error, non-empty reply, then delete the temp room
# See docs/devlog/0001-restart-lockout.md for why each phase exists.
param(
  [switch]$VerifyOnly,
  [int]$Port = 8787,
  [int]$DrainSeconds = 3000,
  [string]$ExcludeRoom = '',
  [string]$NotifyRoom = '',
  [int]$TakeoverPid = 0
)

$root = Split-Path -Parent $PSScriptRoot
$base = "http://127.0.0.1:$Port"
$logFile = Join-Path $root 'data\restart-verify.log'

$script:LogFailed = $false
# Flips true right before the FIRST taskkill goes out (P1, review round 5).
# Several ABORT paths fire AFTER kills were issued (re-resolve mismatch,
# port not freed after 5 attempts, killed pid survived the force kill): by
# then the old chain may be dead and the port may belong to a stranger, and
# Finish must not claim "旧服务未受影响" once any kill has gone out.
$script:Touched = $false
function Log([string]$msg) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  try {
    Add-Content -Path $logFile -Value $line -Encoding utf8
  } catch {
    # This log is the ONLY evidence a detached run leaves behind; a failed
    # write must never be silent: stderr + tracked, and RESULT goes FAIL.
    $script:LogFailed = $true
    [Console]::Error.WriteLine("LOG WRITE FAILED: $line :: $($_.Exception.Message)")
  }
}

function Get-Health {
  try { return Invoke-RestMethod -Uri "$base/api/health" -TimeoutSec 5 } catch { return $null }
}

# Post a SYSTEM message into -NotifyRoom via POST /api/rooms/:id/system
# (system messages never wake the orchestrator - they are tooling notices).
# Failure is NEVER fatal: old servers without the API 404, a dead server is
# unreachable, a typo'd room name misses - in every case we log the skip, so
# restart-verify.log stays the evidence of record either way.
function Send-RoomSystem([string]$text) {
  if (-not $NotifyRoom) { return }
  try {
    $rooms = (Invoke-RestMethod -Uri "$base/api/bootstrap" -TimeoutSec 5).rooms
    $target = @($rooms | Where-Object { $_.name -eq $NotifyRoom })[0]
    if (-not $target) { Log ("notify: no room named '{0}' found, skipped" -f $NotifyRoom); return }
    $body = @{ content = $text } | ConvertTo-Json
    Invoke-RestMethod -Method Post -Uri "$base/api/rooms/$($target.id)/system" -ContentType 'application/json' `
      -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 5 | Out-Null
    Log ("notify: posted to room '{0}'" -f $NotifyRoom)
  } catch {
    Log ("notify: skipped ({0})" -f $_.Exception.Message)
  }
}

# Single exit path: RESULT to the log AND to the group, lock release,
# log-write-failure override, END marker, exit code. VerifyOnly runs are
# tagged so a pre-flight failure can never be mistaken for a real restart
# failure in the group.
function Finish([string]$kind, [string]$detail, [int]$code) {
  Log ("RESULT: {0} - {1}" -f $kind, $detail)
  $tag = if ($VerifyOnly) { '[VerifyOnly] ' } else { '' }
  # ABORT wording splits on $script:Touched (P1, review round 5): once any
  # taskkill went out, "旧服务未受影响" would be a lie - the chain may be
  # dead with the port re-grabbed by a stranger. The retry hint names
  # force:true because the server-side 60min soft window survives a script
  # ABORT (WMI fire-and-forget: the server never sees our exit) and 409s a
  # plain retry - the two group messages must not contradict each other.
  $verdict = if ($kind -eq 'PASS') { '✅ 重启完成' }
    elseif ($kind -ne 'ABORT') { '🔴 重启失败' }
    elseif ($VerifyOnly) { '🟡 重启中止（只读预检，未动任何进程）' }
    elseif (-not $script:Touched) { '🟡 重启中止：未执行任何击杀，旧服务未受影响；软窗口内重新排队请带 force:true' }
    else { '⚠️ 重启中止：已对旧链执行过 taskkill，旧服务可能已停止、端口可能被新进程占用——请先人工确认，再带 force 重新排队' }
  Send-RoomSystem ("{0}{1} - {2}" -f $tag, $verdict, $detail)
  if ($script:LockFile -and (Test-Path -LiteralPath $script:LockFile)) {
    # Only release OUR lock: a stale lock we took over may already have been
    # re-acquired by a legitimate new run - never delete someone else's.
    $mine = $null
    try { $mine = (Get-Content -LiteralPath $script:LockFile -Raw | ConvertFrom-Json).pid } catch {}
    if ($mine -eq $PID) {
      try { Remove-Item -LiteralPath $script:LockFile -ErrorAction Stop; Log 'lock released' }
      catch { Log ("lock release FAILED: {0}" -f $_.Exception.Message) }
    }
  }
  if ($script:LogFailed) {
    Log "RESULT: FAIL - some log writes failed (evidence chain broken)"
    Send-RoomSystem ("{0}🔴 重启判定为 FAIL：本次运行的日志写入曾失败，证据链断裂" -f $tag)
  }
  Log "END"
  exit $code
}

# The listener pid plus every node.exe ancestor above it (bottom-up order).
# Skips cmd.exe wrappers (npm.cmd / pnpm.cmd - they exit on their own once
# their node child dies) and stops at the first other ancestor: an
# interactive shell is never ours to kill. This is what reaches the tsx
# watch parent, which lives ABOVE the listener and is therefore invisible
# to a listener-only tree kill (see phase 2).
function Get-PortChain([int]$FromPid) {
  $chain = @()
  $seen = @{}
  $cur = $FromPid
  while ($cur -and -not $seen.ContainsKey($cur) -and $chain.Count -lt 16) {
    $seen[$cur] = $true
    $p = Get-CimInstance Win32_Process -Filter "ProcessId=$cur" -ErrorAction SilentlyContinue
    if (-not $p) { break }
    if ($p.Name -eq 'node.exe') { $chain += [int]$p.ProcessId }
    elseif ($p.Name -ne 'cmd.exe') { break }
    $cur = [int]$p.ParentProcessId
  }
  return $chain
}

# Descendants of a pid (the pid itself NOT included), as a hashtable key
# set, built from one Win32_Process snapshot by walking ParentProcessId
# levels downward. Replaces `taskkill /T` wherever the kill set must leave
# a subtree alive: a script launched from INSIDE the tree it kills must
# carve its own subtree out or the /T kills it mid-phase-2 (phases 3-6
# dead, the new server in phase 4 never started: a full outage). The WMI
# main path has no parent in this tree at all, so this is defense in
# depth for the remaining in-tree launch shapes.
function Get-DescendantSet([int]$RootPid) {
  $procs = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
  $desc = @{}
  $frontier = @($RootPid)
  while ($frontier.Count -gt 0) {
    $next = @()
    foreach ($p in $procs) {
      if ($frontier -contains [int]$p.ParentProcessId) {
        $id = [int]$p.ProcessId
        if (-not $desc.ContainsKey($id)) {
          $desc[$id] = $true
          $next += $id
        }
      }
    }
    $frontier = $next
  }
  return $desc
}

function Start-Starter {
  $starter = Join-Path $PSScriptRoot 'start-server.ps1'
  Start-Process -FilePath 'powershell.exe' `
    -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $starter, '-Port', "$Port") `
    -WindowStyle Hidden
}

Log ("BEGIN pid=$PID port=$Port verifyOnly={0} excludeRoom='{1}' notifyRoom='{2}' takeoverPid={3}" -f [bool]$VerifyOnly, $ExcludeRoom, $NotifyRoom, $TakeoverPid)
if (-not $VerifyOnly -and $NotifyRoom) {
  Send-RoomSystem ("🔁 重启流程已启动（{0}），预计 1-3 分钟：等待空闲 → 切链 → 起新服务 → 六阶段验证。期间请勿在本群发消息，完成后会在此播报结果。" -f (Get-Date -Format 'HH:mm:ss'))
}

# Cross-run lock: exactly ONE full restart at a time, whichever lane fired
# it (server WMI launch, POST /api/restart retry, scheduled task, manual).
# VerifyOnly is read-only and never takes the lock. A stale lock (holder
# pid gone, or older than 90min - the full budget is 40s phase0 + up to
# 3000s drain + ~4min verify) is taken over, never blindly obeyed.
# Acquisition is ATOMIC on every path (P0, review round 4): a Test-Path +
# Set-Content pair leaves a window where two near-simultaneous launches (a
# double POST /api/restart, a retry racing a scheduled task) BOTH see "no
# lock", both write one, and both run a full kill/start sequence. Instead
# a fresh lock is created via CREATE_NEW (fails if ANY file is there), and
# a stale/corrupt lock is claimed via RENAME before the create (never a
# blind Remove-Item - that could delete a racing takeover's fresh lock).
# The exactly-one-winner guarantee lives in CREATE_NEW itself: concurrent
# takeovers CAN both win the rename (two handles sharing DELETE access
# each rename the same file object - proven in the lock-race rounds,
# 2026-11-03), so the rename is a claim, not the exclusion.
$script:LockFile = $null
if (-not $VerifyOnly) {
  $script:LockFile = Join-Path $root 'data\restart-verify.lock'
  if (Test-Path -LiteralPath $script:LockFile) {
    $lock = $null
    try { $lock = Get-Content -LiteralPath $script:LockFile -Raw | ConvertFrom-Json } catch {}
    if ($lock -and $lock.pid) {
      $holder = Get-Process -Id ([int]$lock.pid) -ErrorAction SilentlyContinue
      $ageMin = 999
      if ($lock.startedAt) {
        try { $ageMin = ((Get-Date) - [datetime]$lock.startedAt).TotalMinutes } catch {}
      }
      if ($holder -and $ageMin -lt 90) {
        Finish 'ABORT' ("lock held by pid {0} (age {1:n0}min) - another restart run is in flight, nothing touched" -f $lock.pid, $ageMin) 1
      }
      Log ("lock takeover: previous lock pid {0} holderAlive={1} ageMin={2:n0} - stale, claiming atomically" -f $lock.pid, [bool]$holder, $ageMin)
    } else {
      Log 'lock takeover: unreadable/corrupt lock file - claiming atomically'
    }
    # Claim via RENAME: move the stale/corrupt lock aside so this run can
    # never be judged against - or step on - another run's takeover race.
    # Concurrent takeovers CAN both win this rename (two open handles
    # sharing DELETE access each rename the same file object - proven,
    # lock-race rounds 4/6, 2026-11-03), so mutual exclusion is NOT here -
    # the CREATE_NEW below is the exactly-one-winner gate.
    $claimPath = "{0}.claim-{1}" -f $script:LockFile, $PID
    try { [IO.File]::Move($script:LockFile, $claimPath) }
    catch {
      Finish 'ABORT' ("lock takeover raced with another run (rename claim failed): {0}" -f $_.Exception.Message) 1
    }
    Remove-Item -LiteralPath $claimPath -ErrorAction SilentlyContinue
  }
  # Atomic create: CREATE_NEW fails if ANY file occupies the name now - the
  # Test-Path+Set-Content window this replaced is how two concurrent
  # launches could both "acquire" (P0, review round 4).
  try {
    $stream = [IO.File]::Open($script:LockFile, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    try {
      $bytes = [Text.Encoding]::ASCII.GetBytes((@{ pid = $PID; startedAt = (Get-Date).ToString('o') } | ConvertTo-Json -Compress))
      $stream.Write($bytes, 0, $bytes.Length)
    } finally { $stream.Close() }
  } catch {
    Finish 'ABORT' ("lock creation raced with another run: {0}" -f $_.Exception.Message) 1
  }
  Log "lock acquired: pid $PID"
}

if (-not $VerifyOnly) {
  # Phase 0: let the scheduling turn land and close before we touch its host.
  # Heartbeat every 10s: on 2026-11-02 the run logged BEGIN, then died with
  # 0xC000013A inside the silent 40s window; heartbeats localize such a death.
  for ($i = 1; $i -le 4; $i++) {
    Start-Sleep -Seconds 10
    Log ("phase0 heartbeat: {0}s/40s" -f ($i * 10))
  }

  # Phase 1: drain - do not kill any in-flight turn. Abort (leave the old
  # server running) if rooms stay busy past -DrainSeconds. Default 3000s
  # because the server's AC_TURN_TIMEOUT_MS is 60m; restart is retryable
  # (rerun this script, POST /api/restart, or the scheduled task manually).
  # -ExcludeRoom takes that room OUT of the drain check: its busy state will
  # not block the restart, but any turn running there WILL be interrupted -
  # that is exactly what the exclude sign-up means, and the group is told so.
  $drainDeadline = (Get-Date).AddSeconds($DrainSeconds)
  $drained = $false
  $excludeNoted = $false
  while ((Get-Date) -lt $drainDeadline) {
    try {
      $rooms = (Invoke-RestMethod -Uri "$base/api/bootstrap" -TimeoutSec 5).rooms
      $busy = @()
      foreach ($r in $rooms) {
        if ($ExcludeRoom -and $r.name -eq $ExcludeRoom) {
          if (-not $excludeNoted) {
            Log ("phase1 note: room '{0}' EXCLUDED from drain - busy there will not block the restart, its in-flight turn WILL be interrupted" -f $ExcludeRoom)
            $excludeNoted = $true
          }
          continue
        }
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
    Finish 'ABORT' ("rooms still busy after {0}s, old server left running" -f $DrainSeconds) 1
  }
  Log "phase1 ok: all rooms idle"

  # Snapshot the OLD server identity (server/index.ts:33 exposes pid /
  # startedAt exactly so stale servers are detectable). Phase 5 must prove
  # the port is now served by a DIFFERENT process, not the old one.
  $oldH = Get-Health
  $oldPid = if ($oldH) { [int]$oldH.pid } else { $null }
  $oldStartedAt = if ($oldH) { [string]$oldH.startedAt } else { $null }
  Log ("phase2 snapshot: oldPid={0} oldStartedAt={1}" -f $oldPid, $oldStartedAt)

  # Takeover contract (main path): we were spawned BY the server on
  # $TakeoverPid, and that process promised to stay alive until phase 2 kills
  # it. If the port has no listener, or a DIFFERENT pid owns it, the contract
  # is broken (a watch reload re-spawned a server / a stranger took the
  # port): killing what we find there would hit someone else's chain, and
  # starting a new server next to a surviving armed watch is the exact
  # port-race this script exists to prevent. Abort without touching anything.
  if ($TakeoverPid -gt 0) {
    $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $conn) {
      Finish 'ABORT' ("takeover target gone: no listener on $Port (TakeoverPid {0} not serving) - old chain state unknown, nothing touched" -f $TakeoverPid) 1
    }
    if ([int]$conn.OwningProcess -ne $TakeoverPid) {
      Finish 'ABORT' ("takeover target mismatch: listener on $Port is pid {0}, expected TakeoverPid {1} - not our spawner, refusing to kill" -f [int]$conn.OwningProcess, $TakeoverPid) 1
    }
    Log ("phase2 takeover target confirmed: listener pid {0} == TakeoverPid" -f $TakeoverPid)
  }

  # Phase 2: kill the dev-server chain BY PORT, never by command-line pattern.
  # AC_PORT travels in an env var (server/index.ts:31, start-server.ps1:34),
  # not in the command line - a pattern match can never scope to THIS port,
  # while a global 'server/index.ts' match would kill any checkout's chain on
  # this machine (and both ports at once). Instead: take the port's listener
  # pid, walk UP the ParentProcessId chain collecting node.exe ancestors
  # (under `npm run dev` the tsx WATCH is the listener's PARENT - a
  # listener-only kill lets watch respawn the server), and kill exactly
  # that chain:
  #   - topmost first, listener last (watch dies before the server, so
  #     nothing respawns in between),
  #   - the listener's own subtree goes down as an EXPLICIT pid set with
  #     THIS script's subtree carved out. The main path (WMI-created, no
  #     parent in the tree) never needs the carve-out - it is pure defense
  #     for anyone ever launching this script from inside the tree it kills
  #     (a child killing its own spawn-parent dies with it on this machine,
  #     E1-E4). Every OTHER descendant keeps the exact blast radius /T had.
  #   - ancestors stay single-kills: a /T on an ancestor would reach into
  #     sibling branches (e.g. vite under concurrently).
  # Fail-safe by design: any abort leaves the old server running.
  $killed = @{}
  $free = $false
  for ($i = 1; $i -le 5; $i++) {
    $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    $still = @($killed.Keys | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
    if (-not $conn -and $still.Count -eq 0) { $free = $true; break }
    if ($conn) {
      $listenerPid = [int]$conn.OwningProcess
      # The takeover contract holds on EVERY re-resolve (P1, review round 4):
      # if attempt 1 failed to free the port and someone NEW grabbed it
      # meanwhile (a watch reload, a stranger), that listener is outside the
      # contract - killing it is exactly the someone-else's-chain kill the
      # pre-check exists to prevent. External runs (no TakeoverPid) have no
      # contract to re-check.
      if ($TakeoverPid -gt 0 -and $listenerPid -ne $TakeoverPid) {
        Finish 'ABORT' ("phase2 re-resolve: listener on $Port is pid {0}, expected TakeoverPid {1} (port changed hands mid-kill) - refusing to kill the newcomer, nothing further touched" -f $listenerPid, $TakeoverPid) 1
      }
      $chain = @(Get-PortChain $listenerPid)
      $targets = $chain
      if ($listenerPid -notin $chain) { $targets = @($listenerPid) + $chain }
      [array]::Reverse($targets)
      Log ("phase2 attempt {0}: kill chain topmost-first: {1}" -f $i, ($targets -join ' -> '))
      # The first taskkill of this attempt is about to go out: from here on
      # the old chain is no longer guaranteed alive (see Finish's verdict).
      $script:Touched = $true
      foreach ($t in $targets) {
        if ($t -eq $listenerPid) {
          # Self-preserving subtree kill: descendants of the listener minus
          # $PID and everything below $PID. Usually empty - a drained
          # server has no children left but us.
          $own = Get-DescendantSet $PID
          $sub = Get-DescendantSet $listenerPid
          $excluded = @($sub.Keys | Where-Object { $_ -eq $PID -or $own.ContainsKey($_) })
          if ($excluded.Count -gt 0) {
            Log ("phase2: self-preservation - excluding own subtree from listener kill: {0}" -f ($excluded -join ', '))
          }
          foreach ($d in @($sub.Keys)) {
            if ($d -eq $PID -or $own.ContainsKey($d)) { continue }
            $killed[$d] = $true
            taskkill /PID $d /F 2>&1 | Out-Null
          }
          $killed[$t] = $true
          taskkill /PID $t /F 2>&1 | Out-Null
        } else {
          $killed[$t] = $true
          taskkill /PID $t /F 2>&1 | Out-Null
        }
      }
    }
    Start-Sleep -Seconds 2
  }
  if (-not $free) {
    Finish 'ABORT' "port $Port (or a killed pid) still occupied after 5 attempts, inspect manually" 1
  }
  if ($killed.Count -eq 0) {
    # The port was never listening, so NOTHING was killed and the old watch
    # chain (a surviving tsx watch) was NOT removed. A blind "ok" here would
    # walk into phase 4 and start a new server right next to an armed watch -
    # the next server/*.ts save would then re-create the port race this whole
    # script exists to prevent. Restart means "kill the old chain first";
    # killing zero pids is never an ok.
    Finish 'ABORT' "no listener on $Port, nothing killed - old chain NOT removed (an armed watch would re-grab the port on next save), investigate or use start-server.ps1 for a cold start" 1
  }
  Log "phase2 ok: port-owner chain gone, port $Port free"

  # Phase 3: verify the killed pid SET is really gone. Never re-scan by
  # pattern to decide what "our chain" is: the set of pids we actually killed
  # IS that definition - a global pattern cannot tell our chain from a
  # stranger's node that started meanwhile. The port must stay free too.
  $chainDeadline = (Get-Date).AddSeconds(15)
  do {
    $still = @($killed.Keys | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
    $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($still.Count -eq 0 -and -not $conn) { break }
    Start-Sleep -Seconds 1
  } while ((Get-Date) -lt $chainDeadline)
  $still = @($killed.Keys | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
  $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($still.Count -gt 0 -or $conn) {
    foreach ($t in $still) {
      Log ("phase3: killed pid {0} still alive, force kill" -f $t)
      taskkill /PID $t /F 2>&1 | Out-Null
    }
    Start-Sleep -Seconds 3
    $still = @($killed.Keys | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
    $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($still.Count -gt 0 -or $conn) {
      Finish 'ABORT' ("{0} killed pids survived force kill, portBusy={1}" -f $still.Count, [bool]$conn) 1
    }
  }
  Log "phase3 ok: all killed pids gone, port $Port stays free"

  # Phase 4: start the new server (own timestamped log - no handle conflicts).
  Start-Starter
  Log "phase4 ok: starter spawned"
}

# -VerifyOnly + -TakeoverPid runs the SAME takeover contract check as a
# read-only pre-flight: proves the pid that would spawn us is the one actually
# serving the port right now, without killing or starting anything. External
# pre-flights pass no TakeoverPid and skip this block entirely.
if ($VerifyOnly -and $TakeoverPid -gt 0) {
  $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $conn) {
    Finish 'ABORT' ("takeover pre-flight: no listener on $Port (TakeoverPid {0} not serving)" -f $TakeoverPid) 1
  }
  if ([int]$conn.OwningProcess -ne $TakeoverPid) {
    Finish 'ABORT' ("takeover pre-flight: listener on $Port is pid {0}, expected TakeoverPid {1}" -f [int]$conn.OwningProcess, $TakeoverPid) 1
  }
  Log ("takeover pre-flight ok: listener pid {0} == TakeoverPid" -f $TakeoverPid)
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
if (-not $healthy) { Finish 'FAIL' 'server not healthy in 80s (+60s respawn)' 1 }
$boot = [DateTimeOffset]::FromUnixTimeMilliseconds([long]$h.startedAt).ToLocalTime().ToString('yyyy-MM-dd HH:mm:ss')
Log ("phase5 ok: pid={0} startedAt={1}" -f $h.pid, $boot)

# Prove this is a NEW server, not the old one still answering the port: pid
# and startedAt must differ from the pre-kill snapshot (VerifyOnly restarts
# nothing, so it skips these asserts). Then prove the new server runs NO
# file-watcher: log the listener's ancestor chain - a watch ancestor is
# exactly the "service up, stale code" failure mode (the next file save
# respawns the old tree into a port race).
if (-not $VerifyOnly) {
  if ($oldPid -and [int]$h.pid -eq $oldPid) {
    Finish 'FAIL' ("health still served by pre-kill pid {0} (stale server)" -f $oldPid) 1
  }
  if ($oldStartedAt -and ([string]$h.startedAt -eq $oldStartedAt)) {
    Finish 'FAIL' 'startedAt unchanged from pre-kill snapshot (stale server)' 1
  }
  Log ("phase5 identity: oldPid={0} -> newPid={1}" -f $oldPid, $h.pid)
}
$conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($conn) {
  $chainDesc = @()
  $watchers = @()
  foreach ($cpid in @(Get-PortChain ([int]$conn.OwningProcess))) {
    $cp = Get-CimInstance Win32_Process -Filter "ProcessId=$cpid" -ErrorAction SilentlyContinue
    $cl = if ($cp -and $cp.CommandLine) { $cp.CommandLine -replace '\s+', ' ' } else { '' }
    if ($cl.Length -gt 120) { $cl = $cl.Substring(0, 120) }
    $chainDesc += "pid=$cpid $cl"
    if ($cp -and $cp.CommandLine -match '\bwatch\b') { $watchers += $cpid }
  }
  Log ("phase5 ancestor chain: {0}" -f ($chainDesc -join ' | '))
  if ($watchers.Count -gt 0) {
    if ($VerifyOnly) {
      Log ("phase5 note: current server runs under a watch ancestor (pid {0}) - the real restart removes it" -f ($watchers -join ', '))
    } else {
      Finish 'FAIL' ("new server still under a watch ancestor: {0}" -f ($watchers -join ', ')) 1
    }
  }
}
$claudeOk = [bool]$h.harnesses.claude.available
$codexOk = [bool]$h.harnesses.codex.available
Log ("phase5 harnesses: claude.available={0} codex.available={1}" -f $claudeOk, $codexOk)
if (-not ($claudeOk -and $codexOk)) { Finish 'FAIL' 'claude/codex not available' 1 }

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
  if (-not $reply) { Finish 'FAIL' 'claude round timeout (no probe reply within 180s)' 1 }

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
  if (-not ($exitOk -and $noErr -and $hasText)) {
    Log ("phase6 verdict: exitOk={0} noErr={1} hasText={2}" -f $exitOk, $noErr, $hasText)
    $rc = 1
  }
} catch {
  Log ("phase6 ERROR: {0}" -f $_.Exception.Message)
  $rc = 1
} finally {
  if ($roomId) {
    try {
      Invoke-RestMethod -Method Delete -Uri "$base/api/rooms/$roomId" -TimeoutSec 10 | Out-Null
      Log "phase6 cleanup: room deleted"
    } catch { Log ("phase6 cleanup FAILED: {0}" -f $_.Exception.Message) }
  }
}
if ($rc -ne 0) { Finish 'FAIL' 'claude round verdict failed (exitCode/error/text)' $rc }
Finish 'PASS' 'restart + health + claude round all verified' 0
