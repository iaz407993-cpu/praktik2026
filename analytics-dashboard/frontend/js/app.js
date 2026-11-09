/* =====================================================================
   Оперативний дашборд аналітика — фронтенд
   Дані: FastAPI (config.json → apiBaseUrl) · Карта: Leaflet + OSM
   Умовні знаки: milsymbol (APP-6 / MIL-STD-2525)
   Вибірка: період + види ураження + область → усі дані з датою
   ===================================================================== */

const state = {
  cfg: null,
  legend: null,
  units: [],
  events: [],
  strikes: [],
  markers: new Map(),     // unit.id -> Leaflet marker
  selectedId: null,
  charts: {},
  // вибірка
  meta: { min: null, max: null },
  strikeTypes: [],
  supplyTypes: [],
  lossCats: [],
  regions: [],
  depots: [],
  inTransit: [],
  frontline: null,
  // st — види ураження, sp — види постачання: null = усі; Set = обрані
  f: { df: null, dt: null, st: null, sp: null, rid: "" },
  reqId: 0,
};

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const $ = (id) => document.getElementById(id);
const fmt = new Intl.NumberFormat("uk-UA");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* ---------------- Дати ---------------- */
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const parseIso = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = parseIso(s); d.setDate(d.getDate() + n); return iso(d); };
const today = () => iso(new Date());
const daysBetween = (a, b) => Math.round((parseIso(b) - parseIso(a)) / 864e5) + 1;
const uaDate = (s) => parseIso(s).toLocaleDateString("uk-UA");

/* ---------------- Завантаження ---------------- */
async function loadJSON(url) {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) {
    let detail = "";
    try { const j = await r.json(); detail = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail); } catch { /* */ }
    throw new Error(`${r.status} ${r.statusText} — ${url}${detail ? " — " + detail : ""}`);
  }
  return r.json();
}
const api = (path) => loadJSON(state.cfg.apiBaseUrl + path);

function setStatus(kind, text) {
  const el = $("apiStatus");
  el.className = `pill pill-${kind}`;
  el.querySelector(".pill-text").textContent = text;
}

/* ---------------- Вибірка (фільтри) ---------------- */
/** kind: "strike" — додати види ураження, "supply" — види постачання, null — лише дати й область */
function filterQS(kind = "strike") {
  const p = new URLSearchParams({ date_from: state.f.df, date_to: state.f.dt });
  if (state.f.rid) p.set("region_id", state.f.rid);
  if (kind === "strike" && state.f.st) p.set("strike_type", state.f.st.size ? [...state.f.st].join(",") : "none");
  if (kind === "supply" && state.f.sp) p.set("supply_type", state.f.sp.size ? [...state.f.sp].join(",") : "none");
  return p.toString();
}

function saveHash() {
  const p = new URLSearchParams({ df: state.f.df, dt: state.f.dt });
  if (state.f.rid) p.set("rid", state.f.rid);
  if (state.f.st) p.set("st", [...state.f.st].join(",") || "none");
  if (state.f.sp) p.set("sp", [...state.f.sp].join(",") || "none");
  history.replaceState(null, "", "#" + p.toString());
}

/* Багатовибіркові списки (вид ураження, вид постачання) */
const MULTI = [
  { dd: "ddStrike", key: "st", items: () => state.strikeTypes },
  { dd: "ddSupply", key: "sp", items: () => state.supplyTypes },
];

function initMulti(m) {
  const dd = $(m.dd);
  dd.querySelector(".dd-list").innerHTML = m.items().map((t) =>
    `<label><input type="checkbox" value="${esc(t.code)}" checked> ${esc(t.name_uk)}</label>`).join("");
  dd.querySelector(".dd-list").addEventListener("change", () => {
    const checked = [...dd.querySelectorAll(".dd-list input:checked")].map((i) => i.value);
    state.f[m.key] = checked.length === m.items().length ? null : new Set(checked);
    onFilterChange();
  });
  dd.querySelector('[data-act="all"]').addEventListener("click", () => { state.f[m.key] = null; onFilterChange(); });
  dd.querySelector('[data-act="none"]').addEventListener("click", () => { state.f[m.key] = new Set(); onFilterChange(); });
}

function syncMulti(m) {
  const dd = $(m.dd), sel = state.f[m.key], items = m.items();
  dd.querySelectorAll(".dd-list input").forEach((i) => { i.checked = !sel || sel.has(i.value); });
  const n = sel ? sel.size : items.length;
  dd.querySelector(".dd-sum").textContent =
    !sel ? "Усі види" : n === 0 ? "Жодного" :
    n === 1 ? items.find((t) => sel.has(t.code))?.name_uk : `Обрано: ${n} з ${items.length}`;
}

function multiText(key, items, allText) {
  const sel = state.f[key];
  if (!sel) return allText;
  if (!sel.size) return "жодного";
  return items.filter((t) => sel.has(t.code)).map((t) => t.name_uk).join(", ");
}

function loadHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  const valid = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || "");
  if (valid(p.get("df")) && valid(p.get("dt")) && p.get("df") <= p.get("dt")) {
    state.f.df = p.get("df"); state.f.dt = p.get("dt");
  }
  if (p.get("rid")) state.f.rid = p.get("rid");
  for (const m of MULTI) {
    if (!p.has(m.key)) continue;
    const codes = m.items().map((t) => t.code);
    const sel = new Set(p.get(m.key).split(",").filter((c) => codes.includes(c)));
    state.f[m.key] = sel.size === codes.length ? null : sel;
  }
}

function setPreset(days) {
  state.f.dt = today();
  state.f.df = days === "all" ? (state.meta.min || addDays(state.f.dt, -364)) : addDays(state.f.dt, -(Number(days) - 1));
  if (state.f.df > state.f.dt) state.f.df = state.f.dt;
}

function syncFilterUI() {
  $("dateFrom").value = state.f.df;
  $("dateTo").value = state.f.dt;
  $("dateFrom").max = state.f.dt;
  $("dateTo").min = state.f.df;
  $("fRegion").value = state.f.rid;

  // активна кнопка-пресет
  const isToday = state.f.dt === today();
  document.querySelectorAll("#presets button").forEach((b) => {
    const d = b.dataset.days;
    const on = isToday && (d === "all" ? state.f.df === state.meta.min : daysBetween(state.f.df, state.f.dt) === Number(d));
    b.classList.toggle("active", on);
    b.setAttribute("aria-pressed", on);
  });

  MULTI.forEach(syncMulti);

  $("csvStrikes").href = `${state.cfg.apiBaseUrl}/strikes.csv?${filterQS("strike")}`;
  $("csvLogistics").href = `${state.cfg.apiBaseUrl}/logistics/deliveries.csv?${filterQS("supply")}`;
}

let refreshTimer;
function onFilterChange() {
  syncFilterUI();
  saveHash();
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, 250);
}

