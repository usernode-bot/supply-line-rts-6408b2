// Server-authoritative PvP match runner: one in-memory simulation per
// active lobby, stepped on a shared scheduler at the PvP rate (the
// clients' forced 1× speed = half the sim's native tick rate). Both
// players are predicted input consoles — their commands are validated
// and applied here, and they reconcile against the snapshots this
// module produces.
//
// The sim modules under public/js are browser ES modules but DOM-free,
// so they load fine in Node via dynamic import() (same pattern as
// attract-pool.js). State is in-memory; the lobby row's snapshot column
// is a periodic durability flush so a container restart (deploy) costs
// a few seconds of match progress, not the match: the first sync that
// touches an active lobby with no runner lazily revives it.

const TICK_MS = 200;            // 1 sim tick / 200 ms = PvP's 5 ticks/s
const MAX_TICKS_PER_BEAT = 15;  // catch-up bound per scheduler beat
const SNAP_TICKS = 5;           // rebuild the snapshot at least every ~1 s
const PERSIST_MS = 5000;        // durability flush cadence
const ABANDON_MS = 60000;       // absent this long while opponent present -> forfeit
const IDLE_PAUSE_MS = 15000;    // both players absent -> stop ticking
const EVICT_IDLE_MS = 10 * 60000;   // both absent this long -> drop (revivable)
const FINISHED_LINGER_MS = 5 * 60000; // keep finished runners so clients see the outcome
const MAX_RUNNERS = 20;         // hardening: decline new matches past this

let pool = null;
let mods = null;                // { S, CMD } once the ES modules are loaded
const runners = new Map();      // lobbyId -> runner
let beatTimer = null;

async function loadMods() {
  if (!mods) {
    const [S, CMD] = await Promise.all([
      import('./public/js/sim.js'),
      import('./public/js/commands.js'),
    ]);
    mods = { S, CMD };
  }
  return mods;
}

function init(pgPool) { pool = pgPool; }

function hasCapacity() {
  let active = 0;
  for (const r of runners.values()) if (r.status === 'active') active++;
  return active < MAX_RUNNERS;
}

function newRunner(row, game, nextCmdId, nextEvId) {
  const now = Date.now();
  return {
    lobbyId: row.id,
    hostUserId: row.host_user_id, hostUsername: row.host_username,
    guestUserId: row.guest_user_id, guestUsername: row.guest_username,
    seed: row.seed,
    game,
    status: 'active', winnerOwner: null, endReason: null,
    nextCmdId, nextEvId,
    evBuf: [],                  // last ~50 events: {id, owner, msg}
    seenAt: [now, now],
    acc: 0, lastBeat: now,
    snapObj: null, snapTick: -1, snapAtTick: -1, snapDirty: true,
    lastPersist: now, persisting: false,
    finishedAt: null,
  };
}

function drainEvents(r) {
  const g = r.game;
  if (!g.events.length) return;
  for (const ev of g.events) {
    r.evBuf.push({ id: ++r.nextEvId, owner: ev.owner == null ? null : ev.owner, msg: ev.msg });
  }
  g.events.length = 0;
  if (r.evBuf.length > 50) r.evBuf.splice(0, r.evBuf.length - 50);
}

function buildSnapshot(r) {
  const { S } = mods;
  const snap = S.serialize(r.game);
  snap.appliedCmdId = r.nextCmdId;   // commands are applied on arrival
  snap.netEvents = r.evBuf.slice(-30);
  r.snapObj = snap;
  r.snapTick = r.game.tick;
  r.snapAtTick = r.game.tick;
  r.snapDirty = false;
}

