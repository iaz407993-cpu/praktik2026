/* Панорама-ОВУ — web (vanilla JS + Chart.js). API: FastAPI на localhost:8000 */
const API_BASE_URL = "http://localhost:8000";

// ---------------------------------------------------------------- режими аудиторій
const VIEWS = {
  executive: { show: ["kpi", "insight", "trend"], public: false },
  analyst: { show: ["kpi", "insight", "trend", "distributions", "panorama", "heatmap", "incidents"], public: false },
  demo: { show: ["kpi", "insight", "trend", "distributions", "panorama", "heatmap"], public: true },
};
const params = new URLSearchParams(location.search);
let viewName = (params.get("view") || "analyst").toLowerCase();
if (viewName === "public") viewName = "demo";          // demo/public — один режим
if (!VIEWS[viewName]) viewName = "analyst";
const VIEW = VIEWS[viewName];
const visible = (b) => VIEW.show.includes(b);

document.querySelectorAll("[data-block]").forEach((el) => { el.hidden = !visible(el.dataset.block); });
document.getElementById("public-banner").hidden = !VIEW.public;
document.querySelectorAll('[data-field="source"]').forEach((el) => { el.hidden = VIEW.public; });
document.body.dataset.view = viewName;

// ---------------------------------------------------------------- стан
const state = { filters: {}, group: "day", metric: "count", page: 1, pageSize: 20, sort: "occurred_at", order: "desc", meta: null };
const form = document.getElementById("filter-form");
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (n) => Number(n).toLocaleString("uk-UA");
const fmtDate = (iso) => (iso ? iso.slice(0, 10).split("-").reverse().join(".") : "");

function qs(extra = {}) {
  const p = new URLSearchParams();
  Object.entries({ ...state.filters, ...extra }).forEach(([k, v]) => { if (v !== "" && v != null) p.set(k, v); });
  return p.toString();
}
async function api(path, extra) {
  const url = `${API_BASE_URL}${path}${path.includes("?") ? "&" : "?"}${qs(extra)}`;
  const r = await fetch(url);
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(`${path}: ${r.status} ${typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail ?? "")}`);
  }
  return r.json();
}
function showError(msg) { const b = $("error-banner"); b.textContent = msg; b.hidden = !msg; }

// Перемикач режимів зберігає поточні фільтри в URL
function syncViewLinks() {
  document.querySelectorAll(".views a").forEach((a) => {
    const p = new URLSearchParams(qs()); p.set("view", a.dataset.view);
    a.href = `?${p}`; a.classList.toggle("active", a.dataset.view === viewName);
  });
}

// ---------------------------------------------------------------- фільтри
function readForm() {
  const fd = new FormData(form);
  state.filters = Object.fromEntries([...fd.entries()].filter(([, v]) => v !== ""));
}
function writeForm() {
  [...form.elements].forEach((el) => { if (el.name) el.value = state.filters[el.name] ?? ""; });
}
function addDays(iso, d) { const t = new Date(iso + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() + d); return t.toISOString().slice(0, 10); }
function setPreset(days) {
  state.filters.to = state.meta.max_date;
  state.filters.from = days >= 90 ? state.meta.min_date : addDays(state.meta.max_date, -(days - 1));
  writeForm(); apply();
}
document.querySelectorAll("[data-days]").forEach((b) => b.addEventListener("click", () => setPreset(+b.dataset.days)));
form.addEventListener("submit", (e) => { e.preventDefault(); readForm(); apply(); });
$("reset-btn").addEventListener("click", () => { state.filters = {}; setPreset(30); });

async function initFilters() {
  state.meta = await api("/filters");
  const fill = (name, list) => { const s = form.elements[name]; list.forEach((v) => s.add(new Option(v, v))); };
  fill("sector", state.meta.sectors); fill("direction", state.meta.directions); fill("event_type", state.meta.event_types);
  form.elements.from.min = form.elements.to.min = state.meta.min_date;
  form.elements.from.max = form.elements.to.max = state.meta.max_date;
  // Фільтри можна передати в URL (так зберігаються при зміні режиму)
  ["from", "to", "sector", "direction", "event_type", "min_intensity"].forEach((k) => { if (params.get(k)) state.filters[k] = params.get(k); });
  if (!state.filters.from && !state.filters.to) {         // за замовчуванням — останні 30 днів
    state.filters.to = state.meta.max_date; state.filters.from = addDays(state.meta.max_date, -29);
  }
  writeForm();
}

