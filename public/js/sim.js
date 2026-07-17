// Supply Line core simulation. Fixed 100 ms timestep; all state lives on
// the `game` object so save/resume is a JSON round-trip (map regenerated
// from its seed). Units exist only as counts inside blobs.

import { generateMap, findPath, passable, dist, nearestPassable } from './mapgen.js';
import * as SUP from './supply.js';

export const C = {
  DT: 0.1,                 // seconds per tick
  SPEED_DEPLOY: 1.2,       // tiles/sec
  SPEED_SUPPLY: 2.4,
  FOOD_PER_UNIT: 10,       // food meter capacity per unit
  EAT_PER_SEC: 1 / 12,     // food per unit per second
  STARVE_FRAC: 0.005,      // fraction of blob lost per tick at 0 food (5%/s — dead in ~20 s)
  K_COMBAT: 0.0035,        // casualties per enemy deploy-unit per tick
  K_SIEGE: 0.0067,         // settlement HP per deploy-unit per tick
  SETT_HP: 100,
  SETT_COST: 5,
  SETT_MIN_DIST: 8,
  STOCK_CAP: 500,
  TRAIN_TICKS: 250,        // 25 s per unit
  TRAIN_COST: 15,
  FARM_BASE: 0.009,        // stockpile per tick per unit of tilled fertility
  FARM_GROW_FLOOR: 50,     // farm-mode settlements grow farmers only above this stockpile
  FARM_CAP: 12,            // max auto-grown farmers per settlement garrison
  VISION_BLOB: 6,
  VISION_SETT: 8,
  AGGRO: 4,
  PILLAGE_RATE: 0.02,      // max food per unit per tick
  PILLAGE_RADIUS: 2.5,     // pillage harvest reach in tiles (half a territory ring)
  PILLAGE_WASTE: 4,        // fertility destroyed per food pillaged, vs the farmed value
  FOOD_PER_FERT: 100,      // food extracted per 1.0 fertility
  FERT_LEVEL: 0.25,        // one visible fertility level; scorched per tile entered while pillage-moving
  FERT_REGEN: 0.01 / 600,  // fertility per tick (0.01/min)
  TERRITORY: 5,            // settlement territory radius: feeds friendly blobs, farmer reach, drawn ring
  UNIT_HP: 100,            // individual unit health (deploy / supply)
  UNIT_HP_FARM: 10,        // farmers are 1/10th as tough
  SEP_PUSH: 1.2,           // max separation push speed, tiles/sec (= SPEED_DEPLOY)
  SEP_SLACK: 0.03,         // minimum overlap before separation acts (damps jitter)
};

export const DIFF = {
  easy:   { income: 0.8, muster: 24, expandTicks: 950, scoutTicks: 550 },
  normal: { income: 1.0, muster: 18, expandTicks: 750, scoutTicks: 450 },
  hard:   { income: 1.2, muster: 13, expandTicks: 570, scoutTicks: 350 },
};

// ---------------------------------------------------------------- helpers

export function total(b) { return b.count.deploy + b.count.supply + b.count.farm; }
export function foodCap(b) { return total(b) * C.FOOD_PER_UNIT; }
export function fedMeter(b) { const c = foodCap(b); return c > 0 ? b.food / c : 0; }
export function fedMult(m) {
  if (m >= 0.75) return 1.25;
  if (m >= 0.5) return 1.0;
  if (m >= 0.25) return 0.75;
  return 0.5;
}
export function fedLabel(m) {
  if (m >= 0.75) return 'Well-fed';
  if (m >= 0.5) return 'Fed';
  if (m >= 0.25) return 'Hungry';
  return 'Famished';
}
export function blobRadius(b) {
  return Math.max(0.4, Math.min(2.2, 0.35 * Math.sqrt(total(b)) + 0.3));
}
export function blobSpeed(b) {
  return (b.count.supply > 0 && b.count.deploy === 0 && b.count.farm === 0)
    ? C.SPEED_SUPPLY : C.SPEED_DEPLOY;
}
export function garrisonTotal(s) { return s.garrison.deploy + s.garrison.supply + s.garrison.farm; }

function tileIdx(game, x, y) { return Math.floor(y) * game.map.w + Math.floor(x); }

// -- settlement footprint: every settlement occupies a 2×2 block of
// tiles anchored at (s.x, s.y) top-left. The footprint center is the
// grid corner (s.x + 1, s.y + 1). Works for anything with {x, y}
// anchor coords (live settlements and fog-memory entries alike).
export function settCenter(s) { return { x: s.x + 1, y: s.y + 1 }; }
export function settTiles(map, s) {
  const tiles = [];
  for (let dy = 0; dy <= 1; dy++) {
    for (let dx = 0; dx <= 1; dx++) {
      const tx = s.x + dx, ty = s.y + dy;
      if (tx >= 0 && ty >= 0 && tx < map.w && ty < map.h) tiles.push(ty * map.w + tx);
    }
  }
  return tiles;
}
// A settlement counts as visible when any of its footprint tiles is.
export function settVisible(game, s) {
  for (const i of settTiles(game.map, s)) if (game.fog[i] === 2) return true;
  return false;
}

// -- per-unit records: each unit has its own hp plus a hidden seed that
// fixes the (invisible) order units absorb damage in. Max HP depends on
// role: farmers are 1/10th as tough as deploy/supply units.
export function unitMaxHP(role) { return role === 'farm' ? C.UNIT_HP_FARM : C.UNIT_HP; }
function newUnit(role) { return { role, hp: unitMaxHP(role), seed: Math.random() }; }
// Role changes convert HP proportionally (a half-dead fighter becomes a
// half-dead farmer, and vice versa).
function convertRole(u, role) {
  if (u.role === role) return;
  u.hp = u.hp / unitMaxHP(u.role) * unitMaxHP(role);
  u.role = role;
}
function unitsFromCount(count) {
  const us = [];
  for (const role of ['deploy', 'supply', 'farm']) {
    for (let k = 0; k < (count[role] | 0); k++) us.push(newUnit(role));
  }
  return us;
}
function recount(b) {
  const c = { deploy: 0, supply: 0, farm: 0 };
  for (const u of b.units) c[u.role]++;
  b.count = c;
}
export function blobHealth(b) {
  if (!b.units || !b.units.length) return 0;
  let hp = 0, max = 0;
  for (const u of b.units) { hp += u.hp; max += unitMaxHP(u.role); }
  return max > 0 ? hp / max : 0;
}

// Farmers currently working a settlement's fields (as live field blobs).
export function workingCount(game, s) {
  let n = 0;
  for (const b of game.blobs) if (!b.dead && b.working === s.id) n += total(b);
  return n;
}

// Deterministic spot inside a tilled tile (same hash placement the old
// decorative farmer sprites used).
function tilledJitter(game, i, salt) {
  const w = game.map.w;
  const h = (i * 31 + salt * 137) >>> 0;
  return {
    x: (i % w) + 0.22 + 0.56 * ((h % 13) / 13),
    y: ((i / w) | 0) + 0.22 + 0.56 * (((h >> 4) % 13) / 13),
  };
}

// Farmers spread out: each new field hand takes the least-crowded tilled
// cell (walking farmers claim their destination cell) instead of stacking.
function farmerSpot(game, s) {
  const w = game.map.w;
  if (!s.tilled.length) {
    // no fields at all — stand just outside the footprint, never on it
    const foot = new Set(settTiles(game.map, s));
    const spot = nearestPassable(game.map, s.x + 2, s.y + 1, 4, null, foot)
      || { x: s.x + 2, y: s.y + 1 };
    return tilledJitter(game, spot.y * w + spot.x, s.id);
  }
  const occ = new Map();
  for (const b of game.blobs) {
    if (b.dead || b.working !== s.id) continue;
    const g = b.pathGoal || b;
    const i = Math.floor(g.y) * w + Math.floor(g.x);
    occ.set(i, (occ.get(i) || 0) + total(b));
  }
  let best = s.tilled[0], bo = Infinity;
  for (const i of s.tilled) {
    const o = occ.get(i) || 0;
    if (o < bo) { bo = o; best = i; }
  }
  return tilledJitter(game, best, workingCount(game, s) + s.id * 17);
}

function spawnWorkingFarmer(game, s, unit) {
  const spot = farmerSpot(game, s);
  const b = makeBlob(game, s.owner, spot.x, spot.y, null, [unit || newUnit('farm')]);
  b.working = s.id;
  return b;
}

// Enemy settlement tiles a mover of `owner` knows about — impassable.
// Player blocks on visible + remembered settlements; the AI on the ones
// it has scouted (no fog cheating on player entities). In PvP each side
// has its own fog + memory.
function blockedTiles(game, owner) {
  const set = new Set();
  for (const s of game.settlements) {
    if (s.owner === owner) continue;
    const tiles = settTiles(game.map, s);
    let knows = false;
    if (game.pvp) {
      knows = !!game.knowns[owner][s.id] || tiles.some(i => game.fogs[owner][i] === 2);
    } else if (owner === 0) {
      knows = !!game.known[s.id] || tiles.some(i => game.fog[i] === 2);
    } else {
      knows = !!game.ai.known[s.id];
    }
    if (knows) for (const i of tiles) set.add(i);
  }
  return set;
}

