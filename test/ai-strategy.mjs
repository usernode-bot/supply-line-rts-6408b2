// Headless tests for the smarter Normal/Hard enemy commander (#207). Run:
//   node test/ai-strategy.mjs
// Drives the scripted opponent exactly like the main loop — aiTick every
// 20 ticks — with a seeded Math.random so every scenario replays
// identically. Every scenario feeds the AI evidence the way the fog would
// (writes into state.known / knownWalls / threats / prey), never by
// letting it peek at live enemy objects.

import * as S from '../public/js/sim.js';
import { aiTick } from '../public/js/ai.js';
import { mulberry32, hashSeed, dist, passable } from '../public/js/mapgen.js';

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

function drive(g, ticks, onAi, owner = 1, state = null) {
  for (let i = 0; i < ticks; i++) {
    S.step(g);
    if (g.tick % 20 === 0) {
      aiTick(g, S, owner, state || g.ai);
      if (onAi) onAi(g);
    }
  }
}

// A fresh game with the AI's town stocked so it isn't starving in the
// first minute (the scenarios below are about decisions, not economy).
function fixture(tag, size, diffKey, stock = 400) {
  seedRandom(tag + ':rng');
  const g = S.newGame(tag, size, diffKey);
  const s1 = g.settlements.find(s => s.owner === 1);
  s1.stockpile = stock;
  s1.garrFood = 30 * S.C.FOOD_PER_UNIT;
  return { g, s1 };
}

// Remember an enemy town at (x,y) with an effective garrison of g.
function remember(state, id, x, y, t, g) {
  state.known[id] = { x, y, t, g, bd: null };
}

// Clear a side's field blobs. Several scenarios below are about which
// party the commander picks; the starting blob loitering on the town
// square would otherwise be the answer to every question.
function clearField(g, owner) {
  g.blobs = g.blobs.filter(b => b.owner !== owner);
}

// Park a blob on open ground roughly `r` tiles from (cx,cy) — fielded
// units spawn at the gate, which several scenarios need them not to be.
function placeAt(g, b, cx, cy, r, a0 = 0) {
  for (let a = 0; a < 32; a++) {
    const th = a0 + a * Math.PI / 16;
    const x = Math.round(cx + Math.cos(th) * r), y = Math.round(cy + Math.sin(th) * r);
    if (x < 1 || y < 1 || x >= g.map.w - 1 || y >= g.map.h - 1) continue;
    if (!passable(g.map, x, y)) continue;
    b.x = x + 0.5; b.y = y + 0.5; b.path = null; b.order = null;
    return true;
  }
  return false;
}

// ---------------------------------------------- 1. easy is untouched

{
  console.log('easy keeps every legacy flag and no new ones:');
  const e = S.DIFF.easy;
  check('easy DIFF entry is byte-identical to the pre-#207 table',
    JSON.stringify(e) === JSON.stringify({
      muster: 24, expandTicks: 950, scoutTicks: 550, carriers: false,
      memoryTicks: 3000, siteNoise: 0.4,
    }), JSON.stringify(e));
  for (const flag of ['evalTargets', 'reinforce', 'guard', 'armies', 'raid', 'reactiveArm',
    'breachWalls', 'flank', 'foodLines', 'settBonus', 'scouts', 'commitTicks']) {
    if (e[flag] !== undefined) { failures++; console.error(`  FAIL easy must not carry ${flag}`); }
  }
  check('easy carries none of the new behaviour flags', true);
  check('normal and hard both evaluate targets',
    S.DIFF.normal.evalTargets === true && S.DIFF.hard.evalTargets === true);
  check('normal does not raid', !S.DIFF.normal.raid);
  check('hard and veryhard raid', S.DIFF.hard.raid === true && S.DIFF.veryhard.raid === true);

  // normal / hard are frozen too: their published Elo anchors describe
  // these exact tables (#208)
  check('normal DIFF entry is unchanged by the veryhard tier',
    JSON.stringify(S.DIFF.normal) === JSON.stringify({
      muster: 18, expandTicks: 750, scoutTicks: 450, wallCap: 6, wallTicks: 900, wallSpan: 3,
      evalTargets: true, reinforce: true, threats: true, threatTicks: 200, armies: 1,
      guard: 6, guardRear: 4, commitTicks: 2400, settBonus: 1, scouts: 1, staleTicks: 900,
      reactiveArm: true,
    }), JSON.stringify(S.DIFF.normal));
  check('hard DIFF entry is unchanged by the veryhard tier',
    JSON.stringify(S.DIFF.hard) === JSON.stringify({
      muster: 13, expandTicks: 570, scoutTicks: 350, threats: true, rumors: true, resupply: true,
      recencyTarget: true, wallCap: 14, wallTicks: 600, wallSpan: 5, wallChoke: true,
      wallGarrison: true, evalTargets: true, reinforce: true, threatTicks: 600, armies: 2,
      guard: 8, guardRear: 5, commitTicks: 1800, settBonus: 2, scouts: 2, staleTicks: 900,
      reactiveArm: true, raid: true, raidTicks: 1200, breachWalls: true, foodLines: true,
      flank: true,
    }), JSON.stringify(S.DIFF.hard));
  for (const flag of ['evalTicks', 'fieldThreats', 'massAssault', 'siegeRun', 'wallSupply',
    'raidParties', 'reroleSurplus', 'rotateHome', 'commitRatio']) {
    for (const key of ['easy', 'normal', 'hard']) {
      if (S.DIFF[key][flag] !== undefined) {
        failures++; console.error(`  FAIL ${key} must not carry ${flag}`);
      }
    }
  }
  check('only veryhard carries the new behaviour flags', true);
}

// ------------------------------------- 1b. the veryhard table + cadence

{
  console.log('veryhard is hard plus the new flags:');
  const v = S.DIFF.veryhard, h = S.DIFF.hard;
  for (const flag of Object.keys(h)) {
    if (typeof h[flag] === 'boolean' && v[flag] !== h[flag]) {
      failures++; console.error(`  FAIL veryhard dropped hard's ${flag}`);
    }
  }
  check('veryhard keeps every behavioural flag hard has', true);
  check('veryhard carries all eight new flags',
    v.evalTicks === 10 && v.fieldThreats === true && v.massAssault === true
    && v.siegeRun === true && v.wallSupply === true && v.raidParties === 2
    && v.reroleSurplus === true && v.rotateHome > 0 && v.rotateHome < 1,
    JSON.stringify(v));
  // settBonus deliberately matches hard: measured against the calibration
  // anchor, wanting a seventh town on an xsmall map cost more than it won
  check('veryhard presses harder on every pacing dial',
    v.muster < h.muster && v.expandTicks < h.expandTicks && v.scoutTicks < h.scoutTicks
    && v.scouts > h.scouts && v.settBonus >= h.settBonus && v.commitTicks < h.commitTicks
    && v.staleTicks < h.staleTicks && v.raidTicks < h.raidTicks && v.wallCap > h.wallCap);
  check('aiCadence reads evalTicks, defaulting to the classic 20',
    S.aiCadence('veryhard') === 10 && S.aiCadence('hard') === 20
    && S.aiCadence('normal') === 20 && S.aiCadence('easy') === 20
    && S.aiCadence(undefined) === 20 && S.aiCadence('nonsense') === 20);
  check('every cadence divides 20 so the two-owner interleave stays clean',
    ['easy', 'normal', 'hard', 'veryhard'].every(k => 20 % S.aiCadence(k) === 0));
}

