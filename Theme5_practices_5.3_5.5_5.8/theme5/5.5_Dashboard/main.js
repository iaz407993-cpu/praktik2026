import { mockData } from './mock.js';

// ---------- Довідники ----------
const RANK_UA = { Private: 'Солдат', Corporal: 'Капрал', Sergeant: 'Сержант', Lieutenant: 'Лейтенант' };
const RANK_ORDER = ['Private', 'Corporal', 'Sergeant', 'Lieutenant'];
const RANK_COLORS = ['#8a9a5b', '#556b2f', '#005a34', '#c9a227'];
const GROUP_COLORS = { 'Group A': '#005a34', 'Group B': '#556b2f', 'Group C': '#a0522d' };
const GROUP_PLACE = {
  'Group A': { city: 'Київ', coords: [50.4501, 30.5234] },
  'Group B': { city: 'Львів', coords: [49.8397, 24.0297] },
  'Group C': { city: 'Одеса', coords: [46.4825, 30.7233] },
};
const FALLBACK_COLORS = ['#005a34', '#556b2f', '#a0522d', '#3d6b9e', '#c9a227'];

// ---------- Підготовка даних (плоска таблиця) ----------
const today = new Date();
const ageOf = (iso) => {
  const b = new Date(iso);
  let a = today.getFullYear() - b.getFullYear();
  if (today < new Date(today.getFullYear(), b.getMonth(), b.getDate())) a -= 1;
  return a;
};
const people = mockData.groups.flatMap((g) =>
  g.students.map((s) => ({
    ...s,
    group: g.group_name,
    rank: RANK_UA[s.rank_name] || s.rank_name,
    age: ageOf(s.birth_date),
    year: Number(s.birth_date.slice(0, 4)),
  }))
);
const groupNames = mockData.groups.map((g) => g.group_name);
const colorOf = (g, i) => GROUP_COLORS[g] || FALLBACK_COLORS[i % FALLBACK_COLORS.length];

// ---------- Стан ----------
const state = { group: 'all', search: '', sortKey: 'full_name', sortDir: 1 };
const filtered = () => (state.group === 'all' ? people : people.filter((p) => p.group === state.group));

// ---------- Фільтр ----------
const select = document.getElementById('group-filter');
groupNames.forEach((g) => select.add(new Option(`${g} (${GROUP_PLACE[g]?.city ?? '—'})`, g)));
select.addEventListener('change', () => setGroup(select.value));
function setGroup(g) {
  state.group = state.group === g && g !== 'all' ? 'all' : g;   // повторний клік знімає фільтр
  select.value = state.group;
  render();
}

// ---------- KPI ----------
function renderKpi(rows) {
  const avgAge = rows.reduce((s, p) => s + p.age, 0) / (rows.length || 1);
  const officers = rows.filter((p) => p.rank_name === 'Lieutenant').length;
  const nco = rows.filter((p) => ['Sergeant', 'Corporal'].includes(p.rank_name)).length;
  const cards = [
    ['Особовий склад', rows.length, state.group === 'all' ? `${groupNames.length} групи` : state.group],
    ['Середній вік', avgAge.toFixed(1), 'років'],
    ['Офіцери', officers, `${pct(officers, rows.length)} від складу`],
    ['Сержанти й капрали', nco, `${pct(nco, rows.length)} від складу`],
  ];
  document.getElementById('kpi').innerHTML = cards
    .map(([t, v, s]) => `<div class="info-box"><div class="kpi-title">${t}</div><div class="kpi-value">${v}</div><div class="kpi-sub">${s}</div></div>`)
    .join('');
}
const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '0%');

// ---------- Графіки ----------
Chart.defaults.font.family = 'Arial, sans-serif';
Chart.defaults.color = '#333';
const charts = {};

