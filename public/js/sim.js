// Supply Line core simulation. Fixed 100 ms timestep; all state lives on
// the `game` object so save/resume is a JSON round-trip (map regenerated
// from its seed). Units exist only as counts inside blobs.

import { generateMap, findPath, passable, dist, nearestPassable } from './mapgen.js';
import * as SUP from './supply.js';

export const C = {
  DT: 0.1,                 // seconds per tick
  SPEED_DEPLOY: 1.2,       // tiles/sec
  SPEED_SUPPLY: 1.2,       // same as deploy (#80); kept separate for retuning
  FOOD_PER_UNIT: 10,       // food meter capacity per unit
  EAT_PER_SEC: 1 / 12,     // food per unit per second
  STARVE_FRAC: 0.005,      // fraction of blob lost per tick at 0 food (5%/s — dead in ~20 s)
  K_COMBAT: 0.0035,        // casualties per enemy deploy-unit per tick
  K_SIEGE: 0.0067,         // settlement HP per deploy-unit per tick
  SETT_HP: 100,
  SETT_COST: 5,
  SETT_MIN_DIST: 8,
  STOCK_CAP: 500,
  TRAIN_TICKS: 250,        // baseline 25 s per unit (surplus income trains faster — see investProduction)
  TRAIN_COST: 15,
  FARM_PER_FARMER: 0.002,  // base-income rate: stockpile per tick per unit of tilled fertility per farmer-equivalent
  FARM_BASE_FARMERS: 2,    // built-in farmer-equivalents every settlement gets for free
  FARM_GROW_FLOOR: 50,     // farm-mode settlements grow farmers only above this stockpile
  FARM_PER_CELL: 0.04,     // stockpile per tick per unit of fertility of a worked plot
                           // (= the old reference ring 20 × FARM_PER_FARMER, so a farmer
                           // on a Lush plot matches the old full share — see farmYield)
                           // (TRAIN_* / FARM_* figures are restated in plain
                           // language in index.html's How to Play — keep in sync)
  VISION_BLOB: 6,
  VISION_SETT: 8,
  AGGRO: 4,
  PILLAGE_RADIUS: 2.5,     // pillage harvest reach in tiles (half a territory ring)
  PILLAGE_YIELD: 0.8,      // food per 1.0 fertility destroyed by pillaging — one full
                           // level off the whole ~21-tile disc (21 × 0.25 × 0.8 ≈ 4.2
                           // food) feeds the reference 10-unit army for ~5 s (#42)
  PILLAGE_INTAKE_MULT: 3,  // pillage intake cap per tick, × the army's eating rate
  PILLAGE_DRAWS: 3,        // max tiles drawn from (degraded) per pillage tick (#72)
  FERT_LEVEL: 0.25,        // one visible fertility level (of four above zero)
  FERT_REGEN: 0.01 / 600,  // fertility per tick (0.01/min)
  TERRITORY: 5,            // settlement territory radius: feeds friendly blobs, farmer reach, drawn ring
  UNIT_HP: 100,            // individual unit health (deploy / supply)
  UNIT_HP_FARM: 10,        // farmers are 1/10th as tough
  FLOW_FX_TICKS: 10,       // resource-flow particle travel time in ticks (< fx prune window)
  WHEAT_FX_FOOD: 1.0,      // food earned per wheat particle (farm income → settlement)
  LOOT_FX_FOOD: 0.5,       // food foraged per loot particle (pillaged land → army)
  SEP_PUSH: 1.2,           // max separation push speed, tiles/sec (= SPEED_DEPLOY)
  SEP_SLACK: 0.03,         // minimum overlap before separation acts (damps jitter)
  MERGE_FRAC: 0.6,         // merge when centers are within this fraction of touching distance (rA + rB)
  MERGE_MIN: 0.8,          // floor on the merge trigger — tiny blobs keep the old fixed-0.8 feel
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

// Per-component stockpile-flow ledger for the settlement panel's food
// breakdown (#76). Transient — never serialized; rebuilt each session.
function newFlowParts() {
  return { base: 0, farmers: 0, routeIn: 0, upkeep: 0, fed: 0, routeOut: 0, train: 0 };
}

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
// cell (walking farmers claim their destination cell) instead of
// stacking; among equally free cells the lushest wins (#87 — with
// per-plot income that ordering is what maximises the farm's yield).
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
  let best = s.tilled[0], bo = Infinity, bf = -1;
  for (const i of s.tilled) {
    const o = occ.get(i) || 0;
    const f = game.map.fert[i];
    if (o < bo || (o === bo && f > bf)) { bo = o; bf = f; best = i; }
  }
  return tilledJitter(game, best, workingCount(game, s) + s.id * 17);
}