// ------------------------------- 2. target choice weighs strength, not distance

{
  console.log('an evaluating commander skips the near fortress for the far outpost:');
  const { g } = fixture('ais-t1', 'medium', 'hard');
  const s1 = g.settlements.find(s => s.owner === 1);
  // a big field army so the launch gate is met immediately
  const army = S.makeBlobForTest ? null : null;
  g.ai.armies = [];
  // fake intel: a heavily-held town close by, a bare one further out
  const near = { x: Math.round(s1.x + 12), y: s1.y };
  const far = { x: Math.round(s1.x + 20), y: s1.y };
  remember(g.ai, 90001, near.x, near.y, g.tick, 30);   // fortress: needs 72
  remember(g.ai, 90002, far.x, far.y, g.tick, 2);      // outpost: needs 4.8
  s1.garrison = { deploy: 26, supply: 6, farm: 0 };
  s1.garrFood = 40 * S.C.FOOD_PER_UNIT;
  let picked = null;
  for (let i = 0; i < 400 && !picked; i++) {
    S.step(g);
    if (g.tick % 20 === 0) {
      // keep the intel fresh so staleness growth doesn't flip the choice
      remember(g.ai, 90001, near.x, near.y, g.tick, 30);
      remember(g.ai, 90002, far.x, far.y, g.tick, 2);
      aiTick(g, S, 1, g.ai);
      if (g.ai.armies.length) picked = g.ai.armies[0].targetId;
    }
  }
  check('an offensive launched', picked != null, JSON.stringify(g.ai.armies));
  check('it marched on the weak outpost, not the nearer fortress', picked === 90002,
    `targetId=${picked}`);
  void army;
}

{
  console.log('the legacy commander (easy) still marches at the nearest:');
  const { g } = fixture('ais-t2', 'medium', 'easy');
  const s1 = g.settlements.find(s => s.owner === 1);
  const near = { x: Math.round(s1.x + 12), y: s1.y };
  const far = { x: Math.round(s1.x + 20), y: s1.y };
  s1.garrison = { deploy: 30, supply: 6, farm: 0 };
  s1.garrFood = 40 * S.C.FOOD_PER_UNIT;
  let picked = null;
  for (let i = 0; i < 600 && !picked; i++) {
    S.step(g);
    if (g.tick % 20 === 0) {
      remember(g.ai, 90001, near.x, near.y, g.tick, 30);
      remember(g.ai, 90002, far.x, far.y, g.tick, 2);
      aiTick(g, S, 1, g.ai);
      if (g.ai.armies.length) picked = g.ai.armies[0].targetId;
    }
  }
  check('easy launched an offensive', picked != null);
  check('easy took the nearest remembered town', picked === 90001, `targetId=${picked}`);
}

// ------------------------------------------- 3. no fog cheating

{
  console.log('nothing is targeted that was never seen:');
  const { g } = fixture('ais-f1', 'medium', 'hard');
  const s1 = g.settlements.find(s => s.owner === 1);
  s1.garrison = { deploy: 30, supply: 8, farm: 0 };
  s1.garrFood = 40 * S.C.FOOD_PER_UNIT;
  // never inject any intel; the player's start is far away
  let sawTarget = false;
  drive(g, 1500, (g2) => {
    for (const a of g2.ai.armies) {
      if (a.targetId != null && !g2.ai.known[a.targetId]) sawTarget = true;
    }
  });
  check('every army target came from remembered intel', !sawTarget);
  const bad = Object.keys(g.ai.known).filter(id => {
    const k = g.ai.known[id];
    const st = g.settlements.find(s => s.id === +id);
    return st && st.owner === 1; // never file an own town as a target
  });
  check('own settlements are never filed as targets', bad.length === 0, bad.join(','));
}

// ---------------------------- 4. massed, besieger-targeted relief

{
  console.log('a besieged town gets a massed relief aimed at the besieger:');
  const { g } = fixture('ais-d1', 'medium', 'hard');
  const s1 = g.settlements.find(s => s.owner === 1);
  clearField(g, 1);
  // three friendly field parties standing off six tiles from the town, a
  // third of the compass apart so they can't just merge into one stack
  s1.garrison = { deploy: 22, supply: 4, farm: 0 };
  s1.garrFood = 40 * S.C.FOOD_PER_UNIT;
  const friends = [];
  for (let i = 0; i < 3; i++) {
    const r = S.opFieldRole(g, s1, 'deploy', 6);
    if (r.ok && placeAt(g, r.blob, s1.x + 1, s1.y + 1, 6, i * 2 * Math.PI / 3)) friends.push(r.blob);
  }
  s1.garrison = { deploy: 4, supply: 4, farm: 2 };
  s1.garrFood = 20 * S.C.FOOD_PER_UNIT;
  check('three relief parties exist', friends.length === 3, `${friends.length}`);
  // a player siege sitting on the town
  const enemySrc = g.settlements.find(s => s.owner === 0);
  enemySrc.garrison.deploy += 10;
  const er = S.opFieldRole(g, enemySrc, 'deploy', 10);
  check('a player siege force was fielded', er.ok, er.err);
  const besieger = er.blob;
  placeAt(g, besieger, s1.x + 1, s1.y + 1, 2.4);
  besieger.food = 100;
  s1.lastHitT = g.tick;

  let vectored = 0;
  for (let i = 0; i < 300; i++) {
    S.step(g);
    besieger.food = Math.max(besieger.food, 50); // keep the siege alive
    s1.lastHitT = g.tick;
    if (g.tick % 20 === 0) {
      aiTick(g, S, 1, g.ai);
      let n = 0;
      for (const b of friends) {
        if (b.dead) continue;
        const o = b.order;
        const atBesieger = o && o.type === 'move' && o.tkind === 'blob';
        const closing = dist(b.x, b.y, besieger.x, besieger.y) < 6;
        if (atBesieger || closing) n++;
      }
      vectored = Math.max(vectored, n);
    }
  }
  check('at least two parties were committed to the relief, not one', vectored >= 2,
    `vectored=${vectored}`);
  check('the garrison was armed for the defence',
    s1.garrison.deploy > 0 || (s1.convert && s1.convert.role === 'deploy'),
    JSON.stringify({ g: s1.garrison, c: s1.convert }));
}

