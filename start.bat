@echo off
setlocal
cd /d "%~dp0"

echo Starting Skill Reader on port 3000...
start "" http://localhost:3000
npm start

endlocal
