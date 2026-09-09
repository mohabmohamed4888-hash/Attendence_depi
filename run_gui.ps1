Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  DEPI Attendance Automation GUI" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

$npmCheck = npm --version
if ($LASTEXITCODE -ne 0) {
    Write-Host "Node.js/npm is not installed or not available in PATH." -ForegroundColor Red
    Write-Host "Install Node.js from https://nodejs.org/ and try again." -ForegroundColor Yellow
    Read-Host "Press Enter to exit"
    exit 1
}

Write-Host "npm Version: $npmCheck" -ForegroundColor Green
Write-Host ""

if (-not (Test-Path "node_modules")) {
    Write-Host "node_modules was not found. Installing dependencies..." -ForegroundColor Yellow
    npm install
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Failed to install dependencies." -ForegroundColor Red
        Read-Host "Press Enter to exit"
        exit 1
    }
}

Write-Host "Starting application..." -ForegroundColor Green
Write-Host ""

npm start

if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "The application exited with an error." -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit 1
}
