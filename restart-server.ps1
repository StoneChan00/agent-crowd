# 一键重启 agent-crowd 后端。
#
# 什么时候用：改了 server 端代码或环境变量之后，让新代码生效。
# 做什么：    停掉正在监听 8787 的旧 server（连同子进程树），然后以
#             AC_TURN_TIMEOUT_MS=30m 启动新 server（终端里已设置过则沿用）。
# 用法：      在项目根目录运行  .\restart-server.ps1    （可加 -Port 8790 指定端口）
param(
  [int]$Port = 8787
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

# 1) 停掉旧 server（最多重试 3 次）。
for ($i = 0; $i -lt 3; $i++) {
  $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $conn) { break }
  $targetPid = $conn.OwningProcess
  Write-Host "停止旧 server（PID $targetPid）..."
  taskkill /PID $targetPid /T /F | Out-Null
  Start-Sleep -Milliseconds 1500
}

$still = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($still) {
  Write-Host ('端口 {0} 仍被占用——如果旧 server 是 pnpm dev（tsx watch）起的，watch 会自动拉起子进程；请先到那个终端 Ctrl+C，再运行本脚本。' -f $Port) -ForegroundColor Yellow
  exit 1
}

# 2) 启动新 server。
if (-not $env:AC_TURN_TIMEOUT_MS) { $env:AC_TURN_TIMEOUT_MS = '30m' }
$env:AC_PORT = "$Port"
Write-Host "AC_TURN_TIMEOUT_MS=$env:AC_TURN_TIMEOUT_MS  AC_PORT=$env:AC_PORT"
Write-Host "启动中：http://127.0.0.1:$Port （Ctrl+C 停止，日志就在这个终端；启动后浏览器 Ctrl+F5 刷新页面即可）"
pnpm start
