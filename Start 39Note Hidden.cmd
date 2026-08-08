@echo off
setlocal
cd /d "%~dp0"

set "APP_URL_39NOTE=http://127.0.0.1:5173/"
set "LOG_PATH_39NOTE=%~dp039note-launch.log"
set "READINESS_HELPER_39NOTE=%~dp0Open 39Note When Ready.ps1"

>>"%LOG_PATH_39NOTE%" echo [%date% %time%] Hidden startup requested.

where node.exe >nul 2>nul
if errorlevel 1 (
  >>"%LOG_PATH_39NOTE%" echo [%date% %time%] ERROR: Node.js is not available.
  exit /b 1
)

where npm.cmd >nul 2>nul
if errorlevel 1 (
  >>"%LOG_PATH_39NOTE%" echo [%date% %time%] ERROR: npm is not available.
  exit /b 1
)

if not exist "%~dp0node_modules\" (
  >>"%LOG_PATH_39NOTE%" echo [%date% %time%] ERROR: node_modules is missing. Run npm install manually.
  exit /b 1
)

if not exist "%READINESS_HELPER_39NOTE%" (
  >>"%LOG_PATH_39NOTE%" echo [%date% %time%] ERROR: The readiness helper is missing.
  exit /b 1
)

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%READINESS_HELPER_39NOTE%" -Url "%APP_URL_39NOTE%" -LogPath "%LOG_PATH_39NOTE%" -ProbeOnly
set "SERVER_STATE_39NOTE=%errorlevel%"
if "%SERVER_STATE_39NOTE%"=="0" (
  >>"%LOG_PATH_39NOTE%" echo [%date% %time%] Existing 39Note server detected; opening the default browser.
  start "" "%APP_URL_39NOTE%"
  exit /b 0
)
if "%SERVER_STATE_39NOTE%"=="2" (
  >>"%LOG_PATH_39NOTE%" echo [%date% %time%] ERROR: Port 5173 is currently being used by another application. Close that application and start 39Note again.
  exit /b 2
)

>>"%LOG_PATH_39NOTE%" echo [%date% %time%] Starting Vite on strict port 5173.
start "" /b powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%READINESS_HELPER_39NOTE%" -Url "%APP_URL_39NOTE%" -LogPath "%LOG_PATH_39NOTE%"
call npm.cmd run start:local >>"%LOG_PATH_39NOTE%" 2>&1
set "START_EXIT_CODE=%errorlevel%"
>>"%LOG_PATH_39NOTE%" echo [%date% %time%] Vite exited with code %START_EXIT_CODE%.
exit /b %START_EXIT_CODE%
