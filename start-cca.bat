@echo off
REM Start CCA Monitor processes via pm2
REM Place a shortcut to this file in shell:startup to auto-start on boot

cd /d "%~dp0"
timeout /t 15 /nobreak >nul
pm2 start ecosystem.config.cjs
pm2 save
