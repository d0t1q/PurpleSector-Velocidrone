#!/usr/bin/env node
// PurpleSector: live timing for Velocidrone. Connects to the game's built-in race websocket and times every lap
// gate by gate (holeshot, every gate split, 3 sectors, laps), keeps each pilot's bests per track by
// name, records race history, and (with "WebSocket IMU" on) telemetry for the pilot on this PC.
//
//   node sector-timer.mjs [--velocidrone ws://HOST:60003/velocidrone] [--port 8090] [--open]
//                         [--host 127.0.0.1] [--allow-remote-edit]
//                         [--data ./data/sectors.json] [--log ./data/raw.jsonl]
//                         [--game-data DIR | --no-game-data]
//
// Then open http://127.0.0.1:8090 (--open does it for you).
// --host 0.0.0.0 lets other devices on your network view the page; changes stay limited to this PC
// unless --allow-remote-edit is given.
// Requires Node 18+ (22.13+ to read the track name from the game's settings). No npm packages.

import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine, emptyDb } from './engine.mjs';
import { connectWs } from './vd-socket.mjs';
import { Telemetry, mapFromLap } from './telemetry.mjs';
import { openGameDb, defaultGameDir } from './gamedb.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));
const PORT = Number(args.port || process.env.PORT || 8090);
const HOST = args.host || '127.0.0.1';
const DATA = path.resolve(args.data || path.join(here, 'data', 'sectors.json'));
const TEL_DIR = path.join(path.dirname(DATA), 'telemetry');
const RAW_LOG = args.log ? path.resolve(args.log) : null;
const GAME_PORT = 60003;
const GAME_PATH = '/velocidrone';

// ---------- persistence ----------

function refuse(msg) {
  console.error(msg);
  console.error('Refusing to start so your records are not overwritten. Fix or move the file, then start again.');
  process.exit(1);
}

function loadDb() {
  let text;
  try {
    text = fs.readFileSync(DATA, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return emptyDb();
    refuse(`Could not read ${DATA}: ${e.message}`);
  }
  let db;
  try {
    db = JSON.parse(text);
  } catch (e) {
    refuse(`${DATA} is not valid JSON (${e.message}). The previous start's copy is ${DATA}.bak.`);
  }
  if (!db || typeof db !== 'object' || db.version !== 1) refuse(`${DATA} was written by a different version of the timer (version ${db?.version}).`);
  // Back up only a file we could read (a bad file must never overwrite the last good backup).
  try {
    fs.copyFileSync(DATA, DATA + '.bak');
  } catch (e) {
    console.warn(`Could not back up ${DATA} to .bak: ${e.message}`);
  }
  return db;
}

let saveTimer = null;
let saveWarned = 0;
function scheduleSave(ms = 1000) {
  if (saveTimer) return;
  saveTimer = setTimeout(saveNow, ms);
}
function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text);
  // Windows: antivirus / OneDrive / the indexer can hold the file for a moment.
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      if (i >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      const until = Date.now() + 50 * (i + 1);
      while (Date.now() < until);
    }
  }
}
function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  try {
    writeAtomic(DATA, JSON.stringify(engine.db));
    saveWarned = 0;
  } catch (e) {
    // Keep running (and keep the data in memory); try again shortly.
    if (Date.now() - saveWarned > 60000) console.error(`Could not save ${DATA} (${e.message}); retrying.`);
    saveWarned = saveWarned || Date.now();
    scheduleSave(5000);
  }
}

// ---------- race telemetry files (data/telemetry/race-<id>.json) ----------

const raceTel = new Map(); // raceId -> { [pilotKey]: { name, laps: { [lap]: lapTel } } }
const telFile = (id) => path.join(TEL_DIR, `race-${id}.json`);
function trimTelCache() {
  if (raceTel.size > 20) for (const k of [...raceTel.keys()].slice(0, raceTel.size - 20)) raceTel.delete(k);
}
function loadRaceTel(id) {
  if (raceTel.has(id)) return raceTel.get(id);
  try {
    const d = JSON.parse(fs.readFileSync(telFile(id), 'utf8'));
    raceTel.set(id, d);
    trimTelCache();
    return d;
  } catch {
    return null;
  }
}
function saveRaceTel(id) {
  const d = raceTel.get(id);
  try {
    if (d) writeAtomic(telFile(id), JSON.stringify(d));
  } catch (e) {
    console.error(`Could not save telemetry for race ${id}: ${e.message}`);
  }
  trimTelCache();
}
/** Highest race id that already has a telemetry file (new races must never reuse one). */
function maxTelemetryId() {
  try {
    return Math.max(0, ...fs.readdirSync(TEL_DIR).map((f) => Number(/^race-(\d+)\.json$/.exec(f)?.[1] || 0)));
  } catch {
    return 0;
  }
}

