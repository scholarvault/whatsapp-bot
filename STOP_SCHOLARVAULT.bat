@echo off
chcp 65001 >nul 2>&1
title ScholarVault - Shutdown
color 0C

echo.
echo  ========================================================
echo         ScholarVault - Shutting Down Services
echo  ========================================================
echo.

echo  [1/2] Stopping Campaign Server (port 3000)...
taskkill /FI "WINDOWTITLE eq ScholarVault Campaign Server*" /F >nul 2>&1
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :3000 ^| findstr LISTENING 2^>nul') do taskkill /PID %%a /F >nul 2>&1
echo        [OK] Campaign Server stopped.
echo.

echo  [2/2] Stopping Evolution API (port 8080)...
taskkill /FI "WINDOWTITLE eq Evolution API*" /F >nul 2>&1
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :8080 ^| findstr LISTENING 2^>nul') do taskkill /PID %%a /F >nul 2>&1
echo        [OK] Evolution API stopped.
echo.

echo  Services stopped successfully.
timeout /t 3 >nul
exit
