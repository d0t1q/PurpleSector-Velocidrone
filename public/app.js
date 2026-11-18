import { lineChart, barChart, trackMap, speedColour } from './charts.js';

// ---------- helpers ----------

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const r3 = (x) => Math.round(x * 1000) / 1000;
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const stdev = (a) => {
  if (a.length < 2) return null;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};
const minOf = (a) => {
  let m = null;
  for (const v of a) if (v != null && (m == null || v < m)) m = v;
  return m;
};
const median = (a) => {
  const s = a.filter((v) => v != null).sort((x, y) => x - y);
  if (!s.length) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const sumAll = (a) => (a && a.length && a.every((v) => v != null) ? r3(a.reduce((x, y) => x + y, 0)) : null);
// Every time is shown in plain seconds (a 3-lap race is 86.795, not 1:26.795).
const fmtT = (t, dp = 3) => (t == null || !Number.isFinite(t) ? '—' : t.toFixed(dp));
const fmtRun = (t) => (t == null ? '—' : fmtT(Math.max(0, t), 1));
const fmtD = (d, dp = 3) => (d == null || !Number.isFinite(d) ? '' : (d > 0 ? '+' : d < 0 ? '−' : '±') + Math.abs(d).toFixed(dp));
const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const when = (ms) => {
  const d = new Date(ms);
  const today = new Date();
  const y = new Date(Date.now() - 864e5);
  const day = d.toDateString() === today.toDateString() ? 'Today' : d.toDateString() === y.toDateString() ? 'Yesterday' : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return `${day} ${clock(ms)}`;
};
const PALETTE = ['#ff4d5e', '#3ea6ff', '#18d36a', '#ffd23f', '#b55cff', '#ff8a3d', '#2fd6d6', '#ff6bcb', '#a3e635', '#c4a484'];
const hash = (s) => [...String(s)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
function colourOf(c, key) {
  const m = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(String(c || ''));
  if (!m) return PALETTE[hash(key) % PALETTE.length];
  const n = parseInt(m[1], 16);
  let [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255];
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  if (lum < 0.25) [r, g, b] = [r, g, b].map((v) => Math.round(v + (255 - v) * 0.45)); // keep it visible on black
  return `rgb(${r},${g},${b})`;
}
// Purple (t-tb) = all-time personal best, green (t-pb) = best of that session, yellow = neither.
const flagClass = (s) => (!s ? '' : s.approx ? 't-approx' : s.pb ? 't-tb' : s.sb ? 't-pb' : s.sb === false ? 't-slow' : '');
const segClass = (f) => (f === 2 ? 't-tb' : f === 1 ? 't-pb' : f === 0 ? 't-slow' : '');
const hsClass = (h) => (!h ? '' : h.pb ? 't-tb' : h.sb ? 't-pb' : h.sb === false ? 't-slow' : '');
const rb = (v, best) => (v != null && best != null && v <= best ? ' rb' : '');
/** The colour key used by every timing table (scope: 'race' or 'session'). */
function colourKey(scope, gaps = false) {
  return `<div class="ckey"><b>Colours</b> show how a time compared when it was flown:
    <span><i class="sw" style="background:var(--purple)"></i>personal best (all sessions)</span>
    <span><i class="sw" style="background:var(--green)"></i>best of that session so far</span>
    <span><i class="sw" style="background:var(--yellow)"></i>slower than your session best</span>
    <span><i class="sw" style="background:var(--text)"></i>white: no comparison saved</span>
    <span class="br"></span>
    <span><u class="rbk">1.234</u> underlined: fastest in this ${scope}</span>
    <span><span class="t-approx">~1.234</span> two gates passed in one 0.1 s update: combined time, never a record</span>
    <span><span class="dim">—</span> not flown</span>
    <span><span class="badge rs">cut</span> lap cut short by a restart</span>${gaps ? `<span class="br"></span><span><span class="mono">7.206<small class="gk">+0.562</small></span> small number: gap to the fastest of that column in this ${scope}</span>` : ''}</div>`;
}
const lapClass = (l) => (!l || l.lapTime == null ? '' : l.lapPb ? 't-tb' : l.lapSb ? 't-pb' : l.lapSb === false ? 't-slow' : '');
const store = {
  get(k, d) {
    try {
      return JSON.parse(localStorage.getItem('st.' + k)) ?? d;
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem('st.' + k, JSON.stringify(v));
    } catch {}
  },
};
function splitLabel(plan, i) {
  return i === plan.gates - 1 ? `${plan.lastGate}→${plan.startGate}` : `${plan.startGate + i}→${plan.startGate + i + 1}`;
}
function sectorOfSplit(plan, i) {
  const g = i === plan.gates - 1 ? Infinity : plan.startGate + 1 + i;
  return g <= plan.ends[0] ? 0 : g <= plan.ends[1] ? 1 : 2;
}
/** Gate times of a lap, normalised to the layout (extra points past the last gate are the finish trigger). */
function normCum(cum, G) {
  if (!cum || !G) return cum || null;
  if (cum.length === G) return cum;
  if (cum.length > G) return [...cum.slice(0, G - 1), cum.at(-1)];
  return null;
}
/** Table cells for one lap's gate splits; gates merged in one update span their columns. */
function splitCells(plan, segs, cum, cls = () => '') {
  const G = plan.gates;
  const sb = (i) => (i > 0 && sectorOfSplit(plan, i) !== sectorOfSplit(plan, i - 1) ? ' sb' : '');
  let out = '';
  for (let i = 0; i < G; i++) {
    const v = segs?.[i];
    if (v != null || !cum) {
      out += `<td class="num ${cls(i, v)}${sb(i)}">${v != null ? v.toFixed(3) : '<span class="dim">—</span>'}</td>`;
      continue;
    }
    if (cum[i] == null) {
      let j = i;
      while (j < G && cum[j] == null) j++;
      if (j >= G) {
        for (; i < G; i++) out += `<td class="num dim${sb(i)}">—</td>`;
        break;
      }
      const prev = i === 0 ? 0 : cum[i - 1];
      const combined = prev != null ? r3(cum[j] - prev) : null;
      out += `<td class="num t-approx${sb(i)}" colspan="${j - i + 1}" title="Gates passed inside one 0.1 s update: combined time">${combined != null ? `~${combined.toFixed(3)}` : '—'}</td>`;
      i = j;
      continue;
    }
    out += `<td class="num dim${sb(i)}">—</td>`;
  }
  return out;
}
/** Gate-split table headers: sector groups over the gate columns, after `lead` sticky columns. */
function gateHeads(plan, lead) {
  const G = plan.gates;
  const counts = [0, 0, 0];
  for (let i = 0; i < G; i++) counts[sectorOfSplit(plan, i)]++;
  const sb = (i) => (i > 0 && sectorOfSplit(plan, i) !== sectorOfSplit(plan, i - 1) ? ' sb' : '');
  const blank = lead.map((c) => `<th class="stk" style="${c.style}"></th>`).join('');
  return `<tr>${blank}${counts.map((c, k) => `<th class="secgrp s${k + 1}" colspan="${c}">Sector ${k + 1}</th>`).join('')}</tr>
    <tr>${lead.map((c) => `<th class="stk${c.end ? ' stk-end' : ''} ${c.cls || ''}" style="${c.style}">${c.label}</th>`).join('')}${Array.from({ length: G }, (_, i) => `<th class="num${sb(i)}">${splitLabel(plan, i)}</th>`).join('')}</tr>`;
}
/** Gate-split table with fixed column widths, so the pinned lap columns can never overlap. */
const GATE_W = 60;
function gateTable(plan, lead, body) {
  const w = lead.reduce((a, c) => a + c.w, 0) + plan.gates * GATE_W;
  return `<table class="splits gates" style="width:${w}px;min-width:100%"><colgroup>${lead.map((c) => `<col style="width:${c.w}px">`).join('')}<col span="${plan.gates}" style="width:${GATE_W}px"></colgroup>
    <thead>${gateHeads(plan, lead)}</thead><tbody>${body}</tbody></table>`;
}
/** A sticky cell (stays visible while the gate columns scroll sideways). */
const stk = (col, html, cls = '') => `<td class="stk${col.end ? ' stk-end' : ''} ${cls}" style="${col.style}">${html}</td>`;
/** Sector / holeshot / lap cell with its gap to the best of the race or session below the time. */
function gapCell(v, cls, best, approx = false, extraCls = '') {
  if (v == null) return `<td class="num dim ${extraCls}">—</td>`;
  const g = !approx && best != null ? (v <= best ? 'best' : `+${(v - best).toFixed(3)}`) : '';
  return `<td class="num gcell ${cls} ${extraCls}"><span class="gv">${approx ? '~' : ''}${v.toFixed(3)}</span>${g ? `<small>${g}</small>` : ''}</td>`;
}

/** A lap's sectors from its gate times when they're known (exact), else as saved. */
function lapSectors(plan, l, cum) {
  if (!plan || !cum) return l.sectors || [];
  const G = plan.gates, e0 = plan.ends[0] - plan.startGate - 1, e1 = plan.ends[1] - plan.startGate - 1;
  const vals = [cum[e0], cum[e0] != null && cum[e1] != null ? cum[e1] - cum[e0] : null, cum[e1] != null && cum[G - 1] != null ? cum[G - 1] - cum[e1] : null];
  const out = vals.map((v, k) => {
    const st = l.sectors?.[k] || null;
    if (v == null) return st;
    const same = st && Math.abs(st.time - v) < 0.0006;
    return { time: r3(v), pb: same ? st.pb : false, sb: same ? st.sb : undefined, delta: same ? st.delta : null, approx: false };
  });
  while (out.length && out[out.length - 1] == null) out.pop();
  return out;
}
/** Shaded S1/S2/S3 ranges for a per-gate-split bar chart. */
function sectorGroupBands(plan) {
  const cols = ['#ff4d5e', '#3ea6ff', '#ffd23f'];
  const out = [];
  for (let i = 0; i < plan.gates; i++) {
    const k = sectorOfSplit(plan, i);
    if (out[k]) out[k].to = i;
    else out[k] = { from: i, to: i, colour: cols[k], label: `S${k + 1}` };
  }
  return out.filter(Boolean);
}
function segsOf(cum) {
  return cum ? cum.map((c, i) => (c == null ? null : i === 0 ? c : cum[i - 1] == null ? null : r3(c - cum[i - 1]))) : null;
}
function interp(xs, ys, x) {
  if (!xs?.length) return null;
  if (x <= xs[0]) return ys[0];
  if (x >= xs[xs.length - 1]) return ys[ys.length - 1];
  let lo = 0, hi = xs.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] < x) lo = mid;
    else hi = mid;
  }
  const f = (x - xs[lo]) / (xs[hi] - xs[lo] || 1);
  return ys[lo] + (ys[hi] - ys[lo]) * f;
}
async function post(path, body) {
  const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return r.ok;
}
function setHTML(el, html) {
  if (el && el._html !== html) {
    el.innerHTML = html;
    el._html = html;
  }
}

// ---------- state ----------

const S = {
  live: null,
  history: null,
  skew: 0,
  imu: false,
  tel: null,
  trace: { lap: null, pts: [] },
  trackData: new Map(), // trackId -> { version, data }
  raceTel: new Map(), // raceId -> { stamp, data }
  tab: store.get('tab', 'analysis'),
  trackSel: null,
  raceSel: null,
  pilotSel: null,
  sel: new Set(['current']), // sessions shown in the scoped tabs ('current' follows the live session)
  sessOpen: false,
  open: {}, // collapsed/expanded groups in the session trees, per tree
  del: { sessions: new Set(), tracks: new Set(), records: new Set(), recTrack: null },
  storage: null,
  scopeTrack: null,
  sessionPilot: null,
  sessionNewest: store.get('sessionNewest', false),
  lapPicks: null,
  mapMode: 'sector',
  byKey: {},
};
const raceNow = (p) => (p?.offset == null ? null : (Date.now() - S.skew - p.offset) / 1000);

// ---------- stream ----------

function connectStream() {
  const es = new EventSource('/events');
  es.addEventListener('access', (e) => {
    S.canEdit = !!JSON.parse(e.data).edit;
    document.body.classList.toggle('viewonly', !S.canEdit);
  });
  es.addEventListener('history', (e) => {
    S.history = JSON.parse(e.data);
    // Forget selections whose sessions were deleted.
    const known = new Set(S.history.sessions.map((x) => x.id));
    for (const k of [...S.sel]) if (k !== 'current' && !known.has(k)) S.sel.delete(k);
    if (!S.sel.size) S.sel.add('current');
    scheduleLower();
    ensureTrackData(S.live?.trackId);
  });
  es.addEventListener('live', (e) => {
    const prevTrack = S.live?.trackId;
    const prevSession = S.live?.sessionId;
    S.live = JSON.parse(e.data);
    S.skew = Date.now() - S.live.now;
    S.imu = !!S.live.imu;
    S.byKey = Object.fromEntries(S.live.pilots.map((p) => [p.key, p]));
    renderLive();
    if (prevTrack !== S.live.trackId) ensureTrackData(S.live.trackId);
    if (prevTrack !== S.live.trackId || prevSession !== S.live.sessionId) scheduleLower(true);
  });
  es.addEventListener('tel', (e) => onTel(JSON.parse(e.data)));
  es.addEventListener('trace', (e) => {
    // The current lap so far, sent on connect, so a page opened mid-lap has the whole trace.
    const tr = JSON.parse(e.data);
    if (tr?.pts?.length) S.trace = tr;
  });
  es.onerror = () => {
    if (S.live) {
      S.live.connected = false;
      S.live.serverDown = true;
      renderTop();
    }
  };
}

async function ensureTrackData(id) {
  if (!id || !S.history) return null;
  const t = S.history.tracks.find((x) => x.id === id);
  const version = t?.mapVersion ?? 'none';
  const cached = S.trackData.get(id);
  if (cached && (cached.version === version || cached.pending)) return cached.data;
  S.trackData.set(id, { version, data: cached?.data || null, pending: true });
  try {
    const r = await fetch(`/api/trackdata?id=${encodeURIComponent(id)}`);
    const data = r.ok ? await r.json() : null;
    S.trackData.set(id, { version, data });
  } catch {
    S.trackData.delete(id);
    return null;
  }
  if (id === S.live?.trackId) renderMap(true);
  if ((S.tab === 'track' && id === selectedTrack()?.id) || (S.tab === 'telemetry' && id === scopeRace()?.trackId)) renderLower();
  return S.trackData.get(id).data;
}
const trackDataOf = (id) => S.trackData.get(id)?.data || null;

// ---------- live: top bar ----------

function leader() {
  return S.live?.pilots.find((p) => p.offset != null) || null;
}