// ---------- engine + live push ----------

const tel = new Telemetry();
const sseClients = new Set();
let pushTimer = null;
let sentHistory = 0;
function sse(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) res.write(payload);
}
// The history (records + every race) changes on almost every gate while racing, and it can be a few
// MB: send it at most every 1.5 s. Live timing goes out at up to 20/s.
const HISTORY_EVERY = 1500;
let historyTimer = null;
let lastHistoryAt = 0;
function pushHistory() {
  historyTimer = null;
  if (engine.historyVersion === sentHistory || !sseClients.size) return;
  sentHistory = engine.historyVersion;
  lastHistoryAt = Date.now();
  sse('history', engine.historySnapshot());
}
function schedulePush() {
  if (pushTimer) return;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    if (!sseClients.size) return;
    if (engine.historyVersion !== sentHistory && !historyTimer) historyTimer = setTimeout(pushHistory, Math.max(0, HISTORY_EVERY - (Date.now() - lastHistoryAt)));
    sse('live', { ...engine.liveSnapshot(), imu: tel.active() });
  }, 50);
}
let telTimer = null;
function scheduleTel() {
  if (telTimer || !sseClients.size) return;
  telTimer = setTimeout(() => {
    telTimer = null;
    // Once the pilot on this PC has finished, telemetry stops until a new race starts.
    const me = engine.live.pilots[engine.localKey()];
    if (me?.finished) return;
    const f = tel.liveFrame();
    if (f) sse('tel', f);
  }, 66);
}

function logError(what, e) {
  const now = Date.now();
  if (now - (logError.last || 0) < 5000) return; // don't flood the console
  logError.last = now;
  console.error(`${what}: ${e?.stack || e}`);
}

const engine = new Engine(loadDb(), {
  onChange(dbDirty) {
    if (dbDirty) scheduleSave();
    schedulePush();
  },
  gameClock: () => tel.clock(),
  onLapStart({ key, lap, start, gOff }) {
    if (key === engine.localKey() && gOff != null) tel.setLapStart(lap, start * 1000 + gOff);
  },
  onLap(info) {
    if (info.key !== engine.localKey() || info.gOff == null || info.end == null) return;
    tel.endLap(info.lap);
    const lapTel = tel.extract(info.start * 1000 + info.gOff, info.end * 1000 + info.gOff, info.cum);
    if (!lapTel) return;
    Object.assign(lapTel, { lap: info.lap, lapTime: info.lapTime ?? null, incomplete: !!info.incomplete });
    const d = loadRaceTel(info.raceId) || {};
    raceTel.set(info.raceId, d);
    (d[info.key] ||= { name: info.name, laps: {} }).laps[info.lap] = lapTel;
    saveRaceTel(info.raceId);
    engine.markRaceTelemetry(info.raceId);
    if (info.incomplete) return;
    const track = engine.db.tracks[info.trackId];
    const rec = track?.pilots[info.key];
    if (rec && (!rec.pbTel || info.lapTime < rec.pbTel.lapTime)) engine.setRefLap(info.trackId, info.key, lapTel);
    if (track && (!track.map || info.lapTime < track.map.lapTime)) engine.setTrackMap(info.trackId, mapFromLap(lapTel, { lapTime: info.lapTime, pilot: info.name }));
  },
  onRacesRemoved(ids) {
    for (const id of ids) {
      raceTel.delete(id);
      fs.rm(telFile(id), { force: true }, () => {});
    }
  },
  onTelemetryRemoved(ids) {
    for (const id of ids) {
      raceTel.delete(id);
      fs.rm(telFile(id), { force: true }, () => {});
    }
  },
});
// Race ids must never reuse an existing telemetry file (e.g. after restoring sectors.json from .bak).
engine.db.raceSeq = Math.max(engine.db.raceSeq, maxTelemetryId());
setInterval(() => sseClients.size && schedulePush(), 2000); // keeps "connected/idle" status fresh

