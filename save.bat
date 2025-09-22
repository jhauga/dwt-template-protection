@echo off 
REM save
::  Save current site status in site.zip.

cd /D "%~dp0site" 

7z a site.zip .

move /Y site.zip ..

cd ..