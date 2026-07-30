// Headless smoke test for walls (#187) and the unified garrison hunger
// rule (#200). Run manually:
//   node test/walls-smoke.mjs
// Exercises the sim only (no DOM): build orders + crew-size scaling,
// enemy pathing block + breach fallback, the three damage tiers, the
// wall's two food pools (bellies + supplies stash) with their auto-refeed
// and starvation, settlement garrison defence scaling with its own
// rations, and save/load round-tripping incl. the pre-#200 migration.

import * as S from '../public/js/sim.js';
import * as SUP from '../public/js/supply.js';
import { passable, fertTier } from '../public/js/mapgen.js';
// the UI's pick geometry (#224) — the garrison cases below assert that a
// near-miss click resolves to the wall tile, which is what makes the
// snapped order a garrison push
import { pickTol, tileDist } from '../public/js/pick.js';

// routeHealth treats a topped-off destination as "keeping up" (#143) — for
// a wall that means the SUPPLIES stash, not the garrison's bellies (#200).
function SUPHealthOk(game, route) {
  return SUP.routeHealth(game, route) >= 1;
}

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function fresh() {
  return S.newGame('walls-smoke-1', 'xsmall', 'normal');
}

// A clear tile with a clear neighbor, far from both starts, for
// deterministic wall placement.
function findClearPair(game) {
  const { w, h } = game.map;
  for (let y = 2; y < h - 2; y++) {
    for (let x = 2; x < w - 2; x++) {
      if (S.canPlaceWall(game, 0, x, y).err) continue;
      if (S.canPlaceWall(game, 0, x + 1, y).err) continue;
      if (S.canPlaceWall(game, 0, x + 2, y).err) continue;
      // keep clear of both starts so nothing interferes
      const far = game.map.starts.every(st =>
        Math.hypot(st.x - x, st.y - y) > 8);
      if (far && !game.map.mountain[y * w + x - 1] && !game.map.mountain[y * w + x + 3]) {
        return { x, y };
      }
    }
  }
  throw new Error('no clear pair found');
}

// Drop a bare test blob directly into the sim — the sim exports no blob
// factory, so this synthesizes the same record shape used everywhere.
function spawnBlob(game, owner, x, y, deploy, supply) {
  const counts = { deploy: deploy || 0, supply: supply || 0, farm: 0 };
  const units = [];
  for (const role of ['deploy', 'supply']) {
    for (let k = 0; k < counts[role]; k++) {
      // per-role max, never a hardcoded 100 — supply units are 40 HP (#213)
      units.push({ role, hp: S.unitMaxHP(role), seed: (units.length + 1) / 100 });
    }
  }
  const b = {
    id: game.nextId++, owner, x, y, prevX: x, prevY: y,
    units, count: { ...counts },
    food: (deploy + (supply || 0)) * 10,
    order: null, path: null, pathGoal: null,
    pillaging: false, working: null, facing: 0, convert: null,
    engagedT: -999, meleeT: -999, rearT: -999, chaseId: null,
    dead: false, mergedInto: null, noMerge: false,
    lastYieldT: game.tick, starving: false, lowFood: false, zeroSince: -1, foodWin: [],
  };
  game.blobs.push(b);
  return b;
}

// Inject a COMPLETED wall (test-only), as if it had been built. Two food
// pools (#200): bellies default to FULL (garrison × FOOD_PER_UNIT) and the
// supplies stash to empty; both overridable.
function injectWall(game, owner, x, y, garrison, opts) {
  const src = garrison || { deploy: 0, supply: 0, farm: 0 };
  // COPY the counts: callers reuse one literal across several walls, and
  // the sim mutates garrison objects in place (starvation, fielding)
  const g = { deploy: src.deploy || 0, supply: src.supply || 0, farm: src.farm || 0 };
  const gcap = (g.deploy + g.supply + g.farm) * S.C.FOOD_PER_UNIT;
  const o = opts || {};
  const w = {
    id: game.nextId++, owner, x, y, hp: S.C.WALL_HP, building: false,
    garrison: g,
    garrFood: o.garrFood != null ? o.garrFood : gcap,
    stock: o.stock != null ? o.stock : 0,
    garrLoss: 0, lastHitT: -999, starving: false, convert: null,
  };
  game.walls.push(w);
  game.wallAt[y * game.map.w + x] = w.id;
  return w;
}

function run(game, ticks) {
  if (!isFinite(ticks)) throw new Error(`run() got a non-finite tick count: ${ticks}`);
  for (let i = 0; i < ticks; i++) S.step(game);
}

// ---------------------------------------------------------------- 1. build a line

{
  console.log('build order completes a 3-tile line:');
  const g = fresh();
  const spot = findClearPair(g);
  const b = spawnBlob(g, 0, spot.x - 1.5, spot.y + 0.5, 10, 0);
  const tiles = [{ x: spot.x, y: spot.y }, { x: spot.x + 1, y: spot.y }, { x: spot.x + 2, y: spot.y }];
  const r = S.opBuildWalls(g, b, tiles);
  check('opBuildWalls accepts the line', !!r.ok && r.queued === 3, JSON.stringify(r));
  run(g, 600);
  const done = g.walls.filter(w => w.owner === 0 && !w.building);
  check('3 finished walls exist', done.length >= 3, `got ${done.length}`);
  check('builder order completed', !b.dead && b.order == null, JSON.stringify(b.order));
  check('wallAt claims match', tiles.every(t => g.wallAt[t.y * g.map.w + t.x] !== 0));
}

// ---------------------------------------------------------------- 2. crew-size scaling

{
  console.log('build rate scales with crew size (√n, capped at 4×):');
  function ticksToBuild(n) {
    const g = fresh();
    const spot = findClearPair(g);
    const b = spawnBlob(g, 0, spot.x + 0.5, spot.y + 0.5, n, 0); // already in reach
    S.opBuildWalls(g, b, [{ x: spot.x, y: spot.y }]);
    for (let t = 1; t <= 800; t++) {
      S.step(g);
      const w = g.walls.find(x => x.owner === 0);
      if (w && !w.building) return t;
    }
    return Infinity;
  }
  const t1 = ticksToBuild(1);
  const t4 = ticksToBuild(4);
  const t16 = ticksToBuild(16);
  const t25 = ticksToBuild(25);
  check(`1 unit ≈ WALL_BUILD_TICKS (${t1} vs ${S.C.WALL_BUILD_TICKS})`, Math.abs(t1 - S.C.WALL_BUILD_TICKS) <= 2, `t1=${t1}`);
  check(`4 units ≈ half the time (${t4})`, Math.abs(t4 - S.C.WALL_BUILD_TICKS / 2) <= 2, `t4=${t4}`);
  check(`16 units hit the 4× cap (${t16})`, Math.abs(t16 - S.C.WALL_BUILD_TICKS / 4) <= 2, `t16=${t16}`);
  check(`25 units no faster than 16 (${t25} vs ${t16})`, t25 >= t16 - 1, `t25=${t25}`);
}

// ---------------------------------------------------------------- 3. pathing: block + breach

{
  console.log('enemy walls block movement; soldiers breach, carriers do not:');
  const g = fresh();
  // find a clear 5x5 pocket and ring its center with enemy (owner 1) walls
  const { w, h } = g.map;
  let cx = -1, cy = -1;
  outer: for (let y = 4; y < h - 4; y++) {
    for (let x = 4; x < w - 4; x++) {
      let clear = true;
      for (let dy = -2; dy <= 2 && clear; dy++) {
        for (let dx = -2; dx <= 2 && dx * dx + dy * dy >= 0 && clear; dx++) {
          const i = (y + dy) * w + (x + dx);
          if (g.map.mountain[i] || g.settAt[i] || g.tilledBy[i] || g.wallAt[i]) clear = false;
          if (g.terr[i]) clear = false;
        }
      }
      const far = g.map.starts.every(st => Math.hypot(st.x - x, st.y - y) > 10);
      if (clear && far) { cx = x; cy = y; break outer; }
    }
  }
  check('found a pocket to seal', cx >= 0);
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      injectWall(g, 1, cx + dx, cy + dy);
    }
  }
  const army = spawnBlob(g, 0, cx + 0.5, cy + 0.5, 5, 0);
  run(g, 6); // let updateVision record the walls (player sees them)
  const rArmy = S.opMove(g, army, cx + 3.5, cy + 0.5);
  check('sealed-in soldiers still get a (breach) path', !!rArmy.ok, JSON.stringify(rArmy));
  check('order carries the breach flag', !!(army.order && army.order.breach));
  const before = g.walls.length;
  run(g, 400);
  check('a sealing wall was battered down', g.walls.length < before, `walls ${before} -> ${g.walls.length}`);
  run(g, 1500);
  check('the army escaped the pocket', Math.hypot(army.x - (cx + 3.5), army.y - (cy + 0.5)) < 1.5 || army.order == null,
    `at (${army.x.toFixed(1)},${army.y.toFixed(1)})`);
  // a pure-supply blob in the same fresh pocket cannot breach
  const g2 = fresh();
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      injectWall(g2, 1, cx + dx, cy + dy);
    }
  }
  const carrier = spawnBlob(g2, 0, cx + 0.5, cy + 0.5, 0, 5);
  run(g2, 6);
  const rSup = S.opMove(g2, carrier, cx + 3.5, cy + 0.5);
  check('sealed-in carriers report no path', !!rSup.err, JSON.stringify(rSup));
}

// ---------------------------------------------------------------- 4. damage tiers

{
  console.log('damage ladder: garrisoned ≫ adjacent-protected ≫ unprotected:');
  function ticksToKill(setup) {
    const g = fresh();
    const spot = findClearPair(g);
    const w = injectWall(g, 1, spot.x, spot.y,
      setup === 'garrisoned' ? { deploy: 4, supply: 0, farm: 0 } : null);
    if (setup === 'adjacent') injectWall(g, 1, spot.x + 1, spot.y, { deploy: 4, supply: 0, farm: 0 });
    // attacker stands Chebyshev-adjacent to the target wall tile
    spawnBlob(g, 0, spot.x - 0.5, spot.y + 0.5, 10, 0);
    let scratchedManned = false; // structure hit while the garrison held?
    for (let t = 1; t <= 3000; t++) {
      S.step(g);
      const live = g.walls.find(x => x.id === w.id);
      if (live && S.wallGarrisonTotal(live) > 0 && live.hp < S.C.WALL_HP - 0.001) scratchedManned = true;
      if (!live) return { t, scratchedManned };
    }
    return { t: Infinity, scratchedManned };
  }
  const open = ticksToKill('open');
  const adj = ticksToKill('adjacent');
  const garr = ticksToKill('garrisoned');
  check(`unprotected falls in seconds (${open.t} ticks)`, open.t < 150, `tOpen=${open.t}`);
  check(`adjacent-protected ≈ ${S.C.WALL_NEAR_PROT}× slower (${adj.t})`, adj.t > open.t * 5, `tAdj=${adj.t}`);
  check(`garrisoned far outlasts unprotected (${garr.t})`, garr.t > open.t * 4, `tGarr=${garr.t}`);
  check('structure untouched while the garrison held', !garr.scratchedManned);
}

// ---------------------------------------------------------------- 5. garrison feeding

{
  console.log('wall garrisons feed in territory, starve outside:');
  const g = fresh();
  const home = g.settlements.find(s => s.owner === 0);
  // a wall INSIDE home territory (ring tiles are tilled — search the
  // territory for an untilled, wall-legal tile)
  let inSpot = null, outSpot = null;
  const { w, h } = g.map;
  for (let y = 1; y < h - 1 && (!inSpot || !outSpot); y++) {
    for (let x = 1; x < w - 1 && (!inSpot || !outSpot); x++) {
      if (S.canPlaceWall(g, 0, x, y).err) continue;
      const inT = S.inTerritory(g, home, x + 0.5, y + 0.5);
      if (inT && !inSpot) inSpot = { x, y };
      const farOut = g.settlements.every(s => Math.hypot(s.x + 1 - x, s.y + 1 - y) > 12);
      if (farOut && !outSpot) outSpot = { x, y };
    }
  }
  check('found in/out spots', !!inSpot && !!outSpot);
  // both start on near-empty pools so the drip's effect is unmistakable
  const wIn = injectWall(g, 0, inSpot.x, inSpot.y, { deploy: 2, supply: 0, farm: 0 }, { garrFood: 5, stock: 0 });
  const wOut = injectWall(g, 0, outSpot.x, outSpot.y, { deploy: 2, supply: 0, farm: 0 }, { garrFood: 5, stock: 0 });
  run(g, 600);
  check('in-territory garrison got fed (bellies full)',
    wIn.garrFood > 5, `garrFood=${wIn.garrFood.toFixed(1)}`);
  check('out-of-territory garrison ran down', wOut.garrFood < 5, `garrFood=${wOut.garrFood.toFixed(1)}`);
  run(g, 3000);
  check('starving remote garrison loses units',
    wOut.garrison.deploy + wOut.garrison.supply + wOut.garrison.farm < 2,
    `left=${JSON.stringify(wOut.garrison)}`);
  check(`in-territory stash fills past the old garrison×10 cap (${(wIn.stock || 0).toFixed(0)}/${S.C.WALL_FOOD_CAP})`,
    wIn.stock > 50, `stock=${(wIn.stock || 0).toFixed(1)}`);
  check('in-territory bellies sit at capacity, not in the stash',
    Math.abs(wIn.garrFood - 2 * S.C.FOOD_PER_UNIT) < 0.5, `garrFood=${wIn.garrFood.toFixed(2)}`);
  // panel readout (#200): the wall names the settlement whose drip is
  // actually feeding it, and nothing at all when it's on its own
  home.stockpile = 100; // deterministic: the drip needs stock to give
  check('wallFeeder names the in-territory settlement',
    S.wallFeeder(g, wIn) === home, `got ${S.wallFeeder(g, wIn)}`);
  check('wallFeeder is null for the remote wall', S.wallFeeder(g, wOut) === null);
}

