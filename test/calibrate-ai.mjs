// Build-time AI calibration harness. Run:
//   npm run calibrate      (node test/calibrate-ai.mjs)
//
// Plays headless AI-vs-AI matches exactly the way attract-pool.js drives
// one, and fits each challenger's Elo from its measured score rate
// against a REFERENCE OPPONENT. The result is written to
// calibration/ai-ratings.json, which is committed and read by server.js
// at boot — the single source of truth for every AI rating.
//
// Each persona is measured against the strongest opponent that can still
// resolve it, and the ladder is fitted in that order (see OPPONENT_OF):
//
//   easy     vs normal   — the 1000-pinned anchor
//   hard     vs normal   — the 1000-pinned anchor
//   veryhard vs HARD     — chained onto hard's freshly fitted rating
//
// Why veryhard is not measured against normal: the anchor saturates.
// Both hard and veryhard beat normal on the same maps — comparing the
// two personas' logs from the v4 run, 28 of 40 maps resolved identically
// no matter which of them played, and the 12 that responded split 6-6.
// A metric where 70% of samples are inert cannot resolve the gap between
// them at n=40, and twice running it fitted them to the identical
// rating. Measuring veryhard against hard puts every match on the axis
// that actually differs, and chaining the fit onto hard's rating keeps
// the whole ladder on one scale.
//
// The chain is recorded in the artifact: every persona carries the
// `opponent` it faced and the `opponent_rating` its fit was anchored to,
// and every log row names its opponent, so the arithmetic is auditable
// after the fact (test/calibration.mjs re-derives it).
//
// NOT part of `npm test`: a full run is minutes of CPU. Re-run it (and
// bump `version` in the artifact) after retuning DIFF in public/js/sim.js.
//
// Flags: --rounds=N  --out=path/to.json  --version=N  --quiet

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import * as S from '../public/js/sim.js';
import { aiTick } from '../public/js/ai.js';

const require = createRequire(import.meta.url);
const elo = require('../elo.js');

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');

export const CALIB_TICK_CAP = 36000;   // 2 h of 1×-scale play
// Fitted in this order — a persona measured against another persona must
// come after it, so its anchor rating already exists when the chain is
// resolved. main() enforces that rather than trusting the ordering.
export const CHALLENGERS = ['easy', 'hard', 'veryhard'];
export const OPPONENT_OF = { easy: 'normal', hard: 'normal', veryhard: 'hard' };
export const ANCHOR_PERSONA = 'normal';     // the one pinned by construction
export const SIZES = ['xsmall', 'small'];   // even rounds / odd rounds
const DEFAULT_ROUNDS = 20;                  // 20 rounds = 40 matches per persona

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

// A round is two matches on one seed with the sides swapped, so the
// residual owner asymmetry (see fogFill below) cancels out.
export function rounds(challenger, n = DEFAULT_ROUNDS) {
  const opponent = OPPONENT_OF[challenger] || ANCHOR_PERSONA;
  const out = [];
  for (let r = 0; r < n; r++) {
    const seed = `calib-${r}`;
    const size = SIZES[r % SIZES.length];
    out.push({ challenger, opponent, seed, size, challengerOwner: 0 });
    out.push({ challenger, opponent, seed, size, challengerOwner: 1 });
  }
  return out;
}

export function totals(game, owner) {
  let setts = 0, units = 0;
  for (const s of game.settlements) {
    if (s.owner !== owner) continue;
    setts++;
    if (s.garrison) for (const k of Object.keys(s.garrison)) units += s.garrison[k] || 0;
  }
  for (const b of game.blobs) if (!b.dead && b.owner === owner) units += S.total(b);
  return { setts, units };
}

// Tick-cap adjudication: settlements first, then a 25% unit margin,
// else a draw. Pure, so test/calibration.mjs can check it cheaply.
export function adjudicate(a, b) {
  if (a.setts !== b.setts) return a.setts > b.setts ? 1 : 0;
  if (a.units >= b.units * 1.25) return 1;
  if (b.units >= a.units * 1.25) return 0;
  return 0.5;
}

// game.result is owner-0-centric in a non-pvp game ('win' = owner 0 won).
export function scoreForChallenger(result, challengerOwner) {
  const owner0 = result === 'win' ? 1 : 0;
  return challengerOwner === 0 ? owner0 : 1 - owner0;
}

