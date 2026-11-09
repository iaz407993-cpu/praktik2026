"""Аналітичний дашборд — REST API (FastAPI).

Запуск:   uvicorn main:app --reload --port 8000
Документація (Swagger): http://localhost:8000/docs

Спільні фільтри вибірки (для подій, уражень і втрат):
    date_from, date_to  — YYYY-MM-DD, межі включно
    region_id           — id області
    strike_type         — коди видів ураження через кому: fpv,artillery
"""
import csv
import io
from datetime import date, timedelta

from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response

from db import query, query_one

app = FastAPI(title="Analytics Dashboard API", version="1.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],          # для локальної розробки; в продакшні вкажіть домен фронтенду
    allow_methods=["GET"],
    allow_headers=["*"],
    expose_headers=["Content-Disposition"],
)

MAX_RANGE_DAYS = 731


def safe(fn):
    """Повертає 503 з поясненням, якщо БД недоступна."""
    try:
        return fn()
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=503, detail=f"Database error: {exc}") from exc


# ---------------------------- Фільтри ----------------------------

def resolve_period(date_from: date | None, date_to: date | None, days: int) -> tuple[date, date]:
    """Без дат — останні `days` днів; з однією датою — добудовує іншу."""
    if date_to is None:
        date_to = date.today() if date_from is None else max(date_from, date.today())
    if date_from is None:
        date_from = date_to - timedelta(days=days - 1)
    if date_from > date_to:
        raise HTTPException(422, "date_from не може бути пізніше за date_to")
    if (date_to - date_from).days + 1 > MAX_RANGE_DAYS:
        raise HTTPException(422, f"Період не може перевищувати {MAX_RANGE_DAYS} днів")
    return date_from, date_to


class Filters:
    """Спільні параметри вибірки (дати + область + види ураження)."""

    def __init__(
        self,
        date_from: date | None = Query(None, description="Початок періоду (включно), YYYY-MM-DD"),
        date_to: date | None = Query(None, description="Кінець періоду (включно), YYYY-MM-DD"),
        days: int = Query(30, ge=1, le=MAX_RANGE_DAYS, description="Якщо дати не задано — останні N днів"),
        region_id: int | None = Query(None, description="id області"),
        strike_type: str | None = Query(None, pattern=r"^[a-z_]+(,[a-z_]+)*$",
                                        description="Коди видів ураження через кому"),
    ):
        self.df, self.dt = resolve_period(date_from, date_to, days)
        self.rid = region_id
        self.st = strike_type or None

    @property
    def length(self) -> int:
        return (self.dt - self.df).days + 1

    def params(self) -> dict:
        return {"df": self.df, "dt": self.dt, "rid": self.rid, "st": self.st}

    def previous(self) -> "Filters":
        """Такий самий за довжиною період безпосередньо перед поточним."""
        prev = object.__new__(Filters)
        prev.dt = self.df - timedelta(days=1)
        prev.df = prev.dt - timedelta(days=self.length - 1)
        prev.rid, prev.st = self.rid, self.st
        return prev


def period_sql(col: str) -> str:
    return f"{col} >= CAST(:df AS DATE) AND {col} < CAST(:dt AS DATE) + 1"


EVENTS_WHERE = f"""
    {period_sql('e.event_time')}
    AND (CAST(:rid AS INT) IS NULL OR e.region_id = :rid)
"""

# CTE з відфільтрованими ураженнями — основа всієї аналітики втрат
STRIKES_CTE = f"""
    WITH s AS (
        SELECT * FROM fire_strikes fs
        WHERE {period_sql('fs.strike_time')}
          AND (CAST(:rid AS INT) IS NULL OR fs.region_id = :rid)
          AND (CAST(:st AS TEXT) IS NULL OR fs.strike_type = ANY(string_to_array(CAST(:st AS TEXT), ',')))
    ),
    l AS (
        SELECT el.strike_id, el.category, el.qty, c.grp
        FROM enemy_losses el
        JOIN s ON s.id = el.strike_id
        JOIN loss_categories c ON c.code = el.category
    )
"""


def bucket_for(f: Filters, bucket: str | None) -> str:
    """Авто-групування: до 92 днів — по днях, довше — по тижнях."""
    return bucket or ("day" if f.length <= 92 else "week")


