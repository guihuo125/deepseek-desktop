@echo off
rem Double-click entry point. All logic lives in deploy.ps1.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy.ps1"
echo.
pause
