@echo off
REM Site Restore Batch Script
REM This script restores the site folder from the compressed backup
REM Usage: reset [folder]

set "_parOneRest=%~1"
set "_checkParOneRest=-%_parOneRest%-"

:: Ensure current directory.
cd /D "%~dp0"

if NOT EXIST "site.zip" (
 call save.bat
)
call :_startReset 1
goto:eof

:_startReset
 if "%1"=="1" (
  if "%_checkParOneRest%"=="--" (
   tar -xf site.zip -C site\
  ) else (
   if NOT EXIST "%_parOneRest%" mkdir "%_parOneRest%" >nul 2>nul
   tar -xf site.zip -C "%_parOneRest%"\
  )
 )
 goto :_removeBatchVariables
goto:eof

:_removeBatchVariables
 set _parOneRest=
 set _checkParOneRest=
goto:eof