@echo off
setlocal
PowerShell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-user.ps1"
if errorlevel 1 (
  echo.
  echo Setup failed. Review the message above.
  exit /b 1
)
echo.
echo Setup files created successfully.
endlocal