// ---------------------------------- 5b. two pools: bellies + supplies (#200)

// A wall-legal tile far from every settlement — no territory drip, so the
// pools only move the way the test moves them.
function findRemoteTile(game) {
  for (let y = 1; y < game.map.h - 1; y++) {
    for (let x = 1; x < game.map.w - 1; x++) {
      if (S.canPlaceWall(game, 0, x, y).err) continue;
      if (game.settlements.every(s => Math.hypot(s.x + 1 - x, s.y + 1 - y) > 12)) return { x, y };
    }
  }
  return null;
}

{
  console.log('wall garrison hunger and the supplies stash are separate pools:');
  const g = fresh();
  const spot = findClearPair(g);
  const GARR4 = { deploy: 4, supply: 0, farm: 0 };
  const CAP4 = 4 * S.C.FOOD_PER_UNIT;

  // hunger is per-unit: 39🌾 of BELLIES for 4 units is nearly full, and
  // the stash is a different number entirely
  const w4 = injectWall(g, 0, spot.x, spot.y, GARR4, { garrFood: 39, stock: 25 });
  check('4 units on 39🌾 rations read Well-fed', S.fedLabel(S.wallFedMeter(w4)) === 'Well-fed',
    `meter=${S.wallFedMeter(w4).toFixed(3)}`);
  check('bellies of 39/40 read as ~98% hunger',
    Math.abs(S.wallFedMeter(w4) - 39 / CAP4) < 1e-9, `meter=${S.wallFedMeter(w4)}`);
  check('the stash reads its own fraction, not the hunger one',
    Math.abs(S.wallStockFrac(w4) - 0.25) < 1e-9, `stock=${S.wallStockFrac(w4)}`);
  check('full bellies are not starving', S.wallStarving(w4) === false);

  // the starving state is derived, never the one-shot toast latch
  w4.starving = true;
  check('a stale starving latch does not fake the display state', S.wallStarving(w4) === false);
  w4.starving = false;

  // starving needs empty bellies AND a garrison
  const wEmpty = injectWall(g, 0, spot.x + 1, spot.y, { deploy: 2, supply: 0, farm: 0 }, { garrFood: 0 });
  check('empty bellies with a garrison is starving', S.wallStarving(wEmpty) === true);
  const wBare = injectWall(g, 0, spot.x + 2, spot.y, null, { garrFood: 0, stock: 0 });
  check('empty bellies with no garrison is not starving', S.wallStarving(wBare) === false);

  // clamps on both pools
  delete wBare.garrFood; delete wBare.stock;
  check('missing pools clamp to 0', S.wallFedMeter(wBare) === 0 && S.wallStockFrac(wBare) === 0);
  wBare.stock = S.C.WALL_FOOD_CAP * 3;
  check('over-cap stash clamps to 1', S.wallStockFrac(wBare) === 1);
  const wOver = injectWall(g, 0, spot.x, spot.y + 1, { deploy: 1, supply: 0, farm: 0 }, { garrFood: 999 });
  check('over-cap bellies clamp to 1', S.wallFedMeter(wOver) === 1);

  // runway counts BOTH pools, and scales with mouths
  check('no mouths ⇒ infinite runway', S.wallRationTicks(wBare) === Infinity);
  const w1 = injectWall(g, 0, spot.x + 1, spot.y + 1, { deploy: 1, supply: 0, farm: 0 }, { garrFood: 10, stock: 40 });
  const w8 = injectWall(g, 0, spot.x + 2, spot.y + 1, { deploy: 8, supply: 0, farm: 0 }, { garrFood: 10, stock: 40 });
  check('runway includes the stash, not just bellies',
    Math.abs(S.wallRationTicks(w1) - 50 / (1 * S.C.EAT_PER_SEC * S.C.DT)) < 1e-6,
    `ticks=${S.wallRationTicks(w1)}`);
  check('8 mouths drain the same provisions faster than 1',
    S.wallRationTicks(w8) < S.wallRationTicks(w1),
    `8→${S.wallRationTicks(w8).toFixed(0)} vs 1→${S.wallRationTicks(w1).toFixed(0)}`);

  // fed tiers map exactly like a blob's
  for (const [m, mult] of [[1, 1.25], [0.6, 1.0], [0.3, 0.75], [0, 0.5]]) {
    const wt = injectWall(g, 0, spot.x, spot.y + 2 + Math.round(m * 10), { deploy: 2, supply: 0, farm: 0 },
      { garrFood: m * 2 * S.C.FOOD_PER_UNIT });
    if (!wt) continue;
    check(`wall hunger ${m} ⇒ ${mult}× strength`, S.fedMult(S.wallFedMeter(wt)) === mult);
  }
}

{
  console.log('the garrison refeeds from the stash, and starves only when both run dry:');
  const g = fresh();
  const far = findRemoteTile(g);
  check('found a remote tile', !!far);
  const GARR = { deploy: 2, supply: 0, farm: 0 };
  const CAP = 2 * S.C.FOOD_PER_UNIT;

  // hungry bellies + a stocked stash: bellies climb, stash drains
  const w = injectWall(g, 0, far.x, far.y, GARR, { garrFood: 0.2 * CAP, stock: 50 });
  const before = w.garrFood + w.stock;
  run(g, 100);
  check('bellies refilled from the stash', w.garrFood > 0.2 * CAP,
    `garrFood=${w.garrFood.toFixed(2)}`);
  check('the stash paid for it', w.stock < 50, `stock=${w.stock.toFixed(2)}`);
  check('total food only fell by what was eaten',
    Math.abs((before - (w.garrFood + w.stock)) - 2 * S.C.EAT_PER_SEC * S.C.DT * 100) < 0.5,
    `delta=${(before - (w.garrFood + w.stock)).toFixed(3)}`);
  check('a refed garrison never starves', S.wallStarving(w) === false);
  check('garrison intact while supplied',
    S.wallGarrisonTotal(w) === 2, `left=${JSON.stringify(w.garrison)}`);
}

{
  console.log('starvation waits for both pools:');
  const g = fresh();
  const far = findRemoteTile(g);
  const GARR = { deploy: 2, supply: 0, farm: 0 };

  // empty bellies but a little stash left: the refeed saves them
  const wSaved = injectWall(g, 0, far.x, far.y, GARR, { garrFood: 0, stock: 5 });
  run(g, 20);
  check('empty bellies + stocked stash loses no units',
    S.wallGarrisonTotal(wSaved) === 2, `left=${JSON.stringify(wSaved.garrison)}`);
  check('and it is no longer starving', S.wallStarving(wSaved) === false);

  // both empty: units die
  const g2 = fresh();
  const far2 = findRemoteTile(g2);
  const wDoomed = injectWall(g2, 0, far2.x, far2.y, GARR, { garrFood: 0, stock: 0 });
  check('both pools empty reads starving', S.wallStarving(wDoomed) === true);
  run(g2, 2000);
  check('both pools empty kills the garrison',
    S.wallGarrisonTotal(wDoomed) < 2, `left=${JSON.stringify(wDoomed.garrison)}`);

  // and the runway prediction matches the real drain of both pools
  const g3 = fresh();
  const far3 = findRemoteTile(g3);
  const wd = injectWall(g3, 0, far3.x, far3.y, GARR, { garrFood: 4, stock: 8 });
  const predicted = Math.ceil(S.wallRationTicks(wd));
  run(g3, predicted - 2);
  check('provisions hold until just before the predicted empty',
    wd.garrFood > 0, `garrFood=${wd.garrFood.toFixed(3)} after ${predicted - 2} ticks`);
  run(g3, 3);
  check('provisions are gone by the predicted tick',
    wd.garrFood <= 0.0001 && wd.stock <= 0.0001 && S.wallStarving(wd),
    `garrFood=${wd.garrFood.toFixed(3)} stock=${wd.stock.toFixed(3)}`);
}

{
  console.log('units carry hunger onto the wall and back off it:');
  const g = fresh();
  const far = findRemoteTile(g);
  // arrival: a full-bellied blob garrisons an EMPTY wall — bellies fill to
  // capacity, the spare spills into the stash
  const wA = injectWall(g, 0, far.x, far.y, null, { garrFood: 0, stock: 0 });
  // 10 units (more than the 8-per-tile cap, #199) so the cap is exercised
  const b = spawnBlob(g, 0, far.x + 2.5, far.y + 0.5, 10, 0); // 10 units, 100🌾
  b.food = 100;
  S.opMove(g, b, far.x + 0.5, far.y + 0.5);
  run(g, 400);
  const gA = S.wallGarrisonTotal(wA);
  // 10 arrivals against the 8-unit cap (#199/#202): the tile fills to the
  // cap and the surplus stays outside
  check('the arrivals filled the tile to the cap',
    gA === S.C.WALL_GARRISON_CAP, `garrisoned=${gA} cap=${S.C.WALL_GARRISON_CAP}`);
  check('their rations landed in bellies, capped',
    wA.garrFood <= gA * S.C.FOOD_PER_UNIT + 1e-6 && wA.garrFood > 0,
    `garrFood=${wA.garrFood.toFixed(2)} cap=${gA * S.C.FOOD_PER_UNIT}`);
  // a blob can never carry more than FOOD_PER_UNIT per unit, so in normal
  // play the arrivals' share fits their bellies exactly — what matters is
  // that nothing is invented or lost across the handoff
  const leftover = g.blobs.filter(x => !x.dead && x.owner === 0 && x.id === b.id)
    .reduce((a, x) => a + x.food, 0);
  check('no food invented or lost when garrisoning',
    wA.garrFood + (wA.stock || 0) + leftover <= 100 + 1e-6,
    `bellies=${wA.garrFood.toFixed(2)} stock=${(wA.stock || 0).toFixed(2)} blob=${leftover.toFixed(2)}`);

  check('bellies never exceed the garrison capacity after an arrival',
    wA.garrFood <= gA * S.C.FOOD_PER_UNIT + 1e-6, `garrFood=${wA.garrFood.toFixed(2)}`);

  // over-capacity bellies (a shrunk garrison, or a migrated save) hand the
  // surplus back to the stash instead of evaporating
  const g0 = fresh();
  const far0 = findRemoteTile(g0);
  const wS = injectWall(g0, 0, far0.x, far0.y, { deploy: 1, supply: 0, farm: 0 },
    { garrFood: 3 * S.C.FOOD_PER_UNIT, stock: 0 });
  run(g0, 1);
  check('over-capacity bellies spill into the stash, not into nothing',
    (wS.stock || 0) > 0 && wS.garrFood <= S.C.FOOD_PER_UNIT + 1e-6,
    `stock=${(wS.stock || 0).toFixed(2)} bellies=${wS.garrFood.toFixed(2)}`);

  // fielding: bellies march out, topped up from the stash, remainder stays
  const g2 = fresh();
  const far2 = findRemoteTile(g2);
  const wF = injectWall(g2, 0, far2.x, far2.y, { deploy: 2, supply: 0, farm: 0 },
    { garrFood: 5, stock: 60 });
  const r = S.opFieldWall(g2, wF.id);
  check('fielding succeeded', !!r.ok, JSON.stringify(r));
  const fb = r.blob;
  check('fielded blob left with full bellies (topped up from the stash)',
    Math.abs(fb.food - S.foodCap(fb)) < 1e-6, `food=${fb.food} cap=${S.foodCap(fb)}`);
  check('the wall kept the rest of the stash',
    Math.abs(wF.stock - (60 - (S.foodCap(fb) - 5))) < 1e-6, `stock=${wF.stock.toFixed(2)}`);
  check('bellies emptied with the garrison', wF.garrFood === 0);
  run(g2, 2);
  check('leftover bellies never strand on an empty wall', wF.garrFood === 0);
}