function bindSelection() {
  document.querySelectorAll("#presets button").forEach((b) =>
    b.addEventListener("click", () => { setPreset(b.dataset.days); onFilterChange(); }));

  const onDate = () => {
    const a = $("dateFrom").value, b = $("dateTo").value;
    if (!a || !b) return;
    state.f.df = a <= b ? a : b;
    state.f.dt = a <= b ? b : a;
    onFilterChange();
  };
  $("dateFrom").addEventListener("change", onDate);
  $("dateTo").addEventListener("change", onDate);

  $("fRegion").addEventListener("change", (e) => { state.f.rid = e.target.value; onFilterChange(); });

  // відкритий список закривається кліком поза ним / Esc; одночасно відкритий лише один
  const dds = () => document.querySelectorAll("details.dd");
  document.addEventListener("click", (e) => dds().forEach((dd) => { if (dd.open && !dd.contains(e.target)) dd.open = false; }));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") dds().forEach((dd) => { dd.open = false; }); });
  dds().forEach((dd) => dd.addEventListener("toggle", () => {
    if (dd.open) dds().forEach((o) => { if (o !== dd) o.open = false; });
  }));

  // навігація по розділах — прокрутка без зміни адреси (у ній зберігається вибірка)
  document.querySelectorAll(".sections a").forEach((a) => a.addEventListener("click", (e) => {
    e.preventDefault();
    document.querySelector(a.getAttribute("href"))?.scrollIntoView({ behavior: "smooth", block: "start" });
  }));

  $("resetFilters").addEventListener("click", () => {
    setPreset(30); state.f.st = null; state.f.sp = null; state.f.rid = ""; onFilterChange();
  });
}

async function loadSelectionMeta() {
  const [meta, sTypes, lCats, regions, supTypes, depots] = await Promise.all([
    api("/meta/date-range"), api("/strike-types"), api("/loss-categories"), api("/regions"),
    api("/supply-types"), api("/depots"),
  ]);
  state.meta = meta;
  state.strikeTypes = sTypes;
  state.lossCats = lCats;
  state.regions = regions;
  state.supplyTypes = supTypes;
  state.depots = depots;

  MULTI.forEach(initMulti);
  renderDepots();
  fillSelect($("fRegion"), regions, "id", "name");
  fillSelect($("regionFilter"), regions, "name", "name", (o, r) => { o.dataset.lat = r.lat; o.dataset.lon = r.lon; });
}

/* ---------------- Символи APP-6 ---------------- */
function symbol(sidc, size, extra = {}) {
  const s = new ms.Symbol(sidc, { size, ...extra });
  return { svg: s.asSVG(), anchor: s.getAnchor(), size: s.getSize() };
}

/* ---------------- Карта ---------------- */
let map, unitsLayer, eventsLayer, strikesLayer, frontLayer, logisticsLayer, depotsLayer, routesLayer;

function initMap() {
  const m = state.cfg.map;
  map = L.map("map", { zoomControl: true, preferCanvas: false, minZoom: 5 }).setView(m.center, m.zoom);
  L.tileLayer(m.tileUrl, { attribution: m.attribution, maxZoom: 18 }).addTo(map);
  map.fitBounds(m.bounds);
  // лінія розмежування — окрема панель під маркерами та іншими шарами
  map.createPane("front").style.zIndex = 390;
  frontLayer = L.layerGroup().addTo(map);
  unitsLayer = L.layerGroup().addTo(map);
  eventsLayer = L.layerGroup();
  strikesLayer = L.layerGroup();
  depotsLayer = L.layerGroup();
  routesLayer = L.layerGroup();
  logisticsLayer = L.layerGroup([routesLayer, depotsLayer]);
  L.control.scale({ imperial: false }).addTo(map);
}

function renderFrontline() {
  frontLayer.clearLayers();
  const fl = state.frontline;
  if (!fl?.coordinates?.length) return;
  const label = `<b>${esc(fl.name)}</b><br>чинна з ${uaDate(fl.valid_from)}<br>
                 <span style="color:var(--text-muted)">${esc(fl.source || "")}</span>`;
  // темна «підкладка» + яскрава лінія — читається на будь-якому фоні карти
  L.polyline(fl.coordinates, { pane: "front", color: "#000", weight: 7, opacity: 0.45, interactive: false }).addTo(frontLayer);
  L.polyline(fl.coordinates, { pane: "front", color: css("--front"), weight: 3, opacity: 0.95 })
    .bindTooltip(label, { sticky: true }).addTo(frontLayer);
}

const DEPOT_SIDC = { base: "SFGPUSS----H---", forward: "SFGPUSS----F---" };

function renderDepots() {
  depotsLayer.clearLayers();
  for (const d of state.depots) {
    const sym = symbol(DEPOT_SIDC[d.kind], 24);
    L.marker([d.lat, d.lon], {
      icon: L.divIcon({ className: "ms-icon", html: sym.svg, iconSize: [sym.size.width, sym.size.height], iconAnchor: [sym.anchor.x, sym.anchor.y] }),
      title: d.name, zIndexOffset: 500,
    }).bindPopup(`<b>${esc(d.name)}</b><br>${d.kind === "base" ? "Базовий склад" : "Передовий пункт забезпечення"} · ${esc(d.region)}`)
      .addTo(depotsLayer);
  }
}

function renderRoutes() {
  routesLayer.clearLayers();
  const color = css("--accent");
  for (const r of state.inTransit) {
    L.polyline([[r.depot_lat, r.depot_lon], [r.unit_lat, r.unit_lon]], { color, weight: 2, dashArray: "6 6", opacity: 0.9 })
      .bindPopup(`<b>У дорозі:</b> ${esc(r.type_name)}, ${fmt.format(r.planned_qty_t)} т<br>
                  ${esc(r.depot)} → ${esc(r.unit)}<br>
                  Відправлено ${new Date(r.depart_time).toLocaleString("uk-UA")}<br>
                  План прибуття ${new Date(r.planned_arrival).toLocaleString("uk-UA")}`)
      .addTo(routesLayer);
    L.circleMarker([r.unit_lat, r.unit_lon], { radius: 4, color, weight: 2, fillColor: color, fillOpacity: 1 }).addTo(routesLayer);
  }
}

function sevColor(sev) { return css(`--seq-${sev}`); }

function unitPopup(u) {
  const aff = state.legend.affiliation[u.affiliation]?.label ?? u.affiliation;
  return `<b>${esc(u.name)}</b><br>${esc(aff)} · ${esc(state.legend.echelon[u.echelon] ?? "")}<br>
          Область: ${esc(u.region)}<br>О/с: ${fmt.format(u.personnel)} · Готовність: ${u.readiness}%<br>
          <span class="mono" style="color:var(--text-muted)">SIDC ${esc(u.sidc)}</span>`;
}