// Fog array used for pathfinding by `owner` (null = omniscient pathing,
// which is how the solo AI behaves today).
function pathFog(game, owner) {
  if (game.pvp) return game.fogs[owner];
  return owner === 0 ? game.fog : null;
}

// ---------------------------------------------------------------- setup

export function newGame(seedStr, sizeKey, difficulty, pvp) {
  const map = generateMap(seedStr, sizeKey);
  const game = {
    seed: seedStr, sizeKey, difficulty,
    map,
    tick: 0,
    nextId: 1,
    blobs: [],
    settlements: [],
    routes: [],
    tilledBy: new Int32Array(map.w * map.h),
    settAt: new Int32Array(map.w * map.h),
    pillaged: new Set(),
    dirty: new Set(),
    fog: new Uint8Array(map.w * map.h),   // player fog: 0 unseen, 1 explored, 2 visible
    known: {},                             // player memory of enemy settlements {id:{x,y}}
    events: [],
    fx: [],                                // transient damage-feedback events (not serialized)
    combat: [],                            // this tick's engagement links (not serialized)
    mergeLog: {},                          // oldBlobId -> survivingBlobId (for UI selection)
    result: null,                          // 'win' | 'loss' | 'surrender'
    farmAlarmT: -999,                      // last "farmers ran to shelter" toast (transient)
    pillageAlarmT: -999,                   // last "land stripped bare" toast (transient)
    ai: { known: {}, lastExpand: 0, lastScout: 0, lastAttack: 0, attacking: false, armyId: null, scoutId: null, expand: null },
  };
  if (pvp) {
    game.pvp = true;
    game.me = 0;
    game.fogs = [new Uint8Array(map.w * map.h), new Uint8Array(map.w * map.h)];
    game.knowns = [{}, {}];
    game.fog = game.fogs[0];
    game.resultReason = null;
  }
  for (let side = 0; side < 2; side++) {
    const s = map.starts[side];
    const sett = foundSettlement(game, side, s.x, s.y);
    sett.stockpile = 150;
    for (let k = 0; k < 2; k++) {
      const f = spawnWorkingFarmer(game, sett);
      f.food = foodCap(f);
    }
    const b = makeBlob(game, side, s.x + 2.5, s.y + 0.5, { deploy: 10, supply: 0, farm: 0 });
    b.food = foodCap(b);
  }
  updateVision(game);
  return game;
}

// Which side this client plays. In PvP, `game.fog` stays aliased to the
// viewer's own fog array so all render/UI fog reads are viewer-relative.
export function setViewer(game, me) {
  game.me = me;
  if (game.pvp) game.fog = game.fogs[me];
}

function makeBlob(game, owner, x, y, count, units) {
  const us = (units || unitsFromCount(count)).sort((a, z) => a.seed - z.seed);
  const b = {
    id: game.nextId++, owner, x, y,
    prevX: x, prevY: y,
    units: us,
    count: { deploy: 0, supply: 0, farm: 0 },
    food: 0,
    order: null, path: null, pathGoal: null,
    pillaging: false, working: null,
    engagedT: -999, chaseId: null,
    dead: false, mergedInto: null,
    noMerge: false,               // set on split; cleared when a move order completes
    lastYieldT: game.tick,        // last tick pillaging yielded food (transient)
    starving: false,              // one-shot starvation toast latch (transient)
  };
  recount(b);
  game.blobs.push(b);
  return b;
}

// Claim the 2×2 footprint as built-over settlement ground.
function claimFootprint(game, s) {
  for (const i of settTiles(game.map, s)) {
    game.settAt[i] = s.id;
    game.dirty.add(i);
  }
}

// Farmland ring: every non-mountain, unclaimed, un-tilled tile whose
// center lies within FARM_RING of the footprint center — 20 tiles on
// open ground, closely matching the old 21-tile disc so income holds.
// The footprint itself is never tilled (it's not farmland anymore).
const FARM_RING = 2.7;
function tillFields(game, s) {
  const { w, h } = game.map;
  const c = settCenter(s);
  const span = Math.ceil(FARM_RING);
  for (let ty = s.y - span; ty <= s.y + 1 + span; ty++) {
    for (let tx = s.x - span; tx <= s.x + 1 + span; tx++) {
      if (tx < 0 || ty < 0 || tx >= w || ty >= h) continue;
      if (dist(tx + 0.5, ty + 0.5, c.x, c.y) > FARM_RING) continue;
      const i = ty * w + tx;
      if (game.map.mountain[i] || game.tilledBy[i] || game.settAt[i]) continue;
      game.tilledBy[i] = s.id;
      s.tilled.push(i);
      game.dirty.add(i);
    }
  }
}

function foundSettlement(game, owner, x, y) {
  const s = {
    id: game.nextId++, owner,
    x: Math.floor(x), y: Math.floor(y),
    hp: C.SETT_HP, mode: 'farm', stockpile: 40,
    garrison: { deploy: 0, supply: 0, farm: 0 },
    trainTicks: 0, garrLoss: 0, lastHitT: -999,
    tilled: [],
    flow: 0,       // EMA of net stockpile flow (food/tick) — gates training
    flowAcc: 0,    // this tick's flow components (transient)
  };
  claimFootprint(game, s);
  tillFields(game, s);
  game.settlements.push(s);
  // units can't share a square with an enemy settlement — nudge them off
  const foot = new Set(settTiles(game.map, s));
  for (const b of game.blobs) {
    if (b.dead || b.owner === owner) continue;
    if (foot.has(tileIdx(game, b.x, b.y))) {
      const spot = nearestPassable(game.map, s.x + 1, s.y + 1, 4, null, foot);
      if (spot) { b.x = spot.x + 0.5; b.y = spot.y + 0.5; b.path = null; b.pathGoal = null; }
    }
  }
  return s;
}

function destroySettlement(game, s, why) {
  for (const i of s.tilled) { game.tilledBy[i] = 0; game.dirty.add(i); }
  // the footprint reverts to ordinary land with its natural fertility
  for (const i of settTiles(game.map, s)) {
    if (game.settAt[i] === s.id) game.settAt[i] = 0;
    game.dirty.add(i);
  }
  for (const b of game.blobs) if (b.working === s.id) b.working = null;
  game.settlements = game.settlements.filter(x => x.id !== s.id);
  for (const r of [...game.routes]) {
    if (r.settlementId === s.id || (r.targetKind === 'settlement' && r.targetId === s.id)) {
      SUP.dissolveRoute(game, r);
    }
  }
  delete game.known[s.id];
  delete game.ai.known[s.id];
  if (game.pvp) { delete game.knowns[0][s.id]; delete game.knowns[1][s.id]; }
  game.events.push({ owner: s.owner, msg: '💥 Your settlement was destroyed!', x: s.x + 1, y: s.y + 1 });
  game.events.push({ owner: 1 - s.owner, msg: '🔥 Enemy settlement destroyed!', x: s.x + 1, y: s.y + 1 });
}

// ---------------------------------------------------------------- ops (player + AI share these)

export function opMove(game, b, x, y, attack) {
  if (b.dead) return { err: 'Gone' };
  leaveRoute(game, b);
  b.working = null;
  b.order = { type: attack ? 'attack' : 'move', x, y };
  b.chaseId = null;
  const p = findPath(game.map, b.x, b.y, x, y, pathFog(game, b.owner), blockedTiles(game, b.owner));
  if (!p) { b.order = null; return { err: 'No path there' }; }
  b.path = p; b.pathGoal = { x, y };
  return { ok: true };
}

// Field blobs may only become farmers at a friendly settlement.
export function isAtHome(game, b) {
  return game.settlements.some(s =>
    s.owner === b.owner && dist(s.x + 1, s.y + 1, b.x, b.y) <= C.TERRITORY);
}

export function opSetRole(game, b, role) {
  if (b.dead) return { err: 'Gone' };
  if (!['deploy', 'supply', 'farm'].includes(role)) return { err: 'Bad role' };
  const n = total(b);
  if (role === 'farm') {
    // farmers disperse into individual working units on the nearest
    // friendly settlement's fields (up to the farm cap)
    if (b.working != null) return { err: 'Already working the fields' };
    let s = null, bd = Infinity;
    for (const st of game.settlements) {
      if (st.owner !== b.owner) continue;
      const d = dist(st.x + 1, st.y + 1, b.x, b.y);
      if (d <= C.TERRITORY && d < bd) { bd = d; s = st; }
    }
    if (!s) return { err: 'Farmers can only be assigned at a friendly settlement' };
    const capLeft = C.FARM_CAP - workingCount(game, s);
    if (capLeft <= 0) return { err: `Farm already at capacity (${C.FARM_CAP} farmers)` };
    leaveRoute(game, b);
    b.order = null; b.path = null; b.pathGoal = null; b.chaseId = null;
    const take = Math.min(n, capLeft);
    const foodShare = b.food / n;
    for (let k = 0; k < take; k++) {
      const u = b.units.shift();
      convertRole(u, 'farm');
      const f = spawnWorkingFarmer(game, s, u);
      f.food = Math.min(foodCap(f), foodShare);
      b.food = Math.max(0, b.food - foodShare);
    }
    recount(b);
    if (b.units.length === 0) b.dead = true;
    else b.food = Math.min(b.food, foodCap(b));
    return take < n ? { ok: true, partial: true, converted: take } : { ok: true };
  }
  if (b.count[role] === n) return { err: 'Already in that role' };
  if (role !== 'supply') leaveRoute(game, b);
  b.working = null;
  for (const u of b.units) convertRole(u, role);
  recount(b);
  return { ok: true };
}