{
  console.log('easy still diverts exactly one blob:');
  const { g } = fixture('ais-d2', 'medium', 'easy');
  const s1 = g.settlements.find(s => s.owner === 1);
  clearField(g, 1);
  s1.garrison = { deploy: 22, supply: 4, farm: 0 };
  s1.garrFood = 40 * S.C.FOOD_PER_UNIT;
  const friends = [];
  for (let i = 0; i < 3; i++) {
    const r = S.opFieldRole(g, s1, 'deploy', 6);
    if (r.ok && placeAt(g, r.blob, s1.x + 1, s1.y + 1, 6 + i)) friends.push(r.blob);
  }
  check('three parties stand off the easy commander"s town', friends.length === 3);
  s1.lastHitT = g.tick;
  aiTick(g, S, 1, g.ai);
  // exactly one gets a move onto the town center
  const onTown = friends.filter(b => b.order && b.order.type === 'move'
    && Math.abs(b.order.x - (s1.x + 1)) < 0.01 && Math.abs(b.order.y - (s1.y + 1)) < 0.01);
  check('easy sent exactly one blob to the hit town', onTown.length === 1, `${onTown.length}`);
}

// ------------------------------------------- 5. reinforcement waves

{
  console.log('a siege that needs more men gets a second wave on the same order:');
  const { g } = fixture('ais-r1', 'medium', 'normal');
  const s1 = g.settlements.find(s => s.owner === 1);
  const tx = Math.round(s1.x + 14), ty = s1.y;
  s1.garrison = { deploy: 40, supply: 8, farm: 0 };
  s1.garrFood = 80 * S.C.FOOD_PER_UNIT;
  s1.stockpile = 500;
  // run until an offensive is under way against a town remembered as lightly held
  let rec = null;
  for (let i = 0; i < 1500 && !rec; i++) {
    S.step(g);
    if (g.tick % 20 === 0) {
      remember(g.ai, 90101, tx, ty, g.tick, 6);
      aiTick(g, S, 1, g.ai);
      rec = g.ai.armies[0] || null;
    }
  }
  check('an offensive is under way', !!rec, JSON.stringify(g.ai.armies));
  // fresh intel: the town turns out to be far better held than believed —
  // the army on its own is now well short of the commit bar
  remember(g.ai, 90101, tx, ty, g.tick, 30);
  const extra = [];
  s1.garrison.deploy += 12;
  s1.garrFood = 80 * S.C.FOOD_PER_UNIT;
  const army = g.blobs.find(b => !b.dead && rec && b.id === rec.id);
  for (let i = 0; i < 2; i++) {
    const r = S.opFieldRole(g, s1, 'deploy', 6);
    if (r.ok && army && placeAt(g, r.blob, army.x, army.y, 5 + i)) extra.push(r.blob);
  }
  check('two spare parties are standing by', extra.length === 2, `${extra.length}`);
  aiTick(g, S, 1, g.ai);
  const order = rec && rec.order;
  // the wave is whatever now carries the army's *identical* order — that
  // is the only thing tickMerge will fold into the siege stack
  const wave = g.blobs.filter(b => !b.dead && b.owner === 1 && b.id !== rec.id
    && b.order && b.order.type === 'move'
    && b.order.tkind === order.kind && b.order.tid === order.id);
  check('a second wave carries the army order verbatim', wave.length >= 2,
    `${wave.length} / ${JSON.stringify(extra.map(b => b.order))}`);
  check('the spare parties standing by were drawn into it',
    extra.some(b => wave.includes(b)), JSON.stringify(extra.map(b => b.order)));
  check('the record tracks the wave (that is what tickMerge folds in)',
    (rec.reinf || []).length === 2, JSON.stringify(rec.reinf));
}

{
  console.log('the classic commander sends no second wave:');
  const { g } = fixture('ais-r2', 'medium', 'easy');
  const s1 = g.settlements.find(s => s.owner === 1);
  const tx = Math.round(s1.x + 14), ty = s1.y;
  s1.garrison = { deploy: 40, supply: 8, farm: 0 };
  s1.garrFood = 80 * S.C.FOOD_PER_UNIT;
  s1.stockpile = 500;
  let rec = null;
  for (let i = 0; i < 1500 && !rec; i++) {
    S.step(g);
    if (g.tick % 20 === 0) {
      remember(g.ai, 90201, tx, ty, g.tick, 6);
      aiTick(g, S, 1, g.ai);
      rec = g.ai.armies[0] || null;
    }
  }
  check('easy launched an offensive', !!rec);
  const extra = [];
  s1.garrison.deploy += 12;
  s1.garrFood = 80 * S.C.FOOD_PER_UNIT;
  const army = g.blobs.find(b => !b.dead && rec && b.id === rec.id);
  for (let i = 0; i < 2; i++) {
    const r = S.opFieldRole(g, s1, 'deploy', 6);
    if (r.ok && army && placeAt(g, r.blob, army.x, army.y, 5 + i)) extra.push(r.blob);
  }
  aiTick(g, S, 1, g.ai);
  const joined = extra.filter(b => b.order && b.order.type === 'move'
    && rec.order && b.order.tid === rec.order.id);
  check('easy never reinforces its siege', joined.length === 0, `${joined.length}`);
  check('easy holds no reinforcement record', !(rec.reinf || []).length);
}

// ------------------------------------------- 6. hard raids soft targets

{
  console.log('hard hunts a remembered caravan:');
  const { g } = fixture('ais-x1', 'medium', 'hard');
  const s1 = g.settlements.find(s => s.owner === 1);
  s1.garrison = { deploy: 20, supply: 8, farm: 0 };
  s1.garrFood = 40 * S.C.FOOD_PER_UNIT;
  const s0 = g.settlements.find(s => s.owner === 0);
  s0.garrison.supply += 4;
  const cr = S.opFieldRole(g, s0, 'supply', 4);
  check('a player caravan exists to hunt', cr.ok, cr.err);
  const carrier = cr.blob;
  carrier.x = (s1.x + s0.x) / 2; carrier.y = (s1.y + s0.y) / 2;
  let raided = false, targetsPrey = false;
  for (let i = 0; i < 2600 && !targetsPrey; i++) {
    S.step(g);
    if (g.tick % 20 === 0) {
      // fog-fair evidence: the AI "saw" the caravan where it stands
      g.ai.prey[carrier.id] = { x: carrier.x, y: carrier.y, t: g.tick, n: 4, kind: 'carrier' };
      aiTick(g, S, 1, g.ai);
      if (g.ai.raid) {
        raided = true;
        const b = g.blobs.find(x => !x.dead && x.id === g.ai.raid.blobId);
        if (b && b.order && b.order.type === 'move' && b.order.tid === carrier.id) targetsPrey = true;
      }
    }
  }
  check('a raid was launched', raided, JSON.stringify(g.ai.raid));
  check('the raiding party is ordered onto the remembered caravan', targetsPrey);
}

