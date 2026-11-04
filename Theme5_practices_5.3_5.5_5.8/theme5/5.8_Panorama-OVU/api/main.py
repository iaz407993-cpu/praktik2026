"""Панорама-ОВУ — API (FastAPI, sync, raw SQL через psycopg2).

Запуск з кореня проєкту:  uvicorn api.main:app --reload
Документація Swagger:      http://localhost:8000/docs
"""
from datetime import date, timedelta
from typing import Literal, Optional

from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

from api.db import fetch_all, fetch_one

app = FastAPI(title="Панорама-ОВУ API", version="1.0",
              description="Міні-ІАС: панорамний огляд подій (навчальні синтетичні дані)")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

PUBLIC_HIDDEN = {"source"}  # чутливі поля, які не віддаються в режимі public/demo
SORTABLE = {"id", "occurred_at", "sector", "direction", "event_type", "intensity"}


# ---------------------------------------------------------------- фільтри
class Filters:
    """Спільні query-параметри для всіх аналітичних ендпоїнтів."""

    def __init__(
        self,
        from_: Optional[date] = Query(None, alias="from", description="YYYY-MM-DD, включно"),
        to: Optional[date] = Query(None, description="YYYY-MM-DD, включно"),
        sector: Optional[str] = None,
        direction: Optional[str] = None,
        event_type: Optional[str] = None,
        min_intensity: Optional[int] = Query(None, ge=1, le=50),
    ):
        if from_ and to and from_ > to:
            raise HTTPException(400, "'from' не може бути пізніше за 'to'")
        self.from_, self.to = from_, to
        self.sector, self.direction, self.event_type = sector or None, direction or None, event_type or None
        self.min_intensity = min_intensity

    def where(self, from_=..., to=...):
        """Повертає (SQL-умову, параметри). Період можна перевизначити (для порівняння періодів)."""
        f = self.from_ if from_ is ... else from_
        t = self.to if to is ... else to
        cond, params = ["TRUE"], []
        if f:
            cond.append("occurred_at >= %s"); params.append(f)
        if t:
            cond.append("occurred_at < %s"); params.append(t + timedelta(days=1))   # 'to' включно
        for col in ("sector", "direction", "event_type"):
            v = getattr(self, col)
            if v:
                cond.append(f"{col} = %s"); params.append(v)
        if self.min_intensity:
            cond.append("intensity >= %s"); params.append(self.min_intensity)
        return " AND ".join(cond), params


def period_bounds(f: Filters):
    """Межі поточного періоду: задані користувачем або весь доступний діапазон даних."""
    if f.from_ and f.to:
        return f.from_, f.to
    r = fetch_one("SELECT MIN(occurred_at)::date AS a, MAX(occurred_at)::date AS b FROM incidents")
    return f.from_ or r["a"], f.to or r["b"]


# ---------------------------------------------------------------- базові
@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/filters")
def filters():
    def distinct(col):
        return [r["v"] for r in fetch_all(f"SELECT DISTINCT {col} AS v FROM incidents ORDER BY 1")]
    r = fetch_one("SELECT MIN(occurred_at)::date AS a, MAX(occurred_at)::date AS b FROM incidents")
    return {"sectors": distinct("sector"), "directions": distinct("direction"),
            "event_types": distinct("event_type"),
            "min_date": str(r["a"]) if r["a"] else "", "max_date": str(r["b"]) if r["b"] else ""}


def kpi_for(where, params):
    k = fetch_one(f"""SELECT COUNT(*) AS total_incidents, COALESCE(SUM(intensity), 0) AS total_intensity,
                             COALESCE(ROUND(AVG(intensity)::numeric, 2), 0) AS avg_intensity
                      FROM incidents WHERE {where}""", params)
    top = fetch_one(f"""SELECT direction FROM incidents WHERE {where}
                        GROUP BY direction ORDER BY COUNT(*) DESC, SUM(intensity) DESC LIMIT 1""", params)
    return {"total_incidents": k["total_incidents"], "total_intensity": int(k["total_intensity"]),
            "avg_intensity": float(k["avg_intensity"]), "top_direction": top["direction"] if top else None}


@app.get("/kpi")
def kpi(f: Filters = Depends()):
    return kpi_for(*f.where())


@app.get("/trend")
def trend(group: Literal["day", "week"] = "day", f: Filters = Depends()):
    """Кількість подій по днях/тижнях; дні без подій заповнюються нулями."""
    where, params = f.where()
    a, b = period_bounds(f)
    if not a:
        return []
    rows = fetch_all(f"""
        WITH s AS (SELECT generate_series(date_trunc(%s, %s::timestamp), date_trunc(%s, %s::timestamp),
                                          ('1 ' || %s)::interval) AS t),
             c AS (SELECT date_trunc(%s, occurred_at) AS t, COUNT(*) AS n FROM incidents WHERE {where} GROUP BY 1)
        SELECT to_char(s.t, 'YYYY-MM-DD') AS t, COALESCE(c.n, 0) AS value
        FROM s LEFT JOIN c USING (t) ORDER BY s.t""",
        [group, a, group, b, group, group, *params])
    return rows


def distribution(col, f):
    where, params = f.where()
    return fetch_all(f"""SELECT {col} AS label, COUNT(*) AS value, SUM(intensity) AS intensity
                         FROM incidents WHERE {where} GROUP BY 1 ORDER BY 2 DESC, 1""", params)


@app.get("/distribution/directions")
def dist_directions(f: Filters = Depends()):
    return distribution("direction", f)


@app.get("/distribution/types")
def dist_types(f: Filters = Depends()):
    return distribution("event_type", f)


