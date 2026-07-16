const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;
const IS_STAGING = process.env.USERNODE_ENV === 'staging';

// Paths that stay open without authentication. Add a path here (and add it
// with `app.get`/`app.post` below) if you deliberately want it public.
// Everything else requires a valid platform-issued JWT.
const PUBLIC_API_PATHS = new Set(['/health']);

app.use(express.json());

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

const RESULTS = new Set(['win', 'loss', 'surrender']);
const DIFFICULTIES = new Set(['easy', 'normal', 'hard']);

// Record a finished match. Fire-and-forget from the client at match end.
app.post('/api/match-result', async (req, res) => {
  try {
    const { result, difficulty, duration_seconds, map_seed } = req.body || {};
    if (!RESULTS.has(result)) return res.status(400).json({ error: 'Bad result' });
    if (!DIFFICULTIES.has(difficulty)) return res.status(400).json({ error: 'Bad difficulty' });
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
      SELECT result, difficulty, duration_seconds, map_seed, created_at
      FROM matches WHERE user_id = $1
      ORDER BY created_at DESC LIMIT 10
    `, [req.user.id]);
    const recent = await pool.query(`
      SELECT username, difficulty, duration_seconds, created_at
      FROM matches WHERE result = 'win'
      ORDER BY created_at DESC LIMIT 10
    `);
    res.json({ mine: mine.rows, recent: recent.rows });
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

  // Staging-only demo rows so the menu's match-history panel has content
  // in previews (the `matches` table is new, so staging starts empty).
  // Obviously-fake identities, idempotent, strictly a no-op in production.
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
  }

  app.listen(port, () => console.log(`Listening on :${port}`));
}

start().catch(err => { console.error(err); process.exit(1); });
