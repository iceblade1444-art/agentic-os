@echo off
set ROOT=%AGENTOS_ROOT%
if "%ROOT%"=="" set ROOT=C:\Users\User\AgentOS
set CYCLES=%AGENTOS_VOICE_CYCLES%
if "%CYCLES%"=="" set CYCLES=3
set INTERVAL=%AGENTOS_VOICE_INTERVAL%
if "%INTERVAL%"=="" set INTERVAL=1
python "%ROOT%\agentosctl.py" --workspace "%ROOT%" voice loop --provider local_file --cycles "%CYCLES%" --interval "%INTERVAL%"
