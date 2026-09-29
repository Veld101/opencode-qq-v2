@echo off
chcp 65001 >nul
title QQ Bot - close this window to stop
cd /d "%~dp0"

echo ============================================================
echo   QQ Bot  (opencode-qq standalone bridge)
echo ------------------------------------------------------------
echo   * Close this window to stop
echo   * If the bridge exits it restarts automatically (5s)
echo   * Log   : %USERPROFILE%\.config\opencode\opencode-qq.log
echo   * Config: %USERPROFILE%\.config\opencode\opencode-qq.json
echo ============================================================
echo.

:loop
call bun bridge.ts
echo.
echo [%date% %time%] bridge exited, restarting in 5s (Ctrl+C or close window to stop)
timeout /t 5 /nobreak >nul
goto loop
