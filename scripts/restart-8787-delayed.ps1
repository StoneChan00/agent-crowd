# Delayed restart for the 8787 agent-crowd server.
#
# Launched via WMI (Win32_Process.Create) so this script lives OUTSIDE the
# server's process tree: killing the old server cannot take this script down
# with it. The initial sleep leaves time for the turn that scheduled this
# restart (a room agent running under the old server) to finish and land its
# reply in the database first.
$ErrorActionPreference = 'Stop'

Start-Sleep -Seconds 90

$root = 'D:\2_Projects\agent-crowd'

# A WMI-spawned process may not inherit the interactive user PATH; make sure
# node/pnpm stay resolvable for the restart script and its pnpm start.
$env:Path = 'D:\1_Sotfware\Nodejs;' + $env:Path

# Reuse the tested restart script (kills the old listener tree, then starts
# the new server with AC_TURN_TIMEOUT_MS=30m). All output lands in a log file
# because this wrapper runs headless with no visible console.
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'restart-server.ps1') *> (Join-Path $root 'data\server-8787.log')
