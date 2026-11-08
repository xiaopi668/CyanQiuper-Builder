@echo off
chcp 65001 >nul
title CyanQiuper 后台管理
cd /d "%~dp0"

echo.
echo  ==========================================================
echo    CyanQiuper 后台管理（一键启动）
echo  ----------------------------------------------------------
echo    网页管理页 : http://127.0.0.1:11452
echo    WS 服务    : ws://127.0.0.1:11451
echo    游戏内连接 : /connect ws://127.0.0.1:11451
echo    日志目录   : logs\  （网页里直接查看）
echo  ==========================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo  [错误] 没有找到 node，请先安装 Node.js 再运行。
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\tsx\dist\cli.mjs" (
  echo  [提示] 缺少运行依赖，正在安装（只需一次）...
  call npm install --no-fund --no-audit
  if errorlevel 1 (
    echo  [错误] 依赖安装失败，请检查网络后重试。
    echo.
    pause
    exit /b 1
  )
)

rem 管理页已经在跑时，直接打开浏览器，避免端口冲突
netstat -ano | findstr ":11452" | findstr "LISTENING" >nul 2>nul
if not errorlevel 1 (
  echo  [提示] 管理页已经在运行，直接打开浏览器。
  start "" http://127.0.0.1:11452
  timeout /t 2 >nul
  exit /b 0
)

echo  正在启动服务（关闭本窗口即停止全部服务）...
echo.

node "node_modules\tsx\dist\cli.mjs" admin-server.ts

echo.
echo  服务已退出。
pause