// ------------------------------- 5c. settlement defence scales with rations (#200)

{
  console.log('settlement garrison defends at its own fed tier:');
  const g = fresh();
  const home = g.settlements.find(s => s.owner === 0);
  home.garrison = { deploy: 6, supply: 0, farm: 0 };
  const gcap = S.garrisonTotal(home) * S.C.FOOD_PER_UNIT;

  // helper tiers, both structures, same function as blobs
  home.garrFood = gcap;
  check('full rations ⇒ 1.25×', S.fedMult(S.settFedMeter(home)) === 1.25);
  home.garrFood = 0.6 * gcap;
  check('0.6 rations ⇒ 1.0×', S.fedMult(S.settFedMeter(home)) === 1.0);
  home.garrFood = 0.3 * gcap;
  check('0.3 rations ⇒ 0.75×', S.fedMult(S.settFedMeter(home)) === 0.75);
  home.garrFood = 0;
  check('empty rations ⇒ 0.5×', S.fedMult(S.settFedMeter(home)) === 0.5);

  // tick-order guard: combat runs before tickSettlement, so an
  // uninitialised meter must read FULL, never 0
  delete home.garrFood;
  check('a missing rations meter reads full, not famished', S.settFedMeter(home) === 1);
  home.garrFood = gcap;
}

// Damage a besieger takes from a settlement's garrison over `ticks`, with
// BOTH the garrison's size and its rations pinned each tick, so the only
// variable left is the fed multiplier. The besieger is deliberately huge
// (and kept well-fed and in place) so it never dies inside the window —
// a dead attacker would saturate the measurement at its total HP.
function siegeReturnFire(frac, ticks) {
  const g = fresh();
  const home = g.settlements.find(s => s.owner === 0);
  home.stockpile = 0;
  // clear the field: the starting armies would brawl with the besieger and
  // add a constant to the measurement, hiding the multiplier being tested
  g.blobs.length = 0;
  const GARR = 6;
  const gcap = GARR * S.C.FOOD_PER_UNIT;
  const att = spawnBlob(g, 1, home.x + 1 + 1.6, home.y + 1, 60, 0);
  const hp0 = att.units.reduce((a, u) => a + u.hp, 0);
  for (let i = 0; i < ticks; i++) {
    home.garrison = { deploy: GARR, supply: 0, farm: 0 };
    home.garrLoss = 0;
    home.garrFood = frac * gcap;
    att.food = S.foodCap(att); // attacker stays well-fed: isolate the defender
    att.x = home.x + 1 + 1.6; att.y = home.y + 1;
    S.step(g);
    if (att.dead) break;
  }
  const hp1 = att.dead ? 0 : att.units.reduce((a, u) => a + u.hp, 0);
  return { taken: hp0 - hp1, died: !!att.dead };
}

{
  console.log('an emptied granary tapers the defence instead of halving it:');
  const full = siegeReturnFire(1.0, 60);
  const mid = siegeReturnFire(0.6, 60);
  const low = siegeReturnFire(0.3, 60);
  const none = siegeReturnFire(0.0, 60);
  check('measurement never saturated (no besieger died)',
    !full.died && !mid.died && !low.died && !none.died);
  check(`well-fed garrison hits hardest (${full.taken.toFixed(1)})`, full.taken > 0);
  // the inverse bug this change fixes: stockpile 0 with full bellies USED
  // to mean half strength; now it's the top tier
  check('full bellies + empty stockpile is NOT half strength',
    full.taken > none.taken * 2 - 1e-6,
    `full=${full.taken.toFixed(1)} none=${none.taken.toFixed(1)}`);
  check(`return fire steps down as rations drain (${full.taken.toFixed(1)} > ${mid.taken.toFixed(1)} > ${low.taken.toFixed(1)} > ${none.taken.toFixed(1)})`,
    full.taken > mid.taken && mid.taken > low.taken && low.taken > none.taken);
  check('the tiers match fedMult exactly (1.25 / 1.0 / 0.75 / 0.5)',
    Math.abs(full.taken / none.taken - 1.25 / 0.5) < 0.05
    && Math.abs(mid.taken / none.taken - 1.0 / 0.5) < 0.05
    && Math.abs(low.taken / none.taken - 0.75 / 0.5) < 0.05,
    `ratios ${(full.taken / none.taken).toFixed(3)} / ${(mid.taken / none.taken).toFixed(3)} / ${(low.taken / none.taken).toFixed(3)}`);
  check('a famished garrison still fights back (taper, not collapse)',
    none.taken > 0, `none=${none.taken.toFixed(1)}`);
}

{
  console.log('a well-supplied settlement defends exactly as before:');
  const g = fresh();
  const home = g.settlements.find(s => s.owner === 0);
  home.garrison = { deploy: 6, supply: 0, farm: 0 };
  home.stockpile = 400;
  const gcap = S.garrisonTotal(home) * S.C.FOOD_PER_UNIT;
  home.garrFood = gcap;
  const att = spawnBlob(g, 1, home.x + 1 + 1.6, home.y + 1, 8, 0);
  att.food = S.foodCap(att);
  let minMeter = 1;
  for (let i = 0; i < 300; i++) {
    att.x = home.x + 1 + 1.6; att.y = home.y + 1;
    S.step(g);
    if (S.garrisonTotal(home) <= 0) break;
    minMeter = Math.min(minMeter, S.settFedMeter(home));
  }
  check(`stocked garrison stays at the top tier through a siege (min meter ${minMeter.toFixed(2)})`,
    S.fedMult(minMeter) === 1.25, `minMeter=${minMeter}`);
}

// ---------------------------------------------------------------- 4b. walls fence pillaging out

{
  console.log('walls block pillaging past them:');
  const g = fresh();
  const { w: mw, h: mh } = g.map;
  // a fully clear 7×7 window (no mountains/farmland/territory) so the
  // only thing shaping the pillage disc is the wall we inject
  let c0 = null;
  outer: for (let y = 4; y < mh - 4; y++) {
    for (let x = 4; x < mw - 4; x++) {
      let clear = true;
      for (let dy = -3; dy <= 3 && clear; dy++) {
        for (let dx = -3; dx <= 3 && clear; dx++) {
          const i = (y + dy) * mw + (x + dx);
          if (g.map.mountain[i] || g.settAt[i] || g.tilledBy[i] || g.wallAt[i] || g.terr[i]) clear = false;
        }
      }
      if (clear) { c0 = { x, y }; break outer; }
    }
  }
  check('found a clear pillage field', !!c0);
  const b = spawnBlob(g, 0, c0.x + 0.5, c0.y + 0.5, 5, 0);
  S.opPillage(g, b, true);
  const before = new Set(S.pillageCells(g, b));
  check('far side harvestable with no wall', before.has(c0.y * mw + (c0.x + 2)));
  // seal the column just right of the camp across the whole disc window
  for (let dy = -3; dy <= 3; dy++) injectWall(g, 1, c0.x + 1, c0.y + dy);
  const sealed = new Set(S.pillageCells(g, b));
  check('tiles beyond the wall are fenced out', ![...sealed].some(i => (i % mw) > c0.x + 1));
  check('near-side tiles still harvestable', sealed.has(c0.y * mw + (c0.x - 1)));
  // breach: knock out the middle tile — the flood pours through the gap
  const mid = g.walls.find(x => x.owner === 1 && x.x === c0.x + 1 && x.y === c0.y);
  g.walls = g.walls.filter(x => x.id !== mid.id);
  g.wallAt[mid.y * mw + mid.x] = 0;
  const breached = new Set(S.pillageCells(g, b));
  check('breaching the wall reopens the far side', [...breached].some(i => (i % mw) > c0.x + 1));
}

// ---------------------------------------------------------------- 5b. garrison role switching

{
  console.log('wall garrison role switching:');
  const g = fresh();
  const spot = findClearPair(g);
  const w = injectWall(g, 0, spot.x, spot.y, { deploy: 0, supply: 4, farm: 0 });
  let r = S.opWallGarrisonRole(g, w.id, 'farm');
  check('instant switch to farm', !r.err && w.garrison.farm === 4 && w.garrison.supply === 0, JSON.stringify(w.garrison));
  r = S.opWallGarrisonRole(g, w.id, 'deploy');
  check('arming to deploy is pending, not instant', !r.err && !!w.convert && w.garrison.deploy === 0, JSON.stringify(w.convert));
  // the pending arm-up survives save/load and completes on schedule
  const d = S.serialize(g);
  const g2 = S.deserialize(JSON.parse(JSON.stringify(d)));
  const w2 = g2.walls.find(x => x.id === w.id);
  check('pending arm-up survives save/load', !!(w2 && w2.convert && w2.convert.role === 'deploy'));
  run(g2, S.C.CONVERT_TICKS + 5);
  check('arm-up completes after CONVERT_TICKS', w2.garrison.deploy === 4 && !w2.convert, JSON.stringify(w2.garrison));
  // fielding cancels a pending arm-up — the units march out unconverted
  S.opWallGarrisonRole(g, w.id, 'supply');
  S.opWallGarrisonRole(g, w.id, 'deploy');
  const rf = S.opFieldWall(g, w.id);
  check('fielding cancels the pending arm-up', !rf.err && w.convert == null && rf.blob.count.supply === 4,
    JSON.stringify(rf.blob && rf.blob.count));
}

// ---------------------------------------------------------------- 6. supply routes feed wall garrisons

{
  console.log('a supply route tops up a remote wall garrison:');
  const g = fresh();
  const home = g.settlements.find(s => s.owner === 0);
  home.stockpile = 400;
  // a wall well outside every settlement's territory, so only the
  // caravan can feed it
  let outSpot = null;
  const { w: mw, h: mh } = g.map;
  for (let y = 1; y < mh - 1 && !outSpot; y++) {
    for (let x = 1; x < mw - 1 && !outSpot; x++) {
      if (S.canPlaceWall(g, 0, x, y).err) continue;
      if (g.settlements.every(s => Math.hypot(s.x + 1 - x, s.y + 1 - y) > 12)) outSpot = { x, y };
    }
  }
  check('found a remote spot', !!outSpot);
  // draining bellies, empty stash — no territory feeding out here
  const w = injectWall(g, 0, outSpot.x, outSpot.y, { deploy: 2, supply: 0, farm: 0 },
    { garrFood: 10, stock: 0 });
  const carrier = spawnBlob(g, 0, home.x + 2.5, home.y + 0.5, 0, 5);
  const r = S.opRoute(g, carrier, { kind: 'wall', id: w.id }, home.id);
  check('opRoute accepts a wall target', !r.err, JSON.stringify(r));
  check('route registered with wall targetKind',
    g.routes.some(x => x.targetKind === 'wall' && x.targetId === w.id));
  let peak = w.stock, prevStock = w.stock, deliveredFar = false, sawFull = false;
  for (let t = 0; t < 2500; t++) {
    S.step(g);
    if (w.stock > prevStock + 1e-9) {
      // deliveries must land touching / next to the tile (dock range 1.5
      // from the tile center ⇒ on it or Chebyshev-adjacent)
      const c = g.blobs.find(x => x.id === carrier.id && !x.dead);
      if (c && Math.hypot(c.x - (w.x + 0.5), c.y - (w.y + 0.5)) > 1.55) deliveredFar = true;
    }
    prevStock = w.stock;
    peak = Math.max(peak, w.stock);
    // routeHealth must read the STASH as the fill target (#200)
    if (w.stock >= 0.95 * S.C.WALL_FOOD_CAP) {
      sawFull = true;
      const rt = g.routes.find(x => x.targetKind === 'wall' && x.targetId === w.id);
      if (rt) check.once = check.once || SUPHealthOk(g, rt);
    }
  }
  const gTot = w.garrison.deploy + w.garrison.supply + w.garrison.farm;
  check(`caravan filled the stash past the old garrison×10 cap (peak ${peak.toFixed(1)})`, peak > 40, `peak=${peak.toFixed(1)}`);
  check('deliveries only landed touching/next to the wall', !deliveredFar);
  check('a topped-off stash reads as a healthy line', !sawFull || check.once === true);
  check(`bellies stayed fed off the stash (${w.garrFood.toFixed(1)})`,
    w.garrFood > 0.25 * gTot * S.C.FOOD_PER_UNIT, `garrFood=${w.garrFood.toFixed(1)}`);
  check('garrison survived on caravan rations', gTot === 2, `left=${JSON.stringify(w.garrison)}`);
  check('route still alive', g.routes.some(x => x.targetKind === 'wall' && x.targetId === w.id));
  // destroying the wall dissolves the line instead of stranding carriers
  w.hp = 0;
  g.walls = g.walls.filter(x => x.id !== w.id);
  g.wallAt[outSpot.y * mw + outSpot.x] = 0;
  run(g, 5);
  check('route dissolves when the wall is gone', !g.routes.some(x => x.targetKind === 'wall'));
}

