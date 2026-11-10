@echo off
setlocal
cd /d "%~dp0windows"
where node >nul 2>nul || (echo Node.js 22 or later is required. & exit /b 1)
call npm install --no-audit --no-fund || exit /b 1
set CSC_IDENTITY_AUTO_DISCOVERY=false
call npm run dist:win || exit /b 1
echo Done: windows\dist\
