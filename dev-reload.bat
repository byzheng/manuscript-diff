@echo off
setlocal

cd /d "%~dp0"

if not exist "node_modules" (
  echo node_modules not found. Running npm install first...
  call npm install
  if errorlevel 1 exit /b 1
)

echo Starting manuscript-diff with nodemon auto-reload...
call npx nodemon --config nodemon.json

endlocal
