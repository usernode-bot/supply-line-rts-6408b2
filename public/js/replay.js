// Match replays (#223): the recorder, the shared advance step, and the
// playback player.
//
// A replay is NOT a video and NOT a series of state snapshots — it is the list
// of orders the player gave, re-run through the sim from tick 0. That works
// because the simulation is a pure function of (seed, sizeKey, difficulty,
// order log): every draw it makes runs through S.simRand off game.rngState
// (see SIM_VERSION in sim.js). The whole log for a 25-minute match is tens of
// KB; a single serialized snapshot is 40–80 KB.
//
// Deliberately DOM-free and storage-injected, like offline.js, so
// test/replay.mjs can drive it in Node the way the sim tests drive sim.js.
// main.js owns every side effect (fetching, rendering, the screen); this module
// owns the bookkeeping and the simulation cursor.

import * as S from './sim.js';
import { aiTick } from './ai.js';
import { applyCommand } from './commands.js';

export const REPLAY_KEY = 'supply-line-replays-v1';

export const LOG_MAX_ENTRIES = 4000;      // orders past this: stop recording
export const LOG_MAX_BYTES = 256 * 1024;  // serialized log cap
export const CHECK_TICKS = 600;           // integrity checkpoint cadence
export const KEYFRAME_TICKS = 600;        // in-memory seek keyframe cadence
// Keyframes are now exact clones of the live game rather than save-format
// snapshots (see keyframe/snapshot below), so each one costs more memory —
// held count trimmed to match. Twelve minutes of scrub-back is still more
// than the seek bar ever needs between slices.
export const KEYFRAME_MAX = 8;            // keyframes held at once
export const SEEK_SLICE = 300;            // ticks simulated per yielded slice
export const LOCAL_MAX = 10;              // logs kept on the device

// ---------------------------------------------------------------- advance

// ONE definition of "advance the simulation by a tick", shared by the live
// frame loop and the replay player so the two can never drift apart: step,
// then think — the AI runs right after the step that lands on its cadence,
// which is the ordering the live loop has always had.
export function advance(game) {
  S.step(game);
  if (!game.pvp && !game.tutorial && !game.practice
    && game.tick % S.aiCadence(game.difficulty) === 0) {
    aiTick(game, S);
  }
}

// ---------------------------------------------------------------- recorder

// A recording in flight. `entries` interleaves three kinds of row, all keyed by
// the tick they belong to:
//   { t, c }              an order, applied AFTER the tick's advance
//   { t, u0, u1, s0, s1 } an integrity checkpoint (unit/settlement counts)
//   { t, end }            the terminal result
export function createRecorder(game) {
  return {
    seed: game.seed,
    size_key: game.sizeKey,
    difficulty: game.difficulty,
    mode: game.pvp ? 'pvp' : 'solo',
    viewer_owner: game.pvp ? (game.me || 0) : 0,
    sim_version: S.SIM_VERSION,
    // #232: playback ALWAYS starts at tick 0, so a recorder that opened
    // partway through a match (resuming a save) produces entries whose
    // tick stamps mean nothing to the player. Recording it explicitly
    // makes that a checkable fact instead of a silent offset.
    start_tick: game.tick | 0,
    entries: [],
    lastCheck: -1,
    orders: 0,
    overflow: false,   // hit a cap — the match is finished but not replayable
    end_tick: 0,
  };
}

// ------------------------------------------------- resume journal (#232)
//
// Recording is per-session, but a match isn't: quit to the menu and resume
// and the second session's recorder used to open at tick 4000 and stamp
// its orders there, while playback dutifully started from zero. The order
// log is therefore journaled to the device alongside the autosave, and a
// resumed session picks the journal back up rather than starting a new,
// offset recorder. If no journal matches the save being resumed, the match
// is simply not recorded (see startMatch in main.js) — a missing replay is
// honest; a misaligned one is not.

export function journalOf(rec, game, stats) {
  if (!rec) return null;
  return {
    seed: rec.seed,
    size_key: rec.size_key,
    difficulty: rec.difficulty,
    mode: rec.mode,
    viewer_owner: rec.viewer_owner,
    sim_version: rec.sim_version,
    start_tick: rec.start_tick | 0,
    tick: game ? game.tick | 0 : 0,
    lastCheck: rec.lastCheck,
    orders: rec.orders,
    overflow: !!rec.overflow,
    entries: rec.entries,
    stats: stats || null,
  };
}

