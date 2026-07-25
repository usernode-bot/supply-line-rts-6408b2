// Headless tests for the Elo module (elo.js). Run:
//   node test/elo.mjs
// Covers the two rules that make this app's Elo unusual: the AI
// commanders are immutable anchors, and human-vs-AI is asymmetric (a
// win only pays below the commander's rating and never carries the
// player past it, while a loss always lands in full).

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const elo = require('../elo.js');

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

// ------------------------------------------------ 1. expected score

{
  console.log('expected score:');
  check('equal ratings are a coin flip', near(elo.expectedScore(1000, 1000), 0.5));
  check('symmetric', near(elo.expectedScore(1200, 900) + elo.expectedScore(900, 1200), 1));
  check('+400 is ~0.909', near(elo.expectedScore(1400, 1000), 1 / (1 + Math.pow(10, -1))));
  check('anchored predicate covers every commander',
    ['ai:easy', 'ai:normal', 'ai:hard', 'ai:veryhard'].every(elo.isAnchored)
    && !elo.isAnchored('user:7'));
}

// ------------------------------------- 2. AI immutability (all three)

{
  console.log('AI personas never move:');
  const cases = [];
  for (const ai of [600, 1000, 1180]) {
    for (const human of [400, ai - 10, ai, ai + 200]) {
      for (const score of [1, 0.5, 0]) cases.push([human, ai, score]);
    }
  }
  check('every applyVsAi returns aiDelta === 0 (wins, draws, losses, above and below)',
    cases.every(([h, a, s]) => elo.applyVsAi(h, a, s, 32).aiDelta === 0),
    'an AI row would have moved');
}

// ------------------------------------------- 3. the asymmetric ceiling

{
  console.log('human vs AI is asymmetric:');
  const AI = 1180, K = 32;

  const below = elo.applyVsAi(900, AI, 1, K);
  const full = K * (1 - elo.expectedScore(900, AI));
  check('a win well below the AI gains the full K(1-E)', near(below.delta, full), `${below.delta} vs ${full}`);
  check('...and does not overshoot the ceiling', below.after < AI);

  const nearCeil = elo.applyVsAi(1170, AI, 1, K);
  check('a win 10 below the AI is clamped to exactly the gap', near(nearCeil.delta, 10), `delta ${nearCeil.delta}`);
  check('...landing on the AI rating, not past it', near(nearCeil.after, AI), `after ${nearCeil.after}`);
  check('...and reports itself capped', nearCeil.capped === true);

  check('a win exactly at the AI rating gains nothing', elo.applyVsAi(AI, AI, 1, K).delta === 0);
  check('a win above the AI rating gains nothing', elo.applyVsAi(1300, AI, 1, K).delta === 0);

  const drawBelow = elo.applyVsAi(900, AI, 0.5, K);
  check('a draw below the AI gains', drawBelow.delta > 0);
  check('a draw at the AI rating gains nothing', elo.applyVsAi(AI, AI, 0.5, K).delta === 0);
  check('a draw above the AI gains nothing', elo.applyVsAi(1300, AI, 0.5, K).delta === 0);

  const lossBelow = elo.applyVsAi(900, AI, 0, K);
  const lossAbove = elo.applyVsAi(1300, AI, 0, K);
  check('a loss below the AI applies the full standard drop',
    near(lossBelow.delta, K * (0 - elo.expectedScore(900, AI))), `${lossBelow.delta}`);
  check('a loss above the AI applies the full standard drop',
    near(lossAbove.delta, K * (0 - elo.expectedScore(1300, AI))), `${lossAbove.delta}`);
  check('losses are the only negative deltas vs AI',
    lossBelow.delta < 0 && lossAbove.delta < 0);

  let anyNegativeGain = false;
  for (let h = 100; h <= 1600; h += 7) {
    for (const s of [1, 0.5]) if (elo.applyVsAi(h, AI, s, K).delta < 0) anyNegativeGain = true;
  }
  check('no win or draw ever produces a negative delta', !anyNegativeGain);

  const floored = elo.applyVsAi(101, 1400, 0, 32);
  check('the rating floor holds at 100', floored.after >= elo.RATING_FLOOR, `after ${floored.after}`);
}

// ------------------------------------------------- 4. K graduation

{
  console.log('K-factor:');
  check('provisional K while under 10 rated matches', elo.kFactor(0) === 32 && elo.kFactor(9) === 32);
  check('established K from 10 on', elo.kFactor(10) === 16 && elo.kFactor(99) === 16);
  // a capped-gain win still counts as a played match: simulate the loop
  let rated = 8, rating = 1300;
  for (let i = 0; i < 3; i++) {
    rating = elo.applyVsAi(rating, 1180, 1, elo.kFactor(rated)).after;
    rated++;
  }
  check('capped-gain wins still graduate the K-factor', rated === 11 && elo.kFactor(rated) === 16);
  check('...without moving the rating', rating === 1300);
}

