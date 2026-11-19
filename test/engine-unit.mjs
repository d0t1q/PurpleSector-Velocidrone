// Engine unit checks for cases that are awkward to drive end-to-end.
//   node test/engine-unit.mjs
import { Engine, emptyDb, pilotKey } from '../engine.mjs';

let failures = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: got ${JSON.stringify(got)}${ok ? '' : ` want ${JSON.stringify(want)}`}`);
};

// One pilot flying `laps` laps of a 12-gate track (gate 1 = start/finish, finish reports 13), 1.5 s per gate.
function fly(engine, name, laps, t0 = 1, dt = 1.5) {
  const send = (lap, gate, t, fin = false) =>
    engine.ingest({ racedata: { [name]: { position: '1', lap: String(lap), gate: String(gate), time: t.toFixed(3), finished: fin ? 'True' : 'False', colour: 'FF0000', uid: 1 } } });
  let t = t0;
  send(1, 1, t);
  for (let lap = 1; lap <= laps; lap++) {
    for (let g = 2; g <= 12; g++) send(lap, g, (t += dt));
    t += dt;
    if (lap < laps) send(lap + 1, 1, t);
    else send(lap, 13, t, true);
  }
}

// Unnamed track (timer connected after the game sent the session), renamed by the user, then later
// the game names the track: the renamed records should be folded into the named track.
{
  const e = new Engine(emptyDb());
  e.ingest({ racestatus: { raceAction: 'start' } });
  fly(e, 'Alice', 2);
  check('unnamed track created', Object.keys(e.db.tracks), ['g:1-12']);
  check('unnamed best lap', e.db.tracks['g:1-12'].pilots.alice.bestLap, 18);
  e.renameTrack('g:1-12', 'Split-S');

  e.ingest({ session: { trackName: 'Split-S', sceneryTitle: 'Football Stadium', raceLength: '2' } });
  e.ingest({ racestatus: { raceAction: 'start' } });
  fly(e, 'Bob', 1, 1, 1.4);
  check('unnamed folded into named track', Object.keys(e.db.tracks), ['n:football-stadium-split-s']);
  const t = e.db.tracks['n:football-stadium-split-s'];
  check('Alice records carried over', [t.pilots.alice?.bestLap, t.pilots.alice?.laps], [18, 2]);
  check('Bob recorded on named track', t.pilots.bob?.bestLap, 16.8);
}

// A differently named unnamed track must NOT be merged.
{
  const e = new Engine(emptyDb());
  e.ingest({ racestatus: { raceAction: 'start' } });
  fly(e, 'Alice', 1);
  e.renameTrack('g:1-12', 'Some Other Track');
  e.ingest({ session: { trackName: 'Split-S', sceneryTitle: 'Football Stadium' } });
  e.ingest({ racestatus: { raceAction: 'start' } });
  fly(e, 'Bob', 1);
  check('other-named unnamed track kept separate', Object.keys(e.db.tracks).sort(), ['g:1-12', 'n:football-stadium-split-s']);
}

// Race history: races are split even when the game doesn't announce them.
{
  const e = new Engine(emptyDb());
  e.ingest({ session: { trackName: 'Split-S', sceneryTitle: 'Football Stadium', raceLength: '2' } });
  e.ingest({ racestatus: { raceAction: 'start' } });
  e.ingest({ racestatus: { raceAction: 'start' } }); // countdown restarted: empty race replaced
  fly(e, 'Alice', 2);
  e.ingest({ racestatus: { raceAction: 'race finished' } });
  fly(e, 'Alice', 2, 1, 1.4); // next race, no "start" message
  const races = e.snapshot().history.races;
  check('two races (no empty one, implicit second start)', races.map((r) => r.no), [2, 1]);
  check('race 1 finished in 37 s', races[1].pilots[0].totalTime, 37);
  check('race 2 laps', races[0].pilots[0].laps.map((l) => l.lapTime), [16.8, 16.8]);
  check('race 2 sectors carry PB flags', races[0].pilots[0].laps[0].sectors.map((s) => s.pb), [true, true, true]);

  // Restart mid-race (lap counter back to 1 while "running") starts a new race too.
  e.ingest({ racestatus: { raceAction: 'start' } });
  const send = (lap, gate, t) => e.ingest({ racedata: { Alice: { position: '1', lap: String(lap), gate: String(gate), time: t.toFixed(3), finished: 'False', colour: 'FF0000', uid: 1 } } });
  send(1, 1, 1);
  for (let g = 2; g <= 12; g++) send(1, g, 1 + g);
  send(2, 1, 14); // lap 1 done
  send(1, 1, 1.2); // restarted from the menu, no message
  check('restart creates a new race', e.snapshot().history.races.length, 4);

  e.deleteRace(e.snapshot().history.races[0].id);
  check('delete race', e.snapshot().history.races.length, 3);
}

// Track named from the game's settings database (timer started after the room was created).
{
  const e = new Engine(emptyDb());
  e.setGameTrack({ trackName: 'Mini Rush', sceneryTitle: 'Sports Hall', playerName: 'Remy', raceLaps: 3 });
  check('last-picked track not shown until on a map', [e.liveSnapshot().trackName, e.liveSnapshot().trackId, e.liveSnapshot().plan], [null, null, null]);
  e.markOnMap(); // IMU started streaming: the drone exists
  check('named from game settings', [e.liveSnapshot().trackName, e.liveSnapshot().trackSource, e.liveSnapshot().trackGuessed], ['Mini Rush', 'game', false]);
  check('local pilot from game settings', e.localKey(), 'remy');
  e.ingest({ racestatus: { raceAction: 'start' } });
  check('race laps from game settings', e.currentRace().raceLaps, 3);
  fly(e, 'Remy', 1);
  check('records stored on the game-named track', Object.keys(e.db.tracks), ['n:sports-hall-mini-rush']);
  // Same name without a scenery = the same track; same name in another scenery = a different track.
  e.ingest({ session: { trackName: 'Mini Rush', sceneryTitle: '' } });
  check('same-named track without scenery is reused', e.trackId, 'n:sports-hall-mini-rush');
  e.ingest({ session: { trackName: 'Mini Rush', sceneryTitle: 'Dynamic Weather' } });
  check('same name in another scenery is a separate track', e.trackId, 'n:dynamic-weather-mini-rush');
}

// Holeshot: crossing the start gate then restarting before gate 2 still keeps the race.
{
  const e = new Engine(emptyDb());
  e.ingest({ session: { trackName: 'Split-S', sceneryTitle: 'Football Stadium' } });
  fly(e, 'Alice', 1); // learn the layout (no start signal + unknown layout: partial lap, no race)
  e.ingest({ racestatus: { raceAction: 'start' } });
  const send = (lap, gate, t) => e.ingest({ racedata: { Alice: { position: '1', lap: String(lap), gate: String(gate), time: t.toFixed(3), finished: 'False', colour: 'FF0000', uid: 1 } } });
  send(1, 1, 0.9);
  send(1, 1, 0.2); // restarted (time went backwards)
  const races = e.snapshot().history.races;
  check('holeshot-only race kept', races[1].pilots[0].holeshot?.time, 0.9);
  check('holeshot PB vs first race', races[1].pilots[0].holeshot?.pb, true);
  check('new race after restart', races.length, 2);
}

// Merge an unnamed track into a named one from the UI.
{
  const e = new Engine(emptyDb());
  e.ingest({ racestatus: { raceAction: 'start' } });
  fly(e, 'Alice', 2);
  e.setGameTrack({ trackName: 'Mini Rush', sceneryTitle: 'Sports Hall' });
  e.ingest({ racestatus: { raceAction: 'start' } });
  fly(e, 'Alice', 1, 1, 1.4);
  check('two tracks before merge', Object.keys(e.db.tracks).sort(), ['g:1-12', 'n:sports-hall-mini-rush']);
  e.mergeTrack('g:1-12', 'n:sports-hall-mini-rush');
  const t = e.db.tracks['n:sports-hall-mini-rush'];
  check('merged: one track, laps summed, best kept', [Object.keys(e.db.tracks), t.pilots.alice.laps, t.pilots.alice.bestLap], [['n:sports-hall-mini-rush'], 3, 16.8]);
  check('merged: races moved', e.db.races.map((r) => r.trackId), ['n:sports-hall-mini-rush', 'n:sports-hall-mini-rush']);
}

// The real game reports the start/finish gate's finish trigger as gate lastGate+1 ~0.03 s before
// the start trigger on every lap. It must close the lap, not become a 13th gate.
{
  const e = new Engine(emptyDb());
  e.ingest({ session: { trackName: 'Mini Rush', sceneryTitle: 'Sports Hall' } });
  e.ingest({ racestatus: { raceAction: 'start' } });
  const send = (lap, gate, t, fin = false) => e.ingest({ racedata: { Remy: { position: '1', lap: String(lap), gate: String(gate), time: t.toFixed(3), finished: fin ? 'True' : 'False', colour: 'FF0000', uid: 1 } } });
  let t = 1;
  send(1, 1, t);
  for (let lap = 1; lap <= 3; lap++) {
    for (let g = 2; g <= 12; g++) send(lap, g, (t += 2));
    t += 2;
    if (lap < 3) {
      send(lap, 13, t - 0.033); // finish trigger
      send(lap + 1, 1, t); // start trigger
    } else send(lap, 13, t, true);
  }
  const tr = e.db.tracks['n:sports-hall-mini-rush'];
  check('finish trigger: layout stays 12 gates', [tr.layout.lastGate, tr.layout.confirmed], [12, true]);
  check('finish trigger: no layout resets', e.live.events.filter((x) => x.type === 'layout').length, 0);
  check('finish trigger: laps end at the trigger', e.currentRace().pilots.remy.laps.map((l) => l.lapTime), [23.967, 24, 24.033]);
  check('finish trigger: 12 gate times per lap', e.currentRace().pilots.remy.laps.map((l) => l.cum.length), [12, 12, 12]);
  check('finish trigger: sector bests kept from lap 1', tr.pilots.remy.bestAt.every((x) => x != null), true);
}

// Startup repair: bests lost to a layout mix-up come back from race history; glitch laps go.
{
  const db = emptyDb();
  db.tracks['n:x'] = { id: 'n:x', name: 'X', sceneryTitle: '', layout: { startGate: 1, lastGate: 12, confirmed: true }, updated: 1,
    pilots: { remy: { name: 'Remy', best: [7.5, 7.8, 7.4], bestAt: [1, 1, 1], bestLap: 0, laps: 3, lastSeen: 1 } } };
  const cum = [2.526, 4.291, 5.604, 7.528, 9.26, 10.244, 12.56, 15.159, 16.628, 19.071, 21.017, 22.222];
  const cum13 = [7.515, 9.462, 10.701, 12.662, 14.492, 15.517, 17.535, 20.188, 21.681, 24.434, 26.533, 27.721, 27.754];
  db.races = [
    { id: 1, trackId: 'n:x', startedAt: 5, status: 'finished', raceLaps: 3, pilots: { remy: { name: 'Remy', laps: [{ lap: 1, lapTime: 0, sectors: [] }], finished: true, totalTime: 3.5 } } },
    { id: 2, trackId: 'n:x', startedAt: 6, status: 'finished', raceLaps: 3, pilots: { remy: { name: 'Remy', holeshot: { time: 0.95 }, laps: [{ lap: 1, lapTime: 22.222, cum, sectors: [] }, { lap: 2, lapTime: 27.754, cum: cum13, sectors: [] }], finished: false } } },
  ];
  db.raceSeq = 2;
  const e = new Engine(db);
  const r = e.db.tracks['n:x'].pilots.remy;
  check('repair: glitch lap removed, finish undone', [e.db.races[0].pilots.remy.laps.length, e.db.races[0].pilots.remy.finished], [0, false]);
  check('repair: best lap from history (0 dropped)', r.bestLap, 22.222);
  check('repair: sector bests restored', r.best, [7.5, 7.526, 7.063]);
  check('repair: holeshot', r.hsBest, 0.95);
  check('repair: gate splits (13-point lap normalised)', [r.segBest.length, r.segBest[11]], [12, 1.205]);
  check('repair: PB profile = fastest lap', r.pbCumLap, 22.222);
  const fixed = e.db.races[1].pilots.remy.laps[1];
  check('repair: 13-point lap rewritten to 12 gates', [fixed.cum.length, fixed.cum[11], fixed.sectors.map((x) => x.time)], [12, 27.754, [12.662, 7.526, 7.566]]);
}

// Finished means finished: flying on after the line (even if the game clears its finished flag and
// keeps counting laps) records nothing; a real restart (race clock back to 0) starts a new race.
{
  const e = new Engine(emptyDb());
  e.ingest({ session: { trackName: 'Split-S', sceneryTitle: 'Football Stadium', raceLength: '2' } });
  e.ingest({ racestatus: { raceAction: 'start' } });
  fly(e, 'Alice', 2);
  const send = (lap, gate, t, fin = false) => e.ingest({ racedata: { Alice: { position: '1', lap: String(lap), gate: String(gate), time: t.toFixed(3), finished: fin ? 'True' : 'False', colour: 'FF0000', uid: 1 } } });
  const before = JSON.stringify(e.db);
  let t = 38;
  send(3, 1, t);
  for (let g = 2; g <= 12; g++) send(3, g, (t += 1.5));
  send(4, 1, (t += 1.5));
  send(4, 2, (t += 1.5));
  check('nothing recorded after the finish', JSON.stringify(e.db) === before, true);
  check('still shown as finished', e.liveSnapshot().pilots[0].finished, true);
  send(1, 1, 1.1); // restarted: race clock back near 0
  check('restart after finish starts a new race', e.snapshot().history.races.length, 2);
}

// Sessions: fresh on every start, closed when the map is reloaded/changed or the game closes.
{
  const e = new Engine(emptyDb());
  check('no session until the first race', e.sessionId, null);
  e.ingest({ session: { trackName: 'Split-S', sceneryTitle: 'Football Stadium', raceLength: '2' } });
  e.ingest({ racestatus: { raceAction: 'start' } });
  fly(e, 'Alice', 2);
  e.ingest({ racestatus: { raceAction: 'start' } });
  fly(e, 'Alice', 2, 1, 1.4);
  const s1 = e.sessionId;
  check('two races in the first session, numbered 1 and 2', e.historySnapshot().races.map((r) => [r.sessionId, r.no]), [[s1, 2], [s1, 1]]);
  e.ingest({ session: { trackName: 'Split-S', sceneryTitle: 'Football Stadium', raceLength: '2' } }); // map reloaded
  check('map reload closes the session', [e.sessionId, e.db.sessions[0].endReason, e.liveSnapshot().pilots.length], [null, 'new map', 0]);
  e.ingest({ racestatus: { raceAction: 'start' } });
  fly(e, 'Alice', 1);
  check('next race starts a new session at race 1', [e.sessionId !== s1, e.historySnapshot().races[0].no], [true, 1]);
  e.ingest({ racestatus: { raceAction: 'start' } }); // countdown, then the game closes before anyone flies
  e.endSession('game closed');
  check('session closed on game close, empty race dropped', [e.db.sessions.at(-1).endReason, e.db.races.length], ['game closed', 3]);
  e.ingest({ racestatus: { raceAction: 'start' } });
  e.endSession('left map');
  check('a session where nothing was flown is dropped', e.db.sessions.length, 2);
  e.setGameTrack({ trackName: 'Split-S', sceneryTitle: 'Football Stadium' });
  e.ingest({ racestatus: { raceAction: 'start' } });
  fly(e, 'Alice', 1);
  const before = e.sessionId;
  e.setGameTrack({ trackName: 'Mini Rush', sceneryTitle: 'Sports Hall' });
  check('changing track in the game closes the session', [e.sessionId, e.db.sessions.find((x) => x.id === before).endReason], [null, 'changed track']);

  // A timer that was killed leaves its session open: the next start closes it.
  e.ingest({ racestatus: { raceAction: 'start' } });
  fly(e, 'Alice', 1, 1, 1.2);
  const db = JSON.parse(JSON.stringify(e.db));
  const e2 = new Engine(db);
  check('restart: fresh, previous open session closed', [e2.sessionId, db.sessions.at(-1).endReason, db.sessions.every((x) => x.endedAt != null)], [null, 'timer stopped', true]);
  const first = e2.db.sessions[0].id;
  check('delete a past session with its races', [e2.deleteSession(first), e2.db.races.some((r) => r.sessionId === first), e2.db.sessions.some((x) => x.id === first)], [true, false, false]);
}

// A new track (gate count not confirmed until a finish): the finish trigger arriving 0.3 s before the
// start gate on lap 2 must not be taken for an extra gate (it used to wipe the split bests, so every
// split of lap 3 showed as a track best).
{
  const e = new Engine(emptyDb());
  e.ingest({ session: { trackName: 'Barnstorm', sceneryTitle: 'Farm' } });
  e.ingest({ racestatus: { raceAction: 'start' } });
  const send = (lap, gate, t, fin = false) => e.ingest({ racedata: { P: { position: '1', lap: String(lap), gate: String(gate), time: t.toFixed(3), finished: fin ? 'True' : 'False', colour: 'FF0000', uid: 1 } } });
  const split = { 1: [1.9, 1.5], 2: [1.78, 1.5], 3: [1.82, 1.6] }; // [gate 2->3, every other split]
  let t = 1;
  send(1, 1, t);
  for (let lap = 1; lap <= 3; lap++) {
    for (let g = 2; g <= 12; g++) send(lap, g, (t += g === 3 ? split[lap][0] : split[lap][1]));
    t += 1.5;
    if (lap === 1) send(2, 1, t);
    else if (lap === 2) {
      send(2, 13, t - 0.3); // finish trigger, 0.3 s before the start gate
      send(3, 1, t);
    } else send(3, 13, t, true);
  }
  const laps = e.currentRace().pilots.p.laps;
  check('slow trigger: no layout change', [e.track().layout.lastGate, e.live.events.filter((x) => x.type === 'layout').length], [12, 0]);
  check('lap 2 ends at the trigger (0.3 s before the line)', laps[1].lapTime, 17.98);
  check('split 2->3 colours: PB, PB, slower', laps.map((l) => l.segFlags[1]), [2, 2, 0]);
  check('lap 3 other splits slower than PB', laps[2].segFlags.slice(2, 11).every((f) => f === 0), true);
}

// Purple = all-time personal best; green = best of the current session; yellow = neither.
{
  const e = new Engine(emptyDb());
  const lap = () => { const x = e.currentRace().pilots.alice.laps[0]; return x.lapPb ? 'purple' : x.lapSb ? 'green' : 'yellow'; };
  const race = (dt) => { e.ingest({ racestatus: { raceAction: 'start' } }); fly(e, 'Alice', 1, 1, dt); return lap(); };
  e.ingest({ session: { trackName: 'Split-S', sceneryTitle: 'Football Stadium', raceLength: '1' } });
  check('session 1: 18.0 first ever, 18.6 slower', [race(1.5), race(1.55)], ['purple', 'yellow']);
  e.ingest({ session: { trackName: 'Split-S', sceneryTitle: 'Football Stadium', raceLength: '1' } }); // new session
  check('session 2: 18.6 / 18.36 / 18.84 / 17.4', [race(1.55), race(1.53), race(1.57), race(1.45)], ['green', 'green', 'yellow', 'purple']);
}

// Colours saved wrongly by an older version are recalculated from the history at startup.
{
  const db = emptyDb();
  db.tracks['n:b'] = { id: 'n:b', name: 'B', layout: { startGate: 1, lastGate: 4, confirmed: true }, updated: 1, pilots: { p: { name: 'P', best: [1, 1, 1], bestAt: [1, 1, 1], bestLap: 4, laps: 3, lastSeen: 1 } } };
  const lap = (n, cum, flags) => ({ lap: n, lapTime: cum[3], start: (n - 1) * 5, end: (n - 1) * 5 + cum[3], cum, segFlags: flags, sectors: [] });
  db.races = [{ id: 1, trackId: 'n:b', startedAt: 1, status: 'finished', raceLaps: 3, pilots: { p: { name: 'P', laps: [
    lap(1, [1.0, 2.0, 3.0, 4.0], [2, 2, 2, 2]),
    lap(2, [0.9, 2.0, 3.1, 4.2], [2, 0, 0, 0]),
    lap(3, [0.95, 1.9, 2.9, 3.9], [2, 2, 2, 2]), // wrong: 0.95 is slower than 0.9
  ], finished: true, totalTime: 15 } } }];
  const e = new Engine(db);
  const L = e.db.races[0].pilots.p.laps;
  check('recoloured: lap 3 = slower, faster (PB), equal, equal', L[2].segFlags, [0, 2, 0, 0]);
  check('recoloured: lap flags [PB, session best]', L.map((l) => [l.lapPb, l.lapSb]), [[true, true], [false, false], [true, true]]);
}

// Leaving the map (or the game closing) closes the session and clears the track from the display.
{
  const e = new Engine(emptyDb());
  e.setGameTrack({ trackName: 'Barnstorm', sceneryTitle: 'Farm' });
  e.ingest({ racestatus: { raceAction: 'start' } });
  fly(e, 'Alice', 1);
  check('on the map while racing', [e.liveSnapshot().onMap, e.liveSnapshot().trackName], [true, 'Barnstorm']);
  e.leaveMap('left map');
  check('left the map: session saved, track cleared', [e.db.sessions.at(-1).endReason, e.liveSnapshot().trackName, e.liveSnapshot().pilots.length], ['left map', null, 0]);
  e.ingest({ session: { trackName: 'Barnstorm', sceneryTitle: 'Farm' } });
  check('map loaded again: track shown', e.liveSnapshot().trackName, 'Barnstorm');
}

// Data management: delete sessions / telemetry only / tracks / records; rebuild records from history.
{
  const removed = [], telGone = [];
  const e = new Engine(emptyDb(), { onRacesRemoved: (ids) => removed.push(...ids), onTelemetryRemoved: (ids) => telGone.push(...ids) });
  e.ingest({ session: { trackName: 'Split-S', sceneryTitle: 'Football Stadium', raceLength: '2' } });
  e.ingest({ racestatus: { raceAction: 'start' } });
  fly(e, 'Alice', 2, 1, 1.2); // fast session (to be deleted)
  e.markRaceTelemetry(e.raceId);
  const bad = e.sessionId;
  e.ingest({ session: { trackName: 'Split-S', sceneryTitle: 'Football Stadium', raceLength: '2' } });
  e.ingest({ racestatus: { raceAction: 'start' } });
  fly(e, 'Alice', 2, 1, 1.5);
  e.markRaceTelemetry(e.raceId);
  const tid = 'n:football-stadium-split-s';
  check('records include the fast session', e.db.tracks[tid].pilots.alice.bestLap, 14.4);
  const keep = e.sessionId;
  e.ingest({ session: { trackName: 'Split-S', sceneryTitle: 'Football Stadium' } }); // closes `keep`
  check('telemetry-only delete keeps the races', [e.deleteData({ sessions: [keep], telemetryOnly: true }).telemetry, e.db.races.filter((r) => r.sessionId === keep).length, telGone.length], [1, 1, 1]);
  const out = e.deleteData({ sessions: [bad] });
  check('delete a session: its races go', [out.sessions, out.races, e.db.sessions.some((x) => x.id === bad), removed.length], [1, 1, false, 1]);
  check('records still remember the deleted laps', e.db.tracks[tid].pilots.alice.bestLap, 14.4);
  e.rebuildRecords(tid);
  check('rebuild from history drops them', [e.db.tracks[tid].pilots.alice.bestLap, e.db.tracks[tid].pilots.alice.laps], [18, 2]);
  check('delete records + track', [e.deleteData({ records: [[tid, 'alice']] }).records, e.deleteData({ tracks: [tid] }).tracks, Object.keys(e.db.tracks).length, e.db.races.length], [1, 1, 0, 0]);
}

// Races saved before sessions existed are grouped into sessions (same track, < 20 min apart).
{
  const db = emptyDb();
  db.tracks['n:x'] = { id: 'n:x', name: 'X', layout: null, pilots: {} };
  const race = (id, startedAt) => ({ id, trackId: 'n:x', startedAt, status: 'finished', pilots: { a: { name: 'A', laps: [{ lap: 1, lapTime: 20, start: 1, end: 21 }], finished: true, totalTime: 21 } } });
  db.races = [race(1, 0), race(2, 5 * 60e3), race(3, 60 * 60e3)];
  const e = new Engine(db);
  check('legacy races grouped into 2 sessions', e.db.races.map((r) => r.sessionId), [1, 1, 2]);
  check('legacy sessions closed', e.db.sessions.map((x) => x.endReason), ['imported', 'imported']);
}

// Release audit regressions.
{
  // Pilot names that would clash with Object.prototype are stored under safe keys.
  check('safe pilot keys', [pilotKey('Constructor'), pilotKey('__proto__'), pilotKey('Alice')], ['_constructor', '___proto__', 'alice']);
  // Ids from the web page can't reach Object.prototype.
  const e = new Engine(emptyDb());
  check('web ids: __proto__ / constructor rejected', [e.renameTrack('__proto__', 'X'), e.trackData('constructor'), e.deletePilot('__proto__', 'x'), ({}).displayName], [false, null, false, undefined]);
  // Polling the game's settings with an unchanged track is a no-op (no session end, no saves).
  let saves = 0;
  const g = new Engine(emptyDb(), { onChange: (d) => d && saves++ });
  g.setGameTrack({ trackName: 'Mini <b>Rush</b>', sceneryTitle: undefined, playerName: 'P', raceLaps: null });
  g.ingest({ racestatus: { raceAction: 'start' } });
  const sid = g.sessionId;
  const before = saves;
  for (let i = 0; i < 5; i++) g.setGameTrack({ trackName: 'Mini <b>Rush</b>', sceneryTitle: undefined, playerName: 'P', raceLaps: null });
  check('unchanged game-settings polls: no session end, no saves', [g.sessionId === sid, saves - before], [true, 0]);
  // Race ids never go below ids already saved.
  const db = emptyDb();
  db.races = [{ id: 7, trackId: 'x', startedAt: 1, status: 'finished', pilots: {} }];
  db.raceSeq = 2;
  check('raceSeq never below saved race ids', new Engine(db).db.raceSeq, 7);
}

// A 40-gate track whose start gate reports as gate 2 (gates 3..41, finish trigger 42), 1.5 s per gate.
function flyLong(e, name, { laps, t0 = 5, earlyFinish = null }) {
  const send = (lap, gate, t, fin = false) =>
    e.ingest({ racedata: { [name]: { position: '1', lap: String(lap), gate: String(gate), time: t.toFixed(3), finished: fin ? 'True' : 'False', colour: 'FF0000', uid: 1 } } });
  let t = t0;
  send(1, 2, t);
  for (let lap = 1; lap <= laps; lap++) {
    for (let g = 3; g <= 41; g++) {
      t += 1.5;
      if (earlyFinish && earlyFinish.lap === lap && earlyFinish.gate === g) return send(lap, g, t, true);
      send(lap, g, t);
    }
    t += 1.5;
    if (lap < laps) {
      send(lap, 42, t - 0.033); // finish trigger
      send(lap + 1, 2, t);
    } else send(lap, 42, t, true);
  }
}

// Seen on San Pablo x DRF 004: the game flagged "finished" at gate 15 of lap 2 (of 3) on a 40-gate
// track. Taking that as the finish line cut the layout to 13 gates for good, and every later lap
// "ended" at gate 15 (a 19 s lap PB on a 65 s track). It must be a lap cut short instead.
{
  const e = new Engine(emptyDb());
  e.ingest({ session: { trackName: 'Long', sceneryTitle: 'S', raceLength: '3' } });
  e.ingest({ racestatus: { raceAction: 'start' } });
  flyLong(e, 'Pia', { laps: 3, earlyFinish: { lap: 2, gate: 15 } });
  const tr = e.track();
  const pe = e.currentRace().pilots.pia;
  check('early finish: layout stays 40 gates', [tr.layout.startGate, tr.layout.lastGate, e.live.events.filter((x) => x.type === 'layout').length], [2, 41, 0]);
  check('early finish: lap 1 full, lap 2 cut', pe.laps.map((l) => [l.lapTime, !!l.incomplete]), [[59.967, false], [null, true]]);
  check('early finish: lap 1 keeps all 40 gate times', pe.laps[0].cum.length, 40);
  check('early finish: best lap is the full lap', tr.pilots.pia.bestLap, 59.967);
  check('early finish: not a race finish', [pe.finished, pe.stopped, pe.stoppedLap, pe.totalTime], [false, 'finished early', 2, null]);
  e.ingest({ racedata: { Pia: { position: '1', lap: '3', gate: '2', time: '200', finished: 'False' } } });
  check('early finish: flying on records nothing', pe.laps.length, 2);
  // A real finish next race confirms the 40 gates.
  e.ingest({ racestatus: { raceAction: 'start' } });
  flyLong(e, 'Pia', { laps: 2 });
  check('early finish: next race confirms 40 gates', [tr.layout.lastGate, tr.layout.confirmed], [41, true]);
  check('early finish: next race laps', e.currentRace().pilots.pia.laps.map((l) => l.lapTime), [59.967, 60.033]);
}

// A layout confirmed wrongly by an older version (13 of the 40 gates): laps still run to the lap
// line instead of ending at gate 15, the finish puts the layout right, and laps saved for another
// layout are left as they were (they used to be cut down to fit, losing their gate times).
{
  const db = emptyDb();
  const long = Array.from({ length: 40 }, (_, i) => 1.5 * (i + 1));
  db.tracks['n:s-long'] = { id: 'n:s-long', name: 'Long', sceneryTitle: 'S', layout: { startGate: 2, lastGate: 14, confirmed: true }, updated: 1,
    pilots: { pia: { name: 'Pia', best: [null, null, null], bestAt: [null, null, null], bestLap: 60, laps: 1, lastSeen: 1 } } };
  db.races = [{ id: 1, sessionId: 1, trackId: 'n:s-long', no: 1, startedAt: 1, status: 'finished', raceLaps: 3,
    pilots: { pia: { name: 'Pia', laps: [{ lap: 1, lapTime: 60, start: 5, end: 65, cum: long, sectors: [] }], finished: false } } }];
  db.sessions = [{ id: 1, trackId: 'n:s-long', startedAt: 1, endedAt: 2, endReason: 'game closed' }];
  db.sessionSeq = 1;
  const e = new Engine(db);
  check('saved 40-gate lap not cut to fit 13 gates', db.races[0].pilots.pia.laps[0].cum.length, 40);
  e.ingest({ session: { trackName: 'Long', sceneryTitle: 'S', raceLength: '2' } });
  e.ingest({ racestatus: { raceAction: 'start' } });
  flyLong(e, 'Pia', { laps: 2 });
  const tr = e.track();
  check('wrong layout: laps run to the line', e.currentRace().pilots.pia.laps.map((l) => l.lapTime), [59.967, 60.033]);
  check('wrong layout: put right by the finish', [tr.layout.lastGate, tr.layout.confirmed], [41, true]);
  check('wrong layout: no fake lap record', tr.pilots.pia.bestLap, 59.967);
}

// IMU messages must not trigger UI updates.
{
  let changes = 0;
  const e = new Engine(emptyDb(), { onChange: () => changes++ });
  for (let i = 0; i < 100; i++) e.ingest({ imu: { roll: 0, pitch: 0, yaw: 0 } });
  check('imu ignored', changes, 0);
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
