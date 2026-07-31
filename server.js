const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const attractPool = require('./attract-pool');
const matchRunner = require('./match-runner');
const ratings = require('./ratings');

const app = express();
const port = process.env.PORT || 3000;
let server = null;          // captured from app.listen so shutdown can drain it
let shuttingDown = false;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const IS_STAGING = process.env.USERNODE_ENV === 'staging';

// Platform-issued user tokens are RS256, signed with a key whose PUBLIC half
// is all we hold (USERNODE_JWT_PUBLIC_KEY). Pinning the algorithm is therefore
// mandatory, not cosmetic: an unpinned verifier would also accept HS256 and
// treat that public PEM as an HMAC secret, letting any caller forge any user.
//
// Issuer, audience and the `pur` purpose claim are pinned too, so another
// app's token — or a token minted for a different purpose — can't be replayed
// here.
const USERNODE_JWT_PUBLIC_KEY = (process.env.USERNODE_JWT_PUBLIC_KEY || '')
  .replace(/\\n/g, '\n');

// Paths that stay open without authentication. Add a path here (and add it
// with `app.get`/`app.post` below) if you deliberately want it public.
// Everything else requires a valid platform-issued JWT.
const PUBLIC_API_PATHS = new Set(['/health', '/api/attract-snapshot', '/api/ai-ratings']);

// PvP snapshots are full serialized game states (~40-80 KB on a medium
// map), well past express.json's 100 kb default.
app.use(express.json({ limit: '2mb' }));

