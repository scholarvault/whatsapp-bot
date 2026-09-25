@echo off
chcp 65001 >nul 2>&1
title ScholarVault - Launcher
color 0A

echo.
echo  ========================================================
echo             ScholarVault WhatsApp CRM Launcher
echo  ========================================================
echo.

REM --- Step 1: Redis Background Service ---
echo  [1/3] Checking Redis service...
sc query Redis 2>nul | findstr /i "RUNNING" >nul 2>&1
if %ERRORLEVEL%==0 (
    echo        [OK] Redis is running.
) else (
    net start Redis >nul 2>&1
    if %ERRORLEVEL%==0 (
        echo        [OK] Redis started.
    ) else (
        echo        [INFO] Redis is already active as a background service.
    )
)
echo.

REM --- Step 2: Evolution API (Port 8080) ---
echo  [2/3] Checking Evolution API (Port 8080)...
set "EVO_RUNNING=0"
netstat -aon | findstr ":8080" | findstr "LISTENING" >nul 2>&1
if %ERRORLEVEL%==0 set "EVO_RUNNING=1"
tasklist /FI "WINDOWTITLE eq Evolution API*" 2>nul | findstr /i "cmd.exe" >nul 2>&1
if %ERRORLEVEL%==0 set "EVO_RUNNING=1"

if "%EVO_RUNNING%"=="1" (
    echo        [OK] Evolution API is already active or starting on port 8080.
) else (
    echo        Launching Evolution API...
    start "Evolution API" /D "C:\Users\Shyam\evolution-api" cmd /k "npm run start"
    echo        Waiting for Evolution API to initialize...
    timeout /t 6 /nobreak >nul
    echo        [OK] Evolution API launched.
)
echo.

REM --- Step 3: Campaign & CRM Server (Port 3000) ---
echo  [3/3] Checking Campaign Server (Port 3000)...
set "CRM_RUNNING=0"
netstat -aon | findstr ":3000" | findstr "LISTENING" >nul 2>&1
if %ERRORLEVEL%==0 set "CRM_RUNNING=1"
tasklist /FI "WINDOWTITLE eq ScholarVault Campaign Server*" 2>nul | findstr /i "cmd.exe" >nul 2>&1
if %ERRORLEVEL%==0 set "CRM_RUNNING=1"

if "%CRM_RUNNING%"=="1" (
    echo        [OK] Campaign Server is already running on port 3000.
) else (
    echo        Launching Campaign Server...
    start "ScholarVault Campaign Server" /D "C:\Users\Shyam\Scholar Vault 2\WhatsApp Campaign" cmd /k "node server.js"
    timeout /t 3 /nobreak >nul
    echo        [OK] Campaign Server launched.
)
echo.

REM --- Open Browser ---
echo  Opening CRM in your browser...
start http://localhost:3000/crm

echo.
echo  ========================================================
echo                     CRM READY!
echo  --------------------------------------------------------
echo   CRM Dashboard:  http://localhost:3000/crm
echo   Evolution API:  http://localhost:8080
echo  ========================================================
echo.
echo  Closing launcher window...
timeout /t 3 >nul
exit