// Rebuild the in-flight recorder from a journal, but only when the journal
// provably belongs to THIS resumed game: same match parameters, same engine
// version, and stamped at exactly the tick the save was taken. Anything else
// returns null and the session records nothing.
export function recorderFromJournal(j, game) {
  if (!j || !game) return null;
  if ((j.sim_version | 0) !== S.SIM_VERSION) return null;
  if ((j.start_tick | 0) !== 0) return null;
  if (j.seed !== game.seed || j.size_key !== game.sizeKey) return null;
  if (j.difficulty !== game.difficulty) return null;
  if ((j.tick | 0) !== (game.tick | 0)) return null;
  if (!Array.isArray(j.entries)) return null;
  return {
    seed: j.seed,
    size_key: j.size_key,
    difficulty: j.difficulty,
    mode: j.mode,
    viewer_owner: j.viewer_owner | 0,
    sim_version: j.sim_version | 0,
    start_tick: 0,
    entries: j.entries.slice(),
    lastCheck: j.lastCheck != null ? j.lastCheck : -1,
    orders: j.orders | 0,
    overflow: !!j.overflow,
    end_tick: 0,
  };
}

function room(rec) {
  if (rec.overflow) return false;
  if (rec.orders >= LOG_MAX_ENTRIES) { rec.overflow = true; return false; }
  return true;
}

// One order, at the tick it was applied. main.js calls this from the same
// wrappers that already build PvP command descriptors, so the log speaks
// exactly the vocabulary applyCommand understands.
export function recordCommand(rec, tick, cmd, owner) {
  if (!rec || !cmd || !room(rec)) return;
  rec.entries.push(owner == null
    ? { t: tick | 0, c: cmd }
    : { t: tick | 0, o: owner | 0, c: cmd });
  rec.orders++;
  // A wall order carries up to 64 tiles, so entry count alone doesn't bound
  // size — check the real serialized length every so often.
  if (rec.orders % 50 === 0 && logBytes(rec) > LOG_MAX_BYTES) rec.overflow = true;
}

// Called once per advanced tick. Drops a checkpoint every CHECK_TICKS so
// playback can notice it has diverged from what was recorded.
export function recordTick(rec, game) {
  if (!rec || rec.overflow) return;
  const t = game.tick;
  if (t % CHECK_TICKS !== 0 || t === rec.lastCheck) return;
  rec.lastCheck = t;
  const a = S.unitCounts(game, 0), b = S.unitCounts(game, 1);
  rec.entries.push({ t, u0: a.units, u1: b.units, s0: a.setts, s1: b.setts });
}

// The terminal entry. Solo surrender sets game.result directly rather than
// going through applyCommand, and an elimination is set by the sim itself, so
// the log states the outcome explicitly instead of inferring it.
export function recordEnd(rec, game, result) {
  if (!rec) return;
  rec.end_tick = game.tick;
  if (rec.overflow) return;
  rec.entries.push({ t: game.tick, end: result });
}

export function logBytes(rec) {
  try { return JSON.stringify(rec.entries).length; } catch { return Infinity; }
}

// The payload POSTed to the server / stored on the device. Null when the
// recording overran its caps or never got going.
export function finishRecording(rec) {
  if (!rec || rec.overflow || !rec.entries.length) return null;
  // #232: fail closed. A log that doesn't cover the match from tick 0 can
  // only ever replay wrong, so it is never published.
  if ((rec.start_tick | 0) !== 0) return null;
  if (logBytes(rec) > LOG_MAX_BYTES) return null;
  return {
    seed: rec.seed,
    size_key: rec.size_key,
    difficulty: rec.difficulty,
    mode: rec.mode,
    viewer_owner: rec.viewer_owner,
    sim_version: rec.sim_version,
    end_tick: rec.end_tick,
    log: rec.entries,
  };
}

// ---------------------------------------------------------------- version gate

// The one playability rule (#223): a replay runs against the engine that
// recorded it, or it does not run. An older recording could show units
// surviving a fight they actually lost, and a NEWER one means this device is
// holding a stale bundle (the service worker deliberately never skipWaiting()s)
// — both are refused, and the UI says the engine changed.
export function playable(meta) {
  return !!meta && (meta.sim_version | 0) === S.SIM_VERSION;
}

// ---------------------------------------------------------------- player

