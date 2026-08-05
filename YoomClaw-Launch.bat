@echo off
chcp 65001 >nul
cd /d "%~dp0"

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
powershell -NoExit -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; Set-Location -LiteralPath '%CD%'; pnpm install --frozen-lockfile --prod=false --config.confirmModulesPurge=false; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; if (-not (Test-Path -LiteralPath 'node_modules\.bin\concurrently.cmd')) { Write-Error 'concurrently was not installed'; exit 1 }; pnpm dev"
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

if "%PNPM_OK%"=="1" goto :start_direct

echo [INFO] pnpm is not available in cmd PATH. Starting through PowerShell...
echo.
powershell -NoExit -ExecutionPolicy Bypass -Command "Set-Location -LiteralPath '%CD%'; pnpm dev"
goto :eof

:start_direct
echo [INFO] Starting dev environment via "pnpm dev"...
echo         (Close the Electron window or press Ctrl+C to stop)
echo.

call pnpm dev

if errorlevel 1 (
    echo.
    echo [ERROR] pnpm dev exited with an error. See output above.
    pause
)