export function opSplit(game, b, takeN) {
  const n = total(b);
  if (n < 2) return { err: 'Too small to split' };
  leaveRoute(game, b);
  b.order = null; b.path = null; b.chaseId = null;
  const take = Math.max(1, Math.min(n - 1, Math.round(takeN)));
  const newCount = { deploy: 0, supply: 0, farm: 0 };
  for (const role of ['deploy', 'supply', 'farm']) {
    const share = Math.min(take, Math.round(b.count[role] * take / n));
    newCount[role] = share;
  }
  let assigned = newCount.deploy + newCount.supply + newCount.farm;
  for (const role of ['deploy', 'supply', 'farm']) {
    while (assigned < take && newCount[role] < b.count[role]) { newCount[role]++; assigned++; }
    while (assigned > take && newCount[role] > 0) { newCount[role]--; assigned--; }
  }
  if (assigned <= 0 || assigned >= n) return { err: 'Split failed' };
  const foodShare = b.food * (assigned / n);
  // move concrete unit records (hp + seed preserved) matching the shares
  const taken = [];
  for (const role of ['deploy', 'supply', 'farm']) {
    let need = newCount[role];
    for (let i = b.units.length - 1; i >= 0 && need > 0; i--) {
      if (b.units[i].role === role) { taken.push(b.units.splice(i, 1)[0]); need--; }
    }
  }
  recount(b);
  b.food -= foodShare;
  // spawn off the parent's tile, and suppress auto-merge on both halves
  // until one of them completes a deliberate move order
  const spot = nearestPassable(game.map, Math.floor(b.x + 1), Math.floor(b.y), 3, null,
    new Set([tileIdx(game, b.x, b.y)])) || { x: b.x, y: b.y };
  const nb = makeBlob(game, b.owner, spot.x + 0.5, spot.y + 0.5, null, taken);
  nb.food = foodShare;
  nb.pillaging = b.pillaging;
  b.noMerge = true;
  nb.noMerge = true;
  return { ok: true, blob: nb };
}

// A 2×2 footprint anchored at (ax, ay) fits when all four tiles are in
// bounds, non-mountain, not another settlement's farmland, and not under
// another settlement.
export function footprintFits(game, ax, ay) {
  const { w, h } = game.map;
  for (let dy = 0; dy <= 1; dy++) {
    for (let dx = 0; dx <= 1; dx++) {
      const cx = ax + dx, cy = ay + dy;
      if (cx < 0 || cy < 0 || cx >= w || cy >= h) return false;
      const i = cy * w + cx;
      if (game.map.mountain[i] || game.tilledBy[i] || game.settAt[i]) return false;
    }
  }
  return true;
}

export function canBuildAt(game, b) {
  const tx = Math.floor(b.x), ty = Math.floor(b.y);
  // try the four 2×2 placements that include the builder's tile
  let anchor = null;
  for (const [ax, ay] of [[tx, ty], [tx - 1, ty], [tx, ty - 1], [tx - 1, ty - 1]]) {
    if (footprintFits(game, ax, ay)) { anchor = { x: ax, y: ay }; break; }
  }
  if (!anchor) return { err: 'No room for a settlement here — needs a clear 2×2 area' };
  for (const s of game.settlements) {
    if (dist(s.x + 1, s.y + 1, anchor.x + 1, anchor.y + 1) < C.SETT_MIN_DIST) {
      return { err: 'Too close to another settlement' };
    }
  }
  return { ok: true, x: anchor.x, y: anchor.y };
}

export function opBuild(game, b) {
  if (total(b) < C.SETT_COST) return { err: `Needs ${C.SETT_COST} units` };
  const spot = canBuildAt(game, b);
  if (spot.err) return spot;
  b.units.splice(0, C.SETT_COST); // lowest-seed units settle down
  recount(b);
  b.food = Math.min(b.food, foodCap(b));
  const s = foundSettlement(game, b.owner, spot.x, spot.y);
  if (total(b) === 0) b.dead = true;
  return { ok: true, settlement: s };
}

export function opPillage(game, b, on) {
  if (on && !b.pillaging) b.lastYieldT = game.tick;
  b.pillaging = on;
  return { ok: true };
}

export function opRoute(game, b, target) {
  if (b.count.supply !== total(b) || total(b) === 0) {
    return { err: 'Only pure supply blobs can run routes' };
  }
  leaveRoute(game, b);
  b.order = null; b.path = null;
  return SUP.createRoute(game, b, target);
}

export function opSetMode(game, s, mode) {
  if (!['farm', 'supply', 'deploy', 'off'].includes(mode)) return { err: 'Bad mode' };
  s.mode = mode;
  return { ok: true };
}

export function opFieldGarrison(game, s) {
  const g = garrisonTotal(s);
  if (g === 0) return { err: 'No garrison' };
  const spot = nearestPassable(game.map, s.x + 2, s.y + 1, 4, null, new Set(settTiles(game.map, s)))
    || { x: s.x + 2, y: s.y + 1 };
  const b = makeBlob(game, s.owner, spot.x + 0.5, spot.y + 0.5, s.garrison);
  const give = Math.min(s.stockpile, foodCap(b));
  s.stockpile -= give;
  b.food = give;
  s.garrison = { deploy: 0, supply: 0, farm: 0 };
  return { ok: true, blob: b };
}

export function opFieldRole(game, s, role, n) {
  const avail = s.garrison[role];
  n = Math.min(n == null ? avail : n, avail);
  if (n <= 0) return { err: 'None to field' };
  if (role === 'farm') {
    // farmers go straight out to work the fields as individual units
    const capLeft = C.FARM_CAP - workingCount(game, s);
    if (capLeft <= 0) return { err: `Farm already at capacity (${C.FARM_CAP} farmers)` };
    n = Math.min(n, capLeft);
    let first = null;
    for (let k = 0; k < n; k++) {
      const b = spawnWorkingFarmer(game, s);
      s.garrison.farm--;
      const give = Math.min(s.stockpile, foodCap(b));
      s.stockpile -= give;
      b.food = give;
      if (!first) first = b;
    }
    return { ok: true, blob: first };
  }
  const spot = nearestPassable(game.map, s.x + 2, s.y + 1, 4, null, new Set(settTiles(game.map, s)))
    || { x: s.x + 2, y: s.y + 1 };
  const count = { deploy: 0, supply: 0, farm: 0 };
  count[role] = n;
  const b = makeBlob(game, s.owner, spot.x + 0.5, spot.y + 0.5, count);
  s.garrison[role] -= n;
  const give = Math.min(s.stockpile, foodCap(b));
  s.stockpile -= give;
  b.food = give;
  return { ok: true, blob: b };
}

export function opGarrisonRole(game, s, role) {
  const g = garrisonTotal(s);
  if (g === 0) return { err: 'No garrison' };
  s.garrison = { deploy: 0, supply: 0, farm: 0 };
  s.garrison[role] = g;
  return { ok: true };
}

// -- back to work: round up idle farmers (garrisoned farm units and
// farm-role units in orderless non-working blobs) and put them back on
// the fields. The plan is shared by the HUD badge (idleFarmers) and the
// op (opBackToWork) so the count always matches what a click does.

function backToWorkPlan(game, owner) {
  const setts = game.settlements.filter(s => s.owner === owner);
  // field slots left per *safe* settlement; unsafe ones take no farmers
  const room = new Map();
  for (const s of setts) {
    if (!settlementInDanger(game, s)) {
      room.set(s.id, Math.max(0, C.FARM_CAP - workingCount(game, s)));
    }
  }
  const plan = { garrison: [], home: [], walk: [], sawIdle: false, sawDanger: false };
  for (const s of setts) {
    if (s.garrison.farm <= 0) continue;
    plan.sawIdle = true;
    if (!room.has(s.id)) { plan.sawDanger = true; continue; }
    const n = Math.min(s.garrison.farm, room.get(s.id));
    if (n > 0) { plan.garrison.push({ s, n }); room.set(s.id, room.get(s.id) - n); }
  }
  for (const b of game.blobs) {
    if (b.dead || b.owner !== owner || b.working != null || b.order || b.count.farm <= 0) continue;
    // nearest safe settlement with room, at home and anywhere
    let homeSett = null, hd = Infinity, atHomeOfAny = false;
    let walkSett = null, wd = Infinity;
    for (const s of setts) {
      const d = dist(s.x + 1, s.y + 1, b.x, b.y);
      if (d <= C.TERRITORY) atHomeOfAny = true;
      if (!(room.get(s.id) > 0)) continue;
      if (d <= C.TERRITORY && d < hd) { hd = d; homeSett = s; }
      if (d < wd) { wd = d; walkSett = s; }
    }
    const pure = b.count.farm === total(b);
    if (homeSett) {
      plan.sawIdle = true;
      const n = Math.min(b.count.farm, room.get(homeSett.id));
      plan.home.push({ b, s: homeSett, n });
      room.set(homeSett.id, room.get(homeSett.id) - n);
    } else if (pure && walkSett) {
      plan.sawIdle = true;
      plan.walk.push({ b, s: walkSett });
    } else if (pure || atHomeOfAny) {
      // idle farmers with nowhere to go right now — remember why
      plan.sawIdle = true;
      if (setts.length > room.size) plan.sawDanger = true;
    }
  }
  return plan;
}