// A live playback cursor. Owns its own game object; main.js renders it exactly
// like a live match, minus every order path.
export function createPlayer(meta) {
  if (!playable(meta)) return null;
  const entries = (meta.log || []).slice().sort((a, b) => (a.t | 0) - (b.t | 0));
  const p = {
    meta,
    entries,
    endTick: Math.max(0, meta.end_tick | 0),
    game: null,
    i: 0,             // next entry to consider
    keyframes: [],    // [{ tick, data, i }] — bounded, newest last
    drift: false,     // a checkpoint didn't match what was recorded
    seeking: false,
    reveal: false,   // render-only fog override — see setReveal (#228)
  };
  reset(p);
  return p;
}

// Rebuild at tick 0. Shared by createPlayer, Restart and any backward seek that
// lands before the oldest keyframe.
export function reset(p) {
  const m = p.meta;
  const g = S.newGame(m.seed, m.size_key, m.difficulty, m.mode === 'pvp');
  if (g.pvp) S.setViewer(g, m.viewer_owner | 0);
  g.replay = true;
  p.game = g;
  p.i = 0;
  p.keyframes = [];
  p.drift = false;        // #232: a fresh run has nothing to have drifted from
  applyAt(p, 0);          // tick-0 orders, if the log has any
  return g;
}

// Every entry stamped for `tick`, in recorded order. Orders are applied AFTER
// the tick's advance, which is where they landed live: step() reaches tick T,
// aiTick(T) thinks, then the frame's DOM events give orders while tick === T.
function applyAt(p, tick) {
  const g = p.game;
  while (p.i < p.entries.length && (p.entries[p.i].t | 0) <= tick) {
    const e = p.entries[p.i++];
    if (e.c) {
      // `o` is present on PvP logs, which record BOTH players' orders (the
      // server-authoritative runner sees them all). Solo logs omit it.
      const owner = e.o != null ? (e.o | 0) : (p.meta.viewer_owner | 0);
      try { applyCommand(g, owner, e.c); } catch { }
    } else if (e.end) {
      if (!g.result) g.result = e.end;
    } else if (e.u0 != null) {
      const a = S.unitCounts(g, 0), b = S.unitCounts(g, 1);
      if (a.units !== e.u0 || b.units !== e.u1 || a.setts !== e.s0 || b.setts !== e.s1) {
        p.drift = true;
      }
    }
  }
}

// #232: a seek keyframe must be an EXACT snapshot, not a save file.
// S.serialize is the save format — deliberately lossy about transient
// state (engagement timers, chase targets, cached paths, hunger latches,
// route delivery windows, the merge log, blob unit order). Restoring one
// mid-match therefore lands on a game that is *nearly* the recorded one,
// and every tick after that diverges a little further — which is what
// made rewound playback jitter and mis-report. structuredClone copies the
// whole live object graph, typed arrays and Sets included, so a rewind is
// bit-identical to where playback actually was.
//
// The exception is game.map: it is large, immutable except for `fert`,
// and the renderer keys its cached terrain layer on the map OBJECT, so
// cloning it would silently invalidate that cache every rewind. The map
// is lifted out, shared by reference, and only its mutable fertility
// array is snapshotted alongside.
function snapshot(g) {
  const map = g.map;
  g.map = null;
  let data;
  try {
    data = structuredClone(g);
  } finally {
    g.map = map;
  }
  return { data, fert: map.fert.slice(), pillaged: new Set(g.pillaged) };
}

function restore(p, snap) {
  const prev = p.game;
  const map = prev.map;
  // clone again on the way out: the keyframe has to stay reusable for the
  // next rewind to the same tick
  const g = structuredClone(snap.data);
  g.map = map;
  // roll fertility back and repaint every tile either state pillaged, so
  // the terrain layer can't keep showing scorched ground that un-happened
  for (let i = 0; i < map.fert.length; i++) map.fert[i] = snap.fert[i];
  for (const i of prev.pillaged) g.dirty.add(i);
  for (const i of snap.pillaged) g.dirty.add(i);
  p.game = g;
  return g;
}

function keyframe(p) {
  if (p.game.tick % KEYFRAME_TICKS !== 0) return;
  const last = p.keyframes[p.keyframes.length - 1];
  if (last && last.tick === p.game.tick) return;
  p.keyframes.push({ tick: p.game.tick, snap: snapshot(p.game), i: p.i });
  if (p.keyframes.length > KEYFRAME_MAX) p.keyframes.shift();
}

