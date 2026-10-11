@echo off
REM ===================================================================
REM  Fanren Jieying - Nascent Soul Battle  (web board game server)
REM  Pure ASCII only: cmd.exe parses this file as GBK and any UTF-8
REM  Chinese byte sequence corrupts the script (see ops doc hard rule 4).
REM  Self-healing loop: if node exits, restart after 5s.
REM  Portable: everything is relative to this script's own folder (%~dp0),
REM  so the project can live anywhere.
REM ===================================================================
setlocal
set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
set "PORT=8094"
set "HOST=0.0.0.0"
cd /d "%ROOT%"
if not exist "%ROOT%\logs" mkdir "%ROOT%\logs"

:loop
echo [%date% %time%] starting fanren-jieying server on port %PORT% >> "%ROOT%\logs\fanren.log"
node server\index.js >> "%ROOT%\logs\fanren.log" 2>&1
echo [%date% %time%] server exited, restart in 5s >> "%ROOT%\logs\fanren.log"
REM ping used as sleep: `timeout` fails under Task Scheduler (no console input handle)
ping -n 6 127.0.0.1 >nul
goto loop