charts.groups = new Chart(document.getElementById('chart-groups'), {
  type: 'bar',
  data: { labels: [], datasets: [] },
  options: {
    maintainAspectRatio: false,
    plugins: {
      legend: {
        position: 'bottom',
        labels: { generateLabels: (c) => c.data.datasets.map((d, i) => ({ text: d.label, fillStyle: RANK_COLORS[i], strokeStyle: RANK_COLORS[i], datasetIndex: i, hidden: !c.isDatasetVisible(i) })) },
      },
    },
    scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true, ticks: { precision: 0 }, title: { display: true, text: 'осіб' } } },
    onClick: (_, els) => els.length && setGroup(groupNames[els[0].index]),
  },
});

charts.ranks = new Chart(document.getElementById('chart-ranks'), {
  type: 'doughnut',
  data: { labels: RANK_ORDER.map((r) => RANK_UA[r]), datasets: [{ data: [], backgroundColor: RANK_COLORS, borderColor: '#fff', borderWidth: 2 }] },
  options: {
    maintainAspectRatio: false,
    cutout: '55%',
    plugins: {
      legend: { position: 'right' },
      tooltip: { callbacks: { label: (c) => ` ${c.label}: ${c.raw} (${pct(c.raw, c.dataset.data.reduce((a, b) => a + b, 0))})` } },
    },
  },
});

charts.years = new Chart(document.getElementById('chart-years'), {
  type: 'line',
  data: { labels: [], datasets: [] },
  options: {
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: { legend: { position: 'bottom' } },
    scales: {
      y: { beginAtZero: true, ticks: { precision: 0 }, title: { display: true, text: 'осіб за рік' } },
      y2: { position: 'right', beginAtZero: true, grid: { drawOnChartArea: false }, ticks: { precision: 0 }, title: { display: true, text: 'накопичено' } },
    },
  },
});

function renderCharts(rows) {
  // 1. Групи (стовпчики з розбивкою за званнями)
  const shownGroups = state.group === 'all' ? groupNames : [state.group];
  charts.groups.data.labels = groupNames;
  charts.groups.data.datasets = RANK_ORDER.map((r, i) => ({
    label: RANK_UA[r],
    backgroundColor: groupNames.map((g) => (shownGroups.includes(g) ? RANK_COLORS[i] : RANK_COLORS[i] + '40')),
    data: groupNames.map((g) => people.filter((p) => p.group === g && p.rank_name === r).length),
  }));
  charts.groups.update();

  // 2. Звання
  const rankCounts = RANK_ORDER.map((r) => rows.filter((p) => p.rank_name === r).length);
  charts.ranks.data.datasets[0].data = rankCounts;
  charts.ranks.update();

  // 3. Роки народження — повний безперервний діапазон, щоб «пропущені» роки були видні
  const years = people.map((p) => p.year);
  const span = [];
  for (let y = Math.min(...years); y <= Math.max(...years); y++) span.push(y);
  const perYear = span.map((y) => rows.filter((p) => p.year === y).length);
  let acc = 0;
  charts.years.data.labels = span;
  charts.years.data.datasets = [
    { label: 'народилось у році', data: perYear, borderColor: '#005a34', backgroundColor: '#005a3433', fill: true, tension: 0, yAxisID: 'y' },
    { label: 'накопичено', data: perYear.map((v) => (acc += v)), borderColor: '#c9a227', borderDash: [6, 4], pointRadius: 2, yAxisID: 'y2' },
  ];
  charts.years.update();

  // Короткі інтерпретації під графіками
  const counts = groupNames.map((g) => people.filter((p) => p.group === g).length);
  const iMax = counts.indexOf(Math.max(...counts));
  document.getElementById('insight-groups').textContent =
    `Найбільша — ${groupNames[iMax]} (${counts[iMax]} осіб). Солдати становлять основу кожної групи.`;
  const iRank = rankCounts.indexOf(Math.max(...rankCounts));
  document.getElementById('insight-ranks').textContent =
    `Переважає звання «${RANK_UA[RANK_ORDER[iRank]]}» — ${pct(rankCounts[iRank], rows.length)} складу; командна ланка (сержанти, лейтенанти) — ${pct(rankCounts[2] + rankCounts[3], rows.length)}.`;
  const iYear = perYear.indexOf(Math.max(...perYear));
  document.getElementById('insight-years').textContent = rows.length
    ? `Пік — ${span[iYear]} р. (${perYear[iYear]} осіб); діапазон віку ${Math.min(...rows.map((p) => p.age))}–${Math.max(...rows.map((p) => p.age))} років.`
    : '';
}

