// Preview the UI without the game: runs a fake Velocidrone feed with simulated races in real time,
// plus PurpleSector pointed at it (separate data file, so real records are untouched).
//
//   node test/demo.mjs   ->  open http://127.0.0.1:8091
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeVelocidrone } from './fake-velocidrone.mjs';
import { playRace } from './sim-lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const VD_PORT = 46013;
const HTTP_PORT = Number(process.env.PORT || 8091);
const SPEED = Number(process.env.SPEED || 1); // e.g. SPEED=4 to fly races 4x faster
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'purplesector-demo-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const vd = await startFakeVelocidrone(VD_PORT);
const timer = spawn(process.execPath, [path.join(here, '..', 'sector-timer.mjs'), '--velocidrone',
  `ws://127.0.0.1:${VD_PORT}/velocidrone`, '--port', String(HTTP_PORT), '--data', path.join(tmp, 'sectors.json'), '--no-game-data'], { stdio: 'inherit' });
const quit = () => { timer.kill('SIGINT'); vd.close(); fs.rmSync(tmp, { recursive: true, force: true }); process.exit(0); };
process.on('SIGINT', quit);
process.on('SIGTERM', quit);
process.on('exit', () => timer.kill('SIGINT'));

await vd.waitConnected();
vd.send({ session: { playerName: 'Alice', sessionName: 'Demo night', sceneryTitle: 'Football Stadium', trackName: 'Demo Circuit', raceLength: '3', RaceMode: 'Race', quadType: '5"', quadSize: '5' } });
const roster = [
  { name: 'Alice', colour: 'FF3B30', uid: 1, pace: 1.5, imu: true }, // "flown on this PC": streams IMU telemetry
  { name: 'Bob', colour: '34C759', uid: 2, pace: 1.6 },
  { name: 'Chen', colour: '0A84FF', uid: 3, pace: 1.55 },
  { name: 'Dee', colour: 'FF9F0A', uid: 4, pace: 1.65 },
];
const session = { playerName: 'Alice', sessionName: 'Demo night', sceneryTitle: 'Football Stadium', trackName: 'Demo Circuit', raceLength: '3', RaceMode: 'Race', quadType: '5"', quadSize: '5' };
for (let race = 0; ; race++) {
  // Every 3 races the map is "reloaded" (the game sends a new session message): a new session starts.
  if (race > 0 && race % 3 === 0) vd.send({ session });
  // Rotate who's flying so pilots leave and come back.
  const pilots = roster.filter((_, i) => (i + race) % 4 !== 3).map((p) => ({ ...p, laps: 3, pace: p.pace * (0.97 + Math.random() * 0.06) }));
  for (let c = 3; c >= 1; c--) { vd.send({ countdown: { countValue: String(c) } }); await sleep(700 / SPEED); }
  await playRace(vd, pilots, { tickMs: 100 / SPEED });
  await sleep(4000 / SPEED);
}