// ---------------------------------------------------------------- KPI + порівняння
function deltaBadge(v, invert = false) {
  if (v === null || v === undefined) return '<span class="delta">н/д</span>';
  const cls = v === 0 ? "flat" : (v > 0) !== invert ? "up" : "down";
  return `<span class="delta ${cls}">${v > 0 ? "▲" : v < 0 ? "▼" : "■"} ${v > 0 ? "+" : ""}${v}%</span>`;
}
function renderKpi(k, cmp) {
  const d = cmp.delta_pct, p = cmp.previous;
  const cards = [
    ["Інцидентів", fmt(k.total_incidents), deltaBadge(d.total_incidents), `попередній: ${fmt(p.total_incidents)}`],
    ["Сумарна інтенсивність", fmt(k.total_intensity), deltaBadge(d.total_intensity), `попередній: ${fmt(p.total_intensity)}`],
    ["Середня інтенсивність", k.avg_intensity.toFixed(2), deltaBadge(d.avg_intensity), `попередній: ${p.avg_intensity.toFixed(2)}`],
    ["Топ-напрямок", esc(k.top_direction ?? "—"), "", `попередній: ${esc(p.top_direction ?? "—")}`],
  ];
  $("kpi").innerHTML = cards.map(([t, v, dl, sub]) =>
    `<div class="kpi"><div class="kpi-t">${t}</div><div class="kpi-v">${v}</div><div class="kpi-s">${dl} <span>${sub}</span></div></div>`).join("");
  $("period-note").innerHTML = `Поточний період: <b>${fmtDate(cmp.period.from)} – ${fmtDate(cmp.period.to)}</b> (${cmp.period.days} дн.) · ` +
    `порівняння з <b>${fmtDate(cmp.previous_period.from)} – ${fmtDate(cmp.previous_period.to)}</b>`;
}

// ---------------------------------------------------------------- графіки
Chart.defaults.font.family = "system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
Chart.defaults.color = "#3b4038";
const C = { cur: "#4b5d2b", prev: "#a3a38c", accent: "#c8902b", palette: ["#4b5d2b", "#2f5f8a", "#c8902b", "#8a4b2b", "#6e7f4f", "#5b5b5b", "#8c7a4a"] };
const charts = {};
function upsert(id, cfg) {
  if (charts[id]) { charts[id].data = cfg.data; charts[id].options = cfg.options; charts[id].update(); }
  else charts[id] = new Chart($(id), cfg);
}

function renderTrend(cur, prev) {
  const n = Math.max(cur.length, prev.length);
  const labels = cur.map((r) => (state.group === "week" ? `тиж. ${fmtDate(r.t)}` : fmtDate(r.t).slice(0, 5)));
  upsert("trend-chart", {
    type: "line",
    data: {
      labels,
      datasets: [
        { label: "цей період", data: cur.map((r) => r.value), borderColor: C.cur, backgroundColor: C.cur + "22", fill: true, tension: 0.25, pointRadius: 2 },
        { label: "попередній період (зсув на ту саму тривалість)", data: prev.slice(-n).map((r) => r.value), borderColor: C.prev, borderDash: [6, 4], pointRadius: 0, tension: 0.25 },
      ],
    },
    options: {
      maintainAspectRatio: false, interaction: { mode: "index", intersect: false },
      plugins: { legend: { position: "bottom" },
        tooltip: { callbacks: { afterTitle: (it) => prev[it[0].dataIndex] ? `попередній: ${fmtDate(prev[it[0].dataIndex].t)}` : "" } } },
      scales: { y: { beginAtZero: true, ticks: { precision: 0 }, title: { display: true, text: "кількість подій" } } },
    },
  });
}

function renderDistributions(dirs, types) {
  upsert("dir-chart", {
    type: "bar",
    data: { labels: dirs.map((r) => r.label), datasets: [{ label: "подій", data: dirs.map((r) => r.value), backgroundColor: dirs.map((_, i) => (i === 0 ? C.accent : C.cur)) }] },
    options: { indexAxis: "y", maintainAspectRatio: false, plugins: { legend: { display: false },
      tooltip: { callbacks: { afterLabel: (c) => `інтенсивність: ${fmt(dirs[c.dataIndex].intensity)}` } } },
      scales: { x: { beginAtZero: true, ticks: { precision: 0 } } } },
  });
  const total = types.reduce((s, r) => s + r.value, 0) || 1;
  upsert("type-chart", {
    type: "doughnut",
    data: { labels: types.map((r) => r.label), datasets: [{ data: types.map((r) => r.value), backgroundColor: C.palette, borderColor: "#fff", borderWidth: 2 }] },
    options: { maintainAspectRatio: false, cutout: "58%", plugins: { legend: { position: "right" },
      tooltip: { callbacks: { label: (c) => ` ${c.label}: ${c.raw} (${Math.round((100 * c.raw) / total)}%)` } } } },
  });
}