export function idleFarmers(game, owner) {
  const plan = backToWorkPlan(game, owner);
  let field = 0, walk = 0;
  for (const g of plan.garrison) field += g.n;
  for (const h of plan.home) field += h.n;
  for (const w of plan.walk) walk += w.b.count.farm;
  return { field, walk };
}

// Peel only the farm-role units out of an idle blob onto a settlement's
// fields — mixed blobs keep their soldiers/suppliers where they stand.
function peelFarmersToFields(game, b, s, n) {
  const tot = total(b);
  const foodShare = tot > 0 ? b.food / tot : 0;
  let moved = 0;
  for (let i = b.units.length - 1; i >= 0 && moved < n; i--) {
    if (b.units[i].role !== 'farm') continue;
    const u = b.units.splice(i, 1)[0];
    const f = spawnWorkingFarmer(game, s, u);
    f.food = Math.min(foodCap(f), foodShare);
    b.food = Math.max(0, b.food - foodShare);
    moved++;
  }
  recount(b);
  if (b.units.length === 0) b.dead = true;
  else b.food = Math.min(b.food, foodCap(b));
  return moved;
}

export function opBackToWork(game, owner) {
  const plan = backToWorkPlan(game, owner);
  let fielded = 0, walking = 0;
  for (const { s, n } of plan.garrison) {
    if (opFieldRole(game, s, 'farm', n).ok) fielded += n;
  }
  for (const { b, s, n } of plan.home) {
    if (!b.dead) fielded += peelFarmersToFields(game, b, s, n);
  }
  for (const { b, s } of plan.walk) {
    if (!b.dead && opMove(game, b, s.x + 1, s.y + 1, false).ok) walking += b.count.farm;
  }
  if (fielded + walking === 0) {
    return { fielded, walking, reason: plan.sawIdle ? (plan.sawDanger ? 'danger' : 'cap') : 'none' };
  }
  return { fielded, walking };
}

function leaveRoute(game, b) {
  if (b.order && b.order.type === 'route') {
    const r = SUP.findRoute(game, b.order.routeId);
    b.food = Math.min(foodCap(b), b.food + (b.order.cargo || 0));
    b.order = null;
    if (r) SUP.removeCarrier(game, r, b.id);
  }
}

// ---------------------------------------------------------------- queries for UI

export function blobAt(game, wx, wy, maxD) {
  let best = null, bd = maxD;
  for (const b of game.blobs) {
    if (b.dead) continue;
    const d = dist(b.x, b.y, wx, wy) - blobRadius(b);
    if (d < bd) { bd = d; best = b; }
  }
  return best;
}
export function settlementAt(game, wx, wy, maxD) {
  let best = null, bd = maxD;
  for (const s of game.settlements) {
    const d = dist(s.x + 1, s.y + 1, wx, wy);
    if (d < bd) { bd = d; best = s; }
  }
  return best;
}
export function unitCounts(game, owner) {
  let units = 0, setts = 0;
  for (const b of game.blobs) if (!b.dead && b.owner === owner) units += total(b);
  for (const s of game.settlements) if (s.owner === owner) { setts++; units += garrisonTotal(s); }
  return { units, setts };
}

// ---------------------------------------------------------------- tick

export function step(game) {
  if (game.result) return;
  game.tick++;

  for (const b of game.blobs) {
    if (b.dead) continue;
    b.prevX = b.x; b.prevY = b.y; // for render interpolation
    if (b.order && b.order.type === 'route') tickCarrier(game, b);
    else tickOrder(game, b);
  }

  tickSeparation(game);
  tickCombat(game);
  for (const b of game.blobs) if (!b.dead) tickFood(game, b);
  for (const s of [...game.settlements]) tickSettlement(game, s);

  if (game.tick % 10 === 0) tickRegen(game);
  if (game.tick % 5 === 0) { tickFarmerSafety(game); tickMerge(game); updateVision(game); }
  if (game.tick % 25 === 0) tickFarmerSpread(game);
  cleanup(game);
  if (game.fx.length) game.fx = game.fx.filter(f => game.tick - f.t < 15);
  if (game.tick % 10 === 0) checkResult(game);
}

function pushFx(game, fx) {
  game.fx.push(fx);
  if (game.fx.length > 200) game.fx.splice(0, game.fx.length - 200);
}

// -- movement / orders

function ensurePath(game, b, x, y) {
  const p = findPath(game.map, b.x, b.y, x, y, pathFog(game, b.owner), blockedTiles(game, b.owner));
  b.path = p;
  b.pathGoal = p ? { x, y } : null;
  return !!p;
}

// Player paths are planned optimistically through unexplored fog; once an
// upcoming waypoint's tile is revealed to be a mountain (or a newly-known
// enemy settlement), the path is wrong and the blob must replan.
function pathBlocked(game, b) {
  if (!b.path) return false;
  const blocked = blockedTiles(game, b.owner);
  const w = game.map.w;
  const fog = pathFog(game, b.owner);
  // a mountain the mover knows about: the player (or pvp side) sees explored
  // terrain only; the AI is omniscient (its paths never contain one anyway)
  const knownMountain = ti => game.map.mountain[ti] && (!fog || fog[ti] > 0);
  let px = Math.floor(b.x), py = Math.floor(b.y);
  const n = Math.min(3, b.path.length);
  for (let i = 0; i < n; i++) {
    const wp = b.path[i];
    const x = Math.floor(wp.x), y = Math.floor(wp.y);
    const ti = y * w + x;
    if (blocked.has(ti)) return true;
    if (knownMountain(ti)) return true;
    // diagonal step that would cut past a revealed mountain corner
    if (x !== px && y !== py && (knownMountain(py * w + x) || knownMountain(y * w + px))) return true;
    px = x; py = y;
  }
  return false;
}

function moveBlob(game, b) {
  if (!b.path || !b.path.length) return true;
  const blocked = blockedTiles(game, b.owner);
  let remaining = blobSpeed(b) * C.DT;
  while (remaining > 0 && b.path.length) {
    const wp = b.path[0];
    // never step onto a known enemy settlement tile or any mountain tile
    // (mountains are static — no unit may ever occupy one, fog or not);
    // stall and let the pathBlocked replan route around it next tick
    const wi = Math.floor(wp.y) * game.map.w + Math.floor(wp.x);
    if (blocked.has(wi) || game.map.mountain[wi]) return false;
    const d = dist(b.x, b.y, wp.x, wp.y);
    if (d <= remaining) {
      b.x = wp.x; b.y = wp.y;
      b.path.shift();
      remaining -= d;
    } else {
      b.x += (wp.x - b.x) / d * remaining;
      b.y += (wp.y - b.y) / d * remaining;
      remaining = 0;
    }
  }
  return b.path.length === 0;
}

function tickOrder(game, b) {
  if (!b.order) return;
  const o = b.order;
  if (o.type === 'move' || o.type === 'attack') {
    // attack-movers chase enemies inside aggro
    if (o.type === 'attack' && b.count.deploy > 0) {
      let tgt = null, bd = C.AGGRO;
      for (const e of game.blobs) {
        if (e.dead || e.owner === b.owner) continue;
        const d = dist(b.x, b.y, e.x, e.y);
        if (d < bd) { bd = d; tgt = e; }
      }
      if (tgt) {
        b.chaseId = tgt.id;
        const inRange = dist(b.x, b.y, tgt.x, tgt.y) <= blobRadius(b) + blobRadius(tgt) + 0.15;
        if (!inRange) {
          if (game.tick % 10 === 0 || !b.path || !b.path.length || pathBlocked(game, b)) ensurePath(game, b, tgt.x, tgt.y);
          moveBlob(game, b);
        }
        return;
      }
      if (b.chaseId) { b.chaseId = null; ensurePath(game, b, o.x, o.y); }
      // engaged with a settlement? stand and fight
      if (game.tick - b.engagedT < 5) return;
    }
    if (!b.path && b.pathGoal == null) ensurePath(game, b, o.x, o.y); // resumed save
    if (pathBlocked(game, b) && !ensurePath(game, b, o.x, o.y)) {
      // walled in by explored mountains — the optimistic plan was wrong
      b.order = null; b.pathGoal = null;
      game.events.push({ owner: b.owner, msg: '⛰️ No way through — order cancelled', x: b.x, y: b.y });
      return;
    }
    const arrived = moveBlob(game, b);
    if (arrived) {
      b.order = null;
      b.pathGoal = null;
      b.noMerge = false; // completed a deliberate move — mergeable again
      // working farmers walking to a new field cell stay in the fields
      if (o.type === 'move' && b.working == null) {
        const s = game.settlements.find(s2 => s2.owner === b.owner && dist(s2.x + 1, s2.y + 1, b.x, b.y) < 1.9);
        if (s) { // garrison
          s.garrison.deploy += b.count.deploy;
          s.garrison.supply += b.count.supply;
          s.garrison.farm += b.count.farm;
          s.stockpile = Math.min(C.STOCK_CAP, s.stockpile + b.food);
          b.dead = true;
        }
      }
    }
  }
}

// -- supply carriers

