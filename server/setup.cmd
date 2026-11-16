@echo off
rem Sets up the call bridge server on this Windows VPS, or updates it (run it again after copying in
rem a newer version, or after the VPS's IP changed). Double-click it: it asks for administrator rights.
rem Options are passed on, e.g.  setup.cmd -Domain bridge.example.com  (see deploy\windows\install.ps1).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy\windows\install.ps1" %*
