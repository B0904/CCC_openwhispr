@echo off
rem CCC_openwhispr launcher. Double-click to sync this fork with the latest OpenWhispr
rem release, install what changed and start the app. All logic lives in
rem scripts\fork-sync\ (run.ps1, then sync-and-run.js), so this file never needs edits.
rem Keep everything below on ONE line: Windows reads .bat files while they run, and the
rem sync may replace this file mid-run.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\fork-sync\run.ps1" %* || (echo. & echo The launcher reported a problem. Please read the messages above. & pause)