async function persist(r, extra) {
  if (!pool || r.persisting) return;
  r.persisting = true;
  r.lastPersist = Date.now();
  try {
    if (!r.snapObj || r.snapDirty) buildSnapshot(r);
    await pool.query(`
      UPDATE lobbies SET snapshot = $2, snapshot_tick = $3,
        host_seen_at = to_timestamp($4 / 1000.0), guest_seen_at = to_timestamp($5 / 1000.0)
      WHERE id = $1
    `, [r.lobbyId, JSON.stringify(r.snapObj), r.snapTick, r.seenAt[0], r.seenAt[1]]);
    if (extra) await extra();
  } catch (err) {
    console.error(`match-runner persist failed (lobby ${r.lobbyId}):`, err.message);
  } finally {
    r.persisting = false;
  }
}

async function finalize(r, winnerOwner, reason) {
  if (r.status !== 'active') return;
  r.status = 'finished';
  r.winnerOwner = winnerOwner;
  r.endReason = reason;
  r.finishedAt = Date.now();
  if (!r.game.result) {
    r.game.result = winnerOwner === 0 ? 'p0-win' : 'p1-win';
    r.game.resultReason = r.game.resultReason || reason;
  }
  drainEvents(r);
  buildSnapshot(r);
  try {
    const upd = await pool.query(`
      UPDATE lobbies SET status = 'finished', winner_owner = $2, end_reason = $3,
        snapshot = $4, snapshot_tick = $5
      WHERE id = $1 AND status = 'active' RETURNING id
    `, [r.lobbyId, winnerOwner, reason, JSON.stringify(r.snapObj), r.snapTick]);
    // only the update that actually flipped the row records history
    if (upd.rows.length && r.guestUserId != null) {
      const duration = Math.max(0, Math.min(86400, Math.round(r.game.tick / 10)));
      const rowResult = (owner) => owner === winnerOwner ? 'win' : (reason === 'surrender' ? 'surrender' : 'loss');
      await pool.query(`
        INSERT INTO matches (user_id, username, result, difficulty, duration_seconds, map_seed, mode, opponent)
        VALUES ($1, $2, $3, 'pvp', $4, $5, 'pvp', $6),
               ($7, $8, $9, 'pvp', $4, $5, 'pvp', $10)
      `, [
        r.hostUserId, r.hostUsername, rowResult(0), duration, r.seed, r.guestUsername,
        r.guestUserId, r.guestUsername, rowResult(1), r.hostUsername,
      ]);
    }
  } catch (err) {
    console.error(`match-runner finalize failed (lobby ${r.lobbyId}):`, err.message);
  }
}

function beat() {
  const now = Date.now();
  const { S } = mods;
  for (const [id, r] of runners) {
    if (r.status === 'finished') {
      if (now - r.finishedAt > FINISHED_LINGER_MS) runners.delete(id);
      continue;
    }
    const lastSeen = Math.max(r.seenAt[0], r.seenAt[1]);
    // both players gone: stop the clock (world pauses with no one watching);
    // after a long absence drop the runner — the persisted snapshot revives it
    if (now - lastSeen > IDLE_PAUSE_MS) {
      r.lastBeat = now; r.acc = 0;
      if (now - lastSeen > EVICT_IDLE_MS && !r.persisting) {
        persist(r).then(() => runners.delete(id));
      }
      continue;
    }
    // one player gone >60 s while the other is around: forfeit
    for (const owner of [0, 1]) {
      const gone = now - r.seenAt[owner];
      const oppGone = now - r.seenAt[1 - owner];
      if (gone > ABANDON_MS && oppGone < ABANDON_MS) {
        finalize(r, 1 - owner, 'abandoned');
        break;
      }
    }
    if (r.status !== 'active') continue;

    r.acc += now - r.lastBeat;
    r.lastBeat = now;
    let steps = 0;
    while (r.acc >= TICK_MS && steps < MAX_TICKS_PER_BEAT && !r.game.result) {
      S.step(r.game);
      r.acc -= TICK_MS;
      steps++;
    }
    if (r.acc >= TICK_MS) r.acc = 0; // fell far behind (event-loop stall); drop backlog
    if (steps) {
      drainEvents(r);
      if (r.game.tick - r.snapAtTick >= SNAP_TICKS) r.snapDirty = true;
    }
    if (r.game.result) {
      const winner = r.game.result === 'p0-win' ? 0 : 1;
      finalize(r, winner, r.game.resultReason || 'elimination');
      continue;
    }
    if (r.snapDirty) buildSnapshot(r);
    if (now - r.lastPersist > PERSIST_MS) persist(r);
  }
  if (!runners.size && beatTimer) { clearInterval(beatTimer); beatTimer = null; }
}