function renderUnits() {
  unitsLayer.clearLayers();
  state.markers.clear();
  const visible = filteredUnits();
  for (const u of visible) {
    const sym = symbol(u.sidc, state.cfg.map.symbolSize);
    const icon = L.divIcon({
      className: "ms-icon",
      html: sym.svg,
      iconSize: [sym.size.width, sym.size.height],
      iconAnchor: [sym.anchor.x, sym.anchor.y],
    });
    const mk = L.marker([u.lat, u.lon], { icon, title: u.name, riseOnHover: true })
      .bindPopup(unitPopup(u))
      .on("click", () => selectUnit(u.id, false));
    mk.addTo(unitsLayer);
    state.markers.set(u.id, mk);
  }
  renderUnitList(visible);
  $("kpiUnits").textContent = fmt.format(visible.length);
}

function renderEventsLayer() {
  eventsLayer.clearLayers();
  for (const e of state.events) {
    L.circleMarker([e.lat, e.lon], {
      radius: 3 + e.severity, color: css("--surface-1"), weight: 2,
      fillColor: sevColor(e.severity), fillOpacity: 0.9,
    })
      .bindPopup(`<b>${esc(e.event_type)}</b><br>${esc(e.region)} · рівень ${e.severity}<br>
                  ${new Date(e.event_time).toLocaleString("uk-UA")}<br>
                  <span style="color:var(--text-muted)">${esc(e.description)}</span>`)
      .addTo(eventsLayer);
  }
}

function lossText(losses, { personnel = false } = {}) {
  return state.lossCats
    .filter((c) => (personnel || c.grp === "equipment") && losses[c.code])
    .map((c) => `${c.name_uk} ${losses[c.code]}`).join(", ");
}

function renderStrikesLayer() {
  strikesLayer.clearLayers();
  const hit = css("--seq-4"), miss = css("--text-muted"), ring = css("--surface-1");
  for (const s of state.strikes) {
    const l = s.losses || {};
    L.circleMarker([s.lat, s.lon], s.success
      ? { radius: 5, color: ring, weight: 2, fillColor: hit, fillOpacity: 0.9 }
      : { radius: 4, color: miss, weight: 1.5, fill: false })
      .bindPopup(`<b>${esc(s.type_name)}</b> · ${s.success ? "уражено" : "без результату"}<br>
                  ${esc(s.region)} · ${new Date(s.strike_time).toLocaleString("uk-UA")}<br>
                  Ціль: ${esc(s.target)}<br>
                  ${l.kia || l.wia ? `О/с: ліквідовано ${l.kia || 0}, поранено ${l.wia || 0}<br>` : ""}
                  ${lossText(l) ? `Техніка: ${esc(lossText(l))}` : ""}`)
      .addTo(strikesLayer);
  }
}

/* ---------------- Фільтри карти ---------------- */
function filteredUnits() {
  const affs = [...document.querySelectorAll(".chips input:checked")].map((i) => i.value);
  const type = $("typeFilter").value;
  const region = $("regionFilter").value;
  const q = $("unitSearch").value.trim().toLowerCase();
  return state.units.filter((u) =>
    affs.includes(u.affiliation) &&
    (!type || u.unit_type === type) &&
    (!region || u.region === region) &&
    (!q || u.name.toLowerCase().includes(q)));
}

function bindFilters() {
  document.querySelectorAll(".chips input").forEach((i) => i.addEventListener("change", renderUnits));
  $("typeFilter").addEventListener("change", renderUnits);
  $("unitSearch").addEventListener("input", renderUnits);
  $("regionFilter").addEventListener("change", (ev) => {
    renderUnits();
    const opt = ev.target.selectedOptions[0];
    if (opt?.dataset.lat) map.flyTo([+opt.dataset.lat, +opt.dataset.lon], 8, { duration: 0.8 });
    else map.flyToBounds(state.cfg.map.bounds, { duration: 0.8 });
  });
  $("eventsToggle").addEventListener("change", (ev) => {
    ev.target.checked ? eventsLayer.addTo(map) : map.removeLayer(eventsLayer);
  });
  $("strikesToggle").addEventListener("change", (ev) => {
    ev.target.checked ? strikesLayer.addTo(map) : map.removeLayer(strikesLayer);
  });
  $("logisticsToggle").addEventListener("change", (ev) => {
    ev.target.checked ? logisticsLayer.addTo(map) : map.removeLayer(logisticsLayer);
  });
  $("frontToggle").addEventListener("change", (ev) => {
    ev.target.checked ? frontLayer.addTo(map) : map.removeLayer(frontLayer);
  });
  $("refreshBtn").addEventListener("click", refresh);
}

function fillSelect(sel, items, valueKey, labelKey, extra) {
  const current = sel.value;
  sel.querySelectorAll("option:not(:first-child)").forEach((o) => o.remove());
  for (const it of items) {
    const o = new Option(it[labelKey], it[valueKey]);
    if (extra) extra(o, it);
    sel.add(o);
  }
  sel.value = current;
}

/* ---------------- Бічна панель ---------------- */
function renderUnitList(units) {
  $("unitCount").textContent = `(${units.length})`;
  const ul = $("unitList");
  ul.innerHTML = "";
  for (const u of units) {
    const li = document.createElement("li");
    li.dataset.id = u.id;
    if (u.id === state.selectedId) li.classList.add("active");
    li.innerHTML = `<span class="sym">${symbol(u.sidc, 14).svg}</span>
                    <span class="nm">${esc(u.name)}</span><span class="rg">${esc(u.region)}</span>`;
    li.addEventListener("click", () => selectUnit(u.id, true));
    ul.appendChild(li);
  }
}

function selectUnit(id, fly) {
  const u = state.units.find((x) => x.id === id);
  if (!u) return;
  state.selectedId = id;
  document.querySelectorAll(".unit-list li").forEach((li) => li.classList.toggle("active", +li.dataset.id === id));

  const aff = state.legend.affiliation[u.affiliation];
  const readyColor = u.readiness >= 70 ? css("--ok") : u.readiness >= 50 ? css("--warn") : css("--crit");
  const el = $("unitDetail");
  el.classList.remove("empty");
  el.innerHTML = `
    <div class="ud-head">${symbol(u.sidc, 34).svg}
      <div><div class="ud-name">${esc(u.name)}</div>
      <div class="muted">${esc(aff?.label)} · ${esc(u.type_name)} · ${esc(state.legend.echelon[u.echelon])}</div></div>
    </div>
    <dl>
      <dt>Область</dt><dd>${esc(u.region)}</dd>
      <dt>Координати</dt><dd class="mono">${u.lat.toFixed(4)}, ${u.lon.toFixed(4)}</dd>
      <dt>Особовий склад</dt><dd class="mono">${fmt.format(u.personnel)}</dd>
      <dt>Статус</dt><dd>${esc(state.legend.status[u.status])}</dd>
      <dt>Оновлено</dt><dd>${new Date(u.updated_at).toLocaleString("uk-UA")}</dd>
      <dt>SIDC</dt><dd class="mono">${esc(u.sidc)}</dd>
      <dt>Боєготовність</dt>
      <dd><span class="mono">${u.readiness}%</span>
        <div class="bar"><span style="width:${u.readiness}%;background:${readyColor}"></span></div></dd>
    </dl>`;

  const mk = state.markers.get(id);
  if (mk) {
    if (fly) map.flyTo(mk.getLatLng(), Math.max(map.getZoom(), 8), { duration: 0.6 });
    mk.openPopup();
  }
}

