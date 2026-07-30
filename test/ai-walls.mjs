// Headless smoke test for the AI wall-building pass (#205). Run manually:
//   node test/ai-walls.mjs
// Drives the scripted opponent (owner 1) exactly like the main loop —
// aiTick every 20 ticks — on fixed map seeds WITH a seeded Math.random
// (mulberry32), so every scenario replays identically run to run.

import * as S from '../public/js/sim.js';
import { aiTick } from '../public/js/ai.js';
import { mulberry32, hashSeed } from '../public/js/mapgen.js';

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function seedRandom(tag) { Math.random = mulberry32(hashSeed(tag)); }

// Drive the sim + the owner-1 commander the way main.js does.
function drive(g, ticks, onAi, diffKey) {
  const cad = S.aiCadence(diffKey || g.difficulty);
  for (let i = 0; i < ticks; i++) {
    S.step(g);
    if (g.tick % cad === 0) {
      aiTick(g, S, 1, g.ai);
      if (onAi) onAi(g);
    }
  }
}

// Feed the AI fog-fair evidence of trouble: the known player settlement
// plus a remembered war party bearing down on its town — placed 12 tiles
// out, inside the scoring radius (TERRITORY + AGGRO + 6 = 15) but outside
// the settlement's own vision (8), so the memory isn't retired on sight.
// Refreshed periodically so it outlives the 600-tick threat expiry.
function inject(g) {
  const s1 = g.settlements.find(s => s.owner === 1);
  const s0 = g.settlements.find(s => s.owner === 0);
  if (!s1 || !s0) return;
  g.ai.known[s0.id] = { x: s0.x, y: s0.y, t: g.tick };
  const cx = s1.x + 1, cy = s1.y + 1;
  const dx = s0.x + 1 - cx, dy = s0.y + 1 - cy;
  const d = Math.max(1, Math.hypot(dx, dy));
  g.ai.threats = g.ai.threats || {};
  g.ai.threats[999901] = { x: cx + (dx / d) * 12, y: cy + (dy / d) * 12, size: 8, t: g.tick };
}

// A hard/easy match with a threatened AI settlement and a garrison with
// spare hands (supply) so crew fielding is deterministic. Records every
// wallPlan the AI ever held plus the peak owner-1 wall count.
function threatScenario(diffKey, seed, ticks) {
  seedRandom(seed + ':rng');
  const g = S.newGame(seed, 'xsmall', diffKey);
  const s1 = g.settlements.find(s => s.owner === 1);
  s1.garrison = { deploy: 4, supply: 8, farm: 0 };
  s1.garrFood = 12 * S.C.FOOD_PER_UNIT;
  s1.stockpile = 300;
  const plans = [];
  const seen = new Set();
  let maxWalls = 0;
  drive(g, ticks, (g2) => {
    if (g2.tick % 100 === 0) inject(g2);
    const p = g2.ai.wallPlan;
    if (p && !p.phase && !seen.has(p.t)) {
      seen.add(p.t);
      const st = g2.settlements.find(x => x.id === p.settId);
      plans.push({
        kind: p.kind, tiles: p.tiles.map(t => ({ x: t.x, y: t.y })),
        cx: st ? st.x + 1 : null, cy: st ? st.y + 1 : null,
      });
    }
    maxWalls = Math.max(maxWalls, g2.walls.filter(w => w.owner === 1).length);
  });
  return { g, plans, maxWalls };
}

// -------------------------------- 1/2/4/6. hard + veryhard fortify