// Verify platform-issued JWT if one was passed, then enforce auth on
// anything not explicitly marked public. The iframe adds `?token=…`
// on load; the frontend script forwards the token via `x-usernode-token`
// on subsequent fetches.
app.use((req, res, next) => {
  const token = req.query.token || req.headers['x-usernode-token'];
  if (token && USERNODE_JWT_PUBLIC_KEY) {
    try {
      const claims = jwt.verify(token, USERNODE_JWT_PUBLIC_KEY, {
        algorithms: ['RS256'],
        issuer: 'usernode',
        audience: 'usernode:app:' + process.env.USERNODE_APP_ID,
      });
      if (claims && claims.pur === 'iframe') req.user = claims;
    } catch {}
  }

  // Static assets (CSS/JS/images) are always served; the API and the HTML
  // shell are gated so direct hits to the staging/prod subdomain don't
  // leak app data to the public internet.
  if (req.method !== 'GET' || req.path.startsWith('/api/')) {
    if (PUBLIC_API_PATHS.has(req.path)) return next();
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
});

// 503 once we're draining so anything polling readiness sees the container
// leaving rotation instead of a reset connection mid-deploy.
app.get('/health', (_req, res) => {
  if (shuttingDown) return res.status(503).json({ status: 'shutting down' });
  res.json({ status: 'ok' });
});

// The template ships no favicon file; index.html carries an inline SVG
// icon instead. Answer 204 here so anything that still probes
// /favicon.ico (older browsers, direct visits) doesn't fall through to
// the auth-gated catch-all and surface a 401 in the console on every
// fresh load.
app.get('/favicon.ico', (_req, res) => res.status(204).end());

// Attract-mode background (title screen): hand out a pre-simulated
// AI-vs-AI mid-game snapshot from the in-memory pool. Public — the
// payload is synthetic scenery with no user data, and the menu should
// get its backdrop even when the token is missing/expired. A cold pool
// answers 503 and the client falls back to simulating locally.
app.get('/api/attract-snapshot', (_req, res) => {
  const json = attractPool.take();
  if (!json) return res.status(503).json({ error: 'No snapshot ready yet' });
  res.type('application/json').send(json);
});

const RESULTS = new Set(['win', 'loss', 'surrender']);
const DIFFICULTIES = new Set(['easy', 'normal', 'hard', 'veryhard', 'pvp']);
const MAP_SIZES = new Set(['xsmall', 'small', 'medium', 'large']);

// Staging demo rows use negative user ids / ids in the 9001xx range so
// they can never collide with (or be mistaken for) real rows.
const DEMO_CHALLENGE_ID = 900103;
const DEMO_NAMES = ['Staging demo Quartermaster', 'Staging demo Forager', 'Staging demo Warden'];
const isDemoReq = (req) => IS_STAGING && req.query.demo === '1';

// ------------------------------------------------------------- replays (#223)
// A replay is an order log re-run through the client's own sim, so the server
// only stores and hands back bytes — it never simulates and never judges
// playability. That gate is `sim_version` vs the client's SIM_VERSION constant,
// checked in the browser next to the constant itself.
// The client's sim/replay engine version, read from public/js/sim.js at boot
// (same dynamic-import trick attract-pool.js uses for the browser modules).
// The server never simulates — it only needs the number so staging seeds can be
// stamped with the version the previewing client will actually accept.
let SIM_VERSION = 1;

const REPLAY_KEEP = 20;              // newest replays retained per user
const REPLAY_MAX_ENTRIES = 4000;     // mirrors LOG_MAX_ENTRIES in replay.js
const REPLAY_MAX_BYTES = 256 * 1024; // mirrors LOG_MAX_BYTES

// ---- staging demo replays -------------------------------------------------
// `replays` is a brand-new table, so staging copies it EMPTY and both the
// ▶ Replay buttons and the viewer itself would be unreviewable in a preview.
// These four rows fix that. The logs are hand-authored but genuinely valid.
//
// newGame assigns ids in ONE fixed order per side: the settlement, then its two
// working farmers, then the war party. So owner 0 is settlement 1, farmhands
// 2/3, WAR PARTY 4 — and owner 1 is settlement 5, farmhands 6/7, war party 8.
// (These logs used to say "the war party is blobs 2/3/4" and accordingly sent
// two farmhands on errands while the army never received a single order — a
// preview showed a motionless camp and some shuffling field hands, which is
// indistinguishable from "the replay is broken", see #228.)
//
// Starts are fixed per map size for every seed: xsmall is 36×36 with (9,9) and
// (27,27); small is 72×72 with (18,18) and (54,54). The destinations below are
// literal and reach enemy country on any seed of that size.
const DEMO_REPLAY_IDS = new Set([900201, 900202, 900203, 900204]);

// setMode → march the war party out → pillage → assault the enemy settlement →
// call the farmhands back, then the terminal result. Not good play; just
// watchable, and every entry applies.
const DEMO_LOG_SOLO = [
  { t: 20, c: { op: 'setMode', settlementId: 1, mode: 'farm' } },
  { t: 60, c: { op: 'move', blobId: 4, x: 23, y: 23 } },
  { t: 500, c: { op: 'pillage', blobId: 4, on: true } },
  { t: 760, c: { op: 'setMode', settlementId: 1, mode: 'deploy' } },
  { t: 900, c: { op: 'move', blobId: 4, x: 28, y: 28, target: { kind: 'settlement', id: 5 } } },
  { t: 1100, c: { op: 'backToWork' } },
  { t: 1200, end: 'win' },
];
const DEMO_LOG_PVP = [
  { t: 30, o: 0, c: { op: 'setMode', settlementId: 1, mode: 'supply' } },
  { t: 120, o: 0, c: { op: 'move', blobId: 4, x: 44, y: 44 } },
  { t: 300, o: 1, c: { op: 'move', blobId: 8, x: 46, y: 46 } },
  { t: 700, o: 0, c: { op: 'pillage', blobId: 4, on: true } },
  { t: 1100, end: 'p0-win' },
];

// id, owner, the match row it hangs off, and the log. 900204 is stamped
// sim_version 0 ON PURPOSE — an impossible-to-match version — so a preview also
// shows the "engine changed" state and its dialog without anyone having to bump
// SIM_VERSION to review that path.
const DEMO_REPLAYS = [
  { id: 900201, matchId: 900001, userId: -1, username: DEMO_NAMES[0], mode: 'solo', seed: 'staging-demo-1', size: 'xsmall', diff: 'normal', owner: 0, result: 'win', dur: 1622, end: 1200, log: DEMO_LOG_SOLO, stale: false },
  { id: 900202, matchId: 900002, userId: -2, username: DEMO_NAMES[1], mode: 'solo', seed: 'staging-demo-2', size: 'xsmall', diff: 'hard', owner: 0, result: 'loss', dur: 2210, end: 1200, log: DEMO_LOG_SOLO, stale: false },
  { id: 900203, matchId: 900006, userId: -1, username: DEMO_NAMES[0], mode: 'pvp', seed: 'staging-demo-6', size: 'small', diff: 'normal', owner: 0, result: 'win', dur: 1744, end: 1100, log: DEMO_LOG_PVP, stale: false },
  { id: 900204, matchId: 900003, userId: -3, username: DEMO_NAMES[2], mode: 'solo', seed: 'staging-demo-3', size: 'xsmall', diff: 'easy', owner: 0, result: 'win', dur: 1385, end: 1200, log: DEMO_LOG_SOLO, stale: true },
];

// History rows shaped exactly like the real `mine` projection, injected for a
// ?demo=1 previewer. Three playable, one on a stale engine.
function demoReplayRows() {
  const now = Date.now();
  return DEMO_REPLAYS.map((d, i) => ({
    result: d.result,
    difficulty: d.mode === 'pvp' ? 'pvp' : d.diff,
    duration_seconds: d.dur,
    map_seed: d.seed,
    created_at: new Date(now - (i + 1) * 3600_000).toISOString(),
    mode: d.mode,
    opponent: d.mode === 'pvp' ? DEMO_NAMES[1] : null,
    rating_delta: null,
    client_id: null,
    replay_id: d.id,
    replay_sim_version: d.stale ? 0 : SIM_VERSION,
  }));
}

// Shape-only validation. A bad replay is DROPPED, never fatal: recording the
// match result matters more than keeping its recording.
function cleanReplay(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
  if (!Array.isArray(r.log) || !r.log.length) return null;
  if (r.log.length > REPLAY_MAX_ENTRIES) return null;
  if (!MAP_SIZES.has(r.size_key) || !DIFFICULTIES.has(r.difficulty)) return null;
  const seed = typeof r.seed === 'string' ? r.seed.slice(0, 64) : null;
  if (!seed) return null;
  const version = parseInt(r.sim_version, 10);
  if (!Number.isInteger(version) || version < 0 || version > 32767) return null;
  const endTick = Math.max(0, Math.min(2000000, parseInt(r.end_tick, 10) || 0));
  let bytes;
  try { bytes = JSON.stringify(r.log).length; } catch { return null; }
  if (bytes > REPLAY_MAX_BYTES) return null;
  return {
    seed, size_key: r.size_key, difficulty: r.difficulty,
    mode: r.mode === 'pvp' ? 'pvp' : 'solo',
    viewer_owner: r.viewer_owner === 1 ? 1 : 0,
    sim_version: version, end_tick: endTick, log: r.log, bytes,
  };
}

// Insert one replay row and trim the owner back to the newest REPLAY_KEEP.
// Returns the new row's id. Runs inside the caller's transaction.
async function insertReplay(client, rep, meta) {
  const ins = await client.query(`
    INSERT INTO replays (user_id, username, mode, client_id, lobby_id, seed, size_key,
                         difficulty, viewer_owner, result, duration_seconds, end_tick,
                         sim_version, log, bytes)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
    ON CONFLICT (user_id, client_id) WHERE client_id IS NOT NULL DO NOTHING
    RETURNING id
  `, [meta.userId, meta.username, rep.mode, meta.clientId || null, meta.lobbyId || null,
    rep.seed, rep.size_key, rep.difficulty, rep.viewer_owner, meta.result,
    meta.duration, rep.end_tick, rep.sim_version, JSON.stringify(rep.log), rep.bytes]);
  if (!ins.rows.length) return null;
  await client.query(`
    DELETE FROM replays WHERE user_id = $1 AND id NOT IN (
      SELECT id FROM replays WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2
    )
  `, [meta.userId, REPLAY_KEEP]);
  return ins.rows[0].id;
}

// Record a finished match. Fire-and-forget from the client at match end.
// The rating update rides along in the same transaction: only the
// player's row moves — the AI commander is a fixed anchor, and a
// win/draw can only carry the player *up to* its rating, never past it.
//
// An optional `client_id` (#221) makes the whole call idempotent: a result
// played offline is queued on the device and re-sent on reconnect, and a
// response lost in transit must not double-record or double-rate the match.
// Absent — pre-#221 clients, PvP — the endpoint behaves exactly as before.
app.post('/api/match-result', async (req, res) => {
  const client = await pool.connect();
  try {
    const { result, difficulty, duration_seconds, map_seed, client_id, replay } = req.body || {};
    if (!RESULTS.has(result)) return res.status(400).json({ error: 'Bad result' });
    if (!DIFFICULTIES.has(difficulty) || difficulty === 'pvp') return res.status(400).json({ error: 'Bad difficulty' });
    const duration = Math.max(0, Math.min(86400, parseInt(duration_seconds, 10) || 0));
    const seed = typeof map_seed === 'string' ? map_seed.slice(0, 64) : null;
    const clientId = typeof client_id === 'string' && client_id.trim()
      ? client_id.trim().slice(0, 64) : null;

    await client.query('BEGIN');
    // Already recorded? Answer with the player's current rating so the client
    // can still render its line, and write nothing.
    if (clientId) {
      const dupe = await client.query(
        `SELECT rating_delta, rating_after FROM matches WHERE user_id = $1 AND client_id = $2`,
        [req.user.id, clientId]);
      if (dupe.rows.length) {
        await client.query('COMMIT');
        const row = dupe.rows[0];
        return res.json({
          ok: true,
          duplicate: true,
          rating: row.rating_after == null ? null : Math.round(Number(row.rating_after)),
          rating_delta: row.rating_delta == null ? null : Math.round(Number(row.rating_delta)),
          ai_rating: null,
        });
      }
    }
    const rated = ratings.soloRatable(req.user.id, result, duration);
    const out = rated
      ? await ratings.applySolo(client, {
        userId: req.user.id, username: req.user.username, difficulty, result,
      })
      : null;
    // The recording rides along with the result (#223), so an offline match
    // and its replay reach the server in the same idempotent call. A malformed
    // or oversized log is dropped — never a reason to lose the match itself.
    let replayId = null;
    const rep = cleanReplay(replay);
    if (rep) {
      try {
        replayId = await insertReplay(client, rep, {
          userId: req.user.id, username: req.user.username, clientId,
          result, duration,
        });
      } catch (e) {
        console.error('replay insert failed:', e.message);
        replayId = null;
      }
    }
    await client.query(`
      INSERT INTO matches (user_id, username, result, difficulty, duration_seconds, map_seed, rating_delta, rating_after, client_id, replay_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    `, [req.user.id, req.user.username, result, difficulty, duration, seed,
      out ? out.delta : null, out ? out.after : null, clientId, replayId]);
    await client.query('COMMIT');

    res.json({
      ok: true,
      rating: out ? Math.round(out.after) : null,
      rating_delta: out ? Math.round(out.delta) : null,
      ai_rating: out ? Math.round(out.aiRating) : null,
    });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// The three commander ratings. Public — they're committed constants
// from calibration/ai-ratings.json with no user data in them (same
// reasoning as the attract snapshot), and the difficulty picker should
// be able to say what you're up against even before the account data
// loads. Player ratings stay behind /api/ratings.
app.get('/api/ai-ratings', (_req, res) => {
  res.json({ ai: ratings.aiPublic() });
});

// Ratings panel on the menu: the three fixed AI anchors, the top rated
// players, and the caller's own row.
app.get('/api/ratings', async (req, res) => {
  try {
    res.json(await ratings.leaderboard(pool, req.user.id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Recent matches for the menu panel: the caller's last 10 plus recent
// wins platform-wide.
app.get('/api/matches', async (req, res) => {
  try {
    // replay_sim_version rides along (#223) so the list can render the
    // playable / "engine changed" state per row without fetching a single log.
    const mine = await pool.query(`
      SELECT m.result, m.difficulty, m.duration_seconds, m.map_seed, m.created_at,
             m.mode, m.opponent, m.rating_delta, m.client_id,
             m.replay_id, r.sim_version AS replay_sim_version
      FROM matches m LEFT JOIN replays r ON r.id = m.replay_id
      WHERE m.user_id = $1
      ORDER BY m.created_at DESC LIMIT 10
    `, [req.user.id]);
    const recent = await pool.query(`
      SELECT username, difficulty, duration_seconds, created_at, mode, opponent
      FROM matches WHERE result = 'win'
      ORDER BY created_at DESC LIMIT 10
    `);
    let mineRows = mine.rows;
    if (isDemoReq(req)) {
      // Request-time demo injection: the seeded replay rows belong to demo
      // users, and this endpoint only ever returns the caller's own matches, so
      // a preview would never see a ▶ Replay button. Same pattern as the
      // injected demo challenge in /api/lobbies. Never persisted.
      mineRows = mineRows.concat(demoReplayRows());
    }
    res.json({ mine: mineRows, recent: recent.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// One replay's metadata and order log. Strictly the caller's own — a replay is
// the sequence of moves someone made, and it is theirs to rewatch.
app.get('/api/replays/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad replay id' });
    const r = await pool.query(`
      SELECT id, user_id, mode, seed, size_key, difficulty, viewer_owner, result,
             duration_seconds, end_tick, sim_version, log, created_at
      FROM replays WHERE id = $1
    `, [id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Replay not found' });
    const row = r.rows[0];
    // The staging demo rows are owned by fake negative-id users, so a previewer
    // has to be allowed to open them — exactly like the demo challenge.
    const demoOk = isDemoReq(req) && DEMO_REPLAY_IDS.has(row.id);
    if (row.user_id !== req.user.id && !demoOk) {
      return res.status(403).json({ error: 'Not your replay' });
    }
    delete row.user_id;
    res.json({ replay: row });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ------------------------------------------------------------- solo saves (#176)
// One save slot per user (mirrors the client's single localStorage slot)
// so an in-progress solo match resumes on any device. The payload is the
// client's serialized sim state, validated only for shape/version — the
// sim itself re-validates everything at deserialize time.

const validSaveData = (d) => d && typeof d === 'object' && !Array.isArray(d)
  && d.v >= 2 && d.v <= 5 && !d.pvp && !d.result;

app.get('/api/save', async (req, res) => {
  try {
    const r = await pool.query(`SELECT data, saved_at FROM saves WHERE user_id = $1`, [req.user.id]);
    res.json({ save: r.rows.length ? { data: r.rows[0].data, saved_at: r.rows[0].saved_at } : null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/save', async (req, res) => {
  try {
    const data = req.body;
    if (!validSaveData(data)) return res.status(400).json({ error: 'Bad save data' });
    await pool.query(`
      INSERT INTO saves (user_id, username, data, saved_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (user_id) DO UPDATE SET username = EXCLUDED.username, data = EXCLUDED.data, saved_at = NOW()
    `, [req.user.id, req.user.username, data]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------- player state

// Per-player onboarding progress (#212): which controls page sets the player
// has read, and whether they've finished the guided tutorial. Kept in its own
// table rather than inside the save row because clearSaves() DELETEs that row
// on every finished match — these flags have to outlive it.
//
// Every flag is a MONOTONIC "has happened" bit, which is what makes syncing
// trivial: merging two devices is a logical OR, so there is no conflict to
// resolve and the API has no way to express un-setting one.
const STATE_KEYS = ['tutorial_done', 'controls_touch_seen', 'controls_desktop_seen'];

app.get('/api/player-state', async (req, res) => {
  try {
    const r = await pool.query(`SELECT state FROM player_state WHERE user_id = $1`, [req.user.id]);
    res.json({ state: r.rows.length ? r.rows[0].state : {} });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/player-state', async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    // whitelist + monotonic: only known keys, and only ever set to true
    const patch = {};
    for (const k of STATE_KEYS) if (body[k] === true) patch[k] = true;
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'No known flags to set' });
    const r = await pool.query(`
      INSERT INTO player_state (user_id, username, state, updated_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (user_id) DO UPDATE
        SET state = player_state.state || EXCLUDED.state,
            username = EXCLUDED.username,
            updated_at = NOW()
      RETURNING state
    `, [req.user.id, req.user.username, patch]);
    res.json({ state: r.rows[0].state });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/save', async (req, res) => {
  try {
    await pool.query(`DELETE FROM saves WHERE user_id = $1`, [req.user.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------- multiplayer

// Challenge-field autocomplete: usernames of people who've played here.
app.get('/api/players', async (req, res) => {
  try {
    const raw = String(req.query.q || '').slice(0, 64);
    const q = raw.replace(/[\\%_]/g, (m) => '\\' + m);
    const r = await pool.query(`
      SELECT DISTINCT username FROM matches
      WHERE user_id > 0 AND username ILIKE $1 AND LOWER(username) <> LOWER($2)
      ORDER BY username LIMIT 8
    `, [q + '%', req.user.username]);
    let names = r.rows.map((x) => x.username);
    if (isDemoReq(req)) {
      const extra = DEMO_NAMES.filter((n) => n.toLowerCase().startsWith(raw.toLowerCase()) && !names.includes(n));
      names = names.concat(extra).slice(0, 8);
    }
    res.json({ players: names });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function lobbyPublic(row) {
  return {
    id: row.id,
    host_username: row.host_username,
    size_key: row.size_key,
    created_at: row.created_at,
    challenge_username: row.challenge_username,
  };
}

function mineShape(row, userId) {
  const role = row.host_user_id === userId ? 'host' : 'guest';
  return {
    id: row.id,
    status: row.status,
    role,
    size_key: row.size_key,
    seed: row.seed,
    challenge_username: row.challenge_username,
    opponent: role === 'host' ? row.guest_username : row.host_username,
  };
}

// The menu's lobby poll: open public lobbies, challenges aimed at me,
// and my own open/active/declined lobby (waiting state + rejoin).
app.get('/api/lobbies', async (req, res) => {
  try {
    const uid = req.user.id, uname = req.user.username;
    const open = await pool.query(`
      SELECT * FROM lobbies
      WHERE status = 'open' AND challenge_username IS NULL AND host_user_id <> $1
        AND (host_seen_at > NOW() - INTERVAL '30 seconds' OR host_user_id < 0)
      ORDER BY created_at DESC LIMIT 20
    `, [uid]);
    const challenges = await pool.query(`
      SELECT * FROM lobbies
      WHERE status = 'open' AND LOWER(challenge_username) = LOWER($1)
        AND host_seen_at > NOW() - INTERVAL '30 seconds'
      ORDER BY created_at DESC LIMIT 10
    `, [uname]);
    const mine = await pool.query(`
      SELECT * FROM lobbies
      WHERE (host_user_id = $1 OR guest_user_id = $1) AND status IN ('open', 'active', 'declined')
      ORDER BY id DESC LIMIT 1
    `, [uid]);
    const challengeRows = challenges.rows.map(lobbyPublic);
    if (isDemoReq(req)) {
      // Request-time demo injection: a synthetic incoming challenge aimed
      // at whoever is previewing. Never persisted; accept/decline on it
      // answers with a friendly demo message.
      challengeRows.push({
        id: DEMO_CHALLENGE_ID,
        host_username: 'Staging demo Warden',
        size_key: 'medium',
        created_at: new Date().toISOString(),
        challenge_username: uname,
      });
    }
    res.json({
      open: open.rows.map(lobbyPublic),
      challenges: challengeRows,
      mine: mine.rows.length ? mineShape(mine.rows[0], uid) : null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create a public lobby or (with challengeUsername) a private challenge.
app.post('/api/lobbies', async (req, res) => {
  try {
    const uid = req.user.id, uname = req.user.username;
    const sizeKey = MAP_SIZES.has(req.body && req.body.sizeKey) ? req.body.sizeKey : 'medium';
    let challenge = req.body && typeof req.body.challengeUsername === 'string'
      ? req.body.challengeUsername.trim().slice(0, 255) : '';
    if (challenge && challenge.toLowerCase() === String(uname).toLowerCase()) {
      return res.status(400).json({ error: "You can't challenge yourself" });
    }
    const active = await pool.query(`
      SELECT 1 FROM lobbies WHERE (host_user_id = $1 OR guest_user_id = $1) AND status = 'active' LIMIT 1
    `, [uid]);
    if (active.rows.length) return res.status(400).json({ error: 'You already have a match in progress — rejoin it first' });
    // one waiting lobby per user: creating a new one replaces the old
    await pool.query(`UPDATE lobbies SET status = 'cancelled' WHERE host_user_id = $1 AND status IN ('open', 'declined')`, [uid]);
    const seed = Math.random().toString(36).slice(2, 10);
    const r = await pool.query(`
      INSERT INTO lobbies (host_user_id, host_username, status, challenge_username, size_key, seed, host_seen_at)
      VALUES ($1, $2, 'open', $3, $4, $5, NOW())
      RETURNING *
    `, [uid, uname, challenge || null, sizeKey, seed]);
    res.json({ lobby: mineShape(r.rows[0], uid) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Join an open lobby / accept a challenge.
app.post('/api/lobbies/:id/join', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const uid = req.user.id, uname = req.user.username;
    if (IS_STAGING && id === DEMO_CHALLENGE_ID) {
      return res.status(400).json({ error: "That's a staging demo challenge — it can't be accepted" });
    }
    const active = await pool.query(`
      SELECT 1 FROM lobbies WHERE (host_user_id = $1 OR guest_user_id = $1) AND status = 'active' LIMIT 1
    `, [uid]);
    if (active.rows.length) return res.status(400).json({ error: 'You already have a match in progress — rejoin it first' });
    if (!matchRunner.hasCapacity()) {
      return res.status(400).json({ error: 'The server is at match capacity — try again in a few minutes' });
    }
    const r = await pool.query(`
      UPDATE lobbies SET guest_user_id = $2, guest_username = $3, status = 'active', guest_seen_at = NOW()
      WHERE id = $1 AND status = 'open' AND guest_user_id IS NULL AND host_user_id <> $2 AND host_user_id > 0
        AND (challenge_username IS NULL OR LOWER(challenge_username) = LOWER($3))
      RETURNING *
    `, [id, uid, uname]);
    if (r.rows.length) {
      // the match is server-authoritative: spin up its simulation now
      await matchRunner.start(r.rows[0]);
      return res.json({ lobby: mineShape(r.rows[0], uid) });
    }
    const row = (await pool.query(`SELECT * FROM lobbies WHERE id = $1`, [id])).rows[0];
    if (!row) return res.status(404).json({ error: 'Lobby not found' });
    if (row.host_user_id < 0) return res.status(400).json({ error: "That's a staging demo lobby — it can't be joined" });
    if (row.host_user_id === uid) return res.status(400).json({ error: "You can't join your own lobby" });
    if (row.challenge_username && row.challenge_username.toLowerCase() !== String(uname).toLowerCase()) {
      return res.status(400).json({ error: 'That challenge is for someone else' });
    }
    return res.status(400).json({ error: 'Lobby is no longer available' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Decline a challenge aimed at me. The challenger's poll sees 'declined',
// shows the notice, then acknowledges via cancel.
app.post('/api/lobbies/:id/decline', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (IS_STAGING && id === DEMO_CHALLENGE_ID) return res.json({ ok: true, demo: true });
    const r = await pool.query(`
      UPDATE lobbies SET status = 'declined'
      WHERE id = $1 AND status = 'open' AND LOWER(challenge_username) = LOWER($2)
      RETURNING id
    `, [id, req.user.username]);
    if (!r.rows.length) return res.status(400).json({ error: 'Challenge is no longer open' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Host cancels a waiting lobby (or acknowledges a decline).
app.post('/api/lobbies/:id/cancel', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    await pool.query(`
      UPDATE lobbies SET status = 'cancelled'
      WHERE id = $1 AND host_user_id = $2 AND status IN ('open', 'declined')
    `, [id, req.user.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Current lobby state for rejoin: role, opponent and the freshest
// snapshot — from the live runner when there is one, else the last
// durability flush in the lobby row.
app.get('/api/lobbies/:id/state', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const row = (await pool.query(`SELECT * FROM lobbies WHERE id = $1`, [id])).rows[0];
    if (!row) return res.status(404).json({ error: 'Lobby not found' });
    const uid = req.user.id;
    if (row.host_user_id !== uid && row.guest_user_id !== uid) return res.status(403).json({ error: 'Not your lobby' });
    const m = mineShape(row, uid);
    const live = matchRunner.peek(id);
    res.json({
      ...m,
      snapshot: live ? live.snapshot : (row.snapshot || null),
      snapshot_tick: live ? live.snapshot_tick : (row.snapshot_tick || 0),
      winner_owner: row.winner_owner,
      end_reason: row.end_reason,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// The single polling endpoint, symmetric for both players: register
// presence, hand the runner this player's commands, download the
// authoritative snapshot when behind. While the lobby is still 'open'
// it doubles as the host's waiting-room heartbeat.
app.post('/api/lobbies/:id/sync', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const row = (await pool.query(`SELECT * FROM lobbies WHERE id = $1`, [id])).rows[0];
    if (!row) return res.status(404).json({ error: 'Lobby not found' });
    const uid = req.user.id;
    const isHost = row.host_user_id === uid;
    if (!isHost && row.guest_user_id !== uid) return res.status(403).json({ error: 'Not your lobby' });

    if (row.status === 'open' || row.status === 'declined') {
      if (isHost) await pool.query(`UPDATE lobbies SET host_seen_at = NOW() WHERE id = $1`, [id]);
      return res.json({ status: row.status, guest_username: row.guest_username, command_ids: [] });
    }

    const out = await matchRunner.sync(row, isHost ? 0 : 1, req.body || {});
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

// HTML shell: serve the app if authenticated. Unauthenticated top-level
// visits (share links pasted into a browser — Sec-Fetch-Dest: document)
// are sent to the platform's chromeless view of this app, where the shell
// embeds it with a real token so the link just works. Every other
// tokenless case (iframe loads with an expired token, old browsers
// without Sec-Fetch-*) gets the "open in Usernode" landing page instead
// of a redirect, so the platform shell is never loaded INSIDE its own
// app iframe and stray visits still don't reveal the app.
app.get('*', (req, res) => {
  if (!req.user) {
    if (req.get('sec-fetch-dest') === 'document') {
      return res.redirect(302, 'https://social-vibecoding.usernodelabs.org/#app/supply-line-rts-6408b2/full');
    }
    return res.status(401).send(`<!doctype html><meta charset=utf-8><title>Open in Usernode</title>
<body style="font-family:system-ui;background:#09090b;color:#e4e4e7;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
  <div style="max-width:24rem;padding:2rem;text-align:center">
    <h1 style="font-size:1.25rem;margin:0 0 0.5rem">Open this app inside Usernode</h1>
    <p style="color:#a1a1aa;font-size:0.9rem;margin:0 0 1.25rem">This page is served via the platform; direct visits aren't authenticated.</p>
    <a href="https://social-vibecoding.usernodelabs.org/#app/supply-line-rts-6408b2/full" style="display:inline-block;padding:0.5rem 1rem;background:#7c3aed;color:white;border-radius:0.5rem;text-decoration:none;font-size:0.9rem">Open in Usernode</a>
  </div>
</body>`);
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function start() {
  // The replay engine version the browser will enforce (#223). Read once from
  // the same module the client runs, so a seed can never claim a version the
  // client would reject by accident.
  try {
    const S = await import('./public/js/sim.js');
    if (Number.isInteger(S.SIM_VERSION)) SIM_VERSION = S.SIM_VERSION;
  } catch (err) {
    console.error('could not read SIM_VERSION from sim.js:', err.message);
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS matches (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      result VARCHAR(16) NOT NULL,
      difficulty VARCHAR(16) NOT NULL,
      duration_seconds INTEGER NOT NULL,
      map_seed VARCHAR(64),
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE matches ADD COLUMN IF NOT EXISTS mode VARCHAR(16) NOT NULL DEFAULT 'solo'`);
  await pool.query(`ALTER TABLE matches ADD COLUMN IF NOT EXISTS opponent VARCHAR(255)`);
  // Offline solo play (#221): the client's own id for a finished match, so a
  // result queued offline and re-sent on reconnect can't be recorded — or
  // rated — twice. Nullable: PvP rows and pre-#221 clients never carry one.
  await pool.query(`ALTER TABLE matches ADD COLUMN IF NOT EXISTS client_id VARCHAR(64)`);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS matches_client_id_idx
    ON matches (user_id, client_id) WHERE client_id IS NOT NULL
  `);
  // Replays (#223): the history row's link to its recording. Nullable — every
  // match played before this shipped has none, and one that overran the log
  // caps is recorded without one.
  await pool.query(`ALTER TABLE matches ADD COLUMN IF NOT EXISTS replay_id INTEGER`);

  // Match replays (#223): one row per participant (mirroring how `matches`
  // already duplicates a PvP match), holding the order log the client re-runs
  // through its own sim. Deliberately PUBLIC (no staging:private comment): a row
  // is a user id, a public username and the moves someone made in a game whose
  // result is ALREADY published in `matches` and on the recent-wins list — the
  // same sensitivity class as `matches`, `saves` and `player_state`.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS replays (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      mode VARCHAR(16) NOT NULL DEFAULT 'solo',
      client_id VARCHAR(64),
      lobby_id INTEGER,
      seed VARCHAR(64) NOT NULL,
      size_key VARCHAR(16) NOT NULL,
      difficulty VARCHAR(16) NOT NULL,
      viewer_owner SMALLINT NOT NULL DEFAULT 0,
      result VARCHAR(16) NOT NULL,
      duration_seconds INTEGER NOT NULL DEFAULT 0,
      end_tick INTEGER NOT NULL DEFAULT 0,
      sim_version SMALLINT NOT NULL,
      log JSONB NOT NULL,
      bytes INTEGER,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS replays_user_idx ON replays (user_id, created_at DESC)`);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS replays_client_id_idx
    ON replays (user_id, client_id) WHERE client_id IS NOT NULL
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS lobbies (
      id SERIAL PRIMARY KEY,
      host_user_id INTEGER NOT NULL,
      host_username VARCHAR(255) NOT NULL,
      guest_user_id INTEGER,
      guest_username VARCHAR(255),
      status VARCHAR(16) NOT NULL DEFAULT 'open',
      challenge_username VARCHAR(255),
      size_key VARCHAR(16) NOT NULL DEFAULT 'medium',
      seed VARCHAR(64) NOT NULL,
      winner_owner SMALLINT,
      end_reason VARCHAR(16),
      snapshot JSONB,
      snapshot_tick INTEGER DEFAULT 0,
      host_seen_at TIMESTAMPTZ DEFAULT NOW(),
      guest_seen_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS lobby_commands (
      id SERIAL PRIMARY KEY,
      lobby_id INTEGER NOT NULL,
      payload JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS lobby_commands_lobby_idx ON lobby_commands (lobby_id, id)`);

  // Cross-device solo resume (#176): one save slot per user.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS saves (
      user_id INTEGER PRIMARY KEY,
      username VARCHAR(255) NOT NULL,
      data JSONB NOT NULL,
      saved_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Cross-device onboarding progress (#212): the controls-seen marks and the
  // tutorial-done mark, so they follow the player between devices instead of
  // living in one browser. Deliberately PUBLIC (no staging:private comment):
  // a row is a user id, a public username and a few onboarding booleans —
  // the same sensitivity class as `matches` and `saves`.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS player_state (
      user_id INTEGER PRIMARY KEY,
      username VARCHAR(255) NOT NULL,
      state JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Elo (#207 follow-up): the ratings table, the three fixed AI anchors
  // seeded from the committed calibration artifact, then a one-time
  // replay of pre-Elo match history to seed player ratings.
  await ratings.migrate(pool);
  await ratings.seedAi(pool);
  const filled = await ratings.backfill(pool);
  if (!filled.skipped) {
    console.log(`ratings backfill: ${filled.players} player(s) from ${filled.rated} rated match row(s)`);
  }

  // Staging-only demo rows so the menu's match-history panel and the
  // multiplayer lobby list have content in previews. Obviously-fake
  // identities, idempotent, strictly a no-op in production.
  if (IS_STAGING) {
    await pool.query(`
      INSERT INTO matches (id, user_id, username, result, difficulty, duration_seconds, map_seed)
      VALUES
        (900001, -1, 'Staging demo Quartermaster', 'win',       'normal', 1622, 'staging-demo-1'),
        (900002, -2, 'Staging demo Forager',       'loss',      'hard',   2210, 'staging-demo-2'),
        (900003, -3, 'Staging demo Warden',        'win',       'easy',   1385, 'staging-demo-3'),
        (900004, -1, 'Staging demo Quartermaster', 'surrender', 'normal', 940,  'staging-demo-4'),
        (900005, -2, 'Staging demo Forager',       'win',       'normal', 1990, 'staging-demo-5'),
        (900008, -1, 'Staging demo Quartermaster', 'loss',      'veryhard', 2480, 'staging-demo-8'),
        (900009, -3, 'Staging demo Warden',        'win',       'veryhard', 3310, 'staging-demo-9')
      ON CONFLICT (id) DO NOTHING
    `);
    await pool.query(`
      INSERT INTO matches (id, user_id, username, result, difficulty, duration_seconds, map_seed, mode, opponent)
      VALUES
        (900006, -1, 'Staging demo Quartermaster', 'win',  'pvp', 1744, 'staging-demo-6', 'pvp', 'Staging demo Forager'),
        (900007, -2, 'Staging demo Forager',       'loss', 'pvp', 1744, 'staging-demo-6', 'pvp', 'Staging demo Quartermaster')
      ON CONFLICT (id) DO NOTHING
    `);
    // Open demo lobbies (never joinable — negative host ids are rejected
    // by the join endpoint). host_seen_at refreshed on every boot; they
    // also bypass the 30 s freshness filter via host_user_id < 0.
    await pool.query(`
      INSERT INTO lobbies (id, host_user_id, host_username, status, size_key, seed, host_seen_at)
      VALUES
        (900101, -1, 'Staging demo Quartermaster', 'open', 'small',  'staging-demo-a', NOW()),
        (900102, -2, 'Staging demo Forager',       'open', 'medium', 'staging-demo-b', NOW())
      ON CONFLICT (id) DO UPDATE SET status = 'open', host_seen_at = NOW()
    `);
    // Demo players for the Ratings panel: one above every commander
    // (only reachable via PvP — solo caps at Very Hard), one between the
    // tiers, one below Normal. The AI rows come from the calibration
    // artifact in every env.
    await pool.query(`
      INSERT INTO ratings (participant, username, rating, rated_matches, calib_matches, calib_version)
      VALUES
        ('user:-1', 'Staging demo Quartermaster', 1285, 24, 0, 0),
        ('user:-2', 'Staging demo Forager',        968, 11, 0, 0),
        ('user:-3', 'Staging demo Warden',        1012,  7, 0, 0),
        ('user:-4', 'Staging demo Marshal',       1340, 31, 0, 0)
      ON CONFLICT (participant) DO NOTHING
    `);
    // Replay rows (#223) for the seeded matches, so the ▶ Replay buttons and
    // the viewer are reviewable in a preview. 900204 carries sim_version 0 on
    // purpose — see DEMO_REPLAYS — so the "engine changed" state shows too.
    for (const d of DEMO_REPLAYS) {
      await pool.query(`
        INSERT INTO replays (id, user_id, username, mode, seed, size_key, difficulty,
                             viewer_owner, result, duration_seconds, end_tick, sim_version, log, bytes)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        ON CONFLICT (id) DO UPDATE SET sim_version = EXCLUDED.sim_version, log = EXCLUDED.log
      `, [d.id, d.userId, d.username, d.mode, d.seed, d.size, d.diff, d.owner,
        d.result, d.dur, d.end, d.stale ? 0 : SIM_VERSION,
        JSON.stringify(d.log), JSON.stringify(d.log).length]);
      await pool.query(`UPDATE matches SET replay_id = $2 WHERE id = $1`, [d.matchId, d.id]);
    }
    // Give the seeded history rows plausible deltas so the "Yours" list
    // shows the +/- column in previews (ids from the block above).
    await pool.query(`
      UPDATE matches SET rating_delta = v.d, rating_after = v.a
      FROM (VALUES (900001, 12.0, 1012.0), (900002, -9.0, 991.0), (900003, 0.0, 1012.0),
                   (900004, -14.0, 998.0), (900005, 11.0, 1009.0), (900008, -16.0, 993.0)) AS v(id, d, a)
      WHERE matches.id = v.id AND matches.rating_delta IS NULL
    `);
  }

  matchRunner.init(pool); // server-authoritative PvP simulations
  server = app.listen(port, () => console.log(`Listening on :${port}`));
  attractPool.warmUp(); // fill the attract-snapshot pool in the background
}

// Graceful shutdown. Every deploy replaces this container by sending SIGTERM
// and waiting a few seconds before SIGKILL, so stop accepting connections,
// let in-flight requests land under a hard deadline, close the pool, exit.
const DRAIN_MS = 3000;
async function shutdown(signal) {
  if (shuttingDown) return;   // a repeat signal during the drain is a no-op
  shuttingDown = true;
  console.log(`[shutdown] ${signal} received, draining`);
  if (server) {
    server.close(() => { });
    server.closeIdleConnections?.();
    const t = setTimeout(() => server.closeAllConnections?.(), DRAIN_MS);
    t.unref?.();
  }
  try {
    await pool.end();
  } catch (e) {
    console.error('[shutdown] pool.end failed', e.message);
  }
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start().catch(err => { console.error(err); process.exit(1); });
