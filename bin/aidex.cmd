@echo off
setlocal
set "ENTRY=%~dp0..\build\index.js"

if not exist "%ENTRY%" (
    >&2 echo AiDex build is missing. Run npm run build.
    exit /b 1
)

if defined AIDEX_NODE (
    set "NODE=%AIDEX_NODE%"
) else (
    set "NODE=node"
)

"%NODE%" "%ENTRY%" %*
exit /b %ERRORLEVEL%
