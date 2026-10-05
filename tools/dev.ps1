# Start the Glimmerwick web dev server (Vite) on http://localhost:5173 (strict port: fails if 5173 is taken).
#
#   powershell -File tools\dev.ps1            # foreground, Ctrl+C to stop
#   powershell -File tools\dev.ps1 -Install   # run `npm install` first
#
# The orchestrator normally runs this through `.claude/launch.json` (configuration "web").
# Nothing here touches git, Rust or global settings.
param(
  [switch]$Install
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$web = Join-Path $root 'web'

if (-not (Test-Path (Join-Path $web 'package.json'))) { throw "web/package.json not found under $root" }

Set-Location $web
if ($Install -or -not (Test-Path (Join-Path $web 'node_modules'))) {
  Write-Host '[dev] npm install ...'
  npm install --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw 'npm install failed' }
}

# Is something already serving 5173?
try {
  $tcp = New-Object System.Net.Sockets.TcpClient
  $tcp.Connect('127.0.0.1', 5173)
  $tcp.Close()
  Write-Host '[dev] port 5173 is already in use (a dev server is probably running): http://localhost:5173'
  exit 0
} catch { }

Write-Host '[dev] starting Vite on http://localhost:5173 (Ctrl+C to stop)'
node (Join-Path $web 'node_modules\vite\bin\vite.js') --port 5173 --strictPort --host 127.0.0.1
