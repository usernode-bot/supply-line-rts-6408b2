// Headless tests for intent-aware group merging (#227). Run:
//   node test/merge.mjs
// Exercises tickMerge only (no DOM, no AI): the pincer veto around a
// shared foe, the stack override, the tightened idle trigger, the
// heading gate on marching columns, and the folds that must KEEP
// working — reinforcement waves (#93/#207), group build (#130) and
// same-route carriers (#133) — plus a save/resume round trip.

import * as S from '../public/js/sim.js';
import * as SUP from '../public/js/supply.js';
import { passable, mulberry32, hashSeed } from '../public/js/mapgen.js';

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function fixture(tag, size = 'medium') {
  Math.random = mulberry32(hashSeed(tag));   // newGame's own draws only
  return S.newGame(tag, size, 'normal');
}

// A patch of open ground clear of every settlement, so nothing in these
// scenarios garrisons, farms or feeds off territory mid-test.
function openSpot(g, radius = 6) {
  const { w, h } = g.map;
  for (let y = radius + 2; y < h - radius - 2; y++) {
    for (let x = radius + 2; x < w - radius - 2; x++) {
      let clear = true;
      for (let dy = -radius; dy <= radius && clear; dy++) {
        for (let dx = -radius; dx <= radius && clear; dx++) {
          if (!passable(g.map, x + dx, y + dy)) clear = false;
        }
      }
      if (!clear) continue;
      if (g.settlements.some(s => Math.hypot(s.x + 1 - x, s.y + 1 - y) < radius + 8)) continue;
      return { x: x + 0.5, y: y + 0.5 };
    }
  }
  return null;
}

// Field n units from `owner`'s first town and park them exactly at
// (x, y), fed and orderless — the equivalent of placeAt in the AI tests.
function party(g, owner, n, x, y, role = 'deploy') {
  const s = g.settlements.find(st => st.owner === owner && !st.building);
  s.garrison[role] += n;
  s.garrFood = (s.garrFood || 0) + n * S.C.FOOD_PER_UNIT;
  const b = S.opFieldRole(g, s, role, n).blob;
  b.x = x; b.y = y; b.prevX = x; b.prevY = y;
  b.order = null; b.path = null; b.pathGoal = null;
  b.food = S.foodCap(b);
  return b;
}

const alive = (g, b) => g.blobs.some(x => x.id === b.id && !x.dead);
const merged = (g) => Object.keys(g.mergeLog).length > 0;
const around = (c, ang, r) => ({ x: c.x + Math.cos(ang) * r, y: c.y + Math.sin(ang) * r });

// Keep every blob fed so nothing starves out of a long scenario.
function feed(g) {
  for (const b of g.blobs) if (!b.dead) b.food = S.foodCap(b);
}
function run(g, ticks, onTick) {
  for (let i = 0; i < ticks; i++) {
    feed(g);
    S.step(g);
    if (onTick && onTick(g, i) === false) return;
  }
}

// ------------------------------- 1. front-and-back pincer on an army

{
  console.log('two groups attacking one enemy from opposite sides stay apart:');
  const g = fixture('merge-pincer');
  const c = openSpot(g);
  check('found open ground for the scenario', !!c);
  const foe = party(g, 1, 10, c.x, c.y);
  const west = party(g, 0, 10, c.x - 3, c.y);
  const east = party(g, 0, 10, c.x + 3, c.y);
  S.opMove(g, west, foe.x, foe.y, { kind: 'blob', id: foe.id });
  S.opMove(g, east, foe.x, foe.y, { kind: 'blob', id: foe.id });
  let sawRear = false, bothInContact = false;
  run(g, 120, () => {
    if (g.combat.some(l => l.kind === 'bb' && l.rear)) sawRear = true;
    const d1 = Math.hypot(west.x - foe.x, west.y - foe.y);
    const d2 = Math.hypot(east.x - foe.x, east.y - foe.y);
    if (d1 <= S.C.MELEE_RANGE + 0.2 && d2 <= S.C.MELEE_RANGE + 0.2) bothInContact = true;
    return !(foe.dead);
  });
  check('both halves reached contact', bothInContact);
  check('the west group survives as its own group', alive(g, west));
  check('the east group survives as its own group', alive(g, east));
  check('nothing merged', !merged(g), JSON.stringify(g.mergeLog));
  check('the enemy takes a rear/flank bonus hit', sawRear);
  // the old touching-distance rule would have folded them: two 10-unit
  // blobs touch at 2.81 tiles, opposite sides of the melee ring are 2.4
  check('the pair really was inside touching distance',
    Math.hypot(west.x - east.x, west.y - east.y)
      < S.blobRadius(west) + S.blobRadius(east),
    `${Math.hypot(west.x - east.x, west.y - east.y).toFixed(2)}`);
}

