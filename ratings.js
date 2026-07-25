// Rating storage: the `ratings` table, the boot seeding of the three AI
// anchors from calibration/ai-ratings.json, the one-time backfill of
// pre-Elo match history, and the two runtime update paths (solo from the
// match-result endpoint, PvP from the match runner).
//
// The AI rows are write-once-per-boot: the committed artifact is the only
// thing that ever sets them, so the DB and the repo can't diverge. Every
// runtime path treats them as read-only anchors (see elo.js).

const elo = require('./elo');
const artifact = require('./calibration/ai-ratings.json');

const AI_LABELS = {
  'ai:easy': 'Easy commander',
  'ai:normal': 'Normal commander',
  'ai:hard': 'Hard commander',
  'ai:veryhard': 'Very Hard commander',
};

const participantForUser = (userId) => `user:${userId}`;
const participantForDifficulty = (difficulty) => `ai:${difficulty}`;

// The anchors as the artifact defines them: Normal is pinned at 1000 by
// construction, every other persona comes from the measured fit. Note the
// personas are NOT all measured against Normal — Very Hard is fitted
// against Hard and chained onto its rating (see test/calibrate-ai.mjs);
// the artifact records each persona's `opponent` / `opponent_rating`.
// Either way the ratings land on one scale, which is all this file needs.
function aiSeeds() {
  const rows = [{
    participant: artifact.anchor.participant,
    rating: artifact.anchor.rating,
    calib_matches: 0,
  }];
  for (const p of artifact.personas) {
    rows.push({ participant: p.participant, rating: p.rating, calib_matches: p.matches });
  }
  return rows.map((r) => ({
    ...r,
    username: AI_LABELS[r.participant] || r.participant,
    calib_version: artifact.version,
  }));
}

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ratings (
      participant VARCHAR(64) PRIMARY KEY,
      username VARCHAR(255) NOT NULL,
      rating DOUBLE PRECISION NOT NULL,
      rated_matches INTEGER NOT NULL DEFAULT 0,
      calib_matches INTEGER NOT NULL DEFAULT 0,
      calib_version INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE matches ADD COLUMN IF NOT EXISTS rating_delta DOUBLE PRECISION`);
  await pool.query(`ALTER TABLE matches ADD COLUMN IF NOT EXISTS rating_after DOUBLE PRECISION`);
}

// Unconditional upsert: nothing at runtime writes an AI row, so the
// artifact always wins and a re-calibration ships by deploying the file.
async function seedAi(pool) {
  for (const s of aiSeeds()) {
    await pool.query(`
      INSERT INTO ratings (participant, username, rating, rated_matches, calib_matches, calib_version)
      VALUES ($1, $2, $3, 0, $4, $5)
      ON CONFLICT (participant) DO UPDATE SET
        username = EXCLUDED.username,
        rating = EXCLUDED.rating,
        calib_matches = EXCLUDED.calib_matches,
        calib_version = EXCLUDED.calib_version,
        updated_at = NOW()
    `, [s.participant, s.username, s.rating, s.calib_matches, s.calib_version]);
  }
}

// Fetch-or-create a human row. Never call this for an 'ai:' participant.
async function ensureUserRow(client, userId, username, forUpdate) {
  const p = participantForUser(userId);
  await client.query(`
    INSERT INTO ratings (participant, username, rating, rated_matches)
    VALUES ($1, $2, $3, 0) ON CONFLICT (participant) DO NOTHING
  `, [p, username || p, elo.START_RATING]);
  const r = await client.query(
    `SELECT participant, username, rating, rated_matches FROM ratings WHERE participant = $1${forUpdate ? ' FOR UPDATE' : ''}`,
    [p]);
  return r.rows[0];
}

async function aiRow(client, difficulty) {
  const r = await client.query(
    `SELECT participant, username, rating, calib_matches FROM ratings WHERE participant = $1`,
    [participantForDifficulty(difficulty)]);
  return r.rows[0] || null;
}

// Solo results are client-reported, so a suspiciously fast "win" is
// recorded but never rated (see the spec's forgery guard).
function soloRatable(userId, result, durationSeconds) {
  if (!(userId > 0)) return false;
  if (result === 'win' && durationSeconds < 120) return false;
  return true;
}

// One human vs one fixed AI anchor. Returns the applied delta and the
// AI's rating so the client can explain a zeroed gain precisely.
async function applySolo(client, { userId, username, difficulty, result }) {
  const human = await ensureUserRow(client, userId, username, true);
  const ai = await aiRow(client, difficulty);
  if (!ai) return null;
  const k = elo.kFactor(human.rated_matches);
  const score = elo.scoreFromResult(result);
  const out = elo.applyVsAi(Number(human.rating), Number(ai.rating), score, k);
  await client.query(`
    UPDATE ratings SET rating = $2, rated_matches = rated_matches + 1, username = $3, updated_at = NOW()
    WHERE participant = $1
  `, [human.participant, out.after, username || human.username]);
  return { delta: out.delta, after: out.after, aiRating: Number(ai.rating), capped: out.capped };
}

// Human vs human: ordinary symmetric Elo, both rows locked in a stable
// order so two finishing matches can't deadlock.
async function applyPvpPair(client, a, b, scoreA) {
  const first = a.userId < b.userId ? a : b;
  const second = a.userId < b.userId ? b : a;
  await ensureUserRow(client, first.userId, first.username, true);
  await ensureUserRow(client, second.userId, second.username, true);
  const rowA = (await client.query(
    `SELECT participant, username, rating, rated_matches FROM ratings WHERE participant = $1`,
    [participantForUser(a.userId)])).rows[0];
  const rowB = (await client.query(
    `SELECT participant, username, rating, rated_matches FROM ratings WHERE participant = $1`,
    [participantForUser(b.userId)])).rows[0];
  const out = elo.applyPvp(
    Number(rowA.rating), Number(rowB.rating), scoreA,
    elo.kFactor(rowA.rated_matches), elo.kFactor(rowB.rated_matches));
  for (const [row, res, who] of [[rowA, out.a, a], [rowB, out.b, b]]) {
    await client.query(`
      UPDATE ratings SET rating = $2, rated_matches = rated_matches + 1, username = $3, updated_at = NOW()
      WHERE participant = $1
    `, [row.participant, res.after, who.username || row.username]);
  }
  return { a: out.a, b: out.b };
}

// ------------------------------------------------------------- backfill
// One-time replay of pre-Elo history, oldest first, under exactly the
// live rules. Idempotent via the "no user: rows yet" flag condition.

async function backfill(pool) {
  const existing = await pool.query(`SELECT 1 FROM ratings WHERE participant LIKE 'user:%' LIMIT 1`);
  if (existing.rows.length) return { skipped: true };

  const all = await pool.query(`
    SELECT id, user_id, username, result, difficulty, duration_seconds, map_seed, created_at, mode, opponent
    FROM matches WHERE user_id > 0 ORDER BY created_at ASC, id ASC
  `);
  const rows = all.rows;
  const ratings = new Map();   // participant -> { rating, rated_matches, username }
  for (const s of aiSeeds()) ratings.set(s.participant, { rating: s.rating, rated_matches: 0, username: s.username });
  const deltas = [];           // { id, delta, after }
  const handled = new Set();

  const human = (id, username) => {
    const p = participantForUser(id);
    if (!ratings.has(p)) ratings.set(p, { rating: elo.START_RATING, rated_matches: 0, username });
    const row = ratings.get(p);
    if (username) row.username = username;
    return row;
  };

  let unpaired = 0;
  for (const m of rows) {
    if (handled.has(m.id)) continue;
    if (m.mode === 'pvp') {
      if (m.result !== 'win') continue;   // the paired loser row drives nothing
      const loser = rows.find((o) => o.id !== m.id && o.mode === 'pvp' && !handled.has(o.id)
        && o.map_seed === m.map_seed
        && String(o.username).toLowerCase() === String(m.opponent || '').toLowerCase()
        && String(o.opponent || '').toLowerCase() === String(m.username).toLowerCase());
      if (!loser) { unpaired++; continue; }
      handled.add(m.id); handled.add(loser.id);
      const w = human(m.user_id, m.username), l = human(loser.user_id, loser.username);
      const out = elo.applyPvp(w.rating, l.rating, 1, elo.kFactor(w.rated_matches), elo.kFactor(l.rated_matches));
      w.rating = out.a.after; w.rated_matches++;
      l.rating = out.b.after; l.rated_matches++;
      deltas.push({ id: m.id, delta: out.a.delta, after: out.a.after });
      deltas.push({ id: loser.id, delta: out.b.delta, after: out.b.after });
      continue;
    }
    if (!soloRatable(m.user_id, m.result, m.duration_seconds)) continue;
    const ai = ratings.get(participantForDifficulty(m.difficulty));
    if (!ai) continue;
    const h = human(m.user_id, m.username);
    const out = elo.applyVsAi(h.rating, ai.rating, elo.scoreFromResult(m.result), elo.kFactor(h.rated_matches));
    h.rating = out.after; h.rated_matches++;
    deltas.push({ id: m.id, delta: out.delta, after: out.after });
  }

  for (const [participant, row] of ratings) {
    if (elo.isAnchored(participant)) continue;   // anchors are never written here
    await pool.query(`
      INSERT INTO ratings (participant, username, rating, rated_matches)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (participant) DO UPDATE SET
        username = EXCLUDED.username, rating = EXCLUDED.rating,
        rated_matches = EXCLUDED.rated_matches, updated_at = NOW()
    `, [participant, row.username || participant, row.rating, row.rated_matches]);
  }
  for (const d of deltas) {
    await pool.query(`UPDATE matches SET rating_delta = $2, rating_after = $3 WHERE id = $1`,
      [d.id, d.delta, d.after]);
  }
  if (unpaired) console.warn(`ratings backfill: skipped ${unpaired} unpairable pvp win row(s)`);
  return { players: ratings.size - aiSeeds().length, rated: deltas.length, unpaired };
}

// --------------------------------------------------------------- reads

// The anchors straight from the artifact — no DB round-trip, no user
// data, safe to serve unauthenticated.
function aiPublic() {
  return aiSeeds()
    .map((s) => ({
      participant: s.participant,
      username: s.username,
      rating: s.rating,
      calib_matches: s.calib_matches,
    }))
    .sort((a, b) => b.rating - a.rating);
}

async function leaderboard(pool, userId) {
  const ai = await pool.query(`
    SELECT participant, username, rating, calib_matches FROM ratings
    WHERE participant LIKE 'ai:%' ORDER BY rating DESC
  `);
  const top = await pool.query(`
    SELECT username, rating, rated_matches FROM ratings
    WHERE participant LIKE 'user:%' AND rated_matches >= 1
    ORDER BY rating DESC, username ASC LIMIT 10
  `);
  let me = null;
  if (userId != null) {
    const r = await pool.query(
      `SELECT username, rating, rated_matches FROM ratings WHERE participant = $1`,
      [participantForUser(userId)]);
    if (r.rows.length) {
      me = {
        username: r.rows[0].username,
        rating: Math.round(Number(r.rows[0].rating)),
        rated_matches: r.rows[0].rated_matches,
      };
    }
  }
  return {
    me,
    ai: ai.rows.map((r) => ({
      participant: r.participant,
      username: r.username,
      rating: Math.round(Number(r.rating)),
      calib_matches: r.calib_matches,
    })),
    top: top.rows.map((r) => ({
      username: r.username,
      rating: Math.round(Number(r.rating)),
      rated_matches: r.rated_matches,
    })),
  };
}

module.exports = {
  artifact,
  AI_LABELS,
  aiSeeds,
  migrate,
  seedAi,
  backfill,
  applySolo,
  applyPvpPair,
  soloRatable,
  aiPublic,
  leaderboard,
  participantForUser,
  participantForDifficulty,
};