// ---------------------------------------------------------------- 7. save / load round-trip

{
  console.log('serialize → deserialize round-trips walls + in-flight orders:');
  const g = fresh();
  const spot = findClearPair(g);
  const b = spawnBlob(g, 0, spot.x - 2.5, spot.y + 0.5, 6, 0);
  S.opBuildWalls(g, b, [{ x: spot.x, y: spot.y }, { x: spot.x + 1, y: spot.y }]);
  injectWall(g, 1, spot.x, spot.y + 2, { deploy: 3, supply: 0, farm: 0 });
  run(g, 120); // mid-construction, mid-march
  const d1 = S.serialize(g);
  const g2 = S.deserialize(JSON.parse(JSON.stringify(d1)));
  const d2 = S.serialize(g2);
  check('walls survive the round-trip', JSON.stringify(d1.walls) === JSON.stringify(d2.walls));
  check('whole save is byte-identical', JSON.stringify(d1) === JSON.stringify(d2));
  check('wallAt rebuilt on load', g2.walls.every(w2 => g2.wallAt[w2.y * g2.map.w + w2.x] === w2.id));
  const b2 = g2.blobs.find(x => x.id === b.id);
  check('in-flight wall order survives', !!(b2 && b2.order && b2.order.type === 'wall'), b2 && JSON.stringify(b2.order));
  run(g2, 2000);
  check('resumed game finishes the walls', g2.walls.filter(w2 => w2.owner === 0 && !w2.building).length >= 2);

  // pre-#200 saves stored ONE flat larder in garrFood: it must split into
  // bellies + stash without losing a grain
  const old = JSON.parse(JSON.stringify(d1));
  old.walls = [{
    id: 90001, owner: 0, x: spot.x, y: spot.y + 4, hp: S.C.WALL_HP, building: false,
    garrison: { deploy: 2, supply: 0, farm: 0 }, garrFood: 100, convert: null,
  }];
  const g3 = S.deserialize(old);
  const mw3 = g3.walls.find(x => x.id === 90001);
  const cap3 = 2 * S.C.FOOD_PER_UNIT;
  check('migrated wall exists', !!mw3);
  check(`old larder fills bellies first (${mw3.garrFood} = ${cap3})`, mw3.garrFood === cap3);
  check(`the remainder becomes the stash (${mw3.stock} = ${100 - cap3})`, mw3.stock === 100 - cap3);
  check('migration loses no food', mw3.garrFood + mw3.stock === 100);
  check('a migrated fed wall reads well-fed, not famished',
    S.fedMult(S.wallFedMeter(mw3)) === 1.25);
  // a small old larder (under bellies capacity) stays entirely in bellies
  old.walls[0].garrFood = 6;
  const g4 = S.deserialize(old);
  const mw4 = g4.walls.find(x => x.id === 90001);
  check('a small old larder stays in bellies', mw4.garrFood === 6 && mw4.stock === 0);
}

// ---------------------------------- 9. disengage + garrison under fire (#201)

// A square of clear, un-owned, un-tilled ground with radius r — every
// placement and every path in the tests below stays inside it, so the
// geometry is exact instead of terrain-dependent.
function findOpenArea(game, r, minD) {
  const { w, h } = game.map;
  const away = minD == null ? 9 : minD;
  for (let y = r + 1; y < h - r - 1; y++) {
    for (let x = r + 1; x < w - r - 1; x++) {
      let ok = true;
      for (let dy = -r; dy <= r && ok; dy++) {
        for (let dx = -r; dx <= r && ok; dx++) {
          const i = (y + dy) * w + (x + dx);
          if (!passable(game.map, x + dx, y + dy)) ok = false;
          else if (game.settAt[i] || game.tilledBy[i] || game.wallAt[i]) ok = false;
        }
      }
      if (!ok) continue;
      if (game.settlements.every(s => Math.hypot(s.x + 1 - x, s.y + 1 - y) > away)) return { x, y };
    }
  }
  return null;
}

// The field cases need ~7 tiles of clear ground to march across, which
// the xsmall map never has — they run on `small` instead.
function freshField() {
  return S.newGame('withdraw-smoke-1', 'small', 'normal');
}

function hpOf(b) { return b.units.reduce((a, u) => a + u.hp, 0); }

{
  console.log('a group ordered to move while in melee actually withdraws (#201):');
  const g = freshField();
  const area = findOpenArea(g, 7);
  check('found an open test area', !!area);
  if (area) {
    // the reported case: our army is at an enemy settlement's walls AND
    // locked with an enemy army. The settlement contact only sets
    // engagedT; the BLOB contact refreshes meleeT every tick, which is
    // what used to swallow the retreat order.
    const foeSett = g.settlements.find(s => s.owner === 1);
    const mine = spawnBlob(g, 0, area.x + 0.5, area.y + 0.5, 10, 0);
    const foe = spawnBlob(g, 1, area.x + 1.5, area.y + 0.5, 6, 0);
    run(g, 2);
    check('the two armies are in melee', g.tick - mine.meleeT < 5,
      `meleeT=${mine.meleeT} tick=${g.tick}`);
    const dest = { x: area.x + 0.5, y: area.y - 5.5 }; // straight away from the foe
    const r = S.opMove(g, mine, dest.x, dest.y);
    check('the retreat order is accepted', !!r.ok, JSON.stringify(r));
    check('a move issued in melee is flagged as a disengagement',
      !!(mine.order && mine.order.disengage));
    const from = { x: mine.x, y: mine.y };
    run(g, 30);
    const moved = Math.hypot(mine.x - from.x, mine.y - from.y);
    check(`the army actually walks out (moved ${moved.toFixed(2)} tiles)`, moved > 1);
    check('it breaks contact with the enemy army',
      Math.hypot(mine.x - foe.x, mine.y - foe.y) > S.C.MELEE_RANGE + 0.2,
      `d=${Math.hypot(mine.x - foe.x, mine.y - foe.y).toFixed(2)}`);
    check('the enemy settlement is untouched by this test', !!foeSett && !foeSett.building);
  }
}

{
  console.log('an ordinary march intercepted en route still stands and fights (#74/#82):');
  const g = freshField();
  const area = findOpenArea(g, 7);
  if (area) {
    const mine = spawnBlob(g, 0, area.x + 0.5, area.y + 0.5, 10, 0);
    // order given BEFORE any contact — no disengage flag
    const r = S.opMove(g, mine, area.x + 0.5, area.y + 6.5);
    check('the march order is accepted', !!r.ok);
    check('a move issued out of melee is not a disengagement', !mine.order.disengage);
    spawnBlob(g, 1, area.x + 1.4, area.y + 0.5, 6, 0);
    const from = { x: mine.x, y: mine.y };
    run(g, 20);
    const moved = Math.hypot(mine.x - from.x, mine.y - from.y);
    check(`the intercepted march halts (moved only ${moved.toFixed(2)} tiles)`, moved < 0.4);
    check('the order is still held, not cancelled', !!mine.order);
  }
}

{
  console.log('the disengage exemption lapses once the group is clear (#201):');
  const g = freshField();
  const area = findOpenArea(g, 7);
  if (area) {
    const mine = spawnBlob(g, 0, area.x + 0.5, area.y + 0.5, 10, 0);
    const foe = spawnBlob(g, 1, area.x + 1.0, area.y + 0.5, 4, 0);
    run(g, 2);
    S.opMove(g, mine, area.x + 0.5, area.y - 6.5);
    check('flagged while in contact', !!mine.order.disengage);
    foe.dead = true; // the fight ends
    run(g, 30);
    check('the order survives (destination not reached yet)', !!mine.order);
    check('the flag is gone once clear of melee for ~2 s',
      !!mine.order && !mine.order.disengage);
  }
}

{
  console.log('withdrawing turns your back: pursuers land the rear bonus (#201):');
  // identical geometry twice — one victim stands its ground, one withdraws
  function trial(withdraw) {
    const g = freshField();
    const area = findOpenArea(g, 7);
    if (!area) return null;
    const v = spawnBlob(g, 0, area.x + 0.5, area.y + 0.5, 20, 0);
    const p = spawnBlob(g, 1, area.x - 0.5, area.y + 0.5, 3, 0);
    run(g, 1);
    S.opMove(g, p, v.x, v.y, { kind: 'blob', id: v.id }); // pursue
    if (withdraw) S.opMove(g, v, area.x + 6.5, area.y + 0.5); // run, back to the foe
    const before = hpOf(v);
    // sample the panel's rear-hit window (#201) mid-pursuit: rearT is the
    // per-victim mark of the same event that flags link.rear
    let rearFresh = false;
    for (let i = 0; i < 40; i++) {
      S.step(g);
      if (i === 20) rearFresh = g.tick - v.rearT < 5;
    }
    return { loss: before - hpOf(v), rearFresh };
  }
  const stood = trial(false);
  const ran = trial(true);
  check('both trials ran', stood != null && ran != null);
  if (stood != null && ran != null) {
    check(`a withdrawing group takes more damage (${ran.loss.toFixed(1)} vs ${stood.loss.toFixed(1)} HP)`,
      ran.loss > stood.loss * 1.1, `stand=${stood.loss.toFixed(2)} withdraw=${ran.loss.toFixed(2)}`);
    check('the withdrawer is marked rear-hit (rearT fresh mid-pursuit)', ran.rearFresh);
    check('the standing victim is never marked rear-hit (lone frontal attacker)', !stood.rearFresh);
  }
}

{
  console.log('reinforcements can garrison a wall that is under attack (#201):');
  const g = freshField();
  const area = findOpenArea(g, 6);
  if (area) {
    const w = injectWall(g, 0, area.x, area.y, { deploy: 1, supply: 0, farm: 0 });
    // an attacker standing beside the wall: Chebyshev 1, so it batters the
    // tile AND comes into melee with anything walking onto it
    spawnBlob(g, 1, area.x + 1.5, area.y + 0.5, 4, 0);
    const mine = spawnBlob(g, 0, area.x - 2.5, area.y + 0.5, 6, 0);
    const before = S.wallGarrisonTotal(w);
    const r = S.opMove(g, mine, area.x + 0.5, area.y + 0.5);
    check('the garrison order is accepted', !!r.ok, JSON.stringify(r));
    check('a move onto an own wall is flagged as a garrison push',
      !!(mine.order && mine.order.garrison));
    run(g, 60);
    check(`the reinforcements got in (${before} → ${S.wallGarrisonTotal(w)})`,
      S.wallGarrisonTotal(w) > before);
    check('the wall still stands', g.walls.some(x => x.id === w.id));
  }
}

{
  console.log('a full wall says so instead of swallowing the order (#201):');
  const g = freshField();
  const area = findOpenArea(g, 6);
  if (area) {
    const w = injectWall(g, 0, area.x, area.y,
      { deploy: S.C.WALL_GARRISON_CAP, supply: 0, farm: 0 });
    const mine = spawnBlob(g, 0, area.x - 2.5, area.y + 0.5, 3, 0);
    S.opMove(g, mine, area.x + 0.5, area.y + 0.5);
    run(g, 60);
    check('the garrison stays at the cap',
      S.wallGarrisonTotal(w) === S.C.WALL_GARRISON_CAP);
    check('the arrivals are still alive outside', !mine.dead && S.total(mine) === 3);
    const full = g.events.filter(e => e.msg.includes('Wall garrison is full'));
    check(`exactly one "garrison is full" notice (got ${full.length})`, full.length === 1);
  }
}

{
  console.log('reinforcements can march into a besieged settlement (#201):');
  const g = freshField();
  const home = g.settlements.find(s => s.owner === 0);
  const c = { x: home.x + 1, y: home.y + 1 };
  // a besieger at the walls, and our relief column behind it on the same side
  spawnBlob(g, 1, c.x + 2.2, c.y, 5, 0);
  const relief = spawnBlob(g, 0, c.x + 4.0, c.y, 6, 0);
  const before = S.garrisonTotal(home);
  check('the settlement is besieged', S.besieged(g, home));
  const r = S.opMove(g, relief, c.x, c.y);
  check('the relief order is accepted', !!r.ok, JSON.stringify(r));
  check('a move onto an own settlement is a garrison push', !!relief.order.garrison);
  run(g, 150);
  check(`the relief column reached the garrison (${before} → ${S.garrisonTotal(home)})`,
    S.garrisonTotal(home) > before);
}