// ------------------------------- 2. a same-side wave still folds in

{
  console.log('a second wave coming in on the same side still merges:');
  const g = fixture('merge-wave');
  const c = openSpot(g);
  const foe = party(g, 1, 10, c.x, c.y);
  const lead = party(g, 0, 10, c.x - 3, c.y);
  const wave = party(g, 0, 8, c.x - 5, c.y);
  S.opMove(g, lead, foe.x, foe.y, { kind: 'blob', id: foe.id });
  S.opMove(g, wave, foe.x, foe.y, { kind: 'blob', id: foe.id });
  run(g, 120, () => !merged(g));
  check('the wave folded into the assault', merged(g), JSON.stringify(g.mergeLog));
  check('the survivor keeps the attack order',
    g.blobs.some(b => !b.dead && b.owner === 0 && b.order
      && b.order.tkind === 'blob' && b.order.tid === foe.id));
}

// ------------------------------- 3. an idle sandwich holds

{
  console.log('two idle groups with an enemy between them do not fuse:');
  const g = fixture('merge-sandwich');
  const c = openSpot(g);
  const foe = party(g, 1, 8, c.x, c.y);
  // 0.8 either side: 1.6 apart, inside the OLD 0.6 trigger (2.24 for two
  // 20-unit groups) and inside the new one (1.68) — only the veto holds
  // them apart, and the enemy sits squarely between their centers
  const left = party(g, 0, 20, c.x - 0.8, c.y);
  const right = party(g, 0, 20, c.x + 0.8, c.y);
  run(g, 30);
  check('the pair is inside the tightened idle trigger',
    Math.hypot(left.x - right.x, left.y - right.y)
      <= Math.max(S.C.MERGE_MIN, S.C.MERGE_FRAC * (S.blobRadius(left) + S.blobRadius(right))),
    `${Math.hypot(left.x - right.x, left.y - right.y).toFixed(2)}`);
  check('both groups are still there', alive(g, left) && alive(g, right));
  check('nothing merged', !merged(g), JSON.stringify(g.mergeLog));
  check('the enemy is engaged by both', !foe.dead && g.tick - foe.engagedT < 5);
}

// ------------------------------- 4. two-sided siege

{
  console.log('a town besieged from two faces keeps two armies:');
  const g = fixture('merge-siege');
  const town = g.settlements.find(s => s.owner === 1 && !s.building);
  const c = S.settCenter(town);
  const r = S.C.SIEGE_RANGE - 0.15;
  const p1 = around(c, 0, r), p2 = around(c, Math.PI * 2 / 3, r); // 120° apart
  const a = party(g, 0, 30, p1.x, p1.y);
  const b = party(g, 0, 30, p2.x, p2.y);
  S.opMove(g, a, c.x, c.y, { kind: 'settlement', id: town.id });
  S.opMove(g, b, c.x, c.y, { kind: 'settlement', id: town.id });
  run(g, 20);
  check('the pair is inside touching distance',
    Math.hypot(a.x - b.x, a.y - b.y) <= S.blobRadius(a) + S.blobRadius(b),
    `${Math.hypot(a.x - b.x, a.y - b.y).toFixed(2)}`);
  check('both siege columns survive separately',
    alive(g, a) && alive(g, b) && !merged(g), JSON.stringify(g.mergeLog));

  console.log('...but two on the SAME face still fold together:');
  const g2 = fixture('merge-siege-2');
  const t2 = g2.settlements.find(s => s.owner === 1 && !s.building);
  const c2 = S.settCenter(t2);
  const q1 = around(c2, 0, S.C.SIEGE_RANGE - 0.15);
  const q2 = around(c2, Math.PI / 9, S.C.SIEGE_RANGE - 0.15); // 20° apart
  const d = party(g2, 0, 30, q1.x, q1.y);
  const e = party(g2, 0, 30, q2.x, q2.y);
  S.opMove(g2, d, c2.x, c2.y, { kind: 'settlement', id: t2.id });
  S.opMove(g2, e, c2.x, c2.y, { kind: 'settlement', id: t2.id });
  run(g2, 20, () => !merged(g2));
  check('the same-face pair merged', merged(g2), JSON.stringify(g2.mergeLog));
}

