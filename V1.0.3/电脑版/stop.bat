@echo off
chcp 65001 >nul
title 停止 CyanQiuper
cd /d "%~dp0"

echo.
echo  正在停止 CyanQiuper 服务...
echo.

for %%P in (11451 11452 11453) do (
  for /f "tokens=5" %%A in ('netstat -ano ^| findstr ":%%P " ^| findstr "LISTENING"') do (
    taskkill /PID %%A /F >nul 2>nul
    if not errorlevel 1 echo   已停止监听端口 %%P 的进程（PID %%A）
  )
)

echo.
echo  完成。如果窗口还开着，直接关掉即可。
timeout /t 2 >nul
exit /b 0
