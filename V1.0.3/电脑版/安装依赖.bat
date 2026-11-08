@echo off
chcp 65001 >nul
title CyanQiuper 安装依赖
cd /d "%~dp0"
echo ==========================================================
echo   正在安装运行依赖（只需一次，约 1-2 分钟）
echo ==========================================================
call npm install
echo.
echo 安装完成，以后直接双击 start.bat 启动。
pause >nul