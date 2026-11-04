"""Smoke test: запити до /health, /filters, /kpi, /trend (+ /compare, /panorama) і перевірка ключів.

python scripts/smoke_test.py [API_URL]   → друкує "OK" або список проблем (exit code 1)
"""
import json
import sys
import urllib.request

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8000").rstrip("/")

CHECKS = [
    ("/health", lambda d: d.get("status") == "ok"),
    ("/filters", lambda d: {"sectors", "directions", "event_types", "min_date", "max_date"} <= d.keys()),
    ("/kpi", lambda d: {"total_incidents", "total_intensity", "avg_intensity", "top_direction"} <= d.keys()),
    ("/trend?group=day", lambda d: isinstance(d, list) and (not d or {"t", "value"} <= d[0].keys())),
    ("/trend?group=week", lambda d: isinstance(d, list) and (not d or {"t", "value"} <= d[0].keys())),
    ("/compare", lambda d: {"current", "previous", "delta_pct", "period"} <= d.keys()),
    ("/panorama", lambda d: {"sectors", "directions", "event_types"} <= d.keys()),
    ("/incidents?page_size=5&public=true", lambda d: "items" in d and all("source" not in i for i in d["items"])),
]

failed = []
for path, ok in CHECKS:
    try:
        with urllib.request.urlopen(BASE + path, timeout=10) as r:
            data = json.loads(r.read().decode("utf-8"))
        status = "ok" if ok(data) else "unexpected keys"
    except Exception as e:  # noqa: BLE001
        status = f"error: {e}"
    print(f"  {path:40s} {status}")
    if status != "ok":
        failed.append(path)

if failed:
    print("FAIL:", ", ".join(failed))
    sys.exit(1)
print("OK")
