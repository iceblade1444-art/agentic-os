@echo off
setlocal
title Install Mila AgentOS Autostart
for %%I in ("%~dp0..") do set ROOT=%%~fI
set STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup
set ENTRY=%STARTUP%\Mila AgentOS.cmd
if not exist "%STARTUP%" mkdir "%STARTUP%"
> "%ENTRY%" echo @echo off
>> "%ENTRY%" echo call "%ROOT%\scripts\start_mila.bat"
echo Installed Mila AgentOS autostart entry:
echo %ENTRY%
echo This installer writes only a Startup launcher. Keep secrets in %ROOT%\.env.