// Leaving the map has no message of its own, but the drone's IMU stream stops the moment you leave.
// A minute of silence from both IMU and race data (after IMU was seen on this map) = left the map.
let imuOnMap = false;
const LEFT_MAP_MS = 60 * 1000;
setInterval(() => {
  if (!imuOnMap || !engine.live.onMap) return;
  const now = Date.now();
  if (now - tel.lastAt > LEFT_MAP_MS && now - (engine.live.lastActivityAt || 0) > LEFT_MAP_MS) {
    imuOnMap = false;
    engine.leaveMap('left map');
  }
}, 5000);
let closedTimer = null; // game closed: the connection stays down

// ---------- the game's settings database (selected track name) ----------

if (args['no-game-data'] === undefined) {
  openGameDb(args['game-data'] ? path.resolve(args['game-data']) : defaultGameDir(), { log: (m) => console.log(m) }).then((gdb) => {
    if (!gdb) return;
    console.log(`Game settings:        ${gdb.dir}`);
    const poll = () => {
      const info = gdb.poll();
      if (info) engine.setGameTrack(info);
    };
    poll();
    setInterval(poll, 2000);
  });
}

// ---------- Velocidrone websocket client ----------

function candidateUrls() {
  if (args.velocidrone) return [args.velocidrone];
  const urls = [`ws://127.0.0.1:${GAME_PORT}${GAME_PATH}`];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) urls.push(`ws://${a.address}:${GAME_PORT}${GAME_PATH}`);
    }
  }
  return urls;
}

let attempt = 0;
let lastWaitLog = 0;
let lastGoodUrl = null;
const failures = new Map(); // url -> last failure reason
function connect() {
  let urls = candidateUrls();
  if (lastGoodUrl && urls.includes(lastGoodUrl)) urls = [lastGoodUrl, ...urls.filter((u) => u !== lastGoodUrl)];
  const url = urls[attempt++ % urls.length];
  let opened = false;
  let ping = null;
  const ws = connectWs(url, { timeoutMs: 3000 });

  ws.on('open', () => {
    opened = true;
    attempt = 0;
    lastGoodUrl = url;
    console.log(`Connected to Velocidrone at ${url}`);
    clearTimeout(closedTimer);
    engine.setConnected(true, url);
    ws.send(JSON.stringify({ command: 'getpilots' }));
    ping = setInterval(() => ws.send(JSON.stringify({ command: 'ping' })), 5000); // game drops idle clients after 40 s
  });

  ws.on('message', (text) => {
    const isImu = text.startsWith('{"imu"');
    // The IMU stream (~60/s) is kept out of the raw log.
    if (RAW_LOG && !isImu) fs.appendFile(RAW_LOG, JSON.stringify({ t: Date.now(), m: text }) + '\n', () => {});
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    try {
      if (msg.imu && typeof msg.imu === 'object') {
        imuOnMap = true;
        engine.markOnMap();
        const wasActive = tel.active();
        if (tel.ingest(msg.imu)) scheduleTel();
        if (!wasActive) schedulePush();
        engine.live.lastMessageAt = Date.now();
        return;
      }
      engine.ingest(msg);
    } catch (e) {
      // One odd message must never stop the timer.
      logError('Could not process a message from the game', e);
    }
  });

  ws.on('close', (reason) => {
    clearInterval(ping);
    failures.set(url, reason);
    if (opened) {
      console.log(`Velocidrone connection closed (${reason}); retrying...`);
      engine.setConnected(false);
      // If it doesn't come back within 15 s the game was closed: the session ends.
      clearTimeout(closedTimer);
      closedTimer = setTimeout(() => {
        imuOnMap = false;
        engine.leaveMap('game closed');
      }, 15000);
    } else if (Date.now() - lastWaitLog > 30000) {
      lastWaitLog = Date.now();
      console.log(
        `Waiting for Velocidrone on port ${GAME_PORT}: ` +
          urls.map((u) => `${u} -> ${failures.get(u) || 'not tried yet'}`).join(', ') +
          '. Is the game running with the WebSocket option enabled, and no other tool (e.g. FPVTrackside) connected?',
      );
    }
    setTimeout(connect, 1000);
  });
}

// ---------- web UI / API ----------

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/charts.js': ['charts.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};

const LOOPBACK = /^(127\.|::1$|::ffff:127\.)/;
const isLoopback = (addr) => LOOPBACK.test(addr || '');
const ALLOW_REMOTE_EDIT = !!args['allow-remote-edit'];

