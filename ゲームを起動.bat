@echo off
chcp 65001 >nul
REM このファイルをダブルクリックすると、サーバーが起動し
REM 既定のブラウザで http://localhost:8081/ が開きます。
REM Windows標準のPowerShellだけで動くので Node.js も Python も不要です。

REM このバッチのある場所へ移動する(ダブルクリックした場所に依存しない)
cd /d "%~dp0"

REM 同じフォルダの serve.ps1 を実行する(実行ポリシーの設定に左右されないよう Bypass 指定)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0serve.ps1"

REM サーバーが止まったら結果が読めるようウィンドウを残す
pause
