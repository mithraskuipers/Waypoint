@echo off
cd /d "%~dp0"
set PORT=8000

where python >nul 2>nul
if %errorlevel%==0 (
    set PYCMD=python
) else (
    where py >nul 2>nul
    if %errorlevel%==0 (
        set PYCMD=py
    ) else (
        echo Python was not found. Install it from https://python.org and try again.
        pause
        exit /b 1
    )
)

echo Starting Waypoint on http://localhost:%PORT%/ ...
start "Waypoint server" /min cmd /c "%PYCMD% "%~dp0serve.py" %PORT%"
timeout /t 2 /nobreak >nul
start "" "http://localhost:%PORT%/"

echo Waypoint is running at http://localhost:%PORT%/
echo Close the "Waypoint server" window to stop the local server.
pause >nul
