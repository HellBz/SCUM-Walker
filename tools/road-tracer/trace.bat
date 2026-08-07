@echo off
setlocal
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
    echo The virtual environment is missing.
    echo Run install.bat first.
    pause
    exit /b 1
)

if not exist "input" (
    echo The input folder is missing.
    echo Create an 'input' folder and place your map images there.
    pause
    exit /b 1
)

.venv\Scripts\python.exe -m scum_road_tracer.pipeline --input input --output output --config config.json

if errorlevel 1 (
    echo.
    echo Tracing failed. Check error messages above.
    pause
    exit /b 1
)

echo.
echo Finished. Results are in the output folder.
pause
