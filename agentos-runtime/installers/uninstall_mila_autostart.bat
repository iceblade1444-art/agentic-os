@echo off
setlocal
title Uninstall Mila AgentOS Autostart
set STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup
set ENTRY=%STARTUP%\Mila AgentOS.cmd
if exist "%ENTRY%" del "%ENTRY%"
echo Removed Mila AgentOS autostart entry if it existed:
echo %ENTRY%
