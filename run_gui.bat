@echo off
title DEPI Attendance Automation GUI
cd /d "%~dp0"

echo.
echo ========================================
echo   DEPI Attendance Automation GUI
echo ========================================
echo.

npm --version >nul 2>&1
if errorlevel 1 (
  echo Node.js/npm is not installed or not available in PATH.
  echo Install Node.js from https://nodejs.org/ and try again.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo node_modules was not found. Installing dependencies...
  npm install
  if errorlevel 1 (
    echo.
    echo Failed to install dependencies.
    pause
    exit /b 1
  )
)

echo Starting application...
echo.
npm start

if errorlevel 1 (
  echo.
  echo The application exited with an error.
)

pause
