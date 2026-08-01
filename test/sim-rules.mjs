// Headless checks for three sim-facing rules. Run manually:
//   node test/sim-rules.mjs
//
//  #235 — a loaded supply carrier eats from its own cargo once its
//         bellies drop below half, on any leg of the run.
//  #234 — S.previewScore describes the settlement the sim actually
//         builds: same plot count, same opening income.
//  #239 — a MIXED supply/army blob ordered onto a route peels its supply
//         units off into a caravan instead of refusing the order.

import * as S from '../public/js/sim.js';
import * as SUP from '../public/js/supply.js';
import { passable } from '../public/js/mapgen.js';

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// ------------------------------------------------ #235 carrier self-feed
{
  console.log('carrier eats its own cargo (#235)');
  const game = S.newTutorialGame();
  const home = game.settlements.find(s => s.owner === 0 && !s.building);
  const outpost = game.settlements.find(s => s.owner === 0 && s.id !== home.id);
  // turn the player's war party into a caravan
  const b = game.blobs.find(x => !x.dead && x.owner === 0 && S.total(x) >= 5 && x.working == null);
  for (const u of b.units) u.role = 'supply';
  b.count = { deploy: 0, supply: b.units.length, farm: 0 };
  const r = SUP.createRoute(game, b, { kind: 'settlement', id: outpost.id }, 0, home.id);
  check('route created', !r.err, r.err);

  // Strand it mid-run: loaded, outbound, and far enough from BOTH
  // settlements that it can neither dock nor top up at the source inside
  // the window — the point is that it feeds itself out in the open.
  let spot = null, bestD = -1;
  for (let ty = 0; ty < game.map.h; ty++) {
    for (let tx = 0; tx < game.map.w; tx++) {
      if (!passable(game.map, tx, ty)) continue;
      const d = Math.min(
        Math.hypot(tx + 0.5 - (home.x + 1), ty + 0.5 - (home.y + 1)),
        Math.hypot(tx + 0.5 - (outpost.x + 1), ty + 0.5 - (outpost.y + 1)));
      if (d > bestD) { bestD = d; spot = { x: tx + 0.5, y: ty + 0.5 }; }
    }
  }
  b.x = spot.x; b.y = spot.y;
  check('stranded well clear of both docks', bestD > 8, `nearest dock ${bestD.toFixed(1)}`);
  b.path = null; b.pathGoal = null;
  b.order.phase = 'deliver';
  b.order.cargo = 60;
  b.food = 0;
  const cargo0 = b.order.cargo;
  const n = S.total(b);

  for (let i = 0; i < 30; i++) S.step(game);

  check('carrier survived', !b.dead);
  check('bellies refilled from cargo', b.food > 1, `food=${b.food.toFixed(2)}`);
  check('cargo actually spent', b.order.cargo < cargo0 - 1,
    `${cargo0} -> ${(b.order.cargo || 0).toFixed(2)}`);
  check('never went starving', !b.starving);
  // the bite is capped at 10% of head-count per tick, so 30 ticks can move
  // at most 3n food out of the hold — no swallowing the delivery whole
  check('sips rather than swallows', cargo0 - b.order.cargo <= n * 0.1 * 30 + 0.001,
    `moved ${(cargo0 - b.order.cargo).toFixed(2)} of ${n * 3}`);

  // and it stops once it's comfortable again: the rule only fires below
  // half rations, so food must settle in the neighbourhood of the cap/2
  const cap = S.total(b) * 10;
  for (let i = 0; i < 400 && b.order && b.order.cargo > 5; i++) S.step(game);
  check('does not gorge past the half-rations trigger', b.food <= cap * 0.5 + n * 0.1 + 0.001,
    `food=${b.food.toFixed(2)} cap=${cap}`);
}

