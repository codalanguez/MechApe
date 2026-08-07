@echo off
title MechApe
cd /d "%~dp0"

rem Headless mode expects you to have already started the two llama-server
rem instances yourself (see the README's Quick start section) — this window
rem only launches the Express server, it doesn't manage llama.cpp for you.
rem For that, use "Start MechApe Desktop.cmd" instead, which downloads and
rem supervises everything automatically.

echo Starting MechApe at http://localhost:8113 ...
echo (make sure your llama-server chat + embed instances are already running — see README.md)
start "" http://localhost:8113
node server.js
