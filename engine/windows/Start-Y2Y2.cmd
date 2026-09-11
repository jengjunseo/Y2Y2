@echo off
cd /d "%~dp0"
python launch_personal.py
if errorlevel 1 pause
