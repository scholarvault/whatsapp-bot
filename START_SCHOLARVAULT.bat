@echo off
chcp 65001 >nul 2>&1
title ScholarVault - Master Launcher
color 0A

echo.
echo  ========================================================
echo       ScholarVault Campaign Command Center
echo              ONE-CLICK LAUNCHER
echo  ========================================================
echo.

REM --- Step 0: Request Admin if needed for Redis ---
net session >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo  [INFO] Requesting Administrator access for Redis...
    powershell -Command "Start-Process '%~f0' -Verb RunAs"
    exit /b
)

REM --- Step 1: Redis ---
echo  [1/5] Checking Redis...
sc query Redis | findstr /i "RUNNING" >nul 2>&1
if %ERRORLEVEL%==0 (
    echo        [OK] Redis is already running.
) else (
    echo        Starting Redis service...
    net start Redis >nul 2>&1
    if %ERRORLEVEL%==0 (
        echo        [OK] Redis started.
    ) else (
        echo        [WARN] Could not start Redis. You may need to start it manually.
    )
)
echo.

REM --- Step 2: Listmonk retirement ---
echo  [2/5] Listmonk is retired from normal CRM operations.
echo        [OK] Skipped. Its local files remain untouched for recovery.
echo.

REM --- Step 3: Evolution API ---
echo  [3/5] Starting Evolution API on port 8080...
start "Evolution API" /D "C:\Users\Shyam\evolution-api" cmd /k "npm run start"
echo        [OK] Evolution API launched.
echo.

REM --- Wait for Evolution API to boot ---
echo  [..] Waiting 15 seconds for Evolution API to initialize...
timeout /t 15 /nobreak >nul
echo        [OK] Services should be ready.
echo.

REM --- Step 4: Campaign Server ---
echo  [4/5] Starting Campaign Server on port 3000...
start "ScholarVault Campaign Server" /D "C:\Users\Shyam\Scholar Vault 2\WhatsApp Campaign" cmd /k "node server.js"
echo        [OK] Campaign Server launched.
echo.

REM --- Open Browser ---
echo  Waiting 5 seconds for Campaign Server to boot...
timeout /t 5 /nobreak >nul
start http://localhost:3000/crm

echo.
echo  ========================================================
echo                   ALL SYSTEMS GO!
echo  --------------------------------------------------------
echo   CRM:          http://localhost:3000/crm
echo   Legacy UI:    http://localhost:3000/legacy
echo   Evolution:    http://localhost:8080
echo   Listmonk:     Retired from normal operations (local archive retained)
echo   Cloudflare:    Disabled for local-only work
echo  ========================================================
echo.
echo  Each service is running in its own window.
echo  Close this launcher window anytime - services stay alive.
echo.
pause