function renderLegend() {
  const lg = state.legend;
  $("legendStd").textContent = lg.standard;
  const ul = $("legend");
  ul.innerHTML = lg.samples
    .map((s) => `<li><span class="sym">${symbol(s.sidc, 18).svg}</span>${esc(s.label)}</li>`)
    .join("");
  ul.insertAdjacentHTML("beforeend",
    `<li style="margin-top:6px;color:var(--text-muted)">Події — рівень (вкл. шар «Події»):</li>` +
    Object.entries(lg.severity).map(([k, v]) =>
      `<li><span class="sym"><span class="sev" style="background:${sevColor(k)};width:${8 + k * 2}px;height:${8 + k * 2}px"></span></span>${k} — ${esc(v)}</li>`
    ).join("") +
    `<li style="margin-top:6px;color:var(--text-muted)">Вогневі ураження (вкл. шар «Ураження»):</li>
     <li><span class="sym"><span class="sev" style="background:${css("--seq-4")};width:12px;height:12px"></span></span>Ціль уражено</li>
     <li><span class="sym"><span class="sev" style="background:transparent;border:1.5px solid ${css("--text-muted")};width:10px;height:10px"></span></span>Без підтвердженого результату</li>
     <li style="margin-top:6px;color:var(--text-muted)">Лінія та логістика:</li>
     <li><span class="sym"><span class="front-key"></span></span><span id="frontLegend">Лінія розмежування</span></li>
     <li><span class="sym">${symbol(DEPOT_SIDC.base, 16).svg}</span>Склад / пункт забезпечення</li>
     <li><span class="sym"><span class="route-key"></span></span>Рейс у дорозі (шар «Логістика»)</li>`);
}

/* ---------------- KPI ---------------- */
function renderKPIs(s) {
  $("kpiFriendly").textContent = fmt.format(s.units_friendly);
  $("kpiHostile").textContent = fmt.format(s.units_hostile);
  $("kpiPersonnel").textContent = fmt.format(s.personnel_friendly);
  $("kpiReadiness").textContent = `${s.readiness_avg ?? "—"}%`;
  $("kpiEvents").textContent = fmt.format(s.events_7d);
  const prev = s.events_prev_7d || 0;
  const d = prev ? Math.round(((s.events_7d - prev) / prev) * 100) : 0;
  $("kpiEventsDelta").textContent = prev ? `${d > 0 ? "▲" : d < 0 ? "▼" : "•"} ${Math.abs(d)}% до попередніх 7 дн (${prev})` : "";
}

function delta(cur, prev) {
  if (!prev) return cur ? "попередній період: 0" : "";
  const d = Math.round(((cur - prev) / prev) * 100);
  return `${d > 0 ? "▲" : d < 0 ? "▼" : "•"} ${Math.abs(d)}% · попер. період ${fmt.format(prev)}`;
}

function renderStrikeKPIs(sum) {
  const c = sum.current, p = sum.previous;
  $("kStrikes").textContent = fmt.format(c.strikes);
  $("kStrikesD").textContent = delta(c.strikes, p.strikes);
  $("kRate").textContent = c.success_rate == null ? "—" : `${c.success_rate}%`;
  if (c.success_rate != null && p.success_rate != null) {
    const d = Math.round((c.success_rate - p.success_rate) * 10) / 10;
    $("kRateD").textContent = `${d > 0 ? "▲" : d < 0 ? "▼" : "•"} ${Math.abs(d)} п.п. · попер. ${p.success_rate}%`;
  } else $("kRateD").textContent = "";
  $("kKia").textContent = fmt.format(c.kia);       $("kKiaD").textContent = delta(c.kia, p.kia);
  $("kWia").textContent = fmt.format(c.wia);       $("kWiaD").textContent = delta(c.wia, p.wia);
  $("kEq").textContent = fmt.format(c.equipment);  $("kEqD").textContent = delta(c.equipment, p.equipment);
  $("kArmor").textContent = fmt.format(c.armor);   $("kArmorD").textContent = delta(c.armor, p.armor);
  $("kStrikesD").title = $("kKiaD").title = `Попередній період: ${uaDate(p.date_from)} – ${uaDate(p.date_to)}`;
}

/* ---------------- Графіки (Chart.js) ---------------- */
function chartDefaults() {
  Chart.defaults.color = css("--text-secondary");
  Chart.defaults.font.family = css("--font-sans");
  Chart.defaults.font.size = 12;
  Chart.defaults.borderColor = css("--grid");
  Chart.defaults.plugins.legend.labels.boxWidth = 10;
  Chart.defaults.plugins.legend.labels.boxHeight = 10;
  Object.assign(Chart.defaults.plugins.tooltip, {
    backgroundColor: css("--surface-2"), borderColor: css("--border"), borderWidth: 1,
    titleColor: css("--text-primary"), bodyColor: css("--text-secondary"), padding: 10,
  });
}

const gridScale = (extra = {}) => ({
  grid: { color: css("--grid"), drawTicks: false },
  border: { display: false },
  ticks: { padding: 6 },
  ...extra,
});

function upsertChart(key, canvasId, config) {
  if (state.charts[key]) {
    state.charts[key].data = config.data;
    state.charts[key].update();
  } else {
    state.charts[key] = new Chart($(canvasId), config);
  }
}

function hbar(key, canvasId, labels, values, color, label) {
  upsertChart(key, canvasId, {
    type: "bar",
    data: { labels, datasets: [{ label, data: values, backgroundColor: color, borderRadius: 4, borderSkipped: "start", barPercentage: 0.7, categoryPercentage: 0.85 }] },
    options: {
      indexAxis: "y", maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: { x: gridScale({ beginAtZero: true, ticks: { precision: 0 } }), y: { grid: { display: false }, border: { display: false } } },
    },
  });
}

