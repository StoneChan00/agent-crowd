# 停止 agent-crowd server（scripts\start-server.ps1 的配套停止脚本）。
#
# 什么时候用：分离启动（Start-Process ... start-server.ps1）的 server 不用保终端，
#             但也没有 Ctrl+C 可按——用它停；pnpm dev 的后端同样适用。
# 做什么：    按端口定位 listener → 向上收集 node.exe 祖先链（tsx watch 住在
#             listener 上方，只杀 listener 会被 watch 重新拉起）→ 自顶向下单杀
#             祖先 → 最后杀 listener 本体连同子树（在跑的 harness 回合进程）。
#             杀父链是单杀不带 /T：/T 会波及 concurrently 下的兄弟分支（vite）。
# 用法：      .\scripts\stop-server.ps1              # 停 8787 上的 server
#             .\scripts\stop-server.ps1 -Port 5180  # 停 pnpm dev 的 vite 前端
# 幂等：      端口没有监听时直接报「没有在运行的 server」，退出码 0。
# 端口上停的是「正在监听该端口的进程链」——别把 8787 让给无关进程再跑本脚本。
param(
  [int]$Port = 8787
)

$ErrorActionPreference = 'Stop'

# The listener pid plus every node.exe ancestor above it (bottom-up order).
# Skips cmd.exe wrappers (npm.cmd / pnpm.cmd / tsx.cmd - they exit on their
# own once their node child dies) and stops at the first other ancestor: an
# interactive shell is never ours to kill. This is what reaches the tsx
# watch parent, which lives ABOVE the listener and is therefore invisible
# to a listener-only tree kill (same shape as scripts\restart-and-verify.ps1
# phase 2).
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
# levels downward. Used to kill the listener's subtree EXPLICITLY (instead
# of taskkill /T) so this script's own subtree can be carved out - pure
# defense for anyone ever launching it from inside the tree it stops.
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

# taskkill that never throws: the target may already be gone - when the
# chain's top dies, the shared hidden console closes and takes every attached
# member with it (console-ctrl death, the 0xC000013A shape in
# restart-and-verify.ps1's notes) - and a "process not found" on stderr is a
# terminating NativeCommandError under $ErrorActionPreference='Stop'. The
# port re-resolve loop above is the authority on whether it died.
function Kill-Pid([int]$Id) {
  if (-not (Get-Process -Id $Id -ErrorAction SilentlyContinue)) { return }
  try { taskkill /PID $Id /F 2>&1 | Out-Null } catch { }
}

# Kill one listener's chain: ancestors topmost-first (single kills, so the
# watch parent dies before anything it could respawn), the listener itself
# LAST with its whole subtree (in-flight harness turns) minus our own.
# Returns $true when an ancestor looked like `concurrently` (pnpm dev shape).
function Stop-PortChain([int]$ListenerPid) {
  $chain = @(Get-PortChain $ListenerPid)
  $targets = $chain
  if ($ListenerPid -notin $chain) { $targets = @($ListenerPid) + $chain }
  [array]::Reverse($targets)
  $sawConcurrently = $false
  foreach ($t in $targets) {
    if ($t -ne $ListenerPid) {
      $p = Get-CimInstance Win32_Process -Filter "ProcessId=$t" -ErrorAction SilentlyContinue
      if ($p -and $p.CommandLine -match 'concurrently') { $sawConcurrently = $true }
      Kill-Pid $t
    } else {
      $own = Get-DescendantSet $PID
      $sub = Get-DescendantSet $t
      foreach ($d in @($sub.Keys)) {
        if ($d -eq $PID -or $own.ContainsKey($d)) { continue }
        Kill-Pid $d
      }
      Kill-Pid $t
    }
  }
  return $sawConcurrently
}

# 最多 3 轮：每轮重新按端口解析（上一轮没杀干净 / watch 在间隙重拉时接得住）。
$devShape = $false
for ($i = 0; $i -lt 3; $i++) {
  $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $conn) {
    if ($i -eq 0) {
      Write-Host "端口 $Port 没有监听——没有正在运行的 server。"
      exit 0
    }
    break
  }
  $listenerPid = [int]$conn.OwningProcess
  Write-Host "停止 server（PID $listenerPid，第 $($i + 1) 轮）..."
  if (Stop-PortChain -ListenerPid $listenerPid) { $devShape = $true }
  Start-Sleep -Milliseconds 1500
}

$still = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($still) {
  Write-Host ('端口 {0} 仍被占用（PID {1}）——请手动检查：Get-Process -Id {1}' -f $Port, $still.OwningProcess) -ForegroundColor Yellow
  exit 1
}

Write-Host "已停止：端口 $Port 释放。" -ForegroundColor Green

# pnpm dev 的链被停后，vite（5180）是 concurrently 的兄弟分支，不随链死——提醒一句。
if ($devShape -and $Port -ne 5180) {
  $vite = Get-NetTCPConnection -LocalPort 5180 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($vite) {
    Write-Host '检测到 pnpm dev：vite 前端（5180）仍在运行，要一并停止请运行 .\scripts\stop-server.ps1 -Port 5180' -ForegroundColor Yellow
  }
}

Write-Host @'
重新启动：
  分离启动（不用保终端）：Start-Process powershell -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','scripts\start-server.ps1'
  交互启动（保终端）：    pnpm start，或改完代码后 .\restart-server.ps1
'@