function ensureBeating() {
  if (!beatTimer) beatTimer = setInterval(beat, 100);
}

// Start a fresh match for a lobby that just went active (join endpoint).
async function start(row) {
  const { S } = await loadMods();
  if (runners.has(row.id)) return runners.get(row.id);
  const game = S.newGame(row.seed, row.size_key, 'normal', true);
  const r = newRunner(row, game, 0, 0);
  drainEvents(r);
  buildSnapshot(r);
  runners.set(row.id, r);
  ensureBeating();
  persist(r); // first durability point right away
  return r;
}

// Get the runner for an active lobby, lazily reviving from the persisted
// snapshot after a restart. Returns null when the lobby isn't active.
async function ensure(row) {
  const existing = runners.get(row.id);
  if (existing) return existing;
  if (row.status !== 'active') return null;
  const { S } = await loadMods();
  let game, nextCmdId = 0, nextEvId = 0;
  if (row.snapshot) {
    game = S.deserialize(row.snapshot);
    nextCmdId = row.snapshot.appliedCmdId || 0;
    for (const ev of row.snapshot.netEvents || []) nextEvId = Math.max(nextEvId, ev.id || 0);
  } else {
    // legacy active row with no snapshot yet — start from tick 0
    game = S.newGame(row.seed, row.size_key, 'normal', true);
  }
  const r = newRunner(row, game, nextCmdId, nextEvId);
  drainEvents(r);
  buildSnapshot(r);
  runners.set(row.id, r);
  ensureBeating();
  return r;
}

// The polling endpoint's core: register presence, apply the caller's
// commands, answer with status + (when the caller is behind) a snapshot.
async function sync(row, owner, body) {
  const r = await ensure(row);
  if (!r) {
    return {
      status: row.status,
      winner_owner: row.winner_owner,
      end_reason: row.end_reason,
      command_ids: [],
    };
  }
  const now = Date.now();
  r.seenAt[owner] = now;
  const { CMD } = mods;
  const commands = Array.isArray(body.commands) ? body.commands.slice(0, 50) : [];
  const commandIds = [];
  for (const c of commands) {
    const id = ++r.nextCmdId;
    if (r.status === 'active') {
      try { CMD.applyCommand(r.game, owner, c); } catch { }
      r.snapDirty = true;
    }
    commandIds.push(id);
  }
  // a surrender command sets game.result — finalize without waiting a beat
  if (r.status === 'active' && r.game.result) {
    const winner = r.game.result === 'p0-win' ? 0 : 1;
    await finalize(r, winner, r.game.resultReason || 'elimination');
  }
  if (r.snapDirty) buildSnapshot(r);
  const haveTick = parseInt(body.haveTick, 10);
  const wantSnap = isNaN(haveTick) || haveTick < r.snapTick;
  return {
    status: r.status,
    tick: r.game.tick,
    snapshot_tick: r.snapTick,
    snapshot: wantSnap ? r.snapObj : undefined,
    command_ids: commandIds,
    opponent: owner === 0 ? r.guestUsername : r.hostUsername,
    opponentSeenAgoMs: now - r.seenAt[1 - owner],
    winner_owner: r.winnerOwner,
    end_reason: r.endReason,
  };
}

// Freshest state for the rejoin endpoint (falls back to the DB row when
// there's no live runner).
function peek(lobbyId) {
  const r = runners.get(lobbyId);
  if (!r) return null;
  if (r.snapDirty) buildSnapshot(r);
  return { snapshot: r.snapObj, snapshot_tick: r.snapTick, status: r.status };
}

module.exports = { init, hasCapacity, start, ensure, sync, peek };
