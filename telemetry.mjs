// Telemetry from the game's IMU stream: the drone flown on this PC, ~60 samples/s, when
// "WebSocket IMU" is on in Main Settings.
//
//   {"imu":{"roll","pitch","yaw","PositionX","PositionY","PositionZ","AttitudeX".."AttitudeW",
//           "SpeedX","SpeedY","SpeedZ","timestamp"}}
// Position/Speed are Unity world units (metres, Y up); timestamp is the game clock in ms. Race times
// from racedata are mapped onto this clock by the engine (pilot.gOff = game clock - race time).

const RATE = 20; // stored samples per second
const KEEP_MS = 6 * 60 * 1000; // raw samples kept (longest lap we can extract)
const G0 = 9.81;

const toNum = (v) => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};
const r2 = (x) => Math.round(x * 100) / 100;
const r1 = (x) => Math.round(x * 10) / 10;

export class Telemetry {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.buf = [];
    this.lastTs = null;
    this.lastAt = 0;
    this.g = 1;
    this.lap = null; // { lap, ts0, dist }
    this.topSpeed = 0;
  }

  /** Latest game-clock timestamp (ms), or null if IMU isn't streaming. */
  clock() {
    return this.active() ? this.lastTs : null;
  }

  active() {
    return this.lastTs != null && this.now() - this.lastAt < 2000;
  }

  ingest(imu) {
    const ts = toNum(imu.timestamp);
    const x = toNum(imu.PositionX), y = toNum(imu.PositionY), z = toNum(imu.PositionZ);
    if (ts == null || x == null || y == null || z == null) return null;
    if (this.lastTs != null && ts < this.lastTs - 1000) {
      // Game clock went backwards: game restarted.
      this.buf = [];
      this.lap = null;
    } else if (this.lastTs != null && ts <= this.lastTs) {
      return null;
    }
    const vx = toNum(imu.SpeedX) ?? 0, vy = toNum(imu.SpeedY) ?? 0, vz = toNum(imu.SpeedZ) ?? 0;
    const s = { ts, x, y, z, vx, vy, vz, v: Math.hypot(vx, vy, vz), roll: toNum(imu.roll), pitch: toNum(imu.pitch), yaw: toNum(imu.yaw) };
    const prev = this.buf.at(-1);
    if (prev) {
      const dt = (ts - prev.ts) / 1000;
      if (dt > 0 && dt < 0.25) {
        // Felt G: acceleration minus gravity (1 G in a hover), smoothed.
        const g = Math.hypot((vx - prev.vx) / dt, (vy - prev.vy) / dt + G0, (vz - prev.vz) / dt) / G0;
        if (Number.isFinite(g)) this.g += 0.12 * (Math.min(g, 15) - this.g);
      }
      if (this.lap && prev.ts >= this.lap.ts0) this.lap.dist += Math.hypot(x - prev.x, y - prev.y, z - prev.z);
    }
    s.g = this.g;
    this.buf.push(s);
    if (this.buf.length > 4000 && this.buf[0].ts < ts - KEEP_MS) {
      const cut = this.buf.findIndex((b) => b.ts >= ts - KEEP_MS);
      this.buf.splice(0, cut);
    }
    if (this.lap) this.lap.top = Math.max(this.lap.top || 0, s.v);
    this.lastTs = ts;
    this.lastAt = this.now();
    return s;
  }

  /** A lap started at game-clock time ts0 (detected a little late, so count distance since then). */
  setLapStart(lap, ts0) {
    let dist = 0, top = 0;
    let i = this.buf.length - 1;
    while (i > 0 && this.buf[i - 1].ts >= ts0) i--;
    for (let k = Math.max(i, 1); k < this.buf.length; k++) {
      const a = this.buf[k - 1], b = this.buf[k];
      if (a.ts >= ts0) dist += Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
      top = Math.max(top, b.v);
    }
    this.lap = { lap, ts0, dist, top };
  }

  /** The lap was completed (or cut short): stop counting it as the lap in progress. */
  endLap(lap) {
    if (this.lap && this.lap.lap === lap && !this.lap.ended) {
      this.lap.ended = true;
      this.lap.ts1 = this.lastTs;
    }
  }

  liveFrame() {
    const s = this.buf.at(-1);
    if (!s || !this.active()) return null;
    const lap = this.lap && !this.lap.ended && s.ts >= this.lap.ts0 ? this.lap : null;
    return {
      ts: s.ts,
      x: r2(s.x), y: r2(s.y), z: r2(s.z),
      v: r2(s.v), vy: r2(s.vy), g: r2(s.g),
      roll: s.roll, pitch: s.pitch, yaw: s.yaw,
      lap: lap?.lap ?? null,
      lt: lap ? r2((s.ts - lap.ts0) / 1000) : null,
      ld: lap ? r1(lap.dist) : null,
      top: lap ? r2(lap.top || 0) : null,
    };
  }

  /** The current lap so far (~15 Hz), for a page that connects mid-lap. */
  lapTrace() {
    if (!this.lap) return null;
    const pts = [];
    let d = 0, prev = null, next = 0;
    for (const s of this.buf) {
      if (s.ts < this.lap.ts0) continue;
      if (this.lap.ended && s.ts > this.lap.ts1) break;
      if (prev) d += Math.hypot(s.x - prev.x, s.y - prev.y, s.z - prev.z);
      prev = s;
      const t = (s.ts - this.lap.ts0) / 1000;
      if (t >= next) {
        pts.push({ t: r2(t), d: r1(d), v: r2(s.v) });
        next = t + 0.066;
      }
    }
    return { lap: this.lap.lap, ended: !!this.lap.ended, pts };
  }

  /** Interpolate a raw sample at game time ts. */
  at(ts, from = 0) {
    const b = this.buf;
    let i = from;
    while (i < b.length - 1 && b[i + 1].ts < ts) i++;
    const a = b[i], c = b[Math.min(i + 1, b.length - 1)];
    const f = c.ts > a.ts ? Math.min(1, Math.max(0, (ts - a.ts) / (c.ts - a.ts))) : 0;
    const L = (k) => a[k] + (c[k] - a[k]) * f;
    return { i, x: L('x'), y: L('y'), z: L('z'), v: L('v'), g: L('g') };
  }

  /**
   * Resampled telemetry for a lap between game-clock times ts0..ts1, with gate positions from the
   * lap's timing-point times (cum, seconds from lap start). Null if the IMU didn't cover the lap.
   */
  extract(ts0, ts1, cum) {
    const b = this.buf;
    if (b.length < 10 || ts1 <= ts0) return null;
    if (b[0].ts > ts0 + 300 || b.at(-1).ts < ts1 - 300) return null;
    let from = 0;
    while (from < b.length - 1 && b[from + 1].ts < ts0) from++;
    const dur = (ts1 - ts0) / 1000;
    const out = { t: [], x: [], y: [], z: [], v: [], g: [], d: [] };
    let d = 0, px = null, py = null, pz = null;
    const n = Math.max(2, Math.ceil(dur * RATE) + 1);
    for (let k = 0; k < n; k++) {
      const t = Math.min(dur, k / RATE);
      const s = this.at(ts0 + t * 1000, from);
      from = s.i;
      if (px != null) d += Math.hypot(s.x - px, s.y - py, s.z - pz);
      px = s.x; py = s.y; pz = s.z;
      out.t.push(r2(t)); out.x.push(r2(s.x)); out.y.push(r2(s.y)); out.z.push(r2(s.z));
      out.v.push(r2(s.v)); out.g.push(r1(s.g)); out.d.push(r1(d));
    }
    out.gates = [];
    (cum || []).forEach((c, i) => {
      if (c == null) return;
      const k = Math.min(n - 1, Math.round(c * RATE));
      out.gates.push({ i, t: c, k, d: out.d[k], x: out.x[k], z: out.z[k], y: out.y[k] });
    });
    out.top = Math.max(...out.v);
    out.dist = r1(d);
    return out;
  }
}

/** Track outline for the map: the fastest lap's path with gate positions. */
export function mapFromLap(lapTel, { lapTime, pilot }) {
  return { lapTime, pilot, x: lapTel.x, z: lapTel.z, y: lapTel.y, d: lapTel.d, gates: lapTel.gates.map((g) => ({ i: g.i, k: g.k })) };
}