/** Стовпчики з накопиченням (2 серії) — розрив 2px кольором поверхні між сегментами. */
function stacked(key, canvasId, labels, series, { horizontal = false } = {}) {
  const surface = css("--surface-1");
  upsertChart(key, canvasId, {
    type: "bar",
    data: {
      labels,
      datasets: series.map((s) => ({
        label: s.label, data: s.data, backgroundColor: s.color,
        borderColor: surface, borderWidth: horizontal ? { right: 2 } : { top: 2 }, borderSkipped: false,
        borderRadius: 3, barPercentage: horizontal ? 0.7 : 0.85, categoryPercentage: 0.9,
      })),
    },
    options: {
      indexAxis: horizontal ? "y" : "x", maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { position: "top", align: "start" },
        tooltip: { callbacks: { footer: (items) => `Разом: ${fmt.format(items.reduce((a, i) => a + i.raw, 0))}` } },
      },
      scales: horizontal
        ? { x: gridScale({ stacked: true, beginAtZero: true, ticks: { precision: 0 } }), y: { stacked: true, grid: { display: false }, border: { display: false } } }
        : { x: gridScale({ stacked: true, grid: { display: false }, ticks: { maxRotation: 0, autoSkipPadding: 12 } }), y: gridScale({ stacked: true, beginAtZero: true, ticks: { precision: 0 } }) },
    },
  });
}

function bucketLabels(items, bucket) {
  return items.map((d) => {
    const s = parseIso(d.day).toLocaleDateString("uk-UA", { day: "2-digit", month: "2-digit" });
    return bucket === "week" ? `тиж. ${s}` : s;
  });
}

function renderCharts({ timeline, types, regions, evTypes, readiness }) {
  // 1. Динаміка подій — лінія з перехрестям
  const tl = timeline.items;
  $("timelineRange").textContent = timeline.bucket === "week" ? "по тижнях" : "по днях";
  upsertChart("timeline", "chartTimeline", {
    type: "line",
    data: {
      labels: bucketLabels(tl, timeline.bucket),
      datasets: [{
        label: "Подій", data: tl.map((d) => d.count),
        borderColor: css("--accent"), backgroundColor: "rgba(201,180,106,.12)", fill: true,
        borderWidth: 2, tension: 0.3, pointRadius: 0, pointHoverRadius: 5,
      }],
    },
    options: {
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: { legend: { display: false } },
      scales: { x: gridScale({ grid: { display: false }, ticks: { maxRotation: 0, autoSkipPadding: 12 } }), y: gridScale({ beginAtZero: true, ticks: { precision: 0 } }) },
    },
  });

  // 2. Боєготовність — колонки, послідовна шкала
  upsertChart("readiness", "chartReadiness", {
    type: "bar",
    data: {
      labels: readiness.map((r) => r.label),
      datasets: [{ label: "Підрозділів", data: readiness.map((r) => r.count),
        backgroundColor: [css("--seq-2"), css("--seq-3"), css("--seq-4"), css("--seq-5")],
        borderRadius: 4, borderSkipped: "start", barPercentage: 0.7 }],
    },
    options: {
      maintainAspectRatio: false, plugins: { legend: { display: false } },
      scales: { x: { grid: { display: false }, border: { display: false } }, y: gridScale({ beginAtZero: true, ticks: { precision: 0 } }) },
    },
  });

  // 3. Підрозділи за типом — свої vs противник (з легендою)
  upsertChart("types", "chartTypes", {
    type: "bar",
    data: {
      labels: types.map((t) => t.name_uk),
      datasets: [
        { label: "Свої", data: types.map((t) => t.friendly), backgroundColor: css("--friendly"), borderRadius: 4, borderSkipped: "start", barPercentage: 0.8 },
        { label: "Противник", data: types.map((t) => t.hostile), backgroundColor: css("--hostile"), borderRadius: 4, borderSkipped: "start", barPercentage: 0.8 },
      ],
    },
    options: {
      indexAxis: "y", maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: { legend: { position: "top", align: "start" } },
      scales: { x: gridScale({ beginAtZero: true, ticks: { precision: 0 } }), y: { grid: { display: false }, border: { display: false } } },
    },
  });

  // 4–5. Події за областями / за типом
  hbar("regions", "chartRegions", regions.map((r) => r.region), regions.map((r) => r.count), css("--seq-4"), "Подій");
  hbar("evTypes", "chartEventTypes", evTypes.map((r) => r.event_type), evTypes.map((r) => r.count), css("--accent"), "Подій");
}

const MISS_COLOR = "#4b5651";   // нейтральний сірий для «без результату»
const WIA_COLOR = "#9c4646";    // темніший крок того ж червоного, що й «противник»

function renderStrikeCharts({ sTimeline, byType, byCat, byRegion }) {
  const tl = sTimeline.items;
  const labels = bucketLabels(tl, sTimeline.bucket);
  document.querySelectorAll(".bucket-note").forEach((el) => { el.textContent = sTimeline.bucket === "week" ? "по тижнях" : "по днях"; });

  stacked("sTime", "cStrikesTime", labels, [
    { label: "Ціль уражено", data: tl.map((d) => d.successful), color: css("--seq-4") },
    { label: "Без результату", data: tl.map((d) => d.strikes - d.successful), color: MISS_COLOR },
  ]);
  stacked("sPers", "cPersonnel", labels, [
    { label: "Ліквідовано", data: tl.map((d) => d.kia), color: css("--hostile") },
    { label: "Поранено", data: tl.map((d) => d.wia), color: WIA_COLOR },
  ]);

  const eq = byCat.filter((c) => c.grp === "equipment").sort((a, b) => b.qty - a.qty);
  hbar("sEquip", "cEquip", eq.map((c) => c.name_uk), eq.map((c) => c.qty), css("--hostile"), "Знищено");

  stacked("sType", "cByType", byType.map((t) => t.name_uk), [
    { label: "Уражено", data: byType.map((t) => t.successful), color: css("--seq-4") },
    { label: "Без результату", data: byType.map((t) => t.strikes - t.successful), color: MISS_COLOR },
  ], { horizontal: true });

  hbar("sRegS", "cRegStrikes", byRegion.map((r) => r.region), byRegion.map((r) => r.strikes), css("--seq-4"), "Уражень");
  const byKia = [...byRegion].sort((a, b) => b.kia - a.kia);
  hbar("sRegK", "cRegKia", byKia.map((r) => r.region), byKia.map((r) => r.kia), css("--hostile"), "Ліквідовано");
  const byEq = [...byRegion].sort((a, b) => b.equipment - a.equipment);
  hbar("sRegE", "cRegEq", byEq.map((r) => r.region), byEq.map((r) => r.equipment), css("--hostile"), "Знищено техніки");
}