function renderTop() {
  const L = S.live;
  if (!L) return;
  const nameEl = $('trackName');
  if (L.trackName) {
    const guess = L.trackGuessed ? `<span class="guess" title="The game hasn't named this track yet, so this is the last track flown. It's checked against the gate layout after the first lap.">?</span>` : '';
    setHTML(nameEl, `${esc(L.trackName)}${guess}`);
  } else setHTML(nameEl, !L.connected ? 'Waiting for Velocidrone…' : L.onMap ? 'Fly a lap to identify the track' : 'No map loaded');
  const plan = L.plan;
  const bits = [];
  if (L.sceneryTitle) bits.push(esc(L.sceneryTitle));
  if (plan) bits.push(`${plan.gates} gates`, `<span class="s1">S1</span> ${plan.startGate}→${plan.ends[0]}`, `<span class="s2">S2</span> ${plan.ends[0]}→${plan.ends[1]}`, `<span class="s3">S3</span> ${plan.ends[1]}→finish`);
  else if (L.trackId) bits.push('gate layout learned after the first lap');
  if (L.trackSource === 'game') bits.push('<span title="Read from the game\'s settings">track from game</span>');
  setHTML($('trackSub'), bits.join(' · '));

  let race = '';
  if (L.countdown != null && Number(L.countdown) > 0 && L.raceStatus !== 'running') race += `<div class="countdown">${esc(L.countdown)}</div>`;
  if (L.raceId) {
    const lead = L.pilots[0];
    const lapNow = lead ? (lead.finished ? L.raceLaps || lead.lapsDone : lead.current?.lap ?? lead.lap) : null;
    const st = { running: 'Live', finished: 'Finished', aborted: 'Aborted' }[L.raceStatus] || L.raceStatus;
    race += `<div><div class="label">Race</div><div class="val">${L.raceNo ?? ''}</div></div>`;
    race += `<span class="status-pill ${esc(L.raceStatus)}">${esc(st)}</span>`;
    if (lapNow) race += `<div><div class="label">Lap</div><div class="val num">${lapNow}${L.raceLaps ? `<span class="dim">/${L.raceLaps}</span>` : ''}</div></div>`;
    race += `<div><div class="label">Race time</div><div class="clock" id="raceClock">—</div></div>`;
  }
  setHTML($('raceBox'), race);
  const vd = L.serverDown ? '<span><i class="dot"></i>Timer not running</span>' : L.connected ? '<span><i class="dot ok"></i>Velocidrone</span>' : '<span><i class="dot wait"></i>Waiting for game</span>';
  const imu = S.imu ? '<span><i class="dot ok"></i>Telemetry</span>' : '<span title="Turn on WebSocket IMU in Velocidrone Main Settings"><i class="dot"></i>Telemetry off</span>';
  const view = S.canEdit === false ? '<span title="Changes can only be made on the PC running the timer"><i class="dot wait"></i>View only</span>' : '';
  setHTML($('connBox'), vd + imu + view);
}

// ---------- live: timing tower ----------

function renderTower() {
  const L = S.live;
  const plan = L.plan;
  const ps = L.pilots;
  const multi = ps.length > 1;
  const hint = !L.connected ? '' : !ps.length ? (L.raceStatus === 'running' ? 'Race started, waiting for the first gate…' : 'Waiting for a race to start…') : '';
  setHTML($('towerHint'), esc(hint));
  setHTML($('towerMeta'), L.localKey ? `You: ${esc(S.byKey[L.localKey]?.name || L.localKey)}` : '');
  const head = `<thead><tr><th class="c">Pos</th><th>Pilot</th><th class="num">Gap</th><th class="num">Int</th><th class="c">Lap</th><th class="num">Time</th><th class="num">HS</th><th>S1</th><th>S2</th><th>S3</th><th>Gate splits</th><th class="num">Δ PB</th><th class="num">Last</th><th class="num">Best</th></tr></thead>`;
  if (!ps.length) {
    setHTML($('tower'), `${head}<tbody><tr><td colspan="14" class="empty">${L.connected ? 'No pilots yet.' : 'Not connected to Velocidrone. Is the game running with WebSocket on in Main Settings?'}</td></tr></tbody>`);
    return;
  }
  const rows = ps.map((p, i) => {
    const cur = p.current && !p.current.partial ? p.current : null;
    const live = cur && !cur.closed && !p.finished;
    const shown = live ? cur : p.last && !p.last.partial ? p.last : null;
    const gap = i === 0 ? (multi ? 'Leader' : '') : p.gapLaps > 0 ? `+${p.gapLaps} lap${p.gapLaps > 1 ? 's' : ''}` : fmtD(p.gap);
    const int = i === 0 ? '' : p.intervalLaps > 0 ? `+${p.intervalLaps} lap${p.intervalLaps > 1 ? 's' : ''}` : fmtD(p.interval);
    const lap = p.finished ? 'FIN' : p.current ? `${p.current.lap}${L.raceLaps ? `<span class="dim">/${L.raceLaps}</span>` : ''}` : '–';
    let time = '<td class="num clock">—</td>';
    if (p.finished && p.totalTime != null) time = `<td class="num clock fin">${fmtT(p.totalTime)}</td>`;
    else if (live && L.raceStatus === 'running') time = `<td class="num clock" data-lapclock="${esc(p.key)}">—</td>`;
    else if (p.current?.partial) time = '<td class="num clock dim" title="Seen mid-lap: timed from the next lap">out lap</td>';
    const hs = p.holeshot ? `<td class="num ${hsClass(p.holeshot)}" title="${p.holeshot.delta != null ? `${fmtD(p.holeshot.delta)} vs PB` : ''}">${fmtT(p.holeshot.time)}</td>` : '<td class="num dim">—</td>';
    const secs = [0, 1, 2]
      .map((k) => {
        const s = shown?.sectors?.[k];
        if (s) return `<td class="sec"><div class="t ${flagClass(s)}">${s.approx ? '~' : ''}${s.time.toFixed(3)}</div><div class="d">${s.delta != null ? fmtD(s.delta) : s.pb ? 'first' : ''}</div></td>`;
        if (live && shown && k === shown.sectors.length && L.raceStatus === 'running') return `<td class="sec running"><div class="t" data-secclock="${esc(p.key)}">—</div><div class="d">${p.best?.sectors?.[k] != null ? `PB ${p.best.sectors[k].toFixed(3)}` : ''}</div></td>`;
        return '<td class="sec pending"><div class="t">—</div><div class="d"></div></td>';
      })
      .join('');
    let minis = '';
    if (plan && shown) {
      const cum = shown.cum || [];
      const flags = shown.segFlags || [];
      for (let k = 0; k < plan.gates; k++) {
        const startOfSector = k > 0 && sectorOfSplit(plan, k) !== sectorOfSplit(plan, k - 1);
        let cls = '';
        if (cum[k] != null) cls = flags[k] === 2 ? 'f2' : flags[k] === 1 ? 'f1' : flags[k] === 0 ? 'f0' : 'fx';
        else if (live && k === (shown.lastIdx ?? -1) + 1) cls = 'now';
        else if (flags[k] === null && cum[k + 1] != null) cls = 'fx';
        minis += `<i class="${cls}${startOfSector ? ' gap-s' : ''}" title="${esc(splitLabel(plan, k))}"></i>`;
      }
    }
    let delta = '<td class="num dim">—</td>';
    if (live && cur.delta != null) {
      const pred = p.pbCum?.at(-1) != null ? p.pbCum.at(-1) + cur.delta : null; // delta is measured against that lap
      delta = `<td class="num"><div class="delta ${cur.delta < 0 ? 'neg' : 'pos'}">${fmtD(cur.delta)}<small>${pred != null ? `pred ${fmtT(pred)}` : ''}</small></div></td>`;
    } else if (p.last?.lapDelta != null && !p.last.partial) {
      delta = `<td class="num"><div class="delta ${p.last.lapDelta < 0 ? 'neg' : 'pos'}" style="opacity:.6">${fmtD(p.last.lapDelta)}<small>last lap</small></div></td>`;
    }
    const last = p.last && !p.last.partial && p.last.lapTime != null ? `<td class="num ${lapClass(p.last)}">${fmtT(p.last.lapTime)}</td>` : '<td class="num dim">—</td>';
    const best = p.raceBest != null ? `<td class="num"><span class="${segClass(p.raceBestFlag)}">${fmtT(p.raceBest)}</span><div class="d dim" style="font-size:11px">${p.best?.lap != null ? `PB ${fmtT(p.best.lap)}` : ''}</div></td>` : `<td class="num dim">${p.best?.lap != null ? `PB ${fmtT(p.best.lap)}` : '—'}</td>`;
    return `<tr class="${p.key === L.localKey ? 'me' : ''}">
      <td class="pos ${p.rank === 1 ? 'p1' : ''}">${p.rank ?? '–'}</td>
      <td><div class="pilot pname"><span class="swatch" style="background:${colourOf(p.colour, p.key)}"></span>${esc(p.name)}</div></td>
      <td class="num gap">${gap}</td><td class="num gap">${int}</td>
      <td class="c num">${lap}</td>${time}${hs}${secs}
      <td><div class="minis">${minis}</div></td>${delta}${last}${best}</tr>`;
  });
  setHTML($('tower'), `${head}<tbody>${rows.join('')}</tbody>`);
}

// ---------- live: feed ----------

function renderFeed() {
  const tags = { trackbest: ['tb', 'TRACK BEST'], pb: ['tb', 'PB'], finish: ['fin', 'FINISH'], race: ['race', 'RACE'], layout: ['info', 'INFO'], restart: ['rs', 'RESTART'], session: ['sess', 'SESSION'] };
  const items = S.live.events.map((e) => {
    const [cls, label] = tags[e.type] || ['info', 'INFO'];
    const text = e.type === 'race' ? `Race ${raceNoOf(e.raceId) ?? ''} ${esc(e.text)}` : `${e.pilot ? `<span class="who">${esc(e.pilot)}</span> ` : ''}${esc(e.text)}`;
    return `<li><time>${new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}</time><div><span class="tag ${cls}">${label}</span>${text}</div></li>`;
  });
  setHTML($('feed'), items.join('') || '<li><time></time><div class="muted">Bests, finishes and race starts show up here.</div></li>');
}
function raceNoOf(id) {
  return S.history?.races.find((r) => r.id === id)?.no ?? null;
}

// ---------- live: map, gauges, telemetry trace ----------

let mapKey = '';
let mapH = null;
let strip = null;
function renderMap(force) {
  if (!S.live) return;
  const el = $('liveMap');
  const td = trackDataOf(S.live.trackId);
  const map = td?.map?.x?.length > 5 ? td.map : null;
  const key = `${S.live.trackId}:${map ? td.map.v : 'none'}:${el.clientWidth}:${S.live.plan?.layoutKey}:${S.imu}`;
  if (!force && key === mapKey) return;
  mapKey = key;
  if (!S.live.trackId) {
    mapH = strip = null;
    el.innerHTML = `<div class="empty" style="height:160px;display:grid;place-content:center">${S.live.connected ? 'No map loaded' : 'Waiting for Velocidrone…'}<small>The track appears when you load a map in the game.</small></div>`;
    setHTML($('mapHint'), '');
    return;
  }
  if (map) {
    mapH = trackMap(el, { map, plan: S.live.plan, mode: 'sector', height: 300 });
    strip = null;
  } else {
    mapH = null;
    strip = buildStrip(el);
  }
  setHTML($('mapHint'), !S.imu ? 'Turn on <b>WebSocket IMU</b> in Main Settings for the live map' : !map ? 'Map appears after your first full lap' : `map: ${esc(td.map.pilot || '')} ${fmtT(td.map.lapTime)}`);
}
function buildStrip(el) {
  const plan = S.live.plan;
  const W = Math.max(200, el.clientWidth || 380);
  const H = 92, x0 = 22, x1 = W - 22, y = 50;
  if (!plan) {
    el.innerHTML = `<div class="empty" style="height:${H}px">Track position shows once the gate layout is known.</div>`;
    return null;
  }
  const xs = (f) => x0 + (x1 - x0) * f;
  let svg = `<svg width="${W}" height="${H}"><line x1="${x0}" x2="${x1}" y1="${y}" y2="${y}" stroke="#2a2f39" stroke-width="8" stroke-linecap="round"/>`;
  const cols = ['var(--s1)', 'var(--s2)', 'var(--s3)'];
  const cut = [0, ...plan.ends.map((g) => (g - plan.startGate) / plan.gates), 1];
  for (let s = 0; s < 3; s++) svg += `<line x1="${xs(cut[s])}" x2="${xs(cut[s + 1])}" y1="${y}" y2="${y}" stroke="${cols[s]}" stroke-width="3"/>`;
  for (let i = 0; i <= plan.gates; i++) {
    const g = i === plan.gates ? plan.startGate : plan.startGate + i;
    svg += `<line x1="${xs(i / plan.gates)}" x2="${xs(i / plan.gates)}" y1="${y - 7}" y2="${y + 7}" stroke="#9aa3b2"/><text x="${xs(i / plan.gates)}" y="${y + 22}" fill="#5d6574" font-size="10" text-anchor="middle" font-family="var(--mono)">${g}</text>`;
  }
  svg += `<g class="dots"></g></svg>`;
  el.innerHTML = svg;
  const layer = el.querySelector('.dots');
  const dots = new Map();
  return {
    place(id, f, colour, label) {
      let g = dots.get(id);
      if (!g) {
        g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        g.innerHTML = `<circle r="7" stroke="#fff" stroke-width="2"/><text y="-12" fill="#fff" font-size="11" font-weight="700" text-anchor="middle" font-family="var(--sans)"></text>`;
        layer.appendChild(g);
        dots.set(id, g);
      }
      g.querySelector('circle').setAttribute('fill', colour);
      g.querySelector('text').textContent = label;
      g.setAttribute('transform', `translate(${xs(Math.max(0, Math.min(1, f))).toFixed(1)},${y})`);
    },
    keep(ids) {
      for (const [id, g] of dots) if (!ids.has(id)) {
        g.remove();
        dots.delete(id);
      }
    },
  };
}

/** Where a pilot is in the lap (timing-point units, 0..G), estimated from their last gate. */
function lapProgress(p) {
  const L = S.live;
  const plan = L.plan;
  const cur = p.current;
  if (!plan || !cur || cur.partial || cur.closed || p.finished || L.raceStatus !== 'running') return null;
  const now = raceNow(p);
  if (now == null) return null;
  const idx = cur.lastIdx ?? -1;
  const next = idx + 1;
  if (next >= plan.gates) return plan.gates - 0.02;
  const exp = p.segBest?.[next] ?? L.trackBest?.segs?.[next] ?? (p.best?.lap ?? 30) / plan.gates;
  const f = Math.max(0, Math.min(0.97, (now - cur.lastT) / (exp * 1.03)));
  return idx + 1 + f;
}

function updateDots() {
  if (!S.live) return;
  const L = S.live;
  const ids = new Set();
  for (const p of L.pilots) {
    const colour = colourOf(p.colour, p.key);
    const prog = lapProgress(p);
    if (mapH) {
      if (p.key === L.localKey && S.imu && S.tel) {
        mapH.place(p.key, S.tel.x, S.tel.z, colour, p.name);
        ids.add(p.key);
      } else if (prog != null) {
        const ki = (i) => (i <= 0 ? 0 : i >= L.plan.gates ? mapH.n - 1 : mapH.gateK.get(i - 1) ?? Math.round((i / L.plan.gates) * (mapH.n - 1)));
        const a = Math.floor(prog);
        const kA = ki(a), kB = ki(a + 1);
        mapH.placeAt(p.key, kA + (kB - kA) * (prog - a), colour, p.name);
        ids.add(p.key);
      }
    } else if (strip && prog != null) {
      strip.place(p.key, prog / L.plan.gates, colour, p.name);
      ids.add(p.key);
    }
  }
  if (mapH && S.imu && S.tel && L.localKey && !ids.has(L.localKey)) {
    mapH.place(L.localKey || 'me', S.tel.x, S.tel.z, colourOf(S.byKey[L.localKey]?.colour, L.localKey), S.byKey[L.localKey]?.name || 'You');
    ids.add(L.localKey || 'me');
  }
  (mapH || strip)?.keep(ids);
}

function renderGauges() {
  const f = S.imu ? S.tel : null;
  const g = (label, v, unit, frac, colour) =>
    `<div class="gauge"><div class="label">${label}</div><div class="v">${v}<small>${unit}</small></div><div class="bar"><i style="width:${Math.round(Math.max(0, Math.min(1, frac || 0)) * 100)}%;background:${colour}"></i></div></div>`;
  const kmh = f ? f.v * 3.6 : null;
  $('gauges').innerHTML =
    g('Speed', kmh != null ? Math.round(kmh) : '—', 'km/h', kmh / 160, speedColour((kmh || 0) / 150)) +
    g('G-force', f ? f.g.toFixed(1) : '—', 'G', f ? f.g / 6 : 0, 'var(--orange)') +
    g('Altitude', f ? f.y.toFixed(1) : '—', 'm', f ? f.y / 40 : 0, 'var(--blue)') +
    g('Top speed', f?.top != null ? Math.round(f.top * 3.6) : '—', 'km/h lap', f?.top ? (f.top * 3.6) / 160 : 0, 'var(--red)');
}

