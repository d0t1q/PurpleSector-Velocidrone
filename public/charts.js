// Small dependency-free SVG charts and the track map.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function niceTicks(min, max, count = 5) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const span = max - min;
  const step0 = span / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0) || 10 * mag;
  const out = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-6; v += step) out.push(Math.round(v / step) * step);
  return out;
}

function nearestIndex(pts, x) {
  let lo = 0, hi = pts.length - 1;
  if (hi < 0) return -1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (pts[mid][0] < x) lo = mid;
    else hi = mid;
  }
  return Math.abs(pts[lo][0] - x) <= Math.abs(pts[hi][0] - x) ? lo : hi;
}

/**
 * Line / dot chart.
 * opts: { height, series:[{name, colour, points:[[x,y|null]], dash, width, dots, area, opacity}],
 *         xMin,xMax,yMin,yMax, invertY, xFmt, yFmt, xTicks:[{v,label}], bands:[{x0,x1,colour,label}],
 *         zero, tipTitle(x), yPad, step }
 */
export function lineChart(el, opts) {
  const W = Math.max(200, el.clientWidth - 16 || 600);
  const H = opts.height || 220;
  const m = { l: 46, r: 12, t: 10, b: 22 };
  const all = opts.series.flatMap((s) => s.points.filter((p) => p[1] != null && Number.isFinite(p[1])));
  if (!all.length) {
    el.innerHTML = `<div class="empty">${esc(opts.emptyText || 'No data yet.')}</div>`;
    return;
  }
  const xs = all.map((p) => p[0]);
  const ys = all.map((p) => p[1]);
  let xMin = opts.xMin ?? Math.min(...xs), xMax = opts.xMax ?? Math.max(...xs);
  if (xMin === xMax) xMax = xMin + 1;
  let yMin = opts.yMin ?? Math.min(...ys), yMax = opts.yMax ?? Math.max(...ys);
  if (opts.zero) {
    yMin = Math.min(yMin, 0);
    yMax = Math.max(yMax, 0);
  }
  const pad = (yMax - yMin || 1) * (opts.yPad ?? 0.08);
  if (opts.yMin == null) yMin -= pad;
  if (opts.yMax == null) yMax += pad;
  const sx = (x) => m.l + ((x - xMin) / (xMax - xMin)) * (W - m.l - m.r);
  const sy = (y) => (opts.invertY ? m.t + ((y - yMin) / (yMax - yMin)) * (H - m.t - m.b) : H - m.b - ((y - yMin) / (yMax - yMin)) * (H - m.t - m.b));
  const yFmt = opts.yFmt || ((v) => String(+v.toFixed(3)));
  const xFmt = opts.xFmt || ((v) => String(+v.toFixed(2)));
  let svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`;
  for (const b of opts.bands || []) {
    const x0 = sx(Math.max(xMin, b.x0)), x1 = sx(Math.min(xMax, b.x1));
    svg += `<rect x="${x0}" y="${m.t}" width="${Math.max(0, x1 - x0)}" height="${H - m.t - m.b}" fill="${b.colour}" opacity="${b.opacity ?? 0.06}"/>`;
    if (b.label) svg += `<text x="${x0 + 4}" y="${m.t + 10}" fill="${b.colour}" font-size="10" font-weight="700" opacity=".8">${esc(b.label)}</text>`;
  }
  svg += '<g class="grid axis">';
  for (const v of niceTicks(yMin, yMax, Math.max(2, Math.round(H / 45)))) {
    if (v < yMin || v > yMax) continue;
    svg += `<line x1="${m.l}" x2="${W - m.r}" y1="${sy(v)}" y2="${sy(v)}"/><text x="${m.l - 6}" y="${sy(v) + 3}" text-anchor="end">${esc(yFmt(v))}</text>`;
  }
  const xt = opts.xTicks || niceTicks(xMin, xMax, Math.max(2, Math.round(W / 90))).map((v) => ({ v, label: xFmt(v) }));
  const every = Math.max(1, Math.ceil(xt.length / Math.max(2, Math.floor((W - m.l) / 34))));
  xt.forEach((t, i) => {
    if (t.v < xMin - 1e-9 || t.v > xMax + 1e-9 || i % every) return;
    svg += `<text x="${sx(t.v)}" y="${H - 6}" text-anchor="middle">${esc(t.label)}</text>`;
  });
  svg += '</g>';
  if (opts.zero && yMin < 0 && yMax > 0) svg += `<line class="zero" x1="${m.l}" x2="${W - m.r}" y1="${sy(0)}" y2="${sy(0)}"/>`;
  for (const s of opts.series) {
    const pts = s.points;
    if (s.dots) {
      for (const [x, y] of pts) if (y != null) svg += `<circle cx="${sx(x)}" cy="${sy(y)}" r="${s.r || 3.5}" fill="${s.colour}" opacity="${s.opacity ?? 0.9}"/>`;
      continue;
    }
    let d = '';
    let pen = false;
    let prevY = null;
    for (const [x, y] of pts) {
      if (y == null || !Number.isFinite(y)) {
        pen = false;
        continue;
      }
      if (opts.step && pen) d += `L${sx(x).toFixed(1)},${sy(prevY).toFixed(1)}`;
      d += `${pen ? 'L' : 'M'}${sx(x).toFixed(1)},${sy(y).toFixed(1)}`;
      pen = true;
      prevY = y;
    }
    if (s.area && d) {
      const base = sy(Math.max(yMin, Math.min(yMax, 0)));
      const first = pts.find((p) => p[1] != null), last = [...pts].reverse().find((p) => p[1] != null);
      svg += `<path d="${d}L${sx(last[0])},${base}L${sx(first[0])},${base}Z" fill="${s.colour}" opacity="${s.areaOpacity ?? 0.15}"/>`;
    }
    svg += `<path d="${d}" fill="none" stroke="${s.colour}" stroke-width="${s.width || 2}" stroke-linejoin="round" ${s.dash ? `stroke-dasharray="${s.dash}"` : ''} opacity="${s.opacity ?? 1}"/>`;
    if (s.markers) for (const [x, y] of pts) if (y != null) svg += `<circle cx="${sx(x)}" cy="${sy(y)}" r="2.6" fill="${s.colour}"/>`;
  }
  svg += `<line class="xhair" x1="0" x2="0" y1="${m.t}" y2="${H - m.b}" visibility="hidden"/>`;
  svg += `<rect class="hit" x="${m.l}" y="0" width="${W - m.l - m.r}" height="${H}" fill="transparent"/></svg><div class="tip"></div>`;
  el.innerHTML = svg;

  if (opts.noTip) return;
  const hit = el.querySelector('.hit'), tip = el.querySelector('.tip'), xh = el.querySelector('.xhair');
  const inv = (px) => xMin + ((px - m.l) / (W - m.l - m.r)) * (xMax - xMin);
  hit.addEventListener('mousemove', (ev) => {
    const r = el.querySelector('svg').getBoundingClientRect();
    const px = ev.clientX - r.left;
    let x = inv(px);
    const rows = [];
    for (const s of opts.series) {
      if (s.noTip) continue;
      const pts = s.points.filter((p) => p[1] != null);
      const i = nearestIndex(pts, x);
      if (i < 0) continue;
      if (opts.snap !== false && rows.length === 0) x = pts[i][0];
      const p = pts[i];
      if (Math.abs(p[0] - x) > (xMax - xMin) * (opts.tipRange ?? 0.04)) continue;
      rows.push(`<div><span style="color:${s.colour}">■</span> ${esc(s.name)} <b>${esc((s.tipFmt || yFmt)(p[1], p))}</b></div>`);
    }
    if (!rows.length) {
      tip.style.display = 'none';
      xh.setAttribute('visibility', 'hidden');
      return;
    }
    xh.setAttribute('x1', sx(x));
    xh.setAttribute('x2', sx(x));
    xh.setAttribute('visibility', 'visible');
    tip.innerHTML = `<div class="dim">${esc(opts.tipTitle ? opts.tipTitle(x) : xFmt(x))}</div>${rows.join('')}`;
    tip.style.display = 'block';
    const left = sx(x) + 14;
    tip.style.left = `${left + tip.offsetWidth > W ? sx(x) - tip.offsetWidth - 6 : left}px`;
    tip.style.top = `${Math.max(0, ev.clientY - r.top - 20)}px`;
  });
  hit.addEventListener('mouseleave', () => {
    tip.style.display = 'none';
    xh.setAttribute('visibility', 'hidden');
  });
}

/**
 * Grouped bar chart. opts: { height, groups:[label], series:[{name, colour, values:[v|null]}], yFmt, zero, tip,
 *   bands:[{from, to, colour, label}] (shaded group ranges, e.g. the sectors) }
 */
export function barChart(el, opts) {
  const W = Math.max(200, el.clientWidth - 16 || 600);
  const H = opts.height || 200;
  const m = { l: 46, r: 10, t: opts.bands?.length ? 26 : 10, b: 22 };
  const vals = opts.series.flatMap((s) => s.values.filter((v) => v != null));
  if (!vals.length) {
    el.innerHTML = `<div class="empty">${esc(opts.emptyText || 'No data yet.')}</div>`;
    return;
  }
  let yMin = Math.min(0, ...vals), yMax = Math.max(0, ...vals);
  if (yMax === yMin) yMax = yMin + 1;
  yMax += (yMax - yMin) * 0.08;
  const sy = (y) => H - m.b - ((y - yMin) / (yMax - yMin)) * (H - m.t - m.b);
  const gw = (W - m.l - m.r) / opts.groups.length;
  const bw = Math.min(26, (gw * 0.8) / opts.series.length);
  const yFmt = opts.yFmt || ((v) => v.toFixed(3));
  let svg = `<svg width="${W}" height="${H}">`;
  for (const b of opts.bands || []) {
    const x = m.l + gw * b.from;
    svg += `<rect x="${x}" y="${m.t}" width="${gw * (b.to - b.from + 1)}" height="${H - m.t - m.b}" fill="${b.colour}" opacity=".06"/>`;
    if (b.label) svg += `<rect x="${x}" y="${m.t - 6}" width="${gw * (b.to - b.from + 1)}" height="2" fill="${b.colour}" opacity=".9"/><text x="${x + 2}" y="${m.t - 11}" fill="${b.colour}" font-size="10" font-weight="700">${esc(b.label)}</text>`;
  }
  svg += '<g class="grid axis">';
  for (const v of niceTicks(yMin, yMax, 4)) svg += `<line x1="${m.l}" x2="${W - m.r}" y1="${sy(v)}" y2="${sy(v)}"/><text x="${m.l - 6}" y="${sy(v) + 3}" text-anchor="end">${esc(yFmt(v))}</text>`;
  // Thin out the labels when there are many groups (e.g. 30+ gate splits).
  const every = Math.max(1, Math.ceil(opts.groups.length / Math.max(1, Math.floor((W - m.l) / 38))));
  opts.groups.forEach((g, gi) => {
    if (gi % every === 0) svg += `<text x="${m.l + gw * gi + gw / 2}" y="${H - 6}" text-anchor="middle">${esc(g)}</text>`;
  });
  svg += '</g>';
  opts.groups.forEach((g, gi) => {
    const x0 = m.l + gw * gi + (gw - bw * opts.series.length) / 2;
    opts.series.forEach((s, si) => {
      const v = s.values[gi];
      if (v == null) return;
      const y = sy(Math.max(v, 0)), h = Math.abs(sy(v) - sy(0));
      const title = `${s.name} · ${g}: ${(opts.tipFmt || yFmt)(v)}`;
      svg += `<rect x="${x0 + bw * si + 1}" y="${y}" width="${bw - 2}" height="${Math.max(1, h)}" fill="${s.colours?.[gi] || s.colour}" rx="1"><title>${esc(title)}</title></rect>`;
      if (opts.labels && bw >= 22) svg += `<text x="${x0 + bw * si + bw / 2}" y="${y - 3}" text-anchor="middle" fill="var(--muted)" font-size="9" font-family="var(--mono)">${esc(opts.labels(v, s, gi))}</text>`;
    });
  });
  svg += `<line x1="${m.l}" x2="${W - m.r}" y1="${sy(0)}" y2="${sy(0)}" stroke="var(--line-2)"/></svg>`;
  el.innerHTML = svg;
}

/** Speed colour scale (slow blue -> fast red). */
export function speedColour(f) {
  const stops = [[0, [62, 120, 255]], [0.35, [40, 210, 200]], [0.6, [24, 211, 106]], [0.8, [255, 210, 63]], [1, [255, 70, 70]]];
  f = Math.max(0, Math.min(1, f));
  for (let i = 1; i < stops.length; i++) {
    if (f <= stops[i][0]) {
      const [a, ca] = stops[i - 1], [b, cb] = stops[i];
      const t = (f - a) / (b - a);
      return `rgb(${ca.map((c, k) => Math.round(c + (cb[k] - c) * t)).join(',')})`;
    }
  }
  return 'rgb(255,70,70)';
}

/**
 * Track map from a lap's path. opts: { map:{x,z,gates:[{i,k}]}, plan, mode:'sector'|'speed'|'plain'|'dominance',
 *   speed:[m/s] (same length as map.x), segColours:[css per timing point] (dominance), height, labels }
 * Returns { place(id, x, z, colour, label), placeAt(id, k, colour, label), clear(id) } for live dots.
 */
export function trackMap(el, opts) {
  const { map, plan } = opts;
  const W = Math.max(200, el.clientWidth || 400);
  const xs = map.x, zs = map.z;
  const minX = Math.min(...xs), maxX = Math.max(...xs), minZ = Math.min(...zs), maxZ = Math.max(...zs);
  const spanX = maxX - minX || 1, spanZ = maxZ - minZ || 1;
  const H = opts.height || Math.max(200, Math.min(460, (W * spanZ) / spanX + 40));
  const pad = 22;
  const scale = Math.min((W - pad * 2) / spanX, (H - pad * 2) / spanZ);
  const ox = (W - spanX * scale) / 2, oz = (H - spanZ * scale) / 2;
  const P = (x, z) => [ox + (x - minX) * scale, H - (oz + (z - minZ) * scale)]; // x right, z up
  const pt = (k) => P(xs[k], zs[k]);
  const n = xs.length;
  const pathOf = (a, b) => {
    let d = '';
    for (let k = a; k <= b && k < n; k++) {
      const [x, y] = pt(k);
      d += `${k === a ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    }
    return d;
  };
  const gateK = new Map(map.gates.map((g) => [g.i, g.k]));
  let svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`;
  svg += `<path d="${pathOf(0, n - 1)}" fill="none" stroke="#2a2f39" stroke-width="11" stroke-linecap="round" stroke-linejoin="round"/>`;
  const mode = opts.mode || 'sector';
  if (mode === 'speed' && opts.speed) {
    const sp = opts.speed;
    const lo = Math.min(...sp), hi = Math.max(...sp);
    for (let k = 1; k < n; k++) {
      const [x0, y0] = pt(k - 1), [x1, y1] = pt(k);
      svg += `<line x1="${x0.toFixed(1)}" y1="${y0.toFixed(1)}" x2="${x1.toFixed(1)}" y2="${y1.toFixed(1)}" stroke="${speedColour((sp[k] - lo) / (hi - lo || 1))}" stroke-width="4" stroke-linecap="round"/>`;
    }
  } else if (mode === 'dominance' && opts.segColours) {
    // Colour each gate split by who owns it.
    let prevK = 0;
    for (let i = 0; i < (plan?.gates || 0); i++) {
      const k = i === plan.gates - 1 ? n - 1 : gateK.get(i);
      if (k == null) continue;
      svg += `<path d="${pathOf(prevK, k)}" fill="none" stroke="${opts.segColours[i] || '#555'}" stroke-width="5" stroke-linecap="round"/>`;
      prevK = k;
    }
  } else if (mode === 'sector' && plan) {
    const cuts = [0, ...plan.ends.map((g) => gateK.get(g - plan.startGate - 1)), n - 1];
    const cols = ['var(--s1)', 'var(--s2)', 'var(--s3)'];
    for (let s = 0; s < 3; s++) {
      if (cuts[s] == null || cuts[s + 1] == null) continue;
      svg += `<path d="${pathOf(cuts[s], cuts[s + 1])}" fill="none" stroke="${cols[s]}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" opacity=".9"/>`;
    }
  } else {
    svg += `<path d="${pathOf(0, n - 1)}" fill="none" stroke="#8892a3" stroke-width="3" stroke-linejoin="round"/>`;
  }
  // Gates
  for (const g of map.gates) {
    if (plan && g.i >= plan.gates - 1) continue; // lap line = start gate (chequered marker)
    const [x, y] = pt(g.k);
    const isEnd = plan && plan.ends.includes(plan.startGate + 1 + g.i);
    svg += `<circle cx="${x}" cy="${y}" r="${isEnd ? 5 : 3.2}" fill="#0b0d11" stroke="${isEnd ? '#fff' : '#9aa3b2'}" stroke-width="1.5"/>`;
    if (opts.labels !== false && plan) svg += `<text x="${x + 7}" y="${y - 6}" fill="#9aa3b2" font-size="10" font-family="var(--mono)">${plan.startGate + 1 + g.i}</text>`;
  }
  const [sx0, sy0] = pt(0);
  svg += `<rect x="${sx0 - 6}" y="${sy0 - 6}" width="12" height="12" fill="url(#chk)" stroke="#fff" stroke-width="1"/>`;
  if (opts.labels !== false && plan) svg += `<text x="${sx0 + 9}" y="${sy0 + 14}" fill="#fff" font-size="10" font-weight="700" font-family="var(--mono)">${plan.startGate}</text>`;
  svg += `<defs><pattern id="chk" width="6" height="6" patternUnits="userSpaceOnUse"><rect width="6" height="6" fill="#fff"/><rect width="3" height="3" fill="#000"/><rect x="3" y="3" width="3" height="3" fill="#000"/></pattern></defs>`;
  svg += `<g class="dots"></g></svg>`;
  el.innerHTML = svg;
  const layer = el.querySelector('.dots');
  const dots = new Map();
  const dot = (id, colour, label) => {
    let g = dots.get(id);
    if (!g) {
      g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.innerHTML = `<circle r="7" stroke="#fff" stroke-width="2"/><text x="10" y="4" fill="#fff" font-size="11" font-weight="700" font-family="var(--sans)" paint-order="stroke" stroke="#000" stroke-width="3"></text>`;
      layer.appendChild(g);
      dots.set(id, g);
    }
    g.querySelector('circle').setAttribute('fill', colour);
    g.querySelector('text').textContent = label || '';
    return g;
  };
  return {
    place(id, x, z, colour, label) {
      const [px, py] = P(x, z);
      const g = dot(id, colour, label);
      // Near the right edge the name goes on the left of the dot so it isn't cut off.
      const text = g.querySelector('text');
      const left = px > W - 90;
      text.setAttribute('x', left ? '-10' : '10');
      text.setAttribute('text-anchor', left ? 'end' : 'start');
      g.setAttribute('transform', `translate(${px.toFixed(1)},${py.toFixed(1)})`);
    },
    placeAt(id, k, colour, label) {
      const k0 = Math.max(0, Math.min(n - 1, Math.floor(k)));
      const k1 = Math.min(n - 1, k0 + 1);
      const f = k - k0;
      this.place(id, xs[k0] + (xs[k1] - xs[k0]) * f, zs[k0] + (zs[k1] - zs[k0]) * f, colour, label);
    },
    keep(ids) {
      for (const [id, g] of dots) if (!ids.has(id)) {
        g.remove();
        dots.delete(id);
      }
    },
    gateK,
    n,
  };
}
