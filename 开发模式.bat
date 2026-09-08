@echo off
chcp 65001 >nul 2>&1
title 抖音下载器 - 开发模式
cd /d "%~dp0"

echo ========================================
echo   抖音下载器 - 开发模式（热更新）
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
    echo [首次运行] 正在安装依赖...
    call npm install
    if %errorlevel% neq 0 (
        echo [错误] 依赖安装失败
        pause
        exit /b 1
    )
)

echo 启动 Vite 开发服务器 + Electron（修改代码会自动刷新）...
echo 关闭此窗口即可退出应用。
echo.

call npm run dev

echo.
echo 应用已退出。
pause