# ---------------------------- Довідники ----------------------------

@app.get("/api/health")
def health():
    return safe(lambda: {"status": "ok", "db_time": query_one("SELECT now() AS t")["t"]})


@app.get("/api/regions")
def regions():
    return safe(lambda: query("SELECT id, name, lat, lon FROM regions ORDER BY name"))


@app.get("/api/unit-types")
def unit_types():
    return safe(lambda: query("SELECT code, name_uk, function_id FROM unit_types ORDER BY name_uk"))


@app.get("/api/strike-types")
def strike_types():
    return safe(lambda: query("SELECT code, name_uk FROM strike_types ORDER BY ord"))


@app.get("/api/loss-categories")
def loss_categories():
    return safe(lambda: query("SELECT code, name_uk, grp FROM loss_categories ORDER BY ord"))


@app.get("/api/meta/date-range")
def date_range():
    """Перша й остання дата, за які є дані (для кнопки «Увесь період»)."""
    sql = """
        SELECT least(min(a), min(b))::date AS min, greatest(max(a), max(b))::date AS max
        FROM (SELECT min(strike_time) a, max(strike_time) b FROM fire_strikes
              UNION ALL SELECT min(event_time), max(event_time) FROM events) x
    """
    return safe(lambda: query_one(sql))


# ---------------------------- Підрозділи ----------------------------

@app.get("/api/units")
def units(
    affiliation: str | None = Query(None, pattern="^[FHNU]$"),
    region_id: int | None = None,
    unit_type: str | None = None,
):
    sql = """
        SELECT u.id, u.name, u.unit_type, t.name_uk AS type_name, u.affiliation,
               u.echelon, u.status, u.sidc, u.lat, u.lon, u.personnel, u.readiness,
               u.updated_at, r.name AS region
        FROM units u
        JOIN unit_types t ON t.code = u.unit_type
        JOIN regions r    ON r.id   = u.region_id
        WHERE (CAST(:aff AS TEXT) IS NULL OR u.affiliation = :aff)
          AND (CAST(:rid AS INT)  IS NULL OR u.region_id   = :rid)
          AND (CAST(:ut  AS TEXT) IS NULL OR u.unit_type   = :ut)
        ORDER BY u.id
    """
    return safe(lambda: query(sql, aff=affiliation, rid=region_id, ut=unit_type))


# ---------------------------- Події ----------------------------

@app.get("/api/events")
def events(f: Filters = Depends(), limit: int = Query(25, ge=1, le=2000)):
    sql = f"""
        SELECT e.id, e.event_time, e.event_type, e.severity, e.lat, e.lon,
               e.description, r.name AS region
        FROM events e JOIN regions r ON r.id = e.region_id
        WHERE {EVENTS_WHERE}
        ORDER BY e.event_time DESC
        LIMIT :lim
    """
    return safe(lambda: query(sql, **f.params(), lim=limit))


@app.get("/api/stats/summary")
def stats_summary():
    sql = """
        SELECT
          (SELECT count(*) FROM units)                                   AS units_total,
          (SELECT count(*) FROM units WHERE affiliation = 'F')           AS units_friendly,
          (SELECT count(*) FROM units WHERE affiliation = 'H')           AS units_hostile,
          (SELECT coalesce(sum(personnel),0) FROM units WHERE affiliation = 'F') AS personnel_friendly,
          (SELECT round(avg(readiness),1) FROM units WHERE affiliation = 'F')    AS readiness_avg,
          (SELECT count(*) FROM events WHERE event_time >= now() - interval '7 days')  AS events_7d,
          (SELECT count(*) FROM events WHERE event_time >= now() - interval '14 days'
                                         AND event_time <  now() - interval '7 days') AS events_prev_7d
    """
    return safe(lambda: query_one(sql))


@app.get("/api/stats/units-by-type")
def stats_units_by_type():
    sql = """
        SELECT t.code, t.name_uk,
               count(*) FILTER (WHERE u.affiliation = 'F') AS friendly,
               count(*) FILTER (WHERE u.affiliation = 'H') AS hostile
        FROM unit_types t LEFT JOIN units u ON u.unit_type = t.code
        GROUP BY t.code, t.name_uk
        ORDER BY count(u.id) DESC
    """
    return safe(lambda: query(sql))


