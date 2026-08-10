@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

REM Keep Electron downloads on the configured mirror. pnpm does not always
REM forward custom npmrc keys to Electron's postinstall script.
set "ELECTRON_MIRROR=https://registry.npmmirror.com/-/binary/electron/"

echo ========================================
echo   YoomClaw Launcher
echo   (project root: %CD%)
echo ========================================
echo.

REM Check whether pnpm is reachable from cmd.exe PATH
set "PNPM_OK=0"
where pnpm >nul 2>nul
if not errorlevel 1 set "PNPM_OK=1"

REM A partial/production-only install can leave node_modules present while
REM omitting the dev CLI that the root dev script needs.
if exist "node_modules\.bin\concurrently.cmd" goto :deps_ready

echo [INFO] Development dependencies are incomplete. Installing them...
echo.
if "%PNPM_OK%"=="1" goto :install_direct

REM pnpm not in cmd PATH (common when it is provisioned by a
REM version manager / PowerShell profile). Delegate to PowerShell,
REM which loads that profile and has pnpm available.
echo [INFO] pnpm not found in cmd PATH. Delegating to PowerShell...
echo.
powershell -NoExit -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; Set-Location -LiteralPath '%CD%'; $env:ELECTRON_MIRROR='https://registry.npmmirror.com/-/binary/electron/'; pnpm install --frozen-lockfile --prod=false --config.confirmModulesPurge=false; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; if (-not (Test-Path -LiteralPath 'node_modules\.bin\concurrently.cmd')) { Write-Error 'concurrently was not installed'; exit 1 }; & '.\start-dev.ps1'"
goto :eof

:install_direct
call pnpm install --frozen-lockfile --prod=false --config.confirmModulesPurge=false
if errorlevel 1 (
    echo.
    echo [ERROR] pnpm install failed. Check network / pnpm setup.
    pause
    exit /b 1
)
if not exist "node_modules\.bin\concurrently.cmd" (
    echo.
    echo [ERROR] concurrently was not installed. Check the pnpm output above.
    pause
    exit /b 1
)

:deps_ready

if not exist "node_modules\electron\dist\electron.exe" goto :repair_electron

goto :start_via_powershell

:repair_electron
echo [INFO] Electron runtime is missing. Repairing the cached Electron package...
echo.

if "%PNPM_OK%"=="1" goto :repair_electron_direct

echo [INFO] pnpm is not available in cmd PATH. Starting through PowerShell...
echo.
powershell -NoExit -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; Set-Location -LiteralPath '%CD%'; $env:ELECTRON_MIRROR='https://registry.npmmirror.com/-/binary/electron/'; pnpm rebuild electron --reporter=append-only; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; & '.\start-dev.ps1'"
goto :eof

:repair_electron_direct
call pnpm rebuild electron --reporter=append-only
if errorlevel 1 (
    echo.
    echo [ERROR] Electron runtime repair failed. Check the download output above.
    pause
    exit /b 1
)

:start_via_powershell
echo [INFO] Starting dev environment through the Windows launcher...
echo         (Close the Electron window or press Ctrl+C to stop)
echo.
powershell -NoExit -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; Set-Location -LiteralPath '%CD%'; $env:ELECTRON_MIRROR='https://registry.npmmirror.com/-/binary/electron/'; & '.\start-dev.ps1'"