function onTel(f) {
  S.tel = f;
  S.imu = true;
  if (f.lap != null && f.lt != null) {
    const pts = S.trace.pts;
    if (S.trace.lap !== f.lap || (pts.length && f.lt < pts[pts.length - 1].t - 0.3)) {
      S.trace = { lap: f.lap, pts: [] };
    }
    S.trace.pts.push({ t: f.lt, d: f.ld, v: f.v });
  }
  renderGauges();
  scheduleTrace();
}

let traceTimer = null;
function scheduleTrace() {
  if (traceTimer) return;
  traceTimer = setTimeout(() => {
    traceTimer = null;
    renderTrace();
  }, 200);
}

function renderTrace() {
  const L = S.live;
  if (!L) return;
  const key = L.localKey;
  const ref = trackDataOf(L.trackId)?.refs?.[key];
  const pts = S.trace.pts;
  const me = S.byKey[key];
  const colour = colourOf(me?.colour, key || 'me');
  if (!S.imu && !pts.length) {
    setHTML($('traceHint'), 'Turn on <b>WebSocket IMU</b> in Velocidrone → Main Settings to see speed, G and a live delta to your PB lap.');
    $('speedTrace').innerHTML = '';
    $('deltaTrace').innerHTML = '';
    setHTML($('traceKeys'), '');
    return;
  }
  const done = me?.finished;
  setHTML($('traceHint'), done ? `Finished · final lap ${S.trace.lap ?? ''} vs ${ref ? `PB ${fmtT(ref.lapTime)}` : 'PB'} · telemetry paused until the next race` : S.trace.lap ? `Lap ${S.trace.lap} vs ${ref ? `PB ${fmtT(ref.lapTime)}` : 'your PB (after a full lap)'}` : 'Waiting for a lap to start…');
  setHTML($('traceKeys'), `<span><i style="background:${colour}"></i>This lap</span>${ref ? '<span><i style="background:#8892a3"></i>PB lap</span>' : ''}`);
  const plan = L.plan;
  const bands = [];
  if (ref && plan) {
    const dAt = (gate) => ref.gates.find((g) => g.i === gate - plan.startGate - 1)?.d;
    const cuts = [0, dAt(plan.ends[0]), dAt(plan.ends[1]), ref.dist];
    const cols = ['#ff4d5e', '#3ea6ff', '#ffd23f'];
    for (let s = 0; s < 3; s++) if (cuts[s] != null && cuts[s + 1] != null) bands.push({ x0: cuts[s], x1: cuts[s + 1], colour: cols[s], label: `S${s + 1}`, opacity: 0.05 });
  }
  const xMax = Math.max(ref?.dist || 0, pts.at(-1)?.d || 0, 10);
  const series = [];
  if (ref) series.push({ name: 'PB lap', colour: '#8892a3', width: 1.5, points: ref.d.map((d, i) => [d, ref.v[i] * 3.6]) });
  series.push({ name: 'This lap', colour, width: 2.2, points: pts.map((p) => [p.d, p.v * 3.6]) });
  lineChart($('speedTrace'), { height: 200, series, xMin: 0, xMax, yMin: 0, bands, yFmt: (v) => `${Math.round(v)}`, xFmt: (v) => `${Math.round(v)} m`, tipTitle: (x) => `${Math.round(x)} m`, tipFmt: (v) => `${Math.round(v)} km/h`, emptyText: 'Speed trace appears when the lap starts.' });
  if (ref && pts.length) {
    const dpts = pts.map((p) => [p.d, r3(p.t - interp(ref.d, ref.t, p.d))]);
    const lastD = dpts.at(-1)[1];
    lineChart($('deltaTrace'), { height: 130, series: [{ name: 'Δ to PB', colour: lastD <= 0 ? '#18d36a' : '#ff5d5d', points: dpts, area: true, width: 2 }], xMin: 0, xMax, zero: true, bands, yFmt: (v) => fmtD(v, 2), xFmt: (v) => `${Math.round(v)} m`, tipTitle: (x) => `${Math.round(x)} m`, tipFmt: (v) => `${fmtD(v)} s` });
  } else {
    $('deltaTrace').innerHTML = ref ? '' : '<div class="empty">Live delta needs a PB lap with telemetry: fly one full lap with WebSocket IMU on.</div>';
  }
}

function renderLive() {
  renderTop();
  renderTower();
  renderFeed();
  renderMap(false);
  renderGauges();
  scheduleTrace();
}

// ---------- the clock loop ----------

function tick() {
  const L = S.live;
  if (L && L.raceStatus === 'running') {
    for (const el of document.querySelectorAll('[data-lapclock]')) {
      const p = S.byKey[el.dataset.lapclock];
      const now = raceNow(p);
      if (now != null && p.current) el.textContent = fmtRun(now - p.current.start);
    }
    for (const el of document.querySelectorAll('[data-secclock]')) {
      const p = S.byKey[el.dataset.secclock];
      const now = raceNow(p);
      if (now == null || !p.current) continue;
      const done = (p.current.sectors || []).reduce((a, s) => a + s.time, 0);
      el.textContent = fmtRun(now - p.current.start - done);
    }
  }
  const rc = $('raceClock');
  if (rc && L) {
    const lead = L.pilots[0];
    if (lead?.finished && lead.totalTime != null) rc.textContent = fmtT(lead.totalTime);
    else if (L.raceStatus === 'running') {
      const p = leader();
      const now = raceNow(p);
      rc.textContent = now != null ? fmtRun(now) : '—';
    }
  }
  updateDots();
  requestAnimationFrame(tick);
}

// ---------- lower section: selection ----------

function selectedTrack() {
  if (!S.history) return null;
  const id = S.trackSel || S.live?.trackId || S.history.tracks[0]?.id;
  return S.history.tracks.find((t) => t.id === id) || S.history.tracks[0] || null;
}
const racesOf = (trackId) => (S.history?.races || []).filter((r) => r.trackId === trackId);
function selectedRace(track) {
  if (!track) return null;
  const rs = racesOf(track.id);
  return rs.find((r) => r.id === S.raceSel) || rs[0] || null;
}

function raceModel(race, track) {
  const plan = track?.plan || null;
  const G = plan?.gates || 0;
  const pilots = race.pilots.map((e, idx) => {
    const laps = [...e.laps].sort((a, b) => a.lap - b.lap).map((l) => {
      const cum = normCum(l.cum, G);
      return { ...l, cum, segs: segsOf(cum), sectors: lapSectors(plan, l, cum) };
    });
    const done = laps.filter((l) => l.lapTime != null);
    const times = done.map((l) => l.lapTime);
    const best = minOf(times);
    const segBest = G ? Array.from({ length: G }, (_, i) => minOf(laps.map((l) => l.segs?.[i]))) : null;
    const secBest = [0, 1, 2].map((k) => minOf(laps.map((l) => (l.sectors?.[k] && !l.sectors[k].approx ? l.sectors[k].time : null))));
    const ends = laps.filter((l) => l.end != null);
    return {
      ...e, idx, colour: colourOf(e.colour, e.key), laps, done, best,
      bestLap: done.find((l) => l.lapTime === best) || null,
      avg: mean(times), sd: stdev(times), segBest, ideal: sumAll(segBest), secBest,
      lastEnd: e.finished ? e.totalTime : ends.at(-1)?.end ?? null,
    };
  });
  const cls = [...pilots].sort((a, b) => (b.finished - a.finished) || (a.finished ? a.totalTime - b.totalTime : b.done.length - a.done.length || (a.lastEnd ?? 1e9) - (b.lastEnd ?? 1e9)));
  // Laps per race: as set, but never fewer than were actually flown (keeps every lap on the charts).
  const raceLaps = Math.max(race.raceLaps || 0, 1, ...pilots.flatMap((p) => p.laps.map((l) => l.lap)));
  return {
    race, plan, G, pilots, cls, raceLaps,
    fastest: minOf(pilots.map((p) => p.best)),
    raceSegBest: G ? Array.from({ length: G }, (_, i) => minOf(pilots.map((p) => p.segBest?.[i]))) : null,
    raceSecBest: [0, 1, 2].map((k) => minOf(pilots.map((p) => p.secBest[k]))),
    hsBest: minOf(pilots.map((p) => p.holeshot?.time)),
  };
}

function statusBadge(p, race) {
  if (p.finished) return `<span class="badge finished">P${p.position ?? ''} Fin</span>`;
  if (p.stopped === 'restart') return `<span class="badge rs">Restarted L${p.stoppedLap ?? ''}</span>`;
  if (p.stopped === 'aborted' || race.status === 'aborted') return '<span class="badge aborted">Aborted</span>';
  if (p.stopped) return `<span class="badge rs">Stopped L${p.stoppedLap ?? ''}</span>`;
  if (race.status === 'running' && race.id === S.live?.raceId) return '<span class="badge running">Racing</span>';
  return '<span class="badge">DNF</span>';
}

function previousResult(race, key) {
  const rs = racesOf(race.trackId);
  const i = rs.findIndex((r) => r.id === race.id);
  for (const r of rs.slice(i + 1)) {
    if (r.raceLaps !== race.raceLaps) continue;
    const p = r.pilots.find((x) => x.key === key);
    if (p?.finished && p.totalTime != null) return { no: r.no, time: p.totalTime, label: r.sessionId === race.sessionId ? `R${r.no}` : when(r.startedAt) };
  }
  return null;
}

// ---------- lower section: rendering ----------

// The Session / Race analysis / Gate splits / Telemetry tabs show the selected sessions (default:
// the current one, so a fresh timer start or a new map starts clean). Records and Track are all-time.
const SCOPED = ['session', 'analysis', 'splits', 'telemetry'];

function selIds() {
  const ids = new Set();
  for (const k of S.sel) {
    if (k === 'current') {
      if (S.live?.sessionId != null) ids.add(S.live.sessionId);
    } else ids.add(k);
  }
  return ids;
}
const selRaces = () => {
  const ids = selIds();
  return (S.history?.races || []).filter((r) => ids.has(r.sessionId));
};
const trackById = (id) => S.history?.tracks.find((t) => t.id === id) || null;
function selTracks() {
  const ids = [];
  if (S.sel.has('current') && S.live?.trackId) ids.push(S.live.trackId);
  for (const r of selRaces()) if (r.trackId && !ids.includes(r.trackId)) ids.push(r.trackId);
  return ids.map(trackById).filter(Boolean);
}
function scopeTrack() {
  const ts = selTracks();
  return ts.find((t) => t.id === S.scopeTrack) || ts[0] || null;
}
function scopeRace() {
  const rs = selRaces();
  return rs.find((r) => r.id === S.raceSel) || rs[0] || null;
}

const END_REASON = { 'game closed': 'game closed', 'left map': 'left the map', 'new map': 'map reloaded', 'changed track': 'changed track', 'timer stopped': 'timer stopped', 'ended by you': 'ended by you', imported: '' };

function sessionPickerLabel() {
  const only = S.sel.size === 1 && S.sel.has('current');
  if (only) {
    const cur = S.history.sessions.find((x) => x.current);
    return `<span class="dim">Session</span> <b>Current</b> <span class="muted">${cur ? `since ${clock(cur.startedAt)} · ${cur.laps} lap${cur.laps === 1 ? '' : 's'}` : 'fresh'}</span> ▾`;
  }
  const n = selIds().size;
  return `<span class="dim">Sessions</span> <b>${n} selected</b> <span class="muted">${selRaces().length} races</span> ▾`;
}

// ---------- session tree (picker + data management) ----------

function dayLabel(ms) {
  const d = new Date(ms);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === new Date(Date.now() - 864e5).toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', ...(d.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}) });
}
const fmtBytes = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : b >= 1024 ? `${Math.round(b / 1024)} KB` : `${b || 0} B`);

/** Past sessions grouped by map, then by day; maps ordered by most recent use. */
function groupSessions(list) {
  const tracks = new Map();
  for (const s of list) {
    let t = tracks.get(s.trackId);
    if (!t) tracks.set(s.trackId, (t = { id: s.trackId, name: s.trackName, sessions: [], days: new Map(), last: 0 }));
    t.sessions.push(s);
    t.last = Math.max(t.last, s.startedAt);
    const dk = new Date(s.startedAt).toDateString();
    let d = t.days.get(dk);
    if (!d) t.days.set(dk, (d = { key: dk, label: dayLabel(s.startedAt), sessions: [] }));
    d.sessions.push(s);
  }
  return [...tracks.values()].sort((x, y) => y.last - x.last);
}

function isOpen(ns, key, dflt) {
  const v = S.open[ns]?.[key];
  return v == null ? dflt : v;
}

/**
 * Collapsible map → day → session checklist. ns namespaces the data attributes; sel is the Set of
 * selected session ids; extra(s) adds text to a session row.
 */
function sessionTree(ns, groups, sel, extra = () => '') {
  const sumLaps = (ss) => ss.reduce((a, x) => a + x.laps, 0);
  const bestOf = (ss) => minOf(ss.map((x) => x.best));
  const groupBox = (ids) => {
    const n = ids.filter((id) => sel.has(id)).length;
    return `<input type="checkbox" data-${ns}-group="${ids.join(',')}" ${n && n === ids.length ? 'checked' : ''} ${n && n < ids.length ? 'data-indet="1"' : ''} title="Select all">`;
  };
  const openTrack = S.live?.trackId || groups[0]?.id;
  let html = '';
  for (const t of groups) {
    const tk = `t:${t.id}`;
    const open = isOpen(ns, tk, t.id === openTrack);
    const best = bestOf(t.sessions);
    html += `<div class="tg"><div class="tg-head lvl1">${groupBox(t.sessions.map((x) => x.id))}
      <button class="tg-name" data-${ns}-toggle="${esc(tk)}"><i class="caret${open ? ' open' : ''}"></i><b>${esc(t.name)}</b>
      <span>${t.sessions.length} session${t.sessions.length === 1 ? '' : 's'} · ${sumLaps(t.sessions)} laps${best != null ? ` · best ${fmtT(best)}` : ''}</span></button></div>`;
    if (open) {
      [...t.days.values()].forEach((d, di) => {
        const dk = `d:${t.id}:${d.key}`;
        const dOpen = isOpen(ns, dk, di === 0);
        html += `<div class="tg-head lvl2">${groupBox(d.sessions.map((x) => x.id))}
          <button class="tg-name" data-${ns}-toggle="${esc(dk)}"><i class="caret${dOpen ? ' open' : ''}"></i><b>${esc(d.label)}</b>
          <span>${d.sessions.length} session${d.sessions.length === 1 ? '' : 's'} · ${sumLaps(d.sessions)} laps</span></button></div>`;
        if (dOpen) {
          for (const x of d.sessions) {
            const on = sel.has(x.id);
            const reason = END_REASON[x.endReason] ? ` · ${END_REASON[x.endReason]}` : '';
            html += `<label class="srow lvl3${on ? ' on' : ''}"><input type="checkbox" data-${ns}-sess="${x.id}" ${on ? 'checked' : ''}>
              <span class="st"><b>${clock(x.startedAt)} – ${x.endedAt ? clock(x.endedAt) : 'now'}</b>
              <span>${x.races} race${x.races === 1 ? '' : 's'} · ${x.laps} lap${x.laps === 1 ? '' : 's'}${x.best != null ? ` · best ${fmtT(x.best)}` : ''}${reason}${extra(x)}</span></span></label>`;
          }
        }
      });
    }
    html += '</div>';
  }
  return html || '<div class="empty" style="padding:16px">No earlier sessions yet.</div>';
}
function applyIndeterminate(root) {
  for (const el of root.querySelectorAll('[data-indet]')) el.indeterminate = true;
}