@app.get("/api/stats/events-timeline")
def stats_events_timeline(f: Filters = Depends(), bucket: str | None = Query(None, pattern="^(day|week)$")):
    b = bucket_for(f, bucket)
    sql = f"""
        SELECT g::date AS day, count(e.id) AS count
        FROM generate_series(date_trunc(CAST(:b AS TEXT), CAST(:df AS DATE)), CAST(:dt AS DATE),
                             CAST('1 ' || CAST(:b AS TEXT) AS INTERVAL)) g
        LEFT JOIN events e ON date_trunc(CAST(:b AS TEXT), e.event_time)::date = g::date
                          AND {EVENTS_WHERE}
        GROUP BY g ORDER BY g
    """
    return safe(lambda: {"bucket": b, "items": query(sql, **f.params(), b=b)})


@app.get("/api/stats/events-by-type")
def stats_events_by_type(f: Filters = Depends()):
    sql = f"""
        SELECT e.event_type, count(*) AS count
        FROM events e WHERE {EVENTS_WHERE}
        GROUP BY e.event_type ORDER BY count DESC
    """
    return safe(lambda: query(sql, **f.params()))


@app.get("/api/stats/events-by-region")
def stats_events_by_region(f: Filters = Depends(), limit: int = Query(8, ge=1, le=26)):
    sql = f"""
        SELECT r.name AS region, count(*) AS count
        FROM events e JOIN regions r ON r.id = e.region_id
        WHERE {EVENTS_WHERE}
        GROUP BY r.name ORDER BY count DESC LIMIT :lim
    """
    return safe(lambda: query(sql, **f.params(), lim=limit))


@app.get("/api/stats/readiness")
def stats_readiness():
    sql = """
        SELECT b.label, count(u.id) AS count
        FROM (VALUES (1,'< 50%',0,49),(2,'50–69%',50,69),(3,'70–84%',70,84),(4,'85–100%',85,100))
             AS b(ord,label,lo,hi)
        LEFT JOIN units u ON u.affiliation = 'F' AND u.readiness BETWEEN b.lo AND b.hi
        GROUP BY b.ord, b.label ORDER BY b.ord
    """
    return safe(lambda: query(sql))


# ------------------- Вогневе ураження та втрати противника -------------------

STRIKES_LIST_SQL = STRIKES_CTE + """
    SELECT s.id, s.strike_time, s.strike_type, t.name_uk AS type_name, r.name AS region,
           s.lat, s.lon, s.target, s.success, s.description,
           coalesce((SELECT json_object_agg(el.category, el.qty) FROM enemy_losses el
                     WHERE el.strike_id = s.id), '{}'::json) AS losses
    FROM s
    JOIN strike_types t ON t.code = s.strike_type
    JOIN regions r      ON r.id   = s.region_id
    ORDER BY s.strike_time DESC
    LIMIT :lim
"""


@app.get("/api/strikes")
def strikes(f: Filters = Depends(), limit: int = Query(100, ge=1, le=5000)):
    """Журнал уражень у вибірці. losses — {код_категорії: кількість}."""
    def run():
        total = query_one(STRIKES_CTE + "SELECT count(*) AS n FROM s", **f.params())["n"]
        return {"total": total, "items": query(STRIKES_LIST_SQL, **f.params(), lim=limit)}
    return safe(run)


@app.get("/api/strikes.csv")
def strikes_csv(f: Filters = Depends()):
    """Уся вибірка у CSV (UTF-8 з BOM, роздільник «;» — відкривається в Excel)."""
    def run():
        cats = query("SELECT code, name_uk FROM loss_categories ORDER BY ord")
        rows = query(STRIKES_LIST_SQL, **f.params(), lim=100000)
        buf = io.StringIO()
        w = csv.writer(buf, delimiter=";", lineterminator="\r\n")
        w.writerow(["Дата і час", "Вид ураження", "Область", "Ціль", "Результат",
                    *[c["name_uk"] for c in cats], "Широта", "Довгота", "Опис"])
        for r in rows:
            w.writerow([r["strike_time"][:16].replace("T", " "), r["type_name"], r["region"], r["target"],
                        "Уражено" if r["success"] else "Без результату",
                        *[r["losses"].get(c["code"], 0) for c in cats],
                        r["lat"], r["lon"], r["description"]])
        name = f"strikes_{f.df}_{f.dt}.csv"
        return Response("﻿" + buf.getvalue(), media_type="text/csv; charset=utf-8",
                        headers={"Content-Disposition": f'attachment; filename="{name}"'})
    return safe(run)


