@echo off
chcp 65001 >nul
rem =========================================
rem start-demo.bat
rem （このファイルは UTF-8。日本語を正しく読ませるため、文字コードの切り替え chcp 65001 を
rem   日本語より前の2行目に置いている）
rem 展示用の起動ファイル。ダブルクリックすると、サーバー（Docker）と Ollama を立ち上げ、
rem デモデータを作り直してから、アプリを展示モードで開く。
rem   - 展示モード：記憶をディスクに保存せずログアウトで消す。感情ログ送信の同意もログアウトのたびに消す
rem     （tumugi_app/main.js の EXHIBIT_MODE）。
rem   - デモデータの作り直しで、それまでの感情ログ（前の日の来場者の分も含む）はすべて消える。
rem   - VOICEVOX は、アプリが起動時に自分で立ち上げる（tumugi_app/main.js の startVoicevoxIfNeeded）。
rem 下の2つのパスは、この PC に合わせてある。別の PC で使うときは直すこと。
rem =========================================
setlocal

set "DOCKER_DESKTOP=C:\Program Files\Docker\Docker\Docker Desktop.exe"
set "OLLAMA_APP=%LOCALAPPDATA%\Programs\Ollama\ollama app.exe"
rem アプリと同じモデル・num_ctx で先に読み込む（違うと、最初の返事のときに読み込み直しになる）
set "MODEL=gemma4:e4b"
set "NUM_CTX=8192"

cd /d "%~dp0"

echo [1/5] Docker Desktop を確認しています...
docker info >nul 2>&1
if not errorlevel 1 goto docker_ready
if not exist "%DOCKER_DESKTOP%" goto no_docker
start "" "%DOCKER_DESKTOP%"
call :wait_docker 180
if errorlevel 1 goto docker_timeout
:docker_ready

echo [2/5] サーバーを起動しています...
docker compose up -d
if errorlevel 1 goto compose_failed
call :wait_url http://127.0.0.1:8080/ 60
if errorlevel 1 goto server_timeout

echo [3/5] デモデータを作り直しています...
docker compose run --rm seed --refresh
if errorlevel 1 goto seed_failed

echo [4/5] Ollama を確認しています...
call :wait_url http://127.0.0.1:11434/api/version 1
if not errorlevel 1 goto ollama_ready
if not exist "%OLLAMA_APP%" goto no_ollama
start "" "%OLLAMA_APP%"
call :wait_url http://127.0.0.1:11434/api/version 60
if errorlevel 1 goto ollama_timeout
:ollama_ready
echo       モデルを読み込んでいます（1分ほどかかることがあります）...
curl -s -o nul --max-time 180 http://127.0.0.1:11434/api/generate -d "{\"model\":\"%MODEL%\",\"keep_alive\":\"60m\",\"options\":{\"num_ctx\":%NUM_CTX%}}"

echo [5/5] アプリを展示モードで起動します（VOICEVOX はアプリが立ち上げます）...
cd /d "%~dp0tumugi_app"
call npm start -- --exhibit
exit /b 0

rem -----------------------------------------
rem うまくいかなかったとき
rem -----------------------------------------
:no_docker
set "MESSAGE=Docker Desktop が見つかりません：%DOCKER_DESKTOP%"
goto fail
:docker_timeout
set "MESSAGE=Docker Desktop が3分たっても使えるようになりませんでした。"
goto fail
:compose_failed
set "MESSAGE=docker compose up -d に失敗しました。上のメッセージを確認してください。"
goto fail
:server_timeout
set "MESSAGE=サーバー（127.0.0.1:8080）が応答しません。docker compose logs app を確認してください。"
goto fail
:seed_failed
set "MESSAGE=デモデータを作り直せませんでした。.env の DEMO_SEED が true か確認してください。"
goto fail
:no_ollama
set "MESSAGE=Ollama が見つかりません：%OLLAMA_APP%"
goto fail
:ollama_timeout
set "MESSAGE=Ollama（127.0.0.1:11434）が1分たっても応答しません。"
goto fail

:fail
echo.
echo [起動できませんでした] %MESSAGE%
echo このファイルの先頭のパスと、README の「展示で使うとき」を確認してください。
pause
exit /b 1

rem -----------------------------------------
rem 待つための部品
rem -----------------------------------------
rem %1 の URL が応答するまで、最大 %2 秒待つ（応答すれば成功。HTTP のエラーでも、つながれば成功とする）
:wait_url
set /a WAITED=0
:wait_url_loop
curl -s -o nul --max-time 2 %1 >nul 2>&1
if not errorlevel 1 exit /b 0
set /a WAITED+=2
if %WAITED% geq %2 exit /b 1
timeout /t 2 /nobreak >nul
goto wait_url_loop

rem Docker が使えるようになるまで、最大 %1 秒待つ
:wait_docker
set /a WAITED=0
:wait_docker_loop
docker info >nul 2>&1
if not errorlevel 1 exit /b 0
set /a WAITED+=3
if %WAITED% geq %1 exit /b 1
timeout /t 3 /nobreak >nul
goto wait_docker_loop
