@echo off
rem Starts the call bridge server on this VPS (the startup tasks installed by
rem deploy\windows\install.ps1) and checks that it answers. It normally runs by itself.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy\windows\start.ps1"