def _strikes_totals(f: Filters) -> dict:
    sql = STRIKES_CTE + """
        SELECT
          (SELECT count(*) FROM s)                                        AS strikes,
          (SELECT count(*) FROM s WHERE success)                          AS successful,
          (SELECT coalesce(sum(qty),0) FROM l WHERE category = 'kia')     AS kia,
          (SELECT coalesce(sum(qty),0) FROM l WHERE category = 'wia')     AS wia,
          (SELECT coalesce(sum(qty),0) FROM l WHERE grp = 'equipment')    AS equipment,
          (SELECT coalesce(sum(qty),0) FROM l WHERE category IN ('tank','afv')) AS armor
    """
    row = query_one(sql, **f.params())
    row["success_rate"] = round(100 * row["successful"] / row["strikes"], 1) if row["strikes"] else None
    return row


@app.get("/api/stats/strikes-summary")
def stats_strikes_summary(f: Filters = Depends()):
    """Підсумок вибірки + той самий показник за попередній період такої ж довжини."""
    def run():
        prev = f.previous()
        return {
            "period": {"date_from": f.df.isoformat(), "date_to": f.dt.isoformat(), "days": f.length},
            "current": _strikes_totals(f),
            "previous": {"date_from": prev.df.isoformat(), "date_to": prev.dt.isoformat(),
                         **_strikes_totals(prev)},
        }
    return safe(run)


@app.get("/api/stats/strikes-timeline")
def stats_strikes_timeline(f: Filters = Depends(), bucket: str | None = Query(None, pattern="^(day|week)$")):
    b = bucket_for(f, bucket)
    sql = STRIKES_CTE + """,
    per AS (
        SELECT s.id, s.success, date_trunc(CAST(:b AS TEXT), s.strike_time)::date AS bk,
               coalesce(sum(l.qty) FILTER (WHERE l.category = 'kia'), 0)    AS kia,
               coalesce(sum(l.qty) FILTER (WHERE l.category = 'wia'), 0)    AS wia,
               coalesce(sum(l.qty) FILTER (WHERE l.grp = 'equipment'), 0)   AS equipment
        FROM s LEFT JOIN l ON l.strike_id = s.id
        GROUP BY s.id, s.success, bk
    )
    SELECT g::date AS day,
           count(per.id)                          AS strikes,
           count(per.id) FILTER (WHERE per.success) AS successful,
           coalesce(sum(per.kia), 0)              AS kia,
           coalesce(sum(per.wia), 0)              AS wia,
           coalesce(sum(per.equipment), 0)        AS equipment
    FROM generate_series(date_trunc(CAST(:b AS TEXT), CAST(:df AS DATE)), CAST(:dt AS DATE),
                         CAST('1 ' || CAST(:b AS TEXT) AS INTERVAL)) g
    LEFT JOIN per ON per.bk = g::date
    GROUP BY g ORDER BY g
    """
    return safe(lambda: {"bucket": b, "items": query(sql, **f.params(), b=b)})


@app.get("/api/stats/strikes-by-type")
def stats_strikes_by_type(f: Filters = Depends()):
    """Результативність кожного виду ураження: кількість, успішність, втрати за категоріями."""
    sql = STRIKES_CTE + """,
    lt AS (SELECT s.strike_type, l.category, l.grp, sum(l.qty) AS qty
           FROM s JOIN l ON l.strike_id = s.id GROUP BY 1, 2, 3)
    SELECT t.code, t.name_uk,
           (SELECT count(*) FROM s WHERE s.strike_type = t.code)               AS strikes,
           (SELECT count(*) FROM s WHERE s.strike_type = t.code AND s.success) AS successful,
           (SELECT coalesce(sum(qty),0) FROM lt WHERE lt.strike_type = t.code AND lt.category = 'kia') AS kia,
           (SELECT coalesce(sum(qty),0) FROM lt WHERE lt.strike_type = t.code AND lt.category = 'wia') AS wia,
           (SELECT coalesce(sum(qty),0) FROM lt WHERE lt.strike_type = t.code AND lt.grp = 'equipment') AS equipment,
           coalesce((SELECT json_object_agg(lt.category, lt.qty) FROM lt WHERE lt.strike_type = t.code),
                    '{}'::json) AS losses
    FROM strike_types t
    WHERE CAST(:st AS TEXT) IS NULL OR t.code = ANY(string_to_array(CAST(:st AS TEXT), ','))
    ORDER BY strikes DESC, t.ord
    """
    return safe(lambda: query(sql, **f.params()))


