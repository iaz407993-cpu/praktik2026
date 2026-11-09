# Запуск усього дашборду: PostgreSQL -> FastAPI (8000) -> фронтенд (5500)
# Використання:  powershell -ExecutionPolicy Bypass -File .\start.ps1
$ErrorActionPreference = "Stop"
$root   = $PSScriptRoot
$pgBin  = "C:\Users\User\pgsql\bin"
$pgData = "C:\Users\User\pgsql-data"
$py     = Join-Path $root "backend\.venv\Scripts\python.exe"

# 1. PostgreSQL (портативний, не служба)
& "$pgBin\pg_isready.exe" -h localhost -p 5432 *> $null
if ($LASTEXITCODE -ne 0) {
    Write-Host "[1/3] Запуск PostgreSQL..."
    & "$pgBin\pg_ctl.exe" -D $pgData -l "$pgData\server.log" start | Out-Null
    Start-Sleep -Seconds 2
} else { Write-Host "[1/3] PostgreSQL уже працює" }

# 2. Бекенд
Write-Host "[2/3] Бекенд  -> http://localhost:8000/docs"
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$root\backend'; & '$py' -m uvicorn main:app --reload --port 8000"

# 3. Фронтенд
Write-Host "[3/3] Фронтенд -> http://localhost:5500"
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$root\frontend'; & '$py' -m http.server 5500"

Start-Sleep -Seconds 3
Start-Process "http://localhost:5500"