// ---------------------------------------------------------------- панорама зрізів
function renderPanorama(p) {
  $("panorama-note").textContent = `Кількість подій: ${fmtDate(p.period.from)}–${fmtDate(p.period.to)} проти ${fmtDate(p.previous_period.from)}–${fmtDate(p.previous_period.to)}. Смужка — частка від максимуму в зрізі.`;
  const block = (title, rows) => {
    const max = Math.max(1, ...rows.map((r) => r.current));
    return `<div class="slice"><h3>${title}</h3><table class="pano"><thead><tr><th>Зріз</th><th class="num">Зараз</th><th class="num">Було</th><th class="num">Δ</th></tr></thead><tbody>` +
      rows.map((r) => `<tr><td><div class="bar-cell"><span class="bar" style="width:${(100 * r.current) / max}%"></span><span>${esc(r.label)}</span></div></td>
        <td class="num">${r.current}</td><td class="num muted">${r.previous}</td><td class="num">${deltaBadge(r.delta_pct)}</td></tr>`).join("") +
      "</tbody></table></div>";
  };
  $("panorama").innerHTML = block("Сектори", p.sectors) + block("Напрямки", p.directions) + block("Типи подій", p.event_types);
}

// ---------------------------------------------------------------- heatmap
function renderHeatmap(h) {
  const max = Math.max(1, ...h.rows.flatMap((r) => r.values));
  const head = `<thead><tr><th>Сектор</th>${h.columns.map((c, i) => `<th title="з ${fmtDate(h.week_starts[i])}">${c.slice(5)}</th>`).join("")}<th class="num">Σ</th></tr></thead>`;
  const body = h.rows.map((r) => `<tr><th>${esc(r.sector)}</th>${r.values.map((v, i) => {
    const a = v / max;
    return `<td style="background:rgba(75,93,43,${(0.06 + 0.9 * a).toFixed(2)});color:${a > 0.55 ? "#fff" : "#222"}" title="${esc(r.sector)}, ${h.columns[i]}: ${v}">${v || ""}</td>`;
  }).join("")}<td class="num"><b>${fmt(r.values.reduce((s, v) => s + v, 0))}</b></td></tr>`).join("");
  $("heatmap").innerHTML = h.rows.length ? head + `<tbody>${body}</tbody>` : "<tbody><tr><td>Немає даних</td></tr></tbody>";
}

// ---------------------------------------------------------------- інциденти + модальне вікно
async function loadIncidents() {
  const d = await api("/incidents", { page: state.page, page_size: state.pageSize, sort: state.sort, order: state.order, public: VIEW.public });
  const pages = Math.max(1, Math.ceil(d.total / d.page_size));
  $("inc-total").textContent = `(${fmt(d.total)})`;
  $("page-info").textContent = `сторінка ${d.page} з ${pages}`;
  $("prev-page").disabled = d.page <= 1; $("next-page").disabled = d.page >= pages;
  document.querySelector("#incidents tbody").innerHTML = d.items.map((it) => `<tr>
      <td>${esc(it.occurred_at)}</td><td>${esc(it.sector)}</td><td>${esc(it.direction)}</td><td>${esc(it.event_type)}</td>
      <td class="num"><span class="int" style="--w:${it.intensity * 2}%">${it.intensity}</span></td>
      ${VIEW.public ? "" : `<td>${esc(it.source)}</td>`}
      <td><button type="button" class="link" data-id="${it.id}">Details</button></td></tr>`).join("")
    || `<tr><td colspan="7" class="muted">Немає записів за фільтрами</td></tr>`;
  document.querySelectorAll("#incidents th[data-sort]").forEach((th) => {
    th.classList.toggle("sorted", th.dataset.sort === state.sort);
    th.dataset.dir = state.order === "asc" ? "▲" : "▼";
  });
}
document.querySelector("#incidents tbody").addEventListener("click", async (e) => {
  const id = e.target.dataset.id; if (!id) return;
  try {
    const r = await fetch(`${API_BASE_URL}/incidents/${id}?public=${VIEW.public}`).then((x) => x.json());
    const labels = { id: "ID", occurred_at: "Час", sector: "Сектор", direction: "Напрямок", event_type: "Тип події", intensity: "Інтенсивність", source: "Джерело", summary: "Опис" };
    $("d-id").textContent = `#${r.id}`;
    $("d-body").innerHTML = Object.entries(labels).filter(([k]) => k in r && !(VIEW.public && k === "source"))
      .map(([k, l]) => `<dt>${l}</dt><dd>${esc(r[k])}</dd>`).join("");
    $("details").showModal();
  } catch (err) { showError(`Не вдалося отримати деталі: ${err.message}`); }
});
document.querySelectorAll("#incidents th[data-sort]").forEach((th) => th.addEventListener("click", () => {
  state.order = state.sort === th.dataset.sort && state.order === "desc" ? "asc" : "desc";
  state.sort = th.dataset.sort; state.page = 1; loadIncidents().catch((e) => showError(e.message));
}));
$("prev-page").addEventListener("click", () => { state.page--; loadIncidents().catch((e) => showError(e.message)); });
$("next-page").addEventListener("click", () => { state.page++; loadIncidents().catch((e) => showError(e.message)); });
$("page-size").addEventListener("change", (e) => { state.pageSize = +e.target.value; state.page = 1; loadIncidents().catch((er) => showError(er.message)); });