{
  console.log('normal never raids:');
  const { g } = fixture('ais-x2', 'medium', 'normal');
  const s1 = g.settlements.find(s => s.owner === 1);
  s1.garrison = { deploy: 24, supply: 8, farm: 0 };
  s1.garrFood = 40 * S.C.FOOD_PER_UNIT;
  let sawRaid = false;
  drive(g, 2600, (g2) => {
    g2.ai.prey[999902] = { x: g2.map.w / 2, y: g2.map.h / 2, t: g2.tick, n: 4, kind: 'carrier' };
    if (g2.ai.raid) sawRaid = true;
  });
  check('normal launched no raid', !sawRaid, JSON.stringify(g.ai.raid));
  check('normal filed no prey (the memory pass is hard-only)',
    Object.keys(g.ai.prey).length <= 1); // only our own injected stub
}

// ------------------------------------------- 7. wall breaching

{
  console.log('hard aims at a remembered wall before the town behind it:');
  const { g } = fixture('ais-w1', 'medium', 'hard');
  const s1 = g.settlements.find(s => s.owner === 1);
  const s0 = g.settlements.find(s => s.owner === 0);
  s1.garrison = { deploy: 30, supply: 8, farm: 0 };
  s1.garrFood = 60 * S.C.FOOD_PER_UNIT;
  // real player walls ringing the player town, and matching AI memory
  const ring = [];
  for (let k = -2; k <= 1; k++) {
    const wx = s0.x - 3, wy = s0.y + k;
    const r = S.canPlaceWall(g, 0, wx, wy);
    if (r.err) continue;
    const w = { id: g.nextId++, owner: 0, x: wx, y: wy, building: false, hp: 100, maxHp: 100,
      garrison: { deploy: 0, supply: 0, farm: 0 }, garrFood: 0, stock: 0, convert: null, work: 0, need: 1 };
    ring.push(w);
  }
  let wallOrder = false, seenSett = false;
  for (let i = 0; i < 900; i++) {
    S.step(g);
    if (g.tick % 20 === 0) {
      remember(g.ai, s0.id, s0.x, s0.y, g.tick, 3);
      for (const w of ring) g.ai.knownWalls[w.id] = { x: w.x, y: w.y, g: 0, t: g.tick };
      aiTick(g, S, 1, g.ai);
      for (const a of g.ai.armies) {
        if (a.order && a.order.kind === 'wall') wallOrder = true;
        if (a.order && a.order.kind === 'settlement') seenSett = true;
      }
    }
  }
  check('an offensive was mounted', wallOrder || seenSett,
    JSON.stringify(g.ai.armies.map(a => a.order)));
  check('it opened by breaching the remembered wall ring', wallOrder);
}

{
  console.log('normal has no breach doctrine — it counts the ring as defence:');
  const { g } = fixture('ais-w2', 'medium', 'normal');
  const s1 = g.settlements.find(s => s.owner === 1);
  const s0 = g.settlements.find(s => s.owner === 0);
  s1.garrison = { deploy: 30, supply: 8, farm: 0 };
  s1.garrFood = 60 * S.C.FOOD_PER_UNIT;
  let wallOrder = false;
  for (let i = 0; i < 900; i++) {
    S.step(g);
    if (g.tick % 20 === 0) {
      remember(g.ai, s0.id, s0.x, s0.y, g.tick, 3);
      for (let k = 0; k < 4; k++) {
        g.ai.knownWalls[880000 + k] = { x: s0.x - 3, y: s0.y + k - 2, g: 2, t: g.tick };
      }
      aiTick(g, S, 1, g.ai);
      for (const a of g.ai.armies) if (a.order && a.order.kind === 'wall') wallOrder = true;
    }
  }
  check('normal never issues a wall-breach order', !wallOrder);
}

// ------------------------------------------- 8. determinism

{
  console.log('the new logic adds no nondeterminism:');
  function fingerprint() {
    const { g } = fixture('ais-z1', 'small', 'hard');
    drive(g, 3500, (g2) => {
      if (g2.tick % 200 === 0) {
        const s0 = g2.settlements.find(s => s.owner === 0);
        if (s0) remember(g2.ai, s0.id, s0.x, s0.y, g2.tick, 5);
      }
    });
    return JSON.stringify({
      setts: g.settlements.map(s => [s.owner, s.x, s.y]).sort(),
      walls: g.walls.map(w => [w.owner, w.x, w.y]).sort(),
      blobs: g.blobs.filter(b => !b.dead).length,
      seq: g.ai.scoutSeq,
    });
  }
  const a = fingerprint(), b = fingerprint();
  check('two identical runs produce identical worlds', a === b);
  check('the deterministic scout rotation advanced', JSON.parse(a).seq > 0, a);
}

// ------------------------------------------- 9. save / resume round-trip

{
  console.log('the new AI state survives a JSON round-trip:');
  const { g } = fixture('ais-s1', 'small', 'hard');
  const s1 = g.settlements.find(s => s.owner === 1);
  s1.garrison = { deploy: 26, supply: 8, farm: 0 };
  s1.garrFood = 40 * S.C.FOOD_PER_UNIT;
  drive(g, 1200, (g2) => {
    const s0 = g2.settlements.find(s => s.owner === 0);
    if (s0) remember(g2.ai, s0.id, s0.x, s0.y, g2.tick, 4);
    g2.ai.prey[999903] = { x: g2.map.w / 2, y: g2.map.h / 2, t: g2.tick, n: 3, kind: 'carrier' };
  });
  const snap = JSON.parse(JSON.stringify(S.serialize(g)));
  const g2 = S.deserialize(snap);
  check('armies survive', JSON.stringify(g2.ai.armies) === JSON.stringify(g.ai.armies),
    JSON.stringify(g2.ai.armies));
  check('prey survives', Object.keys(g2.ai.prey).length === Object.keys(g.ai.prey).length);
  check('scoutIds + scoutSeq survive',
    JSON.stringify(g2.ai.scoutIds) === JSON.stringify(g.ai.scoutIds)
    && g2.ai.scoutSeq === g.ai.scoutSeq);
  let threw = null;
  try { drive(g2, 400, (gg) => { void gg; }); } catch (e) { threw = e; }
  check('the resumed game keeps ticking', !threw, threw && threw.stack);
}