function targetPos(tgt, kind) {
  return kind === 'blob' ? { x: tgt.x, y: tgt.y } : settCenter(tgt);
}

// No way through to this leg's destination (revealed mountains walled it
// off) — release the carrier instead of pacing at the wall forever. It
// keeps as much of its cargo as it can carry as its own food.
function releaseBlockedCarrier(game, b, route) {
  b.food = Math.min(foodCap(b), b.food + (b.order.cargo || 0));
  SUP.removeCarrier(game, route, b.id);
  b.order = null;
  game.events.push({ msg: '⛰️ Supply route blocked', x: b.x, y: b.y });
}

function tickCarrier(game, b) {
  const o = b.order;
  const route = SUP.findRoute(game, o.routeId);
  if (!route) { b.order = null; return; }
  if (pathBlocked(game, b)) b.path = null; // discovered a mountain; each phase replans below
  const src = SUP.routeSource(game, route);
  const tgt = SUP.routeTarget(game, route);
  if (!src || !tgt) { SUP.dissolveRoute(game, route); return; }
  const cap = total(b) * SUP.CARRY_PER_UNIT;

  if (o.phase === 'load') {
    if (dist(b.x, b.y, src.x + 1, src.y + 1) > 2.7) {
      if (!b.path || !b.path.length) { if (!ensurePath(game, b, src.x + 1, src.y + 1)) { SUP.removeCarrier(game, route, b.id); b.order = null; return; } }
      moveBlob(game, b);
      return;
    }
    b.path = null;
    const take = Math.min(cap - o.cargo, src.stockpile, cap / 20);
    src.stockpile -= take; o.cargo += take;
    const self = Math.min(foodCap(b) - b.food, src.stockpile, total(b) * 0.1);
    src.stockpile -= self; b.food += self;
    src.flowAcc = (src.flowAcc || 0) - take - self;
    if (o.cargo >= cap - 0.01) { o.phase = 'go'; o.wait = 0; b.path = null; }
    else if (src.stockpile <= 0.01) {
      o.wait++;
      if (o.wait > 50 && o.cargo > 1) { o.phase = 'go'; o.wait = 0; b.path = null; }
    }
  } else if (o.phase === 'go') {
    const tp = targetPos(tgt, route.targetKind);
    if (dist(b.x, b.y, tp.x, tp.y) <= 2.5) { o.phase = 'unload'; b.path = null; return; }
    const stale = b.pathGoal && dist(b.pathGoal.x, b.pathGoal.y, tp.x, tp.y) > 2.5;
    if (!b.path || !b.path.length || (stale && game.tick % 20 === 0)) {
      if (!ensurePath(game, b, tp.x, tp.y)) { releaseBlockedCarrier(game, b, route); return; }
    }
    moveBlob(game, b);
  } else if (o.phase === 'unload') {
    const tp = targetPos(tgt, route.targetKind);
    if (dist(b.x, b.y, tp.x, tp.y) > 3.1) { o.phase = 'go'; return; }
    const give = Math.min(o.cargo, cap / 20);
    let taken = 0;
    if (route.targetKind === 'blob') {
      const room = foodCap(tgt) - tgt.food;
      taken = Math.min(give, room);
      tgt.food += taken;
    } else {
      const room = C.STOCK_CAP - tgt.stockpile;
      taken = Math.min(give, room);
      tgt.stockpile += taken;
      tgt.flowAcc = (tgt.flowAcc || 0) + taken;
    }
    o.cargo -= taken;
    if (taken > 0) SUP.recordDelivery(game, route, taken);
    if (o.cargo <= 0.01 || taken <= 0.001) { o.phase = 'return'; b.path = null; }
  } else { // return
    if (dist(b.x, b.y, src.x + 1, src.y + 1) <= 2.7) { o.phase = 'load'; o.wait = 0; b.path = null; return; }
    if (!b.path || !b.path.length) {
      if (!ensurePath(game, b, src.x + 1, src.y + 1)) { releaseBlockedCarrier(game, b, route); return; }
    }
    moveBlob(game, b);
  }
}

// -- separation: soft push-apart so blobs never rest overlapped (#28).
// Stateless per tick; runs after movement, before combat. Pairs whose
// overlap is load-bearing are exempt: working farmers (one per tilled
// cell by design), a carrier unloading onto its own route's target blob
// (touching distance can exceed the 2.0 unload radius), and potentially
// mergeable same-owner pairs (merge fires at ≤0.8, well inside touching).

function sepExempt(game, a, b) {
  if (a.working != null || b.working != null) return true;
  const aRoute = a.order && a.order.type === 'route';
  const bRoute = b.order && b.order.type === 'route';
  if (aRoute) {
    const r = SUP.findRoute(game, a.order.routeId);
    if (r && r.targetKind === 'blob' && r.targetId === b.id) return true;
  }
  if (bRoute) {
    const r = SUP.findRoute(game, b.order.routeId);
    if (r && r.targetKind === 'blob' && r.targetId === a.id) return true;
  }
  return a.owner === b.owner && a.pillaging === b.pillaging
    && !(a.noMerge && b.noMerge) && !aRoute && !bRoute;
}

function tickSeparation(game) {
  const alive = game.blobs.filter(b => !b.dead);
  if (alive.length < 2) return;
  const push = new Map(); // blob -> accumulated displacement {x, y}
  for (let i = 0; i < alive.length; i++) {
    for (let j = i + 1; j < alive.length; j++) {
      const a = alive[i], b = alive[j];
      if (sepExempt(game, a, b)) continue;
      const d = dist(a.x, a.y, b.x, b.y);
      const ov = blobRadius(a) + blobRadius(b) - d;
      if (ov <= C.SEP_SLACK) continue;
      let nx, ny;
      if (d < 0.001) {
        // coincident centers: deterministic axis from the pair's ids
        // (no Math.random(), so host/guest dead-reckoning stays aligned)
        const ang = ((a.id * 31 + b.id * 131) % 1024) / 1024 * Math.PI * 2;
        nx = Math.cos(ang); ny = Math.sin(ang);
      } else {
        nx = (a.x - b.x) / d; ny = (a.y - b.y) / d;
      }
      // mass-weighted: the heavier blob gives ground more slowly
      const ma = total(a), mb = total(b);
      const wa = mb / (ma + mb), wb = ma / (ma + mb);
      const pa = push.get(a) || push.set(a, { x: 0, y: 0 }).get(a);
      const pb = push.get(b) || push.set(b, { x: 0, y: 0 }).get(b);
      pa.x += nx * ov * wa; pa.y += ny * ov * wa;
      pb.x -= nx * ov * wb; pb.y -= ny * ov * wb;
    }
  }
  if (!push.size) return;
  const settOwner = new Map(); // settlement tile -> owner
  for (const s of game.settlements) settOwner.set(s.y * game.map.w + s.x, s.owner);
  const okTile = (b, x, y) => {
    const tx = Math.floor(x), ty = Math.floor(y);
    if (!passable(game.map, tx, ty)) return false;
    const so = settOwner.get(ty * game.map.w + tx);
    return so === undefined || so === b.owner;
  };
  const max = C.SEP_PUSH * C.DT;
  for (const [b, v] of push) {
    // final approach: an ordered blob one waypoint from its goal has
    // right-of-way — it pushes others but is never pushed itself, so a
    // squatter can't stall garrisoning / field walks / AI settle parties
    if (b.order && (b.order.type === 'move' || b.order.type === 'attack')
      && b.path && b.path.length <= 1) continue;
    let vx = v.x, vy = v.y;
    const m = Math.sqrt(vx * vx + vy * vy);
    if (m < 1e-6) continue;
    if (m > max) { vx = vx / m * max; vy = vy / m * max; }
    if (okTile(b, b.x + vx, b.y + vy)) { b.x += vx; b.y += vy; }
    else if (okTile(b, b.x + vx, b.y)) b.x += vx;
    else if (okTile(b, b.x, b.y + vy)) b.y += vy;
    // all three blocked (pinned against terrain): drop the push this tick
  }
}

// -- combat

