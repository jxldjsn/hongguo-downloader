@echo off
chcp 65001 >nul 2>&1
title Douyin Downloader

echo ========================================
echo   Douyin Downloader - One Click Start
echo   (Native Node.js API - No Python Required)
echo ========================================
echo.

cd /d "%~dp0"

REM Start React dev server
echo [1/2] Starting React dev server...
start "React Server" /min cmd /c "cd /d "%~dp0" && npm run dev:react"

REM Wait for React to start
echo [INFO] Waiting for React server (5s)...
timeout /t 5 /nobreak >nul

REM Start Electron (using native API)
echo [2/2] Starting Electron app...
npm start
