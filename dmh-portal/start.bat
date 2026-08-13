@echo off
REM Starts the reporting server and opens it in your browser.
REM Close this window to stop it.
setlocal enabledelayedexpansion
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is not installed. Get it from https://nodejs.org ^(version 18 or newer^),
  echo   then run this again.
  echo.
  pause
  exit /b 1
)

if not exist "server\.env" (
  echo   First run - creating server\.env
  for /f "usebackq delims=" %%s in (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`) do set "SECRET=%%s"
  REM delayed expansion, or SECRET would still be empty inside this block
  powershell -NoProfile -Command "(Get-Content 'server\.env.example') -replace '^SESSION_SECRET=.*', 'SESSION_SECRET=!SECRET!' | Set-Content 'server\.env'"
  echo   A signing secret was generated.
  echo   Add MONGODB_URI to server\.env before you set up real clients.
)

start "" "http://localhost:4000/"
node server\src\server.js
if errorlevel 1 pause