function tickCombat(game) {
  game.combat = []; // rebuilt every tick — engaged pairs re-register while in contact
  const alive = game.blobs.filter(b => !b.dead);
  const dmg = new Map();
  for (let i = 0; i < alive.length; i++) {
    for (let j = i + 1; j < alive.length; j++) {
      const a = alive[i], b = alive[j];
      if (a.owner === b.owner) continue;
      const d = dist(a.x, a.y, b.x, b.y);
      if (d > blobRadius(a) + blobRadius(b) + 0.2) continue;
      a.engagedT = game.tick; b.engagedT = game.tick;
      game.combat.push({ kind: 'bb', a: a.id, b: b.id });
      dmg.set(a, (dmg.get(a) || 0) + b.count.deploy * fedMult(fedMeter(b)) * C.K_COMBAT);
      dmg.set(b, (dmg.get(b) || 0) + a.count.deploy * fedMult(fedMeter(a)) * C.K_COMBAT);
    }
  }
  // settlements
  for (const s of [...game.settlements]) {
    for (const b of alive) {
      if (b.dead || b.owner === s.owner || b.count.deploy === 0) continue;
      const d = dist(b.x, b.y, s.x + 1, s.y + 1);
      if (d > blobRadius(b) + 1.9) continue;
      b.engagedT = game.tick;
      s.lastHitT = game.tick;
      game.combat.push({ kind: 'bs', b: b.id, s: s.id });
      const attack = b.count.deploy * fedMult(fedMeter(b));
      const gd = s.garrison.deploy;
      if (garrisonTotal(s) > 0) {
        // garrison defends first; fed from stockpile
        const gMult = s.stockpile > 0 ? 1.25 : 0.5;
        dmg.set(b, (dmg.get(b) || 0) + gd * gMult * C.K_COMBAT);
        applyGarrisonLosses(game, s, attack * C.K_COMBAT);
      } else {
        const hpDmg = attack * C.K_SIEGE;
        s.hp -= hpDmg;
        // throttled floating damage numbers: one per whole HP lost
        s.hpFxAcc = (s.hpFxAcc || 0) + hpDmg;
        if (s.hpFxAcc >= 1) {
          const n = Math.floor(s.hpFxAcc);
          s.hpFxAcc -= n;
          pushFx(game, { kind: 'hp', x: s.x + 1, y: s.y + 1, n, t: game.tick });
        }
      }
      if (s.hp <= 0) { destroySettlement(game, s); break; }
    }
  }
  for (const [b, d] of dmg) {
    // working farmers under fire: alert their settlement (drives the AI's
    // defend reflex) and send the whole field crew running for shelter
    if (b.working != null) {
      const s = game.settlements.find(x => x.id === b.working);
      if (s) { s.lastHitT = game.tick; shelterFarmers(game, s); }
    }
    applyLosses(game, b, d);
  }
}

// -- farmer safety: working farmers shelter in their settlement when
// threatened, then walk back out to the fields once the area is quiet.

// An enemy war party close enough that fielded farmers would immediately
// re-shelter — shared by the auto-return tick and opBackToWork.
function settlementInDanger(game, s) {
  for (const e of game.blobs) {
    if (e.dead || e.owner === s.owner || e.count.deploy === 0) continue;
    if (dist(e.x, e.y, s.x + 1, s.y + 1) <= C.TERRITORY + C.AGGRO) return true;
  }
  return false;
}

function shelterFarmers(game, s) {
  let any = false;
  for (const b of game.blobs) {
    if (b.dead || b.working !== s.id) continue;
    if (opMove(game, b, s.x + 1, s.y + 1, false).ok) any = true;
    else b.working = null; // no path home — at least stop working
  }
  if (any && game.tick - game.farmAlarmT > 100) {
    game.farmAlarmT = game.tick;
    game.events.push({ owner: s.owner, msg: '🌱 Your farmers ran to shelter!', x: s.x + 1, y: s.y + 1 });
  }
}

function tickFarmerSafety(game) {
  // flee: an enemy war party near any working farmer (or a fresh hit on
  // the settlement) sends that settlement's whole field crew home
  const threatened = new Set();
  for (const b of game.blobs) {
    if (b.dead || b.working == null || threatened.has(b.working)) continue;
    const s = game.settlements.find(x => x.id === b.working);
    if (!s) { b.working = null; continue; }
    if (game.tick - s.lastHitT < 30) { threatened.add(s.id); continue; }
    for (const e of game.blobs) {
      if (e.dead || e.owner === b.owner || e.count.deploy === 0) continue;
      if (dist(e.x, e.y, b.x, b.y) <= C.AGGRO) { threatened.add(s.id); break; }
    }
  }
  for (const id of threatened) {
    const s = game.settlements.find(x => x.id === id);
    if (s) shelterFarmers(game, s);
  }
  // return: sheltered farmers head back out once it's been quiet a while
  if (game.tick % 50 === 0) {
    for (const s of game.settlements) {
      if (s.garrison.farm <= 0 || game.tick - s.lastHitT <= 300) continue;
      const capLeft = C.FARM_CAP - workingCount(game, s);
      if (capLeft <= 0) continue;
      if (!settlementInDanger(game, s)) opFieldRole(game, s, 'farm', Math.min(s.garrison.farm, capLeft));
    }
  }
}

// -- farmer spreading: field hands standing on the same cell drift apart
// so each works its own tilled cell where space allows. The walk order
// keeps `working` set (see tickOrder), so income and safety still apply.

function tickFarmerSpread(game) {
  const w = game.map.w;
  for (const s of game.settlements) {
    let idle = null; // tileIdx -> working farmers standing there, orderless
    const claimed = new Set();
    for (const b of game.blobs) {
      if (b.dead || b.working !== s.id) continue;
      if (b.order) {
        if (b.pathGoal) claimed.add(Math.floor(b.pathGoal.y) * w + Math.floor(b.pathGoal.x));
        continue;
      }
      const i = Math.floor(b.y) * w + Math.floor(b.x);
      if (!idle) idle = new Map();
      if (!idle.has(i)) idle.set(i, []);
      idle.get(i).push(b);
    }
    if (!idle) continue;
    const free = s.tilled.filter(i => !idle.has(i) && !claimed.has(i));
    for (const stack of idle.values()) {
      while (stack.length > 1 && free.length) {
        const b = stack.pop();
        const spot = tilledJitter(game, free.shift(), b.id);
        b.order = { type: 'move', x: spot.x, y: spot.y };
        if (!ensurePath(game, b, spot.x, spot.y)) b.order = null;
      }
    }
  }
}

// Damage lands on the living unit with the lowest hidden seed first,
// spilling to the next once it dies. `casualties` is in whole-unit
// equivalents (1 casualty = UNIT_HP damage).
function applyLosses(game, b, casualties) {
  if (casualties <= 0 || b.dead) return;
  let dmgHP = casualties * C.UNIT_HP;
  let removed = 0;
  while (dmgHP > 0.0001 && b.units.length) {
    const u = b.units[0]; // units kept sorted ascending by seed
    const take = Math.min(u.hp, dmgHP);
    u.hp -= take;
    dmgHP -= take;
    if (u.hp <= 0.0001) { b.units.shift(); removed++; }
  }
  if (removed > 0) {
    recount(b);
    pushFx(game, { kind: 'loss', x: b.x, y: b.y, n: removed, t: game.tick });
    b.food = Math.min(b.food, foodCap(b));
  }
  if (b.units.length === 0) b.dead = true;
}

function applyGarrisonLosses(game, s, casualties) {
  s.garrLoss += casualties;
  let whole = Math.floor(s.garrLoss);
  if (whole <= 0) return;
  s.garrLoss -= whole;
  let removed = 0;
  while (whole > 0 && garrisonTotal(s) > 0) {
    let role = 'deploy';
    if (s.garrison.supply > s.garrison[role]) role = 'supply';
    if (s.garrison.farm > s.garrison[role]) role = 'farm';
    s.garrison[role]--;
    whole--; removed++;
  }
  if (removed > 0) pushFx(game, { kind: 'loss', x: s.x + 1, y: s.y + 1, n: removed, t: game.tick });
}

// -- food / pillage / starvation

// Tiles a pillaging blob is stripping right now: a fixed camp-sized
// disc around the army (every non-mountain tile whose center lies
// within PILLAGE_RADIUS), the same for all army sizes. Sorted
// nearest-first so the per-cell-capped harvest drains the land
// center-out. Shared with the renderer so the on-screen grid
// highlights match the sim exactly.
export function pillageCells(game, b) {
  const cx = Math.floor(b.x), cy = Math.floor(b.y);
  const { w, h } = game.map;
  const reach = C.PILLAGE_RADIUS;
  const span = Math.ceil(reach);
  const cells = [];
  for (let dy = -span; dy <= span; dy++) {
    for (let dx = -span; dx <= span; dx++) {
      const tx = cx + dx, ty = cy + dy;
      if (tx < 0 || ty < 0 || tx >= w || ty >= h) continue;
      const d = dist(tx + 0.5, ty + 0.5, b.x, b.y);
      if (d > reach) continue;
      const i = ty * w + tx;
      if (game.map.mountain[i] || game.settAt[i]) continue;
      cells.push({ i, d });
    }
  }
  cells.sort((a, c) => a.d - c.d || a.i - c.i);
  return cells.map(c => c.i);
}