// ---------- Карта ----------
const map = L.map('map', { scrollWheelZoom: false }).setView([48.6, 28.5], 5);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 18,
  attribution: '&copy; OpenStreetMap',
}).addTo(map);
const circles = {};
groupNames.forEach((g, i) => {
  const place = GROUP_PLACE[g];
  if (!place) return;
  const n = people.filter((p) => p.group === g).length;
  circles[g] = L.circleMarker(place.coords, { radius: 8 + n * 1.6, color: '#fff', weight: 2, fillColor: colorOf(g, i), fillOpacity: 0.85 })
    .addTo(map)
    .bindTooltip(`<b>${g}</b> — ${place.city}<br>${n} осіб`, { direction: 'top' })
    .on('click', () => setGroup(g));
});
map.fitBounds(Object.values(GROUP_PLACE).map((p) => p.coords), { padding: [40, 40] });

function renderMap() {
  Object.entries(circles).forEach(([g, c]) => c.setStyle({ fillOpacity: state.group === 'all' || state.group === g ? 0.85 : 0.2 }));
  const sel = state.group === 'all' ? null : GROUP_PLACE[state.group];
  document.getElementById('insight-map').textContent = sel
    ? `${state.group}: пункт дислокації — ${sel.city}.`
    : `Групи розосереджені між трьома регіонами: північ (Київ), захід (Львів), південь (Одеса).`;
}

// ---------- Таблиця ----------
const tbody = document.querySelector('#student-table tbody');
document.querySelectorAll('#student-table th').forEach((th) =>
  th.addEventListener('click', () => {
    const k = th.dataset.key;
    state.sortDir = state.sortKey === k ? -state.sortDir : 1;
    state.sortKey = k;
    renderTable(filtered());
  })
);
document.getElementById('search').addEventListener('input', (e) => {
  state.search = e.target.value.trim().toLowerCase();
  renderTable(filtered());
});
const fmtDate = (iso) => iso.split('-').reverse().join('.');

function renderTable(rows) {
  const q = state.search;
  const list = rows
    .filter((p) => !q || p.full_name.toLowerCase().includes(q) || p.rank.toLowerCase().includes(q))
    .sort((a, b) => (a[state.sortKey] > b[state.sortKey] ? 1 : a[state.sortKey] < b[state.sortKey] ? -1 : 0) * state.sortDir);
  tbody.innerHTML = list
    .map((p) => `<tr><td>${p.full_name}</td><td>${fmtDate(p.birth_date)}</td><td>${p.age}</td>
      <td><span class="rank rank-${p.rank_name.toLowerCase()}">${p.rank}</span></td>
      <td><span class="dot" style="background:${colorOf(p.group, groupNames.indexOf(p.group))}"></span>${p.group}</td></tr>`)
    .join('') || '<tr><td colspan="5" class="empty">Нічого не знайдено</td></tr>';
  document.getElementById('table-count').textContent = `(${list.length})`;
  document.querySelectorAll('#student-table th').forEach((th) => {
    th.classList.toggle('sorted', th.dataset.key === state.sortKey);
    th.dataset.dir = state.sortDir > 0 ? '▲' : '▼';
  });
}

// ---------- Узгоджене оновлення всіх блоків ----------
function render() {
  const rows = filtered();
  renderKpi(rows);
  renderCharts(rows);
  renderMap();
  renderTable(rows);
}
render();
