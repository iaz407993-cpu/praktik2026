#!/usr/bin/env bash
# Заповнює БД тестовими даними. Запуск з кореня: bash scripts/seed_db.sh
set -euo pipefail
cd "$(dirname "$0")/.."
python db/seed.py
