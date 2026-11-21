@echo off
setlocal EnableExtensions
title ScreenDraw Server
cd /d "%~dp0"

echo.
echo  ScreenDraw server
echo  -----------------

rem --- Settings live in .env (created from .env.example the first time)
if exist ".env" goto have_env
if not exist ".env.example" goto have_env
copy ".env.example" ".env" >nul
echo  Created .env with default settings - edit it to change the port, password etc.
:have_env

rem --- Node.js: a private copy in .\runtime, else an installed v18+, else download one
set "NODE_DIR=%~dp0runtime\node"
if exist "%NODE_DIR%\node.exe" goto use_portable
where node >nul 2>nul
if errorlevel 1 goto get_node
node -e "process.exit(parseInt(process.versions.node) < 18 ? 1 : 0)" >nul 2>nul
if errorlevel 1 goto get_node
echo  Using installed Node.js
goto run

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

:run
echo.
echo  If Windows asks whether to let Node.js through the firewall, click "Allow".
echo.
node server\server.js
echo.
echo  Server stopped.
pause
