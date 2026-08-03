// Headless checks for three sim-facing rules. Run manually:
//   node test/sim-rules.mjs
//
//  #235 — a loaded supply carrier eats from its own cargo once its
//         bellies drop below half, on any leg of the run.
//  #234 — S.previewScore describes the settlement the sim actually
//         builds: same plot count, same opening income.
//  #239 — a MIXED supply/army blob runs a route as ONE escorted group:
//         supply units haul, fighters guard and eat off the load.

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

// ------------------------------------------ #239 escorted supply routes
{
  console.log('\na mixed supply/army group escorts its own caravan (#239)');

  // A merged group: fighters + supply units in one blob, exactly what
  // tickMerge produces when an idle caravan folds into an idle army. The
  // tutorial game's biggest party is 10 units, so keep deploy+supply <= 10.
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

  const live = g => g.blobs.filter(x => !x.dead).length;

  // -- the whole group goes, as one blob
  {
    const { game, home, outpost, b } = mixedGame(7, 3);
    const before = live(game);
    const res = S.opRoute(game, b, { kind: 'settlement', id: outpost.id }, home.id);
    check('mixed group accepted onto a route', !res.err, res.err);
    check('nothing was split off', live(game) === before, `${live(game)} vs ${before}`);
    check('the group itself is the carrier',
      !!b.order && b.order.type === 'route' && b.order.routeId === res.route.id,
      JSON.stringify(b.order));
    check('it kept both roles',
      S.total(b) === 10 && b.count.deploy === 7 && b.count.supply === 3,
      JSON.stringify(b.count));
    check('the line lists exactly this carrier',
      res.route.carrierIds.length === 1 && res.route.carrierIds[0] === b.id,
      JSON.stringify(res.route.carrierIds));
  }

  // -- the hold is sized by the supply units alone
  {
    const { game, home, outpost, b } = mixedGame(7, 3);
    check('hold counts carriers, not fighters',
      SUP.holdCap(b) === 3 * SUP.CARRY_PER_UNIT, `holdCap ${SUP.holdCap(b)}`);
    check('a total-based hold would have been far bigger',
      S.total(b) * SUP.CARRY_PER_UNIT === 100);
    S.opRoute(game, b, { kind: 'settlement', id: outpost.id }, home.id);
    home.stockpile = S.C.STOCK_CAP;
    for (let i = 0; i < 600 && b.order && b.order.phase === 'load'; i++) S.step(game);
    check('loading never exceeds the supply-only hold',
      !!b.order && (b.order.cargo || 0) <= SUP.holdCap(b) + 1e-9,
      `cargo ${b.order && b.order.cargo}`);
    check('it did actually load something', !!b.order && (b.order.cargo || 0) > 1,
      `cargo ${b.order && b.order.cargo}`);
  }

  // -- the loop runs indefinitely: deliver, walk home, load, deliver again
  {
    const { game, home, outpost, b } = mixedGame(5, 5);
    const res = S.opRoute(game, b, { kind: 'settlement', id: outpost.id }, home.id);
    check('route created for the long run', !res.err, res.err);
    home.stockpile = S.C.STOCK_CAP;
    outpost.stockpile = 0;
    let loads = 0, prevPhase = b.order.phase;
    for (let i = 0; i < 12000 && !b.dead && b.order; i++) {
      S.step(game);
      home.stockpile = S.C.STOCK_CAP;   // keep the source supplied
      outpost.stockpile = 0;            // and the destination hungry
      if (b.order && b.order.phase !== prevPhase) {
        if (b.order.phase === 'load') loads++;
        prevPhase = b.order.phase;
      }
    }
    check('the escort is still on its line after a long run',
      !b.dead && !!b.order && b.order.type === 'route', JSON.stringify(b.order));
    check('it came back to load at least twice', loads >= 2, `returned to load ${loads}x`);
    const r = SUP.findRoute(game, res.route.id);
    check('the line recorded repeated deliveries', !!r && r.window.length > 1,
      r ? `${r.window.length} deliveries in the window` : 'route gone');
  }

  // -- the escort eats off the load it hauls
  {
    const { game, home, outpost, b } = mixedGame(7, 3);
    S.opRoute(game, b, { kind: 'settlement', id: outpost.id }, home.id);
    b.pillaging = false;
    b.order.phase = 'go';
    b.order.cargo = SUP.holdCap(b);
    b.food = 0.2 * S.foodCap(b);   // below the half-rations trigger
    const cargo0 = b.order.cargo, food0 = b.food;
    for (let i = 0; i < 20; i++) S.step(game);
    check('the escort ate into the cargo', b.order && b.order.cargo < cargo0 - 0.5,
      `${cargo0} -> ${b.order && b.order.cargo}`);
    check('and its own rations rose', b.food > food0, `${food0} -> ${b.food}`);
  }

  // -- fighters defend the caravan; a lean one cannot. Staged out in the
  // open, well clear of every other unit and settlement, so the only thing
  // that can damage the raider is the caravan it is attacking.
  function raid(deployN, supplyN) {
    const { game, home, outpost, b } = mixedGame(deployN, supplyN);
    S.opRoute(game, b, { kind: 'settlement', id: outpost.id }, home.id);
    // the tile furthest from anything of the player's — same trick #235 uses
    let spot = null, bestD = -1;
    for (let ty = 0; ty < game.map.h; ty++) {
      for (let tx = 0; tx < game.map.w; tx++) {
        if (!passable(game.map, tx, ty)) continue;
        let d = Infinity;
        for (const o of game.blobs) {
          if (o.dead || o === b) continue;
          d = Math.min(d, Math.hypot(tx + 0.5 - o.x, ty + 0.5 - o.y));
        }
        for (const s of game.settlements) {
          d = Math.min(d, Math.hypot(tx + 0.5 - (s.x + 1), ty + 0.5 - (s.y + 1)));
        }
        if (d > bestD) { bestD = d; spot = { x: tx + 0.5, y: ty + 0.5 }; }
      }
    }
    b.x = spot.x; b.y = spot.y;
    b.prevX = b.x; b.prevY = b.y;
    b.path = null; b.pathGoal = null;
    const foe = game.blobs.find(x => !x.dead && x.owner === 1 && x.count.deploy > 0);
    foe.order = null; foe.path = null; foe.pathGoal = null;
    foe.x = b.x + 0.5; foe.y = b.y;
    foe.prevX = foe.x; foe.prevY = foe.y;
    const hpOf = z => z.units.reduce((a, u) => a + u.hp, 0);
    const hp0 = hpOf(foe);
    for (let i = 0; i < 15; i++) {
      S.step(game);
      if (b.dead || foe.dead) break;
      foe.x = b.x + 0.5; foe.y = b.y;   // pin the raider in contact
      foe.order = null; foe.path = null;
    }
    return { hurt: hp0 - (foe.dead ? 0 : hpOf(foe)), isolated: bestD };
  }
  const guarded = raid(7, 3), lean = raid(0, 10);
  check('the raid was staged in isolation', guarded.isolated > 6 && lean.isolated > 6,
    `${guarded.isolated.toFixed(1)} / ${lean.isolated.toFixed(1)}`);
  check('an escorted caravan hurts its attacker', guarded.hurt > 0, `${guarded.hurt}`);
  check('a lean caravan cannot fight back', lean.hurt === 0, `${lean.hurt}`);

  // -- lose every carrier and the group drops off the line
  {
    const { game, home, outpost, b } = mixedGame(7, 3);
    const res = S.opRoute(game, b, { kind: 'settlement', id: outpost.id }, home.id);
    b.order.cargo = 12;
    b.food = 0;
    const food0 = b.food;
    b.units = b.units.filter(u => u.role !== 'supply');   // raiders killed the carriers
    b.count = { deploy: 7, supply: 0, farm: 0 };
    S.step(game);
    check('the group left the route', !b.order, JSON.stringify(b.order));
    check('it kept the cargo as rations', b.food > food0, `${food0} -> ${b.food}`);
    check('it survives as an ordinary army', !b.dead && S.total(b) === 7);
    const r = SUP.findRoute(game, res.route.id);
    check('the line dropped it as a carrier',
      !r || !r.carrierIds.includes(b.id), r ? JSON.stringify(r.carrierIds) : 'route dissolved');
  }

  // -- a group still cannot supply itself
  {
    const { game, home, b } = mixedGame(7, 3);
    const res = S.opRoute(game, b, { kind: 'blob', id: b.id }, home.id);
    check('mixed self-route refused',
      res.err === 'Route must lead away from its source', JSON.stringify(res));
    check('refused self-route left the group alone',
      !b.order && S.total(b) === 10, JSON.stringify(b.count));
  }
  {
    const { game, home, b } = mixedGame(0, 5);
    const res = S.opRoute(game, b, { kind: 'blob', id: b.id }, home.id);
    check('lean self-route still refused',
      res.err === 'Route must lead away from its source', JSON.stringify(res));
  }

  // -- no carriers at all is still a refusal
  {
    const { game, home, outpost, b } = mixedGame(7, 0);
    const before = live(game);
    const res = S.opRoute(game, b, { kind: 'settlement', id: outpost.id }, home.id);
    check('all-fighter group refused',
      res.err === 'No supply units in this group', JSON.stringify(res));
    check('refused group is untouched',
      !b.order && S.total(b) === 7 && live(game) === before);
  }

  // -- an all-supply caravan is completely unaffected by the escort rules
  {
    const { game, home, outpost, b } = mixedGame(0, 8);
    const res = S.opRoute(game, b, { kind: 'settlement', id: outpost.id }, home.id);
    check('a lean caravan still routes', !res.err, res.err);
    check('its hold is unchanged by the supply-only rule',
      SUP.holdCap(b) === S.total(b) * SUP.CARRY_PER_UNIT, `${SUP.holdCap(b)}`);
  }
}

