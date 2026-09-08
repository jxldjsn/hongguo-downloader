@echo off
title Electron App

echo Starting React dev server...
start "React" cmd /k "npm run dev:react"

echo Waiting 5 seconds...
timeout /t 5 /nobreak >nul

echo Starting Electron...
npm start
