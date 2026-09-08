@echo off
title Kill All Electron Processes
chcp 65001 >nul
setlocal enabledelayedexpansion

echo ========================================
echo   Kill All Electron Processes
echo ========================================
echo.

echo Searching for Electron-related processes...
echo.

set "killed=0"

REM Match by image name: electron.exe (covers both packaged and npm-start launched)
for /f "tokens=2" %%a in ('tasklist /fi "imagename eq electron.exe" /nh 2^>nul ^| findstr /i "electron.exe"') do (
    echo [KILL] PID %%a  electron.exe
    taskkill /f /pid %%a >nul 2>&1
    set /a killed+=1
)

REM Match packaged main process names (English variants)
for %%n in (DouyinDownloader.exe douyin-downloader.exe) do (
    for /f "tokens=2" %%a in ('tasklist /fi "imagename eq %%n" /nh 2^>nul ^| findstr /i "%%n"') do (
        echo [KILL] PID %%a  %%n
        taskkill /f /pid %%a >nul 2>&1
        set /a killed+=1
    )
)

REM Match Chinese-named packaged exe via tasklist + findstr
for /f "tokens=2" %%a in ('tasklist /nh 2^>nul ^| findstr /i "下载器.exe"') do (
    echo [KILL] PID %%a  packaged-cn-exe
    taskkill /f /pid %%a >nul 2>&1
    set /a killed+=1
)

echo.
if !killed! equ 0 (
    echo [OK] No Electron process found. Already clean.
) else (
    echo [OK] Killed !killed! Electron-related process^(es^).
)

echo.
echo Verifying no leftover:
tasklist /fi "imagename eq electron.exe" /nh 2>nul | findstr /i "electron.exe" >nul && (
    echo [WARN] electron.exe still running:
    tasklist /fi "imagename eq electron.exe"
) || echo [OK] All electron.exe terminated.

echo.
pause
