#!/usr/bin/env bash
# Мінімальна перевірка API. Запуск з кореня (API має працювати): bash scripts/smoke_test.sh [API_URL]
set -euo pipefail
cd "$(dirname "$0")/.."
python scripts/smoke_test.py "${1:-http://localhost:8000}"
