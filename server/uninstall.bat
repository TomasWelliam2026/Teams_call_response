@echo off
rem Removes the call bridge server's startup tasks and firewall rules. Keeps .env (your tokens).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy\windows\uninstall.ps1"