// ------------------------------------------------ #247 idleFarmers is per-owner
{
  console.log('idleFarmers counts ONE side (#247)');
  // The HUD's "Back to work" badge read idleFarmers(game, 0) regardless of
  // which seat the player held, so the joining player in a PvP match was shown
  // the host's count. The op it fires has always been per-owner; this locks the
  // query the badge reads to the same contract.
  const game = S.newGame('sim247', 'xsmall', 'normal', true);
  const mine = game.settlements.find(s => s.owner === 1 && !s.building);
  const theirs = game.settlements.find(s => s.owner === 0 && !s.building);
  check('both sides have a settlement', !!mine && !!theirs);
  // owner 1 keeps farmhands sitting in the garrison; owner 0 keeps none
  mine.garrison = { deploy: 0, supply: 0, farm: 4 };
  theirs.garrison = { deploy: 0, supply: 0, farm: 0 };
  for (const b of game.blobs) if (!b.dead) b.dead = true;   // no field groups either way

  const one = S.idleFarmers(game, 1);
  const zero = S.idleFarmers(game, 0);
  check('the side WITH idle farmhands reports them', one.field === 4, JSON.stringify(one));
  check('the side WITHOUT them reports none',
    zero.field === 0 && zero.walk === 0, JSON.stringify(zero));

  // and the op moves the same side the query counted
  const res = S.opBackToWork(game, 1);
  check('back-to-work fields exactly that side', res.fielded === 4, JSON.stringify(res));
  check('the other side was not touched',
    theirs.garrison.farm === 0 && S.idleFarmers(game, 0).field === 0);
  check('and the badge empties once they are working',
    S.idleFarmers(game, 1).field === 0, JSON.stringify(S.idleFarmers(game, 1)));
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall sim-rule checks passed');
process.exit(failures ? 1 : 0);
