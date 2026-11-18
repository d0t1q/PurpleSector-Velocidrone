// Timing engine for Velocidrone's built-in race websocket feed.
//
// Pure logic, no I/O: feed it parsed websocket messages and it keeps
//   - db:   persistent per-track, per-pilot bests (holeshot, 3 sectors, every gate-to-gate split, lap)
//           plus the race history (every lap with its gate-by-gate times)
//   - live: the race in progress, per pilot, with gaps/intervals and live delta to their PB lap
//
// What the game sends on its race websocket (as observed with Velocidrone 1.16):
//   {"session":{"playerName","sessionName","sceneryTitle","trackName","raceLength","RaceMode","quadType","quadSize"}}
//       only when a room is created/joined, and only if a client is connected at that moment
//   {"racetype":{"raceMode","raceFormat","raceLaps"}}
//   {"racestatus":{"raceAction":"start"|"abort"|"race finished"}}
//   {"countdown":{"countValue":...}}
//   {"racedata":{"<pilot name>":{"position":"1","lap":"2","gate":"5","time":"23.456",
//                                "finished":"False","colour":"FF0000","uid":12345}, ...}}   (polled every 0.1 s)
//   {"imu":{roll,pitch,yaw,PositionX/Y/Z,AttitudeX/Y/Z/W,SpeedX/Y/Z,timestamp}}  local drone, ~60/s (telemetry.mjs)
// `gate` is the gate's own number, increasing through the lap from the
// start/finish gate; `time` is the pilot's race time (seconds since the start signal) when they passed it.
// The first pass through the start gate (lap 1) is therefore also the holeshot time.
// On the final lap line the game reports gate = lastGate+1 with finished = "True".
//
// Timing points of a lap (G = gates on the track, start/finish included): index i = 0..G-2 is gate
// startGate+1+i, index G-1 is the lap line. Gate split i is the time from point i-1 (or the lap start)
// to point i.

export const SECTORS = 3;
const MAX_EVENTS = 40;
const RELEVANT = ['session', 'racetype', 'countdown', 'racestatus', 'racedata'];
const MAX_RACES = 500; // race history kept on disk (oldest dropped first)
const OFFSET_WINDOW = 8; // crossings used to estimate the race clock
const MIN_LAP = 1; // seconds; anything shorter is a glitch, not a lap
const FINISH_TRIGGER_GAP = 0.15; // s: on a new track, a "gate" this close before the lap line is the finish trigger
const KNOWN_TRIGGER_GAP = 0.5; // s: once the gate count is known, lastGate+1 this close before the line is the trigger