{
  console.log('a pre-#207 save migrates cleanly:');
  const { g } = fixture('ais-s2', 'small', 'hard');
  drive(g, 300);
  const snap = JSON.parse(JSON.stringify(S.serialize(g)));
  // rewind the ai blob to the old shape
  snap.ai = {
    known: { 5: { x: 4, y: 4, t: 0 } }, threats: {}, rumors: [],
    lastExpand: 0, lastScout: 0, lastAttack: 0, attacking: true,
    armyId: 12345, scoutId: 6789, expand: null, siege: { settId: 5, g: 3, t: 0 },
  };
  const g2 = S.deserialize(snap);
  check('armyId became a one-entry army list',
    Array.isArray(g2.ai.armies) && g2.ai.armies.length === 1 && g2.ai.armies[0].id === 12345,
    JSON.stringify(g2.ai.armies));
  check('the in-flight siege carried over', g2.ai.armies[0].siege
    && g2.ai.armies[0].siege.settId === 5);
  check('scoutId became scoutIds', JSON.stringify(g2.ai.scoutIds) === '[6789]');
  check('prey / raid / scoutSeq defaults were filled',
    JSON.stringify(g2.ai.prey) === '{}' && g2.ai.raid === null && g2.ai.scoutSeq === 0);
  let threw = null;
  try { drive(g2, 300); } catch (e) { threw = e; }
  check('the migrated game ticks without throwing', !threw, threw && threw.stack);
  check('the dead army id was retired on the first pass', g2.ai.armies.length === 0,
    JSON.stringify(g2.ai.armies));
}

// ------------------------------- 10. attract mode: both owners, no game.ai

{
  console.log('attract mode can drive both owners off separate state:');
  seedRandom('ais-a1:rng');
  const g = S.newGame('ais-a1', 'small', 'hard');
  const fresh = () => ({
    known: {}, lastExpand: 0, lastScout: 0, lastAttack: 0,
    attacking: false, armyId: null, scoutId: null, expand: null,
  });
  const ai0 = fresh(), ai1 = fresh();
  let threw = null;
  try {
    for (let i = 0; i < 2500; i++) {
      S.step(g);
      if (g.tick % 20 === 0) aiTick(g, S, 1, ai1);
      else if (g.tick % 20 === 10) aiTick(g, S, 0, ai0);
    }
  } catch (e) { threw = e; }
  check('two commanders ran side by side without throwing', !threw, threw && threw.stack);
  check('owner-0 state stayed on its own object', ai0 !== g.ai && ai0.known !== undefined);
  check('game.ai was not written by the per-owner calls',
    Object.keys(g.ai.known).length === 0 && g.ai.armies.length === 0,
    JSON.stringify({ k: Object.keys(g.ai.known).length, a: g.ai.armies.length }));
  check('both sides developed', g.settlements.filter(s => s.owner === 0).length >= 1
    && g.settlements.filter(s => s.owner === 1).length >= 1);
}

// ------------------------------- 11. veryhard: threat-weighted targeting

// Drive one owner at its own difficulty's cadence, refreshing whatever
// fog evidence the scenario wants held steady.
function driveAt(g, ticks, diffKey, onAi, owner = 1, state = null) {
  const cad = S.aiCadence(diffKey);
  for (let i = 0; i < ticks; i++) {
    S.step(g);
    if (g.tick % cad === 0) {
      if (onAi) onAi(g);
      aiTick(g, S, owner, state || g.ai);
    }
  }
}

{
  console.log('veryhard counts the field army guarding a town, hard does not:');
  // Two remembered towns of EQUAL garrison. The near one has a
  // remembered enemy war party sitting on it; the far one is bare.
  function pick(diffKey, withThreat) {
    const { g } = fixture(`ais-ft-${diffKey}-${withThreat}`, 'medium', diffKey);
    const s1 = g.settlements.find(s => s.owner === 1);
    g.ai.armies = [];
    // far enough apart that the threat parked on `near` is nowhere near
    // `far` (the field-army radius is 10 tiles)
    const near = { x: Math.round(s1.x + 12), y: s1.y };
    const far = { x: s1.x, y: Math.round(s1.y + 18) };
    s1.garrison = { deploy: 30, supply: 6, farm: 0 };
    s1.garrFood = 40 * S.C.FOOD_PER_UNIT;
    let picked = null;
    driveAt(g, 900, diffKey, (g2) => {
      remember(g2.ai, 90001, near.x, near.y, g2.tick, 3);
      remember(g2.ai, 90002, far.x, far.y, g2.tick, 3);
      if (withThreat) {
        // a big enemy column parked beside the near town — SEEN, not peeked
        g2.ai.threats[90501] = { x: near.x + 1, y: near.y + 1, size: 26, t: g2.tick };
      }
      if (g2.ai.armies.length && picked == null) picked = g2.ai.armies[0].targetId;
    });
    if (picked == null && g.ai.armies.length) picked = g.ai.armies[0].targetId;
    return picked;
  }
  const vhClear = pick('veryhard', false);
  const vhGuarded = pick('veryhard', true);
  const hardGuarded = pick('hard', true);
  check('with nothing in the way veryhard takes the near town', vhClear === 90001,
    `targetId=${vhClear}`);
  check('a remembered relief force sends it at the uncovered town instead',
    vhGuarded === 90002, `targetId=${vhGuarded}`);
  check('hard ignores the field army and walks into it', hardGuarded === 90001,
    `targetId=${hardGuarded}`);
}

{
  console.log('commitTicks still forces a commitment when everything looks guarded:');
  const { g } = fixture('ais-ft-commit', 'medium', 'veryhard');
  const s1 = g.settlements.find(s => s.owner === 1);
  g.ai.armies = [];
  const near = { x: Math.round(s1.x + 12), y: s1.y };
  s1.garrison = { deploy: 30, supply: 6, farm: 0 };
  s1.garrFood = 40 * S.C.FOOD_PER_UNIT;
  // pretend the commander has been idle far longer than commitTicks
  g.ai.lastAttack = -S.DIFF.veryhard.commitTicks * 3;
  let picked = null;
  driveAt(g, 1200, 'veryhard', (g2) => {
    remember(g2.ai, 90001, near.x, near.y, g2.tick, 8);
    g2.ai.threats[90502] = { x: near.x + 1, y: near.y + 1, size: 40, t: g2.tick };
    if (g2.ai.armies.length && picked == null) picked = g2.ai.armies[0].targetId;
  });
  check('it committed to the best available odds anyway', picked === 90001,
    `targetId=${picked}, lastAttack=${g.ai.lastAttack}`);
}