@app.get("/api/stats/losses-by-category")
def stats_losses_by_category(f: Filters = Depends()):
    sql = STRIKES_CTE + """
    SELECT c.code, c.name_uk, c.grp, coalesce(sum(l.qty), 0) AS qty
    FROM loss_categories c LEFT JOIN l ON l.category = c.code
    GROUP BY c.code, c.name_uk, c.grp, c.ord ORDER BY c.ord
    """
    return safe(lambda: query(sql, **f.params()))


@app.get("/api/stats/strikes-by-region")
def stats_strikes_by_region(f: Filters = Depends(), limit: int = Query(10, ge=1, le=26)):
    sql = STRIKES_CTE + """,
    sl AS (SELECT s.id, s.region_id,
                  coalesce(sum(l.qty) FILTER (WHERE l.category = 'kia'), 0)  AS kia,
                  coalesce(sum(l.qty) FILTER (WHERE l.grp = 'equipment'), 0) AS equipment
           FROM s LEFT JOIN l ON l.strike_id = s.id GROUP BY s.id, s.region_id)
    SELECT r.name AS region, count(*) AS strikes, sum(sl.kia) AS kia, sum(sl.equipment) AS equipment
    FROM sl JOIN regions r ON r.id = sl.region_id
    GROUP BY r.name ORDER BY strikes DESC LIMIT :lim
    """
    return safe(lambda: query(sql, **f.params(), lim=limit))


# ---------------------------- Лінія розмежування ----------------------------

@app.get("/api/frontline")
def frontline(on_date: date | None = Query(None, alias="date",
                                           description="Дата, на яку потрібна лінія (за замовчуванням — сьогодні)")):
    """Версія лінії розмежування, чинна на дату. coordinates — [[lat, lon], ...]."""
    def run():
        v = query_one("""SELECT id, valid_from, name, source FROM frontline_versions
                         WHERE valid_from <= CAST(:d AS DATE) ORDER BY valid_from DESC LIMIT 1""",
                      d=on_date or date.today())
        if not v:
            v = query_one("SELECT id, valid_from, name, source FROM frontline_versions ORDER BY valid_from LIMIT 1")
        if not v:
            return {"name": None, "coordinates": []}
        pts = query("SELECT lat, lon FROM frontline_points WHERE version_id = :id ORDER BY seq", id=v.pop("id"))
        return {**v, "coordinates": [[p["lat"], p["lon"]] for p in pts]}
    return safe(run)


# ---------------------------- Логістика ----------------------------

class LogFilters(Filters):
    """Фільтри логістики: період (за датою відправлення), область підрозділу-отримувача, вид постачання."""

    def __init__(
        self,
        date_from: date | None = Query(None, description="Початок періоду (включно), YYYY-MM-DD"),
        date_to: date | None = Query(None, description="Кінець періоду (включно), YYYY-MM-DD"),
        days: int = Query(30, ge=1, le=MAX_RANGE_DAYS),
        region_id: int | None = Query(None, description="id області підрозділу-отримувача"),
        supply_type: str | None = Query(None, pattern=r"^[a-z_]+(,[a-z_]+)*$",
                                        description="Коди видів постачання через кому"),
    ):
        super().__init__(date_from, date_to, days, region_id, None)
        self.sp = supply_type or None

    def params(self) -> dict:
        return {"df": self.df, "dt": self.dt, "rid": self.rid, "sp": self.sp}

    def previous(self) -> "LogFilters":
        prev = super().previous()
        prev.__class__ = LogFilters
        prev.sp = self.sp
        return prev