/* ---------------- Таблиця результативності ---------------- */
function renderMatrix(byType) {
  const eqCats = state.lossCats.filter((c) => c.grp === "equipment");
  const cols = [
    { key: "strikes", label: "Уражень", get: (t) => t.strikes },
    { key: "rate", label: "Результ., %", get: (t) => (t.strikes ? Math.round((t.successful / t.strikes) * 1000) / 10 : 0), heat: false },
    { key: "kia", label: "Ліквід.", get: (t) => t.kia },
    { key: "wia", label: "Поран.", get: (t) => t.wia },
    { key: "per", label: "Ліквід. на 1 ураж.", get: (t) => (t.strikes ? Math.round((t.kia / t.strikes) * 100) / 100 : 0) },
    ...eqCats.map((c) => ({ key: c.code, label: c.name_uk, get: (t) => t.losses?.[c.code] || 0 })),
    { key: "equipment", label: "Техніки всього", get: (t) => t.equipment },
  ];
  const max = Object.fromEntries(cols.map((c) => [c.key, Math.max(0, ...byType.map(c.get))]));
  const heat = "232,138,46";   // --seq-4 у RGB

  $("matrixHead").innerHTML = `<tr><th>Вид ураження</th>${cols.map((c) => `<th class="num">${esc(c.label)}</th>`).join("")}</tr>`;
  $("matrixBody").innerHTML = byType.length ? byType.map((t) => `<tr><td>${esc(t.name_uk)}</td>${cols.map((c) => {
    const v = c.get(t);
    const a = c.heat === false || !max[c.key] ? 0 : 0.06 + 0.44 * (v / max[c.key]);
    return `<td class="num${v ? "" : " zero"}" style="${a ? `background:rgba(${heat},${a.toFixed(3)})` : ""}">${fmt.format(v)}</td>`;
  }).join("")}</tr>`).join("") : `<tr><td colspan="${cols.length + 1}" class="muted">Немає уражень у вибірці</td></tr>`;

  const tot = byType.reduce((a, t) => {
    a.strikes += t.strikes; a.successful += t.successful; a.kia += t.kia; a.wia += t.wia; a.equipment += t.equipment;
    for (const [k, v] of Object.entries(t.losses || {})) a.losses[k] = (a.losses[k] || 0) + v;
    return a;
  }, { strikes: 0, successful: 0, kia: 0, wia: 0, equipment: 0, losses: {} });
  $("matrixFoot").innerHTML = byType.length ? `<tr><td>Разом</td>${cols.map((c) => `<td class="num">${fmt.format(c.get(tot))}</td>`).join("")}</tr>` : "";
}

/* ---------------- Логістика ---------------- */
const STATUS = {
  delivered:  { label: "Вчасно",          cls: "st-ok",   color: () => css("--ok") },
  delayed:    { label: "Із запізненням",  cls: "st-warn", color: () => css("--warn") },
  in_transit: { label: "У дорозі",        cls: "st-info", color: () => css("--transit") },
  lost:       { label: "Втрачено",        cls: "st-crit", color: () => css("--crit") },
};
const covColor = (p) => (p == null ? css("--text-muted") : p >= 90 ? css("--ok") : p >= 75 ? css("--warn") : css("--crit"));
const fmt1 = new Intl.NumberFormat("uk-UA", { maximumFractionDigits: 1 });

function ppDelta(cur, prev) {
  if (cur == null || prev == null) return "";
  const d = Math.round((cur - prev) * 10) / 10;
  return `${d > 0 ? "▲" : d < 0 ? "▼" : "•"} ${fmt1.format(Math.abs(d))} п.п. · попер. ${fmt1.format(prev)}%`;
}
const pct = (v) => (v == null ? "—" : `${fmt1.format(v)}%`);

function renderLogKPIs(sum) {
  const c = sum.current, p = sum.previous;
  $("lDeliv").textContent = fmt.format(c.deliveries);      $("lDelivD").textContent = delta(c.deliveries, p.deliveries);
  $("lTons").textContent = fmt.format(Math.round(c.delivered_t)); $("lTonsD").textContent = delta(Math.round(c.delivered_t), Math.round(p.delivered_t));
  $("lPlan").textContent = pct(c.plan_pct);                $("lPlanD").textContent = ppDelta(c.plan_pct, p.plan_pct);
  $("lCov").textContent = pct(c.coverage_pct);
  $("lCovD").textContent = `потреба ${fmt.format(Math.round(c.need_t))} т · ${ppDelta(c.coverage_pct, p.coverage_pct)}`;
  $("lOnTime").textContent = pct(c.on_time_pct);           $("lOnTimeD").textContent = ppDelta(c.on_time_pct, p.on_time_pct);
  $("lLost").textContent = fmt.format(c.lost);
  $("lLostD").textContent = `у дорозі ${fmt.format(c.in_transit)} · попер. період втрачено ${fmt.format(p.lost)}`;
  $("logPeriod").textContent = `${uaDate(sum.period.date_from)} – ${uaDate(sum.period.date_to)} (${sum.period.days} дн)`;
}

function renderLogCharts({ lTimeline, lStatus, lByType }) {
  const tl = lTimeline.items;
  upsertChart("lTime", "cLogTime", {
    type: "bar",
    data: {
      labels: bucketLabels(tl, lTimeline.bucket),
      datasets: [
        { label: "План", data: tl.map((d) => d.planned_t), backgroundColor: MISS_COLOR, borderRadius: 3, borderSkipped: "start", barPercentage: 0.9, categoryPercentage: 0.8 },
        { label: "Доставлено", data: tl.map((d) => d.delivered_t), backgroundColor: css("--friendly"), borderRadius: 3, borderSkipped: "start", barPercentage: 0.9, categoryPercentage: 0.8 },
      ],
    },
    options: {
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { position: "top", align: "start" },
        tooltip: { callbacks: {
          label: (i) => ` ${i.dataset.label}: ${fmt1.format(i.raw)} т`,
          footer: (items) => { const [p, f] = items.map((i) => i.raw); return p ? `Виконання: ${fmt1.format((f / p) * 100)}%` : ""; },
        } },
      },
      scales: { x: gridScale({ grid: { display: false }, ticks: { maxRotation: 0, autoSkipPadding: 12 } }), y: gridScale({ beginAtZero: true }) },
    },
  });

  hbar("lStatus", "cLogStatus", lStatus.map((s) => s.label), lStatus.map((s) => s.count),
       lStatus.map((s) => STATUS[s.status].color()), "Рейсів");

  upsertChart("lNeed", "cLogNeed", {
    type: "bar",
    data: {
      labels: lByType.map((t) => t.name_uk),
      datasets: [
        { label: "Потреба за нормами", data: lByType.map((t) => t.need_t), backgroundColor: MISS_COLOR, borderRadius: 3, borderSkipped: "start", barPercentage: 0.9, categoryPercentage: 0.75 },
        { label: "Доставлено", data: lByType.map((t) => t.delivered_t), backgroundColor: css("--friendly"), borderRadius: 3, borderSkipped: "start", barPercentage: 0.9, categoryPercentage: 0.75 },
      ],
    },
    options: {
      indexAxis: "y", maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { position: "top", align: "start" },
        tooltip: { callbacks: {
          label: (i) => ` ${i.dataset.label}: ${fmt1.format(i.raw)} т`,
          footer: (items) => { const t = lByType[items[0].dataIndex]; return `Дефіцит: ${fmt1.format(Math.max(0, t.need_t - t.delivered_t))} т`; },
        } },
      },
      scales: { x: gridScale({ beginAtZero: true }), y: { grid: { display: false }, border: { display: false } } },
    },
  });

  upsertChart("lType", "cLogType", {
    type: "bar",
    data: {
      labels: lByType.map((t) => t.name_uk),
      datasets: [{ label: "Забезпеченість, %", data: lByType.map((t) => t.coverage_pct ?? 0),
        backgroundColor: lByType.map((t) => covColor(t.coverage_pct)),
        borderRadius: 4, borderSkipped: "start", barPercentage: 0.7 }],
    },
    options: {
      indexAxis: "y", maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (i) => {
        const t = lByType[i.dataIndex];
        return [` Забезпеченість: ${pct(t.coverage_pct)}`, ` Доставлено ${fmt1.format(t.delivered_t)} т з потреби ${fmt1.format(t.need_t)} т`];
      } } } },
      scales: { x: gridScale({ beginAtZero: true, suggestedMax: 100, ticks: { callback: (v) => `${v}%` } }), y: { grid: { display: false }, border: { display: false } } },
    },
  });
}