function tickFood(game, b) {
  const n = total(b);
  b.food = Math.max(0, b.food - n * C.EAT_PER_SEC * C.DT);
  let gained = 0; // food the land yielded this tick (for stripped-land feedback)
  if (b.pillaging) {
    // scorched earth: every tile entered while pillage-moving instantly
    // loses 1 fertility level (2 for armies of 10+). The fertility is
    // destroyed outright — food only ever comes from the rate-limited
    // harvest below, so pillaging yields at the same rate whether the
    // army is walking or standing still.
    const ci = tileIdx(game, b.x, b.y);
    const pi = tileIdx(game, b.prevX, b.prevY);
    if (ci !== pi && !game.map.mountain[ci] && !game.settAt[ci]) {
      const loss = Math.min(game.map.fert[ci], C.FERT_LEVEL * (n >= 10 ? 2 : 1));
      if (loss > 0.0001) {
        game.map.fert[ci] -= loss;
        game.pillaged.add(ci);
        game.dirty.add(ci);
      }
    }
    let budget = Math.min(foodCap(b) - b.food, n * C.PILLAGE_RATE);
    if (budget > 0.0001) {
      // Foraging is wasteful (PILLAGE_WASTE× the fertility a farm would
      // spend per food), and tiles below half a level — the point where
      // they display as Barren — yield nothing, so stripped land really
      // stops feeding the army.
      for (const i of pillageCells(game, b)) {
        if (budget <= 0.0001) break;
        const avail = Math.max(0, game.map.fert[i] - C.FERT_LEVEL / 2)
          * C.FOOD_PER_FERT / C.PILLAGE_WASTE;
        const take = Math.min(budget, avail, C.PILLAGE_RATE * n / 4);
        if (take <= 0.0001) continue;
        game.map.fert[i] -= take * C.PILLAGE_WASTE / C.FOOD_PER_FERT;
        b.food += take;
        gained += take;
        budget -= take;
        game.pillaged.add(i);
        game.dirty.add(i);
      }
    }
    if (gained > 0.001) b.lastYieldT = game.tick;
    else if (fedMeter(b) < 0.5
      && game.tick - (b.lastYieldT || 0) > 100 && game.tick - game.pillageAlarmT > 100) {
      game.pillageAlarmT = game.tick;
      game.events.push({ owner: b.owner, msg: '🍂 The land here is stripped bare!', x: b.x, y: b.y });
    }
  }
  if (b.food <= 0.0001) {
    if (!b.starving) {
      b.starving = true;
      game.events.push({ owner: b.owner, msg: '💀 Your army is starving!', x: b.x, y: b.y });
    }
    applyStarvation(game, b);
  } else if (b.starving && fedMeter(b) > 0.1) {
    b.starving = false;
  }
}

// At zero food every unit wastes away together: each loses STARVE_FRAC of
// its own max HP per tick, so a full-health blob is gone in ~20 s.
function applyStarvation(game, b) {
  let removed = 0;
  for (let i = b.units.length - 1; i >= 0; i--) {
    const u = b.units[i];
    u.hp -= C.STARVE_FRAC * unitMaxHP(u.role);
    if (u.hp <= 0.0001) { b.units.splice(i, 1); removed++; }
  }
  if (removed > 0) {
    recount(b);
    pushFx(game, { kind: 'loss', x: b.x, y: b.y, n: removed, t: game.tick });
    b.food = Math.min(b.food, foodCap(b));
  }
  if (b.units.length === 0) b.dead = true;
}

function tickRegen(game) {
  for (const i of game.pillaged) {
    const orig = game.map.orig[i];
    game.map.fert[i] = Math.min(orig, game.map.fert[i] + C.FERT_REGEN * 10);
    game.dirty.add(i);
    if (game.map.fert[i] >= orig - 0.0001) game.pillaged.delete(i);
  }
}

// -- settlements

// A settlement trains a new consumer only while its measured net food
// flow can carry one more mouth.
export function trainGated(s) { return s.flow < C.EAT_PER_SEC * C.DT; }

function tickSettlement(game, s) {
  if (!game.settlements.includes(s)) return;
  const aiMult = (!game.pvp && s.owner === 1) ? DIFF[game.difficulty].income : 1;
  // farmland income accrues in every mode (boosted by farmers actually
  // working the fields) — training modes pick what the surplus becomes
  let fertSum = 0;
  for (const i of s.tilled) fertSum += game.map.fert[i];
  const income = fertSum * C.FARM_BASE * (1 + 0.1 * workingCount(game, s)) * aiMult;
  s.stockpile = Math.min(C.STOCK_CAP, s.stockpile + income);
  s.flowAcc = (s.flowAcc || 0) + income;
  if (s.mode === 'farm') {
    // healthy farms grow population: surplus food becomes new farmers who
    // walk straight out to the fields; past the cap, growth trains deploy
    // units into the garrison instead (those are pure consumers, so they
    // gate on the break-even food flow)
    if (s.stockpile >= C.FARM_GROW_FLOOR) {
      const atCap = workingCount(game, s) >= C.FARM_CAP;
      if (!atCap || !trainGated(s)) {
        s.trainTicks++;
        if (s.trainTicks >= C.TRAIN_TICKS) {
          s.trainTicks = 0;
          s.stockpile -= C.TRAIN_COST;
          if (!atCap) {
            const f = spawnWorkingFarmer(game, s);
            const give = Math.min(s.stockpile, foodCap(f));
            s.stockpile -= give;
            f.food = give;
          } else {
            s.garrison.deploy++;
          }
        }
      }
    } else {
      s.trainTicks = 0;
    }
  } else if (s.mode === 'supply' || s.mode === 'deploy') {
    if (s.stockpile >= C.TRAIN_COST && !trainGated(s)) {
      s.trainTicks++;
      if (s.trainTicks >= C.TRAIN_TICKS) {
        s.trainTicks = 0;
        s.stockpile -= C.TRAIN_COST;
        s.garrison[s.mode === 'supply' ? 'supply' : 'deploy']++;
      }
    }
  } else {
    s.trainTicks = 0; // 'off': stockpile food, train nothing
  }
  // garrison eats from the stockpile; starves when it's empty
  const g = garrisonTotal(s);
  if (g > 0) {
    const eat = g * C.EAT_PER_SEC * C.DT;
    if (s.stockpile >= eat) { s.stockpile -= eat; s.flowAcc -= eat; }
    else { s.flowAcc -= s.stockpile; s.stockpile = 0; applyGarrisonLosses(game, s, g * C.STARVE_FRAC); }
  }
  // feed friendly blobs inside the territory
  if (s.stockpile > 0.01) {
    for (const b of game.blobs) {
      if (b.dead || b.owner !== s.owner) continue;
      if (dist(b.x, b.y, s.x + 1, s.y + 1) > C.TERRITORY) continue;
      const need = foodCap(b) - b.food;
      if (need <= 0) continue;
      const give = Math.min(need, s.stockpile, total(b) * 0.1);
      s.stockpile -= give;
      s.flowAcc -= give;
      b.food += give;
      if (s.stockpile <= 0.01) break;
    }
  }
  // fold this tick's flow into the EMA (~10 s half-life). One-time
  // transfers (train costs, garrison deposits, fielding grants) are
  // deliberately excluded from flowAcc so the gate doesn't oscillate.
  s.flow += ((s.flowAcc || 0) - s.flow) * 0.007;
  s.flowAcc = 0;
}

// -- merge / cleanup / vision / result

function tickMerge(game) {
  const alive = game.blobs.filter(b => !b.dead);
  for (let i = 0; i < alive.length; i++) {
    const a = alive[i];
    if (a.dead || a.order || a.working != null) continue;
    for (let j = i + 1; j < alive.length; j++) {
      const b = alive[j];
      if (b.dead || b.order || b.working != null || a.owner !== b.owner) continue;
      if (a.pillaging !== b.pillaging) continue;
      if (a.noMerge && b.noMerge) continue; // freshly split pair — stays apart
      if (dist(a.x, a.y, b.x, b.y) > 0.8) continue;
      const keep = total(a) >= total(b) ? a : b;
      const gone = keep === a ? b : a;
      keep.units = keep.units.concat(gone.units).sort((u, v) => u.seed - v.seed);
      recount(keep);
      keep.food = Math.min(foodCap(keep), keep.food + gone.food);
      gone.dead = true;
      gone.mergedInto = keep.id;
      game.mergeLog[gone.id] = keep.id;
      // re-point any routes feeding the merged-away blob
      for (const r of game.routes) {
        if (r.targetKind === 'blob' && r.targetId === gone.id) r.targetId = keep.id;
      }
      if (gone === a) break;
    }
  }
}

function cleanup(game) {
  for (const b of game.blobs) {
    if (!b.dead) continue;
    if (b.order && b.order.type === 'route') {
      const r = SUP.findRoute(game, b.order.routeId);
      if (r) SUP.removeCarrier(game, r, b.id);
    }
  }
  for (const r of [...game.routes]) {
    const tgt = SUP.routeTarget(game, r);
    if (!tgt) {
      // maybe the target merged away
      let repointed = false;
      if (r.targetKind === 'blob') {
        const old = game.blobs.find(b => b.id === r.targetId);
        if (old && old.mergedInto) { r.targetId = old.mergedInto; repointed = true; }
      }
      if (!repointed) SUP.dissolveRoute(game, r);
    }
  }
  game.blobs = game.blobs.filter(b => !b.dead);
}

function markCircle(fog, map, cx, cy, r) {
  const { w, h } = map;
  const r2 = r * r;
  const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(w - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(h - 1, Math.ceil(cy + r));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
      if (dx * dx + dy * dy <= r2) fog[y * w + x] = 2;
    }
  }
}

// Recompute vision + settlement memory for one side into (fog, known).
function updateVisionFor(game, owner, fog, known) {
  for (let i = 0; i < fog.length; i++) if (fog[i] === 2) fog[i] = 1;
  for (const b of game.blobs) {
    if (!b.dead && b.owner === owner) markCircle(fog, game.map, b.x, b.y, C.VISION_BLOB);
  }
  for (const s of game.settlements) {
    if (s.owner === owner) markCircle(fog, game.map, s.x + 1, s.y + 1, C.VISION_SETT);
  }
  // remember enemy settlements we can currently see; forget destroyed ones
  for (const s of game.settlements) {
    if (s.owner !== owner && settTiles(game.map, s).some(i => fog[i] === 2)) {
      known[s.id] = { x: s.x, y: s.y };
    }
  }
  for (const id of Object.keys(known)) {
    const k = known[id];
    if (settTiles(game.map, k).some(i => fog[i] === 2) && !game.settlements.some(s => s.id === +id)) {
      delete known[id];
    }
  }
}

