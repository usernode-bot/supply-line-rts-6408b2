const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const attractPool = require('./attract-pool');

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;
const IS_STAGING = process.env.USERNODE_ENV === 'staging';

// Paths that stay open without authentication. Add a path here (and add it
// with `app.get`/`app.post` below) if you deliberately want it public.
// Everything else requires a valid platform-issued JWT.
const PUBLIC_API_PATHS = new Set(['/health', '/api/attract-snapshot']);

// PvP snapshots are full serialized game states (~40-80 KB on a medium
// map), well past express.json's 100 kb default.
app.use(express.json({ limit: '2mb' }));

// Verify platform-issued JWT if one was passed, then enforce auth on
// anything not explicitly marked public. The iframe adds `?token=…`
// on load; the frontend script forwards the token via `x-usernode-token`
// on subsequent fetches.
app.use((req, res, next) => {
  const token = req.query.token || req.headers['x-usernode-token'];
  if (token && JWT_SECRET) {
    try { req.user = jwt.verify(token, JWT_SECRET); } catch {}
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

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

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
const DIFFICULTIES = new Set(['easy', 'normal', 'hard', 'pvp']);
const MAP_SIZES = new Set(['xsmall', 'small', 'medium', 'large']);
const END_REASONS = new Set(['elimination', 'surrender', 'abandoned']);

// Staging demo rows use negative user ids / ids in the 9001xx range so
// they can never collide with (or be mistaken for) real rows.
const DEMO_CHALLENGE_ID = 900103;
const DEMO_NAMES = ['Staging demo Quartermaster', 'Staging demo Forager', 'Staging demo Warden'];
const isDemoReq = (req) => IS_STAGING && req.query.demo === '1';

// Record a finished match. Fire-and-forget from the client at match end.
app.post('/api/match-result', async (req, res) => {
  try {
    const { result, difficulty, duration_seconds, map_seed } = req.body || {};
    if (!RESULTS.has(result)) return res.status(400).json({ error: 'Bad result' });
    if (!DIFFICULTIES.has(difficulty) || difficulty === 'pvp') return res.status(400).json({ error: 'Bad difficulty' });
    const duration = Math.max(0, Math.min(86400, parseInt(duration_seconds, 10) || 0));
    const seed = typeof map_seed === 'string' ? map_seed.slice(0, 64) : null;
    await pool.query(`
      INSERT INTO matches (user_id, username, result, difficulty, duration_seconds, map_seed)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [req.user.id, req.user.username, result, difficulty, duration, seed]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Recent matches for the menu panel: the caller's last 10 plus recent
// wins platform-wide.
app.get('/api/matches', async (req, res) => {
  try {
    const mine = await pool.query(`
      SELECT result, difficulty, duration_seconds, map_seed, created_at, mode, opponent
      FROM matches WHERE user_id = $1
      ORDER BY created_at DESC LIMIT 10
    `, [req.user.id]);
    const recent = await pool.query(`
      SELECT username, difficulty, duration_seconds, created_at, mode, opponent
      FROM matches WHERE result = 'win'
      ORDER BY created_at DESC LIMIT 10
    `);
    res.json({ mine: mine.rows, recent: recent.rows });
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
    const r = await pool.query(`
      UPDATE lobbies SET guest_user_id = $2, guest_username = $3, status = 'active', guest_seen_at = NOW()
      WHERE id = $1 AND status = 'open' AND guest_user_id IS NULL AND host_user_id <> $2 AND host_user_id > 0
        AND (challenge_username IS NULL OR LOWER(challenge_username) = LOWER($3))
      RETURNING *
    `, [id, uid, uname]);
    if (r.rows.length) return res.json({ lobby: mineShape(r.rows[0], uid) });
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

// Current lobby state for rejoin: role, opponent and the latest snapshot.
app.get('/api/lobbies/:id/state', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const row = (await pool.query(`SELECT * FROM lobbies WHERE id = $1`, [id])).rows[0];
    if (!row) return res.status(404).json({ error: 'Lobby not found' });
    const uid = req.user.id;
    if (row.host_user_id !== uid && row.guest_user_id !== uid) return res.status(403).json({ error: 'Not your lobby' });
    const m = mineShape(row, uid);
    const lastCmd = await pool.query(`SELECT COALESCE(MAX(id), 0) AS max FROM lobby_commands WHERE lobby_id = $1`, [id]);
    res.json({
      ...m,
      snapshot: row.snapshot || null,
      snapshot_tick: row.snapshot_tick || 0,
      last_command_id: +lastCmd.rows[0].max,
      winner_owner: row.winner_owner,
      end_reason: row.end_reason,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// The single polling endpoint. The host uploads snapshots and drains
// guest commands; the guest uploads commands and downloads snapshots.
// Both calls double as presence heartbeats.
app.post('/api/lobbies/:id/sync', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const row = (await pool.query(`SELECT * FROM lobbies WHERE id = $1`, [id])).rows[0];
    if (!row) return res.status(404).json({ error: 'Lobby not found' });
    const uid = req.user.id;
    const isHost = row.host_user_id === uid;
    if (!isHost && row.guest_user_id !== uid) return res.status(403).json({ error: 'Not your lobby' });
    const body = req.body || {};
    const now = Date.now();

    if (isHost) {
      if (body.snapshot && typeof body.snapshot === 'object' && row.status === 'active') {
        await pool.query(`
          UPDATE lobbies SET host_seen_at = NOW(), snapshot = $2, snapshot_tick = $3 WHERE id = $1
        `, [id, JSON.stringify(body.snapshot), Math.max(0, parseInt(body.tick, 10) || 0)]);
      } else {
        await pool.query(`UPDATE lobbies SET host_seen_at = NOW() WHERE id = $1`, [id]);
      }
      const after = Math.max(0, parseInt(body.commandsAfter, 10) || 0);
      const cmds = await pool.query(`
        SELECT id, payload FROM lobby_commands WHERE lobby_id = $1 AND id > $2 ORDER BY id LIMIT 200
      `, [id, after]);
      return res.json({
        status: row.status,
        guest_username: row.guest_username,
        commands: cmds.rows,
        opponentSeenAgoMs: row.guest_seen_at ? now - new Date(row.guest_seen_at).getTime() : null,
        winner_owner: row.winner_owner,
        end_reason: row.end_reason,
      });
    }

    // guest
    await pool.query(`UPDATE lobbies SET guest_seen_at = NOW() WHERE id = $1`, [id]);
    const commands = Array.isArray(body.commands) ? body.commands.slice(0, 50) : [];
    let commandIds = [];
    if (commands.length && row.status === 'active') {
      const values = [];
      const params = [id];
      for (const c of commands) {
        params.push(JSON.stringify(c));
        values.push(`($1, $${params.length})`);
      }
      // ids come back in insertion order, matching the batch order — the
      // guest uses them to retire optimistically-applied pending commands
      // once a host snapshot acks them
      const ins = await pool.query(`INSERT INTO lobby_commands (lobby_id, payload) VALUES ${values.join(', ')} RETURNING id`, params);
      commandIds = ins.rows.map((r) => r.id);
    }
    const haveTick = parseInt(body.haveTick, 10);
    const wantSnap = row.snapshot && (isNaN(haveTick) || haveTick < (row.snapshot_tick || 0));
    return res.json({
      status: row.status,
      snapshot_tick: row.snapshot_tick || 0,
      snapshot: wantSnap ? row.snapshot : undefined,
      command_ids: commandIds,
      opponentSeenAgoMs: row.host_seen_at ? now - new Date(row.host_seen_at).getTime() : null,
      winner_owner: row.winner_owner,
      end_reason: row.end_reason,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Report the outcome. Host reports elimination/surrender; either player
// may claim an abandoned win once the opponent has been gone >60 s.
app.post('/api/lobbies/:id/result', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { winnerOwner, reason } = req.body || {};
    const winner = winnerOwner === 0 || winnerOwner === 1 ? winnerOwner : null;
    if (winner == null || !END_REASONS.has(reason)) return res.status(400).json({ error: 'Bad result' });
    const row = (await pool.query(`SELECT * FROM lobbies WHERE id = $1`, [id])).rows[0];
    if (!row) return res.status(404).json({ error: 'Lobby not found' });
    const uid = req.user.id;
    const isHost = row.host_user_id === uid;
    if (!isHost && row.guest_user_id !== uid) return res.status(403).json({ error: 'Not your lobby' });
    if (row.status !== 'active') {
      return res.json({ ok: false, status: row.status, winner_owner: row.winner_owner, end_reason: row.end_reason });
    }
    if (reason === 'abandoned') {
      // claimant must be the winner, and the opponent genuinely gone
      const myOwner = isHost ? 0 : 1;
      if (winner !== myOwner) return res.status(400).json({ error: 'Bad claim' });
      const oppSeen = isHost ? row.guest_seen_at : row.host_seen_at;
      const ageMs = oppSeen ? Date.now() - new Date(oppSeen).getTime() : Infinity;
      if (ageMs < 60000) return res.status(400).json({ error: 'Opponent is still connected' });
    } else if (!isHost) {
      return res.status(403).json({ error: 'Only the host reports this result' });
    }
    const upd = await pool.query(`
      UPDATE lobbies SET status = 'finished', winner_owner = $2, end_reason = $3
      WHERE id = $1 AND status = 'active' RETURNING *
    `, [id, winner, reason]);
    if (!upd.rows.length) {
      const cur = (await pool.query(`SELECT status, winner_owner, end_reason FROM lobbies WHERE id = $1`, [id])).rows[0];
      return res.json({ ok: false, ...cur });
    }
    const l = upd.rows[0];
    const duration = Math.max(0, Math.min(86400, Math.round((l.snapshot_tick || 0) / 10)));
    const rowResult = (owner) => owner === winner ? 'win' : (reason === 'surrender' ? 'surrender' : 'loss');
    if (l.guest_user_id != null) {
      await pool.query(`
        INSERT INTO matches (user_id, username, result, difficulty, duration_seconds, map_seed, mode, opponent)
        VALUES ($1, $2, $3, 'pvp', $4, $5, 'pvp', $6),
               ($7, $8, $9, 'pvp', $4, $5, 'pvp', $10)
      `, [
        l.host_user_id, l.host_username, rowResult(0), duration, l.seed, l.guest_username,
        l.guest_user_id, l.guest_username, rowResult(1), l.host_username,
      ]);
    }
    res.json({ ok: true, winner_owner: winner, end_reason: reason });
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
        (900005, -2, 'Staging demo Forager',       'win',       'normal', 1990, 'staging-demo-5')
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
  }

  app.listen(port, () => console.log(`Listening on :${port}`));
  attractPool.warmUp(); // fill the attract-snapshot pool in the background
}

start().catch(err => { console.error(err); process.exit(1); });
