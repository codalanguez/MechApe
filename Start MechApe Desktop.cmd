@echo off
title MechApe Desktop
cd /d "%~dp0"

rem Models folder: uses your MECHAPE_MODELS_DIR env var if set, otherwise
rem defaults to a folder beside your projects data (changeable in Preferences).

rem first run: install dependencies (Electron included)
if not exist "node_modules\electron" (
    echo Installing dependencies, this may take a minute...
    call npm install
)

rem launch the native desktop app — downloads/verifies llama-server on first
rem run, then starts it + the server automatically
".\node_modules\.bin\electron.cmd" .
