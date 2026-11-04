#!/usr/bin/env bash
# Застосовує db/schema.sql до БД з DATABASE_URL (.env). Запуск з кореня: bash scripts/init_db.sh
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -f .env ]; then set -a; . ./.env; set +a; fi
: "${DATABASE_URL:?DATABASE_URL не задано — створіть .env з .env.example}"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/schema.sql
echo "OK: схему застосовано"
