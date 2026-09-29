@echo off
chcp 65001 >nul
cd /d "%~dp0"

rem ===========================================================================
rem  Stop every opencode-qq bridge process.
rem  Wraps scripts/stop.ps1 and keeps the window open so the output is readable.
rem  Keep this file PURE ASCII (cmd.exe parses it with the OEM code page).
rem ===========================================================================

set "PS=powershell"
where pwsh >nul 2>nul && set "PS=pwsh"

%PS% -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop.ps1"

echo.
pause
