@echo off
cd /d "%~dp0"
start "" "http://127.0.0.1:8080/regrip-flex-monitor.html"
node server.mjs
