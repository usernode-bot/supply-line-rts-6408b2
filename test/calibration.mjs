// Fast checks on the calibration harness's pure parts, plus validation
// of the committed artifact. Run:
//   node test/calibration.mjs
// Deliberately does NOT play full matches — a real calibration run is
// minutes of CPU and lives behind `npm run calibrate`. The only sim work
// here is a short smoke run proving the loop actually drives both sides.

import { createRequire } from 'node:module';
import * as S from '../public/js/sim.js';
import { aiTick } from '../public/js/ai.js';
import { adjudicate, scoreForChallenger, rounds, totals, SIZES, CALIB_TICK_CAP } from './calibrate-ai.mjs';

const require = createRequire(import.meta.url);
const elo = require('../elo.js');
const artifact = require('../calibration/ai-ratings.json');

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

// ------------------------------------------- 1. tick-cap adjudication

{
  console.log('adjudication at the tick cap:');
  check('a settlement lead wins outright', adjudicate({ setts: 3, units: 10 }, { setts: 2, units: 400 }) === 1);
  check('...in both directions', adjudicate({ setts: 1, units: 400 }, { setts: 4, units: 10 }) === 0);
  check('equal settlements + 25% unit margin wins',
    adjudicate({ setts: 3, units: 125 }, { setts: 3, units: 100 }) === 1);
  check('...and the mirror', adjudicate({ setts: 3, units: 100 }, { setts: 3, units: 125 }) === 0);
  check('just under the margin is a draw',
    adjudicate({ setts: 3, units: 124 }, { setts: 3, units: 100 }) === 0.5);
  check('dead even is a draw', adjudicate({ setts: 2, units: 80 }, { setts: 2, units: 80 }) === 0.5);
}

// --------------------------------------- 2. result → challenger score

{
  console.log('result mapping:');
  check("'win' means owner 0 won", scoreForChallenger('win', 0) === 1 && scoreForChallenger('win', 1) === 0);
  check("'loss' means owner 1 won", scoreForChallenger('loss', 0) === 0 && scoreForChallenger('loss', 1) === 1);
}

// ------------------------------------------------ 3. round generation

{
  console.log('round generation:');
  const rs = rounds('hard', 4);
  check('two matches per round', rs.length === 8);
  check('each seed is played from both sides',
    rs[0].seed === rs[1].seed && rs[0].challengerOwner === 0 && rs[1].challengerOwner === 1);
  check('sizes alternate xsmall / small',
    rs[0].size === SIZES[0] && rs[2].size === SIZES[1] && rs[4].size === SIZES[0]);
  check('seeds are distinct per round', new Set(rs.map(r => r.seed)).size === 4);
  check('the challenger never faces itself', rs.every(r => r.challenger === 'hard'));
  check('the tick cap is 2h of 1x play', CALIB_TICK_CAP === 36000);
}

// ------------------------------------------- 4. the committed artifact

