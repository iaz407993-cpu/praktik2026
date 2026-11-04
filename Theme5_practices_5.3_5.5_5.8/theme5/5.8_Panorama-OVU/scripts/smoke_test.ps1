# Мінімальна перевірка API. Запуск з кореня (API має працювати): .\scripts\smoke_test.ps1 [-ApiUrl http://localhost:8000]
param([string]$ApiUrl = "http://localhost:8000")
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")
python scripts/smoke_test.py $ApiUrl
exit $LASTEXITCODE
