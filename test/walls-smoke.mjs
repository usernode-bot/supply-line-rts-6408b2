// Headless smoke test for walls (#187). Run manually:
//   node test/walls-smoke.mjs
// Exercises the sim only (no DOM): build orders + crew-size scaling,
// enemy pathing block + breach fallback, the three damage tiers,
// garrison feeding/starvation, and save/load round-tripping.

import * as S from '../public/js/sim.js';

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
      units.push({ role, hp: role === 'farm' ? 10 : 100, seed: (units.length + 1) / 100 });
    }
  }
  const b = {
    id: game.nextId++, owner, x, y, prevX: x, prevY: y,
    units, count: { ...counts },
    food: (deploy + (supply || 0)) * 10,
    order: null, path: null, pathGoal: null,
    pillaging: false, working: null, facing: 0, convert: null,
    engagedT: -999, meleeT: -999, chaseId: null,
    dead: false, mergedInto: null, noMerge: false,
    lastYieldT: game.tick, starving: false, lowFood: false, zeroSince: -1, foodWin: [],
  };
  game.blobs.push(b);
  return b;
}

// Inject a COMPLETED wall (test-only), as if it had been built.
function injectWall(game, owner, x, y, garrison) {
  const w = {
    id: game.nextId++, owner, x, y, hp: S.C.WALL_HP, building: false,
    garrison: garrison || { deploy: 0, supply: 0, farm: 0 },
    garrFood: garrison ? (garrison.deploy + garrison.supply + garrison.farm) * S.C.FOOD_PER_UNIT : 0,
    garrLoss: 0, lastHitT: -999, starving: false, convert: null,
  };
  game.walls.push(w);
  game.wallAt[y * game.map.w + x] = w.id;
  return w;
}

function run(game, ticks) {
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
  const wIn = injectWall(g, 0, inSpot.x, inSpot.y, { deploy: 2, supply: 0, farm: 0 });
  const wOut = injectWall(g, 0, outSpot.x, outSpot.y, { deploy: 2, supply: 0, farm: 0 });
  wIn.garrFood = 5; wOut.garrFood = 5;
  run(g, 600);
  check('in-territory garrison got fed', wIn.garrFood > 5, `garrFood=${wIn.garrFood.toFixed(1)}`);
  check('out-of-territory garrison ran down', wOut.garrFood < 5, `garrFood=${wOut.garrFood.toFixed(1)}`);
  run(g, 3000);
  check('starving remote garrison loses units',
    wOut.garrison.deploy + wOut.garrison.supply + wOut.garrison.farm < 2,
    `left=${JSON.stringify(wOut.garrison)}`);
  check(`in-territory larder stockpiles past the old garrison×10 cap (${wIn.garrFood.toFixed(0)}/${S.C.WALL_FOOD_CAP})`,
    wIn.garrFood > 50, `garrFood=${wIn.garrFood.toFixed(1)}`);
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
  const w = injectWall(g, 0, outSpot.x, outSpot.y, { deploy: 2, supply: 0, farm: 0 });
  w.garrFood = 10; // draining — no territory feeding out here
  const carrier = spawnBlob(g, 0, home.x + 2.5, home.y + 0.5, 0, 5);
  const r = S.opRoute(g, carrier, { kind: 'wall', id: w.id }, home.id);
  check('opRoute accepts a wall target', !r.err, JSON.stringify(r));
  check('route registered with wall targetKind',
    g.routes.some(x => x.targetKind === 'wall' && x.targetId === w.id));
  let peak = w.garrFood;
  for (let t = 0; t < 2500; t++) { S.step(g); peak = Math.max(peak, w.garrFood); }
  const gTot = w.garrison.deploy + w.garrison.supply + w.garrison.farm;
  check(`caravan stockpiled past the old garrison×10 cap (peak ${peak.toFixed(1)})`, peak > 40, `peak=${peak.toFixed(1)}`);
  check(`rations still healthy at the end (${w.garrFood.toFixed(1)})`, w.garrFood > 5, `garrFood=${w.garrFood.toFixed(1)}`);
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
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