{
  console.log('the new order flags survive a save/load round-trip (#201):');
  const g = freshField();
  const area = findOpenArea(g, 7);
  const home = g.settlements.find(s => s.owner === 0);
  if (area) {
    const a = spawnBlob(g, 0, area.x + 0.5, area.y + 0.5, 8, 0);
    spawnBlob(g, 1, area.x + 1.0, area.y + 0.5, 4, 0);
    run(g, 2);
    S.opMove(g, a, area.x + 0.5, area.y - 5.5);
    const b = spawnBlob(g, 0, home.x + 4, home.y + 1, 4, 0);
    S.opMove(g, b, home.x + 1, home.y + 1);
    check('set up: disengage + garrison orders', !!a.order.disengage && !!b.order.garrison);
    const g2 = S.deserialize(JSON.parse(JSON.stringify(S.serialize(g))));
    const a2 = g2.blobs.find(x => x.id === a.id);
    const b2 = g2.blobs.find(x => x.id === b.id);
    check('the disengage flag survives', !!(a2 && a2.order && a2.order.disengage));
    check('the garrison flag survives', !!(b2 && b2.order && b2.order.garrison));
  }
}

// ---------------------------------------------------------------- 9. wall self-repair (#217)

{
  console.log('damaged walls knit back together out of combat (#217):');
  const g = fresh();
  const spot = findClearPair(g);
  // a manned tile and a bare one, both battered to half, both left alone
  const manned = injectWall(g, 0, spot.x, spot.y, { deploy: 3, supply: 0, farm: 0 },
    { stock: S.C.WALL_FOOD_CAP });
  const bare = injectWall(g, 0, spot.x + 2, spot.y, null);
  manned.hp = 50; bare.hp = 50;
  manned.lastHitT = -999; bare.lastHitT = -999;
  const TICKS = 200;
  run(g, TICKS);
  const dManned = manned.hp - 50, dBare = bare.hp - 50;
  check(`a manned wall repairs at ≈WALL_REGEN/tick (+${dManned.toFixed(2)} over ${TICKS})`,
    Math.abs(dManned - S.C.WALL_REGEN * TICKS) < 0.5, `got ${dManned}`);
  check(`an abandoned wall keeps the old crawl (+${dBare.toFixed(2)})`,
    Math.abs(dBare - S.C.WALL_REGEN_BARE * TICKS) < 0.5, `got ${dBare}`);
  check('the protected rate is materially faster than the bare one', dManned > dBare * 4,
    `manned=${dManned} bare=${dBare}`);
  check('repair never overshoots WALL_HP', manned.hp <= S.C.WALL_HP && bare.hp <= S.C.WALL_HP);
}

{
  console.log('a wall under attack does not repair (#217):');
  const g = fresh();
  const spot = findClearPair(g);
  const w = injectWall(g, 0, spot.x, spot.y, { deploy: 4, supply: 0, farm: 0 },
    { stock: S.C.WALL_FOOD_CAP });
  w.hp = 40;
  // an enemy war party parked Chebyshev-adjacent refreshes lastHitT every tick
  const foe = spawnBlob(g, 1, spot.x - 0.5, spot.y + 0.5, 6, 0);
  let peak = w.hp;
  for (let t = 0; t < 150; t++) {
    foe.x = spot.x - 0.5; foe.y = spot.y + 0.5; // hold contact
    foe.food = S.foodCap(foe);
    S.step(g);
    if (!g.walls.some(x => x.id === w.id)) break;
    peak = Math.max(peak, w.hp);
  }
  check(`structure HP never climbed while in contact (peak ${peak.toFixed(2)} ≤ 40)`,
    peak <= 40.0001, `peak=${peak}`);
}

// ---------------------------------------------------------------- 10. caravan fragility (#213)

{
  console.log('supply caravans die faster than the same headcount of soldiers (#213):');
  check(`a supply unit's max HP is UNIT_HP_SUPPLY (${S.C.UNIT_HP_SUPPLY})`,
    S.unitMaxHP('supply') === S.C.UNIT_HP_SUPPLY);
  check('a soldier is still UNIT_HP and a farmer UNIT_HP_FARM',
    S.unitMaxHP('deploy') === S.C.UNIT_HP && S.unitMaxHP('farm') === S.C.UNIT_HP_FARM);

  // one victim of each kind, each pinned in contact with an identical raiding
  // party, so the only variable is the victim's own toughness
  function ticksToDie(supplyN, deployN) {
    const g = freshField();
    const area = findOpenArea(g, 7);
    if (!area) return null;
    g.blobs.length = 0;
    const victim = spawnBlob(g, 0, area.x + 0.5, area.y + 0.5, deployN, supplyN);
    const raider = spawnBlob(g, 1, area.x + 1.4, area.y + 0.5, 6, 0);
    for (let t = 1; t <= 3000; t++) {
      raider.x = area.x + 1.4; raider.y = area.y + 0.5;
      raider.food = S.foodCap(raider);
      victim.x = area.x + 0.5; victim.y = area.y + 0.5;
      S.step(g);
      if (victim.dead) return t;
    }
    return Infinity;
  }
  const tCaravan = ticksToDie(4, 0);
  const tSoldiers = ticksToDie(0, 4);
  if (tCaravan != null && tSoldiers != null) {
    // 4 carriers = 160 HP vs 4 fighters = 400 HP against the same damage rate
    const ratio = tSoldiers / tCaravan;
    check(`a 4-unit caravan dies ~2.5× faster than 4 soldiers (${tCaravan} vs ${tSoldiers} ticks)`,
      ratio > 2.0 && ratio < 3.2, `ratio=${ratio.toFixed(2)}`);
    check(`the caravan is gone inside ~15 s of 1× play (${S.gameSeconds(tCaravan).toFixed(1)} s)`,
      S.gameSeconds(tCaravan) < 15, `${S.gameSeconds(tCaravan)}s`);
  }

  // blobHealth reads against the role max, so a fresh caravan is still 100 %
  const g2 = fresh();
  const spot2 = findClearPair(g2);
  const car = spawnBlob(g2, 0, spot2.x - 3.5, spot2.y + 0.5, 0, 3);
  check('a fresh caravan reads full health', Math.abs(S.blobHealth(car) - 1) < 1e-9,
    `health=${S.blobHealth(car)}`);
  check('arming a wounded carrier keeps its wound fraction', (() => {
    car.units[0].hp = S.C.UNIT_HP_SUPPLY / 2;
    const frac = S.blobHealth(car);
    S.opSetRole(g2, car, 'deploy');
    run(g2, S.C.CONVERT_TICKS + 2);
    return car.count.deploy === 3 && Math.abs(S.blobHealth(car) - frac) < 1e-6;
  })(), `health=${S.blobHealth(car)}`);
}

{
  console.log('old saves with 100-HP supply units are clamped on load (#213):');
  const g = fresh();
  const spot = findClearPair(g);
  const b = spawnBlob(g, 0, spot.x - 3.5, spot.y + 0.5, 0, 2);
  const data = JSON.parse(JSON.stringify(S.serialize(g)));
  const bd = data.blobs.find(x => x.id === b.id);
  for (const u of bd.units) u.hp = 100; // pre-#213 save
  const g2 = S.deserialize(data);
  const b2 = g2.blobs.find(x => x.id === b.id);
  check('supply HP is clamped to the new role max',
    b2.units.every(u => u.hp <= S.C.UNIT_HP_SUPPLY), JSON.stringify(b2.units.map(u => u.hp)));
  check('so a migrated caravan reads exactly full, never over',
    Math.abs(S.blobHealth(b2) - 1) < 1e-9, `health=${S.blobHealth(b2)}`);
}

// ---------------------------------------------------------------- 11. arm-up survival (#215)

{
  console.log('a pending arm-up survives an auto-merge (#215):');
  const g = freshField();
  const area = findOpenArea(g, 7);
  if (area) {
    g.blobs.length = 0;
    const a = spawnBlob(g, 0, area.x + 0.5, area.y + 0.5, 0, 6);   // the arming half
    const b = spawnBlob(g, 0, area.x + 0.9, area.y + 0.5, 0, 2);   // idle, not arming
    check('arm order accepted', !!S.opSetRole(g, a, 'deploy').ok);
    const done = a.convert.done;
    run(g, 10); // tickMerge runs every 5 ticks
    const survivor = g.blobs.find(x => !x.dead && x.owner === 0);
    check('the two groups merged', g.blobs.filter(x => !x.dead && x.owner === 0).length === 1);
    check('the survivor is still arming', !!(survivor && survivor.convert),
      JSON.stringify(survivor && survivor.convert));
    check('on the original countdown', !!survivor.convert && survivor.convert.done === done,
      `${survivor.convert && survivor.convert.done} vs ${done}`);
    run(g, S.C.CONVERT_TICKS + 5);
    check('and the whole merged group ends up armed',
      survivor.count.deploy === S.total(survivor), JSON.stringify(survivor.count));
  }
}

{
  console.log('a pending arm-up survives a split (#215):');
  const g = fresh();
  const spot = findClearPair(g);
  const b = spawnBlob(g, 0, spot.x - 3.5, spot.y + 0.5, 0, 6);
  S.opSetRole(g, b, 'deploy');
  const done = b.convert.done;
  const r = S.opSplit(g, b, 3);
  check('split accepted', !!r.ok, JSON.stringify(r));
  check('the parent is still arming', !!b.convert && b.convert.done === done);
  check('the new half is arming too', !!(r.blob && r.blob.convert && r.blob.convert.done === done),
    JSON.stringify(r.blob && r.blob.convert));
  check('each half has its OWN record (not a shared reference)', b.convert !== r.blob.convert);
  run(g, S.C.CONVERT_TICKS + 5);
  check('both halves finish armed',
    b.count.deploy === S.total(b) && r.blob.count.deploy === S.total(r.blob),
    `${JSON.stringify(b.count)} / ${JSON.stringify(r.blob.count)}`);
}

{
  console.log('a pending arm-up carries into a wall garrison (#215):');
  const g = fresh();
  const spot = findClearPair(g);
  const w = injectWall(g, 0, spot.x, spot.y, null, { stock: S.C.WALL_FOOD_CAP });
  // stand on the neighbouring clear tile findClearPair guarantees, so the
  // march is one tile and the group ARRIVES while still arming
  const b = spawnBlob(g, 0, spot.x + 1.5, spot.y + 0.5, 0, 3);
  S.opSetRole(g, b, 'deploy');
  const done = b.convert.done;
  S.opMove(g, b, spot.x + 0.5, spot.y + 0.5);
  run(g, 40); // well inside CONVERT_TICKS (100)
  check('the group garrisoned the wall', S.wallGarrisonTotal(w) === 3,
    JSON.stringify(w.garrison));
  check('the wall garrison picked up the arm-up', !!(w.convert && w.convert.role === 'deploy'),
    JSON.stringify(w.convert));
  check('on the original countdown', !!w.convert && w.convert.done === done,
    `${w.convert && w.convert.done} vs ${done}`);
  run(g, S.C.CONVERT_TICKS + 5);
  check('and the wall garrison ends up armed', w.garrison.deploy === 3, JSON.stringify(w.garrison));
  // fielding a garrison still cancels an arm-up — that's documented in the UI
  S.opWallGarrisonRole(g, w.id, 'deploy');
  check('an already-armed garrison takes no pointless arm-up', !w.convert);
}

{
  console.log('a pending arm-up carries into a settlement garrison (#215):');
  const g = freshField();
  const home = g.settlements.find(s => s.owner === 0);
  const b = spawnBlob(g, 0, home.x + 4, home.y + 1, 0, 3);
  S.opSetRole(g, b, 'deploy');
  const done = b.convert.done;
  S.opMove(g, b, home.x + 1, home.y + 1);
  run(g, 40); // arrives WHILE still arming (CONVERT_TICKS is 100)
  check('the group garrisoned the town', b.dead, `dead=${b.dead}`);
  check('the town garrison picked up the arm-up', !!(home.convert && home.convert.role === 'deploy'),
    JSON.stringify(home.convert));
  check('on the original countdown', !!home.convert && home.convert.done === done,
    `${home.convert && home.convert.done} vs ${done}`);
  run(g, S.C.CONVERT_TICKS + 5);
  check('the garrison finished arming', home.garrison.deploy === S.garrisonTotal(home),
    JSON.stringify(home.garrison));
  // and fielding still cancels, as the panel promises
  home.convert = { role: 'deploy', done: g.tick + S.C.CONVERT_TICKS };
  S.opFieldGarrison(g, home);
  check('fielding still cancels a garrison arm-up', !home.convert);
}

