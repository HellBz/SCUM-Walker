@echo off
chcp 65001 >nul
setlocal

cd /d "%~dp0"

if exist ".venv\Scripts\python.exe" (
    set PYTHON=.venv\Scripts\python.exe
) else if exist "..\02-road-tracer\.venv\Scripts\python.exe" (
    set PYTHON=..\02-road-tracer\.venv\Scripts\python.exe
) else if exist "..\..\road-tracer\.venv\Scripts\python.exe" (
    set PYTHON=..\..\road-tracer\.venv\Scripts\python.exe
) else (
    set PYTHON=python
)

%PYTHON% -m pip install -q -r requirements.txt 2>nul
%PYTHON% editor.py
pause