SP_FILTER = "(CAST(:sp AS TEXT) IS NULL OR {col} = ANY(string_to_array(CAST(:sp AS TEXT), ',')))"

LOG_CTE = f"""
    WITH d AS (
        SELECT x.*, u.region_id AS unit_region
        FROM deliveries x JOIN units u ON u.id = x.unit_id
        WHERE {period_sql('x.depart_time')}
          AND (CAST(:rid AS INT) IS NULL OR u.region_id = :rid)
          AND {SP_FILTER.format(col='x.supply_type')}
    )
"""

# Потреба за період = чисельність × норма (кг/добу) × кількість днів
NEED_SQL = f"""
    SELECT u.id AS unit_id, st.code AS supply_type,
           u.personnel * st.norm_kg_day * (CAST(:dt AS DATE) - CAST(:df AS DATE) + 1) / 1000.0 AS need_t
    FROM units u CROSS JOIN supply_types st
    WHERE u.affiliation = 'F'
      AND (CAST(:rid AS INT) IS NULL OR u.region_id = :rid)
      AND {SP_FILTER.format(col='st.code')}
"""

STATUS_LABELS = {"delivered": "Вчасно", "delayed": "Із запізненням", "in_transit": "У дорозі", "lost": "Втрачено"}


@app.get("/api/supply-types")
def supply_types():
    return safe(lambda: query("SELECT code, name_uk, norm_kg_day, interval_days FROM supply_types ORDER BY ord"))


@app.get("/api/depots")
def depots():
    sql = """SELECT dp.id, dp.name, dp.kind, dp.lat, dp.lon, r.name AS region
             FROM depots dp JOIN regions r ON r.id = dp.region_id ORDER BY dp.kind, dp.name"""
    return safe(lambda: query(sql))


def _log_totals(f: LogFilters) -> dict:
    sql = LOG_CTE + f""",
    need AS ({NEED_SQL})
    SELECT
      (SELECT count(*) FROM d)                                            AS deliveries,
      (SELECT coalesce(sum(planned_qty_t), 0) FROM d)                     AS planned_t,
      (SELECT coalesce(sum(delivered_qty_t), 0) FROM d)                   AS delivered_t,
      (SELECT coalesce(sum(need_t), 0) FROM need)                         AS need_t,
      (SELECT count(*) FROM d WHERE status = 'delivered')                 AS on_time,
      (SELECT count(*) FROM d WHERE status = 'delayed')                   AS delayed,
      (SELECT count(*) FROM d WHERE status = 'in_transit')                AS in_transit,
      (SELECT count(*) FROM d WHERE status = 'lost')                      AS lost,
      (SELECT round(avg(extract(epoch FROM arrive_time - depart_time) / 3600)::numeric, 1)
         FROM d WHERE arrive_time IS NOT NULL)                            AS avg_hours
    """
    r = query_one(sql, **f.params())
    done = r["on_time"] + r["delayed"]
    r["plan_pct"] = round(100 * r["delivered_t"] / r["planned_t"], 1) if r["planned_t"] else None
    r["coverage_pct"] = round(100 * r["delivered_t"] / r["need_t"], 1) if r["need_t"] else None
    r["on_time_pct"] = round(100 * r["on_time"] / done, 1) if done else None
    for k in ("planned_t", "delivered_t", "need_t"):
        r[k] = round(r[k], 1)
    return r


@app.get("/api/logistics/summary")
def logistics_summary(f: LogFilters = Depends()):
    """Підсумок логістики + той самий показник за попередній період такої ж довжини."""
    def run():
        prev = f.previous()
        return {
            "period": {"date_from": f.df.isoformat(), "date_to": f.dt.isoformat(), "days": f.length},
            "current": _log_totals(f),
            "previous": {"date_from": prev.df.isoformat(), "date_to": prev.dt.isoformat(), **_log_totals(prev)},
        }
    return safe(run)