// Advance one tick and apply whatever the log stamped for it.
export function stepPlayer(p) {
  const g = p.game;
  if (g.result || g.tick >= p.endTick) return false;
  advance(g);
  applyAt(p, g.tick);
  keyframe(p);
  return true;
}

// Run up to `n` ticks. Returns how many actually happened, so the caller can
// tell a finished replay from a slow one.
export function runTicks(p, n) {
  let done = 0;
  for (let k = 0; k < n; k++) {
    if (!stepPlayer(p)) break;
    done++;
  }
  return done;
}

export function atEnd(p) {
  return !!p.game.result || p.game.tick >= p.endTick;
}

// Restore the newest keyframe at or before `tick` (rebuilding from scratch when
// there isn't one). The snapshot shares the previous game's map object, so the
// renderer's terrain layer stays valid across the rewind.
function rewindTo(p, tick) {
  let best = null;
  for (const k of p.keyframes) if (k.tick <= tick) best = k;
  if (!best) { reset(p); return; }
  restore(p, best.snap);
  p.game.replay = true;
  if (p.game.pvp) S.setViewer(p.game, p.meta.viewer_owner | 0);
  p.i = best.i;
  // #232: drift is a statement about the ticks currently on screen. Rewinding
  // discards those ticks, so the banner must not survive the rewind — it
  // re-raises by itself if the re-simulated run really does miss a checkpoint.
  p.drift = false;
  while (p.keyframes.length && p.keyframes[p.keyframes.length - 1].tick > best.tick) {
    p.keyframes.pop();
  }
}

// Seek to `tick`, yielding to the caller between slices so a long rewind never
// freezes the frame loop. `onSlice` is awaited between slices when given (the
// same yield-per-slice shape attract-pool.js uses server-side).
export async function seek(p, tick, onSlice) {
  const target = Math.max(0, Math.min(p.endTick, tick | 0));
  p.seeking = true;
  try {
    if (target < p.game.tick) rewindTo(p, target);
    while (p.game.tick < target) {
      const n = Math.min(SEEK_SLICE, target - p.game.tick);
      if (runTicks(p, n) === 0) break;   // result reached before the target
      if (onSlice) await onSlice(p);
    }
  } finally {
    p.seeking = false;
  }
  return p.game;
}

// Reveal-map is bookkeeping ONLY (#228). It used to fill game.fog with 2, but
// that array is simulation state — the player's pathfinder reads it for known
// mountains, remembered enemy settlements and known enemy wall tiles (pathFog
// in sim.js) — so revealing gave the recorded player knowledge they never had
// and the playback diverged from the match it was replaying (three of four
// measured matches tripped the integrity checkpoint). The renderer honours
// this flag via ui.reveal instead, which also makes it instantly reversible
// and independent of whether the player is stepping, paused or seeking.
export function setReveal(p, on) {
  p.reveal = !!on;
  return p.reveal;
}

// ---------------------------------------------------------------- local store

// Logs for matches finished on this device, keyed by the history entry's
// client_id, so a match played with no connection is replayable before its
// result has even synced. Newest first, capped — same shape/discipline as
// offline.js's history log.
export function readLocal(store) {
  const v = store.read(REPLAY_KEY, []);
  return Array.isArray(v) ? v : [];
}

export function saveLocal(store, clientId, payload) {
  if (!clientId || !payload) return;
  const rows = readLocal(store).filter((r) => r && r.client_id !== clientId);
  rows.unshift({ client_id: String(clientId).slice(0, 64), ...payload });
  store.write(REPLAY_KEY, rows.slice(0, LOCAL_MAX));
}

// A stale-engine local log can never be played and nothing else consumes it,
// so reading is also where it gets swept.
export function takeLocal(store, clientId) {
  const rows = readLocal(store);
  const hit = rows.find((r) => r && r.client_id === clientId) || null;
  if (hit && !playable(hit)) { dropLocal(store, clientId); return null; }
  return hit;
}

export function dropLocal(store, clientId) {
  const rows = readLocal(store).filter((r) => r && r.client_id !== clientId);
  store.write(REPLAY_KEY, rows);
}

// Which of this device's client_ids still have a log, and on what version — so
// the history list can render the playable / unavailable state for a row the
// server hasn't accepted yet.
export function localIndex(store) {
  const out = {};
  for (const r of readLocal(store)) {
    if (r && r.client_id) out[r.client_id] = r.sim_version | 0;
  }
  return out;
}
