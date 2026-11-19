// Crew dashboard: fetches the JSON API and renders tiles, ship map, charts and tables. No build step.
const $ = (s) => document.querySelector(s);
const api = async (path) => {
  const res = await fetch('/api/' + path);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const nf = (n, d = 0) => Number(n).toLocaleString('pl-PL', { minimumFractionDigits: d, maximumFractionDigits: d });
const time = (iso) => iso ? new Date(iso).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' }) : '–';
const ago = (iso) => {
  if (!iso) return '–';
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  return m < 1 ? 'przed chwilą' : m < 60 ? `${m} min temu` : `${Math.floor(m / 60)} h ${m % 60} min temu`;
};

// occupancy buckets (% of safe capacity) -> sequential blue steps
const BUCKETS = [
  { max: 0, label: 'pusto' },
  { max: 25, label: '≤ 25%' },
  { max: 50, label: '≤ 50%' },
  { max: 70, label: '≤ 70%' },
  { max: 99.9, label: '< 100%' },
  { max: Infinity, label: '≥ 100%' },
];
const bucket = (occ) => BUCKETS.findIndex((b) => occ <= b.max);
const status = (occ) => occ >= 100 ? ['critical', 'Przekroczone'] : occ >= 70 ? ['warning', 'Wysokie'] : ['good', 'OK'];

let rooms = [], crew = [], sort = { key: 'code', asc: true };

/* ---------- tooltip ---------- */
const tip = $('#tooltip');
function showTip(e, html) {
  tip.innerHTML = html; tip.hidden = false;
  const r = tip.getBoundingClientRect();
  let x = e.clientX + 14, y = e.clientY + 14;
  if (x + r.width > innerWidth - 8) x = e.clientX - r.width - 14;
  if (y + r.height > innerHeight - 8) y = e.clientY - r.height - 14;
  tip.style.left = x + 'px'; tip.style.top = y + 'px';
}
const hideTip = () => { tip.hidden = true; };
const row = (k, v) => `<div class="tt-row"><span>${k}</span><span>${v}</span></div>`;
function bindTip(el, html) {
  el.addEventListener('mousemove', (e) => showTip(e, html()));
  el.addEventListener('mouseleave', hideTip);
}

/* ---------- tiles ---------- */
function renderTiles(s, al) {
  const busiest = [...rooms].sort((a, b) => b.occupancy - a.occupancy)[0];
  const staffOk = al.staffing.filter((x) => !x.active || x.status === 'good').length;
  const tiles = [
    ['Załoga na pokładzie', `${s.onboard} / ${s.crew}`, `${s.ashore} os. na lądzie lub poza systemem`],
    ['Obsada stanowisk', `${staffOk} / ${al.staffing.length}`, staffOk === al.staffing.length ? 'wszystkie obsadzone' : `${al.staffing.length - staffOk} bez wymaganej obsady`],
    ['Sami w strefie niebezp.', al.lone.length, al.counts.lone.critical + al.counts.lone.warning ? `${al.counts.lone.critical + al.counts.lone.warning} ponad ${al.limits.loneWarnMin} min` : 'brak ostrzeżeń'],
    ['Długo bez odbicia', al.counts.lastCheckin.critical + al.counts.lastCheckin.warning, `w tym ${al.counts.lastCheckin.critical} alarm`],
    ['Największe obłożenie', busiest ? `${nf(busiest.occupancy)}%` : '–', busiest ? `${busiest.name} (${busiest.people}/${busiest.capacity})` : ''],
    ['Odbicia w 24 h', nf(s.checkins24h), `ostatnie: ${ago(s.lastCheckin)}`],
  ];
  $('#tiles').innerHTML = tiles.map(([l, v, sub]) =>
    `<div class="tile"><div class="label">${l}</div><div class="value">${esc(v)}</div><div class="sub">${esc(sub)}</div></div>`).join('');
}

/* ---------- ship map ---------- */
function renderMap() {
  const decks = [...new Set(rooms.map((r) => r.deck))].sort((a, b) => b - a);
  $('#shipMap').innerHTML = decks.map((d) => {
    const list = rooms.filter((r) => r.deck === d);
    const people = list.reduce((a, r) => a + r.people, 0);
    return `<div class="deck">
      <div class="deck-name"><div><b>Pokład ${d}</b>${esc(list[0].deck_name)} · ${people} os.</div></div>
      <div class="deck-rooms">${list.map((r) => {
        const b = bucket(r.occupancy);
        return `<button class="room${r.restricted ? ' restricted' : ''}" data-id="${r.id}"
          style="flex-grow:${Math.sqrt(r.area_m2)};background:var(--d${b});color:var(--dt${b})"
          aria-label="${esc(r.name)}: ${r.people} osób">
          <span class="rn">${esc(r.name)}</span><span class="rc">${r.people} os. · ${esc(r.code)}</span></button>`;
      }).join('')}</div></div>`;
  }).join('');
  for (const el of document.querySelectorAll('.room')) {
    const r = rooms.find((x) => x.id === Number(el.dataset.id));
    bindTip(el, () => `<b>${esc(r.name)}</b>${row('Rola', esc(r.role))}${row('Osoby', `${r.people} / ${r.capacity}`)}
      ${row('Obłożenie', nf(r.occupancy) + '%')}${row('Powierzchnia', nf(r.area_m2) + ' m²')}`);
    el.addEventListener('click', () => openRoom(r.id));
  }
  $('#occLegend').innerHTML = '<span>Obłożenie:</span>' + BUCKETS.map((b, i) =>
    `<span class="item"><span class="sw" style="background:var(--d${i})"></span>${b.label}</span>`).join('');
}

/* ---------- people by room role ---------- */
function renderRoles() {
  const by = {};
  for (const r of rooms) {
    by[r.role] ??= { people: 0, capacity: 0, count: 0 };
    Object.assign(by[r.role], { people: by[r.role].people + r.people, capacity: by[r.role].capacity + r.capacity, count: by[r.role].count + 1 });
  }
  const list = Object.entries(by).sort((a, b) => b[1].people - a[1].people);
  const max = Math.max(1, ...list.map(([, v]) => v.people));
  $('#roleChart').innerHTML = list.map(([role, v], i) =>
    `<div class="hbar" data-i="${i}"><span>${esc(role)}</span>
      <div class="track"><div class="fill" style="width:${(v.people / max) * 100}%"></div></div>
      <span class="v">${v.people} os.</span></div>`).join('');
  document.querySelectorAll('#roleChart .hbar').forEach((el) => {
    const [role, v] = list[Number(el.dataset.i)];
    bindTip(el, () => `<b>${esc(role)}</b>${row('Pomieszczeń', v.count)}${row('Osoby', `${v.people} / ${v.capacity}`)}
      ${row('Obłożenie', nf((v.people / v.capacity) * 100) + '%')}`);
  });
}

/* ---------- activity per hour ---------- */
function renderActivity(buckets) {
  const max = Math.max(1, ...buckets.map((b) => b.count));
  const top = Math.ceil(max / 10) * 10;
  const ticks = [top, top / 2, 0];
  $('#activityChart').innerHTML = `<div class="yaxis">${ticks.map((t) => `<span>${t}</span>`).join('')}</div>
    <div class="plot">${ticks.slice(0, 2).map((t) => `<div class="gridline" style="bottom:${(t / top) * 100}%"></div>`).join('')}
    ${buckets.map((b, i) => `<div class="col" data-i="${i}"><div class="bar" style="height:${(b.count / top) * 100}%"></div>
      ${i % 4 === 0 ? `<span class="tick">${time(b.start)}</span>` : ''}</div>`).join('')}</div>`;
  document.querySelectorAll('#activityChart .col').forEach((el) => {
    const b = buckets[Number(el.dataset.i)];
    const end = new Date(Date.parse(b.start) + 3600_000).toISOString();
    bindTip(el, () => `<b>${time(b.start)}–${time(end)}</b>${row('Odbicia', b.count)}`);
  });
}

/* ---------- room table ---------- */
function renderRoomTable() {
  const q = $('#roomFilter').value.toLowerCase();
  const list = rooms.filter((r) => (r.name + ' ' + r.role + ' ' + r.code).toLowerCase().includes(q))
    .sort((a, b) => {
      const x = a[sort.key], y = b[sort.key];
      const c = typeof x === 'number' ? x - y : String(x).localeCompare(String(y), 'pl');
      return sort.asc ? c : -c;
    });
  $('#roomTable tbody').innerHTML = list.map((r) => {
    const [cls, label] = status(r.occupancy);
    return `<tr data-id="${r.id}">
      <td>${esc(r.code)}</td><td>${esc(r.name)}${r.restricted ? ' 🔒' : ''}</td><td>${esc(r.role)}</td>
      <td class="num">${r.deck}</td><td class="num">${nf(r.area_m2)}</td><td class="num">${r.capacity}</td>
      <td class="num"><b>${r.people}</b></td>
      <td><div class="occ"><div class="track"><div class="fill" style="width:${Math.min(100, r.occupancy)}%"></div></div>
        <span class="pct">${nf(r.occupancy)}%</span><span class="status ${cls}"><span class="dot"></span>${label}</span></div></td>
      <td class="num">${r.checkins_24h}</td></tr>`;
  }).join('');
  document.querySelectorAll('#roomTable th').forEach((th) => {
    th.classList.toggle('sorted', th.dataset.sort === sort.key);
    th.classList.toggle('asc', th.dataset.sort === sort.key && sort.asc);
  });
}
$('#roomTable thead').addEventListener('click', (e) => {
  const key = e.target.closest('th')?.dataset.sort;
  if (!key) return;
  sort = { key, asc: sort.key === key ? !sort.asc : !['people', 'occupancy', 'checkins_24h', 'area_m2', 'capacity'].includes(key) };
  renderRoomTable();
});
$('#roomTable tbody').addEventListener('click', (e) => {
  const tr = e.target.closest('tr');
  if (tr) openRoom(Number(tr.dataset.id));
});
$('#roomFilter').addEventListener('input', renderRoomTable);

/* ---------- room detail ---------- */
async function openRoom(id) {
  const r = await api('rooms/' + id);
  const [cls, label] = status(r.occupancy);
  $('#roomDetail').innerHTML = `<h2>${esc(r.name)} <span class="muted">${esc(r.code)}</span></h2>
    <p class="muted">${esc(r.role)} · Pokład ${r.deck} (${esc(r.deck_name)})${r.restricted ? ' · tylko upoważnieni 🔒' : ''}<br>${esc(r.description)}</p>
    <div class="facts">
      <div><span>Osoby teraz</span><b>${r.people} / ${r.capacity}</b></div>
      <div><span>Obłożenie</span><b>${nf(r.occupancy)}%</b> <span class="status ${cls}"><span class="dot"></span>${label}</span></div>      <div><span>Powierzchnia</span><b>${nf(r.area_m2)} m²</b></div>
      <div><span>Terminale</span><b>${r.terminals}</b></div>
      <div><span>Odbicia 24 h</span><b>${r.checkins_24h}</b></div>
    </div>
    ${r.crew.length ? `<table><thead><tr><th>Imię i nazwisko</th><th>Stanowisko</th><th>Wachta</th><th>Od</th></tr></thead><tbody>
      ${r.crew.map((c) => `<tr><td>${esc(c.first_name)} ${esc(c.last_name)}</td><td>${esc(c.rank)}</td><td>${esc(c.shift)}</td><td>${time(c.since)}</td></tr>`).join('')}
      </tbody></table>` : '<p class="muted">Nikogo tu teraz nie ma.</p>'}`;
  if (!$('#roomDialog').open) $('#roomDialog').showModal();
}

/* ---------- crew ---------- */
async function loadCrew() {
  crew = await api('crew?q=' + encodeURIComponent($('#crewFilter').value));
  $('#crewTable tbody').innerHTML = crew.map((c) => `<tr>
    <td>${esc(c.badge)}</td><td><b>${esc(c.first_name)} ${esc(c.last_name)}</b></td><td>${esc(c.rank)}</td>
    <td>${esc(c.department)}</td><td>${esc(c.shift)}</td>
    <td>${c.room_name ? esc(c.room_name) : '<span class="ashore">poza statkiem / wyszedł</span>'}</td>
    <td title="${esc(c.since)}">${ago(c.since)}</td><td>${esc(c.nationality)}</td><td>${esc(c.birth_date)}</td>
    <td class="num">${esc(c.phone_ext)}</td><td>${esc(c.cabin)}</td></tr>`).join('');
}
let crewTimer;
$('#crewFilter').addEventListener('input', () => { clearTimeout(crewTimer); crewTimer = setTimeout(loadCrew, 200); });

/* ---------- staffing, lone workers, last check-in ---------- */
const dur = (min) => min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min`;
const badge = (st, label) => `<span class="status ${st}${st === 'critical' ? ' strong' : ''}"><span class="dot"></span>${label}</span>`;
let staleAll = false, lastAlerts = null;

function renderAlerts(a) {
  lastAlerts = a;
  const L = a.limits;
  $('#staffing').innerHTML = a.staffing.map((s) => {
    const st = s.active ? s.status : 'neutral';
    const label = !s.active ? `Poza godzinami (${s.staff_hours})` : s.status === 'good' ? 'Pełna obsada' : s.people === 0 ? 'Brak obsady' : 'Niedobór';
    const since = s.understaffed_all_day ? 'od ponad 24 h'
      : s.understaffed_since ? `od ${time(s.understaffed_since)} (${dur(Math.floor((Date.now() - Date.parse(s.understaffed_since)) / 60000))})` : '';
    return `<div class="station ${s.active ? s.status : ''}">
      <div class="head"><b>${esc(s.name)}</b>${badge(st, label)}</div>
      <div class="count">${s.people} <span>/ wymagane ${s.min_staff}${s.staff_hours !== '00-24' ? ` · godz. ${esc(s.staff_hours)}` : ' · całą dobę'}</span></div>
      <div class="who">${since ? `<b>${since}</b> · ` : ''}${s.crew.length ? s.crew.map((c) => `${esc(c.name)} (${esc(c.rank)})`).join(', ') : 'nikogo nie ma'}</div>
      <div class="cov"><div class="track"><div class="fill" style="width:${s.coverage_24h}%"></div></div><span>${nf(s.coverage_24h, 1)}% doby z pełną obsadą</span></div>
    </div>`;
  }).join('');

  $('#loneNote').textContent = `Ktoś jest sam w maszynowni, warsztacie, pompowni lub chłodni. Ostrzeżenie po ${L.loneWarnMin} min, alarm po ${L.loneCritMin} min.`;
  $('#lone').innerHTML = a.lone.length ? a.lone.map((x) => `<div class="lone-item">
      <div><b>${esc(x.crew.name)}</b> <span class="sub">${esc(x.crew.rank)}</span><div class="sub">${esc(x.name)} · pokład ${x.deck} · sam od ${time(x.since)}</div></div>
      <div><div class="t">${dur(x.minutes)}</div>${badge(x.status, x.status === 'critical' ? 'Alarm' : x.status === 'warning' ? 'Sprawdź' : 'OK')}</div>
    </div>`).join('') : '<p class="empty">✓ Nikt nie pracuje teraz sam w strefie niebezpiecznej.</p>';

  $('#staleNote').textContent = `Ostrzeżenie po ${L.staleWarnH} h bez odbicia (we własnej kabinie po ${L.cabinWarnH} h), alarm po ${L.staleCritH} h (w kabinie po ${L.cabinCritH} h). Może to oznaczać zgubioną kartę albo osobę, którą trzeba sprawdzić.`;
  const rows = staleAll ? a.lastCheckin : a.lastCheckin.filter((x, i) => x.status === 'critical' || x.status === 'warning' || i < 8);
  $('#staleTable tbody').innerHTML = rows.map((x) => `<tr>
    <td><b>${esc(x.name)}</b> <span class="muted">${esc(x.rank)}</span></td>
    <td>${x.ashore ? '<span class="ashore">wyszedł / na lądzie</span>' : x.room ? esc(x.room) + (x.in_cabin ? ' (kabina)' : '') : '–'}</td>
    <td class="num">${x.hours === null ? 'nigdy' : nf(x.hours, 1)}</td>
    <td>${badge(x.status, { critical: 'Alarm', warning: 'Sprawdź', good: 'OK', neutral: 'Poza statkiem' }[x.status])}</td></tr>`).join('');
  $('#staleMore').textContent = staleAll ? 'Pokaż mniej' : `Pokaż wszystkich (${a.lastCheckin.length})`;

  const n = ['staffing', 'lone', 'lastCheckin'].reduce((s, k) => s + a.counts[k].critical + a.counts[k].warning, 0);
  $('#alertBadge').hidden = !n;
  $('#alertBadge').textContent = n;
}
$('#staleMore').addEventListener('click', () => { staleAll = !staleAll; if (lastAlerts) renderAlerts(lastAlerts); });

/* ---------- tabs, refresh ---------- */
// The dashboard is read-only: check-ins come only from the physical terminals (POST /api/checkin).
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.tabs button').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
  document.querySelectorAll('.tab').forEach((t) => { t.hidden = t.id !== 'tab-' + b.dataset.tab; });
}));

async function refresh() {
  try {
    const [s, r, a, al] = await Promise.all([api('summary'), api('rooms'), api('activity'), api('alerts')]);
    rooms = r;
    renderTiles(s, al); renderAlerts(al); renderMap(); renderRoles(); renderActivity(a); renderRoomTable();
    await loadCrew();
    $('#updated').textContent = `Stan na ${new Date().toLocaleTimeString('pl-PL')} · odświeża się co 5 s`;
  } catch (err) {
    $('#updated').textContent = 'Brak połączenia z serwerem: ' + err.message;
  }
}
$('#refresh').addEventListener('click', refresh);

refresh();
setInterval(refresh, 5000);
