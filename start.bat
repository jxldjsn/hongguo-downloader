@echo off
title Douyin Downloader - Start

echo ========================================
echo   Douyin Downloader Electron
echo ========================================
echo.

echo [1/3] Checking environment...
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js not found
    pause
    exit /b 1
)

echo [OK] Node.js installed

echo.
echo [2/3] Checking dependencies...
if not exist "node_modules" (
    echo [INFO] Installing dependencies...
    call npm install
    if %errorlevel% neq 0 (
        echo [ERROR] Failed to install dependencies
        pause
        exit /b 1
    )
)

echo [OK] Dependencies installed

echo.
echo [3/3] Starting application...
echo.
echo Select mode:
echo   [1] Development mode (need Python source code)
echo   [2] Production mode (need python-backend folder)
echo.
set /p mode="Enter option (1/2): "

if "%mode%"=="1" (
    echo.
    echo ========================================
    echo   Development Mode
    echo ========================================
    echo.
    echo Starting React dev server...
    start "React Dev Server" cmd /k "npm run dev:react"
    echo.
    timeout /t 3 >nul
    echo Starting Electron...
    start "Electron" cmd /k "npm start"
    echo.
    echo [OK] Application started!
    echo.
) else if "%mode%"=="2" (
    echo.
    echo ========================================
    echo   Production Mode
    echo ========================================
    echo.
    if not exist "python-backend\main.exe" (
        echo [ERROR] python-backend\main.exe not found
        echo.
        echo Please build Python backend first:
        echo   1. cd ..\TikTokDownloader
        echo   2. pyinstaller --onefile main.py
        echo   3. Copy dist\main to python-backend folder
        echo.
        pause
        exit /b 1
    )
    
    echo [OK] Python backend found
    echo.
    echo Starting application...
    call npm start
) else (
    echo.
    echo [ERROR] Invalid option
    pause
    exit /b 1
)

echo.
pause
