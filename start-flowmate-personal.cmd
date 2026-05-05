@echo off
setlocal
cd /d "%~dp0"
echo FlowMate personal auto-monitor starting...
echo It will check authorization first, pause if re-authorization is needed, and resume automatically after authorization.
node scripts\watch-personal-messages.js --interval 60
endlocal
