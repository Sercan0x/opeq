@echo off
if not exist "%~dp0app\opeq.ps1" goto zip
echo "%~dp0" | "%SystemRoot%\System32\find.exe" /i ".zip\" >nul && goto zip
start "" "%SystemRoot%\System32\conhost.exe" --headless "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0app\opeq.ps1"
exit /b
:zip
echo.
echo  OPEQ is still inside the zip file.
echo.
echo  1. Close this window.
echo  2. Right-click OPEQ-USB.zip and choose "Extract All".
echo  3. Copy the OPEQ-USB folder to your USB stick.
echo  4. Double-click OPEQ inside that folder on the stick.
echo.
pause