// The settlement "gate": the spot just outside the footprint that fielded
// units already emerge from — new farmers appear here and walk out (#83).
function farmerGate(game, s) {
  const foot = new Set(settTiles(game.map, s));
  const spot = nearestPassable(game.map, s.x + 2, s.y + 1, 4, null, foot)
    || { x: s.x + 2, y: s.y + 1 };
  return { x: spot.x + 0.5, y: spot.y + 0.5 };
}

// Farmers walk in and out of settlements, never pop (#83): spawn at
// `origin` (the gate by default; a converting blob passes its own spot)
// and walk to the chosen plot. The move order keeps `working` set, so
// safety/selection behave as for any field hand; income starts only on
// arrival (see farmYield).
function spawnWorkingFarmer(game, s, unit, origin) {
  const o = origin || farmerGate(game, s);
  const b = makeBlob(game, s.owner, o.x, o.y, null, [unit || newUnit('farm')]);
  b.working = s.id;
  const spot = farmerSpot(game, s);
  if (dist(b.x, b.y, spot.x, spot.y) > 0.05) {
    b.order = { type: 'move', x: spot.x, y: spot.y };
    if (!ensurePath(game, b, spot.x, spot.y)) b.order = null;
  }
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
    engagedT: -999, meleeT: -999, chaseId: null,
    dead: false, mergedInto: null,
    noMerge: false,               // set on split; cleared when a move order completes
    lastYieldT: game.tick,        // last tick pillaging yielded food (transient)
    starving: false,              // one-shot starvation toast latch (transient)
    foodTrend: 0,                 // EMA of food change per tick (transient — drives the panel's ▲/▼)
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
  const ring = new Set();
  for (let ty = s.y - span; ty <= s.y + 1 + span; ty++) {
    for (let tx = s.x - span; tx <= s.x + 1 + span; tx++) {
      if (tx < 0 || ty < 0 || tx >= w || ty >= h) continue;
      if (dist(tx + 0.5, ty + 0.5, c.x, c.y) > FARM_RING) continue;
      const i = ty * w + tx;
      if (game.map.mountain[i] || game.tilledBy[i] || game.settAt[i]) continue;
      ring.add(i);
    }
  }
  // only plots walkable from the settlement are tilled (#83): flood
  // (4-connected) through the candidate ring from tiles touching the
  // footprint — plots sealed off behind mountains never become fields
  const DIRS4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const reached = new Set();
  const stack = [];
  for (const i of ring) {
    const tx = i % w, ty = (i / w) | 0;
    for (const [dx, dy] of DIRS4) {
      const nx = tx + dx, ny = ty + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      if (game.settAt[ny * w + nx] === s.id) { reached.add(i); stack.push(i); break; }
    }
  }
  while (stack.length) {
    const i = stack.pop();
    const tx = i % w, ty = (i / w) | 0;
    for (const [dx, dy] of DIRS4) {
      const nx = tx + dx, ny = ty + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const ni = ny * w + nx;
      if (ring.has(ni) && !reached.has(ni)) { reached.add(ni); stack.push(ni); }
    }
  }
  // row-major order, matching the old scan, so rebuilds are deterministic
  const cells = [...reached].sort((a, b) => a - b);
  for (const i of cells) {
    game.tilledBy[i] = s.id;
    s.tilled.push(i);
    game.dirty.add(i);
  }
}