function renderDepotTable(rows) {
  $("depotTable").innerHTML = rows.map((d) => `<tr>
    <td>${esc(d.name)}</td>
    <td><span class="kind-tag">${d.kind === "base" ? "базовий" : "передовий"}</span></td>
    <td>${esc(d.region)}</td>
    <td class="num mono">${fmt.format(d.deliveries)}</td>
    <td class="num mono">${fmt1.format(d.delivered_t)}</td>
    <td class="num mono">${d.avg_km == null ? "—" : fmt.format(d.avg_km)}</td>
    <td class="num mono">${d.avg_hours == null ? "—" : fmt1.format(d.avg_hours)}</td>
    <td class="num mono">${d.deliveries ? `${fmt.format(d.delayed)} <span class="muted">(${Math.round((d.delayed / d.deliveries) * 100)}%)</span>` : "—"}</td>
    <td class="num mono">${d.lost ? `<span class="st-badge"><i class="st-dot st-crit"></i>${d.lost}</span>` : "0"}</td>
    <td class="num mono">${fmt.format(d.in_transit)}</td>
  </tr>`).join("");
}

function renderCoverage(rows) {
  const types = state.supplyTypes.filter((t) => !state.f.sp || state.f.sp.has(t.code));
  $("covHead").innerHTML = `<tr><th>Підрозділ</th><th>Область</th><th class="num">О/с</th><th class="num">Потреба, т</th>
    <th class="num">Доставлено, т</th><th>Забезпеченість</th>${types.map((t) => `<th class="num">${esc(t.name_uk)}</th>`).join("")}<th>Найгірше</th></tr>`;
  $("covBody").innerHTML = rows.length ? rows.map((u) => `<tr>
    <td>${esc(u.name)}</td><td>${esc(u.region)}</td>
    <td class="num mono">${fmt.format(u.personnel)}</td>
    <td class="num mono">${fmt1.format(u.need_t)}</td>
    <td class="num mono">${fmt1.format(u.delivered_t)}</td>
    <td><span class="cov-bar"><span class="mono">${pct(u.coverage_pct)}</span>
      <span class="bar"><span style="width:${Math.min(100, u.coverage_pct || 0)}%;background:${covColor(u.coverage_pct)}"></span></span></span></td>
    ${types.map((t) => {
      const v = u.by_type?.[t.code];
      // що нижча забезпеченість, то насиченіший червоний фон (дефіцит)
      const a = v == null ? 0 : Math.max(0, Math.min(1, (100 - v) / 50)) * 0.45;
      return `<td class="num" style="${a ? `background:rgba(229,83,75,${a.toFixed(3)})` : ""}">${v == null ? "—" : fmt1.format(v)}</td>`;
    }).join("")}
    <td>${esc(u.worst_type)} <span class="muted mono">${pct(u.worst_pct)}</span></td>
  </tr>`).join("") : `<tr><td colspan="${types.length + 7}" class="muted">Немає підрозділів у вибірці</td></tr>`;
}

function renderDeliveries(list) {
  const rows = list.items;
  $("delivCount").textContent = `показано ${fmt.format(rows.length)} з ${fmt.format(list.total)}`;
  $("delivTable").innerHTML = rows.length ? rows.map((d) => `<tr>
    <td class="mono">${shortTime(d.depart_time)}</td>
    <td><span class="st-badge"><i class="st-dot ${STATUS[d.status].cls}"></i>${STATUS[d.status].label}</span></td>
    <td>${esc(d.type_name)}</td><td>${esc(d.depot)}</td><td>${esc(d.unit)}</td><td>${esc(d.region)}</td>
    <td class="num mono">${fmt1.format(d.planned_qty_t)}</td>
    <td class="num mono">${d.status === "in_transit" ? "—" : fmt1.format(d.delivered_qty_t)}</td>
    <td class="num mono">${fmt.format(d.distance_km)}</td>
    <td class="mono">${d.arrive_time ? shortTime(d.arrive_time) : `<span class="muted">план ${shortTime(d.planned_arrival)}</span>`}</td>
  </tr>`).join("") : `<tr><td colspan="10" class="muted">Немає рейсів у вибірці</td></tr>`;
}

/* ---------------- Таблиці ---------------- */
const shortTime = (t) => new Date(t).toLocaleString("uk-UA", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });

function renderTable(events) {
  $("eventsCount").textContent = `${fmt.format(Math.min(events.length, 25))} з ${fmt.format(events.length)} у вибірці`;
  $("eventsTable").innerHTML = events.length ? events.slice(0, 25).map((e) => `
    <tr>
      <td class="mono">${shortTime(e.event_time)}</td>
      <td>${esc(e.event_type)}</td>
      <td>${esc(e.region)}</td>
      <td><span class="sev-badge"><i style="background:${sevColor(e.severity)}"></i>${e.severity} · ${esc(state.legend.severity[e.severity])}</span></td>
      <td>${esc(e.description)}</td>
    </tr>`).join("") : `<tr><td colspan="5" class="muted">Немає подій у вибірці</td></tr>`;
}

function renderStrikesTable(list) {
  const rows = list.items.slice(0, 100);
  $("strikesCount").textContent = `показано ${fmt.format(rows.length)} з ${fmt.format(list.total)} · повна вибірка — кнопка «CSV»`;
  $("strikesTable").innerHTML = rows.length ? rows.map((s) => {
    const l = s.losses || {};
    return `<tr>
      <td class="mono">${shortTime(s.strike_time)}</td>
      <td>${esc(s.type_name)}</td>
      <td>${esc(s.region)}</td>
      <td>${esc(s.target)}</td>
      <td>${s.success ? '<span class="res-ok">Уражено</span>' : '<span class="res-none">Без результату</span>'}</td>
      <td class="num mono">${l.kia || "—"}</td>
      <td class="num mono">${l.wia || "—"}</td>
      <td>${esc(lossText(l)) || '<span class="muted">—</span>'}</td>
    </tr>`;
  }).join("") : `<tr><td colspan="8" class="muted">Немає уражень у вибірці</td></tr>`;
}

