@echo off
rem Runs the bridge server for the "CallBridge Server" task and starts it again if it ever exits.
rem (Task Scheduler's own "restart on failure" only covers a task that fails to start, not a
rem server that stops later.) NODE may be set by the task; otherwise node from PATH is used.
cd /d "%~dp0..\.."
if not defined NODE set "NODE=node"
:loop
"%NODE%" --env-file=.env server.js >> logs\server.log 2>&1
echo %date% %time% server exited with code %errorlevel%, restarting in 3 s >> logs\server.log
timeout /t 3 /nobreak >nul
goto loop
