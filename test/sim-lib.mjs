// Shared race simulation for tests and the demo: produces reports exactly the way Velocidrone does.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Track: start/finish gate reports as gate 1, gates 2..12 follow, finish line reports 13.
export const START_GATE = 1, LAST_GATE = 12;
export const G = LAST_GATE - START_GATE + 1; // 12 gates
export const ENDS = [START_GATE + Math.round(G / 3), START_GATE + Math.round((2 * G) / 3)]; // gates 5 and 9
export const IMU_HZ = 30;
export const GAME_CLOCK0 = 50; // game clock (s) at the start signal

let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);

/** Build the list of reports a pilot's client produces over a race. */
export function flyRace({ laps, pace, quirks = {} }) {
  const ev = []; // { t, lap, gate, fin, s (lap progress for the IMU path) }
  let t = 1.0 + rnd() * 0.5; // holeshot: start signal to first start-gate crossing
  ev.push({ t, lap: 1, gate: START_GATE, fin: false, s: 0 });
  const stopAt = quirks.restartAt; // { lap, gate }: pilot restarts from the menu after this gate
  for (let lap = 1; lap <= laps; lap++) {
    for (let g = START_GATE + 1; g <= LAST_GATE; g++) {
      t += pace * (0.8 + rnd() * 0.4);
      const s = lap - 1 + (g - START_GATE) / G;
      if (quirks.tightGate && quirks.tightGate.lap === lap && quirks.tightGate.gate === g) {
        // This gate and the next one land inside the same 100 ms update, so this one is never reported.
        t = Math.floor(t * 10) / 10 + 0.03;
        ev.push({ t, lap, gate: g, fin: false, s });
        t += 0.04;
        ev.push({ t, lap, gate: ++g, fin: false, s: s + 1 / G });
        continue;
      }
      ev.push({ t, lap, gate: g, fin: false, s });
      if (stopAt && stopAt.lap === lap && stopAt.gate === g) return ev;
    }
    t += pace * (0.8 + rnd() * 0.4);
    if (lap < laps) {
      // Like the real game: the start/finish gate's finish trigger reports as gate lastGate+1 about
      // 0.03 s before the start trigger (only seen when a 0.1 s update falls in between).
      ev.push({ t: t - 0.033, lap, gate: LAST_GATE + 1, fin: false, s: lap - 0.0005, trigger: true });
      // Game reports the lap line twice: lap L first, then L+1 (same time).
      ev.push({ t, lap, gate: START_GATE, fin: false, splitTick: rnd() < 0.5, s: lap });
      ev.push({ t, lap: lap + 1, gate: START_GATE, fin: false, s: lap });
    } else if (quirks.lateFinishFlag) {
      ev.push({ t, lap, gate: LAST_GATE + 1, fin: false, splitTick: true, s: lap });
      ev.push({ t, lap, gate: LAST_GATE + 1, fin: true, s: lap });
    } else {
      ev.push({ t, lap, gate: LAST_GATE + 1, fin: true, s: lap });
    }
  }
  return ev;
}

/** A closed loop course; gate k of G sits at u = k/G. Returns world position (Unity: y up). */
export function coursePoint(u) {
  const a = 2 * Math.PI * u;
  return {
    x: 55 * Math.cos(a) + 14 * Math.cos(3 * a),
    z: 32 * Math.sin(a) + 9 * Math.sin(2 * a),
    y: 3.5 + 2.5 * Math.sin(2 * a) + 1.5 * Math.cos(5 * a),
  };
}

/** Lap progress (in laps) at race time t, from the pilot's gate times. */
function progressAt(ev, t) {
  if (t <= ev[0].t) return -0.05 + 0.05 * Math.max(0, t / ev[0].t); // holeshot run-up
  for (let i = 1; i < ev.length; i++) {
    if (t <= ev[i].t) {
      const a = ev[i - 1], b = ev[i];
      return a.s + (b.s - a.s) * ((t - a.t) / (b.t - a.t || 1));
    }
  }
  const last = ev.at(-1);
  return last.s + Math.min(0.05, (t - last.t) * 0.01); // slowing down after the finish
}

export function imuAt(ev, t) {
  const pos = (tt) => coursePoint(((progressAt(ev, tt) % 1) + 1) % 1);
  const p = pos(t), q = pos(t + 0.02);
  const v = { x: (q.x - p.x) / 0.02, y: (q.y - p.y) / 0.02, z: (q.z - p.z) / 0.02 };
  return {
    roll: 0, pitch: -20, yaw: 0,
    PositionX: +p.x.toFixed(3), PositionY: +p.y.toFixed(3), PositionZ: +p.z.toFixed(3),
    AttitudeX: 0, AttitudeY: 0, AttitudeZ: 0, AttitudeW: 1,
    SpeedX: +v.x.toFixed(3), SpeedY: +v.y.toFixed(3), SpeedZ: +v.z.toFixed(3),
    timestamp: +((GAME_CLOCK0 + t) * 1000).toFixed(1),
  };
}

/**
 * Play the race through the fake websocket the way the game reports it: every 0.1 s, if anything
 * changed, send a snapshot of every pilot's latest report. The pilot with `imu: true` also streams
 * IMU telemetry (30 Hz here). Returns the flights with which reports were visible.
 */
export async function playRace(vd, pilots, { sendStart = true, sendFinish = true, tickMs = 1 } = {}) {
  if (sendStart) vd.send({ racestatus: { raceAction: 'start' } });
  const flights = pilots.map((p) => ({ ...p, ev: flyRace(p), idx: -1, visible: new Set() }));
  const end = Math.max(...flights.map((f) => f.ev.at(-1).t)) + 1;
  // A report flagged splitTick is followed by one that only shows up in the next 100 ms update.
  for (const f of flights) {
    for (const e of f.ev) e.showAt = e.t;
    for (let i = 0; i < f.ev.length; i++) if (f.ev[i].splitTick) f.ev[i + 1].showAt = f.ev[i].t + 0.1;
  }
  const imuFlight = flights.find((f) => f.imu);
  const sub = IMU_HZ / 10;
  for (let step = 0; step / IMU_HZ <= end; step++) {
    const clock = step / IMU_HZ;
    if (imuFlight) vd.send({ imu: imuAt(imuFlight.ev, clock) });
    if (step % sub !== 0) {
      if (tickMs >= 10) await sleep(tickMs / sub);
      continue;
    }
    let dirty = false;
    for (const f of flights) {
      let i = f.idx;
      while (i + 1 < f.ev.length && f.ev[i + 1].showAt <= clock + 1e-9) i++;
      if (i !== f.idx) { f.idx = i; dirty = true; f.visible.add(i); }
    }
    if (dirty) {
      const order = [...flights].filter((f) => f.idx >= 0).sort((a, b) => {
        const ea = a.ev[a.idx], eb = b.ev[b.idx];
        return eb.lap * 1000 + eb.gate - (ea.lap * 1000 + ea.gate) || ea.t - eb.t;
      });
      const racedata = {};
      order.forEach((f, n) => {
        const e = f.ev[f.idx];
        racedata[f.name] = {
          position: String(n + 1),
          lap: String(e.lap),
          gate: String(e.gate),
          time: e.t.toFixed(3),
          finished: e.fin ? 'True' : 'False',
          colour: f.colour,
          uid: f.uid,
        };
      });
      vd.send({ racedata });
    }
    await sleep(tickMs >= 10 ? tickMs / sub : tickMs);
  }
  if (sendFinish) vd.send({ racestatus: { raceAction: 'race finished' } });
  await sleep(200);
  return flights;
}
