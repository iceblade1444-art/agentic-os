@echo off
setlocal
title Mila AgentOS
set "ROOT=%AGENTOS_ROOT%"
if "%ROOT%"=="" set "ROOT=C:\Users\User\AgentOS"
set "PORT=%AGENTOS_PORT%"
if "%PORT%"=="" set "PORT=8765"
set "LOGDIR=%ROOT%\logs\runtime"
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
echo Starting Mila AgentOS dashboard on http://127.0.0.1:%PORT%/
start "Mila AgentOS Dashboard" /min cmd /d /c ""python" "%ROOT%\dashboard\backend\app.py" --workspace "%ROOT%" --port "%PORT%" >> "%LOGDIR%\mila-dashboard.log" 2^>^&1"
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:%PORT%/"
echo Mila AgentOS requested. Keep keys in .env; this launcher does not contain secrets.
