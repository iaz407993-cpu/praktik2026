# Заповнює БД тестовими даними. Запуск з кореня: .\scripts\seed_db.ps1
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")
python db/seed.py