@app.get("/api/logistics/timeline")
def logistics_timeline(f: LogFilters = Depends(), bucket: str | None = Query(None, pattern="^(day|week)$")):
    b = bucket_for(f, bucket)
    sql = LOG_CTE + """
    SELECT g::date AS day,
           count(d.id)                                   AS deliveries,
           round(coalesce(sum(d.planned_qty_t), 0), 1)   AS planned_t,
           round(coalesce(sum(d.delivered_qty_t), 0), 1) AS delivered_t
    FROM generate_series(date_trunc(CAST(:b AS TEXT), CAST(:df AS DATE)), CAST(:dt AS DATE),
                         CAST('1 ' || CAST(:b AS TEXT) AS INTERVAL)) g
    LEFT JOIN d ON date_trunc(CAST(:b AS TEXT), d.depart_time)::date = g::date
    GROUP BY g ORDER BY g
    """
    return safe(lambda: {"bucket": b, "items": query(sql, **f.params(), b=b)})


@app.get("/api/logistics/by-type")
def logistics_by_type(f: LogFilters = Depends()):
    """План / факт / потреба за кожним видом постачання."""
    sql = LOG_CTE + f""",
    need AS ({NEED_SQL})
    SELECT st.code, st.name_uk,
           (SELECT count(*) FROM d WHERE d.supply_type = st.code) AS deliveries,
           (SELECT round(coalesce(sum(planned_qty_t), 0), 1) FROM d WHERE d.supply_type = st.code)   AS planned_t,
           (SELECT round(coalesce(sum(delivered_qty_t), 0), 1) FROM d WHERE d.supply_type = st.code) AS delivered_t,
           (SELECT round(coalesce(sum(need_t), 0), 1) FROM need WHERE need.supply_type = st.code)    AS need_t
    FROM supply_types st
    WHERE {SP_FILTER.format(col='st.code')}
    ORDER BY st.ord
    """
    def run():
        rows = query(sql, **f.params())
        for r in rows:
            r["coverage_pct"] = round(100 * r["delivered_t"] / r["need_t"], 1) if r["need_t"] else None
        return rows
    return safe(run)


@app.get("/api/logistics/by-status")
def logistics_by_status(f: LogFilters = Depends()):
    sql = LOG_CTE + """
    SELECT s.status, count(d.id) AS count
    FROM (VALUES (1,'delivered'),(2,'delayed'),(3,'in_transit'),(4,'lost')) s(ord, status)
    LEFT JOIN d ON d.status = s.status
    GROUP BY s.ord, s.status ORDER BY s.ord
    """
    def run():
        rows = query(sql, **f.params())
        for r in rows:
            r["label"] = STATUS_LABELS[r["status"]]
        return rows
    return safe(run)


@app.get("/api/logistics/by-depot")
def logistics_by_depot(f: LogFilters = Depends()):
    """Звіт по складах: рейси, обсяги, середній час, запізнення, втрати."""
    sql = LOG_CTE + """
    SELECT dp.id, dp.name, dp.kind, r.name AS region,
           count(d.id)                                                  AS deliveries,
           round(coalesce(sum(d.delivered_qty_t), 0), 1)                AS delivered_t,
           round(avg(d.distance_km)::numeric, 0)                        AS avg_km,
           round(avg(extract(epoch FROM d.arrive_time - d.depart_time) / 3600)::numeric, 1) AS avg_hours,
           count(*) FILTER (WHERE d.status = 'delayed')                 AS delayed,
           count(*) FILTER (WHERE d.status = 'lost')                    AS lost,
           count(*) FILTER (WHERE d.status = 'in_transit')              AS in_transit
    FROM depots dp
    JOIN regions r ON r.id = dp.region_id
    LEFT JOIN d ON d.depot_id = dp.id
    GROUP BY dp.id, dp.name, dp.kind, r.name
    ORDER BY delivered_t DESC
    """
    return safe(lambda: query(sql, **f.params()))


