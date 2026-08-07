@echo off
setlocal
cd /d "%~dp0"

if not exist "editor\index.html" (
    echo Editor files not found in 'editor' folder.
    pause
    exit /b 1
)

echo Starting local HTTP server on port 8080...
echo Editor will open in your browser automatically.
echo Press Ctrl+C to stop the server.

start "" "http://localhost:8080/editor/index.html"

where py >nul 2>nul
if errorlevel 1 (
    where python >nul 2>nul
    if errorlevel 1 (
        echo Python not found. Install Python 3.11+ and add to PATH.
        pause
        exit /b 1
    )
    python -m http.server 8080
) else (
    py -m http.server 8080
)

if errorlevel 1 (
    echo.
    echo Failed to start HTTP server.
    pause
    exit /b 1
)
