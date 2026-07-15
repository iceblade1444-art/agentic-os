@echo off
set ROOT=%AGENTOS_ROOT%
if "%ROOT%"=="" set ROOT=C:\Users\User\AgentOS
set PORT=%AGENTOS_PORT%
if "%PORT%"=="" set PORT=8765
python "%ROOT%\dashboard\backend\app.py" --workspace "%ROOT%" --port "%PORT%"
