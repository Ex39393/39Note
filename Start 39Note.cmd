@echo off
setlocal
title 39Note Local Server
cd /d "%~dp0"

set "APP_URL_39NOTE=http://127.0.0.1:5173/"
set "READINESS_HELPER_39NOTE=%~dp0Open 39Note When Ready.ps1"

where node.exe >nul 2>nul
if errorlevel 1 (
  echo 39Note could not start because Node.js is not available.
  echo Install Node.js, then run this launcher again.
  echo.
  pause
  exit /b 1
)

where npm.cmd >nul 2>nul
if errorlevel 1 (
  echo 39Note could not start because npm is not available.
  echo Reinstall Node.js with npm, then run this launcher again.
  echo.
  pause
  exit /b 1
)

if not exist "%~dp0node_modules\" (
  echo 39Note has not been set up on this computer.
  echo Open a terminal in:
  echo   %~dp0
  echo Then run:
  echo   npm install
  echo.
  echo This launcher will not install packages automatically.
  pause
  exit /b 1
)

if not exist "%READINESS_HELPER_39NOTE%" (
  echo 39Note could not start because the readiness helper is missing:
  echo   %READINESS_HELPER_39NOTE%
  echo.
  pause
  exit /b 1
)

powershell.exe -NoLogo -NoProfile -Command "try { $response = Invoke-WebRequest -UseBasicParsing -Uri $env:APP_URL_39NOTE -TimeoutSec 2; if ($response.StatusCode -ge 200) { exit 0 } } catch {}; exit 1" >nul 2>nul
if not errorlevel 1 (
  echo 39Note is already running. Opening it in the default browser.
  start "" "%APP_URL_39NOTE%"
  exit /b 0
)

echo Starting 39Note at %APP_URL_39NOTE%
echo The default browser will open after the local server responds.
echo Keep this window open while using 39Note.
echo Port 5173 is strict; a conflicting process will not be stopped or replaced.
echo.

start "" /b powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%READINESS_HELPER_39NOTE%" -Url "%APP_URL_39NOTE%"
call npm.cmd run start:local
set "START_EXIT_CODE=%errorlevel%"

echo.
if not "%START_EXIT_CODE%"=="0" (
  echo 39Note stopped with an error.
  echo If port 5173 is occupied by another application, close that application or choose when to stop it yourself.
) else (
  echo The 39Note local server has stopped.
)
pause
exit /b %START_EXIT_CODE%
