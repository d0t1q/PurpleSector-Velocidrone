// End-to-end test: fake Velocidrone feed -> sector-timer.mjs -> /api/state.
// Simulates races exactly the way the game reports them (see engine.mjs header) and checks that the
// recorded holeshots, gate splits, sectors, laps, race history and telemetry match what was flown.
//
//   node test/run-sim.mjs            (exits non-zero on failure)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeVelocidrone } from './fake-velocidrone.mjs';
import { START_GATE, LAST_GATE, ENDS, G, playRace } from './sim-lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const VD_PORT = 46003;
const HTTP_PORT = 48090;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'purplesector-test-'));
const DATA = path.join(tmp, 'sectors.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r3 = (x) => Math.round(x * 1000) / 1000;
const keyOf = (name) => name.toLowerCase().replace(/<[^>]*>/g, '').trim();

/** What the timer should have recorded, from the reports it could actually see. */
function expected(flights) {
  const out = {};
  for (const f of flights) {
    const seen = (e) => e && f.visible.has(f.ev.indexOf(e));
    const tAt = (lap, gate) => f.ev.find((e) => e.lap === lap && e.gate === gate && !e.fin);
    const res = { best: [null, null, null], bestLap: null, laps: 0, hs: r3(f.ev[0].t), segBest: Array(G).fill(null), cums: [] };
    // A lap ends at the finish trigger (gate lastGate+1) when that report was seen, else at the line.
    const lapEnd = (lap) => {
      if (lap === f.laps) return f.ev.find((e) => e.fin).t;
      const trig = f.ev.find((e) => e.lap === lap && e.trigger);
      return seen(trig) ? trig.t : f.ev.find((e) => e.lap === lap + 1 && e.gate === START_GATE).t;
    };
    for (let lap = 1; lap <= f.laps; lap++) {
      const start = lap === 1 ? f.ev[0].t : lapEnd(lap - 1);
      const endEv = { t: lapEnd(lap) };
      const b1 = tAt(lap, ENDS[0]), b2 = tAt(lap, ENDS[1]);
      const ok1 = seen(b1), ok2 = seen(b2);
      const s = [b1.t - start, b2.t - b1.t, endEv.t - b2.t].map((x) => r3(r3(x)));
      const elig = [ok1, ok1 && ok2, ok2];
      for (let k = 0; k < 3; k++) if (elig[k] && (res.best[k] == null || s[k] < res.best[k])) res.best[k] = s[k];
      const lt = r3(endEv.t - start);
      if (res.bestLap == null || lt < res.bestLap) res.bestLap = lt;
      res.laps++;
      const cum = [];
      for (let g = START_GATE + 1; g <= LAST_GATE; g++) {
        const e = tAt(lap, g);
        cum.push(seen(e) ? r3(e.t - start) : null);
      }
      cum.push(lt);
      res.cums.push(cum);
      cum.forEach((c, i) => {
        if (c == null || (i > 0 && cum[i - 1] == null)) return;
        const seg = r3(c - (i ? cum[i - 1] : 0));
        if (res.segBest[i] == null || seg < res.segBest[i]) res.segBest[i] = seg;
      });
    }
    out[keyOf(f.name)] = res;
  }
  return out;
}

function merge(a, b) {
  const out = structuredClone(a);
  for (const [k, v] of Object.entries(b)) {
    if (!out[k]) { out[k] = v; continue; }
    for (let s = 0; s < 3; s++) if (v.best[s] != null && (out[k].best[s] == null || v.best[s] < out[k].best[s])) out[k].best[s] = v.best[s];
    if (v.bestLap != null && (out[k].bestLap == null || v.bestLap < out[k].bestLap)) out[k].bestLap = v.bestLap;
    if (v.hs < out[k].hs) out[k].hs = v.hs;
    out[k].segBest = out[k].segBest.map((x, i) => (v.segBest[i] != null && (x == null || v.segBest[i] < x) ? v.segBest[i] : x));
    out[k].laps += v.laps;
  }
  return out;
}

let failures = 0;
function check(label, actual, want) {
  const close = (a, b) => (a == null && b == null) || (a != null && b != null && Math.abs(a - b) < 0.0015);
  const numeric = (v) => v == null || typeof v === 'number';
  const ok = Array.isArray(want)
    ? (want.every(numeric) ? want.every((w, i) => close(actual?.[i], w)) && actual?.length === want.length : JSON.stringify(actual) === JSON.stringify(want))
    : typeof want === 'number' ? close(actual, want) : actual === want;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: got ${JSON.stringify(actual)}${ok ? '' : ` want ${JSON.stringify(want)}`}`);
}

function startTimer() {
  const p = spawn(process.execPath, [path.join(here, '..', 'sector-timer.mjs'),
    '--velocidrone', `ws://127.0.0.1:${VD_PORT}/velocidrone`, '--port', String(HTTP_PORT), '--data', DATA, '--no-game-data'], { stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.on('data', (d) => process.env.VERBOSE && process.stdout.write('[timer] ' + d));
  p.stderr.on('data', (d) => process.stdout.write('[timer:err] ' + d));
  return p;
}
const stopTimer = (p) => new Promise((r) => { p.on('exit', r); p.kill('SIGINT'); });
const get = async (p) => (await fetch(`http://127.0.0.1:${HTTP_PORT}${p}`)).json();
const state = () => get('/api/state');

const vd = await startFakeVelocidrone(VD_PORT);
let timer = startTimer();
await vd.waitConnected();
await sleep(300);

// ---- Race 1: session known, three pilots, one tight double gate on a sector boundary ----
vd.send({ session: { playerName: 'Alice', sessionName: 'Thursday', sceneryTitle: 'Football Stadium', trackName: 'Split-S', raceLength: '3', RaceMode: 'Race', quadType: '5"', quadSize: '5' } });
vd.send({ racetype: { raceMode: 'Race', raceFormat: 'Laps', raceLaps: '3' } });
const race1 = await playRace(vd, [
  { name: 'Alice', colour: 'FF3B30', uid: 101, laps: 3, pace: 1.5, imu: true },
  { name: 'Bob', colour: '34C759', uid: 102, laps: 3, pace: 1.6, quirks: { tightGate: { lap: 2, gate: ENDS[0] }, lateFinishFlag: true } },
  { name: 'Chen <color=#ff0>Wei</color>', colour: '0A84FF', uid: 103, laps: 3, pace: 1.7 },
]);
await sleep(300);
let st = await state();
let track = st.history.tracks.find((t) => t.id === st.live.trackId);
let want = expected(race1);
console.log('\nRace 1');
check('track name', track?.name, 'Split-S');
check('layout start gate', track?.layout?.startGate, START_GATE);
check('layout last gate', track?.layout?.lastGate, LAST_GATE);
check('layout confirmed by finish', track?.layout?.confirmed, true);
check('sector ends', track?.plan?.ends, ENDS);
for (const [key, w] of Object.entries(want)) {
  const r = track.records.find((x) => x.key === key);
  check(`${key} best sectors`, r?.best, w.best);
  check(`${key} best lap`, r?.bestLap, w.bestLap);
  check(`${key} laps`, r?.laps, w.laps);
  check(`${key} best holeshot`, r?.hsBest, w.hs);
  check(`${key} best gate splits`, r?.segBest, w.segBest);
}
check('scenario: Bob lap-2 boundary gate never reported', race1[1].visible.has(race1[1].ev.findIndex((e) => e.lap === 2 && e.gate === ENDS[0])), false);
check('ping/getpilots sent to game', vd.received.some((m) => m.includes('getpilots')), true);
check('finish triggers seen but never taken for a 13th gate', [race1.some((f) => f.ev.some((e, i) => e.trigger && f.visible.has(i))), st.live.events.some((e) => e.type === 'layout')], [true, false]);
let r1 = st.history.races[0];
const bobR1 = r1.pilots.find((p) => p.key === 'bob');
check('Bob lap 2 gate times (missed gate = null)', bobR1.laps[1].cum, want.bob.cums[1]);
check('Bob lap 2 merged splits not flagged', [bobR1.laps[1].segFlags[ENDS[0] - START_GATE - 1], bobR1.laps[1].segFlags[ENDS[0] - START_GATE]], [null, null]);
check('Alice race holeshot', r1.pilots.find((p) => p.key === 'alice').holeshot?.time, want.alice.hs);
check('live gaps: leader has none, others positive', st.live.pilots.map((p, i) => (i === 0 ? p.gap === null : p.gap > 0)), [true, true, true]);
check('finish order = race time order', st.live.pilots.map((p) => p.key), Object.entries(want).sort((a, b) => race1.find((f) => keyOf(f.name) === a[0]).ev.at(-1).t - race1.find((f) => keyOf(f.name) === b[0]).ev.at(-1).t).map((x) => x[0]));

console.log('\nTelemetry (Alice streams IMU)');
check('local pilot', st.live.localKey, 'alice');
check('race marked with telemetry', r1.tel, true);
const tel1 = await get(`/api/telemetry?race=${r1.id}`);
check('telemetry laps for Alice', Object.keys(tel1.alice?.laps || {}), ['1', '2', '3']);
const lap1 = tel1.alice?.laps?.['1'];
check('lap telemetry has ~20 Hz samples', lap1 && Math.abs(lap1.t.length - want.alice.cums[0][G - 1] * 20) < 3, true);
check('lap telemetry gate positions', lap1?.gates?.length, G);
const td = await get(`/api/trackdata?id=${encodeURIComponent(track.id)}`);
check('track map built', td.map?.x?.length > 50, true);
check('PB reference lap stored', td.refs?.alice?.lapTime, want.alice.bestLap);
// The simulated course puts gate k at angle 2πk/G: the map's gate positions must line up.
const gk = td.map.gates.find((g) => g.i === 2);
const ex = 55 * Math.cos((2 * Math.PI * 3) / G) + 14 * Math.cos((3 * 2 * Math.PI * 3) / G);
check('gate 4 placed on the course (within 3 m)', Math.abs(td.map.x[gk.k] - ex) < 3, true);

// ---- Restart the timer: records must survive, and a returning pilot fights their old sectors ----
await sleep(1200); // let the debounced save land
await stopTimer(timer);
check('records file written', fs.existsSync(DATA), true);
const reconnected = vd.waitNextConnection();
timer = startTimer();
await reconnected;
await sleep(300);

// ---- Race 2: no session message (timer restarted mid-session); Alice comes back, Dee is new ----
console.log('\nRace 2 (after timer restart, no session message)');
const race2 = await playRace(vd, [
  { name: 'Alice', colour: 'FF3B30', uid: 101, laps: 3, pace: 1.45 },
  { name: 'Dee', colour: 'FF9F0A', uid: 104, laps: 3, pace: 1.55 },
]);
await sleep(300);
st = await state();
track = st.history.tracks.find((t) => t.id === st.live.trackId);
want = merge(expected(race1), expected(race2));
check('same track reused', track?.id, 'n:football-stadium-split-s');
check('track guessed (no session)', st.live.trackGuessed, true);
for (const key of ['alice', 'bob', 'dee']) {
  const r = track.records.find((x) => x.key === key);
  check(`${key} best sectors`, r?.best, want[key].best);
  check(`${key} best lap`, r?.bestLap, want[key].bestLap);
  check(`${key} laps`, r?.laps, want[key].laps);
  check(`${key} best gate splits`, r?.segBest, want[key].segBest);
}
const alice = st.live.pilots.find((p) => p.key === 'alice');
check('Alice live sectors have deltas vs old PBs', alice?.last?.sectors?.every((s) => s.delta != null), true);
check('theoretical = sum of best sectors', track.records.find((x) => x.key === 'alice')?.theoretical, r3(want.alice.best.reduce((a, b) => a + b, 0)));
check('ultimate = sum of best gate splits', track.records.find((x) => x.key === 'alice')?.ultimate, r3(want.alice.segBest.reduce((a, b) => a + b, 0)));

// ---- Race history ----
console.log('\nRace history');
let races = st.history.races.filter((r) => r.trackId === track.id);
check('timer restart split the sessions (race 1 of each)', races.map((r) => r.no), [1, 1]);
check('first session closed when the timer stopped', st.history.sessions.find((x) => x.id === races[1].sessionId)?.endReason, 'timer stopped');
check('second session is the current one', st.history.sessions.find((x) => x.id === races[0].sessionId)?.current, true);
check('race 1 pilots', races[1].pilots.map((p) => p.key).sort(), ['alice', 'bob', 'chen wei']);
check('race 2 pilots', races[0].pilots.map((p) => p.key).sort(), ['alice', 'dee']);
check('race 1 laps per pilot', races[1].pilots.map((p) => p.laps.length), [3, 3, 3]);
check('race 1 all finished', races[1].pilots.every((p) => p.finished && p.totalTime != null), true);
const aliceR1 = races[1].pilots.find((p) => p.key === 'alice');
check('race 1 Alice race time = her finish crossing', aliceR1.totalTime, r3(race1[0].ev.find((e) => e.fin).t));
check('race 1 Alice lap 1 gate times', aliceR1.laps[0].cum, expected(race1).alice.cums[0]);
check('race statuses', races.map((r) => r.status), ['finished', 'finished']);

// ---- Race 3: restart from the menu in the middle of lap 2 ----
console.log('\nRace 3 (restart mid-race keeps what was flown)');
const cut = await playRace(vd, [{ name: 'Alice', colour: 'FF3B30', uid: 101, laps: 3, pace: 1.5, quirks: { restartAt: { lap: 2, gate: 6 } } }], { sendFinish: false });
await playRace(vd, [{ name: 'Alice', colour: 'FF3B30', uid: 101, laps: 3, pace: 1.5 }], { sendStart: false });
await sleep(300);
st = await state();
races = st.history.races.filter((r) => r.trackId === track.id);
check('restart made a separate race (same session)', races.map((r) => r.no), [3, 2, 1, 1]);
const cutEntry = races[1].pilots[0];
check('cut race keeps lap 1 + lap 2 so far', cutEntry.laps.map((l) => [l.lap, l.lapTime != null, !!l.incomplete]), [[1, true, false], [2, false, true]]);
check('lap 2 kept gate times up to gate 6', cutEntry.laps[1].cum.map((c) => c != null), [true, true, true, true, true, false, false, false, false, false, false, false]);
check('lap 2 kept its finished sector', cutEntry.laps[1].sectors.length, 1);
check('marked as restarted on lap 2', [cutEntry.stopped, cutEntry.stoppedLap], ['restart', 2]);
check('cut race holeshot kept', cutEntry.holeshot?.time, r3(cut[0].ev[0].t));
check('next race complete', races[0].pilots[0].laps.length, 3);

// ---- Race 4: someone joins mid-race (timer missed their lap start) ----
console.log('\nMid-lap first sighting');
vd.send({ racedata: { Eve: { position: '1', lap: '2', gate: '7', time: '30.100', finished: 'False', colour: 'FFFFFF', uid: 105 } } });
await sleep(100);
st = await state();
check('Eve partial lap not timed', st.live.pilots.find((p) => p.key === 'eve')?.current?.partial, true);

await stopTimer(timer);
vd.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