for (const diffKey of ['hard', 'veryhard']) {
  // both tiers face the same map, so the comparison is like for like
  console.log(diffKey + ' fortifies a threatened settlement:');
  const { g, plans, maxWalls } = threatScenario(diffKey, 'aiw-h1', 5000);
  const own = g.walls.filter(w => w.owner === 1);
  check('owner-1 walls were built', own.length >= 2, `got ${own.length}`);
  check('a shield plan was recorded', plans.some(p => p.kind === 'shield'), JSON.stringify(plans));

  // every tile sits on legal ground
  const mw = g.map.w;
  check('every wall tile is on legal ground (no mountain / keep / farmland)',
    own.every(w => {
      const i = w.y * mw + w.x;
      return !g.map.mountain[i] && !g.settAt[i] && !g.tilledBy[i];
    }));

  // shield tiles sit in the feeding band outside the farm ring
  let bandOk = true, bandBad = null;
  for (const p of plans) {
    if (p.kind !== 'shield' || p.cx == null) continue;
    for (const t of p.tiles) {
      const d = Math.hypot(t.x + 0.5 - p.cx, t.y + 0.5 - p.cy);
      if (d < 3.2 - 1e-9 || d > 4.4 + 1e-9) { bandOk = false; bandBad = { t, d }; }
    }
  }
  check('shield tiles sit in the 3.2–4.4 band around the town', bandOk, JSON.stringify(bandBad));

  check(`wall count never exceeded the cap (peak ${maxWalls} ≤ ${S.DIFF[diffKey].wallCap})`,
    maxWalls <= S.DIFF[diffKey].wallCap);

  // no farm plot was denied: strip the walls from a save and every
  // owner-1 field ring keeps the same plot count
  const plots = g.settlements.filter(s => s.owner === 1 && !s.building)
    .map(s => S.previewFields(g, s.x, s.y, 1).length);
  const d2 = JSON.parse(JSON.stringify(S.serialize(g)));
  d2.walls = [];
  const gNoWalls = S.deserialize(d2);
  const plots2 = gNoWalls.settlements.filter(s => s.owner === 1 && !s.building)
    .map(s => S.previewFields(gNoWalls, s.x, s.y, 1).length);
  check('walls denied no farm plots', JSON.stringify(plots) === JSON.stringify(plots2),
    `${JSON.stringify(plots)} vs ${JSON.stringify(plots2)}`);

  // #219 made own farmland legal for the PLAYER, and a staked site clears
  // tilledBy — so the legal-ground check above can no longer see a plot
  // the commander ate. Strip the walls and look at the rings that come
  // back: no owner-1 wall may stand where its own farmland would be.
  const ownPlots = new Set();
  for (const s of gNoWalls.settlements) {
    if (s.owner !== 1 || s.building) continue;
    for (const i of s.tilled) ownPlots.add(i);
  }
  const onPlot = own.filter(w => ownPlots.has(w.y * mw + w.x)).map(w => [w.x, w.y]);
  check('no owner-1 wall stands on its own farmland (#219)', onPlot.length === 0, JSON.stringify(onPlot));

  // both tiers garrison and arm what they raise, fed by the territory drip
  const manned = own.find(w => !w.building && S.wallGarrisonTotal(w) > 0);
  check('a finished wall ended the run garrisoned', !!manned,
    JSON.stringify(own.map(w => ({ b: w.building, g: w.garrison }))));
  if (manned) {
    check('the wall garrison is fed (bellies or stash non-empty)',
      (manned.garrFood || 0) + (manned.stock || 0) > 0,
      `garrFood=${manned.garrFood} stock=${manned.stock}`);
  }
}

// ---------------------------- 2b. veryhard mans and feeds its walls

{
  // A finished own wall standing OUTSIDE any settlement's territory: the
  // stockpile drip can never reach it, which is exactly why hard leaves
  // its choke plugs bare. veryhard hauls food out to it by caravan.
  function supplyRun(diffKey) {
    seedRandom('aiw-sup-' + diffKey + ':rng');
    const g = S.newGame('aiw-sup', 'small', diffKey);
    const s1 = g.settlements.find(s => s.owner === 1);
    s1.stockpile = 500;
    s1.garrison = { deploy: 10, supply: 8, farm: 0 };
    s1.garrFood = 40 * S.C.FOOD_PER_UNIT;
    let wall = null;
    for (let r = 9; r <= 14 && !wall; r++) {
      for (let a = 0; a < 16 && !wall; a++) {
        const th = a * Math.PI / 8;
        const x = Math.round(s1.x + 1 + Math.cos(th) * r);
        const y = Math.round(s1.y + 1 + Math.sin(th) * r);
        if (x < 1 || y < 1 || x >= g.map.w - 1 || y >= g.map.h - 1) continue;
        if (S.canPlaceWall(g, 1, x, y).err) continue;
        wall = S.placeFinishedWall(g, 1, x, y, { deploy: 4, supply: 0, farm: 0 }, 0);
      }
    }
    if (!wall) return { wall: null };
    wall.food = 0;
    drive(g, 400, null, diffKey);
    const route = g.routes.find(r => r.owner === 1 && r.targetKind === 'wall' && r.targetId === wall.id);
    return { g, wall, route };
  }

  console.log('veryhard caravans food out to a stranded wall garrison:');
  const v = supplyRun('veryhard');
  check('a manned wall was planted outside territory', !!v.wall);
  check('a caravan route was sent out to it', !!v.route,
    v.g && JSON.stringify(v.g.routes.map(r => [r.targetKind, r.targetId])));

  console.log('hard leaves it to starve (no wall caravans):');
  const h = supplyRun('hard');
  check('hard never routes a caravan to a wall', !h.route);
}

// ------------------------------------------- 3. easy never walls

{
  console.log('easy never walls:');
  const { g } = threatScenario('easy', 'aiw-e1', 2500);
  check('zero owner-1 walls on easy', g.walls.filter(w => w.owner === 1).length === 0,
    `${g.walls.length} walls`);
}

