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

if "%PNPM_OK%"=="1" goto :direct

REM pnpm not in cmd PATH (common when it is provisioned by a
REM version manager / PowerShell profile). Delegate to PowerShell,
REM which loads that profile and has pnpm available.
echo [INFO] pnpm not found in cmd PATH. Delegating to PowerShell...
echo.
if not exist "node_modules" (
    powershell -Command "if (-not (Test-Path 'node_modules')) { pnpm install }"
)
powershell -NoExit -Command "pnpm dev"
goto :eof

:direct
if not exist "node_modules" (
    echo [INFO] node_modules not found, running "pnpm install" first...
    echo.
    call pnpm install
    if errorlevel 1 (
        echo.
        echo [ERROR] pnpm install failed. Check network / pnpm setup.
        pause
        exit /b 1
    )
    echo.
)

echo [INFO] Starting dev environment via "pnpm dev"...
echo         (Close the Electron window or press Ctrl+C to stop)
echo.

call pnpm dev

if errorlevel 1 (
    echo.
    echo [ERROR] pnpm dev exited with an error. See output above.
    pause
)