/** Keep the dropdown on screen: below the button, or above it when there's more room there. */
function placeSessPanel() {
  const panel = $('sessPanel');
  if (panel.hidden) return;
  const r = $('sessBtn').getBoundingClientRect();
  const margin = 10;
  const below = innerHeight - r.bottom - margin;
  const above = r.top - 64 - margin; // stay clear of the sticky top bar
  const up = below < 360 && above > below;
  const room = Math.max(160, up ? above : below);
  panel.style.left = `${Math.max(8, Math.min(r.left, innerWidth - panel.offsetWidth - 8))}px`;
  panel.style.top = up ? '' : `${r.bottom + 6}px`;
  panel.style.bottom = up ? `${innerHeight - r.top + 6}px` : '';
  const foot = panel.querySelector('.sfoot')?.offsetHeight || 0;
  panel.querySelector('.slist').style.maxHeight = `${room - foot - 8}px`;
}

function renderSessionPanel() {
  const panel = $('sessPanel');
  panel.hidden = !S.sessOpen;
  if (!S.sessOpen) return;
  const cur = S.history.sessions.find((x) => x.current);
  const pastSel = new Set([...S.sel].filter((k) => k !== 'current'));
  const curOn = S.sel.has('current');
  let html = `<label class="srow cur${curOn ? ' on' : ''}"><input type="checkbox" data-pick-sess="current" ${curOn ? 'checked' : ''}>
    <span class="st"><b>Current session</b><span>${cur ? `${esc(cur.trackName)} · since ${clock(cur.startedAt)} · ${cur.races} race${cur.races === 1 ? '' : 's'} · ${cur.laps} laps` : `${esc(S.live?.trackName || 'No map loaded')} · starts with your next race`}</span></span></label>`;
  html += `<div class="sday">Earlier sessions</div>${sessionTree('pick', groupSessions(S.history.sessions.filter((x) => !x.current)), pastSel)}`;
  const t = scopeTrack() || trackById(S.live?.trackId);
  const keepScroll = panel.querySelector('.slist')?.scrollTop || 0;
  panel.innerHTML = `<div class="slist">${html}</div>
    <div class="sfoot"><button data-sessact="current">Current only</button>${t ? `<button data-sessact="track">All on ${esc(t.name)}</button>` : ''}<span class="sp" style="flex:1"></span><button class="ghost" data-sessact="manage">Manage data →</button></div>`;
  applyIndeterminate(panel);
  panel.querySelector('.slist').scrollTop = keepScroll;
  placeSessPanel();
}

// History arrives often while racing. Redraw the lower section at most about once a second, never
// while you're in the middle of something (a delete armed, typing a name), and keep sideways scroll.
let lowerTimer = null;
function lowerBusy() {
  const a = document.activeElement;
  return !!document.querySelector('#tabBody .armed, #raceBar .armed, #renameBox.open') || (a && $('tabBody').contains(a) && (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && a.type === 'text')));
}
function scheduleLower(soon = !S.lowerDrawn) {
  if (lowerTimer) return;
  lowerTimer = setTimeout(function run() {
    if (lowerBusy()) {
      lowerTimer = setTimeout(run, 500);
      return;
    }
    lowerTimer = null;
    renderLower();
  }, soon ? 30 : 1000);
}
function renderLower() {
  const body = $('tabBody');
  const keep = [...body.querySelectorAll('.scroll')].map((e) => e.scrollLeft);
  const tab = S.tab;
  drawLower();
  if (tab === S.lowerTab) [...body.querySelectorAll('.scroll')].forEach((e, i) => keep[i] && (e.scrollLeft = keep[i]));
  S.lowerTab = tab;
  S.lowerDrawn = !!S.history;
}

function drawLower() {
  if (!S.history) return;
  for (const b of $('tabs').children) b.setAttribute('aria-selected', String(b.dataset.tab === S.tab));
  const scoped = SCOPED.includes(S.tab);
  $('trackCtl').style.display = scoped || S.tab === 'data' ? 'none' : '';
  $('sessPick').style.display = scoped ? '' : 'none';
  const body = $('tabBody');
  if (S.tab === 'data') {
    $('raceBar').style.display = 'none';
    S.sessOpen = false;
    renderSessionPanel();
    return renderData(body);
  }

  if (!scoped) {
    const track = selectedTrack();
    setHTML($('trackSel'), S.history.tracks.map((t) => `<option value="${esc(t.id)}" ${t.id === track?.id ? 'selected' : ''}>${esc(t.name)}${t.id === S.live?.trackId ? ' (live)' : ''}</option>`).join('') || '<option>No tracks yet</option>');
    $('raceBar').style.display = 'none';
    if (!track) {
      body.innerHTML = '<div class="empty">No tracks recorded yet. Fly a lap!</div>';
      return;
    }
    return S.tab === 'records' ? renderRecords(body, track) : renderTrackTab(body, track);
  }

  setHTML($('sessBtn'), sessionPickerLabel());
  renderSessionPanel();
  const races = selRaces();
  const multiSess = selIds().size > 1;
  if (S.tab === 'session') {
    const ts = selTracks();
    const t = scopeTrack();
    setHTML($('raceBar'), ts.length > 1 ? `<div class="racelist">${ts.map((x) => `<button data-scopetrack="${esc(x.id)}" aria-pressed="${x.id === t?.id}"><b>${esc(x.name)}</b><span class="muted">${races.filter((r) => r.trackId === x.id).length} races</span></button>`).join('')}</div>` : '');
    $('raceBar').style.display = ts.length > 1 ? '' : 'none';
    return renderSession(body, t, races.filter((r) => r.trackId === t?.id).reverse());
  }
  const race = scopeRace();
  const chips = races
    .slice(0, 80)
    .map((r) => {
      const isLive = r.id === S.live?.raceId && r.status === 'running';
      const win = [...r.pilots].filter((p) => p.finished).sort((a, b) => a.totalTime - b.totalTime)[0];
      const sum = win ? `${esc(win.name)} ${fmtT(win.totalTime)}` : `${r.pilots.length} pilot${r.pilots.length === 1 ? '' : 's'}`;
      return `<button data-race="${r.id}" aria-pressed="${r.id === race?.id}">${isLive ? '<i class="live-dot"></i>' : ''}<b>Race ${r.no}</b><span class="dim">${multiSess ? when(r.startedAt) : clock(r.startedAt)}</span><span class="muted">${sum}</span></button>`;
    })
    .join('');
  setHTML($('raceBar'), races.length ? `<div class="racelist">${chips}</div><span class="sp" style="flex:1"></span>${race ? `<button class="danger" data-arm="delete-race" data-id="${race.id}">Delete race ${race.no}</button>` : ''}` : '<span class="muted">No races in this session yet.</span>');
  $('raceBar').style.display = '';
  if (!race) {
    body.innerHTML = emptySession();
    return;
  }
  const track = trackById(race.trackId);
  if (!track) {
    body.innerHTML = '<div class="empty">This race\'s track was deleted.</div>';
    return;
  }
  if (S.tab === 'analysis') return renderAnalysis(body, track, race);
  if (S.tab === 'splits') return renderSplits(body, track, race);
  return renderTelemetry(body, track, race);
}

function emptySession() {
  const only = S.sel.size === 1 && S.sel.has('current');
  return only
    ? `<div class="empty"><b>Fresh session${S.live?.trackName ? ` on ${esc(S.live.trackName)}` : ''}.</b> Every lap you fly from now on shows up here.<small>Looking for earlier laps? Open the Session menu above and tick a previous session.</small></div>`
    : '<div class="empty">No races in the selected sessions.</div>';
}