// ---------------------------------------------------------------- 12. recruit rations (#210)

{
  console.log('newly trained units arrive with rations, not famished (#210):');
  const g = freshField();
  const home = g.settlements.find(s => s.owner === 0);
  g.blobs.length = 0;                     // no field armies eating the stores
  home.garrison = { deploy: 0, supply: 0, farm: 0 };
  home.garrFood = 0;
  home.stockpile = S.C.STOCK_CAP;
  S.opSetMode(g, home, 'deploy');
  let trained = 0;
  for (let t = 0; t < 4000 && trained < 1; t++) {
    S.step(g);
    trained = S.garrisonTotal(home);
  }
  check('the town trained a unit', trained >= 1, `garrison=${trained}`);
  check(`the recruit's rations read Well-fed (${S.fedLabel(S.settFedMeter(home))})`,
    S.fedLabel(S.settFedMeter(home)) === 'Well-fed',
    `meter=${S.settFedMeter(home).toFixed(3)}`);
  const r = S.opFieldRole(g, home, 'deploy', 1);
  check('fielding it works', !!r.ok, JSON.stringify(r));
  check(`the fielded unit marches out Well-fed (${r.blob && S.fedLabel(S.fedMeter(r.blob))})`,
    !!r.blob && S.fedLabel(S.fedMeter(r.blob)) === 'Well-fed',
    r.blob && `meter=${S.fedMeter(r.blob).toFixed(3)}`);
  check('and at full combat strength', !!r.blob && S.fedMult(S.fedMeter(r.blob)) === 1.25,
    r.blob && `mult=${S.fedMult(S.fedMeter(r.blob))}`);
}

{
  console.log('an empty granary still honestly trains a hungry recruit (#210):');
  const g = freshField();
  const home = g.settlements.find(s => s.owner === 0);
  g.blobs.length = 0;
  home.garrison = { deploy: 0, supply: 0, farm: 0 };
  home.garrFood = 0;
  home.trainAcc = S.C.TRAIN_COST;  // paid for, but nothing banked for rations
  home.stockpile = 0;
  S.opSetMode(g, home, 'deploy');
  const before = S.garrisonTotal(home);
  run(g, 1);
  check('training is never blocked by missing rations', S.garrisonTotal(home) >= before,
    `${before} → ${S.garrisonTotal(home)}`);
  check('the stockpile never goes negative', home.stockpile >= -1e-9, `stockpile=${home.stockpile}`);
}

// ---------------------------------------- 13. walls over own farmland (#219)

// Farmland is just `tilledBy` — no separate tile type — so every case
// below is really about when a plot leaves (and rejoins) its
// settlement's `tilled` list, which is the only thing farmYield reads.

function freshFarm() {
  return S.newGame('walls-farm-219', 'small', 'normal');
}

// The settlement's own plot furthest from its keep that a wall may stand
// on: far out so the builder never brawls with the settlement, and
// fertile so losing it has to move the income.
function farmPlot(game, s) {
  const mw = game.map.w;
  let best = null, bd = -1;
  for (const i of [...s.tilled].sort((a, b) => a - b)) {
    const x = i % mw, y = (i / mw) | 0;
    if (game.map.fert[i] <= 0) continue;
    const r = S.canPlaceWall(game, s.owner, x, y);
    if (!r.ok || !r.farm) continue;
    const d = Math.hypot(x + 0.5 - (s.x + 1), y + 0.5 - (s.y + 1));
    if (d > bd) { bd = d; best = { x, y, i }; }
  }
  return best;
}

// A tile a builder can stand on to work `p`, never `p` itself.
function builderTile(game, p) {
  const mw = game.map.w;
  for (const dy of [0, -1, 1]) {
    for (const dx of [0, -1, 1]) {
      if (!dx && !dy) continue;
      const x = p.x + dx, y = p.y + dy, i = y * mw + x;
      if (!passable(game.map, x, y) || game.settAt[i] || game.wallAt[i]) continue;
      return { x: x + 0.5, y: y + 0.5 };
    }
  }
  return null;
}

{
  console.log('own farmland is buildable, the enemy\'s is not:');
  const g = freshFarm();
  const home = g.settlements.find(s => s.owner === 0 && !s.building);
  const foeHome = g.settlements.find(s => s.owner === 1 && !s.building);
  const p = farmPlot(g, home);
  const fp = farmPlot(g, foeHome);
  check('found an own plot and an enemy plot', !!p && !!fp);
  if (p && fp) {
    const mine = S.canPlaceWall(g, 0, p.x, p.y);
    check('a wall may go on your own plot', !!mine.ok && !mine.err, JSON.stringify(mine));
    check('the answer flags the plot it would cost',
      mine.farm === true && mine.plot === home.id, JSON.stringify(mine));
    const theirs = S.canPlaceWall(g, 0, fp.x, fp.y);
    check('enemy farmland is refused by name', theirs.err === 'Enemy farmland', JSON.stringify(theirs));
    check('and refused symmetrically', S.canPlaceWall(g, 1, p.x, p.y).err === 'Enemy farmland');
    const foeOwn = S.canPlaceWall(g, 1, fp.x, fp.y);
    check('each side may take its own', !!foeOwn.ok && foeOwn.farm === true, JSON.stringify(foeOwn));
    // plain ground stays plain green — no cost flag
    const clear = findClearPair(g);
    check('free ground carries no plot flag',
      S.canPlaceWall(g, 0, clear.x, clear.y).farm === undefined);
  }
}

{
  console.log('staking the site ploughs the plot under:');
  const g = freshFarm();
  g.blobs.length = 0;
  const home = g.settlements.find(s => s.owner === 0 && !s.building);
  const p = farmPlot(g, home);
  const stand = p && builderTile(g, p);
  check('found a plot and a builder tile', !!p && !!stand);
  if (p && stand) {
    const plotsBefore = home.tilled.length;
    const baseBefore = S.farmYield(g, home).base;
    const b = spawnBlob(g, 0, stand.x, stand.y, 4, 0);
    const r = S.opBuildWalls(g, b, [{ x: p.x, y: p.y }]);
    check('the order is accepted', !!r.ok && r.queued === 1, JSON.stringify(r));
    run(g, 1);
    check('a site was staked out', !!g.wallAt[p.i]);
    check('the site is still a scaffold', g.walls.some(w => w.x === p.x && w.y === p.y && w.building));
    check('the tile is no longer farmland', g.tilledBy[p.i] === 0);
    check('the plot left the settlement', !home.tilled.includes(p.i) && home.tilled.length === plotsBefore - 1);
    const baseAfter = S.farmYield(g, home).base;
    check(`income falls by exactly that plot (${baseBefore.toFixed(5)} → ${baseAfter.toFixed(5)})`,
      Math.abs(baseBefore - baseAfter - g.map.fert[p.i] * S.C.FARM_PER_FARMER * S.C.FARM_BASE_FARMERS) < 1e-9);
    check('income really is lower', baseAfter < baseBefore);
    // raising a wall never damages the soil — only tearing one out does
    check('the ground keeps its natural fertility', g.map.fert[p.i] === g.map.orig[p.i]);
    check('the tile is not scorched by construction', !g.pillaged.has(p.i));
    check('the lost tile is queued for a repaint', g.dirty.has(p.i));
    run(g, 600);
    check('the wall finishes', g.walls.some(w => w.x === p.x && w.y === p.y && !w.building));
    check('the plot stays lost under masonry', g.tilledBy[p.i] === 0 && !home.tilled.includes(p.i));
    check('previewFields never grants a walled tile',
      !S.previewFields(g, home.x, home.y, 0).includes(p.i));
  }
}

{
  console.log('the field hand standing on the site is re-plotted:');
  const g = freshFarm();
  g.blobs.length = 0;
  const home = g.settlements.find(s => s.owner === 0 && !s.building);
  const p = farmPlot(g, home);
  const stand = p && builderTile(g, p);
  check('found a plot and a builder tile', !!p && !!stand);
  if (p && stand && home.tilled.length > 1) {
    const farmer = spawnBlob(g, 0, p.x + 0.5, p.y + 0.5, 0, 1);
    farmer.working = home.id;
    farmer.noMerge = true;
    farmer.food = 100;
    run(g, 1);
    check('the farmer works the doomed plot', S.farmYield(g, home).workedCells === 1,
      JSON.stringify(S.farmYield(g, home)));
    const b = spawnBlob(g, 0, stand.x, stand.y, 4, 0);
    b.noMerge = true;
    S.opBuildWalls(g, b, [{ x: p.x, y: p.y }]);
    run(g, 1);
    check('the site was staked', !!g.wallAt[p.i]);
    check('the displaced farmer is walking to another plot',
      !!(farmer.order && farmer.order.type === 'move'), JSON.stringify(farmer.order));
    if (farmer.order) {
      const dest = Math.floor(farmer.order.y) * g.map.w + Math.floor(farmer.order.x);
      check('the destination is a surviving plot of the same settlement',
        dest !== p.i && home.tilled.includes(dest), `dest=${dest} plot=${p.i}`);
    }
    check('it still works for the settlement', farmer.working === home.id);
    run(g, 200);
    const here = Math.floor(farmer.y) * g.map.w + Math.floor(farmer.x);
    check('it arrived and is earning again',
      !farmer.dead && home.tilled.includes(here) && S.farmYield(g, home).workedCells >= 1,
      `here=${here} yield=${JSON.stringify(S.farmYield(g, home))}`);
  }
}

{
  console.log('a wall that falls hands the plot back scorched:');
  const g = freshFarm();
  g.blobs.length = 0;
  const home = g.settlements.find(s => s.owner === 0 && !s.building);
  const p = farmPlot(g, home);
  check('found a plot', !!p);
  if (p) {
    const plotsBefore = [...home.tilled].sort((a, b) => a - b);
    const baseBefore = S.farmYield(g, home).base;
    const origBefore = g.map.orig[p.i];
    const worthBefore = S.farmYield(g, home).worthwhileCells;
    const share = origBefore * S.C.FARM_PER_FARMER * S.C.FARM_BASE_FARMERS;
    const w = S.spawnFinishedWall(g, 0, p.x, p.y, { deploy: 0, supply: 0, farm: 0 });
    check('the finished wall took the plot too', !!w && g.tilledBy[p.i] === 0 && !home.tilled.includes(p.i));
    // an unmanned wall on its last legs: one adjacent attacker ends it
    w.hp = 0.5;
    spawnBlob(g, 1, p.x + 1.5, p.y + 0.5, 3, 0);
    run(g, 30);
    check('the wall was destroyed', !g.walls.some(x => x.id === w.id) && g.wallAt[p.i] === 0);
    check('the tile is tilled again', g.tilledBy[p.i] === home.id && home.tilled.includes(p.i));
    check('the field ring is exactly as it was',
      JSON.stringify([...home.tilled].sort((a, b) => a - b)) === JSON.stringify(plotsBefore));
    // ...but scorched: lowest tier, earning ~nothing (#219). The regen tick
    // has already nudged it a hair off zero by now — that's the point of
    // the mechanism — so the assertion is on the TIER, and on being under
    // the floor below which pillaging itself refuses to harvest.
    check('the reclaimed tile is stripped to the lowest tier',
      fertTier(g.map.fert[p.i]) === 0 && g.map.fert[p.i] < S.C.FERT_LEVEL / 2,
      `fert=${g.map.fert[p.i]}`);
    check('its original fertility is remembered', g.map.orig[p.i] === origBefore);
    check('it is registered as scorched land', g.pillaged.has(p.i));
    check('the burnt tile is queued for a repaint', g.dirty.has(p.i));
    const baseAfter = S.farmYield(g, home).base;
    check(`income is NOT restored — the plot earns nothing (${baseBefore.toFixed(5)} → ${baseAfter.toFixed(5)})`,
      Math.abs(baseAfter - (baseBefore - share)) < 1e-4 && baseAfter < baseBefore,
      `expected ≈ ${(baseBefore - share).toFixed(5)}`);
    check('the barren plot is below the break-even fertility',
      g.map.fert[p.i] < S.FERT_WORTHWHILE, `${g.map.fert[p.i]} vs ${S.FERT_WORTHWHILE}`);
    check('so it no longer counts as a worthwhile plot to man',
      S.farmYield(g, home).worthwhileCells === worthBefore - 1,
      `${worthBefore} → ${S.farmYield(g, home).worthwhileCells}`);
    check('the ring still counts the plot even though it pays nothing',
      home.tilled.length === plotsBefore.length);
    // a farmer standing on the barren plot adds exactly nothing
    g.blobs.length = 0;
    const hand = spawnBlob(g, 0, p.x + 0.5, p.y + 0.5, 0, 1);
    hand.working = home.id;
    hand.food = 100;
    const y2 = S.farmYield(g, home);
    const wasWorth = origBefore * S.C.FARM_PER_CELL; // what the plot used to pay
    check('a farmer on the barren plot earns ~nothing (under 2% of the old plot)',
      y2.workedCells === 1 && y2.farmers < wasWorth * 0.02,
      `${y2.farmers} vs ${wasWorth}`);
  }
}

