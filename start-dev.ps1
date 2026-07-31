# Start Claw Desktop (Electron) + renderer dev server
# Gateway is spawned by the Electron main process (node + tsx runs packages/gateway/src/bin.ts on :18789),
# so no separate gateway step is needed.

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot

# Load .env (the Gateway child process reads JIMO credentials via --env-file)
if (Test-Path "$root\.env") {
    Get-Content "$root\.env" | ForEach-Object {
        $line = $_.Trim()
        if ($line -and -not $line.StartsWith("#")) {
            $idx = $line.IndexOf("=")
            if ($idx -gt 0) {
                $key = $line.Substring(0, $idx)
                $val = $line.Substring($idx + 1)
                Set-Item -Path "Env:$key" -Value $val
            }
        }
    }
    Write-Host "Loaded .env" -ForegroundColor Green
}

# 1) Start renderer dev server (Vite, :5173)
Write-Host "Starting renderer dev server on :5173..." -ForegroundColor Cyan
$vite = Start-Process -FilePath "node" `
    -ArgumentList "node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "5173" `
    -WorkingDirectory "$root\apps\desktop\renderer" `
    -NoNewWindow -PassThru

Start-Sleep -Seconds 3

# 2) Start Electron (desktop shell; spawns Gateway :18789 internally)
# NOTE: pnpm-installed electron's path.txt contains "dist\electron.exe" while its index.js
# also prepends "dist", producing ".../electron/dist/dist/electron.exe" (ENOENT).
# Work around it by resolving the real electron.exe on disk and launching it directly,
# instead of going through electron/cli.js (which reads the buggy path.txt).
Write-Host "Starting Claw Desktop..." -ForegroundColor Cyan

$electronExe = Join-Path $root "node_modules\electron\dist\electron.exe"
if (-not (Test-Path $electronExe)) {
    $found = Get-ChildItem -Path "$root\node_modules" -Recurse -Filter "electron.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($found) { $electronExe = $found.FullName }
    else {
        Write-Error "electron.exe not found under $root\node_modules"
        exit 1
    }
}

# Safety: never let Electron run under plain Node (some envs export this flag)
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

$electronArgs = @(".")
# Headless / no-GPU environments: set $env:CLAW_DISABLE_GPU=1 to launch with --disable-gpu
if ($env:CLAW_DISABLE_GPU) {
    $electronArgs = @("--disable-gpu") + $electronArgs
}

$electron = Start-Process -FilePath $electronExe `
    -ArgumentList $electronArgs `
    -WorkingDirectory "$root\apps\desktop" `
    -NoNewWindow -PassThru

Write-Host ""
Write-Host "Claw Desktop is running!" -ForegroundColor Green
Write-Host "   Renderer: http://127.0.0.1:5173" -ForegroundColor Gray
Write-Host "   Gateway : http://127.0.0.1:18789 (spawned by desktop)" -ForegroundColor Gray
Write-Host ""
Write-Host "Press Ctrl+C to stop." -ForegroundColor Yellow

try {
    while ($true) {
        Start-Sleep -Seconds 1
        if ($vite.HasExited) {
            Write-Host "Renderer exited, stopping desktop..." -ForegroundColor Red
            Stop-Process -Id $electron.Id -Force -ErrorAction SilentlyContinue
            break
        }
        if ($electron.HasExited) {
            Write-Host "Desktop exited, stopping renderer..." -ForegroundColor Red
            Stop-Process -Id $vite.Id -Force -ErrorAction SilentlyContinue
            break
        }
    }
} finally {
    Stop-Process -Id $vite.Id -Force -ErrorAction SilentlyContinue
    Stop-Process -Id $electron.Id -Force -ErrorAction SilentlyContinue
}