const stripTags = (s) => String(s ?? '').replace(/<[^>]*>/g, '').trim();
// Pilot names become object keys: keep the two that would clash with Object.prototype harmless.
export const pilotKey = (name) => {
  const k = stripTags(name).toLowerCase();
  return k === '__proto__' || k === 'constructor' ? `_${k}` : k;
};
/** obj[key] only if it's the object's own entry (ids from the web UI are untrusted). */
const own = (obj, key) => (obj && typeof key === 'string' && Object.hasOwn(obj, key) ? obj[key] : undefined);
const slug = (s) => stripTags(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const toNum = (v) => {
  const n = parseFloat(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};
const toInt = (v) => {
  const n = parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : null;
};
const toBool = (v) => /^(true|1|yes)$/i.test(String(v ?? '').trim());
const ms = (x) => Math.round(x * 1000) / 1000;

/**
 * Split a lap into SECTORS parts by gate count. Sector k ends at gate ends[k] (inclusive); the last
 * sector ends at the lap line.
 */
export function sectorPlan(layout) {
  if (!layout || layout.startGate == null || layout.lastGate == null) return null;
  const gates = layout.lastGate - layout.startGate + 1;
  if (gates < SECTORS) return null;
  const ends = [];
  for (let k = 1; k < SECTORS; k++) ends.push(layout.startGate + Math.round((gates * k) / SECTORS));
  return {
    gates,
    ends,
    startGate: layout.startGate,
    lastGate: layout.lastGate,
    key: `${layout.startGate}:${ends.join(',')}`, // sector boundaries
    layoutKey: `${layout.startGate}-${layout.lastGate}`, // gate splits
  };
}

export function emptyDb() {
  return { version: 1, tracks: {}, lastSession: null, lastTrackId: null, races: [], raceSeq: 0 };
}

export class Engine {
  /**
   * @param db persisted state (emptyDb() shape)
   * @param opts.onChange(dbDirty)  something changed (dbDirty: persist it)
   * @param opts.onLap(info)        a lap ended (complete or cut short), for telemetry
   * @param opts.onLapStart(info)   a lap started
   * @param opts.onRacesRemoved(ids)     races deleted (their telemetry files can go)
   * @param opts.onTelemetryRemoved(ids) telemetry deleted for these races (times kept)
   * @param opts.gameClock()        latest IMU timestamp in ms (game clock), or null
   * @param opts.now()              wall clock in ms (tests pass a fake one)
   */
  constructor(db, { onChange = () => {}, onLap = () => {}, onLapStart = () => {}, onRacesRemoved = () => {}, onTelemetryRemoved = () => {}, now = () => Date.now(), gameClock = () => null } = {}) {
    this.db = db && db.version === 1 ? db : emptyDb();
    if (!Array.isArray(this.db.races)) this.db.races = [];
    this.db.raceSeq = Math.max(this.db.raceSeq || 0, ...this.db.races.map((r) => r.id || 0));
    this.raceId = null; // race currently being recorded
    this.progress = new Map(); // progress key -> Map(pilotKey -> race time), current race only
    this.historyVersion = 1;
    Object.assign(this, { onChange, onLap, onLapStart, onRacesRemoved, onTelemetryRemoved, now, gameClock });
    this.live = {
      connected: false,
      endpoint: null,
      lastMessageAt: null,
      // Track name sources: "session" (game message, only on room create/join) and "game" (the
      // track selected in the game's settings database, see gamedb.mjs). The newer one wins. With
      // neither we fall back to the last track flown and flag it as a guess.
      session: null,
      sessionAt: 0,
      gameTrack: null,
      gameTrackAt: 0,
      trackSource: 'guess',
      // On a map right now? Only then is a track shown (the game's settings just remember the last
      // track picked). Set by a map load, race data or the drone's IMU stream; cleared on leaving.
      onMap: false,
      raceLaps: null,
      raceStatus: 'idle',
      countdown: null,
      sawStart: false,
      pilots: {},
      events: [],
    };
    this.repair();
    this.sessionId = null; // every timer start begins with a fresh session
    this.setupSessions();
    this.trackId = this.resolveTrackId();
  }

  // ---------- sessions ----------
  //
  // A session is one sitting on one map: it starts with the first race after the timer starts or a
  // map is loaded, and ends when the game closes, the map is left or changed, or the timer stops.

  setupSessions() {
    if (!Array.isArray(this.db.sessions)) this.db.sessions = [];
    this.db.sessionSeq ||= 0;
    // Sessions left open by a timer that was killed or crashed: close them where their racing ended.
    for (const s of this.db.sessions) {
      if (s.endedAt == null) {
        s.endedAt = this.sessionLastActivity(s);
        s.endReason = 'timer stopped';
      }
    }
    // Races saved before sessions existed: group them (same track, no break over 20 minutes).
    const legacy = this.db.races.filter((r) => r.sessionId == null).sort((a, b) => a.startedAt - b.startedAt);
    let cur = null;
    for (const r of legacy) {
      if (!cur || cur.trackId !== r.trackId || r.startedAt - cur.endedAt > 20 * 60 * 1000) {
        cur = { id: ++this.db.sessionSeq, trackId: r.trackId, startedAt: r.startedAt, endedAt: r.startedAt, endReason: 'imported' };
        this.db.sessions.push(cur);
      }
      r.sessionId = cur.id;
      cur.endedAt = Math.max(cur.endedAt, raceEnd(r));
    }
    this.db.sessions.sort((a, b) => a.startedAt - b.startedAt);
  }

  sessionLastActivity(s) {
    let t = s.startedAt;
    for (const r of this.db.races) if (r.sessionId === s.id) t = Math.max(t, raceEnd(r));
    return t;
  }

  /** A pilot's bests within the current session (for green = session best). */
  sessBest(key) {
    this.sessBests ||= {};
    const plan = this.plan();
    const b = (this.sessBests[key] ||= { hs: null, lap: null, sec: [null, null, null], seg: [], segKey: null });
    if (plan && b.segKey !== plan.layoutKey) {
      b.segKey = plan.layoutKey;
      b.seg = Array(plan.gates).fill(null);
    }
    return b;
  }

  currentSession() {
    return this.sessionId != null ? this.db.sessions.find((s) => s.id === this.sessionId) || null : null;
  }

  newSession() {
    const s = { id: ++this.db.sessionSeq, trackId: this.trackId, startedAt: this.now(), endedAt: null, endReason: null };
    this.db.sessions.push(s);
    this.sessionId = s.id;
    this.sessBests = {}; // each pilot's bests in this session (green)
    this.event({ type: 'session', text: 'New session' });
    return s;
  }

  /**
   * Close the current session (game closed, map left or changed, timer stopped). A lap in progress is
   * saved as cut short. A session where nothing was flown is dropped.
   */
  endSession(reason) {
    const s = this.currentSession();
    if (!s) return false;
    const race = this.currentRace();
    if (race) {
      this.flushAll(reason);
      if (race.status === 'running') race.status = 'aborted';
    }
    const races = this.db.races.filter((r) => r.sessionId === s.id);
    const flown = races.filter((r) => Object.values(r.pilots).some((e) => e.laps.length || e.finished || e.holeshot));
    if (!flown.length) {
      this.db.races = this.db.races.filter((r) => r.sessionId !== s.id);
      this.onRacesRemoved(races.map((r) => r.id));
      this.db.sessions = this.db.sessions.filter((x) => x !== s);
    } else {
      const empty = races.filter((r) => !flown.includes(r));
      if (empty.length) {
        this.db.races = this.db.races.filter((r) => !empty.includes(r));
        this.onRacesRemoved(empty.map((r) => r.id));
      }
      s.endedAt = this.now();
      s.endReason = reason;
      this.event({ type: 'session', text: `Session ended (${reason}): ${flown.length} race${flown.length === 1 ? '' : 's'} saved` });
    }
    this.sessionId = null;
    this.raceId = null;
    this.progress = new Map();
    this.live.pilots = {};
    this.live.raceStatus = 'idle';
    this.live.countdown = null;
    this.changed(true);
    return true;
  }

  /** The drone exists (IMU is streaming): we're on a map. */
  markOnMap() {
    if (this.live.onMap) return;
    this.live.onMap = true;
    this.changed(false);
  }

  /** Left the map or the game closed: close the session and stop showing the track. */
  leaveMap(reason) {
    this.endSession(reason);
    if (!this.live.onMap) return;
    this.live.onMap = false;
    this.live.pilots = {};
    this.live.raceStatus = 'idle';
    this.changed(false);
  }

  deleteSession(id) {
    if (id === this.sessionId) return false;
    const s = this.db.sessions.find((x) => x.id === id);
    if (!s) return false;
    const gone = this.db.races.filter((r) => r.sessionId === id);
    this.db.races = this.db.races.filter((r) => r.sessionId !== id);
    this.db.sessions = this.db.sessions.filter((x) => x !== s);
    this.onRacesRemoved(gone.map((r) => r.id));
    this.changed(true);
    return true;
  }

  /**
   * Clean up and backfill records from the race history (runs at startup):
   *  - drops impossible laps (< MIN_LAP s; seen when the game reports a finish as a race resets)
   *  - re-derives every pilot's bests from the gate times saved with each lap, so bests lost to an
   *    earlier layout mix-up come back. Only ever improves a record, never worsens one.
   */
  repair() {
    for (const r of this.db.races) {
      for (const e of Object.values(r.pilots)) {
        e.laps = (e.laps || []).filter((l) => l.lapTime == null || l.lapTime >= MIN_LAP);
        if (e.finished && !e.laps.length) {
          e.finished = false;
          e.totalTime = null;
        }
      }
    }
    for (const t of Object.values(this.db.tracks)) {
      for (const rec of Object.values(t.pilots)) if (rec.bestLap != null && rec.bestLap < MIN_LAP) rec.bestLap = null;
      this.improveFromHistory(t);
      this.recomputeFlags(t.id);
    }
  }

  /**
   * Recolour a track's saved laps: replay its race history in order and set every PB / track-best
   * flag as it was when flown. Bests older than the saved history are the starting point. Fixes the
   * colours after a layout mix-up or deleted data.
   */
  recomputeFlags(trackId) {
    const t = this.db.tracks[trackId];
    if (!t) return;
    const plan = sectorPlan(t.layout);
    const G = plan?.gates || 0;
    const e0 = plan ? plan.ends[0] - plan.startGate - 1 : 0, e1 = plan ? plan.ends[1] - plan.startGate - 1 : 0;
    const races = this.db.races.filter((r) => r.trackId === trackId).sort((a, b) => a.startedAt - b.startedAt || a.id - b.id);
    const fit = (cum) => (!cum || !G ? null : cum.length === G ? cum : cum.length > G ? [...cum.slice(0, G - 1), cum.at(-1)] : null);
    const segsOf = (cum) => cum.map((c, i) => (c == null ? null : i === 0 ? c : cum[i - 1] == null ? null : ms(c - cum[i - 1])));
    const secsOf = (l, cum) =>
      cum
        ? [cum[e0], cum[e0] != null && cum[e1] != null ? cum[e1] - cum[e0] : null, cum[e1] != null && cum[G - 1] != null ? cum[G - 1] - cum[e1] : null].map((v) => (v == null ? null : ms(v)))
        : (l.sectors || []).map((s) => (s && !s.approx ? s.time : null));
    const lo = (a, b) => (a == null ? b : b == null ? a : Math.min(a, b));
    const blank = () => ({ hs: null, lap: null, sec: [null, null, null], seg: Array(G).fill(null) });
    // Fastest of each thing in the saved history, per pilot.
    const hist = {};
    for (const r of races) {
      for (const [k, e] of Object.entries(r.pilots)) {
        const h = (hist[k] ||= blank());
        h.hs = lo(h.hs, e.holeshot?.time ?? null);
        for (const l of e.laps) {
          h.lap = lo(h.lap, l.lapTime ?? null);
          const cum = fit(l.cum);
          secsOf(l, cum).forEach((v, i) => (h.sec[i] = lo(h.sec[i], v)));
          if (cum) segsOf(cum).forEach((v, i) => (h.seg[i] = lo(h.seg[i], v)));
        }
      }
    }
    // Starting point: record values better than anything saved (set before the history was kept).
    const older = (rec, v) => (rec != null && (v == null || rec < v - 0.0005) ? rec : null);
    const best = {};
    for (const [k, rec] of Object.entries(t.pilots)) {
      const h = hist[k] || blank();
      best[k] = {
        hs: older(rec.hsBest, h.hs),
        lap: older(rec.bestLap, h.lap),
        sec: [0, 1, 2].map((i) => older(rec.best?.[i], h.sec[i])),
        seg: Array.from({ length: G }, (_, i) => (rec.segKey === plan?.layoutKey ? older(rec.segBest?.[i], h.seg[i]) : null)),
      };
    }
    // Purple = all-time PB (b), green = best within that session (sb, per pilot per session).
    const sbest = {};
    const judge = (v, mine, sess) => ({ pb: mine == null || v < mine, sb: sess == null || v < sess, delta: mine == null ? null : ms(v - mine) });
    for (const r of races) {
      // In the order things happened: holeshots, then laps by the race time they ended.
      const evs = [];
      for (const [k, e] of Object.entries(r.pilots)) {
        if (e.holeshot) evs.push({ t: e.holeshot.time, k, e });
        for (const l of e.laps) evs.push({ t: l.end ?? (l.start ?? 0) + (l.lapTime ?? 999), k, l });
      }
      evs.sort((a, b) => a.t - b.t);
      for (const ev of evs) {
        const b = (best[ev.k] ||= blank());
        const sb = (sbest[`${ev.k}|${r.sessionId}`] ||= blank());
        if (!ev.l) {
          const v = ev.e.holeshot.time;
          const j = judge(v, b.hs, sb.hs);
          const h = ev.e.holeshot;
          delete h.trackBest;
          Object.assign(h, { pb: j.pb, sb: j.sb, delta: j.delta });
          if (j.pb) b.hs = v;
          if (j.sb) sb.hs = v;
          continue;
        }
        const l = ev.l;
        const cum = fit(l.cum);
        if (cum) {
          l.cum = cum;
          l.segFlags = segsOf(cum).map((v, i) => {
            if (v == null) return null;
            const j = judge(v, b.seg[i], sb.seg[i]);
            if (j.pb) b.seg[i] = v;
            if (j.sb) sb.seg[i] = v;
            return j.pb ? 2 : j.sb ? 1 : 0;
          });
        } else if (Array.isArray(l.segFlags)) {
          l.segFlags = l.segFlags.map(() => null);
        }
        const secs = secsOf(l, cum);
        const n = Math.max((l.sectors || []).length, secs.filter((v) => v != null).length);
        const out = [];
        for (let i = 0; i < n && i < SECTORS; i++) {
          const v = secs[i];
          const st = l.sectors?.[i];
          if (v == null) {
            if (!st) break;
            out.push({ time: st.time, approx: true, pb: false, sb: false, delta: null }); // approximate: never a record
            continue;
          }
          const j = judge(v, b.sec[i], sb.sec[i]);
          if (j.pb) b.sec[i] = v;
          if (j.sb) sb.sec[i] = v;
          out.push({ time: v, pb: j.pb, sb: j.sb, delta: j.delta, approx: false });
        }
        l.sectors = out;
        if (l.lapTime != null) {
          const j = judge(l.lapTime, b.lap, sb.lap);
          delete l.lapTrackBest;
          Object.assign(l, { lapPb: j.pb, lapSb: j.sb, lapDelta: j.delta });
          if (j.pb) b.lap = l.lapTime;
          if (j.sb) sb.lap = l.lapTime;
        }
      }
    }
  }

  /** Improve a track's records from the laps saved in its race history (never makes one worse). */
  improveFromHistory(t) {
    const plan = sectorPlan(t.layout);
    const G = plan?.gates;
    const e0 = plan ? plan.ends[0] - plan.startGate - 1 : 0, e1 = plan ? plan.ends[1] - plan.startGate - 1 : 0;
    for (const r of this.db.races) {
      if (r.trackId !== t.id) continue;
      for (const [key, e] of Object.entries(r.pilots)) {
        const rec = t.pilots[key];
        if (!rec) continue;
        if (e.holeshot?.time != null && (rec.hsBest == null || e.holeshot.time < rec.hsBest)) rec.hsBest = e.holeshot.time;
        for (const l of e.laps) {
          if (l.lapTime != null && (rec.bestLap == null || l.lapTime < rec.bestLap)) {
            rec.bestLap = l.lapTime;
            rec.bestLapAt = r.startedAt;
          }
          if (!plan) continue;
          let cum = l.cum;
          if (!cum) {
            // Saved before gate times were kept: its sectors are exact (unless marked approximate).
            (l.sectors || []).forEach((st, k) => {
              if (st && !st.approx && st.time > 0 && (rec.best[k] == null || st.time < rec.best[k])) {
                rec.best[k] = st.time;
                rec.bestAt[k] = r.startedAt;
              }
            });
            continue;
          }
          if (cum.length < G) continue;
          // Gate times: extra points past the last gate are the finish-line trigger (saved that way
          // by an older version, with sectors split for the wrong gate count): fix the saved lap.
          if (cum.length > G) {
            cum = [...cum.slice(0, G - 1), cum.at(-1)];
            l.cum = cum;
            if (Array.isArray(l.segFlags) && l.segFlags.length > G) l.segFlags = [...l.segFlags.slice(0, G - 1), l.segFlags.at(-1)];
            // Missing gate times stay missing (null - x must not count as 0 - x).
            const sub = (a, b) => (a == null || b == null ? null : a - b);
            const fixed = [cum[e0], sub(cum[e1], cum[e0]), sub(cum[G - 1], cum[e1])].map((v, k) =>
              v == null ? (l.sectors?.[k] ? { ...l.sectors[k], approx: true } : null) : { time: ms(v), delta: null, pb: false, sb: false, approx: false },
            );
            while (fixed.length && fixed.at(-1) == null) fixed.pop();
            l.sectors = fixed.filter(Boolean);
          }
          if (l.lapTime == null) cum = [...cum.slice(0, G - 1), null];
          const secs = [cum[e0], cum[e0] != null && cum[e1] != null ? cum[e1] - cum[e0] : null, cum[e1] != null && cum[G - 1] != null ? cum[G - 1] - cum[e1] : null];
          secs.forEach((v, k) => {
            if (v != null && v > 0 && (rec.best[k] == null || ms(v) < rec.best[k])) {
              rec.best[k] = ms(v);
              rec.bestAt[k] = r.startedAt;
            }
          });
          if (rec.segKey !== plan.layoutKey || !Array.isArray(rec.segBest)) {
            rec.segKey = plan.layoutKey;
            rec.segBest = Array(G).fill(null);
            rec.pbCum = null;
            rec.pbCumLap = null;
          }
          cum.forEach((c, i) => {
            if (c == null || (i > 0 && cum[i - 1] == null)) return;
            const v = ms(c - (i ? cum[i - 1] : 0));
            if (v > 0 && (rec.segBest[i] == null || v < rec.segBest[i])) rec.segBest[i] = v;
          });
          if (l.lapTime != null && cum[G - 1] != null && (rec.pbCumLap == null || l.lapTime < rec.pbCumLap)) {
            rec.pbCum = cum;
            rec.pbCumLap = l.lapTime;
          }
        }
      }
    }
  }

  // ---------- connection / messages ----------

  setConnected(connected, endpoint = null) {
    this.live.connected = connected;
    this.live.endpoint = connected ? endpoint : null;
    this.changed(false);
  }

  ingest(msg) {
    if (!msg || typeof msg !== 'object') return;
    this.live.lastMessageAt = this.now();
    // Ignore the IMU stream (~60 msgs/s) and anything else we don't use, without re-rendering.
    if (!RELEVANT.some((k) => k in msg)) return;
    let dbDirty = false;

    if (msg.session && typeof msg.session === 'object') {
      // Sent when a room is created/joined, i.e. a map was (re)loaded: that starts a new session.
      this.endSession('new map');
      this.live.onMap = true;
      const s = msg.session;
      this.live.session = {
        playerName: stripTags(s.playerName),
        sessionName: stripTags(s.sessionName),
        sceneryTitle: stripTags(s.sceneryTitle),
        trackName: stripTags(s.trackName),
        raceLength: s.raceLength,
        raceMode: stripTags(s.RaceMode),
        quadType: stripTags(s.quadType),
      };
      this.live.sessionAt = this.now();
      this.db.lastSession = this.live.session;
      const laps = toInt(s.raceLength);
      if (laps) this.live.raceLaps = laps;
      this.trackId = this.resolveTrackId();
      dbDirty = true;
    }
    if (msg.racetype && typeof msg.racetype === 'object') {
      const laps = toInt(msg.racetype.raceLaps);
      if (laps) this.live.raceLaps = laps;
      this.live.raceMode = stripTags(msg.racetype.raceMode);
      this.live.raceFormat = stripTags(msg.racetype.raceFormat);
    }
    if (msg.countdown && typeof msg.countdown === 'object') {
      this.live.countdown = msg.countdown.countValue ?? null;
    }
    if (msg.racestatus && typeof msg.racestatus === 'object') {
      const action = String(msg.racestatus.raceAction ?? '').toLowerCase();
      if (action === 'start') {
        this.flushAll('new race');
        this.live.raceStatus = 'running';
        this.live.sawStart = true;
        this.live.countdown = null;
        this.live.pilots = {};
        this.startRace();
        dbDirty = true;
      } else if (action === 'abort') {
        this.flushAll('aborted');
        this.live.raceStatus = 'aborted';
        for (const p of Object.values(this.live.pilots)) p.cur = null;
        const race = this.currentRace();
        if (race) race.status = 'aborted';
        this.event({ type: 'race', raceId: this.raceId, text: 'aborted' });
        dbDirty = true;
      } else if (action.includes('finish')) {
        this.live.raceStatus = 'finished';
        const race = this.currentRace();
        if (race) race.status = 'finished';
        dbDirty = true;
      }
    }
    if (msg.racedata && typeof msg.racedata === 'object') {
      this.live.onMap = true;
      if (this.live.raceStatus === 'idle' || this.live.raceStatus === 'aborted') this.live.raceStatus = 'running';
      for (const [name, d] of Object.entries(msg.racedata)) {
        if (d && typeof d === 'object' && this.updatePilot(name, d)) dbDirty = true;
      }
    }
    this.changed(dbDirty);
  }

  /** Track currently selected in the game, read from its settings database (gamedb.mjs). */
  setGameTrack(info) {
    if (!info || !info.trackName) return;
    // Compare cleaned values with what we have, so an unchanged poll is a no-op.
    const next = { trackName: stripTags(info.trackName), sceneryTitle: stripTags(info.sceneryTitle), playerName: stripTags(info.playerName) };
    const laps = Number.isInteger(info.raceLaps) && info.raceLaps > 0 ? info.raceLaps : null;
    const prev = this.live.gameTrack;
    const trackChanged = !prev || prev.trackName !== next.trackName || prev.sceneryTitle !== next.sceneryTitle;
    if (!trackChanged && prev.playerName === next.playerName && (this.live.gameRaceLaps ?? null) === laps) return;
    this.live.gameTrack = next;
    this.live.gameRaceLaps = laps;
    if (trackChanged) {
      // A different track picked in the game ends the session (not the first reading after a start).
      if (prev) this.endSession('changed track');
      this.live.gameTrackAt = this.now();
    }
    const before = this.trackId;
    this.trackId = this.resolveTrackId();
    const race = this.currentRace();
    if (race && before !== this.trackId && !Object.values(race.pilots).some((e) => e.laps.length)) race.trackId = this.trackId;
    this.changed(before !== this.trackId);
  }

  /** Laps per race: from the game's messages, else its settings (single player sends no racetype). */
  raceLaps() {
    return this.live.raceLaps || this.live.gameRaceLaps || null;
  }

  /** Pilot flying on this PC (telemetry belongs to them). */
  localKey() {
    const name = this.live.session?.playerName || this.live.gameTrack?.playerName;
    if (name) return pilotKey(name);
    const keys = Object.keys(this.live.pilots);
    return keys.length === 1 ? keys[0] : null;
  }

  // ---------- tracks ----------

  namedSource() {
    const s = this.live.session?.trackName ? { ...this.live.session, at: this.live.sessionAt, src: 'session' } : null;
    const g = this.live.gameTrack?.trackName ? { ...this.live.gameTrack, at: this.live.gameTrackAt, src: 'game' } : null;
    if (s && g) return g.at > s.at ? g : s;
    return s || g;
  }

  resolveTrackId() {
    const s = this.namedSource();
    if (s) {
      let id = 'n:' + (slug(`${s.sceneryTitle || ''} ${s.trackName}`) || 'track');
      if (!this.db.tracks[id]) {
        // A track saved without its scenery (or now named without one) is the same track. Tracks with
        // the same name in different sceneries are different tracks.
        const same = Object.values(this.db.tracks).filter((t) => t.id.startsWith('n:') && slug(t.name) === slug(s.trackName) && (!t.sceneryTitle || !s.sceneryTitle));
        if (same.length === 1) id = same[0].id;
      }
      const t = (this.db.tracks[id] ||= newTrack(id, s.trackName, s.sceneryTitle));
      t.sceneryTitle = t.sceneryTitle || s.sceneryTitle || '';
      this.db.lastTrackId = id;
      this.live.trackSource = s.src;
      return id;
    }
    this.live.trackSource = 'guess';
    // No track name: guess the last track used (verified against gate layout later).
    return this.db.lastTrackId && this.db.tracks[this.db.lastTrackId] ? this.db.lastTrackId : null;
  }

  track() {
    return this.trackId ? this.db.tracks[this.trackId] : null;
  }

  plan() {
    return sectorPlan(this.track()?.layout);
  }

  /** Learn/verify the gate layout. Returns true if sector definitions changed. */
  learnLayout(startGate, lastGate, confirmed) {
    if (startGate == null || lastGate == null || lastGate <= startGate) return false;
    let t = this.track();
    if (!t || (this.live.trackSource !== 'session' && t.layout && !sameLayout(t.layout, startGate, lastGate, confirmed))) {
      // Unnamed (or the name may be stale): identify the track by gate layout.
      t = Object.values(this.db.tracks)
        .filter((x) => x.layout && x.layout.startGate === startGate && x.layout.lastGate === lastGate)
        .sort((a, b) => (b.updated || 0) - (a.updated || 0))[0];
      if (!t) {
        const id = `g:${startGate}-${lastGate}`;
        t = this.db.tracks[id] ||= newTrack(id, `Unnamed track (${lastGate - startGate + 1} gates)`, '');
      }
      this.trackId = t.id;
      this.db.lastTrackId = t.id;
    }
    const before = sectorPlan(t.layout);
    if (!t.layout) {
      t.layout = { startGate, lastGate, confirmed: !!confirmed };
      if (t.id.startsWith('n:')) this.adoptRenamedUnnamed(t);
    } else if (t.layout.startGate !== startGate) {
      t.layout = { startGate, lastGate, confirmed: !!confirmed };
    } else if (confirmed) {
      t.layout.lastGate = lastGate;
      t.layout.confirmed = true;
    } else if (lastGate > t.layout.lastGate && !t.layout.confirmed) {
      // Saw a gate beyond what we thought was the last one (a finish has the final word).
      t.layout.lastGate = lastGate;
      t.layout.confirmed = false;
    }
    const after = sectorPlan(t.layout);
    if (before && after?.key !== before.key) {
      // Sector boundaries moved: bests split the old way don't compare. Rebuild them (and the colours)
      // from the saved laps that fit the new layout. Lap bests are unaffected.
      for (const rec of Object.values(t.pilots)) {
        rec.best = Array(SECTORS).fill(null);
        rec.bestAt = Array(SECTORS).fill(null);
      }
      this.event({ type: 'layout', text: `Gate layout of ${t.displayName || t.name} is ${lastGate - startGate + 1} gates; sector bests recalculated` });
    }
    if (before && after?.layoutKey !== before.layoutKey) {
      for (const p of Object.values(this.live.pilots)) if (p.cur) p.cur.cumKey = null;
      this.improveFromHistory(t);
      this.recomputeFlags(t.id);
    }
    return before?.key !== after?.key;
  }

  /**
   * A track flown before the game named it is stored as "Unnamed track (N gates)". If the user
   * renamed it to this track's name and the gate layout matches, fold its records into this track.
   */
  adoptRenamedUnnamed(named) {
    const want = named.name.trim().toLowerCase();
    for (const u of Object.values(this.db.tracks)) {
      if (!u.id.startsWith('g:') || !u.layout) continue;
      if ((u.displayName || '').trim().toLowerCase() !== want) continue;
      if (u.layout.startGate !== named.layout.startGate || u.layout.lastGate !== named.layout.lastGate) continue;
      this.mergeInto(u, named);
    }
  }

  mergeInto(from, to) {
    for (const [key, r] of Object.entries(from.pilots)) {
      const mine = to.pilots[key];
      if (!mine) {
        to.pilots[key] = r;
        continue;
      }
      for (let k = 0; k < SECTORS; k++) {
        if (r.best[k] != null && (mine.best[k] == null || r.best[k] < mine.best[k])) {
          mine.best[k] = r.best[k];
          mine.bestAt[k] = r.bestAt[k];
        }
      }
      if (r.bestLap != null && (mine.bestLap == null || r.bestLap < mine.bestLap)) {
        mine.bestLap = r.bestLap;
        mine.bestLapAt = r.bestLapAt;
        if (r.pbTel) mine.pbTel = r.pbTel;
      }
      if (r.hsBest != null && (mine.hsBest == null || r.hsBest < mine.hsBest)) mine.hsBest = r.hsBest;
      if (r.segBest && r.segKey) {
        if (!mine.segBest || mine.segKey !== r.segKey) {
          mine.segBest = r.segBest;
          mine.segKey = r.segKey;
        } else {
          mine.segBest = mine.segBest.map((v, i) => minOf([v, r.segBest[i]]));
        }
      }
      if (r.pbCum && (mine.pbCumLap == null || (r.pbCumLap != null && r.pbCumLap < mine.pbCumLap))) {
        mine.pbCum = r.pbCum;
        mine.pbCumLap = r.pbCumLap;
      }
      mine.laps += r.laps;
      mine.lastSeen = Math.max(mine.lastSeen || 0, r.lastSeen || 0);
    }
    if (to.layout && !to.layout.confirmed && from.layout?.confirmed) to.layout.confirmed = true;
    if (!to.layout && from.layout) to.layout = from.layout;
    if (from.map && (!to.map || from.map.lapTime < to.map.lapTime)) to.map = from.map;
    to.updated = Math.max(to.updated || 0, from.updated || 0);
    this.recomputeFlags(to.id);
    for (const r of this.db.races) if (r.trackId === from.id) r.trackId = to.id;
    for (const s of this.db.sessions || []) if (s.trackId === from.id) s.trackId = to.id;
    delete this.db.tracks[from.id];
    if (this.trackId === from.id) this.trackId = to.id;
    if (this.db.lastTrackId === from.id) this.db.lastTrackId = to.id;
    this.event({ type: 'layout', text: `Merged records from "${from.displayName || from.name}" into ${to.displayName || to.name}` });
  }

  // ---------- races ----------

  currentRace() {
    if (this.raceId == null) return null;
    for (let i = this.db.races.length - 1; i >= 0; i--) if (this.db.races[i].id === this.raceId) return this.db.races[i];
    return null;
  }

  startRace() {
    const prev = this.currentRace();
    if (prev && !Object.values(prev.pilots).some((e) => e.laps.length || e.finished || e.holeshot)) {
      // Nothing was flown (countdown restarted, aborted on the line...): replace it.
      this.db.races.splice(this.db.races.indexOf(prev), 1);
      this.live.events = this.live.events.filter((e) => !(e.type === 'race' && e.raceId === prev.id));
      this.onRacesRemoved([prev.id]);
    }
    let sess = this.currentSession();
    if (sess) {
      const last = this.db.races.filter((r) => r.sessionId === sess.id).at(-1);
      if (last && last.trackId && this.trackId && last.trackId !== this.trackId) {
        this.endSession('changed track');
        sess = null;
      }
    }
    if (!sess) sess = this.newSession();
    const race = {
      id: ++this.db.raceSeq,
      sessionId: sess.id,
      trackId: this.trackId,
      startedAt: this.now(),
      status: 'running',
      raceLaps: this.raceLaps(),
      sessionName: this.live.session?.sessionName || null,
      pilots: {},
    };
    this.db.races.push(race);
    if (this.db.races.length > MAX_RACES) {
      const gone = this.db.races.splice(0, this.db.races.length - MAX_RACES);
      this.onRacesRemoved(gone.map((r) => r.id));
      this.pruneSessions();
    }
    this.raceId = race.id;
    this.progress = new Map();
    this.event({ type: 'race', raceId: race.id, text: 'started' });
    return race;
  }

  raceEntry(p) {
    const race = this.currentRace();
    if (!race) return null;
    const e = (race.pilots[p.key] ||= { name: p.name, colour: p.colour, laps: [], finished: false, totalTime: null, position: null, holeshot: null });
    e.name = p.name;
    e.colour = p.colour || e.colour;
    return e;
  }

  deleteRace(id) {
    const i = this.db.races.findIndex((r) => r.id === id);
    if (i < 0) return false;
    this.db.races.splice(i, 1);
    if (this.raceId === id) this.raceId = null;
    this.onRacesRemoved([id]);
    this.pruneSessions();
    for (const t of Object.keys(this.db.tracks)) this.recomputeFlags(t);
    this.changed(true);
    return true;
  }

  /** Drop closed sessions that no longer have any races. */
  pruneSessions() {
    const used = new Set(this.db.races.map((r) => r.sessionId));
    this.db.sessions = (this.db.sessions || []).filter((s) => s.id === this.sessionId || used.has(s.id));
  }

  markRaceTelemetry(id) {
    const r = this.db.races.find((x) => x.id === id);
    if (r && !r.tel) {
      r.tel = true;
      this.changed(true);
    }
  }

  /** Save the lap in progress (restart / abort / new race) so what was flown isn't lost. */
  flushLap(p, reason) {
    const cur = p.cur;
    p.cur = null;
    const race = this.currentRace();
    if (!race) return false;
    const entry = race.pilots[p.key];
    let dirty = false;
    if (cur && !cur.closed && !cur.partial && cur.crossings.length && this.track()) {
      this.updateCum(p, cur, null);
      const e = this.raceEntry(p);
      const lastT = cur.crossings.at(-1).t;
      e.laps.push({
        lap: cur.lap,
        lapTime: null,
        incomplete: true,
        start: cur.startTime,
        end: null,
        pos: p.position ?? null,
        sectors: cur.sectors.map((s) => ({ ...s })),
        cum: cur.cum ? [...cur.cum] : null,
        segFlags: cur.segFlags ? cur.segFlags.map((f) => (f === undefined ? null : f)) : null,
      });
      cur.closed = true;
      this.onLap({ raceId: race.id, trackId: this.trackId, key: p.key, name: p.name, lap: cur.lap, start: cur.startTime, end: lastT, cum: cur.cum, incomplete: true, gOff: p.gOff });
      dirty = true;
    }
    const e = race.pilots[p.key] || entry;
    if (e && !e.finished && (e.laps.length || e.holeshot) && !e.stopped) {
      e.stopped = reason;
      e.stoppedLap = cur?.lap ?? (e.laps.at(-1)?.lap ?? 0) + 1;
      if (reason === 'restart') this.event({ type: 'restart', raceId: race.id, pilot: p.name, text: `restarted on lap ${e.stoppedLap}` });
      dirty = true;
    }
    return dirty;
  }

  flushAll(reason) {
    for (const p of Object.values(this.live.pilots)) if (!p.finished) this.flushLap(p, reason);
  }

  // ---------- pilots / laps ----------

  updatePilot(name, d) {
    const key = pilotKey(name);
    if (!key) return false;
    const lap = toInt(d.lap);
    const gate = toInt(d.gate);
    const t = toNum(d.time);
    const fin = toBool(d.finished);
    if (lap == null || gate == null || t == null) return false;

    let firstSight = !this.live.pilots[key];
    const p = (this.live.pilots[key] ||= newPilot(key, name));
    p.name = stripTags(name);
    p.colour = d.colour != null ? String(d.colour) : p.colour;
    p.uid = d.uid ?? p.uid;
    p.position = toInt(d.position);

    let dirty = false;
    // Restarted / respawned / new race without a "start" message: the lap counter or race clock
    // went back.
    const reset = !firstSight && (lap < p.lap || t < p.time - 0.5);
    if (p.finished && !reset) {
      // Finished means finished: nothing more is recorded for this pilot (flying on after the line,
      // the game clearing its finished flag...) until a new race starts.
      return dirty;
    }
    if (reset) {
      dirty = this.flushLap(p, p.finished ? 'new race' : 'restart') || dirty;
      Object.assign(p, newPilot(key, name), { colour: p.colour, uid: p.uid, position: p.position });
      firstSight = true;
    }

    const prevLap = p.lap;
    const prevGate = p.gate;
    const prevFin = p.finished;
    const changed = lap !== prevLap || gate !== prevGate || fin !== prevFin;
    const timeChanged = t !== p.time;
    p.lap = lap;
    p.gate = gate;
    p.time = ms(t);
    p.finished = fin;
    if (timeChanged) this.updateClock(p, t);
    if (!changed) return dirty;
    this.live.lastActivityAt = this.now();
    return this.onCrossing(p, { prevLap, prevGate, prevFin, lap, gate, t: ms(t), fin, firstSight }) || dirty;
  }

  /** Estimate the pilot's race clock against wall time and the game's IMU clock (min latency seen). */
  updateClock(p, t) {
    const push = (arr, v) => {
      arr.push(v);
      if (arr.length > OFFSET_WINDOW) arr.shift();
      return Math.min(...arr);
    };
    p.offset = push(p.wallOffs, this.now() - t * 1000);
    const g = this.gameClock();
    if (g != null) p.gOff = push(p.gameOffs, g - t * 1000);
  }

  recordProgress(p, key, t) {
    let m = this.progress.get(key);
    if (!m) this.progress.set(key, (m = new Map()));
    if (!m.has(p.key)) m.set(p.key, t);
    if (p.progKey == null || key > p.progKey) {
      p.progKey = key;
      p.progT = t;
    }
  }

  onCrossing(p, { prevLap, prevFin, lap, gate, t, fin, firstSight }) {
    let dirty = false;
    const cur = p.cur;

    if (fin) {
      // Final lap line: the game reports gate = lastGate + 1.
      if (!prevFin && cur && !cur.closed && lap === cur.lap) dirty = this.closeLap(p, t, gate - 1) || dirty;
      p.cur = null;
      const flown = this.currentRace()?.pilots[p.key]?.laps.length || (cur && !cur.glitch && cur.crossings.length);
      const entry = !prevFin && flown && this.currentRace() && this.raceEntry(p);
      if (entry && !entry.finished) {
        entry.finished = true;
        entry.totalTime = t;
        entry.position = p.position;
        delete entry.stopped;
        p.totalTime = t;
        if (p.progKey == null || p.progKey < (lap + 1) * 1000) this.recordProgress(p, (lap + 1) * 1000, t);
        this.event({ type: 'finish', raceId: this.raceId, pilot: p.name, text: `finished ${fmtTime(t)}${p.position ? ` (P${p.position})` : ''}` });
        dirty = true;
      }
      return dirty;
    }
    if (lap <= 0) return false; // before the first start-gate crossing

    if (!cur || lap !== cur.lap) {
      const lay0 = this.track()?.layout;
      if (lay0 && gate > lay0.lastGate) {
        // Finish trigger (lastGate+1) reported before the start trigger (on the holeshot, or with the
        // lap counter already bumped): close the lap if one is open; the next lap starts at the
        // start gate's report.
        if (cur && lap === cur.lap + 1 && !cur.closed) dirty = this.closeLap(p, t, gate - 1) || dirty;
        return dirty;
      }
      // Lap line crossed (or first time we see this pilot).
      let startTime = t;
      if (cur && lap === cur.lap + 1) {
        if (!cur.closed) dirty = this.closeLap(p, t, null) || dirty;
        startTime = cur.endTime ?? t;
      }
      const knownStart = this.track()?.layout?.startGate;
      const observedTransition = cur ? lap === cur.lap + 1 : prevLap != null && lap === prevLap + 1;
      const valid =
        observedTransition ||
        (knownStart != null && gate === knownStart) ||
        (firstSight && lap === 1 && this.live.sawStart);
      p.cur = newLap(lap, startTime, gate, !valid);
      if (valid) {
        // A fresh lap 1 means a new race if the game didn't announce one (missed "start" message,
        // race restarted from the menu, single-player retry...).
        const race = this.currentRace();
        const e = race?.pilots[p.key];
        if (!race || (lap === 1 && (race.status !== 'running' || e?.laps.length || e?.holeshot))) {
          this.startRace();
          dirty = true;
        }
        this.recordProgress(p, lap * 1000, startTime);
        if (lap === 1) dirty = this.holeshot(p, startTime) || dirty;
        this.onLapStart({ key: p.key, lap, start: startTime, gOff: p.gOff });
      }
      return dirty;
    }

    if (gate === cur.startGate) {
      // Lap line reported before the lap counter increments (game sends lap L, then L+1).
      if (!cur.closed) dirty = this.closeLap(p, t, null) || dirty;
      return dirty;
    }
    if (cur.closed) return dirty;
    const lay = this.track()?.layout;
    if (lay?.confirmed && lay.startGate === cur.startGate && gate > lay.lastGate) {
      // The start/finish gate's finish trigger (reported as lastGate+1, ~0.03 s before the start
      // trigger) on a lap that isn't the last one: that's the lap line.
      return this.closeLap(p, t, gate - 1) || dirty;
    }
    // Otherwise the layout is only (re)learned when the lap closes: a gate past the known last gate
    // may just be the finish line arriving one update before the finished flag.
    cur.crossings.push({ gate, t });
    cur.maxGate = Math.max(cur.maxGate, gate);
    if (!cur.partial) this.recordProgress(p, lap * 1000 + (gate - cur.startGate), t);
    if (this.updateCum(p, cur, null)) dirty = this.evalSegments(p, cur) || dirty;
    return this.evalSectors(p, cur, null) || dirty;
  }

  /** First pass through the start gate: race time = holeshot. */
  holeshot(p, t) {
    if (!this.track()) {
      p.hsPending = t; // new unnamed track: recorded once the first lap identifies it
      return false;
    }
    const t0 = this.track();
    const rec = this.pilotRecord(p);
    const prev = rec.hsBest ?? null;
    // Purple = all-time PB, green = best of this session so far.
    const sess = this.sessBest(p.key);
    const pb = prev == null || t < prev;
    const sb = sess.hs == null || t < sess.hs;
    const hs = { time: t, pb, sb, delta: prev == null ? null : ms(t - prev) };
    if (pb) rec.hsBest = t;
    if (sb) sess.hs = t;
    p.holeshot = hs;
    const e = this.raceEntry(p);
    if (e) e.holeshot = hs;
    if (hs.pb && prev != null) {
      const rec2 = othersBest(t0, p.key, (r) => r.hsBest);
      this.event({ type: 'pb', pilot: p.name, text: `Holeshot ${t.toFixed(3)} (${fmtDelta(hs.delta)}) PB${rec2 != null && t < rec2 ? ' · track record' : ''}` });
    }
    return true;
  }

  closeLap(p, endTime, finishLastGate) {
    const cur = p.cur;
    if (!cur || cur.closed) return false;
    cur.closed = true;
    const lastC = cur.crossings.at(-1);
    const lay = this.track()?.layout;
    const knownLast = lay && lay.startGate === cur.startGate ? lay.lastGate : null;
    const gap = lastC ? endTime - lastC.t : Infinity;
    const trigger =
      lastC && cur.crossings.length >= 2 && lastC.gate === cur.maxGate &&
      (knownLast != null ? lastC.gate > knownLast && gap < KNOWN_TRIGGER_GAP : gap < FINISH_TRIGGER_GAP);
    if (finishLastGate == null && trigger) {
      // The start/finish gate's finish trigger (reported as lastGate+1) just before the lap line.
      cur.crossings.pop();
      cur.maxGate = Math.max(cur.startGate, ...cur.crossings.map((c) => c.gate));
      endTime = lastC.t;
    }
    cur.endTime = endTime;
    cur.lapTime = ms(endTime - cur.startTime);
    let dirty = false;
    if (!cur.partial && (cur.lapTime < MIN_LAP || !cur.crossings.length)) {
      // Not a lap: the game reported the line again without any gate in between (race reset, respawn).
      cur.partial = true;
      cur.glitch = true;
    }
    if (!cur.partial) {
      this.recordProgress(p, (cur.lap + 1) * 1000, endTime);
      const confirmed = finishLastGate != null && finishLastGate > cur.startGate;
      const lastGate = confirmed ? finishLastGate : cur.maxGate;
      if (lastGate > cur.startGate) dirty = this.learnLayout(cur.startGate, lastGate, confirmed) || dirty;
      if (this.track()) {
        if (p.hsPending != null) {
          const hsT = p.hsPending;
          p.hsPending = null;
          this.holeshot(p, hsT);
        }
        dirty = this.evalSectors(p, cur, endTime) || dirty;
        this.updateCum(p, cur, endTime);
        this.evalSegments(p, cur);
        dirty = this.recordLap(p, cur) || dirty;
        const race = this.currentRace();
        if (race) {
          race.trackId = this.trackId;
          const sess = this.currentSession();
          if (sess) sess.trackId = this.trackId;
          const entry = this.raceEntry(p);
          entry.laps.push({
            lap: cur.lap,
            lapTime: cur.lapTime,
            start: cur.startTime,
            end: endTime,
            pos: p.position ?? null,
            sectors: cur.sectors.map((s) => ({ ...s })),
            cum: cur.cum ? [...cur.cum] : null,
            segFlags: cur.segFlags ? cur.segFlags.map((f) => (f === undefined ? null : f)) : null,
            lapPb: cur.lapPb,
            lapSb: cur.lapSb,
            lapDelta: cur.lapDelta,
          });
          this.onLap({
            raceId: race.id, trackId: this.trackId, key: p.key, name: p.name, lap: cur.lap, start: cur.startTime, end: endTime,
            lapTime: cur.lapTime, cum: cur.cum, incomplete: false, isPb: cur.lapPb, gOff: p.gOff,
          });
        }
      }
    } else if (!cur.glitch && finishLastGate != null && this.track()?.layout?.startGate != null) {
      this.learnLayout(this.track().layout.startGate, finishLastGate, true);
    }
    if (!cur.glitch) p.last = cur;
    return dirty;
  }

  /** Fill in the lap's timing-point times (needs a known layout). Returns true if any are new. */
  updateCum(p, cur, endTime) {
    const plan = this.plan();
    if (!plan || cur.partial) return false;
    if (cur.cumKey !== plan.layoutKey) {
      cur.cumKey = plan.layoutKey;
      cur.cum = Array(plan.gates).fill(null);
      cur.segFlags = Array(plan.gates).fill(undefined);
    }
    let added = false;
    for (const c of cur.crossings) {
      const i = c.gate - plan.startGate - 1;
      if (i >= 0 && i < plan.gates - 1 && cur.cum[i] == null) {
        cur.cum[i] = ms(c.t - cur.startTime);
        added = true;
      }
    }
    if (endTime != null && cur.cum[plan.gates - 1] == null) {
      cur.cum[plan.gates - 1] = ms(endTime - cur.startTime);
      added = true;
    }
    // Live delta to the pilot's PB lap at the latest timing point.
    let last = -1;
    for (let i = cur.cum.length - 1; i >= 0; i--) if (cur.cum[i] != null) { last = i; break; }
    cur.lastIdx = last;
    const rec = this.track()?.pilots[p.key];
    const pb = rec && rec.segKey === plan.layoutKey ? rec.pbCum : null;
    if (last >= 0 && pb && pb[last] != null) {
      cur.delta = ms(cur.cum[last] - pb[last]);
      cur.deltaIdx = last;
    }
    return added;
  }

  /** Record newly completed gate splits (exact ones only: both ends reported). */
  evalSegments(p, cur) {
    if (!cur.cum) return false;
    let dirty = false;
    for (let i = 0; i < cur.cum.length; i++) {
      if (cur.cum[i] == null || cur.segFlags[i] !== undefined) continue;
      if (i > 0 && cur.cum[i - 1] == null) {
        // The gate before was never reported (two gates inside one 100 ms update): only the combined
        // time of both splits is known.
        cur.segFlags[i] = null;
        if (cur.segFlags[i - 1] === undefined) cur.segFlags[i - 1] = null;
        continue;
      }
      cur.segFlags[i] = this.recordSeg(p, i, ms(cur.cum[i] - (i ? cur.cum[i - 1] : 0)));
      dirty = true;
    }
    return dirty;
  }

  /** Ensure the pilot's gate-split records match the current layout. */
  segRecord(rec) {
    const plan = this.plan();
    if (rec.segKey !== plan.layoutKey || !Array.isArray(rec.segBest)) {
      rec.segKey = plan.layoutKey;
      rec.segBest = Array(plan.gates).fill(null);
      rec.pbCum = null;
      rec.pbCumLap = null;
    }
    return rec;
  }

  recordSeg(p, i, time) {
    const t = this.track();
    const plan = this.plan();
    const rec = this.segRecord(this.pilotRecord(p));
    const prev = rec.segBest[i];
    const sess = this.sessBest(p.key);
    const pb = prev == null || time < prev;
    const sb = sess.seg[i] == null || time < sess.seg[i];
    if (pb) rec.segBest[i] = time;
    if (sb) sess.seg[i] = time;
    return pb ? 2 : sb ? 1 : 0; // 2 purple (all-time PB), 1 green (session best), 0 yellow
  }

  /** Work out which sectors this lap has completed; record newly completed ones. */
  evalSectors(p, cur, endTime) {
    if (cur.partial) return false;
    const plan = this.plan();
    if (!plan) return false;
    if (cur.planKey !== plan.key) {
      cur.planKey = plan.key;
      cur.splits = [];
      cur.sectors = [];
    }
    // Splits = times at which each sector boundary gate was passed.
    for (let k = cur.splits.length; k < plan.ends.length; k++) {
      const c = cur.crossings.find((x) => x.gate >= plan.ends[k] && (k === 0 || x.t >= cur.splits[k - 1].t));
      if (!c) break;
      // If the exact boundary gate was never reported (two gates inside one 100 ms update), we only
      // know the time at a later gate: keep the split but don't let it set records.
      cur.splits.push({ t: c.t, approx: c.gate !== plan.ends[k] });
    }
    let dirty = false;
    const done = endTime != null && cur.splits.length === plan.ends.length ? SECTORS : cur.splits.length;
    for (let k = cur.sectors.length; k < done; k++) {
      const start = k === 0 ? cur.startTime : cur.splits[k - 1].t;
      const end = k < plan.ends.length ? cur.splits[k].t : endTime;
      const approx = (k > 0 && cur.splits[k - 1].approx) || (k < plan.ends.length && cur.splits[k].approx);
      cur.sectors.push(this.recordSector(p, k, ms(end - start), !approx));
      dirty = true;
    }
    return dirty;
  }

  pilotRecord(p) {
    const t = this.track();
    const rec = (t.pilots[p.key] ||= {
      name: p.name,
      best: Array(SECTORS).fill(null),
      bestAt: Array(SECTORS).fill(null),
      bestLap: null,
      bestLapAt: null,
      laps: 0,
      lastSeen: null,
    });
    rec.name = p.name;
    if (p.colour) rec.colour = p.colour;
    rec.lastSeen = this.now();
    t.updated = this.now();
    return rec;
  }

  recordSector(p, k, time, eligible) {
    const t = this.track();
    const rec = this.pilotRecord(p);
    const prev = rec.best[k];
    const others = othersBest(t, p.key, (r) => r.best[k]);
    const sess = this.sessBest(p.key);
    const pb = eligible && (prev == null || time < prev);
    const sb = eligible && (sess.sec[k] == null || time < sess.sec[k]);
    if (pb) {
      rec.best[k] = time;
      rec.bestAt[k] = this.now();
    }
    if (sb) sess.sec[k] = time;
    const s = { time, delta: prev == null ? null : ms(time - prev), pb, sb, approx: !eligible };
    if (pb) {
      this.event({
        type: 'pb',
        pilot: p.name,
        text: `S${k + 1} ${time.toFixed(3)}${s.delta != null ? ` (${fmtDelta(s.delta)})` : ''} PB${others != null && time < others ? ' · track record' : ''}`,
      });
    }
    return s;
  }

  recordLap(p, cur) {
    const rec = this.pilotRecord(p);
    const t = this.track();
    rec.laps += 1;
    const others = othersBest(t, p.key, (r) => r.bestLap);
    const sess = this.sessBest(p.key);
    cur.lapPb = rec.bestLap == null || cur.lapTime < rec.bestLap;
    cur.lapSb = sess.lap == null || cur.lapTime < sess.lap;
    cur.lapDelta = rec.bestLap == null ? null : ms(cur.lapTime - rec.bestLap);
    if (cur.lapSb) sess.lap = cur.lapTime;
    if (cur.lapPb) {
      rec.bestLap = cur.lapTime;
      rec.bestLapAt = this.now();
      this.event({
        type: 'pb',
        pilot: p.name,
        text: `Lap ${cur.lapTime.toFixed(3)}${cur.lapDelta != null ? ` (${fmtDelta(cur.lapDelta)})` : ''} PB${others != null && cur.lapTime < others ? ' · track record' : ''}`,
      });
    }
    // Reference profile for the live delta: the fastest lap with gate times.
    if (cur.cum && this.plan()) {
      this.segRecord(rec);
      if (rec.pbCumLap == null || cur.lapTime < rec.pbCumLap) {
        rec.pbCum = [...cur.cum];
        rec.pbCumLap = cur.lapTime;
      }
    }
    return true;
  }

  // ---------- telemetry results (telemetry.mjs via the server) ----------

  setTrackMap(trackId, map) {
    const t = this.db.tracks[trackId];
    if (!t) return;
    t.map = { ...map, v: (t.map?.v || 0) + 1 };
    this.changed(true);
  }

  setRefLap(trackId, key, tel) {
    const rec = this.db.tracks[trackId]?.pilots[key];
    if (!rec) return;
    rec.pbTel = tel;
    rec.pbTelV = (rec.pbTelV || 0) + 1;
    this.changed(true);
  }

  trackData(id) {
    const t = own(this.db.tracks, id);
    if (!t) return null;
    const refs = {};
    for (const [key, r] of Object.entries(t.pilots)) if (r.pbTel) refs[key] = r.pbTel;
    return { id, map: t.map || null, refs };
  }

  // ---------- admin actions (from the web UI) ----------

  renameTrack(id, name) {
    const t = own(this.db.tracks, id);
    if (!t || !stripTags(name)) return false;
    t.displayName = stripTags(name).slice(0, 80);
    this.changed(true);
    return true;
  }

  mergeTrack(fromId, toId) {
    const from = own(this.db.tracks, fromId);
    const to = own(this.db.tracks, toId);
    if (!from || !to || from === to) return false;
    this.mergeInto(from, to);
    this.changed(true);
    return true;
  }

  relearnTrack(id) {
    const t = own(this.db.tracks, id);
    if (!t) return false;
    t.layout = null;
    t.map = null;
    for (const rec of Object.values(t.pilots)) {
      rec.best = Array(SECTORS).fill(null);
      rec.bestAt = Array(SECTORS).fill(null);
      rec.segBest = null;
      rec.segKey = null;
      rec.pbCum = null;
      rec.pbCumLap = null;
    }
    for (const p of Object.values(this.live.pilots)) if (p.cur) p.cur.planKey = p.cur.cumKey = null;
    this.changed(true);
    return true;
  }

  deletePilot(id, key) {
    const t = own(this.db.tracks, id);
    if (!t || !own(t.pilots, key)) return false;
    delete t.pilots[key];
    this.changed(true);
    return true;
  }

  deleteTrack(id) {
    if (!this.removeTrack(id)) return false;
    this.pruneSessions();
    this.changed(true);
    return true;
  }

  removeTrack(id) {
    if (!own(this.db.tracks, id)) return false;
    delete this.db.tracks[id];
    const gone = this.db.races.filter((r) => r.trackId === id).map((r) => r.id);
    this.db.races = this.db.races.filter((r) => r.trackId !== id);
    this.onRacesRemoved(gone);
    if (!this.currentRace()) this.raceId = null;
    if (this.db.lastTrackId === id) this.db.lastTrackId = null;
    if (this.trackId === id) this.trackId = null;
    return true;
  }

  /**
   * Data management (web UI): delete sessions (with their races and telemetry) or only their
   * telemetry, whole tracks, and pilots' records. The session in progress can't be deleted.
   */
  deleteData({ sessions = [], telemetryOnly = false, tracks = [], records = [] } = {}) {
    const out = { sessions: 0, races: 0, telemetry: 0, tracks: 0, records: 0 };
    const sids = new Set(sessions.map(Number).filter((id) => id !== this.sessionId));
    const inSess = this.db.races.filter((r) => sids.has(r.sessionId));
    if (telemetryOnly) {
      const ids = inSess.filter((r) => r.tel).map((r) => r.id);
      for (const r of inSess) r.tel = false;
      this.onTelemetryRemoved(ids);
      out.telemetry = ids.length;
    } else if (sids.size) {
      this.db.races = this.db.races.filter((r) => !sids.has(r.sessionId));
      const before = this.db.sessions.length;
      this.db.sessions = this.db.sessions.filter((s) => !sids.has(s.id));
      this.onRacesRemoved(inSess.map((r) => r.id));
      out.sessions = before - this.db.sessions.length;
      out.races = inSess.length;
    }
    for (const [tid, key] of records) {
      if (own(own(this.db.tracks, tid)?.pilots, key)) {
        delete this.db.tracks[tid].pilots[key];
        out.records++;
      }
    }
    for (const id of tracks) if (this.removeTrack(id)) out.tracks++;
    if (!this.currentRace()) this.raceId = null;
    this.pruneSessions();
    for (const id of Object.keys(this.db.tracks)) this.recomputeFlags(id);
    this.changed(true);
    return out;
  }

  /**
   * Recreate a track's records from its saved race history only (after deleting bad data). Bests
   * from laps that aren't in the history any more are dropped.
   */
  rebuildRecords(id) {
    const t = own(this.db.tracks, id);
    if (!t) return false;
    const old = t.pilots;
    t.pilots = {};
    for (const r of this.db.races) {
      if (r.trackId !== id) continue;
      for (const [key, e] of Object.entries(r.pilots)) {
        const done = e.laps.filter((l) => l.lapTime != null).length;
        if (!done && !e.holeshot && !e.laps.length) continue;
        const rec = (t.pilots[key] ||= { name: e.name, colour: e.colour || old[key]?.colour, best: Array(SECTORS).fill(null), bestAt: Array(SECTORS).fill(null), bestLap: null, bestLapAt: null, laps: 0, lastSeen: null });
        rec.laps += done;
        rec.lastSeen = Math.max(rec.lastSeen || 0, raceEnd(r));
      }
    }
    this.improveFromHistory(t);
    this.recomputeFlags(id);
    for (const [key, rec] of Object.entries(t.pilots)) {
      const o = old[key]?.pbTel;
      if (o && rec.bestLap != null && Math.abs(o.lapTime - rec.bestLap) < 0.002) {
        rec.pbTel = o;
        rec.pbTelV = old[key].pbTelV;
      }
    }
    t.updated = this.now();
    this.changed(true);
    return true;
  }

  // ---------- output ----------

  event(e) {
    this.live.events.unshift({ ...e, at: this.now() });
    this.live.events.length = Math.min(this.live.events.length, MAX_EVENTS);
  }

  changed(dbDirty) {
    if (dbDirty) this.historyVersion++;
    this.onChange(dbDirty);
  }

  /** Small, frequently pushed state: the race in progress. */
  liveSnapshot() {
    const t = this.live.onMap ? this.track() : null;
    const plan = sectorPlan(t?.layout);
    const race = this.currentRace();
    const lapView = (l) =>
      l && {
        lap: l.lap,
        partial: l.partial,
        closed: l.closed,
        start: l.startTime,
        sectors: l.sectors,
        cum: l.cumKey === plan?.layoutKey ? l.cum : null,
        segFlags: l.cumKey === plan?.layoutKey ? l.segFlags?.map((f) => (f === undefined ? null : f)) : null,
        lastIdx: l.lastIdx ?? -1,
        lastT: l.crossings.length ? l.crossings.at(-1).t : l.startTime,
        delta: l.delta ?? null,
        deltaIdx: l.deltaIdx ?? null,
        lapTime: l.lapTime ?? null,
        lapPb: !!l.lapPb,
        lapSb: !!l.lapSb,
        lapDelta: l.lapDelta ?? null,
      };

    // Running order and gaps from the time each pilot reached the same point on track.
    const ps = Object.values(this.live.pilots);
    const ranked = ps.filter((p) => p.progKey != null).sort((a, b) => b.progKey - a.progKey || a.progT - b.progT);
    const rest = ps.filter((p) => p.progKey == null).sort((a, b) => (a.position || 99) - (b.position || 99));
    const leader = ranked[0];
    const order = [...ranked, ...rest];
    const recs = t?.pilots || {};
    const pilots = order.map((p, i) => {
      let gap = null, interval = null, gapLaps = 0, intervalLaps = 0;
      if (p.progKey != null && i > 0 && leader) {
        const m = this.progress.get(p.progKey);
        gapLaps = Math.floor((leader.progKey - p.progKey) / 1000);
        const first = m ? Math.min(...m.values()) : null;
        if (first != null) gap = ms(p.progT - first);
        const ahead = order[i - 1];
        intervalLaps = Math.floor((ahead.progKey - p.progKey) / 1000);
        const at = m?.get(ahead.key);
        if (at != null) interval = ms(p.progT - at);
      }
      const rec = recs[p.key];
      const segOk = rec && plan && rec.segKey === plan.layoutKey;
      const entry = race?.pilots[p.key];
      const raceLaps = (entry?.laps || []).filter((l) => l.lapTime != null).map((l) => l.lapTime);
      return {
        key: p.key,
        name: p.name,
        colour: p.colour,
        rank: p.progKey != null ? i + 1 : null,
        gamePos: p.position,
        lap: p.lap,
        finished: p.finished,
        totalTime: entry?.finished ? entry.totalTime : null,
        gap, gapLaps, interval, intervalLaps,
        offset: Number.isFinite(p.offset) ? p.offset : null,
        holeshot: p.holeshot || entry?.holeshot || null,
        lapsDone: raceLaps.length,
        raceBest: raceLaps.length ? Math.min(...raceLaps) : null,
        raceBestFlag: (() => {
          const l = raceLaps.length ? entry.laps.find((x) => x.lapTime === Math.min(...raceLaps)) : null;
          return l ? (l.lapPb ? 2 : l.lapSb ? 1 : 0) : null;
        })(),
        current: lapView(p.cur),
        last: lapView(p.last),
        best: rec ? { lap: rec.bestLap, sectors: rec.best, hs: rec.hsBest ?? null, theoretical: sumAll(rec.best), ultimate: segOk ? sumAll(rec.segBest) : null } : null,
        segBest: segOk ? rec.segBest : null,
        pbCum: segOk ? rec.pbCum : null,
      };
    });
    const trackSegBest = plan
      ? Array.from({ length: plan.gates }, (_, i) => minOf(Object.values(recs).filter((r) => r.segKey === plan.layoutKey && r.segBest).map((r) => r.segBest[i])))
      : null;
    const raceNo = race ? this.db.races.filter((r) => r.sessionId === race.sessionId && r.id <= race.id).length : null;
    const sess = this.currentSession();
    return {
      connected: this.live.connected,
      endpoint: this.live.endpoint,
      lastMessageAt: this.live.lastMessageAt,
      raceStatus: this.live.raceStatus,
      countdown: this.live.countdown,
      raceLaps: race?.raceLaps ?? this.raceLaps(),
      session: this.live.session,
      gameTrack: this.live.gameTrack,
      onMap: this.live.onMap,
      trackSource: t ? this.live.trackSource : 'none',
      trackId: t ? t.id : null,
      trackName: t ? t.displayName || t.name : null,
      sceneryTitle: t?.sceneryTitle || '',
      trackGuessed: !!t && this.live.trackSource === 'guess',
      plan,
      trackBest: t ? { lap: minOf(Object.values(recs).map((r) => r.bestLap)), sectors: [0, 1, 2].map((k) => minOf(Object.values(recs).map((r) => r.best[k]))), hs: minOf(Object.values(recs).map((r) => r.hsBest)), segs: trackSegBest } : null,
      localKey: this.localKey(),
      raceId: this.raceId,
      raceNo,
      sessionId: this.sessionId,
      sessionStartedAt: sess?.startedAt ?? null,
      raceStartedAt: race?.startedAt ?? null,
      pilots,
      events: this.live.events,
      historyVersion: this.historyVersion,
      now: this.now(),
    };
  }

  /** Records and race history: pushed only when it changes. */
  historySnapshot() {
    const tracks = Object.values(this.db.tracks)
      .map((x) => {
        const plan = sectorPlan(x.layout);
        return {
          id: x.id,
          name: x.displayName || x.name,
          gameName: x.name,
          sceneryTitle: x.sceneryTitle,
          layout: x.layout,
          plan,
          updated: x.updated || 0,
          mapVersion: x.map ? `${x.map.v}:${Object.values(x.pilots).reduce((a, r) => a + (r.pbTelV || 0), 0)}` : null,
          records: Object.entries(x.pilots)
            .map(([key, r]) => {
              const segOk = plan && r.segKey === plan.layoutKey && Array.isArray(r.segBest);
              return {
                key,
                name: r.name,
                colour: r.colour || null,
                best: r.best,
                bestLap: r.bestLap,
                hsBest: r.hsBest ?? null,
                theoretical: sumAll(r.best),
                segBest: segOk ? r.segBest : null,
                ultimate: segOk ? sumAll(r.segBest) : null,
                laps: r.laps,
                lastSeen: r.lastSeen,
                hasTel: !!r.pbTel,
              };
            })
            .sort((a, b) => (a.bestLap ?? a.theoretical ?? 1e9) - (b.bestLap ?? b.theoretical ?? 1e9)),
        };
      })
      .sort((a, b) => b.updated - a.updated);
    // Races numbered within their session; newest first. All of them (the history is capped on disk).
    const counts = {};
    const races = this.db.races
      .map((r) => ({
        id: r.id,
        sessionId: r.sessionId,
        trackId: r.trackId,
        no: (counts[r.sessionId] = (counts[r.sessionId] || 0) + 1),
        startedAt: r.startedAt,
        status: r.status,
        raceLaps: r.raceLaps,
        sessionName: r.sessionName,
        tel: !!r.tel,
        pilots: Object.entries(r.pilots).map(([key, e]) => ({ key, ...e })),
      }))
      .reverse();
    const sessions = this.db.sessions
      .map((s) => {
        const rs = this.db.races.filter((r) => r.sessionId === s.id);
        const laps = rs.flatMap((r) => Object.values(r.pilots).flatMap((e) => e.laps.filter((l) => l.lapTime != null)));
        const t = this.db.tracks[s.trackId];
        return {
          id: s.id,
          trackId: s.trackId,
          trackName: t ? t.displayName || t.name : 'Deleted track',
          startedAt: s.startedAt,
          endedAt: s.endedAt,
          endReason: s.endReason,
          current: s.id === this.sessionId,
          races: rs.length,
          laps: laps.length,
          best: minOf(laps.map((l) => l.lapTime)),
          pilots: [...new Set(rs.flatMap((r) => Object.values(r.pilots).map((e) => e.name)))],
        };
      })
      .reverse();
    return { version: this.historyVersion, tracks, races, sessions };
  }

  /** Everything (tests, /api/state). */
  snapshot() {
    return { live: this.liveSnapshot(), history: this.historySnapshot() };
  }
}

/** Wall-clock time a race's last recorded crossing happened. */
function raceEnd(r) {
  let t = 0;
  for (const e of Object.values(r.pilots || {})) {
    t = Math.max(t, e.totalTime ?? 0);
    for (const l of e.laps || []) t = Math.max(t, l.end ?? (l.start != null && l.cum ? l.start + Math.max(0, ...l.cum.filter((v) => v != null)) : 0));
  }
  return r.startedAt + t * 1000;
}

function newPilot(key, name) {
  return {
    key, name: stripTags(name), cur: null, last: null,
    lap: undefined, gate: undefined, time: undefined, finished: false,
    wallOffs: [], gameOffs: [], offset: null, gOff: null,
    progKey: null, progT: null, holeshot: null, hsPending: null, totalTime: null,
  };
}

function newTrack(id, name, sceneryTitle) {
  return { id, name: stripTags(name), sceneryTitle: stripTags(sceneryTitle), layout: null, pilots: {}, updated: 0 };
}

function newLap(lap, startTime, startGate, partial) {
  return {
    lap,
    startTime,
    startGate,
    partial,
    crossings: [],
    maxGate: startGate,
    splits: [],
    sectors: [],
    planKey: null,
    cumKey: null,
    cum: null,
    segFlags: null,
    closed: false,
  };
}

function sameLayout(layout, startGate, lastGate, confirmed) {
  if (layout.startGate !== startGate) return false;
  if (confirmed && layout.confirmed) return layout.lastGate === lastGate;
  return true;
}

/** Best of every other pilot on the track (a track best has to beat someone else). */
function othersBest(track, key, pick) {
  return minOf(Object.entries(track.pilots).filter(([k]) => k !== key).map(([, r]) => pick(r)));
}

function minOf(arr) {
  let m = null;
  for (const v of arr) if (v != null && (m == null || v < m)) m = v;
  return m;
}

function sumAll(arr) {
  return Array.isArray(arr) && arr.length && arr.every((v) => v != null) ? ms(arr.reduce((a, b) => a + b, 0)) : null;
}

function fmtTime(t) {
  return t.toFixed(3); // plain seconds, like the page
}

function fmtDelta(d) {
  return (d > 0 ? '+' : d < 0 ? '−' : '±') + Math.abs(d).toFixed(3);
}