function renderAnalysis(body, track, race) {
  if (!race) {
    body.innerHTML = '<div class="empty">No races on this track yet.</div>';
    return;
  }
  const M = raceModel(race, track);
  const multi = M.pilots.length > 1;
  const win = M.cls[0];
  const fastestP = M.fastest != null ? M.pilots.find((p) => p.best === M.fastest) : null;
  const hsP = M.hsBest != null ? M.pilots.find((p) => p.holeshot?.time === M.hsBest) : null;
  const rec = minOf(track.records.map((r) => r.bestLap));
  const recP = rec != null ? track.records.find((r) => r.bestLap === rec) : null;
  const ideal = sumAll(M.raceSegBest);
  const stat = (label, v, sub) => `<div class="stat"><div class="label">${label}</div><div class="v">${v}${sub ? `<small>${sub}</small>` : ''}</div></div>`;
  let html = `<div class="stat-row">
    ${stat(win?.finished ? 'Winner' : race.status === 'running' ? 'Leading' : 'Top', win ? esc(win.name) : '—', win?.finished ? fmtT(win.totalTime) : '')}
    ${stat('Fastest lap', fmtT(M.fastest), fastestP ? `${esc(fastestP.name)} · L${fastestP.bestLap?.lap}` : '')}
    ${stat('Best holeshot', fmtT(M.hsBest), hsP ? esc(hsP.name) : '')}
    ${stat('Ideal lap', fmtT(ideal), 'best gate splits combined')}
    ${stat('Track record', fmtT(rec), recP ? esc(recP.name) : '')}
    ${stat('Started', clock(race.startedAt), `${M.raceLaps} lap${M.raceLaps === 1 ? '' : 's'}${race.sessionName ? ` · ${esc(race.sessionName)}` : ''}`)}
  </div>`;

  // Classification
  const rows = M.cls.map((p, i) => {
    const gap = i === 0 ? '' : p.finished && win.finished ? fmtD(p.totalTime - win.totalTime) : p.done.length < win.done.length ? `+${win.done.length - p.done.length} lap${win.done.length - p.done.length > 1 ? 's' : ''}` : '';
    const prev = p.finished ? previousResult(race, p.key) : null;
    const pd = prev ? r3(p.totalTime - prev.time) : null;
    return `<tr><td class="c num">${i + 1}</td><td><div class="pilot"><span class="swatch" style="background:${p.colour}"></span>${esc(p.name)}</div></td>
      <td>${statusBadge(p, race)}</td><td class="num">${p.done.length}${p.laps.some((l) => l.incomplete) ? '<span class="dim">+½</span>' : ''}</td>
      <td class="num">${p.finished ? fmtT(p.totalTime) : '—'}</td><td class="num muted">${gap}</td>
      <td class="num ${hsClass(p.holeshot)}">${fmtT(p.holeshot?.time)}</td>
      <td class="num ${p.bestLap ? lapClass(p.bestLap) : ''}">${fmtT(p.best)}${p.bestLap ? ` <span class="dim">L${p.bestLap.lap}</span>` : ''}</td>
      <td class="num">${fmtT(p.avg)}</td><td class="num muted">${p.sd != null ? '±' + p.sd.toFixed(3) : '—'}</td>
      <td class="num">${fmtT(p.ideal)}</td>
      <td class="num ${pd == null ? '' : pd < 0 ? 'faster' : 'slower'}">${pd != null ? `${fmtD(pd)} <span class="dim">vs ${prev.label}</span>` : '—'}</td></tr>`;
  });
  html += `<div class="card"><h3>Classification</h3><div class="scroll"><table class="class"><thead><tr><th class="c">Pos</th><th>Pilot</th><th>Status</th><th class="num">Laps</th><th class="num">Race time</th><th class="num">Gap</th><th class="num">Holeshot</th><th class="num">Best lap</th><th class="num">Average</th><th class="num">Consistency</th><th class="num">Ideal</th><th class="num">vs last race</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>
    <div class="ckey">Holeshot and best lap, as flown: <span><i class="sw" style="background:var(--purple)"></i>personal best (all sessions)</span><span><i class="sw" style="background:var(--green)"></i>session best</span><span><i class="sw" style="background:var(--yellow)"></i>slower than session best</span><span><i class="sw" style="background:var(--text)"></i>no comparison</span>
      <span class="br"></span>vs last race (same lap count): <span class="faster">green = faster</span><span class="slower">yellow = slower</span> · Consistency = spread of lap times (±1 standard deviation) · Ideal = best gate splits of this race added up</div></div>`;

  const keyRow = (ps) => `<div class="keys">${ps.map((p) => `<span><i style="background:${p.colour}"></i>${esc(p.name)}</span>`).join('')}</div>`;
  const pilotKeys = M.pilots.map((p) => p.key);
  if (!pilotKeys.includes(S.pilotSel)) S.pilotSel = pilotKeys.includes(S.live?.localKey) ? S.live.localKey : win?.key;
  const pilotSelect = `<select data-pilotsel>${M.cls.map((p) => `<option value="${esc(p.key)}" ${p.key === S.pilotSel ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>`;
  const sp = M.pilots.find((p) => p.key === S.pilotSel) || win;
  html += `<div class="cards">
    <div class="card"><h3>Lap times</h3><div class="chart" id="chLaps"></div>${keyRow(M.pilots)}</div>
    ${multi ? `<div class="card"><h3>Race trace <span class="dim" style="text-transform:none;letter-spacing:0">gap to leader at every gate</span></h3><div class="chart" id="chTrace"></div>${keyRow(M.pilots)}</div>` : ''}
    ${multi ? `<div class="card"><h3>Positions</h3><div class="chart" id="chPos"></div>${keyRow(M.pilots)}</div>` : ''}
    <div class="card"><h3>Lap comparison <span class="sp"></span>${pilotSelect}</h3><div class="chart" id="chLapCmp"></div><div class="keys" id="kLapCmp"></div></div>
    <div class="card wide"><h3>Time lost per gate <span class="dim" style="text-transform:none;letter-spacing:0">average vs own best split this race</span><span class="sp"></span>${pilotSelect}</h3><div class="chart" id="chLoss"></div><div class="keys"><span><i style="background:var(--s1)"></i>S1</span><span><i style="background:var(--s2)"></i>S2</span><span><i style="background:var(--s3)"></i>S3</span>${sp?.ideal != null && sp.best != null ? `<span>best lap ${fmtT(sp.best)} vs ideal ${fmtT(sp.ideal)} (${fmtD(sp.best - sp.ideal)})</span>` : ''}</div></div>
    <div class="card"><h3>Gap to track best <span class="dim" style="text-transform:none;letter-spacing:0">best of this race vs all-time track best</span></h3><div class="chart" id="chSec"></div>${keyRow(M.pilots)}</div>
    ${M.pilots.some((p) => p.done.length > 1) ? `<div class="card"><h3>Consistency <span class="dim" style="text-transform:none;letter-spacing:0">every lap, with average</span></h3><div class="chart" id="chCons"></div>${keyRow(M.pilots)}</div>` : ''}
  </div>`;
  body.innerHTML = html;

  // Lap times
  const lapTicks = Array.from({ length: M.raceLaps }, (_, i) => ({ v: i + 1, label: `L${i + 1}` }));
  lineChart($('chLaps'), {
    height: 210,
    series: M.pilots.map((p) => ({ name: p.name, colour: p.colour, markers: true, points: p.done.map((l) => [l.lap, l.lapTime]) })),
    xMin: 0.8, xMax: Math.max(M.raceLaps, 1.2) + 0.2, xTicks: lapTicks, yFmt: (v) => fmtT(v, 1), tipFmt: (v) => fmtT(v), tipTitle: (x) => `Lap ${Math.round(x)}`,
    emptyText: 'No completed laps.',
  });

  // Race trace: gap to the first pilot through each timing point.
  if (multi && M.G) {
    const at = new Map(); // key "L:i" -> min time
    const pts = M.pilots.map((p) => {
      const list = [];
      if (p.holeshot) list.push([0, p.holeshot.time]);
      for (const l of p.laps) {
        (l.cum || []).forEach((c, i) => {
          if (c != null) list.push([l.lap - 1 + (i + 1) / M.G, l.start + c]);
        });
      }
      for (const [x, t] of list) {
        const k = x.toFixed(4);
        at.set(k, Math.min(at.get(k) ?? Infinity, t));
      }
      return list;
    });
    lineChart($('chTrace'), {
      height: 210, invertY: true, zero: true,
      series: M.pilots.map((p, i) => ({ name: p.name, colour: p.colour, points: pts[i].map(([x, t]) => [x, r3(t - at.get(x.toFixed(4)))]) })),
      xMin: 0, xMax: M.raceLaps, xTicks: Array.from({ length: M.raceLaps + 1 }, (_, i) => ({ v: i, label: i === 0 ? 'HS' : `L${i}` })),
      yFmt: (v) => (v === 0 ? '0' : `+${v.toFixed(1)}`), tipFmt: (v) => (v === 0 ? 'leader' : `+${v.toFixed(3)}`),
      tipTitle: (x) => {
        if (x <= 0) return 'Holeshot';
        const lap = Math.ceil(x - 1e-6);
        const i = Math.round((x - (lap - 1)) * M.G) - 1;
        return `Lap ${lap} · gate ${i >= M.G - 1 ? 'finish' : M.plan.startGate + 1 + i}`;
      },
    });
  }

  // Positions after the holeshot and each lap.
  if (multi) {
    const series = M.pilots.map((p) => ({ name: p.name, colour: p.colour, markers: true, points: [] }));
    const rank = (vals) => {
      const order = vals.map((v, i) => [v, i]).filter((x) => x[0] != null).sort((a, b) => a[0] - b[0]);
      const out = Array(vals.length).fill(null);
      order.forEach(([, i], n) => (out[i] = n + 1));
      return out;
    };
    const hs = rank(M.pilots.map((p) => p.holeshot?.time ?? null));
    hs.forEach((r, i) => r != null && series[i].points.push([0, r]));
    for (let L = 1; L <= M.raceLaps; L++) {
      const rk = rank(M.pilots.map((p) => p.laps.find((l) => l.lap === L && l.end != null)?.end ?? null));
      rk.forEach((r, i) => r != null && series[i].points.push([L, r]));
    }
    lineChart($('chPos'), {
      height: 210, invertY: true, yMin: 0.6, yMax: M.pilots.length + 0.4, series,
      xMin: 0, xMax: M.raceLaps, xTicks: Array.from({ length: M.raceLaps + 1 }, (_, i) => ({ v: i, label: i === 0 ? 'HS' : `L${i}` })),
      yFmt: (v) => (Number.isInteger(v) ? `P${v}` : ''), tipFmt: (v) => `P${v}`, tipTitle: (x) => (x === 0 ? 'After holeshot' : `End of lap ${x}`),
    });
  }

  // Lap comparison for one pilot: each lap vs their best lap, gate by gate.
  if (sp && M.G) {
    const ref = sp.bestLap;
    const shades = ['#3ea6ff', '#ffd23f', '#ff8a3d', '#ff4d5e', '#b55cff', '#2fd6d6', '#a3e635', '#ff6bcb'];
    const series = sp.laps
      .filter((l) => l !== ref && l.cum && ref?.cum)
      .map((l, n) => ({ name: `Lap ${l.lap}${l.incomplete ? ' (cut short)' : ''}`, colour: shades[n % shades.length], markers: true, points: [[0, 0], ...l.cum.map((c, i) => [i + 1, c != null && ref.cum[i] != null ? r3(c - ref.cum[i]) : null])] }));
    if (ref) series.unshift({ name: `Lap ${ref.lap} (best)`, colour: '#8892a3', dash: '4 3', points: [[0, 0], [M.G, 0]], noTip: true });
    lineChart($('chLapCmp'), {
      height: 210, zero: true, series, xMin: 0, xMax: M.G,
      xTicks: Array.from({ length: M.G + 1 }, (_, i) => ({ v: i, label: i === 0 ? String(M.plan.startGate) : i === M.G ? 'F' : String(M.plan.startGate + i) })),
      bands: sectorBands(M.plan, (i) => i),
      yFmt: (v) => fmtD(v, 2), tipFmt: (v) => fmtD(v), tipTitle: (x) => (x === 0 ? 'Start' : `Gate ${x === M.G ? 'finish' : M.plan.startGate + x}`),
      emptyText: sp.laps.length < 2 ? 'Needs two laps or more.' : 'No gate times for these laps.',
    });
    $('kLapCmp').innerHTML = series.map((s) => `<span><i style="background:${s.colour}"></i>${esc(s.name)}</span>`).join('');

    // Time lost per gate split
    const loss = Array.from({ length: M.G }, (_, i) => {
      const vals = sp.laps.map((l) => l.segs?.[i]).filter((v) => v != null);
      return vals.length && sp.segBest[i] != null ? r3(mean(vals) - sp.segBest[i]) : null;
    });
    barChart($('chLoss'), {
      height: 240, groups: Array.from({ length: M.G }, (_, i) => splitLabel(M.plan, i)), bands: sectorGroupBands(M.plan),
      series: [{ name: sp.name, colour: sp.colour, colours: loss.map((_, i) => ['#ff4d5e', '#3ea6ff', '#ffd23f'][sectorOfSplit(M.plan, i)]), values: loss }],
      yFmt: (v) => v.toFixed(2), tipFmt: (v) => `+${v.toFixed(3)} s avg`, labels: (v) => `+${v.toFixed(2)}`, emptyText: 'Needs gate times.',
    });
  }

  // Sector + holeshot gaps to the track best.
  const tb = { hs: minOf(track.records.map((r) => r.hsBest)), s: [0, 1, 2].map((k) => minOf(track.records.map((r) => r.best?.[k]))) };
  barChart($('chSec'), {
    height: 190, groups: ['Holeshot', 'S1', 'S2', 'S3'],
    series: M.pilots.map((p) => ({ name: p.name, colour: p.colour, values: [p.holeshot && tb.hs != null ? r3(p.holeshot.time - tb.hs) : null, ...p.secBest.map((v, k) => (v != null && tb.s[k] != null ? r3(v - tb.s[k]) : null))] })),
    yFmt: (v) => v.toFixed(2), tipFmt: (v) => (v === 0 ? 'track best' : `+${v.toFixed(3)}`), labels: (v) => (v === 0 ? '★' : `+${v.toFixed(2)}`),
  });

  // Consistency
  if ($('chCons')) {
    const series = [];
    M.pilots.forEach((p, i) => {
      const n = p.done.length;
      series.push({ name: p.name, colour: p.colour, dots: true, points: p.done.map((l, j) => [i + 1 + (n > 1 ? (j / (n - 1) - 0.5) * 0.3 : 0), l.lapTime]), tipFmt: (v) => fmtT(v) });
      if (p.avg != null) series.push({ name: `${p.name} avg`, colour: p.colour, width: 2, opacity: 0.6, points: [[i + 0.75, p.avg], [i + 1.25, p.avg]], tipFmt: (v) => `avg ${fmtT(v)}` });
    });
    lineChart($('chCons'), {
      height: 200, series, xMin: 0.5, xMax: M.pilots.length + 0.5, xTicks: M.pilots.map((p, i) => ({ v: i + 1, label: p.name.slice(0, 12) })),
      yFmt: (v) => fmtT(v, 1), snap: false, tipRange: 0.2, tipTitle: (x) => M.pilots[Math.round(x) - 1]?.name || '',
    });
  }
}

function sectorBands(plan, xOf) {
  if (!plan) return [];
  const cut = [0, plan.ends[0] - plan.startGate, plan.ends[1] - plan.startGate, plan.gates];
  const cols = ['#ff4d5e', '#3ea6ff', '#ffd23f'];
  return [0, 1, 2].map((s) => ({ x0: xOf(cut[s]), x1: xOf(cut[s + 1]), colour: cols[s], label: `S${s + 1}`, opacity: 0.05 }));
}

function renderSplits(body, track, race) {
  if (!race) {
    body.innerHTML = '<div class="empty">No races on this track yet.</div>';
    return;
  }
  const M = raceModel(race, track);
  const plan = M.plan;
  if (!plan) {
    body.innerHTML = '<div class="empty">The gate layout is learned at the end of the first lap.</div>';
    return;
  }
  const G = plan.gates;
  // Card 1: sectors and laps, one block per pilot.
  let sec = '';
  // Card 2: every gate split, with the lap and its time pinned on the left.
  const lead = [
    { label: 'Lap', w: 96, style: 'left:0' },
    { label: 'Lap time', cls: 'num', w: 100, style: 'left:96px', end: true },
  ];
  let gates = '';
  for (const p of M.cls) {
    const recP = track.records.find((r) => r.key === p.key);
    const who = `<div class="pilot"><span class="swatch" style="background:${p.colour}"></span>${esc(p.name)} ${statusBadge(p, race)}
      <span class="muted" style="font-weight:400;margin-left:10px">best ${fmtT(p.best)} · ideal ${fmtT(p.ideal)}${p.finished ? ` · race ${fmtT(p.totalTime)}` : ''}</span></div>`;
    sec += `<tr class="pilot-head"><td colspan="8">${who}</td></tr>`;
    gates += `<tr class="pilot-head"><td colspan="${G + 2}"><div class="stick">${who}</div></td></tr>`;
    const nLaps = Math.max(M.raceLaps, p.laps.length);
    for (let L = 1; L <= nLaps; L++) {
      const l = p.laps.find((x) => x.lap === L);
      const hsTd = L === 1 && p.holeshot ? gapCell(p.holeshot.time, hsClass(p.holeshot), M.hsBest, false, rb(p.holeshot.time, M.hsBest)) : '<td class="num dim">—</td>';
      const lapNo = `L${L}${l?.incomplete ? ' <span class="badge rs">cut</span>' : ''}`;
      if (!l) {
        sec += `<tr class="blank"><td class="lapno">${lapNo}</td>${hsTd}<td class="num sb">—</td><td class="num">—</td><td class="num">—</td><td class="num sb">—</td><td class="num">—</td><td class="num">—</td></tr>`;
        gates += `<tr class="blank">${stk(lead[0], lapNo, 'lapno')}${stk(lead[1], '—', 'num')}${Array.from({ length: G }, () => '<td class="num">—</td>').join('')}</tr>`;
        continue;
      }
      const secs = [0, 1, 2].map((k) => {
        const s0 = l.sectors?.[k];
        return gapCell(s0?.time ?? null, flagClass(s0), M.raceSecBest[k], !!s0?.approx, `${k === 0 ? 'sb ' : ''}${s0 && !s0.approx ? rb(s0.time, M.raceSecBest[k]) : ''}`);
      });
      const lapTd = gapCell(l.lapTime, lapClass(l), M.fastest, false, `sb ${rb(l.lapTime, M.fastest)}`);
      const theo = l.sectors?.length === 3 && l.sectors.every((x) => !x.approx) ? r3(l.sectors.reduce((a2, x) => a2 + x.time, 0)) : null;
      sec += `<tr class="${l.incomplete ? 'inc' : ''}"><td class="lapno">${lapNo}</td>${hsTd}${secs.join('')}${lapTd}
        <td class="num ${l.lapDelta == null ? '' : l.lapDelta < 0 ? 'faster' : 'slower'}">${l.lapDelta != null ? fmtD(l.lapDelta) : ''}</td><td class="num muted">${theo != null && l.lapTime != null && Math.abs(theo - l.lapTime) > 0.0015 ? fmtT(theo) : ''}</td></tr>`;
      gates += `<tr class="${l.incomplete ? 'inc' : ''}">${stk(lead[0], lapNo, 'lapno')}${stk(lead[1], l.lapTime != null ? fmtT(l.lapTime) : '—', `num ${lapClass(l)}`)}${splitCells(plan, l.segs, l.cum, (i, v) => `${segClass(l.segFlags?.[i])}${rb(v, M.raceSegBest[i])}`)}</tr>`;
    }
    sec += `<tr class="sum"><td>Race best</td><td class="num">${fmtT(p.holeshot?.time)}</td>${p.secBest.map((v, k) => `<td class="num${k === 0 ? ' sb' : ''}">${fmtT(v)}</td>`).join('')}<td class="num sb">${fmtT(p.best)}</td><td class="num muted" colspan="2">best sectors Σ ${fmtT(sumAll(p.secBest))}</td></tr>`;
    if (recP) sec += `<tr class="sum"><td>All-time PB</td><td class="num">${fmtT(recP.hsBest)}</td>${(recP.best || []).map((v, k) => `<td class="num${k === 0 ? ' sb' : ''}">${fmtT(v)}</td>`).join('')}<td class="num sb">${fmtT(recP.bestLap)}</td><td class="num muted" colspan="2">theoretical ${fmtT(recP.theoretical)}</td></tr>`;
    gates += `<tr class="sum">${stk(lead[0], 'Race best')}${stk(lead[1], `<span class="muted">Σ</span> ${fmtT(p.ideal)}`, 'num')}${splitCells(plan, p.segBest, null)}</tr>`;
    if (recP?.segBest) gates += `<tr class="sum">${stk(lead[0], 'All-time PB')}${stk(lead[1], `<span class="muted">Σ</span> ${fmtT(recP.ultimate)}`, 'num')}${splitCells(plan, recP.segBest, null)}</tr>`;
  }
  body.innerHTML = `<div class="card"><h3>Sectors &amp; laps · Race ${race.no}</h3>${colourKey('race', true)}
      <div class="scroll"><table class="splits secs"><thead><tr><th>Lap</th><th class="num">Holeshot</th><th class="num sb">S1</th><th class="num">S2</th><th class="num">S3</th><th class="num sb">Lap</th><th class="num">vs PB</th><th class="num" title="S1+S2+S3 when it differs from the lap time">Σ sectors</th></tr></thead><tbody>${sec}</tbody></table></div></div>
    <div class="card"><h3>Gate splits · Race ${race.no}<span class="sp"></span><span class="dim" style="text-transform:none;letter-spacing:0">scroll sideways: the lap stays pinned on the left</span></h3>${colourKey('race')}
      <div class="scroll">${gateTable(plan, lead, gates)}</div></div>`;
}

async function loadRaceTel(race) {
  const stamp = race.status === 'running' ? `run:${race.pilots.reduce((a, e) => a + e.laps.length, 0)}` : 'final';
  const c = S.raceTel.get(race.id);
  if (c && c.stamp === stamp) return c.data;
  if (c?.pending === stamp) return c.data;
  S.raceTel.set(race.id, { ...(c || {}), pending: stamp });
  try {
    const data = await (await fetch(`/api/telemetry?race=${race.id}`)).json();
    S.raceTel.set(race.id, { stamp, data });
    if (S.tab === 'telemetry' && scopeRace()?.id === race.id) renderLower();
    return data;
  } catch {
    S.raceTel.delete(race.id);
    return null;
  }
}

function renderTelemetry(body, track, race) {
  if (!race) {
    body.innerHTML = '<div class="empty">No races on this track yet.</div>';
    return;
  }
  if (!race.tel) {
    body.innerHTML = `<div class="empty">No telemetry for this race.<small>Telemetry is recorded for the pilot flying on this PC when <b>WebSocket IMU</b> is on in Velocidrone's Main Settings.</small></div>`;
    return;
  }
  const c = S.raceTel.get(race.id);
  const data = c?.data;
  loadRaceTel(race);
  if (!data) {
    body.innerHTML = '<div class="empty">Loading telemetry…</div>';
    return;
  }
  const td = trackDataOf(track.id);
  ensureTrackData(track.id);
  const plan = track.plan;
  // Laps available: every lap of every pilot in this race + their PB reference lap.
  const laps = [];
  const shades = ['#3ea6ff', '#ff4d5e', '#18d36a', '#ffd23f', '#b55cff', '#ff8a3d', '#2fd6d6'];
  for (const [key, pd] of Object.entries(data)) {
    for (const lt of Object.values(pd.laps)) laps.push({ id: `${key}:${lt.lap}`, label: `${pd.name} L${lt.lap} ${lt.lapTime != null ? fmtT(lt.lapTime) : '(cut short)'}`, tel: lt, key });
    const ref = td?.refs?.[key];
    if (ref) laps.push({ id: `${key}:pb`, label: `${pd.name} PB ${fmtT(ref.lapTime)}`, tel: ref, key, pb: true });
  }
  laps.forEach((l, i) => (l.colour = l.pb ? '#8892a3' : shades[i % shades.length]));
  if (!S.lapPicks || S.lapPicks.race !== race.id || !S.lapPicks.user || !S.lapPicks.ids.some((id) => laps.find((l) => l.id === id))) {
    const done = laps.filter((l) => !l.pb && l.tel.lapTime != null).sort((a, b) => a.tel.lapTime - b.tel.lapTime);
    const ids = [done[0]?.id, laps.find((l) => l.pb)?.id].filter(Boolean);
    S.lapPicks = { race: race.id, ids: ids.length ? ids : laps.slice(0, 2).map((l) => l.id) };
  }
  const picked = S.lapPicks.ids.map((id) => laps.find((l) => l.id === id)).filter(Boolean);
  const base = picked[0];
  const pickHtml = laps.map((l) => `<label class="${S.lapPicks.ids.includes(l.id) ? 'on' : ''}"><input type="checkbox" data-lappick="${esc(l.id)}" ${S.lapPicks.ids.includes(l.id) ? 'checked' : ''}><i style="background:${l.colour}"></i>${esc(l.label)}</label>`).join('');
  body.innerHTML = `<div class="card"><div class="lap-picks">${pickHtml}</div>
    <div class="cards" style="padding:12px">
      <div class="card"><h3>Speed <span class="dim" style="text-transform:none;letter-spacing:0">km/h by distance</span></h3><div class="chart" id="tSpeed"></div></div>
      <div class="card"><h3>Delta <span class="dim" style="text-transform:none;letter-spacing:0">time vs ${base ? esc(base.label) : 'first pick'}</span></h3><div class="chart" id="tDelta"></div></div>
      <div class="card"><h3>Altitude <span class="dim" style="text-transform:none;letter-spacing:0">metres</span></h3><div class="chart" id="tAlt"></div></div>
      <div class="card"><h3>G-force</h3><div class="chart" id="tG"></div></div>
      <div class="card"><h3>Speed map <span class="dim" style="text-transform:none;letter-spacing:0">${base ? esc(base.label) : ''}</span></h3><div class="map-wrap" id="tMap"></div></div>
      <div class="card"><h3>Lap summary</h3><div class="scroll"><table><thead><tr><th>Lap</th><th class="num">Time</th><th class="num">Distance</th><th class="num">Top speed</th><th class="num">Avg speed</th><th class="num">Max G</th></tr></thead><tbody>
        ${picked.map((l) => `<tr><td><div class="pilot"><span class="swatch" style="background:${l.colour}"></span>${esc(l.label)}</div></td><td class="num">${fmtT(l.tel.lapTime)}</td><td class="num">${Math.round(l.tel.dist ?? l.tel.d.at(-1))} m</td><td class="num">${Math.round((l.tel.top ?? Math.max(...l.tel.v)) * 3.6)} km/h</td><td class="num">${l.tel.t.at(-1) ? Math.round(((l.tel.dist ?? l.tel.d.at(-1)) / l.tel.t.at(-1)) * 3.6) : '—'} km/h</td><td class="num">${l.tel.g ? Math.max(...l.tel.g).toFixed(1) : '—'}</td></tr>`).join('')}
      </tbody></table></div></div>
    </div></div>`;
  if (!picked.length) return;
  const xMax = Math.max(...picked.map((l) => l.tel.d.at(-1)));
  const bandsFor = (tel) => {
    if (!plan || !tel?.gates) return [];
    const dAt = (gate) => tel.gates.find((g) => g.i === gate - plan.startGate - 1)?.d;
    const cuts = [0, dAt(plan.ends[0]), dAt(plan.ends[1]), tel.d.at(-1)];
    const cols = ['#ff4d5e', '#3ea6ff', '#ffd23f'];
    return [0, 1, 2].filter((s) => cuts[s] != null && cuts[s + 1] != null).map((s) => ({ x0: cuts[s], x1: cuts[s + 1], colour: cols[s], label: `S${s + 1}`, opacity: 0.05 }));
  };
  const bands = bandsFor(base?.tel);
  const common = { xMin: 0, xMax, bands, xFmt: (v) => `${Math.round(v)} m`, tipTitle: (x) => `${Math.round(x)} m` };
  const series = (f) => picked.map((l) => ({ name: l.label, colour: l.colour, width: l.pb ? 1.5 : 2, dash: l.pb ? '4 3' : null, points: l.tel.d.map((d, i) => [d, f(l.tel, i)]) }));
  lineChart($('tSpeed'), { ...common, height: 200, yMin: 0, series: series((t, i) => t.v[i] * 3.6), yFmt: (v) => `${Math.round(v)}`, tipFmt: (v) => `${Math.round(v)} km/h` });
  lineChart($('tDelta'), {
    ...common, height: 200, zero: true,
    series: picked.slice(1).map((l) => ({ name: l.label, colour: l.colour, area: true, points: l.tel.d.map((d, i) => [d, r3(l.tel.t[i] - interp(base.tel.d, base.tel.t, d))]) })),
    yFmt: (v) => fmtD(v, 2), tipFmt: (v) => `${fmtD(v)} s`, emptyText: 'Pick a second lap to compare.',
  });
  lineChart($('tAlt'), { ...common, height: 170, series: series((t, i) => t.y[i]), yFmt: (v) => v.toFixed(0), tipFmt: (v) => `${v.toFixed(1)} m` });
  lineChart($('tG'), { ...common, height: 170, yMin: 0, series: series((t, i) => t.g?.[i] ?? null), yFmt: (v) => v.toFixed(0), tipFmt: (v) => `${v.toFixed(1)} G` });
  if (base) trackMap($('tMap'), { map: { x: base.tel.x, z: base.tel.z, gates: base.tel.gates }, plan, mode: 'speed', speed: base.tel.v, height: 300 });
}