{
  console.log('scorched farmland heals back through the regen tick:');
  const g = freshFarm();
  g.blobs.length = 0;
  const home = g.settlements.find(s => s.owner === 0 && !s.building);
  const p = farmPlot(g, home);
  check('found a plot', !!p);
  if (p) {
    const orig = g.map.orig[p.i];
    const baseBefore = S.farmYield(g, home).base;
    const w = S.spawnFinishedWall(g, 0, p.x, p.y, { deploy: 0, supply: 0, farm: 0 });
    w.hp = 0.5;
    const foe = spawnBlob(g, 1, p.x + 1.5, p.y + 0.5, 3, 0);
    run(g, 30);
    check('the plot came back scorched', g.tilledBy[p.i] === home.id && fertTier(g.map.fert[p.i]) === 0);
    foe.dead = true; // clear the field so the farmer can work in peace
    g.blobs.length = 0;
    // worked recovery (#110): FERT_REGEN_WORKED restores a full level per
    // 225 ticks, so a stripped plot is whole again in ~4 levels' worth
    const hand = spawnBlob(g, 0, p.x + 0.5, p.y + 0.5, 0, 1);
    hand.working = home.id;
    hand.food = 1e6;
    let last = g.map.fert[p.i];
    let monotone = true;
    const budget = Math.ceil(orig / S.C.FERT_REGEN_WORKED) + 40;
    for (let t = 0; t < budget; t++) {
      S.step(g);
      const f = g.map.fert[p.i];
      if (f < last - 1e-12) monotone = false;
      last = f;
      if (f >= orig - 0.0001) break;
    }
    check('a worked plot recovers monotonically', monotone);
    check(`a worked plot is whole again within ${budget} ticks (${last.toFixed(3)} of ${orig.toFixed(3)})`,
      last >= orig - 0.0001, `fert=${last}`);
    check('a healed tile stops being scorched', !g.pillaged.has(p.i));
    check('income is back to its pre-wall value',
      Math.abs(S.farmYield(g, home).base - baseBefore) < 1e-9,
      `${baseBefore} → ${S.farmYield(g, home).base}`);
  }
}

{
  console.log('fallow scorched land crawls back far slower than a worked plot:');
  const g = freshFarm();
  g.blobs.length = 0;
  const home = g.settlements.find(s => s.owner === 0 && !s.building);
  const p = farmPlot(g, home);
  check('found a plot', !!p);
  if (p) {
    const orig = g.map.orig[p.i];
    const w = S.spawnFinishedWall(g, 0, p.x, p.y, { deploy: 0, supply: 0, farm: 0 });
    w.hp = 0.5;
    const foe = spawnBlob(g, 1, p.x + 1.5, p.y + 0.5, 3, 0);
    run(g, 30);
    check('the plot came back scorched', fertTier(g.map.fert[p.i]) === 0 && g.pillaged.has(p.i));
    foe.dead = true;
    g.blobs.length = 0; // nobody farms it
    run(g, 600);
    const f = g.map.fert[p.i];
    check('fallow land does creep back', f > 0, `fert=${f}`);
    check(`but is nowhere near whole (${f.toFixed(4)} of ${orig.toFixed(3)})`, f < orig * 0.25, `fert=${f}`);
    check('and is still scorched', g.pillaged.has(p.i));
    // the worked rate is an order of magnitude faster (#110)
    check('the worked rate far outpaces the fallow one',
      S.C.FERT_REGEN_WORKED > S.C.FERT_REGEN * 20);
  }
}

{
  console.log('a wall razed on naturally barren ground is not marked scorched:');
  const g = freshFarm();
  g.blobs.length = 0;
  const home = g.settlements.find(s => s.owner === 0 && !s.building);
  const p = farmPlot(g, home);
  check('found a plot', !!p);
  if (p) {
    // force the tile's ORIGINAL fertility to nothing: there is no wound to
    // heal, so the tile must stay out of `pillaged` or the live set and a
    // reloaded one would disagree and the save would stop being stable
    g.map.fert[p.i] = 0;
    g.map.orig[p.i] = 0;
    const w = S.spawnFinishedWall(g, 0, p.x, p.y, { deploy: 0, supply: 0, farm: 0 });
    w.hp = 0.5;
    spawnBlob(g, 1, p.x + 1.5, p.y + 0.5, 3, 0);
    run(g, 30);
    check('the wall was destroyed', !g.walls.some(x => x.id === w.id));
    check('the tile is tilled again', g.tilledBy[p.i] === home.id);
    check('nothing was scorched', !g.pillaged.has(p.i));
    const d1 = S.serialize(g);
    const g2 = S.deserialize(JSON.parse(JSON.stringify(d1)));
    check('the save is byte-identical', JSON.stringify(d1) === JSON.stringify(S.serialize(g2)));
    check('the reload agrees the tile is not scorched', !g2.pillaged.has(p.i));
  }
}

{
  console.log('save / load agrees about a plot a wall took:');
  const g = freshFarm();
  g.blobs.length = 0;
  const home = g.settlements.find(s => s.owner === 0 && !s.building);
  const p = farmPlot(g, home);
  const stand = p && builderTile(g, p);
  check('found a plot and a builder tile', !!p && !!stand);
  if (p && stand) {
    const b = spawnBlob(g, 0, stand.x, stand.y, 4, 0);
    S.opBuildWalls(g, b, [{ x: p.x, y: p.y }]);
    // the load-bearing case: a save taken MID-construction. deserialize
    // loads walls before it re-tills, so the plot must already be gone.
    run(g, 3);
    check('mid-construction scaffold exists', g.walls.some(w => w.x === p.x && w.y === p.y && w.building));
    function parity(tag, walled) {
      const d1 = S.serialize(g);
      const g2 = S.deserialize(JSON.parse(JSON.stringify(d1)));
      const home2 = g2.settlements.find(s => s.id === home.id);
      check(`${tag}: save is byte-identical`, JSON.stringify(d1) === JSON.stringify(S.serialize(g2)));
      check(`${tag}: tilledBy agrees`, g2.tilledBy[p.i] === g.tilledBy[p.i],
        `${g.tilledBy[p.i]} vs ${g2.tilledBy[p.i]}`);
      check(`${tag}: the tile is ${walled ? 'untilled' : 'tilled'} on both sides`,
        walled ? (g.tilledBy[p.i] === 0 && g2.tilledBy[p.i] === 0)
          : (g.tilledBy[p.i] === home.id && g2.tilledBy[p.i] === home.id));
      check(`${tag}: s.tilled agrees`,
        JSON.stringify([...home.tilled].sort((a, x) => a - x)) === JSON.stringify([...home2.tilled].sort((a, x) => a - x)));
      check(`${tag}: fertility at the tile agrees`, g2.map.fert[p.i] === g.map.fert[p.i],
        `${g.map.fert[p.i]} vs ${g2.map.fert[p.i]}`);
      check(`${tag}: scorched state agrees`, g2.pillaged.has(p.i) === g.pillaged.has(p.i),
        `${g.pillaged.has(p.i)} vs ${g2.pillaged.has(p.i)}`);
      check(`${tag}: incomeRate agrees`, Math.abs(S.incomeRate(g, home) - S.incomeRate(g2, home2)) < 1e-9,
        `${S.incomeRate(g, home)} vs ${S.incomeRate(g2, home2)}`);
    }
    parity('mid-construction', true);
    run(g, 600);
    const built = g.walls.find(w => w.x === p.x && w.y === p.y);
    check('the wall finished', !!built && !built.building);
    parity('finished', true);
    // and the moment that now writes fertility: the wall razed, the plot
    // reclaimed scorched (#219)
    g.blobs.length = 0;
    built.hp = 0.5;
    spawnBlob(g, 1, p.x + 1.5, p.y + 0.5, 3, 0);
    run(g, 30);
    check('the wall was razed and the plot reclaimed',
      !g.walls.some(w => w.id === built.id) && g.tilledBy[p.i] === home.id && g.pillaged.has(p.i));
    parity('destroyed', false);
  }
}

// ------------------- 14. garrisoning a wall UNDER ATTACK (#222)

// The reported bug: armies ordered onto their own wall while it is being
// battered stop just short and never enter. Everything hinges on whether
// the order's DESTINATION TILE is the wall tile — that is what makes
// opMove flag the march as a garrison push (so contact can't halt it)
// and what the arrival fold reads. These cases pin all four ways that
// used to break, plus the UI-side snap that keeps it true.

// A wall-legal tile a few tiles from the player's start with clear ground
// either side, so the stage sits inside the player's permanent vision.
function findSeenSpot(g) {
  const start = g.map.starts[0];
  for (let r = 3; r <= 7; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = start.x + 1 + dx, y = start.y + 1 + dy;
        if (S.canPlaceWall(g, 0, x, y).err) continue;
        // clear lane east and west: the march and the attacker both need it
        let ok = true;
        for (let k = -5; k <= 3 && ok; k++) {
          if (k === 0) continue;
          const i = y * g.map.w + (x + k);
          if (!passable(g.map, x + k, y) || g.settAt[i] || g.wallAt[i]) ok = false;
        }
        if (ok) return { x, y };
      }
    }
  }
  return null;
}

// A farm blob (spawnBlob only makes deploy/supply), for the flee case.
function spawnFarmBlob(game, owner, x, y, n) {
  const b = spawnBlob(game, owner, x, y, 0, 0);
  for (let k = 0; k < n; k++) {
    b.units.push({ role: 'farm', hp: S.unitMaxHP('farm'), seed: (k + 1) / 100 });
  }
  b.count = { deploy: 0, supply: 0, farm: n };
  b.food = n * 10;
  return b;
}

// Stage: an own finished wall on clear ground, an enemy war party parked
// adjacent battering it, and one of the player's groups a few tiles off
// on the far side. `enemySide` puts the attacker between the group and
// the wall when -1, so the march has to push THROUGH contact.
//
// `nearHome` puts the whole thing inside the player's own vision, which
// is what real play looks like — and what the enemy-avoidance cases
// below REQUIRE: avoidTiles skips enemies the mover's side can't see, so
// a siege staged out in the fog exercises no avoidance at all.
function siegeStage(opts) {
  const o = opts || {};
  const g = S.newGame('withdraw-smoke-1', 'small', 'normal');
  const spot = o.nearHome ? findSeenSpot(g) : findOpenArea(g, 5, 11);
  if (!spot) throw new Error('no open area for the siege stage');
  const w = o.building
    ? null
    : injectWall(g, 0, spot.x, spot.y, o.garrison || { deploy: 0, supply: 0, farm: 0 },
      { stock: 40 });
  const side = o.enemySide != null ? o.enemySide : 1;
  const enemy = spawnBlob(g, 1, spot.x + 0.5 + side * 1.5, spot.y + 0.5, o.enemyN || 8, 0);
  const mine = o.farm
    ? spawnFarmBlob(g, 0, spot.x + 0.5 - 4, spot.y + 0.5, o.mineN || 6)
    : spawnBlob(g, 0, spot.x + 0.5 - 4, spot.y + 0.5, o.mineN || 6, 0);
  return { g, spot, w, enemy, mine };
}

// Hold the attacker on its tile so the case under test is the MARCH, not
// whatever the enemy decides to chase; then step until the wall's
// garrison grows (or we give up).
function marchUntilGarrisoned(g, enemy, wall, spot, ticks) {
  const base = wall ? S.wallGarrisonTotal(wall) : 0;
  const ex = enemy.x, ey = enemy.y;
  for (let t = 0; t < (ticks || 400); t++) {
    if (!enemy.dead) { enemy.order = null; enemy.path = null; enemy.x = ex; enemy.y = ey; }
    S.step(g);
    const live = wall || g.walls.find(x => x.x === spot.x && x.y === spot.y);
    if (live && S.wallGarrisonTotal(live) > base) return t;
  }
  return -1;
}

