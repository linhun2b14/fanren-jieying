@echo off
REM ===================================================================
REM  Fanren Jieying - Card Editor  (tools\editor\server.js)
REM  Pure ASCII only: cmd.exe parses this file as GBK and any UTF-8
REM  Chinese byte sequence corrupts the script (see ops doc hard rule 4).
REM  Self-healing loop: if node exits, restart after 5s.
REM  Same pattern as run-fanren.cmd (the game server launcher).
REM  Portable: project root is two levels up from this script (%~dp0..\..).
REM ===================================================================
setlocal
set "ROOT=%~dp0..\.."
set "EDITOR_PORT=8098"
set "EDITOR_HOST=0.0.0.0"
cd /d "%ROOT%"
if not exist "%ROOT%\logs" mkdir "%ROOT%\logs"

:loop
echo [%date% %time%] starting card editor on port %EDITOR_PORT% >> "%ROOT%\logs\editor.log"
node tools\editor\server.js >> "%ROOT%\logs\editor.log" 2>&1
echo [%date% %time%] editor exited, restart in 5s >> "%ROOT%\logs\editor.log"
REM ping used as sleep: `timeout` fails under Task Scheduler (no console input handle)
ping -n 6 127.0.0.1 >nul
goto loop