// ---------- session: every lap across races ----------

/** Rolling median: a crash lap doesn't drag the trend line around. */
function rolling(vals, n) {
  return vals.map((_, i) => median(vals.slice(Math.max(0, i - n + 1), i + 1)));
}

function renderSession(body, track, sessRaces) {
  if (!track || !sessRaces.length) {
    body.innerHTML = emptySession();
    return;
  }
  const only = S.sel.size === 1 && S.sel.has('current');
  const sess = { races: sessRaces, label: only ? `current session · since ${clock(sessRaces[0].startedAt)}` : `${selIds().size} sessions · ${when(sessRaces[0].startedAt)} – ${when(sessRaces.at(-1).startedAt)}` };
  const plan = track.plan;
  const G = plan?.gates || 0;
  // Pilots in this session; default to the pilot on this PC, else whoever flew most.
  const counts = new Map();
  for (const r of sess.races) for (const e of r.pilots) counts.set(e.key, { name: e.name, colour: e.colour, n: (counts.get(e.key)?.n || 0) + e.laps.length });
  const keys = [...counts.keys()];
  if (!keys.includes(S.sessionPilot)) S.sessionPilot = keys.includes(S.live?.localKey) ? S.live.localKey : [...counts.entries()].sort((a, b) => b[1].n - a[1].n)[0]?.[0];
  const me = counts.get(S.sessionPilot);
  const colour = colourOf(me?.colour, S.sessionPilot);
  const rec = track.records.find((r) => r.key === S.sessionPilot);

  // Every lap, oldest first. With several sessions loaded, races are labelled S<n>·R<no>.
  const sessOrder = [...new Set(sess.races.map((r) => r.sessionId))];
  const multiSess = sessOrder.length > 1;
  const raceLabel = (r) => (multiSess ? `S${sessOrder.indexOf(r.sessionId) + 1}·R${r.no}` : `R${r.no}`);
  const rows = [];
  sess.races.forEach((r, ri) => {
    const e = r.pilots.find((x) => x.key === S.sessionPilot);
    if (!e) return;
    [...e.laps].sort((a, b) => a.lap - b.lap).forEach((raw, li) => {
      const cum = normCum(raw.cum, G);
      const l = { ...raw, sectors: lapSectors(plan, raw, cum) };
      rows.push({
        n: rows.length + 1, race: r, raceIdx: ri, firstOfRace: li === 0, lap: l, cum, segs: segsOf(cum),
        hs: l.lap === 1 ? e.holeshot?.time ?? null : null,
        hsObj: l.lap === 1 ? e.holeshot ?? null : null,
        sectors: (l.sectors || []).map((s) => (s && !s.approx ? s.time : null)),
        at: r.startedAt + (l.start ?? 0) * 1000,
      });
    });
  });
  const done = rows.filter((x) => x.lap.lapTime != null);
  if (!rows.length) {
    body.innerHTML = `<div class="empty">${esc(me?.name || 'This pilot')} has no laps in this period.</div>`;
    return;
  }
  const times = done.map((x) => x.lap.lapTime);
  const best = minOf(times);
  const bestRow = done.find((x) => x.lap.lapTime === best);
  const segBest = G ? Array.from({ length: G }, (_, i) => minOf(rows.map((x) => x.segs?.[i]))) : [];
  const secBest = [0, 1, 2].map((k) => minOf(rows.map((x) => x.sectors[k])));
  const hsBest = minOf(rows.map((x) => x.hs));
  const ideal = sumAll(segBest);
  // Trend window = the race length (most common lap count in these races), 2..5 laps.
  const lapCounts = sessRaces.map((r) => r.raceLaps).filter(Boolean);
  const common = lapCounts.sort((a, b) => lapCounts.filter((v) => v === b).length - lapCounts.filter((v) => v === a).length)[0];
  const W = Math.max(2, Math.min(5, common || 3));
  const k = Math.min(W, Math.floor(times.length / 2));
  const firstAvg = k >= 2 ? median(times.slice(0, k)) : null;
  const lastAvg = k >= 2 ? median(times.slice(-k)) : null;
  const trend = firstAvg != null ? r3(lastAvg - firstAvg) : null;
  const hsList = rows.map((x) => x.hs).filter((v) => v != null);

  const stat = (label, v, sub, cls = '') => `<div class="stat"><div class="label">${label}</div><div class="v ${cls}">${v}${sub ? `<small>${sub}</small>` : ''}</div></div>`;
  const pilotSel = keys.length > 1 ? `<select data-sessionpilot>${keys.map((k2) => `<option value="${esc(k2)}" ${k2 === S.sessionPilot ? 'selected' : ''}>${esc(counts.get(k2).name)}</option>`).join('')}</select>` : '';
  let html = `<div class="stat-row">
    ${stat('Laps', `${done.length}`, `${sess.races.length} race${sess.races.length === 1 ? '' : 's'}${rows.length > done.length ? ` · ${rows.length - done.length} cut short` : ''}`)}
    ${stat('Session best', fmtT(best), bestRow ? `${raceLabel(bestRow.race)} L${bestRow.lap.lap}${rec?.bestLap != null && best <= rec.bestLap ? ' · PB!' : rec?.bestLap != null ? ` · PB ${fmtT(rec.bestLap)}` : ''}` : '')}
    ${stat('Typical lap', fmtT(median(times)), times.length > 1 ? `median · avg ${fmtT(mean(times))}` : '')}
    ${stat(`First ${k} → last ${k} (median)`, trend != null ? fmtD(trend) : '—', firstAvg != null ? `${fmtT(firstAvg)} → ${fmtT(lastAvg)}` : 'needs 4+ laps', trend == null ? '' : trend < 0 ? 'faster' : 'slower')}
    ${stat('Ideal lap', fmtT(ideal), 'best gate splits this session')}
    ${stat('Holeshot', fmtT(hsBest), hsList.length > 1 ? `avg ${fmtT(mean(hsList))}` : '')}
  </div>`;

  html += `<div class="cards">
    <div class="card"><h3>Lap times <span class="dim" style="text-transform:none;letter-spacing:0">every lap, trend = ${W}-lap median</span><span class="sp"></span>${pilotSel}</h3><div class="chart" id="sLaps"></div>
      <div class="keys"><span><i style="background:${colour}"></i>lap</span><span><i style="background:#fff"></i>trend (${W}-lap median)</span>${rec?.bestLap != null ? '<span><i style="background:var(--purple)"></i>all-time PB</span>' : ''}</div></div>
    <div class="card"><h3>Sectors <span class="dim" style="text-transform:none;letter-spacing:0">trend = ${W}-lap median</span></h3><div class="chart" id="sSecs"></div>
      <div class="keys"><span><i style="background:var(--s1)"></i>S1</span><span><i style="background:var(--s2)"></i>S2</span><span><i style="background:var(--s3)"></i>S3</span></div></div>
  </div>
    ${G ? `<div class="card"><h3>Where you've improved <span class="dim" style="text-transform:none;letter-spacing:0">per gate split: last third vs first third of the session (median)</span></h3><div class="chart" id="sGain"></div>
      <div class="keys"><span><i style="background:var(--green)"></i>faster now</span><span><i style="background:#ff5d5d"></i>slower now</span><span>shaded = sector</span></div></div>` : ''}`;

  // Two cards: sectors & laps (always readable), then every gate split (pinned lap column).
  {
    const groups = [];
    for (const x of rows) {
      let g = groups.at(-1);
      if (!g || g.sid !== x.race.sessionId) groups.push((g = { sid: x.race.sessionId, rows: [] }));
      g.rows.push(x);
    }
    const ordered = S.sessionNewest ? groups.reverse().map((g) => ({ ...g, rows: [...g.rows].reverse() })) : groups;
    const sessHead = (g, cols, sticky) => {
      if (!multiSess) return '';
      const info = S.history.sessions.find((x) => x.id === g.sid);
      const txt = `<b>Session S${sessOrder.indexOf(g.sid) + 1}</b> <span class="muted" style="margin-left:8px">${info ? `${when(info.startedAt)} – ${info.endedAt ? clock(info.endedAt) : 'now'}${info.current ? ' · current' : END_REASON[info.endReason] ? ` · ${END_REASON[info.endReason]}` : ''}` : ''}</span>`;
      return sticky ? `<tr class="pilot-head"><td colspan="${cols}"><div class="stick">${txt}</div></td></tr>` : `<tr class="pilot-head"><td colspan="${cols}">${txt}</td></tr>`;
    };
    const lead = [
      { label: '#', cls: 'num', w: 36, style: 'left:0' },
      { label: 'Race · lap', w: 122, style: 'left:36px' },
      { label: 'Lap', cls: 'num', w: 80, style: 'left:158px', end: true },
    ];
    const label = (x) => `${raceLabel(x.race)} · L${x.lap.lap}${x.lap.incomplete ? ' <span class="badge rs">cut</span>' : ''}`;
    let sec = '', gates = '';
    let prevS = null, prevG = null;
    for (const g of ordered) {
      sec += sessHead(g, 10, false);
      gates += G ? sessHead(g, G + 3, true) : '';
      prevS = prevG = null;
      for (const x of g.rows) {
        const l = x.lap;
        const sep = prevS && prevS !== x.race ? ' race-start' : '';
        prevS = x.race;
        const secs = [0, 1, 2].map((k) => {
          const s0 = l.sectors?.[k];
          return gapCell(s0?.time ?? null, flagClass(s0), secBest[k], !!s0?.approx, `${k === 0 ? 'sb ' : ''}${rb(x.sectors[k], secBest[k])}`);
        });
        const d = l.lapTime != null ? r3(l.lapTime - best) : null;
        sec += `<tr class="${l.incomplete ? 'inc' : ''}${sep}"><td class="num dim">${x.n}</td><td class="lapno">${label(x)}</td><td class="dim">${clock(x.at)}</td>
          ${x.hs != null ? gapCell(x.hs, hsClass(x.hsObj), hsBest, false, rb(x.hs, hsBest)) : '<td></td>'}${secs.join('')}
          <td class="num sb ${lapClass(l)}${rb(l.lapTime, best)}"><b>${l.lapTime != null ? fmtT(l.lapTime) : '—'}</b></td>
          <td class="num muted">${d != null ? (d === 0 ? 'best' : fmtD(d)) : ''}</td>
          <td class="num ${l.lapDelta == null ? '' : l.lapDelta < 0 ? 'faster' : 'slower'}">${l.lapDelta != null ? fmtD(l.lapDelta) : ''}</td></tr>`;
        if (G) {
          const flags = normCum(l.segFlags, G);
          const sepG = prevG && prevG !== x.race ? ' race-start' : '';
          prevG = x.race;
          gates += `<tr class="${l.incomplete ? 'inc' : ''}${sepG}">${stk(lead[0], x.n, 'num dim')}${stk(lead[1], label(x), 'lapno')}${stk(lead[2], l.lapTime != null ? fmtT(l.lapTime) : '—', `num ${lapClass(l)}${rb(l.lapTime, best)}`)}${splitCells(plan, x.segs, x.cum, (i, v) => `${segClass(flags?.[i])}${rb(v, segBest[i])}`)}</tr>`;
        }
      }
    }
    sec += `<tr class="sum"><td></td><td>Session best</td><td></td><td class="num">${fmtT(hsBest)}</td>${secBest.map((v, k) => `<td class="num${k === 0 ? ' sb' : ''}">${fmtT(v)}</td>`).join('')}<td class="num sb">${fmtT(best)}</td><td class="num muted" colspan="2">best sectors Σ ${fmtT(sumAll(secBest))}</td></tr>`;
    if (rec) sec += `<tr class="sum"><td></td><td>All-time PB</td><td></td><td class="num">${fmtT(rec.hsBest)}</td>${(rec.best || []).map((v, k) => `<td class="num${k === 0 ? ' sb' : ''}">${fmtT(v)}</td>`).join('')}<td class="num sb">${fmtT(rec.bestLap)}</td><td class="num muted" colspan="2">theoretical ${fmtT(rec.theoretical)}</td></tr>`;
    if (G) {
      gates += `<tr class="sum">${stk(lead[0], '')}${stk(lead[1], 'Session best')}${stk(lead[2], `<span class="muted">Σ</span> ${fmtT(ideal)}`, 'num')}${splitCells(plan, segBest, null)}</tr>`;
      if (rec?.segBest) gates += `<tr class="sum">${stk(lead[0], '')}${stk(lead[1], 'All-time PB')}${stk(lead[2], `<span class="muted">Σ</span> ${fmtT(rec.ultimate)}`, 'num')}${splitCells(plan, rec.segBest, null)}</tr>`;
    }
    const newest = `<label class="dim" style="text-transform:none;letter-spacing:0;display:inline-flex;gap:6px;align-items:center;cursor:pointer"><input type="checkbox" data-sessionnewest ${S.sessionNewest ? 'checked' : ''}> newest first</label>`;
    html += `<div class="card"><h3>Sectors &amp; laps · ${esc(me?.name || '')} · ${esc(sess.label)}<span class="sp"></span>${newest}</h3>${colourKey('session', true)}
      <div class="scroll"><table class="splits secs"><thead><tr><th class="num">#</th><th>Race · lap</th><th>Time</th><th class="num">Holeshot</th><th class="num sb">S1</th><th class="num">S2</th><th class="num">S3</th><th class="num sb">Lap</th><th class="num">Δ best</th><th class="num" title="Gap to your all-time PB when flown">vs PB</th></tr></thead><tbody>${sec}</tbody></table></div></div>`;
    if (G)
      html += `<div class="card"><h3>Gate splits · ${esc(me?.name || '')}<span class="sp"></span><span class="dim" style="text-transform:none;letter-spacing:0">scroll sideways: the lap stays pinned on the left</span></h3>${colourKey('session')}
        <div class="scroll">${gateTable(plan, lead, gates)}</div></div>`;
  }
  body.innerHTML = html;

  // Charts: x = lap number within the session, with race boundaries marked.
  const raceTicks = [];
  const bands = [];
  rows.forEach((x, i) => {
    if (x.firstOfRace) {
      raceTicks.push({ v: i + 1, label: raceLabel(x.race) });
      if (x.raceIdx % 2 === 1) {
        const last = rows.findLastIndex((y) => y.race === x.race) + 1;
        bands.push({ x0: i + 0.5, x1: last + 0.5, colour: '#ffffff', opacity: 0.025 });
      }
    }
  });
  const xMax = rows.length + 0.5;
  const tipTitle = (xv) => {
    const x = rows[Math.round(xv) - 1];
    return x ? `#${x.n} · ${raceLabel(x.race)} lap ${x.lap.lap} · ${clock(x.at)}` : '';
  };
  const lapPts = rows.map((x) => [x.n, x.lap.lapTime]);
  const avg = rolling(rows.map((x) => x.lap.lapTime), W);
  const series = [
    { name: 'Lap', colour, dots: true, points: lapPts.filter((p) => p[1] != null), tipFmt: (v) => fmtT(v) },
    { name: 'trend', colour: '#ffffff', width: 2, opacity: 0.8, points: rows.map((x, i) => [x.n, avg[i]]), tipFmt: (v) => fmtT(v) },
  ];
  if (rec?.bestLap != null) series.push({ name: 'PB', colour: 'var(--purple)', dash: '5 4', width: 1.5, points: [[0.5, rec.bestLap], [xMax, rec.bestLap]], noTip: true });
  lineChart($('sLaps'), { height: 230, series, xMin: 0.5, xMax, xTicks: raceTicks, bands, yFmt: (v) => fmtT(v, 1), tipTitle, snap: true, tipRange: 0.5 / rows.length + 0.01 });

  const secCols = ['#ff4d5e', '#3ea6ff', '#ffd23f'];
  const secSeries = [];
  [0, 1, 2].forEach((kk) => {
    const vals = rows.map((x) => x.sectors[kk]);
    secSeries.push({ name: `S${kk + 1}`, colour: secCols[kk], dots: true, r: 2.2, opacity: 0.35, noTip: true, points: rows.map((x, i) => [x.n, vals[i]]).filter((p) => p[1] != null) });
    const ra = rolling(vals, W);
    secSeries.push({ name: `S${kk + 1} trend`, colour: secCols[kk], width: 2, points: rows.map((x, i) => [x.n, vals[i] != null ? ra[i] : null]), tipFmt: (v) => fmtT(v) });
  });
  lineChart($('sSecs'), { height: 230, series: secSeries, xMin: 0.5, xMax, xTicks: raceTicks, bands, yFmt: (v) => v.toFixed(1), tipTitle, tipRange: 0.5 / rows.length + 0.01 });

  if (G && $('sGain')) {
    const third = Math.max(1, Math.floor(rows.length / 3));
    const early = rows.slice(0, third), late = rows.slice(-third);
    const gain = Array.from({ length: G }, (_, i) => {
      const a = early.map((x) => x.segs?.[i]).filter((v) => v != null);
      const b = late.map((x) => x.segs?.[i]).filter((v) => v != null);
      return rows.length >= 6 && a.length && b.length ? r3(median(b) - median(a)) : null;
    });
    barChart($('sGain'), {
      height: 240, groups: Array.from({ length: G }, (_, i) => splitLabel(plan, i)), bands: sectorGroupBands(plan),
      series: [{ name: 'change', colour: '#18d36a', colours: gain.map((v) => (v != null && v > 0 ? '#ff5d5d' : '#18d36a')), values: gain }],
      yFmt: (v) => fmtD(v, 2), tipFmt: (v) => `${fmtD(v)} s (${v < 0 ? 'faster' : 'slower'} now)`, labels: (v) => fmtD(v, 2),
      emptyText: 'Needs 6 or more laps in the session.',
    });
  }
}