// ------------------------------------------------ #234 placement readout
{
  console.log('placement score matches the settlement built (#234)');
  const game = S.newGame('preview-1', 'small', 'normal');
  const b = game.blobs.find(x => !x.dead && x.owner === 0 && S.total(x) >= S.C.SETT_COST);

  // walk the blob to the best legal anchor a few tiles off its start
  let site = null;
  for (let ay = 0; ay < game.map.h - 1 && !site; ay++) {
    for (let ax = 0; ax < game.map.w - 1; ax++) {
      const a = S.buildAnchorAt(game, ax, ay);
      if (a.err || a.x !== ax || a.y !== ay) continue;
      const d = Math.hypot(ax + 1 - b.x, ay + 1 - b.y);
      if (d < 6 || d > 12) continue;
      const sc = S.previewScore(game, ax, ay, 0);
      if (sc.plots >= 12) { site = { ax, ay, sc, cells: S.previewFields(game, ax, ay, 0) }; break; }
    }
  }
  check('found a site to score', !!site);
  if (site) {
    const { ax, ay, sc, cells } = site;
    check('score is self-consistent', sc.maxPerMin >= sc.nowPerMin && sc.plots > 0,
      JSON.stringify(sc));
    check('mean fertility in range', sc.meanFert > 0 && sc.meanFert <= 1,
      String(sc.meanFert));
    check('cached score matches the raw one',
      JSON.stringify(S.previewScoreCached(game, ax, ay, 0)) === JSON.stringify(sc));
    // the headline number is the sim's own rate function over the previewed
    // cells, not a parallel formula — this is the whole point of #234
    const viaSim = S.incomeRate(game, { id: -1, tilled: cells }) * 600;
    check('now/min IS the sim rate over the previewed cells',
      Math.abs(viaSim - sc.nowPerMin) < 1e-9,
      `${viaSim} vs ${sc.nowPerMin}`);

    // stand ON the anchor tile: buildAnchorAt tries the floored tile first
    b.x = ax + 0.5; b.y = ay + 0.5;
    const built = S.opBuild(game, b);
    check('build accepted', !built.err, built.err);
    const s = built.settlement;
    check('founded at the scored anchor', s.x === ax && s.y === ay,
      `scored ${ax},${ay} got ${s.x},${s.y}`);
    for (let i = 0; i < 3000 && s.building; i++) S.step(game);
    check('settlement finished', !s.building);
    check('plot count matched the preview', s.tilled.length === sc.plots,
      `preview ${sc.plots}, built ${s.tilled.length}`);
    // Opening income: no farmers are out on the tick it completes, so the
    // live rate is exactly the base rate over the previewed cells. Compared
    // against the CURRENT fertility of those cells, not the preview-time
    // figure — fertility regenerates over the construction window, and what
    // #234 promises is the plot set, not frozen soil.
    const live = S.incomeRate(game, s) * 600;
    let fnow = 0;
    for (const i of cells) fnow += game.map.fert[i];
    const expected = fnow * S.C.FARM_PER_FARMER * S.C.FARM_BASE_FARMERS * 600;
    check('founded settlement earns over exactly the previewed cells',
      Math.abs(live - expected) < 1e-9,
      `live ${live}, expected ${expected}`);
    check('preview max is an upper bound on the opening rate',
      sc.maxPerMin >= sc.nowPerMin - 1e-9,
      `max ${sc.maxPerMin.toFixed(2)} vs now ${sc.nowPerMin.toFixed(2)}`);
  }
}