// ------------------------------- 5. converging columns on the march

{
  console.log('columns converging from different bearings do not fuse en route:');
  const g = fixture('merge-converge');
  const c = openSpot(g);
  const foe = party(g, 1, 10, c.x, c.y);
  // 30-unit columns touch at 4.4 tiles; these start 4.24 apart and 3.0
  // from the target, so the OLD rule folded them well short of the fight
  const w = party(g, 0, 30, c.x - 3, c.y);
  const n = party(g, 0, 30, c.x, c.y - 3);
  S.opMove(g, w, foe.x, foe.y, { kind: 'blob', id: foe.id });
  S.opMove(g, n, foe.x, foe.y, { kind: 'blob', id: foe.id });
  check('they start inside the old touching trigger',
    Math.hypot(w.x - n.x, w.y - n.y) < S.blobRadius(w) + S.blobRadius(n));
  let mergedEnRoute = false;
  run(g, 6, () => {
    if (merged(g)) mergedEnRoute = true;
    return !mergedEnRoute;
  });
  check('neither column was folded on the road', !mergedEnRoute);
  check('both columns are still marching', alive(g, w) && alive(g, n));
}

// ------------------------------- 6. one column still consolidates

{
  console.log('a group stacked behind another on the same heading merges:');
  const g = fixture('merge-column');
  const c = openSpot(g);
  const foe = party(g, 1, 10, c.x, c.y);
  const front = party(g, 0, 30, c.x - 5, c.y);
  const back = party(g, 0, 20, c.x - 6, c.y + 0.5); // same heading, deep overlap
  S.opMove(g, front, foe.x, foe.y, { kind: 'blob', id: foe.id });
  S.opMove(g, back, foe.x, foe.y, { kind: 'blob', id: foe.id });
  run(g, 10, () => !merged(g));
  check('the trailing group folded into the column', merged(g), JSON.stringify(g.mergeLog));
}

// ------------------------------- 7. the tightened idle trigger

{
  console.log('idle groups only fold when genuinely stacked:');
  const g = fixture('merge-idle');
  const c = openSpot(g);
  const a = party(g, 0, 20, c.x - 1, c.y);
  const b = party(g, 0, 20, c.x + 1, c.y);   // 2.0 apart: old 2.24 merged, new 1.68 doesn't
  run(g, 20);
  check('a 2.0-tile gap no longer merges', alive(g, a) && alive(g, b) && !merged(g),
    JSON.stringify(g.mergeLog));

  const g2 = fixture('merge-idle-2');
  const c2 = openSpot(g2);
  const d = party(g2, 0, 20, c2.x - 0.6, c2.y);
  const e = party(g2, 0, 20, c2.x + 0.6, c2.y); // 1.2 apart: inside 1.68
  run(g2, 20, () => !merged(g2));
  check('a 1.2-tile gap still merges', merged(g2), JSON.stringify(g2.mergeLog));
  check('the survivor carries both halves',
    g2.blobs.some(b => !b.dead && b.owner === 0 && S.total(b) === 40),
    JSON.stringify(g2.blobs.filter(b => !b.dead && b.owner === 0).map(b => S.total(b))));
}

// ------------------------------- 8. the deliberate join

{
  console.log('sending one group onto another still combines them:');
  const g = fixture('merge-join');
  const c = openSpot(g);
  const foe = party(g, 1, 8, c.x, c.y);         // an enemy squarely between them
  const held = party(g, 0, 20, c.x - 0.9, c.y);
  const sent = party(g, 0, 20, c.x + 4, c.y);
  S.opMove(g, sent, held.x, held.y);
  run(g, 200, () => !merged(g));
  check('the sent group folded in on arrival', merged(g), JSON.stringify(g.mergeLog));
  check('the survivor holds both halves',
    g.blobs.some(b => !b.dead && b.owner === 0 && S.total(b) >= 38),
    JSON.stringify(g.blobs.filter(b => !b.dead && b.owner === 0).map(b => S.total(b))));
}

// ------------------------------- 9. group build (#130) still folds