/**
 * Host names this server answers to. Checking the Host header blocks "DNS rebinding" (a web page
 * pointing its own domain at 127.0.0.1 to read or wipe your data).
 */
function allowedHosts() {
  const h = new Set(['localhost', '127.0.0.1', '[::1]']);
  if (!['127.0.0.1', 'localhost', '::1'].includes(HOST)) {
    h.add(HOST.toLowerCase());
    h.add(os.hostname().toLowerCase());
    h.add(`${os.hostname().toLowerCase()}.local`);
    for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) h.add(a.family === 'IPv6' ? `[${a.address}]` : a.address);
  }
  return h;
}
const hostName = (hostHeader) => String(hostHeader || '').replace(/:\d+$/, '').toLowerCase();
const hostOk = (hostHeader) => !!hostHeader && allowedHosts().has(hostName(hostHeader));
/** Edits and deletes only from this PC, unless --allow-remote-edit. */
const canEdit = (req) => ALLOW_REMOTE_EDIT || isLoopback(req.socket.remoteAddress);

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let done = false;
    const fail = (status, msg) => {
      if (done) return;
      done = true;
      reject(Object.assign(new Error(msg), { status }));
    };
    req.on('data', (c) => {
      if (done) return;
      body += c;
      if (body.length > 10000) fail(413, 'request too large');
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      try {
        const v = body ? JSON.parse(body) : {};
        resolve(v && typeof v === 'object' && !Array.isArray(v) ? v : {});
      } catch {
        reject(Object.assign(new Error('bad json'), { status: 400 }));
      }
    });
    req.on('error', () => fail(400, 'request error'));
  });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    logError('A web request failed', e);
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('error');
  });
});

async function handle(req, res) {
  const json = (code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(obj));
  };
  if (!hostOk(req.headers.host)) {
    res.writeHead(403, { 'content-type': 'text/plain' });
    res.end('Forbidden: unknown host name');
    return;
  }
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    res.writeHead(400).end('bad url');
    return;
  }
  const edit = canEdit(req);

  if (req.method === 'GET' && STATIC[url.pathname]) {
    const [file, type] = STATIC[url.pathname];
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    fs.createReadStream(path.join(here, 'public', file)).pipe(res);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    });
    res.write(`retry: 1000\n\n`);
    res.write(`event: access\ndata: ${JSON.stringify({ edit })}\n\n`);
    res.write(`event: history\ndata: ${JSON.stringify(engine.historySnapshot())}\n\n`);
    res.write(`event: live\ndata: ${JSON.stringify({ ...engine.liveSnapshot(), imu: tel.active() })}\n\n`);
    const trace = tel.lapTrace();
    if (trace) res.write(`event: trace\ndata: ${JSON.stringify(trace)}\n\n`);
    sseClients.add(res);
    const hb = setInterval(() => res.write(': hb\n\n'), 15000);
    req.on('close', () => {
      clearInterval(hb);
      sseClients.delete(res);
    });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/state') return json(200, { ...engine.snapshot(), imu: tel.active(), edit });
  if (req.method === 'GET' && url.pathname === '/api/trackdata') {
    const d = engine.trackData(url.searchParams.get('id'));
    return d ? json(200, d) : json(404, { error: 'no such track' });
  }
  if (req.method === 'GET' && url.pathname === '/api/storage') {
    const size = (f) => {
      try {
        return fs.statSync(f).size;
      } catch {
        return 0;
      }
    };
    const perRace = {};
    let telemetryBytes = 0;
    try {
      for (const f of fs.readdirSync(TEL_DIR)) {
        const m = /^race-(\d+)\.json$/.exec(f);
        if (!m) continue;
        const b = size(path.join(TEL_DIR, f));
        perRace[m[1]] = b;
        telemetryBytes += b;
      }
    } catch {}
    // The full path (it contains your user name) is only shown on this PC.
    return json(200, { dataFile: isLoopback(req.socket.remoteAddress) ? DATA : null, recordsBytes: size(DATA), backupBytes: size(DATA + '.bak'), telemetryBytes, telemetryFiles: Object.keys(perRace).length, perRace });
  }
  if (req.method === 'GET' && url.pathname === '/api/telemetry') {
    const id = Number(url.searchParams.get('race'));
    if (!Number.isInteger(id)) return json(400, { error: 'race id' });
    return json(200, loadRaceTel(id) || {});
  }

  if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
    if (!edit) return json(403, { error: 'view only: changes can only be made on the PC running the timer (or start it with --allow-remote-edit)' });
    // Browsers send Origin: it must be this page itself (blocks other web pages from poking the API).
    const origin = req.headers.origin;
    if (origin) {
      let o;
      try {
        o = new URL(origin).host;
      } catch {}
      if (!o || o !== req.headers.host || !hostOk(o)) return json(403, { error: 'cross-origin' });
    }
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      json(e.status || 400, { error: e.message });
      if (e.status === 413) req.destroy();
      return;
    }
    const str = (v) => (typeof v === 'string' ? v : '');
    let ok = false;
    switch (url.pathname) {
      case '/api/track/rename':
        ok = engine.renameTrack(str(body.trackId), str(body.name));
        break;
      case '/api/track/merge':
        ok = engine.mergeTrack(str(body.fromId), str(body.toId));
        break;
      case '/api/track/relearn':
        ok = engine.relearnTrack(str(body.trackId));
        break;
      case '/api/track/delete':
        ok = engine.deleteTrack(str(body.trackId));
        break;
      case '/api/pilot/delete':
        ok = engine.deletePilot(str(body.trackId), str(body.pilotKey));
        break;
      case '/api/race/delete':
        ok = engine.deleteRace(Number(body.raceId));
        break;
      case '/api/session/delete':
        ok = engine.deleteSession(Number(body.sessionId));
        break;
      case '/api/data/delete': {
        const out = engine.deleteData({
          sessions: Array.isArray(body.sessions) ? body.sessions.map(Number).filter(Number.isInteger) : [],
          telemetryOnly: body.telemetryOnly === true,
          tracks: Array.isArray(body.tracks) ? body.tracks.filter((t) => typeof t === 'string') : [],
          records: Array.isArray(body.records) ? body.records.filter((r) => Array.isArray(r) && r.length === 2 && r.every((x) => typeof x === 'string')) : [],
        });
        return json(200, { ok: true, ...out });
      }
      case '/api/track/rebuild':
        ok = engine.rebuildRecords(str(body.trackId));
        break;
      case '/api/session/end':
        ok = engine.endSession('ended by you');
        break;
      default:
        return json(404, { error: 'not found' });
    }
    return json(ok ? 200 : 404, { ok });
  }
  res.writeHead(404).end('not found');
}