@app.get("/api/logistics/units-coverage")
def logistics_units_coverage(f: LogFilters = Depends(), limit: int = Query(50, ge=1, le=500)):
    """Забезпеченість кожного свого підрозділу: доставлено / потреба за період, найгірший вид постачання."""
    sql = LOG_CTE + f""",
    need AS ({NEED_SQL}),
    got AS (SELECT unit_id, supply_type, sum(delivered_qty_t) AS t FROM d GROUP BY 1, 2),
    per AS (SELECT n.unit_id, n.supply_type, n.need_t, coalesce(g.t, 0) AS got_t,
                   coalesce(g.t, 0) / nullif(n.need_t, 0) AS cov
            FROM need n LEFT JOIN got g ON g.unit_id = n.unit_id AND g.supply_type = n.supply_type)
    SELECT u.id, u.name, r.name AS region, u.personnel,
           round(sum(per.need_t), 1)  AS need_t,
           round(sum(per.got_t), 1)   AS delivered_t,
           round(100 * sum(per.got_t) / nullif(sum(per.need_t), 0), 1) AS coverage_pct,
           (SELECT st.name_uk FROM per p2 JOIN supply_types st ON st.code = p2.supply_type
             WHERE p2.unit_id = u.id ORDER BY p2.cov NULLS FIRST LIMIT 1) AS worst_type,
           (SELECT round(100 * p2.cov, 1) FROM per p2
             WHERE p2.unit_id = u.id ORDER BY p2.cov NULLS FIRST LIMIT 1) AS worst_pct,
           json_object_agg(per.supply_type, round(100 * per.cov, 1)) AS by_type
    FROM per
    JOIN units u   ON u.id = per.unit_id
    JOIN regions r ON r.id = u.region_id
    GROUP BY u.id, u.name, r.name, u.personnel
    ORDER BY coverage_pct NULLS FIRST
    LIMIT :lim
    """
    return safe(lambda: query(sql, **f.params(), lim=limit))


DELIV_LIST_SQL = LOG_CTE + """
    SELECT d.id, d.depart_time, d.planned_arrival, d.arrive_time, d.status, d.transport,
           d.supply_type, st.name_uk AS type_name, d.planned_qty_t, d.delivered_qty_t, d.distance_km,
           dp.name AS depot, dp.lat AS depot_lat, dp.lon AS depot_lon,
           u.name AS unit, u.lat AS unit_lat, u.lon AS unit_lon, r.name AS region
    FROM d
    JOIN supply_types st ON st.code = d.supply_type
    JOIN depots dp       ON dp.id = d.depot_id
    JOIN units u         ON u.id = d.unit_id
    JOIN regions r       ON r.id = u.region_id
    WHERE CAST(:status AS TEXT) IS NULL OR d.status = CAST(:status AS TEXT)
    ORDER BY d.depart_time DESC
    LIMIT :lim
"""


@app.get("/api/logistics/deliveries")
def logistics_deliveries(f: LogFilters = Depends(), limit: int = Query(100, ge=1, le=5000),
                         status: str | None = Query(None, pattern="^(delivered|delayed|in_transit|lost)$")):
    def run():
        total = query_one(LOG_CTE + """SELECT count(*) AS n FROM d
                          WHERE CAST(:status AS TEXT) IS NULL OR d.status = CAST(:status AS TEXT)""",
                          **f.params(), status=status)["n"]
        return {"total": total, "items": query(DELIV_LIST_SQL, **f.params(), status=status, lim=limit)}
    return safe(run)


@app.get("/api/logistics/deliveries.csv")
def logistics_deliveries_csv(f: LogFilters = Depends()):
    """Усі рейси вибірки у CSV (UTF-8 з BOM, «;»)."""
    def run():
        rows = query(DELIV_LIST_SQL, **f.params(), status=None, lim=200000)
        buf = io.StringIO()
        w = csv.writer(buf, delimiter=";", lineterminator="\r\n")
        w.writerow(["Відправлено", "План прибуття", "Прибуло", "Статус", "Вид постачання", "Склад",
                    "Підрозділ", "Область", "Транспорт", "План, т", "Доставлено, т", "Відстань, км"])

        def ts(v):
            return (v or "")[:16].replace("T", " ")

        def num(v):
            return str(v).replace(".", ",")

        for r in rows:
            w.writerow([ts(r["depart_time"]), ts(r["planned_arrival"]), ts(r["arrive_time"]),
                        STATUS_LABELS[r["status"]], r["type_name"], r["depot"], r["unit"], r["region"],
                        "Залізниця" if r["transport"] == "rail" else "Автотранспорт",
                        num(r["planned_qty_t"]), num(r["delivered_qty_t"]), num(r["distance_km"])])
        name = f"logistics_{f.df}_{f.dt}.csv"
        return Response("﻿" + buf.getvalue(), media_type="text/csv; charset=utf-8",
                        headers={"Content-Disposition": f'attachment; filename="{name}"'})
    return safe(run)
