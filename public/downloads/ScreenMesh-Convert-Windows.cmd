@echo off
rem ScreenMesh local video converter launcher for Windows.
rem Drag one or more video files or folders onto this file.
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0ScreenMesh-Convert-Windows.ps1" %*
set "converter_exit=%ERRORLEVEL%"
echo.
pause
exit /b %converter_exit%
