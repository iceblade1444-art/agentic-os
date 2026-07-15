@echo off
REM Mila native tray scaffold launcher. Secret-free; credentials stay in environment/local config.
REM Dashboard: http://127.0.0.1:8765/ ; action=open_dashboard
cd /d "%~dp0.."
python scripts\mila_tray.py open_dashboard
