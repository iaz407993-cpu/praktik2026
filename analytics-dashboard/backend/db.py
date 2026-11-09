"""Підключення до PostgreSQL через pg8000 (чистий Python — працює на будь-якій версії Python,
не потребує компіляції чи libpq)."""
import os
from contextlib import contextmanager
from decimal import Decimal
from datetime import datetime, date

import pg8000.native
from dotenv import load_dotenv

load_dotenv()

DB_CONFIG = {
    "host": os.getenv("DB_HOST", "localhost"),
    "port": int(os.getenv("DB_PORT", "5432")),
    "database": os.getenv("DB_NAME", "analytics_db"),
    "user": os.getenv("DB_USER", "postgres"),
    "password": os.getenv("DB_PASSWORD", "postgres"),
}


@contextmanager
def connect(database: str | None = None):
    cfg = dict(DB_CONFIG)
    if database:
        cfg["database"] = database
    conn = pg8000.native.Connection(**cfg)
    try:
        yield conn
    finally:
        conn.close()


def _clean(v):
    if isinstance(v, Decimal):
        return int(v) if v == v.to_integral_value() else float(v)
    if isinstance(v, (datetime, date)):
        return v.isoformat()
    return v


def query(sql: str, **params) -> list[dict]:
    """Виконати SELECT і повернути список словників (готово для JSON)."""
    with connect() as conn:
        rows = conn.run(sql, **params)
        cols = [c["name"] for c in conn.columns] if conn.columns else []
        return [{k: _clean(v) for k, v in zip(cols, row)} for row in rows]


def query_one(sql: str, **params) -> dict:
    rows = query(sql, **params)
    return rows[0] if rows else {}
