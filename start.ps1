$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

if (-not (Test-Path 'node_modules')) {
  Write-Host '安装依赖…' -ForegroundColor Cyan
  pnpm install
}

if (-not (Test-Path 'dist\web\index.html')) {
  Write-Host '构建前端…' -ForegroundColor Cyan
  pnpm build
}

$port = if ($env:AC_PORT) { $env:AC_PORT } else { '8787' }
$url = "http://127.0.0.1:$port"
Write-Host "启动 Agent Crowd → $url" -ForegroundColor Green

# 等后端起来再打开浏览器
Start-Process powershell -ArgumentList @(
  '-NoProfile', '-WindowStyle', 'Hidden', '-Command',
  "Start-Sleep -Seconds 3; Start-Process '$url'"
) | Out-Null

pnpm start
