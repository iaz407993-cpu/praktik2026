"""Мінімальний доступ до PostgreSQL: без пулів, без async, без ORM."""
import os
from contextlib import contextmanager

import psycopg2
import psycopg2.extras
from dotenv import load_dotenv

load_dotenv()
DATABASE_URL = os.getenv("DATABASE_URL")


@contextmanager
def get_conn():
    """Відкриває з'єднання (autocommit=True) і гарантовано закриває його."""
    if not DATABASE_URL:
        raise RuntimeError("DATABASE_URL не задано (див. .env.example)")
    conn = psycopg2.connect(DATABASE_URL)
    conn.autocommit = True
    try:
        yield conn
    finally:
        conn.close()


def fetch_all(sql, params=None):
    with get_conn() as conn, conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(sql, params or [])
        return cur.fetchall()


def fetch_one(sql, params=None):
    rows = fetch_all(sql, params)
    return rows[0] if rows else None