// ------------------------------------------------- 5. PvP symmetry

{
  console.log('PvP stays symmetric:');
  const out = elo.applyPvp(1200, 900, 1, 16, 16);
  check('deltas sum to zero', near(out.a.delta + out.b.delta, 0), `${out.a.delta} / ${out.b.delta}`);
  check('winner gains, loser loses', out.a.delta > 0 && out.b.delta < 0);
  const upset = elo.applyPvp(900, 1200, 1, 16, 16);
  check('an upset pays more than a favoured win', upset.a.delta > out.a.delta);
  const past = elo.applyPvp(1170, 1180, 1, 32, 32);
  check('no ceiling in PvP — a win can carry a player past the opponent', past.a.after > 1180);
}

// --------------------------------------------- 6. calibration fit

{
  console.log('rating fit:');
  const even = elo.ratingFromScoreRate(10, 20);
  check('a 50% score rate fits the anchor', near(Math.round(even.rating), 1000), `${even.rating}`);
  const strong = elo.ratingFromScoreRate(15, 20);
  check('a 75% score rate fits above the anchor', strong.rating > 1000 && strong.rating < 1400);
  const shutout = elo.ratingFromScoreRate(0, 40);
  check('a shutout stays finite', Number.isFinite(shutout.raw) && shutout.raw < 600);
  check('...and clamps to the -400 bound', near(shutout.rating, 600) && shutout.clamped === true);
  const perfect = elo.ratingFromScoreRate(40, 40);
  check('a perfect record clamps to the +400 bound', near(perfect.rating, 1400) && perfect.clamped === true);
  // 8 wins + 4 draws over 20 is the same total score as 10 wins over 20
  check('draws count as half a win in the fit',
    near(elo.ratingFromScoreRate(8 + 4 * 0.5, 20).rating, elo.ratingFromScoreRate(10, 20).rating));
  check('result→score mapping', elo.scoreFromResult('win') === 1
    && elo.scoreFromResult('draw') === 0.5
    && elo.scoreFromResult('loss') === 0
    && elo.scoreFromResult('surrender') === 0);
}

// ------------------------------------- 7. deterministic replay

{
  console.log('replay of a synthetic history:');
  const AI = { 'ai:easy': 600, 'ai:normal': 1000, 'ai:hard': 1180 };
  const before = JSON.stringify(AI);
  const players = new Map();
  const player = (id) => {
    if (!players.has(id)) players.set(id, { rating: 1000, rated: 0 });
    return players.get(id);
  };
  const deltas = [];

  // p1 beats Easy twice from 1000 — already above Easy's 600, so nothing.
  for (let i = 0; i < 2; i++) {
    const p = player(1);
    const o = elo.applyVsAi(p.rating, AI['ai:easy'], 1, elo.kFactor(p.rated));
    p.rating = o.after; p.rated++; deltas.push(o.delta);
  }
  check('grinding Easy from above its rating pays nothing',
    players.get(1).rating === 1000 && deltas.every(d => d === 0));

  // p1 then loses to Easy — the full drop still lands.
  {
    const p = player(1);
    const o = elo.applyVsAi(p.rating, AI['ai:easy'], 0, elo.kFactor(p.rated));
    p.rating = o.after; p.rated++;
    check('a loss to Easy from above still costs points', p.rating < 1000, `${p.rating}`);
  }

  // p2 beats Hard from 900 — a real gain, still under Hard.
  {
    const p = player(2);
    const o = elo.applyVsAi(p.rating, AI['ai:hard'], 1, elo.kFactor(p.rated));
    p.rating = o.after; p.rated++;
    check('beating Hard from below pays and stays under Hard',
      p.rating > 1000 && p.rating < AI['ai:hard'], `${p.rating}`);
  }

  // a pvp pair between them: symmetric, can cross the Hard ceiling.
  {
    const a = player(2), b = player(1);
    const o = elo.applyPvp(a.rating, b.rating, 1, elo.kFactor(a.rated), elo.kFactor(b.rated));
    a.rating = o.a.after; a.rated++;
    b.rating = o.b.after; b.rated++;
    check('pvp moves both players', o.a.delta > 0 && o.b.delta < 0);
  }

  check('the three AI ratings are byte-identical after the replay', JSON.stringify(AI) === before);
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall elo checks passed');
process.exit(failures ? 1 : 0);
