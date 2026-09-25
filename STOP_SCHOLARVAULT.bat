@echo off
chcp 65001 >nul 2>&1
title ScholarVault - Shutdown
color 0C

echo.
echo  ========================================================
echo         ScholarVault - Shutting Down Services
echo  ========================================================
echo.

echo  [1/4] Stopping Campaign Server (node)...
taskkill /FI "WINDOWTITLE eq ScholarVault Campaign Server*" /F >nul 2>&1
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :3000 ^| findstr LISTENING 2^>nul') do taskkill /PID %%a /F >nul 2>&1
echo        [OK] Campaign Server stopped.
echo.

echo  [2/4] Stopping Cloudflare Tunnel...
taskkill /FI "WINDOWTITLE eq Cloudflare Tunnel*" /F >nul 2>&1
taskkill /IM cloudflared.exe /F >nul 2>&1
echo        [OK] Cloudflare Tunnel stopped.
echo.

echo  [3/4] Stopping Evolution API...
taskkill /FI "WINDOWTITLE eq Evolution API*" /F >nul 2>&1
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :8080 ^| findstr LISTENING 2^>nul') do taskkill /PID %%a /F >nul 2>&1
echo        [OK] Evolution API stopped.
echo.

echo  [4/4] Stopping Listmonk...
taskkill /FI "WINDOWTITLE eq Listmonk Server*" /F >nul 2>&1
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :9000 ^| findstr LISTENING 2^>nul') do taskkill /PID %%a /F >nul 2>&1
echo        [OK] Listmonk stopped.
echo.

echo  NOTE: Redis is left running (system service).
echo  To stop Redis manually: net stop Redis
echo.
echo  All services stopped. Press any key to close.
pause >nul
