@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 请先安装 Node.js 20 或更新版本，然后重新打开。
  pause
  exit /b 1
)
if not exist node_modules\qrcode\package.json (
  echo 正在安装二维码组件，首次运行需要联网。
  call npm.cmd ci --no-audit --no-fund
  if errorlevel 1 (
    echo 安装失败，请检查网络后重新运行。
    pause
    exit /b 1
  )
)
node launch.js %*
if errorlevel 1 pause
