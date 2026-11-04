# Застосовує db/schema.sql до БД з DATABASE_URL (.env). Запуск з кореня: .\scripts\init_db.ps1
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")
if (Test-Path .env) {
  Get-Content .env | Where-Object { $_ -match '^\s*[^#].*=' } | ForEach-Object {
    $k, $v = $_ -split '=', 2; Set-Item -Path "Env:$($k.Trim())" -Value $v.Trim()
  }
}
if (-not $env:DATABASE_URL) { throw "DATABASE_URL не задано — створіть .env з .env.example" }
psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f db/schema.sql
if ($LASTEXITCODE -ne 0) { throw "psql завершився з помилкою" }
Write-Host "OK: схему застосовано"
