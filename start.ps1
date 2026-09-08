# PowerShell Startup Script
# Usage: Right-click -> Run with PowerShell

$ErrorActionPreference = "Stop"

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Douyin Downloader - Electron Edition" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Check Node.js
Write-Host "[1/3] Checking environment..." -ForegroundColor Yellow
try {
    $nodeVersion = node --version
    Write-Host "[OK] Node.js installed: $nodeVersion" -ForegroundColor Green
} catch {
    Write-Host "[ERROR] Node.js not found. Please install Node.js 18+" -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit 1
}

# Check dependencies
Write-Host ""
Write-Host "[2/3] Checking dependencies..." -ForegroundColor Yellow
if (-not (Test-Path "node_modules")) {
    Write-Host "[INFO] Installing dependencies..." -ForegroundColor Cyan
    npm install
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[ERROR] Failed to install dependencies" -ForegroundColor Red
        Read-Host "Press Enter to exit"
        exit 1
    }
    Write-Host "[OK] Dependencies installed" -ForegroundColor Green
} else {
    Write-Host "[OK] Dependencies already installed" -ForegroundColor Green
}

# Select mode
Write-Host ""
Write-Host "[3/3] Starting application..." -ForegroundColor Yellow
Write-Host ""
Write-Host "Select startup mode:" -ForegroundColor Cyan
Write-Host "  [1] Development mode (need Python source code)" -ForegroundColor White
Write-Host "  [2] Production mode (need python-backend folder)" -ForegroundColor White
Write-Host ""

$mode = Read-Host "Enter option (1/2)"

if ($mode -eq "1") {
    Write-Host ""
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host "  Development Mode" -ForegroundColor Cyan
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host ""

    # Check Python source
    $pythonSource = "..\抖音下载器源码"
    if (-not (Test-Path $pythonSource)) {
        Write-Host "[ERROR] Python source code not found at: $pythonSource" -ForegroundColor Red
        Write-Host ""
        Write-Host "Please ensure the source code is at the correct location." -ForegroundColor Yellow
        Read-Host "Press Enter to exit"
        exit 1
    }

    Write-Host "[OK] Python source found" -ForegroundColor Green
    Write-Host ""
    Write-Host "Starting React dev server..." -ForegroundColor Cyan

    # Start React dev server in new window
    Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$PWD'; npm run dev:react"

    Write-Host "[INFO] Waiting for React dev server to start..." -ForegroundColor Yellow
    Start-Sleep -Seconds 5

    Write-Host ""
    Write-Host "Starting Electron..." -ForegroundColor Cyan
    npm start

} elseif ($mode -eq "2") {
    Write-Host ""
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host "  Production Mode" -ForegroundColor Cyan
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host ""

    # Check python-backend
    if (-not (Test-Path "python-backend\main.exe")) {
        Write-Host "[ERROR] python-backend\main.exe not found" -ForegroundColor Red
        Write-Host ""
        Write-Host "Please build Python backend first:" -ForegroundColor Yellow
        Write-Host "  1. cd ..\抖音下载器源码" -ForegroundColor White
        Write-Host "  2. pyinstaller --onefile --add-data 'static:static' main.py" -ForegroundColor White
        Write-Host "  3. Copy dist\main folder to python-backend\" -ForegroundColor White
        Write-Host ""
        Read-Host "Press Enter to exit"
        exit 1
    }

    Write-Host "[OK] Python backend found" -ForegroundColor Green
    Write-Host ""
    Write-Host "Starting application..." -ForegroundColor Cyan
    npm start

} else {
    Write-Host ""
    Write-Host "[ERROR] Invalid option" -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit 1
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Startup Complete" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Read-Host "Press Enter to exit"