// ------------------------------- 12. veryhard: mass assault

{
  // One column is already committed to a town it is far too small to
  // take, and a fat spare column is sitting at home with nothing else on
  // the map worth marching at. Hard leaves it standing; veryhard sends it
  // in on the SAME order, which is what tickMerge folds together.
  function massRun(diffKey) {
    seedRandom('ais-mass:' + diffKey);
    const g = S.newGame('ais-mass', 'medium', diffKey);
    const s1 = g.settlements.find(s => s.owner === 1);
    clearField(g, 1);
    s1.stockpile = 500;
    s1.garrison = { deploy: 60, supply: 8, farm: 0 };
    s1.garrFood = 90 * S.C.FOOD_PER_UNIT;
    const tgt = { x: Math.round(s1.x + 13), y: s1.y };
    remember(g.ai, 90003, tgt.x, tgt.y, 0, 22);   // needs ~53 to storm
    const a = S.opFieldRole(g, s1, 'deploy', 12).blob;
    placeAt(g, a, tgt.x + 1, tgt.y + 1, 5);
    S.opMove(g, a, tgt.x + 1, tgt.y + 1, { kind: 'settlement', id: 90003 });
    g.ai.armies = [{
      id: a.id, targetId: 90003, siege: null, t: 0, start: 12, reinf: [],
      order: { kind: 'settlement', id: 90003, x: tgt.x + 1, y: tgt.y + 1 },
    }];
    const b = S.opFieldRole(g, s1, 'deploy', 20).blob;
    placeAt(g, b, s1.x + 1, s1.y + 1, 4);
    g.ai.lastAttack = 0;
    S.step(g);
    remember(g.ai, 90003, tgt.x, tgt.y, g.tick, 22);
    aiTick(g, S, 1, g.ai);
    return { g, targets: g.ai.armies.map(r => r.targetId), spare: b };
  }

  console.log('a second column joins the assault instead of idling:');
  const v = massRun('veryhard');
  check('a second column was committed', v.targets.length === 2, JSON.stringify(v.targets));
  check('both are aimed at the same town (so tickMerge folds them)',
    v.targets.length === 2 && v.targets[0] === v.targets[1], JSON.stringify(v.targets));
  check('the spare column really is marching on that town',
    !!(v.spare.order && v.spare.order.type === 'move' && v.spare.order.tid === 90003),
    JSON.stringify(v.spare.order));

  console.log('hard leaves its second army standing:');
  const h = massRun('hard');
  check('hard never stacks two armies on one town', h.targets.length === 1,
    JSON.stringify(h.targets));
}

// ------------------------------- 13. veryhard: siege running + wall supply

{
  console.log('caravans run the ring into a besieged town:');
  const { g } = fixture('ais-siegerun', 'small', 'veryhard');
  const home = g.settlements.find(s => s.owner === 1);
  home.garrison = { deploy: 30, supply: 12, farm: 0 };
  home.garrFood = 60 * S.C.FOOD_PER_UNIT;
  home.stockpile = 500;
  // found a second own town the sim's own way, then let it finish
  let far = null;
  for (let dx = 8; dx <= 14 && !far; dx++) {
    const ax = Math.min(g.map.w - 4, home.x + dx);
    if (!S.footprintFits(g, ax, home.y)) continue;
    const r = S.opFieldRole(g, home, 'deploy', 8);
    if (!r.ok) break;
    if (S.opBuildAt(g, r.blob, ax + 1, home.y + 1).err) continue;
    for (let i = 0; i < 1200; i++) S.step(g);
    far = g.settlements.find(s => s.owner === 1 && s.id !== home.id && !s.building);
  }
  check('a second own town exists to haul to', !!far);
  if (far) {
    home.garrison.supply = 8;
    home.stockpile = 500;
    const route = S.opSupplyRoute(g, home, { kind: 'settlement', id: far.id });
    check('a supply route was established', !!route.ok, JSON.stringify(route));
    // park an enemy war party on the destination and hold it there
    const pin = () => {
      const f = g.blobs.find(b => b.owner === 0 && !b.dead && b.count.deploy > 0);
      if (f) { f.x = far.x + 1; f.y = far.y + 1; f.order = null; f.path = null; }
    };
    for (let i = 0; i < 60; i++) {
      S.step(g);
      pin();
      if (g.tick % S.aiCadence('veryhard') === 0) aiTick(g, S, 1, g.ai);
    }
    const r = g.routes.find(x => x.targetKind === 'settlement' && x.targetId === far.id);
    check('the besieged town is under siege', S.besieged(g, far));
    check('its route was ordered to run the ring', !!(r && r.runSiege),
      JSON.stringify(r ? { id: r.id, runSiege: r.runSiege } : g.routes.length));
    // lift the siege — the flag must clear again
    for (const b of g.blobs) if (b.owner === 0) b.dead = true;
    driveAt(g, 40, 'veryhard');
    const r2 = g.routes.find(x => x.targetKind === 'settlement' && x.targetId === far.id);
    check('and cleared once the ring lifted', !!r2 && !r2.runSiege,
      JSON.stringify(r2 ? { runSiege: r2.runSiege } : g.routes.length));
  }
}

{
  console.log('a hungry wall garrison gets a caravan:');
  const { g } = fixture('ais-wallsupply', 'small', 'veryhard');
  const s1 = g.settlements.find(s => s.owner === 1);
  s1.stockpile = 500;
  s1.garrison = { deploy: 10, supply: 8, farm: 0 };
  s1.garrFood = 40 * S.C.FOOD_PER_UNIT;
  // a manned own wall well outside territory, with an empty stash — the
  // choke-plug case the drip can never reach
  let placed = null;
  for (let r = 9; r <= 14 && !placed; r++) {
    for (let a = 0; a < 16 && !placed; a++) {
      const th = a * Math.PI / 8;
      const x = Math.round(s1.x + 1 + Math.cos(th) * r), y = Math.round(s1.y + 1 + Math.sin(th) * r);
      if (!passable(g.map, x, y)) continue;
      if (S.canPlaceWall(g, 1, x, y).err) continue;
      placed = S.placeFinishedWall(g, 1, x, y, { deploy: 4, supply: 0, farm: 0 }, 0);
    }
  }
  check('a manned wall was planted outside territory', !!placed);
  if (placed) {
    placed.food = 0;
    check('its stash really is empty', S.wallStockFrac(placed) <= 0.01);
    driveAt(g, 200, 'veryhard');
    const r = g.routes.find(x => x.owner === 1 && x.targetKind === 'wall' && x.targetId === placed.id);
    check('a caravan route was sent out to it', !!r,
      JSON.stringify(g.routes.map(x => [x.targetKind, x.targetId])));
  }
}

