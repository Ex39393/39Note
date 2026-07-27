@echo off
setlocal
title Create 39Note Desktop Shortcut
cd /d "%~dp0"

set "PROJECT_DIRECTORY_39NOTE=%~dp0"
set "HIDDEN_LAUNCHER_39NOTE=%~dp0Start 39Note Hidden.vbs"
set "ICON_PATH_39NOTE=%~dp039Note.ico"
set "WSCRIPT_PATH_39NOTE=%SystemRoot%\System32\wscript.exe"

if not exist "%HIDDEN_LAUNCHER_39NOTE%" (
  echo Unable to create the desktop shortcut.
  echo The hidden launcher was not found:
  echo   %HIDDEN_LAUNCHER_39NOTE%
  echo.
  pause
  exit /b 1
)

if not exist "%WSCRIPT_PATH_39NOTE%" (
  echo Unable to create the desktop shortcut.
  echo Windows Script Host was not found:
  echo   %WSCRIPT_PATH_39NOTE%
  echo.
  pause
  exit /b 1
)

if not exist "%ICON_PATH_39NOTE%" (
  echo Unable to create the desktop shortcut.
  echo The 39Note icon was not found:
  echo   %ICON_PATH_39NOTE%
  echo.
  pause
  exit /b 1
)

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference = 'Stop';" ^
  "$projectDirectory = [IO.Path]::GetFullPath($env:PROJECT_DIRECTORY_39NOTE).TrimEnd('\');" ^
  "$launcherPath = [IO.Path]::GetFullPath($env:HIDDEN_LAUNCHER_39NOTE);" ^
  "$iconPath = [IO.Path]::GetFullPath($env:ICON_PATH_39NOTE);" ^
  "$wscriptPath = [IO.Path]::GetFullPath($env:WSCRIPT_PATH_39NOTE);" ^
  "$desktopDirectory = [Environment]::GetFolderPath('Desktop');" ^
  "if ([string]::IsNullOrWhiteSpace($desktopDirectory) -or -not (Test-Path -LiteralPath $desktopDirectory -PathType Container)) { throw 'Windows did not return a valid Desktop folder.' }" ^
  "if (-not (Test-Path -LiteralPath $launcherPath -PathType Leaf)) { throw 'Start 39Note Hidden.vbs could not be found.' }" ^
  "if (-not (Test-Path -LiteralPath $iconPath -PathType Leaf)) { throw '39Note.ico could not be found.' }" ^
  "if (-not (Test-Path -LiteralPath $wscriptPath -PathType Leaf)) { throw 'wscript.exe could not be found.' }" ^
  "$shortcutPath = Join-Path $desktopDirectory '39Note.lnk';" ^
  "$shell = New-Object -ComObject WScript.Shell;" ^
  "$shortcut = $shell.CreateShortcut($shortcutPath);" ^
  "$shortcut.TargetPath = $wscriptPath;" ^
  "$shortcut.Arguments = [char]34 + $launcherPath + [char]34;" ^
  "$shortcut.WorkingDirectory = $projectDirectory;" ^
  "$shortcut.Description = 'Start the local 39Note PDF reader';" ^
  "$shortcut.IconLocation = $iconPath + ',0';" ^
  "$shortcut.Save();" ^
  "if (-not (Test-Path -LiteralPath $shortcutPath -PathType Leaf)) { throw 'Windows did not create the shortcut.' }" ^
  "Write-Host 'Desktop shortcut created successfully:';" ^
  "Write-Host ('  ' + $shortcutPath);" ^
  "Write-Host ('Target: ' + $wscriptPath);" ^
  "Write-Host ('Arguments: ' + [char]34 + $launcherPath + [char]34);" ^
  "Write-Host ('Icon: ' + $iconPath);"

set "SHORTCUT_EXIT_CODE=%errorlevel%"
echo.
if not "%SHORTCUT_EXIT_CODE%"=="0" (
  echo The 39Note desktop shortcut could not be created.
  echo Review the PowerShell error above.
  echo The launcher files were not changed.
) else (
  echo Double-click 39Note on the Desktop to start the local PDF reader.
)
echo.
pause
exit /b %SHORTCUT_EXIT_CODE%