function foundSettlement(game, owner, x, y) {
  const s = {
    id: game.nextId++, owner,
    x: Math.floor(x), y: Math.floor(y),
    hp: C.SETT_HP, mode: 'farm', stockpile: 40,
    garrison: { deploy: 0, supply: 0, farm: 0 },
    trainAcc: 0, garrLoss: 0, lastHitT: -999,
    tilled: [],
    flow: 0,       // EMA of net stockpile flow (food/tick) — gates training
    flowAcc: 0,    // this tick's flow components (transient)
    parts: newFlowParts(),     // this tick's per-component flow (transient, #76)
    partsEma: newFlowParts(),  // smoothed per-component flow for the panel (transient)
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

// One move command. A plain move only moves — it never diverts to attack
// (#74); combat is contact-based, so a moving blob still fights back
// while an enemy engages it. Optional `target`
// ({kind:'blob'|'settlement', id}) makes it an explicit attack order:
// the blob heads for that entity (following blobs while visible,
// besieging settlements until destroyed). Moving never touches the
// pillaging stance — pillage is a persistent toggle (#63) and armies
// forage on the march (#66).
export function opMove(game, b, x, y, target) {
  if (b.dead) return { err: 'Gone' };
  leaveRoute(game, b);
  b.working = null;
  const o = { type: 'move', x, y };
  if (target && target.kind && target.id != null) { o.tkind = target.kind; o.tid = target.id; }
  b.order = o;
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
    // friendly settlement's fields — no cap; each earns only from the
    // plot they actually work (see farmYield), so extra hands beyond
    // the worthwhile plots are a pure drain
    if (b.working != null) return { err: 'Already working the fields' };
    let s = null, bd = Infinity;
    for (const st of game.settlements) {
      if (st.owner !== b.owner) continue;
      const d = dist(st.x + 1, st.y + 1, b.x, b.y);
      if (d <= C.TERRITORY && d < bd) { bd = d; s = st; }
    }
    if (!s) return { err: 'Farmers can only be assigned at a friendly settlement' };
    leaveRoute(game, b);
    b.order = null; b.path = null; b.pathGoal = null; b.chaseId = null;
    const foodShare = b.food / n;
    while (b.units.length > 0) {
      const u = b.units.shift();
      convertRole(u, 'farm');
      // converts in place: the farmer starts from the blob's own spot
      const f = spawnWorkingFarmer(game, s, u, { x: b.x, y: b.y });
      f.food = Math.min(foodCap(f), foodShare);
      b.food = Math.max(0, b.food - foodShare);
    }
    recount(b);
    b.dead = true;
    return { ok: true };
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

// Pillaging is a persistent stance, fully independent of movement
// (#63, #66): while toggled on the blob forages the land around it every
// tick — camped or on the march — until it is toggled off. It only drops
// field work (a farmer can't till and burn at once); orders, supply
// routes and paths are untouched.
export function opPillage(game, b, on) {
  if (on && !b.pillaging) { b.lastYieldT = game.tick; b.working = null; }
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
  // farmers only return to *safe* settlements; unsafe ones take none
  // (no field-slot cap — a farm takes any number of returning hands)
  const safe = new Set();
  for (const s of setts) if (!settlementInDanger(game, s)) safe.add(s.id);
  const plan = { garrison: [], home: [], walk: [], sawIdle: false, sawDanger: false };
  for (const s of setts) {
    if (s.garrison.farm <= 0) continue;
    plan.sawIdle = true;
    if (!safe.has(s.id)) { plan.sawDanger = true; continue; }
    plan.garrison.push({ s, n: s.garrison.farm });
  }
  for (const b of game.blobs) {
    if (b.dead || b.owner !== owner || b.working != null || b.order || b.count.farm <= 0) continue;
    // nearest safe settlement, at home and anywhere
    let homeSett = null, hd = Infinity, atHomeOfAny = false;
    let walkSett = null, wd = Infinity;
    for (const s of setts) {
      const d = dist(s.x + 1, s.y + 1, b.x, b.y);
      if (d <= C.TERRITORY) atHomeOfAny = true;
      if (!safe.has(s.id)) continue;
      if (d <= C.TERRITORY && d < hd) { hd = d; homeSett = s; }
      if (d < wd) { wd = d; walkSett = s; }
    }
    const pure = b.count.farm === total(b);
    if (homeSett) {
      plan.sawIdle = true;
      plan.home.push({ b, s: homeSett, n: b.count.farm });
    } else if (pure && walkSett) {
      plan.sawIdle = true;
      plan.walk.push({ b, s: walkSett });
    } else if (pure || atHomeOfAny) {
      // idle farmers with nowhere to go right now — remember why
      plan.sawIdle = true;
      if (setts.length > safe.size) plan.sawDanger = true;
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
    const f = spawnWorkingFarmer(game, s, u, { x: b.x, y: b.y });
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
    if (!b.dead && opMove(game, b, s.x + 1, s.y + 1).ok) walking += b.count.farm;
  }
  if (fielded + walking === 0) {
    return { fielded, walking, reason: plan.sawIdle && plan.sawDanger ? 'danger' : 'none' };
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
    b.prevFood = b.food;          // for the fed-trend EMA below
    if (b.order && b.order.type === 'route') tickCarrier(game, b);
    else tickOrder(game, b);
  }

  tickSeparation(game);
  tickCombat(game);
  for (const b of game.blobs) if (!b.dead) tickFood(game, b);
  for (const s of [...game.settlements]) tickSettlement(game, s);

  // fed trend: EMA (~3.5 s half-life) of each blob's net food change per
  // tick, once all transfers have landed — shown as ▲/▼ in the panel (#64)
  for (const b of game.blobs) {
    if (b.dead) continue;
    const d = b.food - (b.prevFood != null ? b.prevFood : b.food);
    b.foodTrend = (b.foodTrend || 0) + (d - (b.foodTrend || 0)) * 0.02;
  }

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

function ensurePath(game, b, x, y, avoid) {
  const blocked = blockedTiles(game, b.owner);
  if (avoid && avoid.size) {
    // soft avoidance: try to route around the avoid set first, but never
    // let it strand the order — fall through to a plain plan on failure
    const merged = new Set(blocked);
    for (const i of avoid) merged.add(i);
    merged.delete(tileIdx(game, b.x, b.y));
    const pa = findPath(game.map, b.x, b.y, x, y, pathFog(game, b.owner), merged);
    if (pa) { b.path = pa; b.pathGoal = { x, y }; return true; }
  }
  const p = findPath(game.map, b.x, b.y, x, y, pathFog(game, b.owner), blocked);
  b.path = p;
  b.pathGoal = p ? { x, y } : null;
  return !!p;
}

// Tiles a targeted mover plans around: the footprint (+1 tile) of every
// enemy blob its owner can currently see, except the target itself and
// enemy field hands. Planning-only — moveBlob never hard-blocks on these.
function avoidTiles(game, b, targetId) {
  const set = new Set();
  const fog = pathFog(game, b.owner);
  const { w, h } = game.map;
  for (const e of game.blobs) {
    if (e.dead || e.owner === b.owner || e.id === targetId || e.working != null) continue;
    if (fog && fog[tileIdx(game, e.x, e.y)] !== 2) continue; // unseen — nothing to dodge
    const reach = blobRadius(e) + 1;
    const span = Math.ceil(reach);
    const cx = Math.floor(e.x), cy = Math.floor(e.y);
    for (let dy = -span; dy <= span; dy++) {
      for (let dx = -span; dx <= span; dx++) {
        const tx = cx + dx, ty = cy + dy;
        if (tx < 0 || ty < 0 || tx >= w || ty >= h) continue;
        if (dist(tx + 0.5, ty + 0.5, e.x, e.y) <= reach) set.add(ty * w + tx);
      }
    }
  }
  return set;
}

// Resolve a targeted order's blob through the merge log, like the UI's
// selection does, so a target that merged away keeps being followed.
function resolveTargetBlob(game, id) {
  let cur = id, hops = 0;
  while (hops++ < 10) {
    const t = game.blobs.find(x => x.id === cur && !x.dead);
    if (t) return t;
    if (game.mergeLog[cur] != null) cur = game.mergeLog[cur];
    else return null;
  }
  return null;
}

// Whether `owner` can currently see world position (x, y). Owners with
// no fog array (the solo AI) are omniscient.
function ownerSees(game, owner, x, y) {
  const fog = pathFog(game, owner);
  return !fog || fog[tileIdx(game, x, y)] === 2;
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
  if (o.type !== 'move' && o.type !== 'attack') return;
  if (o.tkind) { tickTargetedMove(game, b, o); return; }
  // plain tile move: never diverts to attack (#74) — attacking takes an
  // explicit target. Fighters still defend themselves: while actively in
  // MELEE with an enemy blob (contact keeps refreshing meleeT) they stand
  // and fight back instead of marching out of it. Settlement contact
  // deliberately doesn't hold them (#82) — a settlement can't disengage,
  // so waiting for it would freeze the move order forever.
  if (b.count.deploy > 0) {
    b.chaseId = null;
    if (game.tick - b.meleeT < 5) return;
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
    if (b.working == null) {
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

// Targeted move: head for a specific enemy blob or settlement. Never
// diverts to other enemies — instead it plans around the ones it can see.
function tickTargetedMove(game, b, o) {
  if (o.tkind === 'blob') {
    const t = resolveTargetBlob(game, o.tid);
    if (!t) {
      // target died — degrade to a plain tile move toward its last-known spot
      delete o.tkind; delete o.tid;
      ensurePath(game, b, o.x, o.y);
      return;
    }
    o.tid = t.id; // follow merges
    const seen = ownerSees(game, b.owner, t.x, t.y);
    b.chaseId = seen ? t.id : null; // drives the renderer's targeting line
    if (seen) { o.x = t.x; o.y = t.y; } // last-known position while visible
    if (seen && dist(b.x, b.y, t.x, t.y) <= blobRadius(b) + blobRadius(t) + 0.15) {
      b.path = null; b.pathGoal = null; // in contact — combat takes it from here
      return;
    }
    const stale = !b.pathGoal || dist(b.pathGoal.x, b.pathGoal.y, o.x, o.y) > 0.75;
    if (!b.path || !b.path.length || pathBlocked(game, b) || (stale && game.tick % 10 === 0)) {
      if (!ensurePath(game, b, o.x, o.y, avoidTiles(game, b, t.id))) {
        b.order = null; b.pathGoal = null;
        game.events.push({ owner: b.owner, msg: '⛰️ No way through — order cancelled', x: b.x, y: b.y });
        return;
      }
    }
    const arrived = moveBlob(game, b);
    if (arrived && !seen) {
      // reached the last place it was seen and it isn't there — give up
      b.order = null; b.pathGoal = null; b.noMerge = false;
    }
    return;
  }
  // settlement target: besiege until it falls
  const s = game.settlements.find(x => x.id === o.tid);
  if (!s) { b.order = null; b.pathGoal = null; b.noMerge = false; return; }
  const c = settCenter(s);
  o.x = c.x; o.y = c.y;
  if (dist(b.x, b.y, c.x, c.y) <= blobRadius(b) + 1.9) {
    b.path = null; b.pathGoal = null; // in siege range — stand and fight
    return;
  }
  if (!b.path || !b.path.length || pathBlocked(game, b) || game.tick % 20 === 0) {
    if (!ensurePath(game, b, o.x, o.y, avoidTiles(game, b, null))) {
      b.order = null; b.pathGoal = null;
      game.events.push({ owner: b.owner, msg: '⛰️ No way through — order cancelled', x: b.x, y: b.y });
      return;
    }
  }
  moveBlob(game, b);
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
    if (src.parts) src.parts.routeOut -= take + self;
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
      if (tgt.parts) tgt.parts.routeIn += taken;
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
// mergeable same-owner pairs (merge fires at MERGE_FRAC of touching
// distance — a deep overlap the push would otherwise make unreachable).

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
  return a.owner === b.owner
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
      a.meleeT = game.tick; b.meleeT = game.tick; // blob melee only — settlement contact never sets meleeT (#82)
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
    // defend reflex). AI field crews run for shelter; human-owned farmers
    // stay on the fields and the owner just gets a warning (issue #52).
    if (b.working != null) {
      const s = game.settlements.find(x => x.id === b.working);
      if (s) {
        s.lastHitT = game.tick;
        if (autoShelters(game, s)) shelterFarmers(game, s);
        else warnFarmers(game, s);
      }
    }
    applyLosses(game, b, d);
  }
}

// -- farmer safety: AI-owned working farmers shelter in their settlement
// when threatened, then walk back out to the fields once the area is
// quiet. Human-owned farmers are never auto-recalled (issue #52): they
// get a throttled warning instead, and only the manual "Recall farmers" /
// "Field" / "Back to work" actions move them.

// Only the scripted AI keeps the automatic shelter/return reflex; in PvP
// both owners are human, so nobody does.
function autoShelters(game, s) {
  return !game.pvp && s.owner === 1;
}

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
    if (opMove(game, b, s.x + 1, s.y + 1).ok) any = true;
    else b.working = null; // no path home — at least stop working
  }
  if (any && game.tick - game.farmAlarmT > 100) {
    game.farmAlarmT = game.tick;
    game.events.push({ owner: s.owner, msg: '🌱 Your farmers ran to shelter!', x: s.x + 1, y: s.y + 1 });
  }
}

// Human owners keep working through danger — just tell them about it.
function warnFarmers(game, s) {
  if (game.tick - game.farmAlarmT <= 100) return;
  game.farmAlarmT = game.tick;
  game.events.push({ owner: s.owner, msg: '⚠️ Your farmers are in danger!', x: s.x + 1, y: s.y + 1 });
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
    if (!s) continue;
    if (autoShelters(game, s)) shelterFarmers(game, s);
    else warnFarmers(game, s);
  }
  // return: sheltered AI farmers head back out once it's been quiet a
  // while; human garrisons stay put until the player fields them
  if (game.tick % 50 === 0) {
    for (const s of game.settlements) {
      if (!autoShelters(game, s)) continue;
      if (s.garrison.farm <= 0 || game.tick - s.lastHitT <= 300) continue;
      if (!settlementInDanger(game, s)) opFieldRole(game, s, 'farm', s.garrison.farm);
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
    // lushest free plots are claimed first (#87)
    const free = s.tilled.filter(i => !idle.has(i) && !claimed.has(i))
      .sort((a, b) => game.map.fert[b] - game.map.fert[a]);
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
// within PILLAGE_RADIUS), the same for all army sizes. Every cell
// degrades together (see tickFood). Shared with the renderer so the
// on-screen grid highlights match the sim exactly.
export function pillageCells(game, b) {
  const cx = Math.floor(b.x), cy = Math.floor(b.y);
  const { w, h } = game.map;
  const reach = C.PILLAGE_RADIUS;
  const span = Math.ceil(reach);
  // own settlement land is never pillaged (#85): own farmland, and any
  // tile inside a friendly territory ring (matches the drawn border)
  const friendly = game.settlements.filter(st => st.owner === b.owner);
  const friendlyIds = new Set(friendly.map(st => st.id));
  const cells = [];
  for (let dy = -span; dy <= span; dy++) {
    for (let dx = -span; dx <= span; dx++) {
      const tx = cx + dx, ty = cy + dy;
      if (tx < 0 || ty < 0 || tx >= w || ty >= h) continue;
      if (dist(tx + 0.5, ty + 0.5, b.x, b.y) > reach) continue;
      const i = ty * w + tx;
      if (game.map.mountain[i] || game.settAt[i]) continue;
      if (friendlyIds.has(game.tilledBy[i])) continue;
      let own = false;
      for (const st of friendly) {
        if (dist(tx + 0.5, ty + 0.5, st.x + 1, st.y + 1) <= C.TERRITORY) { own = true; break; }
      }
      if (own) continue;
      cells.push(i);
    }
  }
  return cells;
}

function tickFood(game, b) {
  const n = total(b);
  b.food = Math.max(0, b.food - n * C.EAT_PER_SEC * C.DT);
  let gained = 0; // food the land yielded this tick (for stripped-land feedback)
  if (b.pillaging) {
    // Demand-driven foraging (#41, #42), drawn from concrete tiles (#72):
    // each tick up to PILLAGE_DRAWS randomly-picked harvestable cells in
    // the disc supply the whole demand and degrade — so the on-map tile
    // damage and the loot particles come from exactly the cells that were
    // stripped. The pick is a deterministic hash of tick + blob id (no
    // Math.random() — host/guest dead-reckoning stays aligned). The army
    // takes only what it needs — the meter deficit, capped at
    // PILLAGE_INTAKE_MULT× its eating rate so a hungry blob refills
    // steadily instead of instantly. Tiles at or below half a level
    // (displayed as Barren) yield nothing, so stripped land really stops
    // feeding the army and recovers only via the slow regen tick.
    const floor = C.FERT_LEVEL / 2;
    const need = Math.min(foodCap(b) - b.food, C.PILLAGE_INTAKE_MULT * n * C.EAT_PER_SEC * C.DT);
    if (need > 0.0001) {
      const cells = pillageCells(game, b).filter(i => game.map.fert[i] > floor);
      if (cells.length) {
        let remaining = need / C.PILLAGE_YIELD; // fertility still to take
        const picks = Math.min(cells.length, C.PILLAGE_DRAWS);
        const drawn = []; // cells that actually yielded this tick
        let h = (Math.imul(game.tick, 374761393) ^ Math.imul(b.id, 668265263)) >>> 0;
        for (let k = 0; k < picks && remaining > 0.0001; k++) {
          h = Math.imul(h ^ (h >>> 13), 2246822519) >>> 0;
          const idx = h % cells.length;
          const i = cells[idx];
          cells[idx] = cells[cells.length - 1]; // swap-pop: no double draws
          cells.pop();
          const loss = Math.min(remaining / (picks - k), game.map.fert[i] - floor);
          if (loss <= 0) continue;
          game.map.fert[i] -= loss;
          remaining -= loss;
          gained += loss * C.PILLAGE_YIELD;
          game.pillaged.add(i);
          game.dirty.add(i);
          drawn.push(i);
        }
        b.food = Math.min(foodCap(b), b.food + gained);
        // loot-flow fx: one particle per LOOT_FX_FOOD foraged, flying in
        // from the very cells that just degraded.
        b.lootFxAcc = (b.lootFxAcc || 0) + gained;
        let burst = 0;
        while (b.lootFxAcc >= C.LOOT_FX_FOOD && burst < 3 && drawn.length) {
          b.lootFxAcc -= C.LOOT_FX_FOOD;
          const ci = drawn[burst % drawn.length];
          pushFx(game, {
            kind: 'loot',
            x: (ci % game.map.w) + 0.5, y: ((ci / game.map.w) | 0) + 0.5,
            bid: b.id, tx: b.x, ty: b.y, t: game.tick,
          });
          burst++;
        }
        if (b.lootFxAcc >= C.LOOT_FX_FOOD) b.lootFxAcc = 0; // never backlog past a burst
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

// Break-even plot fertility: a plot must out-earn its farmer's upkeep
// to be worth manning (≈ 0.21 — Sparse and up qualify).
export const FERT_WORTHWHILE = (C.EAT_PER_SEC * C.DT) / C.FARM_PER_CELL;

// Per-plot farm income (counts the land actually farmed): each distinct
// tilled cell with an arrived farmer standing on it pays its own
// fertility × FARM_PER_CELL once per tick — one plot, one share; walkers
// en route earn nothing until they reach their plot (#83). The land also
// earns a built-in base worth FARM_BASE_FARMERS old-style shares over
// the whole ring, so a farmerless settlement earns what it always did.
// Shared by the sim tick, the settlement panel and the food breakdown
// (#76) so displayed rates can never drift from what actually accrues.
export function farmYield(game, s) {
  const aiMult = (!game.pvp && s.owner === 1) ? DIFF[game.difficulty].income : 1;
  const w = game.map.w;
  let fertSum = 0, worthwhileCells = 0;
  for (const i of s.tilled) {
    fertSum += game.map.fert[i];
    if (game.map.fert[i] > FERT_WORTHWHILE) worthwhileCells++;
  }
  const tilled = new Set(s.tilled);
  const worked = new Set();
  let farmers = 0;
  for (const b of game.blobs) {
    if (b.dead || b.working !== s.id || b.order) continue;
    const i = Math.floor(b.y) * w + Math.floor(b.x);
    if (!tilled.has(i) || worked.has(i)) continue;
    worked.add(i);
    farmers += game.map.fert[i] * C.FARM_PER_CELL;
  }
  return {
    base: fertSum * C.FARM_PER_FARMER * C.FARM_BASE_FARMERS * aiMult,
    farmers: farmers * aiMult,
    workedCells: worked.size,
    worthwhileCells,
  };
}

// Gross farmland income per 100 ms tick (base + worked plots).
export function incomeRate(game, s) {
  const y = farmYield(game, s);
  return y.base + y.farmers;
}

// Deterministic source spot for a wheat particle: rotate through the
// settlement's working farmers; with none out, rotate through its tilled
// cells (the land still earns its base rate). No Math.random() — host
// and guest dead-reckoning emit identical fx.
function wheatFxSource(game, s) {
  const farmers = [];
  for (const b of game.blobs) if (!b.dead && b.working === s.id) farmers.push(b);
  if (farmers.length) {
    const b = farmers[game.tick % farmers.length];
    return { x: b.x, y: b.y };
  }
  if (!s.tilled.length) return null;
  const i = s.tilled[(game.tick * 7 + s.id) % s.tilled.length];
  return { x: (i % game.map.w) + 0.5, y: ((i / game.map.w) | 0) + 0.5 };
}

function tickSettlement(game, s) {
  if (!game.settlements.includes(s)) return;
  // farmland income accrues in every mode: the base trickle plus one
  // share per plot actually being worked — training modes pick what the
  // surplus becomes
  const y = farmYield(game, s);
  const income = y.base + y.farmers;
  s.stockpile = Math.min(C.STOCK_CAP, s.stockpile + income);
  s.flowAcc = (s.flowAcc || 0) + income;
  s.parts.base += y.base;
  s.parts.farmers += y.farmers;
  // wheat-flow fx: one particle per WHEAT_FX_FOOD earned, from a working
  // farmer (or a tilled cell) toward the settlement — same throttled
  // accumulator pattern as hpFxAcc. Transient; never serialized.
  s.wheatFxAcc = (s.wheatFxAcc || 0) + income;
  if (s.wheatFxAcc >= C.WHEAT_FX_FOOD) {
    s.wheatFxAcc -= C.WHEAT_FX_FOOD;
    const src = wheatFxSource(game, s);
    if (src) pushFx(game, { kind: 'wheat', x: src.x, y: src.y, tx: s.x + 1, ty: s.y + 1, t: game.tick });
  }
  // garrison eats from the stockpile; starves when it's empty
  const g = garrisonTotal(s);
  if (g > 0) {
    const eat = g * C.EAT_PER_SEC * C.DT;
    if (s.stockpile >= eat) { s.stockpile -= eat; s.flowAcc -= eat; s.parts.upkeep -= eat; }
    else { s.flowAcc -= s.stockpile; s.parts.upkeep -= s.stockpile; s.stockpile = 0; applyGarrisonLosses(game, s, g * C.STARVE_FRAC); }
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
      s.parts.fed -= give;
      b.food += give;
      if (s.stockpile <= 0.01) break;
    }
  }
  // production (after everyone has eaten, so it only takes true surplus):
  // in a training mode the tick's net surplus is invested into the unit
  // under construction instead of banking in the stockpile (#65) — the
  // stockpile only grows in 'off' mode, at farm break-even, or while the
  // flow gate pauses training. Paid-in progress (trainAcc) is kept across
  // mode switches and pauses; it's food already spent.
  if (s.mode === 'farm') {
    // healthy farms grow population while a worthwhile plot is unmanned
    // (workingCount includes crews still walking out, so growth doesn't
    // overshoot); after that the farm invests nothing and surplus banks,
    // like 'off'. Growth is deliberately not gated on the flow EMA — an
    // army feeding in territory shouldn't stall population growth;
    // FARM_GROW_FLOOR is the brake.
    if (s.stockpile >= C.FARM_GROW_FLOOR && workingCount(game, s) < y.worthwhileCells) {
      if (investProduction(game, s)) {
        const f = spawnWorkingFarmer(game, s);
        const give = Math.min(s.stockpile, foodCap(f));
        s.stockpile -= give;
        f.food = give;
      }
    }
  } else if (s.mode === 'supply' || s.mode === 'deploy') {
    if (!trainGated(s) && investProduction(game, s)) {
      s.garrison[s.mode === 'supply' ? 'supply' : 'deploy']++;
    }
  }
  // fold this tick's flow into the EMA (~10 s half-life). One-time
  // transfers (production investment, garrison deposits, fielding
  // grants) are deliberately excluded from flowAcc so the gate doesn't
  // oscillate. The per-component ledger (#76) EMAs the same way — it
  // DOES include training, purely for the panel's breakdown.
  s.flow += ((s.flowAcc || 0) - s.flow) * 0.007;
  s.flowAcc = 0;
  for (const k in s.parts) {
    s.partsEma[k] += (s.parts[k] - s.partsEma[k]) * 0.007;
    s.parts[k] = 0;
  }
}

// Invest food into the unit under construction: the tick's positive net
// flow (income minus everything eaten/shipped), floored at the old fixed
// drip TRAIN_COST/TRAIN_TICKS so banked stockpile still converts when
// income is thin. Returns true when a full unit's cost has been paid.
function investProduction(game, s) {
  const drip = C.TRAIN_COST / C.TRAIN_TICKS;
  const surplus = Math.max(0, s.flowAcc || 0);
  const invest = Math.min(s.stockpile, Math.max(surplus, drip));
  if (invest <= 0) return false;
  s.stockpile -= invest;
  s.parts.train -= invest; // panel breakdown only — kept out of flowAcc/the gate
  s.trainAcc += invest; // remainder past the cost rolls into the next unit
  if (s.trainAcc >= C.TRAIN_COST - 1e-9) { s.trainAcc -= C.TRAIN_COST; return true; }
  return false;
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
      if (a.noMerge && b.noMerge) continue; // freshly split pair — stays apart
      // trigger scales with blob size: deep overlap, not mere touching
      const trigger = Math.max(C.MERGE_MIN, C.MERGE_FRAC * (blobRadius(a) + blobRadius(b)));
      if (dist(a.x, a.y, b.x, b.y) > trigger) continue;
      const keep = total(a) >= total(b) ? a : b;
      const gone = keep === a ? b : a;
      // mass-weighted centroid, taken before the union changes the counts;
      // the survivor keeps its own pillaging stance (bigger blob wins)
      const mk = total(keep), mg = total(gone);
      const cx = (keep.x * mk + gone.x * mg) / (mk + mg);
      const cy = (keep.y * mk + gone.y * mg) / (mk + mg);
      keep.units = keep.units.concat(gone.units).sort((u, v) => u.seed - v.seed);
      recount(keep);
      keep.food = Math.min(foodCap(keep), keep.food + gone.food);
      // settle between the two groups so the absorbed half doesn't
      // teleport; skip onto-mountain / onto-settlement centroids
      if (passable(game.map, Math.floor(cx), Math.floor(cy)) && !game.settAt[tileIdx(game, cx, cy)]) {
        keep.x = cx; keep.y = cy;
      }
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
      trainAcc: s.trainAcc, flow: s.flow,
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
      garrison: sd.garrison,
      // older saves stored tick-based progress; convert to invested food
      trainAcc: sd.trainAcc != null ? sd.trainAcc
        : (sd.trainTicks ? sd.trainTicks / C.TRAIN_TICKS * C.TRAIN_COST : 0),
      garrLoss: 0, lastHitT: -999, tilled: [],
      flow: sd.flow || 0, flowAcc: 0,
      parts: newFlowParts(), partsEma: newFlowParts(),
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
    // pre-rework saves distinguished move vs attack-move; both map onto
    // the unified move order (same x/y fields)
    const order = bd.order && bd.order.type === 'attack'
      ? { ...bd.order, type: 'move' } : bd.order;
    const units = (bd.units && bd.units.length
      // clamp HP to the role's max: v2 saves stored farmers at up to 100 HP
      ? bd.units.map(u => ({ role: u.role, hp: Math.min(u.hp, unitMaxHP(u.role)), seed: u.seed }))
      : unitsFromCount(bd.count || { deploy: 0, supply: 0, farm: 0 })
    ).sort((a, z) => a.seed - z.seed);
    const b = {
      id: bd.id, owner: bd.owner, x: bd.x, y: bd.y,
      prevX: bd.x, prevY: bd.y,
      units, count: { deploy: 0, supply: 0, farm: 0 },
      food: bd.food, order,
      path: null, pathGoal: null,
      pillaging: bd.pillaging, working: bd.working != null ? bd.working : null,
      engagedT: -999, meleeT: -999, chaseId: null, dead: false, mergedInto: null,
      noMerge: !!bd.noMerge, lastYieldT: data.tick, starving: false,
      foodTrend: 0,
    };
    recount(b);
    game.blobs.push(b);
  }
  for (const rd of data.routes) {
    game.routes.push({ ...rd, window: [] });
  }
  if (reuse) {
    // carry the smoothed food-breakdown ledger across snapshot
    // applications so the guest's panel doesn't reset every ~2 s (#76)
    const prevSett = new Map(prev.settlements.map(ps => [ps.id, ps]));
    for (const s of game.settlements) {
      const ps = prevSett.get(s.id);
      if (ps && ps.partsEma) s.partsEma = { ...ps.partsEma };
    }
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
