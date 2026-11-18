@echo off
rem PurpleSector - live timing for Velocidrone. Double-click to start; the page opens in your browser.
title PurpleSector
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Get the LTS version from https://nodejs.org and run this again.
  pause
  exit /b 1
)
node "%~dp0sector-timer.mjs" --open %*
pause
