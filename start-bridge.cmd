@echo off
chcp 65001 >nul
cd /d "%~dp0"

rem ===========================================================================
rem  opencode-qq standalone bridge launcher
rem
rem  Usage:
rem    start-bridge.cmd            single bot  -> %USERPROFILE%\.config\opencode\opencode-qq.json
rem    start-bridge.cmd <bot>      multi  bot  -> %USERPROFILE%\.config\opencode\bots\<bot>\
rem
rem  NOTE: keep this file PURE ASCII. cmd.exe parses it with the OEM code page,
rem        so UTF-8 Chinese bytes break the script (this has bitten us before).
rem ===========================================================================

setlocal
set "BOT=%~1"
set "CFGROOT=%USERPROFILE%\.config\opencode"
set "CFGFILE=%CFGROOT%\opencode-qq.json"

if defined BOT (
  set "OPENCODE_QQ_CONFIG_DIR=%CFGROOT%\bots\%BOT%"
  set "CFGFILE=%CFGROOT%\bots\%BOT%\opencode-qq.json"
  set "WINTITLE=QQ Bot [%BOT%]"
) else (
  set "WINTITLE=QQ Bot"
)

title %WINTITLE% - close this window to stop

echo ============================================================
echo   QQ Bot  (opencode-qq standalone bridge)
echo ------------------------------------------------------------
if defined BOT (
  echo   Bot    : %BOT%
) else (
  echo   Bot    : (default^)
)
echo   Config : %CFGFILE%
echo   * Close this window to stop
echo   * If the bridge exits it restarts automatically in 5s
echo ============================================================
echo.

if not exist "%CFGFILE%" (
  echo [warn] config not found: %CFGFILE%
  echo [warn] copy opencode-qq.example.json there and fill in AppID/AppSecret.
  echo.
)

:loop
if defined BOT (
  call bun bridge.ts --bot "%BOT%"
) else (
  call bun bridge.ts
)

rem exit code 3 = this bot already has a running instance -> close, do not restart
if "%ERRORLEVEL%"=="3" (
  echo.
  echo [info] This bot is already running. Closing this window.
  timeout /t 3 /nobreak >nul
  exit
)

echo.
echo [%date% %time%] bridge exited, restarting in 5s (Ctrl+C or close window to stop)
timeout /t 5 /nobreak >nul
goto loop
