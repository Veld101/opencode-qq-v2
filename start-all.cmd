@echo off
chcp 65001 >nul
cd /d "%~dp0"

rem ===========================================================================
rem  Start every configured opencode-qq bot, one console window each.
rem  A bot that is already running exits by itself (instance guard, exit code 3).
rem  Keep this file PURE ASCII (cmd.exe parses it with the OEM code page).
rem ===========================================================================

set "ROOT=%USERPROFILE%\.config\opencode"

if exist "%ROOT%\opencode-qq.json" (
  echo [start] (default^)
  start "QQ Bot" "%~dp0start-bridge.cmd"
)

if exist "%ROOT%\bots" (
  for /d %%D in ("%ROOT%\bots\*") do (
    if exist "%%D\opencode-qq.json" (
      echo [start] %%~nxD
      start "QQ Bot [%%~nxD]" "%~dp0start-bridge.cmd" "%%~nxD"
    )
  )
)

echo.
echo Done. Close a window to stop that bot, or run scripts\stop.ps1 to stop all.
timeout /t 4 >nul