// ------------------------------------------- 5. expansion is not starved

{
  console.log('walling does not starve expansion (quiet game, same seed):');
  function quietRun(cap) {
    const saved = S.DIFF.hard.wallCap;
    S.DIFF.hard.wallCap = cap;
    try {
      seedRandom('aiw-q1:rng');
      const g = S.newGame('aiw-q1', 'xsmall', 'hard');
      drive(g, 4000);
      return g.settlements.filter(s => s.owner === 1).length;
    } finally {
      S.DIFF.hard.wallCap = saved;
    }
  }
  const withWalls = quietRun(S.DIFF.hard.wallCap);
  const without = quietRun(0);
  check(`same settlement count with walls enabled (${withWalls} vs ${without})`,
    withWalls === without);
  check('the AI expanded past its founding town', withWalls >= 2, `setts=${withWalls}`);
}

// ------------------------------------------- 7. save / resume mid-job

{
  console.log('save/resume preserves an in-flight wall job:');
  seedRandom('aiw-s1:rng');
  const g = S.newGame('aiw-s1', 'xsmall', 'hard');
  const s1 = g.settlements.find(s => s.owner === 1);
  s1.garrison = { deploy: 4, supply: 8, farm: 0 };
  s1.garrFood = 120;
  s1.stockpile = 300;
  let snap = null;
  for (let i = 0; i < 5000 && !snap; i++) {
    S.step(g);
    if (g.tick % 20 === 0) {
      if (g.tick % 100 === 0) inject(g);
      aiTick(g, S, 1, g.ai);
      const p = g.ai.wallPlan;
      if (p && !p.phase) {
        const b = g.blobs.find(x => !x.dead && x.id === p.blobId);
        if (b && b.order && b.order.type === 'wall') snap = S.serialize(g);
      }
    }
  }
  check('captured a mid-job save', !!snap);
  if (snap) {
    const g2 = S.deserialize(JSON.parse(JSON.stringify(snap)));
    check('wallPlan survives the round-trip', !!(g2.ai && g2.ai.wallPlan),
      JSON.stringify(g2.ai && g2.ai.wallPlan));
    const b2 = g2.ai.wallPlan
      ? g2.blobs.find(x => !x.dead && x.id === g2.ai.wallPlan.blobId) : null;
    check('builder resumes with its wall order',
      !!(b2 && b2.order && b2.order.type === 'wall'), b2 && JSON.stringify(b2.order));
    drive(g2, 2500, (gg) => { if (gg.tick % 100 === 0) inject(gg); });
    check('the resumed game finishes walls',
      g2.walls.some(w => w.owner === 1 && !w.building),
      `${g2.walls.filter(w => w.owner === 1).length} owner-1 walls`);
  }
}

// ------------------------------------------- 9. dead crew clears the job

{
  console.log('a dead crew does not strand the job:');
  seedRandom('aiw-k1:rng');
  const g = S.newGame('aiw-k1', 'xsmall', 'hard');
  const s1 = g.settlements.find(s => s.owner === 1);
  s1.garrison = { deploy: 4, supply: 8, farm: 0 };
  s1.garrFood = 120;
  s1.stockpile = 300;
  let killed = false, killedAt = 0;
  for (let i = 0; i < 6000; i++) {
    S.step(g);
    if (g.tick % 20 === 0) {
      if (g.tick % 100 === 0) inject(g);
      aiTick(g, S, 1, g.ai);
      const p = g.ai.wallPlan;
      if (!killed && p && !p.phase) {
        const b = g.blobs.find(x => !x.dead && x.id === p.blobId);
        if (b) {
          b.units = [];
          b.count = { deploy: 0, supply: 0, farm: 0 };
          b.dead = true;
          killed = true;
          killedAt = g.tick;
        }
      }
      if (killed && !g.ai.wallPlan) break;
    }
  }
  check('a crew was killed mid-job', killed);
  check('the plan was cleared well within the deadline',
    killed && !g.ai.wallPlan && g.tick - killedAt <= 1800,
    `plan=${JSON.stringify(g.ai.wallPlan)} after ${g.tick - killedAt} ticks`);
}

// ------------------------------------------- 8. deterministic placement

{
  console.log('placement is deterministic (same seed, same RNG):');
  function tileSet() {
    const { g } = threatScenario('hard', 'aiw-d1', 3000);
    return JSON.stringify(g.walls.filter(w => w.owner === 1)
      .map(w => [w.x, w.y])
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]));
  }
  const a = tileSet();
  const b = tileSet();
  check('two identical runs place identical walls', a === b, `${a} vs ${b}`);
  check('and they placed something', a !== '[]', a);
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