function updateVision(game) {
  if (game.pvp) {
    updateVisionFor(game, 0, game.fogs[0], game.knowns[0]);
    updateVisionFor(game, 1, game.fogs[1], game.knowns[1]);
    return;
  }
  updateVisionFor(game, 0, game.fog, game.known);
}

export function isVisible(game, x, y) {
  return game.fog[Math.floor(y) * game.map.w + Math.floor(x)] === 2;
}

function checkResult(game) {
  const p = unitCounts(game, 0);
  const e = unitCounts(game, 1);
  if (game.pvp) {
    // symmetric: a side is out at 0 settlements and too few units to rebuild
    const pOut = p.setts === 0 && p.units < C.SETT_COST;
    const eOut = e.setts === 0 && e.units < C.SETT_COST;
    if (pOut && eOut) game.result = p.units >= e.units ? 'p0-win' : 'p1-win';
    else if (pOut) game.result = 'p1-win';
    else if (eOut) game.result = 'p0-win';
    return;
  }
  if (e.setts === 0) { game.result = 'win'; return; }
  if (p.setts === 0 && p.units < C.SETT_COST) game.result = 'loss';
}

// ---------------------------------------------------------------- save / load

function u8ToB64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 4096) {
    s += String.fromCharCode.apply(null, u8.subarray(i, i + 4096));
  }
  return btoa(s);
}
function b64ToU8(b64) {
  const s = atob(b64);
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8;
}

export function serialize(game) {
  const fertDelta = {};
  for (const i of game.pillaged) fertDelta[i] = game.map.fert[i];
  const data = {
    v: 4,
    seed: game.seed, sizeKey: game.sizeKey, difficulty: game.difficulty,
    tick: game.tick, nextId: game.nextId, result: game.result,
    blobs: game.blobs.filter(b => !b.dead).map(b => ({
      id: b.id, owner: b.owner, x: b.x, y: b.y,
      count: b.count, food: b.food, order: b.order,
      pillaging: b.pillaging, working: b.working, noMerge: b.noMerge,
      units: b.units.map(u => ({ role: u.role, hp: u.hp, seed: u.seed })),
    })),
    settlements: game.settlements.map(s => ({
      id: s.id, owner: s.owner, x: s.x, y: s.y, hp: s.hp,
      mode: s.mode, stockpile: s.stockpile, garrison: s.garrison,
      trainTicks: s.trainTicks, flow: s.flow,
    })),
    routes: game.routes.map(r => ({
      id: r.id, owner: r.owner, settlementId: r.settlementId,
      targetKind: r.targetKind, targetId: r.targetId, carrierIds: r.carrierIds,
    })),
    fertDelta,
  };
  if (game.pvp) {
    // PvP snapshot: both sides' fog + memory (rejoiners recover their
    // explored map), plus the mergeLog so the guest's selections survive
    // merges across snapshot applications.
    data.pvp = true;
    data.fogs = [u8ToB64(game.fogs[0]), u8ToB64(game.fogs[1])];
    data.knowns = game.knowns;
    data.mergeLog = game.mergeLog;
    data.resultReason = game.resultReason || null;
  } else {
    data.fog = u8ToB64(game.fog);
    data.known = game.known;
    data.ai = game.ai;
  }
  return data;
}

// Rebuild a game from serialized data. Pass `prev` (the current game for
// the same match) to reuse its map object — the renderer keys its terrain
// layer on map identity, so PvP snapshot applications must NOT regenerate
// the map. Fertility, dirty-tile and blob-interpolation state carry over.
export function deserialize(data, prev) {
  const reuse = prev && prev.seed === data.seed && prev.sizeKey === data.sizeKey;
  const map = reuse ? prev.map : generateMap(data.seed, data.sizeKey);
  const dirty = new Set(reuse ? prev.dirty : []);
  if (reuse) {
    // reset tiles our local dead-reckoning may have pillaged; the
    // snapshot's fertDelta below re-applies the authoritative values
    for (const i of prev.pillaged) { map.fert[i] = map.orig[i]; dirty.add(i); }
  }
  const game = {
    seed: data.seed, sizeKey: data.sizeKey, difficulty: data.difficulty,
    map,
    tick: data.tick, nextId: data.nextId,
    blobs: [], settlements: [], routes: [],
    tilledBy: new Int32Array(map.w * map.h),
    settAt: new Int32Array(map.w * map.h),
    pillaged: new Set(),
    dirty,
    fog: data.fog ? b64ToU8(data.fog) : new Uint8Array(map.w * map.h),
    known: data.known || {},
    events: [],
    fx: reuse ? prev.fx : [],
    combat: [],
    mergeLog: {},
    result: data.result || null,
    farmAlarmT: -999,
    pillageAlarmT: -999,
    ai: data.ai || { known: {}, lastExpand: 0, lastScout: 0, lastAttack: 0, attacking: false, armyId: null, scoutId: null, expand: null },
  };
  if (data.pvp) {
    game.pvp = true;
    game.fogs = [b64ToU8(data.fogs[0]), b64ToU8(data.fogs[1])];
    game.knowns = data.knowns || [{}, {}];
    game.mergeLog = data.mergeLog || {};
    game.resultReason = data.resultReason || null;
    game.me = prev && prev.me != null ? prev.me : 0;
    game.fog = game.fogs[game.me];
  }
  for (const [i, f] of Object.entries(data.fertDelta || {})) {
    map.fert[+i] = f;
    if (f < map.orig[+i] - 0.0001) game.pillaged.add(+i);
    if (reuse) dirty.add(+i);
  }
  for (const sd of data.settlements) {
    const s = {
      id: sd.id, owner: sd.owner, x: sd.x, y: sd.y, hp: sd.hp,
      mode: sd.mode, stockpile: sd.stockpile,
      garrison: sd.garrison, trainTicks: sd.trainTicks,
      garrLoss: 0, lastHitT: -999, tilled: [],
      flow: sd.flow || 0, flowAcc: 0,
    };
    // pre-v4 saves stored a single-tile settlement; the same (x, y) now
    // anchors a 2×2 footprint. If that footprint runs off the map or
    // onto a mountain, try the other anchors that still contain the
    // original tile; failing that, clamp into bounds and accept the
    // blocked tile (mountains inside a footprint are impassable anyway).
    const { w, h } = map;
    const clear = (ax, ay) => ax >= 0 && ay >= 0 && ax + 1 < w && ay + 1 < h
      && !map.mountain[ay * w + ax] && !map.mountain[ay * w + ax + 1]
      && !map.mountain[(ay + 1) * w + ax] && !map.mountain[(ay + 1) * w + ax + 1];
    if (!clear(s.x, s.y)) {
      let moved = false;
      for (const [ax, ay] of [[s.x - 1, s.y], [s.x, s.y - 1], [s.x - 1, s.y - 1]]) {
        if (clear(ax, ay)) { s.x = ax; s.y = ay; moved = true; break; }
      }
      if (!moved) {
        s.x = Math.max(0, Math.min(w - 2, s.x));
        s.y = Math.max(0, Math.min(h - 2, s.y));
      }
    }
    claimFootprint(game, s);
    tillFields(game, s);
    game.settlements.push(s);
  }
  for (const bd of data.blobs) {
    const units = (bd.units && bd.units.length
      // clamp HP to the role's max: v2 saves stored farmers at up to 100 HP
      ? bd.units.map(u => ({ role: u.role, hp: Math.min(u.hp, unitMaxHP(u.role)), seed: u.seed }))
      : unitsFromCount(bd.count || { deploy: 0, supply: 0, farm: 0 })
    ).sort((a, z) => a.seed - z.seed);
    const b = {
      id: bd.id, owner: bd.owner, x: bd.x, y: bd.y,
      prevX: bd.x, prevY: bd.y,
      units, count: { deploy: 0, supply: 0, farm: 0 },
      food: bd.food, order: bd.order,
      path: null, pathGoal: null,
      pillaging: bd.pillaging, working: bd.working != null ? bd.working : null,
      engagedT: -999, chaseId: null, dead: false, mergedInto: null,
      noMerge: !!bd.noMerge, lastYieldT: data.tick, starving: false,
    };
    recount(b);
    game.blobs.push(b);
  }
  for (const rd of data.routes) {
    game.routes.push({ ...rd, window: [] });
  }
  if (reuse) {
    // repaint tiles whose tilled/footprint state changed (settlements founded/lost)
    for (let i = 0; i < game.tilledBy.length; i++) {
      if (game.tilledBy[i] !== prev.tilledBy[i]) dirty.add(i);
      if (prev.settAt && game.settAt[i] !== prev.settAt[i]) dirty.add(i);
    }
    // carry interpolation anchors so blobs glide instead of teleporting
    const prevById = new Map();
    for (const ob of prev.blobs) if (!ob.dead) prevById.set(ob.id, ob);
    for (const b of game.blobs) {
      const ob = prevById.get(b.id);
      if (ob && dist(ob.x, ob.y, b.x, b.y) < 3) { b.prevX = ob.x; b.prevY = ob.y; }
    }
  }
  return game;
}
