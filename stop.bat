@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

set "PORT=3000"
set "FOUND="
set "STOPPED="
set "FAILED="

echo Stopping Skill Reader on port %PORT%...
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /R /C:":%PORT% .*LISTENING"') do (
  if not defined PID_%%P (
    set "PID_%%P=1"
    set "FOUND=1"
    taskkill /PID %%P /F >nul 2>&1
    if errorlevel 1 (
      echo Failed to stop PID %%P.
      set "FAILED=1"
    ) else (
      echo Stopped PID %%P.
      set "STOPPED=1"
    )
  )
)

if defined STOPPED (
  echo Skill Reader stopped.
) else if defined FAILED (
  echo Stop request reached the process, but Windows denied termination.
  echo Try running stop.bat as Administrator.
) else if defined FOUND (
  echo A process was found, but it could not be stopped.
) else (
  echo No listening process found on port %PORT%.
)

pause
endlocal
