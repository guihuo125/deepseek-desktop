@echo off
taskkill /f /im DeepSeek.exe >nul 2>&1
timeout /t 2 /nobreak >nul
"D:\DeepSeek 桌面应用\deepseek-app\inno-out\DeepSeek-Setup-1.0.0.exe" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /FORCECLOSEAPPLICATIONS
start "" "C:\Users\39007\AppData\Local\Programs\DeepSeek\DeepSeek.exe"