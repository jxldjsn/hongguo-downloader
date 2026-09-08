@echo off
chcp 65001 >nul 2>&1
title 抖音下载器
cd /d "%~dp0"

echo ========================================
echo   抖音下载器 - 启动
echo ========================================
echo.

REM 检查 Node.js
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [错误] 未检测到 Node.js，请先安装 Node.js
    pause
    exit /b 1
)

REM 检查依赖
if not exist "node_modules" (
    echo [1/2] 首次运行，正在安装依赖...
    call npm install
    if %errorlevel% neq 0 (
        echo [错误] 依赖安装失败
        pause
        exit /b 1
    )
) else (
    echo [1/2] 依赖已安装，跳过
)

echo.
echo [2/2] 构建前端并启动应用...
call npm run build:react
if %errorlevel% neq 0 (
    echo [错误] 前端构建失败
    pause
    exit /b 1
)

echo.
echo 启动 Electron...
set NODE_ENV=production
call npm start

echo.
echo 应用已退出。
pause
