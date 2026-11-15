@echo off
setlocal EnableExtensions
title ScreenDraw
cd /d "%~dp0"

rem ================= Settings =================
rem Port to host on. Forward this port (TCP) on your router if it isn't done automatically.
set "PORT=8080"
rem Set to 0 to stop ScreenDraw from asking your router to forward the port (UPnP).
set "UPNP=0"
rem Set to 0 to only run the server (no sharer app window).
set "OPEN_SHARER=1"
rem ============================================

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

rem --- 2. The desktop sharer app (Electron), which draws the overlay on your screen
:deps
if "%OPEN_SHARER%"=="0" goto server
if exist "node_modules\electron\dist\electron.exe" goto open_app
echo  Installing the sharer app (one time only, about 100 MB)...
call npm install --no-audit --no-fund --loglevel=error
if exist "node_modules\electron\dist\electron.exe" goto open_app
echo.
echo  The sharer app couldn't be installed, so sharing will open in your browser
echo  instead. Drawings will show over the preview rather than on your screen.
start "" /b cmd /c "ping -n 3 127.0.0.1 >nul & start http://localhost:%PORT%/share.html"
goto server

:open_app
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."

rem --- 3. The server runs in this window; close it to stop
:server
echo.
echo  If Windows asks whether to let Node.js through the firewall, click "Allow".
echo.
node server.js
echo.
echo  Server stopped.
pause
