@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul || (
  echo [Cioppino] Node.js 24 or newer is required: https://nodejs.org/
  pause
  exit /b 1
)
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 24 ? 0 : 1)" || (
  echo [Cioppino] Node.js 24 or newer is required.
  pause
  exit /b 1
)
if not exist "backend\dist\server.js" (
  echo [Cioppino] Build output is missing. Run: npm ci ^&^& npm run build
  pause
  exit /b 1
)
node scripts\start.mjs
