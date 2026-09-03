@echo off
rem start-jarvis.cmd - launches the Jarvis daemon with logging.
rem Used by the Task Scheduler 'Jarvis' task.
setlocal
set "NODE=C:\Program Files\nodejs\node.exe"
set "DAEMON=C:\Users\rodne\jarvis\server\daemon.js"
set "LOG=C:\Users\rodne\jarvis\logs"
set "OPENCODE_BIN=%APPDATA%\npm\opencode.cmd"
set "PATH=%APPDATA%\npm;%PATH%"
if not exist "%LOG%" mkdir "%LOG%"
cd /d "C:\Users\rodne\jarvis\server"
"%NODE%" "%DAEMON%" >> "%LOG%\jarvis.out.log" 2>> "%LOG%\jarvis.err.log"
exit /b %ERRORLEVEL%