@app.get("/heatmap")
def heatmap(metric: Literal["count", "intensity"] = "count", f: Filters = Depends()):
    """Матриця «сектор × тиждень» (ISO-тижні)."""
    where, params = f.where()
    a, b = period_bounds(f)
    if not a:
        return {"columns": [], "rows": []}
    weeks = [r["w"] for r in fetch_all(
        "SELECT generate_series(date_trunc('week', %s::timestamp), date_trunc('week', %s::timestamp), '1 week')::date AS w",
        [a, b])]
    agg = "COUNT(*)" if metric == "count" else "SUM(intensity)"
    data = fetch_all(f"""SELECT sector, date_trunc('week', occurred_at)::date AS w, {agg} AS v
                         FROM incidents WHERE {where} GROUP BY 1, 2""", params)
    sectors = sorted({r["sector"] for r in data}) or [r["v"] for r in fetch_all(
        "SELECT DISTINCT sector AS v FROM incidents ORDER BY 1")]
    cell = {(r["sector"], r["w"]): int(r["v"]) for r in data}
    return {"columns": [w.strftime("%G-W%V") for w in weeks],
            "week_starts": [str(w) for w in weeks],
            "rows": [{"sector": s, "values": [cell.get((s, w), 0) for w in weeks]} for s in sectors]}


# ---------------------------------------------------------------- інциденти
def strip_public(row, public):
    return {k: v for k, v in row.items() if not (public and k in PUBLIC_HIDDEN)}


@app.get("/incidents")
def incidents(page: int = Query(1, ge=1), page_size: int = Query(20, ge=5, le=100),
              sort: str = "occurred_at", order: Literal["asc", "desc"] = "desc",
              public: bool = Query(False, description="true — без чутливих полів"),
              f: Filters = Depends()):
    if sort not in SORTABLE:
        raise HTTPException(400, f"sort має бути одним із: {sorted(SORTABLE)}")
    where, params = f.where()
    total = fetch_one(f"SELECT COUNT(*) AS n FROM incidents WHERE {where}", params)["n"]
    cols = "id, occurred_at, sector, direction, event_type, intensity" + ("" if public else ", source")
    items = fetch_all(f"""SELECT {cols} FROM incidents WHERE {where}
                          ORDER BY {sort} {order}, id {order} LIMIT %s OFFSET %s""",
                      [*params, page_size, (page - 1) * page_size])
    for it in items:
        it["occurred_at"] = it["occurred_at"].isoformat(sep=" ", timespec="minutes")
    return {"total": total, "page": page, "page_size": page_size, "items": items}


@app.get("/incidents/{incident_id}")
def incident(incident_id: int, public: bool = False):
    row = fetch_one("SELECT * FROM incidents WHERE id = %s", [incident_id])
    if not row:
        raise HTTPException(404, "Запис не знайдено")
    row["occurred_at"] = row["occurred_at"].isoformat(sep=" ", timespec="minutes")
    return strip_public(row, public)


# ---------------------------------------------------------------- фокус варіанту «Панорама-ОВУ»
def prev_window(f: Filters, days_default=30):
    """Поточний період і попередній такої самої тривалості, що безпосередньо йому передує."""
    if f.from_ and f.to:
        cur_a, cur_b = f.from_, f.to
    else:
        last = fetch_one("SELECT MAX(occurred_at)::date AS b FROM incidents")["b"] or date.today()
        cur_b = f.to or last
        cur_a = f.from_ or cur_b - timedelta(days=days_default - 1)
    length = (cur_b - cur_a).days + 1
    prev_b = cur_a - timedelta(days=1)
    return cur_a, cur_b, prev_b - timedelta(days=length - 1), prev_b


def delta_pct(cur, prev):
    return None if not prev else round(100.0 * (cur - prev) / prev, 1)


@app.get("/compare")
def compare(f: Filters = Depends()):
    """KPI «цей період vs попередній». Без from/to — останні 30 днів даних."""
    a, b, pa, pb = prev_window(f)
    cur, prev = kpi_for(*f.where(a, b)), kpi_for(*f.where(pa, pb))
    return {"period": {"from": str(a), "to": str(b), "days": (b - a).days + 1},
            "previous_period": {"from": str(pa), "to": str(pb)},
            "current": cur, "previous": prev,
            "delta_pct": {k: delta_pct(cur[k], prev[k]) for k in ("total_incidents", "total_intensity", "avg_intensity")}}


@app.get("/panorama")
def panorama(f: Filters = Depends()):
    """Агрегування одночасно за трьома зрізами (сектор, напрямок, тип) з порівнянням із попереднім періодом."""
    a, b, pa, pb = prev_window(f)
    result = {"period": {"from": str(a), "to": str(b)}, "previous_period": {"from": str(pa), "to": str(pb)}}
    for key, col in (("sectors", "sector"), ("directions", "direction"), ("event_types", "event_type")):
        wc, pc = f.where(a, b)
        wp, pp = f.where(pa, pb)
        rows = fetch_all(f"""
            WITH cur AS (SELECT {col} AS label, COUNT(*) AS n, SUM(intensity) AS s FROM incidents WHERE {wc} GROUP BY 1),
                 prev AS (SELECT {col} AS label, COUNT(*) AS n FROM incidents WHERE {wp} GROUP BY 1)
            SELECT COALESCE(cur.label, prev.label) AS label, COALESCE(cur.n, 0) AS current,
                   COALESCE(prev.n, 0) AS previous, COALESCE(cur.s, 0) AS intensity
            FROM cur FULL JOIN prev ON cur.label = prev.label
            ORDER BY 2 DESC, 1""", [*pc, *pp])
        for r in rows:
            r["intensity"] = int(r["intensity"])
            r["delta_pct"] = delta_pct(r["current"], r["previous"])
        result[key] = rows
    return result
