@echo off
title orc
node --disable-warning=ExperimentalWarning "%~dp0src\cli.ts" ui %*
if errorlevel 1 pause