function openBrowser(url) {
  const [cmd, argv] =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    const p = spawn(cmd, argv, { stdio: 'ignore', detached: true, windowsVerbatimArguments: process.platform === 'win32' });
    p.on('error', () => console.log(`Open ${url} in your browser.`));
    p.unref();
  } catch {
    console.log(`Open ${url} in your browser.`);
  }
}

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`Port ${PORT} is already in use. Is the timer already running? Close it, or start this one with --port <another number>.`);
  else console.error(`Could not start the web page on ${HOST}:${PORT}: ${e.message}`);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const local = `http://${['0.0.0.0', '::'].includes(HOST) ? '127.0.0.1' : HOST.includes(':') ? `[${HOST}]` : HOST}:${PORT}`;
  console.log(`PurpleSector:         ${local}`);
  console.log(`Records file:         ${DATA}`);
  if (!['127.0.0.1', 'localhost', '::1'].includes(HOST)) {
    console.log(`Other devices on your network can view the page${ALLOW_REMOTE_EDIT ? ' and change or delete data' : ' (changes only from this PC; --allow-remote-edit to allow)'}.`);
  }
  if (RAW_LOG) console.log(`Raw message log:      ${RAW_LOG}`);
  if (args.open) openBrowser(local);
  connect();
});

let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  try {
    engine.endSession('timer stopped');
  } catch (e) {
    logError('Could not close the session', e);
  } finally {
    saveNow();
    process.exit(0);
  }
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGHUP', shutdown); // terminal / console window closed
// Last line of defence: log and keep timing rather than lose the session.
process.on('uncaughtException', (e) => logError('Unexpected error (the timer keeps running)', e));
process.on('unhandledRejection', (e) => logError('Unexpected error (the timer keeps running)', e));

function parseArgs(argv) {
  const FLAGS = new Set(['open', 'allow-remote-edit']);
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') {
      console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 16).join('\n'));
      process.exit(0);
    }
    if (a.startsWith('--no-')) {
      out[a.slice(2)] = true;
      continue;
    }
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      out[k] = FLAGS.has(k) ? true : v ?? argv[++i];
    }
  }
  return out;
}
