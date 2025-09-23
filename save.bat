@echo off 
REM save
::  Save current site status in site.zip.

cd /D "%~dp0site" 

tar -acf ../site.zip *

cd ..