{
  console.log('an escort still folds into a waiting founding party:');
  const g = fixture('merge-build');
  const c = openSpot(g);
  const site = S.buildAnchorAt(g, Math.floor(c.x), Math.floor(c.y));
  check('the open ground takes a settlement', !site.err, JSON.stringify(site));
  const founder = party(g, 0, 3, c.x - 2, c.y);
  const escort = party(g, 0, 4, c.x - 4, c.y);
  const r = S.opBuildAt(g, founder, site.x, site.y);
  check('the founding order was issued', !!r.ok, JSON.stringify(r));
  S.opMove(g, escort, r.site.x + 1, r.site.y + 1);
  let founded = false;
  run(g, 400, () => {
    if (g.settlements.some(s => s.owner === 0 && s.building)) founded = true;
    return !founded;
  });
  check('the escort merged in and construction started', founded,
    JSON.stringify(g.blobs.filter(b => !b.dead && b.owner === 0).map(b => S.total(b))));
}

// ------------------------------- 10. same-route carriers (#133)

{
  console.log('two carriers on one line still converge:');
  const g = fixture('merge-carriers');
  const home = g.settlements.find(s => s.owner === 0 && !s.building);
  const c = S.settCenter(home);
  const depot = party(g, 0, 6, c.x + 5, c.y);            // the line's destination
  const c1 = party(g, 0, 4, c.x + 2, c.y, 'supply');
  const c2 = party(g, 0, 4, c.x + 2.4, c.y + 0.3, 'supply');
  const r1 = S.opRoute(g, c1, { kind: 'blob', id: depot.id });
  const r2 = S.opRoute(g, c2, { kind: 'blob', id: depot.id });
  check('both carriers joined one line', !r1.err && !r2.err
    && g.routes.length === 1 && g.routes[0].carrierIds.length === 2,
    JSON.stringify({ r1, r2, routes: g.routes.length }));
  run(g, 400, () => !merged(g));
  check('the carriers merged into one caravan', merged(g), JSON.stringify(g.mergeLog));
  const caravan = g.blobs.find(b => !b.dead && b.order && b.order.type === 'route');
  check('the survivor carries both crews and a hold that fits them',
    !!caravan && S.total(caravan) === 8
      && (caravan.order.cargo || 0) <= S.total(caravan) * SUP.CARRY_PER_UNIT + 1e-9,
    caravan ? `${S.total(caravan)} units, cargo ${caravan.order.cargo}` : 'no caravan');
  check('the line still has a live carrier',
    g.routes.length === 1 && g.routes[0].carrierIds.length >= 1,
    JSON.stringify(g.routes.map(r => r.carrierIds)));
}

// ------------------------------- 11. save / resume

{
  console.log('a pincer survives a save/resume round trip:');
  const g = fixture('merge-save');
  const c = openSpot(g);
  const foe = party(g, 1, 10, c.x, c.y);
  const west = party(g, 0, 10, c.x - 3, c.y);
  const east = party(g, 0, 10, c.x + 3, c.y);
  S.opMove(g, west, foe.x, foe.y, { kind: 'blob', id: foe.id });
  S.opMove(g, east, foe.x, foe.y, { kind: 'blob', id: foe.id });
  run(g, 120, () => {
    const d1 = Math.hypot(west.x - foe.x, west.y - foe.y);
    const d2 = Math.hypot(east.x - foe.x, east.y - foe.y);
    return !(d1 <= S.C.MELEE_RANGE + 0.2 && d2 <= S.C.MELEE_RANGE + 0.2);
  });
  const save = JSON.parse(JSON.stringify(S.serialize(g)));
  check('the save is a clean JSON round trip', !!save && save.tick === g.tick);
  const g2 = S.deserialize(save);
  // engagedT is transient (-999 on load) — tickCombat refreshes it inside
  // the very same step() that runs tickMerge, so the veto must still hold
  for (let i = 0; i < 10; i++) { feed(g2); S.step(g2); }
  check('the resumed pincer still holds', Object.keys(g2.mergeLog).length === 0,
    JSON.stringify(g2.mergeLog));
  check('both groups are still on the map',
    g2.blobs.filter(b => !b.dead && b.owner === 0).length >= 2);
}

// ------------------------------- 12. constants + version

{
  console.log('the merge dials and engine version:');
  check('MERGE_FRAC tightened to 0.45', S.C.MERGE_FRAC === 0.45);
  check('MERGE_ARC matches the rear arc', S.C.MERGE_ARC === S.C.REAR_ARC);
  check('MERGE_HEAD_ARC is 60°', Math.abs(S.C.MERGE_HEAD_ARC - Math.PI / 3) < 1e-9);
  check('MERGE_STACK is a short co-location distance',
    S.C.MERGE_STACK > 0 && S.C.MERGE_STACK < S.C.MERGE_MIN);
  check('SIM_VERSION was bumped past 1', S.SIM_VERSION > 1);
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall merge tests passed');
process.exit(failures ? 1 : 0);
