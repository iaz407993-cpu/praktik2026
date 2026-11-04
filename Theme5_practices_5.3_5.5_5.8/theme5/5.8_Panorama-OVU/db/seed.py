"""Генерація 500 синтетичних навчальних подій за останні 90 днів.

Запуск з кореня проєкту:  python db/seed.py
Підключення — через DATABASE_URL з файлу .env.
"""
import os
import random
from datetime import datetime, timedelta

import psycopg2
from dotenv import load_dotenv

load_dotenv()
DATABASE_URL = os.getenv("DATABASE_URL")
if not DATABASE_URL:
    raise SystemExit("DATABASE_URL не задано: створіть .env на основі .env.example")

N_RECORDS = 500
DAYS = 90
random.seed(42)  # відтворюваність

SECTORS = ["Сектор А", "Сектор Б", "Сектор В", "Сектор Г", "Сектор Д"]
DIRECTIONS = ["Північний", "Північно-Східний", "Східний", "Південно-Східний", "Південний", "Центральний"]
EVENT_TYPES = ["Обстріл", "Атака БпЛА", "Штурмові дії", "Розвідактивність", "Інженерні роботи"]
SOURCES = ["Спостережний пост", "Аеророзвідка БпЛА", "Радіоперехоплення", "Донесення підрозділу", "Технічні засоби"]

# Невеликі «перекоси», щоб у даних були тренди й лідери, які можна виявити на дашборді
DIRECTION_W = [1.0, 1.4, 2.2, 1.6, 1.0, 0.6]
TYPE_W = [2.5, 2.0, 1.0, 1.5, 0.7]
SECTOR_W = [1.2, 1.8, 1.0, 1.4, 0.6]
BASE_INT = {"Обстріл": 22, "Атака БпЛА": 18, "Штурмові дії": 30, "Розвідактивність": 8, "Інженерні роботи": 6}

TEMPLATES = {
    "Обстріл": "Зафіксовано обстріл позицій, {n} прильотів",
    "Атака БпЛА": "Атака ударних БпЛА, виявлено {n} цілей",
    "Штурмові дії": "Спроба штурмових дій групою до {n} осіб",
    "Розвідактивність": "Активність розвідувальних засобів противника, {n} епізодів",
    "Інженерні роботи": "Ведення інженерних робіт, {n} ділянок",
}


def generate():
    now = datetime.now().replace(minute=0, second=0, microsecond=0)
    rows = []
    for _ in range(N_RECORDS):
        # Частота подій зростає до кінця періоду: свіжі дні ймовірніші (тренд на зростання)
        day_back = int(DAYS * (random.random() ** 1.35))
        ts = now - timedelta(days=day_back, hours=random.randint(0, 23), minutes=random.choice([0, 15, 30, 45]))
        direction = random.choices(DIRECTIONS, DIRECTION_W)[0]
        etype = random.choices(EVENT_TYPES, TYPE_W)[0]
        sector = random.choices(SECTORS, SECTOR_W)[0]
        # «Східний» напрямок — інтенсивність помітно росте в останні 3 тижні
        boost = 12 if (direction == "Східний" and day_back < 21) else 0
        intensity = max(1, min(50, int(random.gauss(BASE_INT[etype] + boost, 7))))
        summary = TEMPLATES[etype].format(n=max(1, intensity // 4)) + f" ({direction.lower()} напрямок)."
        rows.append((ts, sector, direction, etype, intensity, random.choice(SOURCES), summary))
    return rows


def main():
    rows = generate()
    with psycopg2.connect(DATABASE_URL) as conn, conn.cursor() as cur:
        cur.execute("TRUNCATE incidents RESTART IDENTITY")
        cur.executemany(
            "INSERT INTO incidents (occurred_at, sector, direction, event_type, intensity, source, summary) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s)",
            rows,
        )
        cur.execute("SELECT COUNT(*), MIN(occurred_at)::date, MAX(occurred_at)::date FROM incidents")
        n, d1, d2 = cur.fetchone()
    print(f"OK: додано {n} записів, період {d1} … {d2}")


if __name__ == "__main__":
    main()
