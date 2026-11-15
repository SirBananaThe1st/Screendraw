@echo off
setlocal EnableExtensions
title ScreenDraw
cd /d "%~dp0"

rem ================= Settings =================
rem Port to host on. Forward this port (TCP) on your router if it isn't done automatically.
set "PORT=8080"
rem Set to 0 to stop ScreenDraw from asking your router to forward the port (UPnP).
set "UPNP=1"
rem Set to 0 to only run the server (no sharer app window).
set "OPEN_SHARER=1"
rem ============================================

rem Version of the Electron runtime used by the desktop sharer app.
set "ELECTRON_VERSION=33.4.11"

set "SCREENDRAW_SERVER=http://localhost:%PORT%"
set "NODE_DIR=%~dp0runtime\node"

echo.
echo  ScreenDraw launcher
echo  -------------------

rem --- 1. Node.js: a private copy in .\runtime, else an installed v18+, else download one
if exist "%NODE_DIR%\node.exe" goto use_portable
where node >nul 2>nul
if errorlevel 1 goto get_node
node -e "process.exit(parseInt(process.versions.node) < 18 ? 1 : 0)" >nul 2>nul
if errorlevel 1 goto get_node
echo  Using installed Node.js
goto deps

:get_node
echo  Node.js not found - downloading a private copy (one time only, about 30 MB)...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\get-node.ps1" -Dest "%NODE_DIR%"
if not errorlevel 1 goto use_portable
echo.
echo  Could not download Node.js. Check your internet connection, or install it
echo  from https://nodejs.org and run this again.
pause
exit /b 1

:use_portable
set "PATH=%NODE_DIR%;%PATH%"
echo  Using bundled Node.js

rem --- 2. The desktop sharer app, which draws the overlay on your screen
:deps
if "%OPEN_SHARER%"=="0" goto server
set "ELECTRON_DIR=%~dp0runtime\electron"
if exist "%ELECTRON_DIR%\electron.exe" goto open_app
echo  Downloading the sharer app (one time only)...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\get-electron.ps1" -Version %ELECTRON_VERSION% -Dest "%ELECTRON_DIR%"
if exist "%ELECTRON_DIR%\electron.exe" goto open_app

rem Fallback: share from a Chromium browser (Firefox often has WebRTC switched off).
echo.
echo  ==================================================================
echo   The desktop sharer app couldn't be installed - see the error above.
echo   Run this launcher again to retry. For now, sharing will open in
echo   your browser; drawings will show over the preview there instead
echo   of on top of your screen.
echo  ==================================================================
set "BROWSER="
for %%B in (chrome.exe msedge.exe) do if not defined BROWSER reg query "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\%%B" >nul 2>nul && set "BROWSER=%%B"
for %%B in (chrome.exe msedge.exe) do if not defined BROWSER reg query "HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\%%B" >nul 2>nul && set "BROWSER=%%B"
if defined BROWSER goto open_browser
echo   No Chrome or Edge found, so using your default browser. If that's
echo   Firefox and it says WebRTC is off, follow the steps it shows.
start "" /b cmd /c "ping -n 3 127.0.0.1 >nul & start http://localhost:%PORT%/share.html"
goto server

:open_browser
start "" /b cmd /c "ping -n 3 127.0.0.1 >nul & start %BROWSER% http://localhost:%PORT%/share.html"
goto server

:open_app
echo  Opening the ScreenDraw sharer app... (if it doesn't appear, see sharer-app.log)
start "" "%ELECTRON_DIR%\electron.exe" "%~dp0."

rem --- 3. The server runs in this window; close it to stop
:server
echo.
echo  If Windows asks whether to let Node.js through the firewall, click "Allow".
echo.
node server.js
echo.
echo  Server stopped.
pause
