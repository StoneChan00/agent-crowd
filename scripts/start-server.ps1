# Detached starter for the agent-crowd server.
#
# Why this exists: NEVER redirect `*>` to a FIXED log path (e.g.
# data\server-8787.log). That file gets held open for WRITE, forever, by the
# ancestor chain of the running server (wrapper powershell -> pnpm start ->
# node). Any later `*>` onto the same file dies instantly with a sharing
# violation under $ErrorActionPreference='Stop' -- which is exactly how the
# 2026-10-30 21:09 (pid 25452) and 21:25 (canary) restart attempts died
# without a trace. The 00:37 restart only worked because the previous server
# was started from an interactive terminal and held no log file. See
# docs/devlog/0001-restart-lockout.md.
#
# Fix: each boot writes its OWN timestamped log under <dataDir>\ (the
# chain-scoped data root: -DataDir when given, repo data\ otherwise —
# B05b-1), so a restart never fights the running chain over a file handle
# AND a test-chain replacement never drops logs into the production data
# dir. The latest log path is mirrored to <dataDir>\server-<port>-latest.txt
# for quick lookup.
#
# Usage:
#   powershell -File scripts\start-server.ps1              # default port 8787
#   powershell -File scripts\start-server.ps1 -Port 8790   # other port
param(
  [int]$Port = 8787,
  # Where node.exe lives on THIS machine; prepended to PATH so detached /
  # scheduled processes can still resolve node & pnpm. Override freely.
  [string]$NodeDir = 'D:\1_Sotfware\Nodejs',
  # Data dir of the server this one REPLACES (restart flow). Without it the
  # replacement boots on the repo default — for a test-triggered restart
  # that spawns a PROD-data zombie whose boot sweep kills the live
  # production's in-flight turns (2026-11-06 incident). Empty = repo default.
  # B05b-1: the server's OWN log and latest.txt pointer also follow this
  # value, so a replacement started for a test chain no longer drops log
  # files into the PRODUCTION data dir.
  [string]$DataDir = '',
  # Print the chain-scoped log paths and exit — no dir creation, no log
  # write, no server start (scripts/restart-path-check.mjs).
  [switch]$ShowPaths
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

# B05b-1: chain-scoped data root — absolute -DataDir used as-is, relative
# resolved against the repo root (never cwd; GetFullPath throws on
# cross-drive absolutes under .NET Framework), repo default as fallback.
if ($DataDir) {
  if ([IO.Path]::IsPathRooted($DataDir)) { $dataDir = $DataDir } else { $dataDir = Join-Path $root $DataDir }
} else {
  $dataDir = Join-Path $root 'data'
}

if ($ShowPaths) {
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  Write-Output ("LOG={0}" -f (Join-Path $dataDir ("server-{0}-{1}.log" -f $Port, $stamp)))
  Write-Output ("LATEST={0}" -f (Join-Path $dataDir ("server-{0}-latest.txt" -f $Port)))
  exit 0
}

foreach ($dir in @($NodeDir, "$env:APPDATA\npm")) {
  if ($dir -and (Test-Path $dir)) { $env:Path = "$dir;$env:Path" }
}
$env:AC_PORT = "$Port"
if ($DataDir) { $env:AC_DATA_DIR = "$dataDir" }
if (-not $env:AC_TURN_TIMEOUT_MS) { $env:AC_TURN_TIMEOUT_MS = '60m' }

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
$log = Join-Path $dataDir "server-$Port-$stamp.log"
Set-Content -Path (Join-Path $dataDir "server-$Port-latest.txt") -Value $log -Encoding ascii

pnpm start *> $log