// ------------------------------- 14. veryhard: two raiding parties

{
  // A raid scenario needs REAL soft targets: prey memory of a blob that
  // does not exist is (correctly) forgotten the moment a raider stands on
  // the empty spot. So keep three live enemy caravans loitering between
  // the capitals and record them the way the fog would.
  function raidRun(tag, diffKey) {
    const { g } = fixture(tag, 'medium', diffKey);
    const s1 = g.settlements.find(s => s.owner === 1);
    const s0 = g.settlements.find(s => s.owner === 0);
    s1.garrison = { deploy: 40, supply: 6, farm: 0 };
    s1.garrFood = 60 * S.C.FOOD_PER_UNIT;
    s1.stockpile = 500;
    g.ai.lastRaid = -9999;
    let peak = 0, distinct = true;
    driveAt(g, 4000, diffKey, (g2) => {
      let vans = g2.blobs.filter(b => !b.dead && b.owner === 0
        && S.total(b) > 0 && b.count.supply === S.total(b));
      while (vans.length < 3) {
        s0.garrison.supply += 2;
        s0.garrFood = S.garrisonTotal(s0) * S.C.FOOD_PER_UNIT;
        const r = S.opFieldRole(g2, s0, 'supply', 2);
        if (!r.ok) break;
        placeAt(g2, r.blob, s1.x + 1, s1.y + 1, 11, vans.length * 2);
        vans.push(r.blob);
      }
      for (const c of vans) {
        g2.ai.prey[c.id] = { x: c.x, y: c.y, t: g2.tick, n: S.total(c), kind: 'carrier' };
      }
      // spare hands loose near home, the cheapest party the raid pass takes
      const parked = g2.blobs.filter(b => !b.dead && b.owner === 1
        && b.count.deploy >= 3 && b.count.deploy <= 8 && S.total(b) === b.count.deploy);
      if (parked.length < 2) {
        s1.garrison.deploy = Math.max(s1.garrison.deploy, 12);
        s1.garrFood = S.garrisonTotal(s1) * S.C.FOOD_PER_UNIT;
        const r = S.opFieldRole(g2, s1, 'deploy', 4);
        if (r.ok) placeAt(g2, r.blob, s1.x + 1, s1.y + 1, 6, parked.length * Math.PI);
      }
      peak = Math.max(peak, g2.ai.raids.length);
      if (g2.ai.raids.length >= 2) {
        const ids = g2.ai.raids.map(r => r.preyId);
        if (new Set(ids).size !== ids.length) distinct = false;
      }
    });
    return { g, peak, distinct };
  }

  console.log('veryhard hunts two caravans at once:');
  const v = raidRun('ais-raids', 'veryhard');
  check('two raiding parties were out at once', v.peak >= 2, `peak=${v.peak}`);
  check('the two parties never chase the same caravan', v.distinct,
    JSON.stringify(v.g.ai.raids));
  check('the legacy state.raid mirror tracks the first party',
    (v.g.ai.raids.length === 0 && v.g.ai.raid === null)
    || (v.g.ai.raid && v.g.ai.raid.blobId === v.g.ai.raids[0].blobId),
    JSON.stringify({ raid: v.g.ai.raid, raids: v.g.ai.raids }));

  console.log('hard still raids with exactly one party:');
  const h = raidRun('ais-raids-hard', 'hard');
  check('hard raided at all', h.g.ai.lastRaid > 0, `lastRaid=${h.g.ai.lastRaid}`);
  check('hard never runs a second party', h.peak <= 1, `peak=${h.peak}`);
}

// ------------------------------- 15. veryhard: surplus farmers get armed

{
  console.log('farm hands the land cannot pay for are armed:');
  const { g } = fixture('ais-rerole', 'small', 'veryhard');
  const s1 = g.settlements.find(s => s.owner === 1);
  clearField(g, 1);
  s1.stockpile = 400;
  // far more hands than the town has worthwhile plots
  const y = S.farmYield(g, s1);
  s1.garrison = { deploy: 6, supply: 2, farm: y.worthwhileCells + 12 };
  s1.garrFood = S.garrisonTotal(s1) * S.C.FOOD_PER_UNIT;
  let armed = null;
  driveAt(g, 400, 'veryhard', () => {
    if (armed) return;
    armed = g.blobs.find(b => !b.dead && b.owner === 1
      && b.convert && b.convert.role === 'deploy');
  });
  if (!armed) {
    armed = g.blobs.find(b => !b.dead && b.owner === 1 && b.convert && b.convert.role === 'deploy');
  }
  check('a group of hands was fielded and put on arming duty', !!armed,
    JSON.stringify(g.blobs.filter(b => !b.dead && b.owner === 1)
      .map(b => ({ c: b.count, conv: b.convert && b.convert.role }))));
  check('the rest of the hands are still working plots',
    g.blobs.some(b => !b.dead && b.owner === 1 && b.working === s1.id)
    || s1.garrison.farm > 0,
    JSON.stringify({ garr: s1.garrison }));
}

{
  console.log('hard leaves its surplus hands in the fields:');
  const { g } = fixture('ais-rerole-hard', 'small', 'hard');
  const s1 = g.settlements.find(s => s.owner === 1);
  clearField(g, 1);
  s1.stockpile = 400;
  const y = S.farmYield(g, s1);
  s1.garrison = { deploy: 6, supply: 2, farm: y.worthwhileCells + 12 };
  s1.garrFood = S.garrisonTotal(s1) * S.C.FOOD_PER_UNIT;
  driveAt(g, 400, 'hard');
  const armed = g.blobs.find(b => !b.dead && b.owner === 1 && b.convert && b.convert.role === 'deploy');
  check('hard never re-roles a farm group', !armed);
}

// ------------------------------- 16. veryhard: determinism & save/resume

{
  console.log('veryhard adds no nondeterminism:');
  function fingerprint() {
    const { g } = fixture('ais-vz1', 'small', 'veryhard');
    driveAt(g, 3500, 'veryhard', (g2) => {
      if (g2.tick % 200 === 0) {
        const s0 = g2.settlements.find(s => s.owner === 0);
        if (s0) remember(g2.ai, s0.id, s0.x, s0.y, g2.tick, 5);
      }
    });
    return JSON.stringify({
      setts: g.settlements.map(s => [s.owner, s.x, s.y]).sort(),
      walls: g.walls.map(w => [w.owner, w.x, w.y]).sort(),
      blobs: g.blobs.filter(b => !b.dead).length,
      raids: g.ai.raids.length,
      seq: g.ai.scoutSeq,
    });
  }
  const a = fingerprint(), b = fingerprint();
  check('two identical veryhard runs produce identical worlds', a === b);
}