function renderSelectionSummary(sum, logSum, eventsCount) {
  const f = state.f;
  const region = f.rid ? state.regions.find((r) => String(r.id) === String(f.rid))?.name : "усі області";
  const period = `${uaDate(f.df)} – ${uaDate(f.dt)} (${daysBetween(f.df, f.dt)} дн)`;
  $("fbSummary").textContent =
    `Вибірка: ${period} · ${region} · ураження: ${multiText("st", state.strikeTypes, "усі види")} · ` +
    `постачання: ${multiText("sp", state.supplyTypes, "усі види")} → ${fmt.format(sum.current.strikes)} уражень, ` +
    `${fmt.format(logSum.current.deliveries)} рейсів, ${fmt.format(eventsCount)} подій. ` +
    `«Вид ураження» діє лише на ураження, «Постачання» — лише на логістику.`;
  $("strikesPeriod").textContent = period;
}

/* ---------------- Цикл оновлення ---------------- */
async function refresh() {
  const id = ++state.reqId;
  setStatus("wait", "Оновлення…");
  document.querySelector(".wrap").classList.add("loading");
  try {
    const q = filterQS("strike"), qe = filterQS(null), ql = filterQS("supply");
    // «у дорозі» — завжди поточний стан (останні 3 доби), незалежно від періоду
    const qTransit = new URLSearchParams({ days: 3 });
    if (state.f.rid) qTransit.set("region_id", state.f.rid);
    if (state.f.sp) qTransit.set("supply_type", state.f.sp.size ? [...state.f.sp].join(",") : "none");

    const [units, summary, types, readiness, unitTypes,
           events, timeline, regionsStat, evTypes,
           sSum, sTimeline, byType, byCat, byRegion, strikes,
           lSum, lTimeline, lStatus, lByType, lDepots, lCoverage, lDeliv, lTransit, frontline] = await Promise.all([
      api("/units"), api("/stats/summary"), api("/stats/units-by-type"), api("/stats/readiness"), api("/unit-types"),
      api(`/events?${qe}&limit=2000`), api(`/stats/events-timeline?${qe}`),
      api(`/stats/events-by-region?${qe}&limit=8`), api(`/stats/events-by-type?${qe}`),
      api(`/stats/strikes-summary?${q}`), api(`/stats/strikes-timeline?${q}`), api(`/stats/strikes-by-type?${q}`),
      api(`/stats/losses-by-category?${q}`), api(`/stats/strikes-by-region?${q}&limit=10`), api(`/strikes?${q}&limit=3000`),
      api(`/logistics/summary?${ql}`), api(`/logistics/timeline?${ql}`), api(`/logistics/by-status?${ql}`),
      api(`/logistics/by-type?${ql}`), api(`/logistics/by-depot?${ql}`), api(`/logistics/units-coverage?${ql}&limit=100`),
      api(`/logistics/deliveries?${ql}&limit=200`), api(`/logistics/deliveries?${qTransit}&status=in_transit&limit=500`),
      api(`/frontline?date=${state.f.dt}`),
    ]);
    if (id !== state.reqId) return;   // прийшла відповідь на застарілий запит

    state.units = units;
    state.events = events;
    state.strikes = strikes.items;
    state.inTransit = lTransit.items;
    state.frontline = frontline;

    fillSelect($("typeFilter"), unitTypes, "code", "name_uk");

    renderUnits();
    renderEventsLayer();
    renderStrikesLayer();
    renderKPIs(summary);
    renderCharts({ timeline, types, regions: regionsStat, evTypes, readiness });
    renderTable(events);
    renderStrikeKPIs(sSum);
    renderStrikeCharts({ sTimeline, byType, byCat, byRegion });
    renderMatrix(byType);
    renderStrikesTable(strikes);
    renderFrontline();
    renderRoutes();
    renderLogKPIs(lSum);
    renderLogCharts({ lTimeline, lStatus, lByType });
    renderDepotTable(lDepots);
    renderCoverage(lCoverage);
    renderDeliveries(lDeliv);
    const fl = $("frontLegend");
    if (fl && frontline.valid_from) fl.textContent = `Лінія розмежування (орієнт.), чинна з ${uaDate(frontline.valid_from)}`;
    renderSelectionSummary(sSum, lSum, events.length);
    if (state.selectedId) selectUnit(state.selectedId, false);

    document.querySelector(".error-box")?.remove();
    setStatus("ok", `API онлайн · ${new Date().toLocaleTimeString("uk-UA")}`);
  } catch (err) {
    if (id !== state.reqId) return;
    console.error(err);
    setStatus("err", "API недоступний");
    showError(err);
  } finally {
    if (id === state.reqId) document.querySelector(".wrap").classList.remove("loading");
  }
}

function showError(err) {
  document.querySelector(".error-box")?.remove();
  const box = document.createElement("div");
  box.className = "error-box";
  box.innerHTML = `<b>Не вдалося отримати дані з бекенду.</b><br>
    Перевірте, що запущено PostgreSQL і бекенд: <code>uvicorn main:app --reload --port 8000</code>,
    а адреса в <code>data/config.json</code> правильна (<code>${esc(state.cfg?.apiBaseUrl)}</code>).<br>
    <span class="muted">${esc(err.message)}</span>`;
  document.querySelector(".wrap").prepend(box);
}

function tickClock() {
  $("clock").textContent = new Date().toLocaleTimeString("uk-UA");
}

/* ---------------- Старт ---------------- */
(async function main() {
  tickClock();
  setInterval(tickClock, 1000);
  try {
    [state.cfg, state.legend] = await Promise.all([loadJSON("data/config.json"), loadJSON("data/legend.json")]);
  } catch (err) {
    setStatus("err", "Немає config.json");
    document.querySelector(".wrap").insertAdjacentHTML("afterbegin",
      `<div class="error-box"><b>Не завантажено data/config.json.</b> Відкривайте сторінку через веб-сервер
       (<code>python -m http.server 5500</code>), а не подвійним кліком по файлу.</div>`);
    return;
  }
  chartDefaults();
  initMap();
  renderLegend();
  bindFilters();
  bindSelection();

  try {
    await loadSelectionMeta();
  } catch (err) {
    console.error(err);
    setStatus("err", "API недоступний");
    showError(err);
  }
  setPreset(state.cfg.defaultDays || 30);
  loadHash();
  syncFilterUI();
  await refresh();
  if (state.cfg.refreshSeconds > 0) setInterval(refresh, state.cfg.refreshSeconds * 1000);
})();