// ---------- data management ----------

async function loadStorage() {
  const H = S.history;
  const v = H ? `${H.races.length}:${H.races.filter((r) => r.tel).length}:${H.sessions.length}:${H.tracks.length}` : null;
  if (S.storage?.version === v || S.storage?.pending === v) return;
  S.storage = { ...(S.storage || {}), pending: v };
  try {
    const d = await (await fetch('/api/storage')).json();
    S.storage = { ...d, version: v };
  } catch {
    S.storage = null;
    return;
  }
  if (S.tab === 'data') renderLower();
}

function renderData(body) {
  loadStorage();
  const H = S.history;
  const st = S.storage?.perRace ? S.storage : null;
  const D = S.del;
  // Drop selections that no longer exist.
  for (const id of D.sessions) if (!H.sessions.some((x) => x.id === id && !x.current)) D.sessions.delete(id);
  for (const id of D.tracks) if (!H.tracks.some((t) => t.id === id)) D.tracks.delete(id);
  const telOf = (sid) => (st ? H.races.filter((r) => r.sessionId === sid).reduce((a, r) => a + (st.perRace[r.id] || 0), 0) : 0);
  const selSess = H.sessions.filter((x) => D.sessions.has(x.id));
  const selRacesN = selSess.reduce((a, x) => a + x.races, 0);
  const selTel = selSess.reduce((a, x) => a + telOf(x.id), 0);
  const totalLaps = H.sessions.reduce((a, x) => a + x.laps, 0);
  const stat = (label, v, sub) => `<div class="stat"><div class="label">${label}</div><div class="v">${v}${sub ? `<small>${sub}</small>` : ''}</div></div>`;
  let html = `<div class="stat-row">
    ${stat('Sessions', H.sessions.length, `${H.races.length} races · ${totalLaps} laps`)}
    ${stat('Tracks', H.tracks.length, `${H.tracks.reduce((a, t) => a + t.records.length, 0)} pilot records`)}
    ${stat('Telemetry', st ? fmtBytes(st.telemetryBytes) : '…', st ? `${st.telemetryFiles} race files` : '')}
    ${stat('Records file', st ? fmtBytes(st.recordsBytes) : '…', st ? `backup ${fmtBytes(st.backupBytes)}` : '')}
  </div>`;

  // Sessions
  const cur = H.sessions.find((x) => x.current);
  html += `<div class="card"><h3>Sessions<span class="sp"></span><span class="dim" style="text-transform:none;letter-spacing:0">${cur ? 'the session in progress can’t be deleted' : ''}</span></h3>
    <div class="dtree">${sessionTree('del', groupSessions(H.sessions.filter((x) => !x.current)), D.sessions, (x) => (st && telOf(x.id) ? ` · telemetry ${fmtBytes(telOf(x.id))}` : ''))}</div>
    <div class="toolbar dbar"><span class="muted">${D.sessions.size ? `${D.sessions.size} selected · ${selRacesN} races${selTel ? ` · ${fmtBytes(selTel)} telemetry` : ''}` : 'Tick sessions (or a whole map / day) to delete.'}</span><span class="sp" style="flex:1"></span>
      ${D.sessions.size ? '<button data-dact="clear-sessions">Clear</button>' : ''}
      <button class="danger" data-arm="del-tel" ${selTel ? '' : 'disabled'} title="Remove speed/position data, keep all times">Delete telemetry only</button>
      <button class="danger" data-arm="del-sessions" ${D.sessions.size ? '' : 'disabled'}>Delete ${D.sessions.size || ''} session${D.sessions.size === 1 ? '' : 's'}</button></div></div>`;

  // Tracks
  const trows = H.tracks.map((t) => {
    const ss = H.sessions.filter((x) => x.trackId === t.id);
    const rs = H.races.filter((r) => r.trackId === t.id);
    const last = Math.max(0, ...t.records.map((r) => r.lastSeen || 0));
    return `<tr><td><input type="checkbox" data-del-track="${esc(t.id)}" ${D.tracks.has(t.id) ? 'checked' : ''}></td><td><b>${esc(t.name)}</b>${t.sceneryTitle ? ` <span class="dim">${esc(t.sceneryTitle)}</span>` : ''}${t.id === S.live?.trackId ? ' <span class="badge running">live</span>' : ''}</td>
      <td class="num">${ss.length}</td><td class="num">${rs.length}</td><td class="num">${t.records.length}</td><td class="num">${fmtT(minOf(t.records.map((r) => r.bestLap)))}</td><td class="muted">${last ? when(last) : '—'}</td></tr>`;
  });
  html += `<div class="card"><h3>Tracks</h3><div class="scroll"><table class="class"><thead><tr><th></th><th>Track</th><th class="num">Sessions</th><th class="num">Races</th><th class="num">Pilots</th><th class="num">Best lap</th><th>Last flown</th></tr></thead><tbody>${trows.join('') || '<tr><td colspan="7" class="empty">No tracks.</td></tr>'}</tbody></table></div>
    <div class="toolbar dbar"><span class="muted">Deleting a track removes its records, map, sessions, races and telemetry.</span><span class="sp" style="flex:1"></span>
      <button class="danger" data-arm="del-tracks" ${D.tracks.size ? '' : 'disabled'}>Delete ${D.tracks.size || ''} track${D.tracks.size === 1 ? '' : 's'}</button></div></div>`;

  // Records
  const rt = H.tracks.find((t) => t.id === D.recTrack) || H.tracks.find((t) => t.id === S.live?.trackId) || H.tracks[0];
  if (rt) {
    D.recTrack = rt.id;
    const rrows = rt.records.map((r) => {
      const k = `${rt.id}|${r.key}`;
      return `<tr><td><input type="checkbox" data-del-rec="${esc(k)}" ${D.records.has(k) ? 'checked' : ''}></td><td><b>${esc(r.name)}</b></td><td class="num">${fmtT(r.bestLap)}</td><td class="num">${fmtT(r.hsBest)}</td><td class="num">${r.best.map((v) => fmtT(v)).join(' / ')}</td><td class="num">${r.laps}</td><td class="muted">${r.lastSeen ? when(r.lastSeen) : '—'}</td></tr>`;
    });
    const nRec = [...D.records].filter((k) => k.startsWith(`${rt.id}|`)).length;
    html += `<div class="card"><h3>Pilot records<span class="sp"></span><select data-del-rectrack>${H.tracks.map((t) => `<option value="${esc(t.id)}" ${t.id === rt.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></h3>
      <div class="scroll"><table class="class"><thead><tr><th></th><th>Pilot</th><th class="num">Best lap</th><th class="num">Holeshot</th><th class="num">S1 / S2 / S3</th><th class="num">Laps</th><th>Last flown</th></tr></thead><tbody>${rrows.join('') || '<tr><td colspan="7" class="empty">No records on this track.</td></tr>'}</tbody></table></div>
      <div class="toolbar dbar"><span class="muted">Records are the all-time bests. <b>Rebuild</b> recalculates them from the races still saved (use it after deleting bad sessions); bests from laps no longer saved are dropped.</span><span class="sp" style="flex:1"></span>
        <button class="danger" data-arm="rebuild" data-track="${esc(rt.id)}">Rebuild from saved races</button>
        <button class="danger" data-arm="del-records" ${nRec ? '' : 'disabled'}>Delete ${nRec || ''} record${nRec === 1 ? '' : 's'}</button></div></div>`;
  }
  html += `<div class="dim" style="font-size:12px">The records file is backed up to <code>sectors.json.bak</code> each time the timer starts${st?.dataFile ? ` (${esc(st.dataFile)})` : ''}.</div>`;
  body.innerHTML = html;
  applyIndeterminate(body);
}

async function dataDelete(payload) {
  const r = await fetch('/api/data/delete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  return r.ok ? r.json() : null;
}

function renderRecords(body, track) {
  const plan = track.plan;
  const recs = track.records;
  if (!recs.length) {
    body.innerHTML = '<div class="empty">No records on this track yet.</div>';
    return;
  }
  const tb = { hs: minOf(recs.map((r) => r.hsBest)), s: [0, 1, 2].map((k) => minOf(recs.map((r) => r.best[k]))), lap: minOf(recs.map((r) => r.bestLap)), th: minOf(recs.map((r) => r.theoretical)), ul: minOf(recs.map((r) => r.ultimate)) };
  // Purple marks who holds each best, when there's more than one pilot to compare.
  const c = (v, best) => `<td class="num${recs.length > 1 && v != null && best != null && v <= best ? ' rb' : ''}">${fmtT(v)}</td>`;
  const rows = recs.map((r, i) => `<tr><td class="c num">${i + 1}</td><td><div class="pilot">${esc(r.name)}</div></td>${c(r.hsBest, tb.hs)}${r.best.map((v, k) => c(v, tb.s[k])).join('')}${c(r.theoretical, tb.th)}${c(r.ultimate, tb.ul)}${c(r.bestLap, tb.lap)}
      <td class="num">${r.laps}</td><td class="muted">${r.lastSeen ? when(r.lastSeen) : ''}</td><td><button class="danger ghost" data-arm="delete-pilot" data-key="${esc(r.key)}">×</button></td></tr>`);
  let html = `<div class="card"><h3>Records · ${esc(track.name)}</h3><div class="scroll"><table class="class"><thead><tr><th class="c">#</th><th>Pilot</th><th class="num">Holeshot</th><th class="num">S1</th><th class="num">S2</th><th class="num">S3</th><th class="num" title="Sum of best sectors">Theoretical</th><th class="num" title="Sum of best gate splits">Ultimate</th><th class="num">Best lap</th><th class="num">Laps</th><th>Last flown</th><th></th></tr></thead><tbody>${rows.join('')}</tbody></table></div>
    <div class="ckey"><span>Every value here is that pilot's all-time best.</span><span><u class="rbk">1.234</u> underlined: the track record in that column (fastest of all pilots)</span>
      <span class="br"></span>Theoretical = best S1 + S2 + S3 · Ultimate = every best gate split added up</div></div>`;
  if (plan) {
    const G = plan.gates;
    const segTb = Array.from({ length: G }, (_, i) => minOf(recs.map((r) => r.segBest?.[i])));
    const counts = [0, 0, 0];
    for (let i = 0; i < G; i++) counts[sectorOfSplit(plan, i)]++;
    const sb = (i) => (i > 0 && sectorOfSplit(plan, i) !== sectorOfSplit(plan, i - 1) ? ' sb' : '');
    // Like the main table: the track record in each column is underlined (with 2+ pilots).
    const withSegs = recs.filter((r) => r.segBest);
    const mark = (v, i) => (withSegs.length > 1 && v != null && segTb[i] != null && v <= segTb[i] ? ' rb' : '');
    const segRows = withSegs.map((r) => `<tr><td><div class="pilot">${esc(r.name)}</div></td>${r.segBest.map((v, i) => `<td class="num${sb(i)}${mark(v, i)}">${v != null ? v.toFixed(3) : '—'}</td>`).join('')}<td class="num sb">${fmtT(r.ultimate)}</td></tr>`);
    if (withSegs.length > 1) segRows.push(`<tr class="sum"><td>Track record</td>${segTb.map((v, i) => `<td class="num${sb(i)}">${v != null ? v.toFixed(3) : '—'}</td>`).join('')}<td class="num sb">${fmtT(sumAll(segTb))}</td></tr>`);
    html += `<div class="card"><h3>Best gate splits</h3><div class="scroll"><table class="splits"><thead><tr><th></th>${counts.map((n, s) => `<th class="secgrp s${s + 1}" colspan="${n}">Sector ${s + 1}</th>`).join('')}<th></th></tr><tr><th>Pilot</th>${Array.from({ length: G }, (_, i) => `<th class="num${sb(i)}">${splitLabel(plan, i)}</th>`).join('')}<th class="num sb">Σ</th></tr></thead><tbody>${segRows.join('')}</tbody></table></div></div>`;
  }
  body.innerHTML = html;
}

function renderTrackTab(body, track) {
  const plan = track.plan;
  const td = trackDataOf(track.id);
  ensureTrackData(track.id);
  const others = S.history.tracks.filter((t) => t.id !== track.id);
  const races = racesOf(track.id);
  const info = [
    track.gameName && track.gameName !== track.name ? `game name: ${esc(track.gameName)}` : '',
    track.sceneryTitle ? esc(track.sceneryTitle) : '',
    plan ? `${plan.gates} gates (start/finish = gate ${plan.startGate})${track.layout.confirmed ? '' : ' · last gate not yet confirmed by a finish'}` : 'gate layout not learned yet',
    plan ? `S1 ${plan.startGate}→${plan.ends[0]} · S2 ${plan.ends[0]}→${plan.ends[1]} · S3 ${plan.ends[1]}→finish` : '',
    `${races.length} race${races.length === 1 ? '' : 's'} · ${track.records.length} pilot${track.records.length === 1 ? '' : 's'}`,
  ].filter(Boolean);
  const modes = [['sector', 'Sectors'], ['dominance', 'Gate owners'], ['speed', 'Speed (best lap)']];
  body.innerHTML = `<div class="card"><h3>${esc(track.name)}<span class="sp"></span>${modes.map(([m, l]) => `<button class="ghost" data-mapmode="${m}" style="${S.mapMode === m ? 'border-color:var(--red)' : ''}">${l}</button>`).join('')}</h3>
      <div class="map-wrap" id="bigMap"></div><div class="keys" id="bigMapKeys"></div></div>
    <div class="card"><h3>Track settings</h3><div style="padding:12px;display:grid;gap:10px">
      <div class="muted">${info.join('<br>')}</div>
      <div class="toolbar">
        <button data-act="rename-open">Rename</button>
        <span class="rename" id="renameBox"><input id="renameInput" value="${esc(track.name)}" maxlength="80"><button data-act="rename-save">Save</button></span>
        ${others.length ? `<span class="ctl"><select id="mergeSel">${others.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('')}</select><button data-arm="merge">Merge into</button></span>` : ''}
        <button class="danger" data-arm="relearn">Re-learn gates</button>
        <button class="danger" data-arm="delete-track">Delete track</button>
      </div>
      <div class="dim" style="font-size:12px">Merge moves this track's records and races into the selected track (use it when the same track was saved twice, e.g. once as "Unnamed track"). Re-learn gates resets sector and gate-split bests (lap bests are kept) after a track edit.</div>
    </div></div>`;
  const el = $('bigMap');
  const map = td?.map;
  if (!map?.x?.length) {
    el.innerHTML = `<div class="empty">${S.imu ? 'The map is drawn from your fastest lap with telemetry: fly a full lap.' : 'The map needs telemetry: turn on <b>WebSocket IMU</b> in Velocidrone Main Settings and fly a lap.'}</div>`;
    return;
  }
  let opts = { map, plan, mode: S.mapMode, height: 440 };
  let keys = '';
  if (S.mapMode === 'speed') {
    const refKey = td.refs?.[S.live?.localKey] ? S.live.localKey : Object.keys(td.refs || {})[0];
    const ref = refKey ? td.refs[refKey] : null;
    if (ref) opts = { map: { x: ref.x, z: ref.z, gates: ref.gates }, plan, mode: 'speed', speed: ref.v, height: 440 };
    const whose = ref ? `${esc(track.records.find((r) => r.key === refKey)?.name || refKey)}'s best lap ${fmtT(ref.lapTime)}` : 'no telemetry lap yet';
    keys = `<span>slow <i style="background:linear-gradient(90deg,rgb(62,120,255),rgb(24,211,106),rgb(255,210,63),rgb(255,70,70));width:80px"></i> fast</span><span>${whose}</span>`;
  } else if (S.mapMode === 'dominance' && plan) {
    const recs = track.records.filter((r) => r.segBest);
    const owners = Array.from({ length: plan.gates }, (_, i) => {
      const best = minOf(recs.map((r) => r.segBest[i]));
      return recs.find((r) => r.segBest[i] != null && r.segBest[i] === best) || null;
    });
    opts.segColours = owners.map((r) => (r ? colourOf(r.colour, r.key) : '#444'));
    const who = [...new Set(owners.filter(Boolean))];
    keys = who.map((r) => `<span><i style="background:${colourOf(r.colour, r.key)}"></i>${esc(r.name)} (${owners.filter((o) => o === r).length})</span>`).join('');
  } else {
    keys = '<span><i style="background:var(--s1)"></i>Sector 1</span><span><i style="background:var(--s2)"></i>Sector 2</span><span><i style="background:var(--s3)"></i>Sector 3</span><span>○ gate · ◎ sector boundary</span>';
  }
  trackMap(el, opts);
  $('bigMapKeys').innerHTML = keys;
}

// ---------- interactions ----------

function arm(btn, run) {
  if (btn.classList.contains('armed')) {
    btn.classList.remove('armed');
    clearTimeout(btn._t);
    run();
    return;
  }
  btn.classList.add('armed');
  btn._label = btn.textContent;
  btn.textContent = 'Click again to confirm';
  btn._t = setTimeout(() => {
    btn.classList.remove('armed');
    btn.textContent = btn._label;
  }, 3000);
}

$('tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]');
  if (!b) return;
  S.tab = b.dataset.tab;
  store.set('tab', S.tab);
  renderLower();
});
$('trackSel').addEventListener('change', (e) => {
  S.trackSel = e.target.value === S.live?.trackId ? null : e.target.value;
  renderLower();
});
$('raceBar').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.scopetrack) {
    S.scopeTrack = b.dataset.scopetrack;
    renderLower();
  } else if (b.dataset.race) {
    const id = Number(b.dataset.race);
    const latest = selRaces()[0]?.id;
    S.raceSel = id === latest ? null : id; // the newest race keeps following new races
    renderLower();
  } else if (b.dataset.arm === 'delete-race') {
    arm(b, async () => {
      await post('/api/race/delete', { raceId: Number(b.dataset.id) });
      S.raceSel = null;
    });
  }
});
$('sessBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  S.sessOpen = !S.sessOpen;
  if (S.sessOpen) $('sessBtn').scrollIntoView({ block: 'nearest' });
  renderSessionPanel();
});
document.addEventListener('click', (e) => {
  if (S.sessOpen && !e.target.closest('#sessPick')) {
    S.sessOpen = false;
    renderSessionPanel();
  }
});
window.addEventListener('scroll', () => S.sessOpen && placeSessPanel(), { passive: true });
$('sessPanel').addEventListener('change', (e) => {
  const t = e.target;
  if (t.matches('[data-pick-sess]')) {
    const key = t.dataset.pickSess === 'current' ? 'current' : Number(t.dataset.pickSess);
    if (t.checked) S.sel.add(key);
    else S.sel.delete(key);
  } else if (t.matches('[data-pick-group]')) {
    for (const id of t.dataset.pickGroup.split(',').map(Number)) {
      if (t.checked) S.sel.add(id);
      else S.sel.delete(id);
    }
  } else return;
  if (!S.sel.size) S.sel.add('current');
  S.raceSel = null;
  renderLower();
});
$('sessPanel').addEventListener('click', (e) => {
  // Clicks inside the panel never close it (the panel re-renders, detaching the clicked element).
  e.stopPropagation();
  const b = e.target.closest('button');
  if (!b) return;
  e.preventDefault();
  if (b.dataset.pickToggle) {
    (S.open.pick ||= {})[b.dataset.pickToggle] = !isOpen('pick', b.dataset.pickToggle, b.querySelector('.caret')?.classList.contains('open'));
    return renderSessionPanel();
  }
  if (b.dataset.sessact === 'current') S.sel = new Set(['current']);
  else if (b.dataset.sessact === 'track') {
    const t = scopeTrack() || trackById(S.live?.trackId);
    S.sel = new Set(S.history.sessions.filter((x) => x.trackId === t?.id).map((x) => (x.current ? 'current' : x.id)));
    if (!S.sel.size) S.sel.add('current');
  } else if (b.dataset.sessact === 'manage') {
    S.sessOpen = false;
    S.tab = 'data';
    store.set('tab', S.tab);
  } else return;
  S.raceSel = null;
  renderLower();
});
$('tabBody').addEventListener('change', (e) => {
  const t = e.target;
  const D = S.del;
  if (S.tab === 'data') {
    if (t.matches('[data-del-sess]')) {
      const id = Number(t.dataset.delSess);
      t.checked ? D.sessions.add(id) : D.sessions.delete(id);
    } else if (t.matches('[data-del-group]')) {
      for (const id of t.dataset.delGroup.split(',').map(Number)) t.checked ? D.sessions.add(id) : D.sessions.delete(id);
    } else if (t.matches('[data-del-track]')) {
      t.checked ? D.tracks.add(t.dataset.delTrack) : D.tracks.delete(t.dataset.delTrack);
    } else if (t.matches('[data-del-rec]')) {
      t.checked ? D.records.add(t.dataset.delRec) : D.records.delete(t.dataset.delRec);
    } else if (t.matches('[data-del-rectrack]')) {
      D.recTrack = t.value;
      D.records.clear(); // ticks belong to the track they were made on
    } else return;
    return renderLower();
  }
  if (t.matches('[data-sessionpilot]')) {
    S.sessionPilot = t.value;
    renderLower();
  } else if (t.matches('[data-sessionnewest]')) {
    S.sessionNewest = t.checked;
    store.set('sessionNewest', S.sessionNewest);
    renderLower();
  } else if (t.matches('[data-pilotsel]')) {
    S.pilotSel = t.value;
    renderLower();
  } else if (t.matches('[data-lappick]')) {
    const id = t.dataset.lappick;
    const ids = S.lapPicks.ids.filter((x) => x !== id);
    if (t.checked) ids.push(id);
    S.lapPicks.ids = ids.slice(-4);
    S.lapPicks.user = true;
    renderLower();
  }
});
$('tabBody').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (S.tab === 'data') {
    const D = S.del;
    if (b.dataset.delToggle) {
      e.preventDefault();
      (S.open.del ||= {})[b.dataset.delToggle] = !isOpen('del', b.dataset.delToggle, b.querySelector('.caret')?.classList.contains('open'));
      return renderLower();
    }
    if (b.dataset.dact === 'clear-sessions') {
      D.sessions.clear();
      return renderLower();
    }
    const done = () => {
      S.storage = null;
      renderLower();
    };
    if (b.dataset.arm === 'del-sessions')
      return arm(b, async () => {
        const ids = [...D.sessions];
        for (const id of ids) S.sel.delete(id);
        if (!S.sel.size) S.sel.add('current');
        D.sessions.clear();
        await dataDelete({ sessions: ids });
        done();
      });
    if (b.dataset.arm === 'del-tel')
      return arm(b, async () => {
        await dataDelete({ sessions: [...D.sessions], telemetryOnly: true });
        S.raceTel.clear();
        done();
      });
    if (b.dataset.arm === 'del-tracks')
      return arm(b, async () => {
        const ids = [...D.tracks];
        D.tracks.clear();
        await dataDelete({ tracks: ids });
        done();
      });
    if (b.dataset.arm === 'del-records')
      return arm(b, async () => {
        const recs = [...D.records].filter((k) => k.startsWith(`${D.recTrack}|`)).map((k) => [k.slice(0, k.indexOf('|')), k.slice(k.indexOf('|') + 1)]);
        D.records.clear();
        await dataDelete({ records: recs });
        done();
      });
    if (b.dataset.arm === 'rebuild') return arm(b, () => post('/api/track/rebuild', { trackId: b.dataset.track }));
    return;
  }
  const track = selectedTrack();
  if (b.dataset.mapmode) {
    S.mapMode = b.dataset.mapmode;
    renderLower();
  } else if (b.dataset.act === 'rename-open') {
    $('renameBox').classList.toggle('open');
    $('renameInput').focus();
  } else if (b.dataset.act === 'rename-save') {
    post('/api/track/rename', { trackId: track.id, name: $('renameInput').value });
  } else if (b.dataset.arm === 'merge') {
    arm(b, () => {
      const toId = $('mergeSel').value;
      post('/api/track/merge', { fromId: track.id, toId });
      S.trackSel = toId === S.live?.trackId ? null : toId;
    });
  } else if (b.dataset.arm === 'relearn') {
    arm(b, () => post('/api/track/relearn', { trackId: track.id }));
  } else if (b.dataset.arm === 'delete-track') {
    arm(b, () => {
      post('/api/track/delete', { trackId: track.id });
      S.trackSel = null;
    });
  } else if (b.dataset.arm === 'delete-pilot') {
    arm(b, () => post('/api/pilot/delete', { trackId: track.id, pilotKey: b.dataset.key }));
  }
});
$('tabBody').addEventListener('keydown', (e) => {
  if (e.target.id === 'renameInput' && e.key === 'Enter') post('/api/track/rename', { trackId: selectedTrack().id, name: e.target.value });
});
let resizeT = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeT);
  resizeT = setTimeout(() => {
    renderMap(true);
    renderTrace();
    renderLower();
  }, 150);
});

connectStream();
requestAnimationFrame(tick);
