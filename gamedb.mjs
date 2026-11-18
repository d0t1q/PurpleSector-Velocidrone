// Reads which track is selected in Velocidrone from the game's own settings databases (read-only).
//
// The race websocket only sends the track name when a room is created/joined, and only to a client
// that is already connected, so a timer started later never hears it. The game remembers the
// selected track in user<N>.db (sim_states: track_id, scenery_id, player_name, race_mode); names
// come from its `tracks` table and the scenery title from settings.db.
//
// Needs Node's built-in SQLite (Node 22.13+ / 23.4+). On older Node this quietly does nothing.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function defaultGameDir() {
  const home = os.homedir();
  if (process.platform === 'win32') return path.join(home, 'AppData', 'LocalLow', 'velocidrone', 'velocidrone');
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'velocidrone', 'velocidrone');
  return path.join(home, '.config', 'unity3d', 'velocidrone', 'velocidrone');
}

const LAP_WORDS = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5, SIX: 6, SEVEN: 7, EIGHT: 8, NINE: 9, TEN: 10, TWENTY: 20 };

function decodeName(s) {
  const raw = String(s ?? '').replace(/\+/g, ' ');
  try {
    return decodeURIComponent(raw).trim();
  } catch {
    return raw.trim();
  }
}

async function loadSqlite() {
  // node:sqlite prints an ExperimentalWarning on load; keep the console clean.
  const orig = process.emitWarning;
  process.emitWarning = function (w, ...rest) {
    const text = `${typeof w === 'string' ? w : w?.message} ${typeof rest[0] === 'string' ? rest[0] : rest[0]?.type || ''}`;
    if (/sqlite/i.test(text)) return;
    return orig.call(this, w, ...rest);
  };
  try {
    return await import('node:sqlite');
  } catch {
    return null;
  } finally {
    setTimeout(() => (process.emitWarning = orig), 0);
  }
}

/**
 * Returns { poll(): info|null, dir } or null if unavailable.
 * info = { trackName, sceneryTitle, playerName, raceLaps, trackId, sceneryId }
 */
export async function openGameDb(dir = defaultGameDir(), { log = () => {} } = {}) {
  if (!fs.existsSync(dir)) {
    log(`Game data folder not found (${dir}); track names will come from the game's websocket only.`);
    return null;
  }
  const sqlite = await loadSqlite();
  if (!sqlite?.DatabaseSync) {
    log(`Reading the track name from the game needs Node 22.13 or newer (this is ${process.version}).`);
    return null;
  }
  const userDb = () => {
    const files = fs.readdirSync(dir).map((f) => /^user(\d+)\.db$/.exec(f)).filter(Boolean);
    files.sort((a, b) => Number(b[1]) - Number(a[1]));
    return files[0] ? path.join(dir, files[0][0]) : null;
  };
  const settingsDb = path.join(dir, 'settings.db');
  let lastStamp = null;
  let last = null;
  let warned = false;

  function query(file, fn) {
    const db = new sqlite.DatabaseSync(file, { readOnly: true });
    try {
      return fn(db);
    } finally {
      db.close();
    }
  }

  function poll() {
    const file = userDb();
    if (!file) return last;
    let stamp;
    try {
      const st = fs.statSync(file);
      stamp = `${file}:${st.mtimeMs}:${st.size}`;
    } catch {
      return last;
    }
    if (stamp === lastStamp) return last;
    try {
      const info = query(file, (db) => {
        const states = {};
        for (const r of db.prepare("SELECT name, value FROM sim_states WHERE name IN ('track_id','scenery_id','player_name','race_mode')").all()) states[r.name] = r.value;
        const trackId = Number(states.track_id);
        const sceneryId = Number(states.scenery_id);
        let trackName = null;
        if (Number.isFinite(trackId)) trackName = db.prepare('SELECT name FROM tracks WHERE id = ?').get(trackId)?.name ?? null;
        const m = /^([A-Z]+)_LAP/.exec(String(states.race_mode || ''));
        return { trackId, sceneryId, trackName: trackName && decodeName(trackName), playerName: decodeName(states.player_name), raceLaps: m ? LAP_WORDS[m[1]] || null : null };
      });
      if (fs.existsSync(settingsDb)) {
        query(settingsDb, (db) => {
          if (!info.trackName && Number.isFinite(info.trackId)) {
            const n = db.prepare('SELECT name FROM tracks WHERE id = ?').get(info.trackId)?.name;
            if (n) info.trackName = decodeName(n);
          }
          if (Number.isFinite(info.sceneryId)) {
            const s = db.prepare('SELECT title, name FROM sceneries WHERE id = ?').get(info.sceneryId);
            info.sceneryTitle = decodeName(s?.title || s?.name || '');
          }
        });
      }
      lastStamp = stamp;
      last = info.trackName ? info : null;
      warned = false;
    } catch (e) {
      // Locked mid-write by the game, or schema changed in an update: try again on the next poll.
      if (!warned) log(`Could not read the game's settings (${e.message}); will retry.`);
      warned = true;
    }
    return last;
  }

  return { dir, poll };
}
