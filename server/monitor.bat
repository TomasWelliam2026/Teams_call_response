@echo off
rem Shows the call bridge server (it runs invisibly in the background) and its log, live.
rem Closing this window does not stop the server.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy\windows\monitor.ps1"