{
  console.log('veryhard state survives a JSON round-trip:');
  const { g } = fixture('ais-vs1', 'small', 'veryhard');
  const s1 = g.settlements.find(s => s.owner === 1);
  s1.garrison = { deploy: 26, supply: 8, farm: 0 };
  s1.garrFood = 40 * S.C.FOOD_PER_UNIT;
  g.ai.lastRaid = -9999;
  driveAt(g, 1500, 'veryhard', (g2) => {
    const s0 = g2.settlements.find(s => s.owner === 0);
    if (s0) remember(g2.ai, s0.id, s0.x, s0.y, g2.tick, 4);
    g2.ai.prey[999903] = { x: g2.map.w / 2, y: g2.map.h / 2, t: g2.tick, n: 3, kind: 'carrier' };
    g2.ai.prey[999904] = { x: g2.map.w / 3, y: g2.map.h / 3, t: g2.tick, n: 4, kind: 'carrier' };
  });
  const snap = JSON.parse(JSON.stringify(S.serialize(g)));
  const g2 = S.deserialize(snap);
  check('the raid list survives',
    JSON.stringify(g2.ai.raids) === JSON.stringify(g.ai.raids), JSON.stringify(g2.ai.raids));
  check('the re-role cooldown map survives',
    JSON.stringify(g2.ai.reroleT) === JSON.stringify(g.ai.reroleT));
  check('the save kept the difficulty key', g2.difficulty === 'veryhard');
  let threw = null;
  try { driveAt(g2, 400, 'veryhard'); } catch (e) { threw = e; }
  check('the resumed veryhard game keeps ticking', !threw, threw && threw.stack);
}

{
  console.log('a save with the legacy single raid slot migrates:');
  const { g } = fixture('ais-vs2', 'small', 'veryhard');
  driveAt(g, 300, 'veryhard');
  const snap = JSON.parse(JSON.stringify(S.serialize(g)));
  snap.ai = {
    known: {}, knownWalls: {}, threats: {}, prey: {}, rumors: [],
    lastExpand: 0, lastScout: 0, lastAttack: 0, lastRaid: 0, attacking: false,
    armies: [], armyId: null, scoutIds: [], scoutId: null, scoutSeq: 0,
    raid: { blobId: 4242, preyId: 77, t: 0 }, expand: null,
  };
  const g2 = S.deserialize(snap);
  let threw = null;
  try { driveAt(g2, 40, 'veryhard'); } catch (e) { threw = e; }
  check('the migrated game ticks without throwing', !threw, threw && threw.stack);
  check('the legacy record became a raids entry (then retired with its dead blob)',
    Array.isArray(g2.ai.raids) && g2.ai.raids.length === 0, JSON.stringify(g2.ai.raids));
}

{
  console.log('an unknown difficulty key degrades instead of throwing:');
  const { g } = fixture('ais-unknown', 'small', 'hard');
  g.difficulty = 'brutal-9000';
  let threw = null;
  try { drive(g, 200); } catch (e) { threw = e; }
  check('aiTick fell back to normal', !threw, threw && threw.stack);
}

// ------------------------------- 17. the smarter commander actually wins more

{
  console.log('hard beats easy head to head on the same map:');
  function duel(tag, aKey, bKey) {
    seedRandom(tag + ':rng');
    const g = S.newGame(tag, 'small', 'hard');
    const a0 = { known: {}, diffKey: aKey, lastExpand: 0, lastScout: 0, lastAttack: 0, expand: null };
    const a1 = { known: {}, diffKey: bKey, lastExpand: 0, lastScout: 0, lastAttack: 0, expand: null };
    const cad0 = S.aiCadence(aKey), cad1 = S.aiCadence(bKey);
    for (let i = 0; i < 14000 && !g.result; i++) {
      S.step(g);
      if (g.tick % cad1 === 0) aiTick(g, S, 1, a1);
      if (g.tick % cad0 === (cad0 >> 1)) aiTick(g, S, 0, a0);
    }
    const own = o => g.settlements.filter(s => s.owner === o).length;
    const men = o => g.blobs.filter(b => !b.dead && b.owner === o).reduce((n, b) => n + S.total(b), 0)
      + g.settlements.filter(s => s.owner === o).reduce((n, s) => n + S.garrisonTotal(s), 0);
    return { setts: [own(0), own(1)], men: [men(0), men(1)], result: g.result };
  }
  // owner 1 plays hard, owner 0 plays easy
  const r = duel('ais-duel1', 'easy', 'hard');
  console.log(`    setts ${JSON.stringify(r.setts)}  men ${JSON.stringify(r.men)}  result ${r.result || 'ongoing'}`);
  check('the hard commander is not behind on settlements', r.setts[1] >= r.setts[0],
    JSON.stringify(r.setts));
  check('the hard commander is not behind on manpower', r.men[1] >= r.men[0] * 0.9,
    JSON.stringify(r.men));

  // veryhard vs hard, over SEVERAL maps rather than one.
  //
  // A strict inequality on a single seed is not a test of "is stronger":
  // the tuned veryhard measures ~0.71 head to head over 80 matches, so it
  // still drops ~3 maps in 10 and any one seed can go either way. Scoring
  // a set and asserting the majority is what the claim actually says. The
  // suite seeds Math.random per duel, so this is deterministic, not flaky.
  console.log('veryhard beats hard across a set of maps:');
  let vhWins = 0, played = 0;
  const lines = [];
  for (const tag of ['ais-duel2', 'ais-duel3', 'ais-duel4', 'ais-duel5', 'ais-duel6']) {
    const d = duel(tag, 'hard', 'veryhard');
    played++;
    // ahead on towns, or level on towns and ahead on manpower
    const win = d.setts[1] > d.setts[0]
      || (d.setts[1] === d.setts[0] && d.men[1] > d.men[0]);
    if (win) vhWins++;
    lines.push(`${tag}: setts ${JSON.stringify(d.setts)} men ${JSON.stringify(d.men)} ${win ? 'VH' : 'hard'}`);
  }
  for (const l of lines) console.log('    ' + l);
  check(`the veryhard commander takes the majority of maps (${vhWins}/${played})`,
    vhWins * 2 > played, lines.join(' | '));
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