{
  console.log('an army ordered onto its own wall garrisons it under attack (#222):');
  // both sidings, and both in the fog and inside the player's own vision
  // (only the latter engages enemy avoidance — see the pathing case below)
  for (const [side, nearHome] of [[1, false], [-1, false], [1, true], [-1, true]]) {
    const tag = `${side === 1 ? 'enemy beyond the wall' : 'enemy blocking the approach'}`
      + `${nearHome ? ', in vision' : ''}`;
    const { g, spot, w, enemy, mine } = siegeStage({ enemySide: side, nearHome, enemyN: 12 });
    const r = S.opMove(g, mine, spot.x + 0.5, spot.y + 0.5);
    check(`${tag}: the order is accepted`, !!r.ok, r.err);
    check(`${tag}: it is flagged a garrison push`, !!(mine.order && mine.order.garrison));
    const at = marchUntilGarrisoned(g, enemy, w, spot);
    check(`${tag}: the group folded into the wall`, at >= 0,
      `garrison ${JSON.stringify(w.garrison)} after 400 ticks`);
    check(`${tag}: the arrivals are real units`, S.wallGarrisonTotal(w) > 0);
  }
}

{
  console.log('\nenemy avoidance may not move the destination (#222):');
  // The mechanism behind the reported "armies stop just short" symptom.
  // findPath RETARGETS a blocked goal to the nearest passable tile within
  // 6 and reports success, so the soft-avoidance ring around the wall's
  // attacker (blobRadius + 1 ≈ 2.4 tiles for a 10-stack, which covers the
  // wall tile) used to come back as a fine path to somewhere ELSE. The
  // march then "arrived" two tiles out, the fold found no wall, and the
  // order was quietly cleared — no event, no toast, full-strength army.
  const { g, spot, w, enemy, mine } = siegeStage({ enemyN: 12, nearHome: true });
  check('the attacker\'s avoidance ring covers the wall tile',
    Math.hypot(enemy.x - (spot.x + 0.5), enemy.y - (spot.y + 0.5)) <= S.blobRadius(enemy) + 1,
    `${Math.hypot(enemy.x - (spot.x + 0.5), enemy.y - (spot.y + 0.5)).toFixed(2)} vs reach ${(S.blobRadius(enemy) + 1).toFixed(2)}`);
  // avoidance only applies to enemies the mover can SEE — assert that, or
  // the case silently tests nothing (this is why it must be staged in vision)
  run(g, 1);
  check('the attacker is visible to the player',
    g.fog[Math.floor(enemy.y) * g.map.w + Math.floor(enemy.x)] === 2);
  S.opMove(g, mine, spot.x + 0.5, spot.y + 0.5);
  const last = mine.path && mine.path[mine.path.length - 1];
  check('the planned path ENDS on the wall tile', !!last
    && Math.floor(last.x) === spot.x && Math.floor(last.y) === spot.y,
    last ? `ends at ${Math.floor(last.x)},${Math.floor(last.y)} not ${spot.x},${spot.y}` : 'no path');
  check('and the march folds into the wall', marchUntilGarrisoned(g, enemy, w, spot) >= 0,
    `garrison ${JSON.stringify(w.garrison)}, blob at ${mine.dead ? 'dead' : `${mine.x.toFixed(1)},${mine.y.toFixed(1)}`}`);

  // the exemption is scoped to GARRISON destinations on purpose: the
  // wider "avoidance never moves any goal" rule re-routes AI marches
  // fleet-wide and would need a recalibration (CLAUDE.md). Ordinary moves
  // keep today's retarget-toward behaviour — assert both halves so the
  // scope is deliberate rather than accidental.
  const s2 = siegeStage({ enemyN: 12, nearHome: true });
  run(s2.g, 1);
  S.opMove(s2.g, s2.mine, s2.spot.x + 0.5, s2.spot.y + 0.5);
  const pg = s2.mine.path[s2.mine.path.length - 1];
  check('a garrison destination is never substituted',
    Math.floor(pg.x) === s2.spot.x && Math.floor(pg.y) === s2.spot.y,
    `ends ${Math.floor(pg.x)},${Math.floor(pg.y)}`);
  check('pathGoal always records what was asked for',
    Math.abs(s2.mine.pathGoal.x - (s2.spot.x + 0.5)) < 1e-9
    && Math.abs(s2.mine.pathGoal.y - (s2.spot.y + 0.5)) < 1e-9);
  // an ordinary tile inside the ring keeps the old behaviour untouched
  const plain = { x: s2.spot.x + 1.5, y: s2.spot.y + 0.5 };
  if (passable(s2.g.map, Math.floor(plain.x), Math.floor(plain.y))) {
    const r = S.opMove(s2.g, s2.mine, plain.x, plain.y);
    check('an ordinary move into the ring is still accepted', !r.err, r.err);
    check('and is NOT a garrison push', !s2.mine.order.garrison);
  }
}

{
  console.log('\na near-miss click still garrisons once the UI snaps it (#222):');
  // The sim is tile-exact by design: a destination one tile short is an
  // ordinary move and correctly stops there. What must hold is that a
  // click inside the pick band resolves to the wall's own tile centre —
  // the snap main.js's ownGarrisonTargetAt now applies — so the order
  // the sim receives is the garrison push the player meant.
  const { g, spot, w, enemy, mine } = siegeStage({});
  const nearMiss = { x: spot.x + 1 + 0.2, y: spot.y + 0.5 }; // 0.2 tiles off the tile
  check('the near-miss lands inside the wall tile\'s pick band',
    tileDist(spot.x, spot.y, nearMiss.x, nearMiss.y) <= pickTol(14),
    `${tileDist(spot.x, spot.y, nearMiss.x, nearMiss.y)} > ${pickTol(14)}`);
  // ...and is NOT on the wall tile itself, so the raw point would miss
  check('the near-miss is not on the wall tile itself',
    Math.floor(nearMiss.x) !== spot.x);
  check('the raw point would NOT be a garrison spot',
    !S.opMove(g, mine, nearMiss.x, nearMiss.y).err && !mine.order.garrison);
  // snap it exactly the way ownGarrisonTargetAt does, then re-order
  const snapped = { x: w.x + 0.5, y: w.y + 0.5 };
  S.opMove(g, mine, snapped.x, snapped.y);
  check('the snapped point IS a garrison push', !!mine.order.garrison);
  check('the snapped order reaches the wall', marchUntilGarrisoned(g, enemy, w, spot) >= 0,
    `garrison ${JSON.stringify(w.garrison)}`);
}

{
  console.log('\na garrison destination drops any attack target (#222):');
  // An order carrying o.tkind is driven by tickTargetedMove, which stops
  // at melee range and NEVER reaches the arrival fold — so `garrison +
  // tkind` was a silent dead end whichever way the click resolved.
  const { g, spot, w, enemy, mine } = siegeStage({});
  S.opMove(g, mine, spot.x + 0.5, spot.y + 0.5, { kind: 'blob', id: enemy.id });
  check('the attack target was dropped', mine.order.tkind == null,
    `tkind ${mine.order.tkind}`);
  check('the order is still a garrison push', !!mine.order.garrison);
  check('and it garrisons instead of stalling at melee range',
    marchUntilGarrisoned(g, enemy, w, spot) >= 0, `garrison ${JSON.stringify(w.garrison)}`);

  // a plain enemy destination still becomes a real attack order
  const s2 = siegeStage({});
  S.opMove(s2.g, s2.mine, s2.enemy.x, s2.enemy.y, { kind: 'blob', id: s2.enemy.id });
  check('an ordinary attack order keeps its target', s2.mine.order.tkind === 'blob');
}

{
  console.log('\nreinforcements hold an unfinished wall and fold when it completes (#222):');
  const g = S.newGame('withdraw-smoke-1', 'small', 'normal');
  const spot = findOpenArea(g, 5, 11);
  // stake out a site the honest way: a builder crew standing beside it
  const crew = spawnBlob(g, 0, spot.x + 1.5, spot.y + 0.5, 1, 0);
  S.opBuildWalls(g, crew, [{ x: spot.x, y: spot.y }]);
  run(g, 5);
  const site = g.walls.find(w => w.x === spot.x && w.y === spot.y);
  check('the site exists and is still building', !!site && site.building);

  const mine = spawnBlob(g, 0, spot.x + 0.5 - 4, spot.y + 0.5, 4, 0);
  S.opMove(g, mine, spot.x + 0.5, spot.y + 0.5);
  check('an unfinished wall is not a garrison spot yet', !mine.order.garrison);
  // march in and wait on the tile. NOTE: the sim never trims game.events
  // (main.js drains it per frame), so count the array ONCE at the end —
  // summing per tick counts every event as many times as it lingers.
  g.events.length = 0;
  let held = false;
  for (let t = 0; t < 200 && site.building; t++) {
    S.step(g);
    if (!mine.dead && Math.floor(mine.x) === spot.x && Math.floor(mine.y) === spot.y
      && mine.order) held = true;
  }
  const warned = g.events.filter(e => e.msg.includes('isn\'t finished')).length;
  check('it says the wall isn\'t finished, exactly once', warned === 1, `${warned} times`);
  check('the group holds the tile with its order alive', held);
  check('the wall finished', !site.building);
  // once complete, tickOrder's re-derivation turns it into a garrison push
  run(g, 5);
  check('the waiting group folded in on completion', S.wallGarrisonTotal(site) > 0,
    `garrison ${JSON.stringify(site.garrison)}`);
  check('and the blob is gone (absorbed)', mine.dead);
}

{
  console.log('\nfarm hands sent to a wall under attack stop being pulled home (#222):');
  const { g, spot, w, enemy, mine } = siegeStage({ farm: true, mineN: 6 });
  S.opMove(g, mine, spot.x + 0.5, spot.y + 0.5);
  check('the farm group is flagged a garrison push', !!mine.order.garrison);
  let fled = false;
  const at = marchUntilGarrisoned(g, enemy, w, spot);
  if (mine.order && mine.order.flee) fled = true;
  check('it never acquired a flee order', !fled);
  check('it garrisoned the wall', at >= 0, `garrison ${JSON.stringify(w.garrison)}`);
  check('the wall holds farm hands', w.garrison.farm > 0, JSON.stringify(w.garrison));

  // the reflex itself is intact: an UNORDERED farm group near a hit
  // farmer group still runs for cover
  const s2 = siegeStage({ farm: true, mineN: 4, enemySide: -1 });
  s2.mine.x = s2.spot.x + 0.5 - 1.4; s2.mine.y = s2.spot.y + 0.5;
  for (let t = 0; t < 120 && !(s2.mine.order && s2.mine.order.flee) && !s2.mine.dead; t++) {
    S.step(s2.g);
  }
  check('an unordered farm group under fire still flees',
    s2.mine.dead || !!(s2.mine.order && s2.mine.order.flee));
}

{
  console.log('\nsupply and mixed groups garrison a wall under attack too (#222):');
  for (const kind of ['supply', 'mixed']) {
    const { g, spot, w, enemy, mine } = siegeStage({});
    if (kind === 'supply') {
      mine.units.forEach(u => { u.role = 'supply'; });
      mine.count = { deploy: 0, supply: mine.units.length, farm: 0 };
    } else {
      mine.units.slice(0, 3).forEach(u => { u.role = 'farm'; });
      mine.count = { deploy: mine.units.length - 3, supply: 0, farm: 3 };
    }
    S.opMove(g, mine, spot.x + 0.5, spot.y + 0.5);
    check(`${kind}: garrisons the wall`, marchUntilGarrisoned(g, enemy, w, spot) >= 0,
      `garrison ${JSON.stringify(w.garrison)}`);
  }
}

{
  console.log('\na full wall still turns arrivals away, once (#201 regression):');
  const { g, spot, w, enemy, mine } = siegeStage({
    garrison: { deploy: S.C.WALL_GARRISON_CAP, supply: 0, farm: 0 },
  });
  S.opMove(g, mine, spot.x + 0.5, spot.y + 0.5);
  const ex = enemy.x, ey = enemy.y;
  g.events.length = 0;
  for (let t = 0; t < 200; t++) {
    if (!enemy.dead) { enemy.order = null; enemy.path = null; enemy.x = ex; enemy.y = ey; }
    S.step(g);
    if (mine.dead) break;
  }
  const full = g.events.filter(e => e.msg.includes('garrison is full')).length;
  check('it warned that the garrison is full, exactly once', full === 1, `${full} times`);
  check('and never exceeded the cap', S.wallGarrisonTotal(w) <= S.C.WALL_GARRISON_CAP,
    `${S.wallGarrisonTotal(w)}`);
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