export function playMatch({ challenger, seed, size, challengerOwner, opponent }, cap = CALIB_TICK_CAP) {
  const foe = opponent || OPPONENT_OF[challenger] || ANCHOR_PERSONA;
  const d0 = challengerOwner === 0 ? challenger : foe;
  const d1 = challengerOwner === 0 ? foe : challenger;
  const g = S.newGame(seed, size, 'normal');   // per-owner diffKey overrides this
  const st0 = { diffKey: d0 }, st1 = { diffKey: d1 };
  // each side thinks at its own difficulty's cadence (evalTicks); the
  // half-cadence offset on owner 0 keeps the two from resolving on the
  // same tick, exactly as the fixed 20/10 pair used to
  const cad0 = S.aiCadence(d0), cad1 = S.aiCadence(d1);
  while (g.tick < cap && !g.result) {
    S.step(g);
    if (g.tick % cad1 === 0) aiTick(g, S, 1, st1);
    if (g.tick % cad0 === (cad0 >> 1)) aiTick(g, S, 0, st0);
    // owner 1 paths omnisciently in a solo game (pathFog returns null for
    // it); flooding the fog keeps owner 0 on equal footing — same trick
    // attract-pool.js uses.
    if (g.tick % 5 === 0) g.fog.fill(2);
    g.events.length = 0;
  }
  if (g.result) {
    return { score: scoreForChallenger(g.result, challengerOwner), ticks: g.tick, decided_by: 'elimination' };
  }
  const own0 = adjudicate(totals(g, 0), totals(g, 1));
  const score = challengerOwner === 0 ? own0 : 1 - own0;
  return { score, ticks: g.tick, decided_by: 'adjudicated' };
}

function main() {
  const n = parseInt(arg('rounds', String(DEFAULT_ROUNDS)), 10);
  const version = parseInt(arg('version', '1'), 10);
  const outPath = resolve(REPO, arg('out', 'calibration/ai-ratings.json'));
  const quiet = process.argv.includes('--quiet');
  const t0 = Date.now();

  const log = [];
  const personas = [];
  // Rating each persona is measured against. The anchor is pinned; every
  // other entry is filled in as that persona is fitted, so a chained
  // challenger reads its opponent's rating from this run, not a stale one.
  const ratingOf = { [ANCHOR_PERSONA]: elo.ANCHOR_RATING };

  for (const challenger of CHALLENGERS) {
    const opponent = OPPONENT_OF[challenger] || ANCHOR_PERSONA;
    const anchorRating = ratingOf[opponent];
    if (anchorRating == null) {
      throw new Error(`cannot fit ai:${challenger}: its opponent ai:${opponent} has no rating yet — ` +
        `list it earlier in CHALLENGERS`);
    }
    let wins = 0, draws = 0, losses = 0, total = 0;
    for (const round of rounds(challenger, n)) {
      const t = Date.now();
      const r = playMatch(round);
      total += r.score;
      if (r.score === 1) wins++; else if (r.score === 0.5) draws++; else losses++;
      log.push({
        challenger: `ai:${challenger}`,
        opponent: `ai:${opponent}`,
        seed: round.seed,
        size: round.size,
        challenger_owner: round.challengerOwner,
        score: r.score,
        ticks: r.ticks,
        decided_by: r.decided_by,
      });
      if (!quiet) {
        console.log(`  ${challenger} vs ${opponent} ${round.size} ${round.seed} own${round.challengerOwner} ` +
          `score=${r.score} ${r.decided_by} t=${r.ticks} (${((Date.now() - t) / 1000).toFixed(1)}s)`);
      }
    }
    const matches = wins + draws + losses;
    const fit = elo.ratingFromScoreRate(total, matches, anchorRating);
    const rating = Math.round(fit.rating);
    ratingOf[challenger] = rating;
    personas.push({
      participant: `ai:${challenger}`,
      opponent: `ai:${opponent}`,
      opponent_rating: anchorRating,
      rating,
      matches, wins, draws, losses,
      score_rate: Number(fit.scoreRate.toFixed(4)),
      raw_fit: Math.round(fit.raw),
      clamped: fit.clamped,
    });
    console.log(`${challenger} vs ${opponent} (${anchorRating}): ${wins}W-${draws}D-${losses}L → Elo ${rating}` +
      (fit.clamped ? ` (raw ${Math.round(fit.raw)}, clamped)` : ''));
  }

  const artifact = {
    version,
    generated_at: new Date().toISOString(),
    harness: 'test/calibrate-ai.mjs',
    tick_cap: CALIB_TICK_CAP,
    rounds: n,
    sizes: SIZES,
    anchor: { participant: `ai:${ANCHOR_PERSONA}`, rating: elo.ANCHOR_RATING },
    // who each persona was measured against, mirroring OPPONENT_OF so the
    // chain is readable without re-reading the harness
    opponents: Object.fromEntries(
      CHALLENGERS.map((c) => [`ai:${c}`, `ai:${OPPONENT_OF[c] || ANCHOR_PERSONA}`])),
    personas,
    log,
  };
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(artifact, null, 2) + '\n');
  console.log(`wrote ${outPath} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
