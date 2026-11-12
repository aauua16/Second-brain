@echo off
chcp 65001 > nul
cd /d "%~dp0"
echo Second Brain を起動中...
echo ブラウザで http://localhost:8000 を開いてください (終了: Ctrl+C)
echo.
rem 同一LAN内の他端末から使う場合のみ HOST=0.0.0.0 に変更（認証なしなので注意）
if "%HOST%"=="" set HOST=127.0.0.1
python -m uvicorn main:app --host %HOST% --port 8000
pause