// ---------------------------------------------------------------- інсайт (автоматичний текст)
function renderInsight(k, cmp, pano, trend) {
  const items = [];
  const dI = cmp.delta_pct.total_incidents;
  if (k.total_incidents === 0) { $("insight-list").innerHTML = "<li>За обраними фільтрами подій немає.</li>"; return; }
  items.push(dI === null
    ? `За період зафіксовано <b>${fmt(k.total_incidents)}</b> подій; у попередньому періоді даних немає.`
    : `За період зафіксовано <b>${fmt(k.total_incidents)}</b> подій — ${dI >= 0 ? "<b>більше</b>" : "<b>менше</b>"} на <b>${Math.abs(dI)}%</b>, ніж за попередній період такої ж тривалості.`);
  items.push(`Основне навантаження — <b>${esc(k.top_direction)}</b> напрямок; середня інтенсивність ${k.avg_intensity.toFixed(1)} (${cmp.delta_pct.avg_intensity >= 0 ? "+" : ""}${cmp.delta_pct.avg_intensity ?? "н/д"}%).`);
  const grow = pano.directions.filter((r) => r.previous >= 3 && r.delta_pct !== null).sort((a, b) => b.delta_pct - a.delta_pct)[0];
  if (grow && grow.delta_pct > 0) items.push(`Найшвидше зростання — <b>${esc(grow.label)}</b> напрямок: ${grow.previous} → ${grow.current} (+${grow.delta_pct}%).`);
  const sec = pano.sectors[0];
  if (sec) items.push(`Найактивніший сектор — <b>${esc(sec.label)}</b> (${sec.current} подій, ${Math.round((100 * sec.current) / k.total_incidents)}% від загалу).`);
  const peak = trend.reduce((m, r) => (r.value > m.value ? r : m), trend[0] || { value: 0 });
  if (peak && peak.value) items.push(state.group === "week"
    ? `Пік активності — тиждень з <b>${fmtDate(peak.t)}</b> (${peak.value} подій; крайні тижні можуть бути неповними).`
    : `Пік активності — <b>${fmtDate(peak.t)}</b> (${peak.value} подій за добу).`);
  $("insight-list").innerHTML = items.map((t) => `<li>${t}</li>`).join("");
}

// ---------------------------------------------------------------- узгоджене оновлення
let seq = 0;
async function apply() {
  const my = ++seq; state.page = 1; showError(""); syncViewLinks();
  history.replaceState(null, "", `?${new URLSearchParams({ view: viewName, ...state.filters })}`);
  document.body.classList.add("loading");
  try {
    const [k, cmp, pano] = await Promise.all([api("/kpi"), api("/compare"), api("/panorama")]);
    const prevF = { from: cmp.previous_period.from, to: cmp.previous_period.to };
    const jobs = [api("/trend", { group: state.group }), api("/trend", { group: state.group, ...prevF })];
    if (visible("distributions")) jobs.push(api("/distribution/directions"), api("/distribution/types"));
    const [trend, trendPrev, dirs, types] = await Promise.all(jobs);
    const extra = [];
    if (visible("heatmap")) extra.push(api("/heatmap", { metric: state.metric }).then(renderHeatmap));
    if (visible("incidents")) extra.push(loadIncidents());
    if (my !== seq) return;                       // застарілий запит — ігноруємо
    renderKpi(k, cmp); renderTrend(trend, trendPrev); renderInsight(k, cmp, pano, trend);
    if (visible("distributions")) renderDistributions(dirs, types);
    if (visible("panorama")) renderPanorama(pano);
    await Promise.all(extra);
  } catch (e) {
    showError(`Помилка завантаження даних: ${e.message}. Перевірте, що API запущено на ${API_BASE_URL}.`);
  } finally { document.body.classList.remove("loading"); }
}
document.querySelectorAll("[data-group]").forEach((b) => b.addEventListener("click", () => {
  state.group = b.dataset.group;
  document.querySelectorAll("[data-group]").forEach((x) => x.classList.toggle("active", x === b)); apply();
}));
document.querySelectorAll("[data-metric]").forEach((b) => b.addEventListener("click", () => {
  state.metric = b.dataset.metric;
  document.querySelectorAll("[data-metric]").forEach((x) => x.classList.toggle("active", x === b));
  api("/heatmap", { metric: state.metric }).then(renderHeatmap).catch((e) => showError(e.message));
}));

initFilters().then(apply).catch((e) => showError(`API недоступне (${API_BASE_URL}): ${e.message}`));
