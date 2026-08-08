@echo off
setlocal

REM Change to the directory containing this batch file
cd /d "%~dp0"

REM Run the road tracer
python trace_roads.py ^
    scum_map_14481.png ^
    --output roads.json ^
    --preview roads_preview.png ^
    --mask-preview roads_mask.png ^
    --white-min-radius 0.8 ^
    --white-max-radius 9.0 ^
    --red-min-area 350 ^
    --red-min-extent 80 ^
    --gap-size 7 ^
    --endpoint-gap 18 ^
    --branch-length 35 ^
    --minimum-road-length 40 ^
    --simplify 2.5 ^
    --target-width 14481 ^
    --target-height 14481

echo.
echo Finished.
pause