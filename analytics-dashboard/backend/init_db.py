"""Створює базу analytics_db і заливає ../database/*.sql без psql.

Запуск:  python init_db.py
"""
from pathlib import Path

from db import DB_CONFIG, connect

SQL_DIR = Path(__file__).resolve().parent.parent / "database"
DB_NAME = DB_CONFIG["database"]

# 1. Створити базу, якщо її немає
with connect("postgres") as conn:
    if not conn.run("SELECT 1 FROM pg_database WHERE datname = :n", n=DB_NAME):
        conn.run(f'CREATE DATABASE "{DB_NAME}"')
        print(f"[+] Створено базу {DB_NAME}")
    else:
        print(f"[=] База {DB_NAME} вже існує")

# 2. Виконати SQL-файли по черзі
with connect() as conn:
    for f in sorted(SQL_DIR.glob("*.sql")):
        print(f"[>] {f.name}")
        conn.run(f.read_text(encoding="utf-8"))
    for name, cnt in conn.run(
        "SELECT 'units', count(*) FROM units UNION ALL SELECT 'events', count(*) FROM events"
    ):
        print(f"    {name}: {cnt}")

print("[OK] Базу даних готово.")