// ------------------------------------------- #239 mixed blob peels carriers
{
  console.log('\nmixed supply/army blob peels its carriers onto a route (#239)');

  // A merged group: fighters + supply units in one blob, exactly what
  // tickMerge produces when an idle caravan folds into an idle army.
  function mixedGame(deployN, supplyN) {
    const game = S.newTutorialGame();
    const home = game.settlements.find(s => s.owner === 0 && !s.building);
    const outpost = game.settlements.find(s => s.owner === 0 && s.id !== home.id);
    const b = game.blobs.find(x => !x.dead && x.owner === 0
      && S.total(x) >= deployN + supplyN && x.working == null);
    b.units.length = deployN + supplyN;
    b.units.forEach((u, i) => { u.role = i < supplyN ? 'supply' : 'deploy'; });
    b.count = { deploy: deployN, supply: supplyN, farm: 0 };
    b.food = 20;
    return { game, home, outpost, b };
  }

  {
    const { game, home, outpost, b } = mixedGame(7, 3);
    const order = { type: 'move', x: b.x, y: b.y }; // the army's own plan
    b.order = order;
    const before = game.blobs.filter(x => !x.dead).length;
    const res = S.opRoute(game, b, { kind: 'settlement', id: outpost.id }, home.id);
    check('mixed blob accepted onto a route', !res.err, res.err);
    check('peeled count is the supply half', res.peeled === 3, `peeled ${res.peeled}`);
    check('parent keeps only its fighters',
      b.count.supply === 0 && b.count.deploy === 7 && S.total(b) === 7,
      JSON.stringify(b.count));
    const c = res.carrier;
    check('carrier is a NEW blob', !!c && c.id !== b.id);
    check('carrier is pure supply',
      c.count.supply === S.total(c) && S.total(c) === 3, JSON.stringify(c.count));
    check('carrier units are all supply records',
      c.units.every(u => u.role === 'supply'));
    check('carrier is on the route',
      !!c.order && c.order.type === 'route' && c.order.routeId === res.route.id,
      JSON.stringify(c.order));
    check('carrier carries no arm-up', c.convert == null);
    check('both halves are held apart from re-merging', b.noMerge && c.noMerge);
    check('army keeps its own order', b.order === order, JSON.stringify(b.order));
    check('one new blob exists', game.blobs.filter(x => !x.dead).length === before + 1);
    check('food split proportionally',
      Math.abs(b.food - 20 * 7 / 10) < 1e-9 && Math.abs(c.food - 20 * 3 / 10) < 1e-9,
      `parent ${b.food}, carrier ${c.food}`);
  }

  // Self-target: the peeled caravan feeds the army it just left.
  {
    const { game, home, b } = mixedGame(7, 3);
    const res = S.opRoute(game, b, { kind: 'blob', id: b.id }, home.id);
    check('mixed blob may supply itself', !res.err, res.err);
    check('the line points at the army remainder',
      res.route.targetKind === 'blob' && res.route.targetId === b.id,
      `${res.route.targetKind} ${res.route.targetId}`);
    check('the carrier is not its own destination', res.carrier.id !== res.route.targetId);
  }

  // ...but a pure-supply blob still cannot route to itself.
  {
    const { game, home, b } = mixedGame(0, 5);
    const res = S.opRoute(game, b, { kind: 'blob', id: b.id }, home.id);
    check('pure-supply self-route still refused',
      res.err === 'Route must lead away from its source', JSON.stringify(res));
    check('refused self-route left the blob alone',
      S.total(b) === 5 && !b.order, JSON.stringify(b.count));
  }

  // Rollback: a route that createRoute rejects must leave nothing stranded.
  {
    const { game, home, b } = mixedGame(7, 3);
    const before = game.blobs.filter(x => !x.dead).length;
    // a line from home to home is refused by createRoute itself
    const res = S.opRoute(game, b, { kind: 'settlement', id: home.id }, home.id);
    check('failed route reports the error',
      res.err === 'Route must lead away from its source', JSON.stringify(res));
    check('units folded back into the parent',
      S.total(b) === 10 && b.count.supply === 3 && b.count.deploy === 7,
      JSON.stringify(b.count));
    check('food folded back', Math.abs(b.food - 20) < 1e-9, `${b.food}`);
    check('no stranded caravan left behind',
      game.blobs.filter(x => !x.dead).length === before,
      `${game.blobs.filter(x => !x.dead).length} vs ${before}`);
    check('no orderless supply blob beside the army',
      !game.blobs.some(x => !x.dead && x !== b && x.owner === 0
        && x.count.supply === S.total(x) && S.total(x) === 3 && !x.order));
    check('no route was created', !game.routes.some(r => r.owner === 0
      && r.settlementId === home.id && r.targetId === home.id));
  }

  // A group with no supply units at all is still refused.
  {
    const { game, home, outpost, b } = mixedGame(7, 0);
    const before = game.blobs.filter(x => !x.dead).length;
    const res = S.opRoute(game, b, { kind: 'settlement', id: outpost.id }, home.id);
    check('all-fighter blob refused',
      res.err === 'No supply units in this group', JSON.stringify(res));
    check('refused blob is untouched',
      S.total(b) === 7 && game.blobs.filter(x => !x.dead).length === before);
  }

  // The peeled caravan actually runs: it loads at the source and delivers.
  {
    const { game, home, outpost, b } = mixedGame(7, 3);
    const res = S.opRoute(game, b, { kind: 'settlement', id: outpost.id }, home.id);
    check('route created for the run', !res.err, res.err);
    const c = res.carrier;
    home.stockpile = S.C.STOCK_CAP;
    outpost.stockpile = 0;
    let delivered = false;
    for (let i = 0; i < 6000 && !delivered; i++) {
      S.step(game);
      if (c.dead) break;
      delivered = SUP.findRoute(game, res.route.id)
        && game.routes.some(r => r.id === res.route.id && r.window.length > 0);
    }
    check('the peeled caravan delivers on its line', delivered);
  }
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall sim-rule checks passed');
process.exit(failures ? 1 : 0);
