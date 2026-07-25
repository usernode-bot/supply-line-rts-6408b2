// Build-time AI calibration harness. Run:
//   npm run calibrate      (node test/calibrate-ai.mjs)
//
// Plays Easy-vs-Normal and Hard-vs-Normal headless, exactly the way
// attract-pool.js drives an AI-vs-AI game, and fits each challenger's
// Elo from the measured score rate against the 1000-pinned Normal
// commander. The result is written to calibration/ai-ratings.json,
// which is committed and read by server.js at boot — it is the single
// source of truth for all three AI ratings.
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
export const CHALLENGERS = ['easy', 'hard', 'veryhard'];
export const SIZES = ['xsmall', 'small'];   // even rounds / odd rounds
const DEFAULT_ROUNDS = 20;                  // 20 rounds = 40 matches per persona

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

// A round is two matches on one seed with the sides swapped, so the
// residual owner asymmetry (see fogFill below) cancels out.
export function rounds(challenger, n = DEFAULT_ROUNDS) {
  const out = [];
  for (let r = 0; r < n; r++) {
    const seed = `calib-${r}`;
    const size = SIZES[r % SIZES.length];
    out.push({ challenger, seed, size, challengerOwner: 0 });
    out.push({ challenger, seed, size, challengerOwner: 1 });
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

export function playMatch({ challenger, seed, size, challengerOwner }, cap = CALIB_TICK_CAP) {
  const d0 = challengerOwner === 0 ? challenger : 'normal';
  const d1 = challengerOwner === 0 ? 'normal' : challenger;
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
  for (const challenger of CHALLENGERS) {
    let wins = 0, draws = 0, losses = 0, total = 0;
    for (const round of rounds(challenger, n)) {
      const t = Date.now();
      const r = playMatch(round);
      total += r.score;
      if (r.score === 1) wins++; else if (r.score === 0.5) draws++; else losses++;
      log.push({
        challenger: `ai:${challenger}`,
        seed: round.seed,
        size: round.size,
        challenger_owner: round.challengerOwner,
        score: r.score,
        ticks: r.ticks,
        decided_by: r.decided_by,
      });
      if (!quiet) {
        console.log(`  ${challenger} ${round.size} ${round.seed} own${round.challengerOwner} ` +
          `score=${r.score} ${r.decided_by} t=${r.ticks} (${((Date.now() - t) / 1000).toFixed(1)}s)`);
      }
    }
    const matches = wins + draws + losses;
    const fit = elo.ratingFromScoreRate(total, matches);
    personas.push({
      participant: `ai:${challenger}`,
      rating: Math.round(fit.rating),
      matches, wins, draws, losses,
      score_rate: Number(fit.scoreRate.toFixed(4)),
      raw_fit: Math.round(fit.raw),
      clamped: fit.clamped,
    });
    console.log(`${challenger}: ${wins}W-${draws}D-${losses}L → Elo ${Math.round(fit.rating)}` +
      (fit.clamped ? ` (raw ${Math.round(fit.raw)}, clamped)` : ''));
  }

  const artifact = {
    version,
    generated_at: new Date().toISOString(),
    harness: 'test/calibrate-ai.mjs',
    tick_cap: CALIB_TICK_CAP,
    rounds: n,
    sizes: SIZES,
    anchor: { participant: 'ai:normal', rating: elo.ANCHOR_RATING },
    personas,
    log,
  };
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(artifact, null, 2) + '\n');
  console.log(`wrote ${outPath} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