{
  console.log('committed calibration/ai-ratings.json:');
  check('has a version and a generated_at',
    Number.isInteger(artifact.version) && typeof artifact.generated_at === 'string');
  check('anchors ai:normal at 1000',
    artifact.anchor.participant === 'ai:normal' && artifact.anchor.rating === 1000);
  check('rates exactly ai:easy, ai:hard and ai:veryhard',
    artifact.personas.length === 3
    && artifact.personas.some(p => p.participant === 'ai:easy')
    && artifact.personas.some(p => p.participant === 'ai:hard')
    && artifact.personas.some(p => p.participant === 'ai:veryhard'));

  const byId = Object.fromEntries(artifact.personas.map(p => [p.participant, p]));
  check('the tiers are ordered easy < normal(1000) < hard < veryhard',
    byId['ai:easy'] && byId['ai:hard'] && byId['ai:veryhard']
    && byId['ai:easy'].rating < 1000
    && byId['ai:hard'].rating > 1000
    && byId['ai:veryhard'].rating > byId['ai:hard'].rating,
    JSON.stringify({
      easy: byId['ai:easy'] && byId['ai:easy'].rating,
      hard: byId['ai:hard'] && byId['ai:hard'].rating,
      veryhard: byId['ai:veryhard'] && byId['ai:veryhard'].rating,
    }));

  for (const p of artifact.personas) {
    const refit = elo.ratingFromScoreRate(p.wins + p.draws * 0.5, p.matches);
    check(`${p.participant} rating matches a re-fit of its own W/D/L`,
      Math.round(refit.rating) === p.rating, `stored ${p.rating}, refit ${Math.round(refit.rating)}`);
    check(`${p.participant} W+D+L equals its match count`,
      p.wins + p.draws + p.losses === p.matches);
    check(`${p.participant} sits inside the ±400 clamp`,
      p.rating >= 600 && p.rating <= 1400, `${p.rating}`);
    check(`${p.participant} clamped flag agrees with the fit`, p.clamped === refit.clamped);
  }

  const logged = artifact.log.length;
  const summed = artifact.personas.reduce((a, p) => a + p.matches, 0);
  check('the log holds one record per played match', logged === summed, `${logged} vs ${summed}`);
  check('every log record is scored 0 / 0.5 / 1',
    artifact.log.every(r => [0, 0.5, 1].includes(r.score)));
  check('every log record says how it was decided',
    artifact.log.every(r => ['elimination', 'adjudicated'].includes(r.decided_by)));
  check('adjudicated records all sit at the tick cap',
    artifact.log.filter(r => r.decided_by === 'adjudicated').every(r => r.ticks === artifact.tick_cap));
  check('each persona played both sides equally',
    artifact.personas.every(p => {
      const mine = artifact.log.filter(r => r.challenger === p.participant);
      return mine.filter(r => r.challenger_owner === 0).length === mine.length / 2;
    }));
  check('per-persona wins in the log match the summary',
    artifact.personas.every(p => {
      const mine = artifact.log.filter(r => r.challenger === p.participant);
      return mine.filter(r => r.score === 1).length === p.wins
        && mine.filter(r => r.score === 0.5).length === p.draws;
    }));
}

// -------------------------------------------------- 5. loop smoke run

{
  console.log('harness loop smoke run (2000 ticks, xsmall):');
  const g = S.newGame('calib-smoke', 'xsmall', 'normal');
  const st0 = { diffKey: 'veryhard' }, st1 = { diffKey: 'normal' };
  const cad0 = S.aiCadence(st0.diffKey), cad1 = S.aiCadence(st1.diffKey);
  const t0 = Date.now();
  let ticks0 = 0;
  while (g.tick < 2000 && !g.result) {
    S.step(g);
    if (g.tick % cad1 === 0) aiTick(g, S, 1, st1);
    if (g.tick % cad0 === (cad0 >> 1)) { aiTick(g, S, 0, st0); ticks0++; }
    if (g.tick % 5 === 0) g.fog.fill(2);
    g.events.length = 0;
  }
  check('the sim advanced', g.tick >= 2000 || !!g.result);
  check('veryhard is evaluated twice as often as normal',
    S.aiCadence('veryhard') === 10 && S.aiCadence('normal') === 20
    && S.aiCadence('hard') === 20 && S.aiCadence('easy') === 20);
  check('the faster commander really did tick more often', ticks0 > 2000 / 20,
    `${ticks0} evaluations`);
  check('fog is flooded so owner 0 is not handicapped', g.fog.every(v => v === 2));
  check('both commanders acted (state was written per owner)',
    !!st0.known && !!st1.known);
  check('both sides still hold territory or units',
    totals(g, 0).setts + totals(g, 0).units > 0 && totals(g, 1).setts + totals(g, 1).units > 0);
  console.log(`  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall calibration checks passed');
process.exit(failures ? 1 : 0);
