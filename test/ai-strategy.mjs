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
  check('only hard raids', !S.DIFF.normal.raid && S.DIFF.hard.raid === true);
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

// ------------------------------- 11. the smarter commander actually wins more

{
  console.log('hard beats easy head to head on the same map:');
  function duel(tag, aKey, bKey) {
    seedRandom(tag + ':rng');
    const g = S.newGame(tag, 'small', 'hard');
    const a0 = { known: {}, diffKey: aKey, lastExpand: 0, lastScout: 0, lastAttack: 0, expand: null };
    const a1 = { known: {}, diffKey: bKey, lastExpand: 0, lastScout: 0, lastAttack: 0, expand: null };
    for (let i = 0; i < 14000 && !g.result; i++) {
      S.step(g);
      if (g.tick % 20 === 0) aiTick(g, S, 1, a1);
      else if (g.tick % 20 === 10) aiTick(g, S, 0, a0);
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
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
