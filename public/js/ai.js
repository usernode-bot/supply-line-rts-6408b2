// Scripted opponent. Evaluated every ~2 s (20 ticks) from the main loop.
// Uses the same sim ops as the player. Terrain is fully known to it, but
// player positions must be discovered by scouting (its own vision +
// memory) — no fog cheating on player entities at any difficulty.
//
// State machine per the spec: Expand → Develop → Scout → Attack → Defend.
// All persistent state lives on game.ai so it survives save/resume.

import { dist } from './mapgen.js';

const SETT_TARGETS = { small: 3, medium: 4, large: 5 };

export function aiTick(game, S) {
  if (game.result) return;
  const ai = game.ai;
  const diff = S.DIFF[game.difficulty];
  const mine = game.blobs.filter(b => !b.dead && b.owner === 1);
  const setts = game.settlements.filter(s => s.owner === 1);
  if (setts.length === 0) return;

  updateMemory(game, S, mine, setts);
  develop(game, S, setts, mine);
  defend(game, S, setts, mine, ai);
  expand(game, S, setts, mine, ai, diff);
  scout(game, S, setts, mine, ai, diff);
  attack(game, S, setts, mine, ai, diff);
  muster(game, S, setts, mine, ai, diff);
}

// -- memory: what the AI has actually seen ----------------------------

function canSee(mine, setts, x, y, S) {
  for (const s of setts) if (dist(s.x + 1, s.y + 1, x, y) <= S.C.VISION_SETT) return true;
  for (const b of mine) if (dist(b.x, b.y, x, y) <= S.C.VISION_BLOB) return true;
  return false;
}

function updateMemory(game, S, mine, setts) {
  const known = game.ai.known;
  for (const s of game.settlements) {
    if (s.owner === 0 && canSee(mine, setts, s.x, s.y, S)) known[s.id] = { x: s.x, y: s.y };
  }
  for (const id of Object.keys(known)) {
    const k = known[id];
    if (canSee(mine, setts, k.x, k.y, S) && !game.settlements.some(s => s.id === +id)) {
      delete known[id];
    }
  }
}

// -- develop: production modes + fielding trained units ---------------

function develop(game, S, setts, mine) {
  let supplyCount = 0, deployCount = 0;
  for (const b of mine) { supplyCount += b.count.supply; deployCount += b.count.deploy; }
  for (const s of setts) { supplyCount += s.garrison.supply; deployCount += s.garrison.deploy; }

  for (const s of setts) {
    if (s.building) continue; // construction sites can't train or field (#95)
    if (s.stockpile < 50) S.opSetMode(game, s, 'farm');
    else if (s.stockpile > 150 && s.mode === 'farm') {
      S.opSetMode(game, s, supplyCount < Math.max(3, deployCount / 4) ? 'supply' : 'deploy');
    }
    // keep a small home guard; field the rest to the rally
    if (s.garrison.deploy > 4) {
      const r = S.opFieldRole(game, s, 'deploy', s.garrison.deploy - 4);
      if (r.ok) sendToRally(game, S, setts, r.blob);
    }
  }
}

function rallyPoint(game, setts) {
  // never rally at a construction site — it can't feed the muster (#95)
  const ready = setts.filter(s => !s.building);
  const pool = ready.length ? ready : setts;
  let best = pool[0];
  for (const s of pool) if (s.stockpile > best.stockpile) best = s;
  // stay inside the settlement's feed radius so the mustering army eats
  const cx = game.map.w / 2, cy = game.map.h / 2;
  const dx = cx - best.x, dy = cy - best.y;
  const d = Math.max(1, Math.sqrt(dx * dx + dy * dy));
  return { x: best.x + 1 + (dx / d) * 2.6, y: best.y + 1 + (dy / d) * 2.6 };
}

function sendToRally(game, S, setts, b) {
  const r = rallyPoint(game, setts);
  S.opMove(game, b, r.x, r.y);
}

// -- expand: found new settlements on good land ------------------------

function expand(game, S, setts, mine, ai, diff) {
  // finish an in-flight expansion first
  if (ai.expand) {
    const b = mine.find(x => x.id === ai.expand.blobId);
    if (!b) { ai.expand = null; }
    else if (!b.order) {
      if (dist(b.x, b.y, ai.expand.x, ai.expand.y) < 2.5) {
        const res = S.opBuild(game, b);
        ai.expand = null;
        if (res.err) { /* site got contested; try again later */ }
      } else {
        // stalled — retry the move once, then give up on this site
        if (S.opMove(game, b, ai.expand.x, ai.expand.y).err) ai.expand = null;
        else ai.expand.retried = (ai.expand.retried || 0) + 1;
        if (ai.expand && ai.expand.retried > 2) { ai.expand = null; }
      }
    }
    return;
  }
  const target = SETT_TARGETS[game.sizeKey] || 4;
  if (setts.length >= target) return;
  if (game.tick - ai.lastExpand < diff.expandTicks) return;

  // need 5+ deploy: prefer an idle field blob, else field from a garrison
  let b = mine.find(x => !x.order && x.count.deploy >= 6 && x.id !== ai.armyId && x.id !== ai.scoutId);
  if (!b) {
    const s = setts.find(x => x.garrison.deploy >= 9); // 5 to build + keep guard
    if (!s) return;
    const r = S.opFieldRole(game, s, 'deploy', 6);
    if (!r.ok) return;
    b = r.blob;
  }
  const site = pickSite(game, S, setts, ai);
  if (!site) return;
  if (S.opMove(game, b, site.x + 1, site.y + 1).ok) {
    ai.expand = { blobId: b.id, x: site.x + 1, y: site.y + 1 };
    ai.lastExpand = game.tick;
  }
}

function pickSite(game, S, setts, ai) {
  const { w, h, orig } = game.map;
  let best = null, bestScore = -Infinity;
  for (let y = 4; y < h - 4; y += 3) {
    for (let x = 4; x < w - 4; x += 3) {
      // the whole 2×2 footprint anchored here must be buildable
      if (!S.footprintFits(game, x, y)) continue;
      let ok = true, nearest = Infinity;
      for (const s of game.settlements) {
        const d = dist(s.x, s.y, x, y);
        if (d < 9) { ok = false; break; }
        if (s.owner === 1 && d < nearest) nearest = d;
      }
      if (!ok || nearest > 26) continue;
      // score the farmland ring around the footprint center
      let fert = 0;
      for (let dy = -2; dy <= 3; dy++) for (let dx = -2; dx <= 3; dx++) {
        const tx = x + dx, ty = y + dy;
        if (tx < 0 || ty < 0 || tx >= w || ty >= h) continue;
        if (dist(tx + 0.5, ty + 0.5, x + 1, y + 1) > 2.7) continue;
        if (dx >= 0 && dx <= 1 && dy >= 0 && dy <= 1) continue; // footprint
        fert += orig[ty * w + tx];
      }
      let danger = 0;
      for (const k of Object.values(ai.known)) danger += Math.max(0, 30 - dist(k.x, k.y, x, y));
      const score = fert - nearest * 0.15 - danger * 0.2;
      if (score > bestScore) { bestScore = score; best = { x, y }; }
    }
  }
  return best;
}

// -- scout: find the player -------------------------------------------

function scout(game, S, setts, mine, ai, diff) {
  if (ai.scoutId) {
    const b = mine.find(x => x.id === ai.scoutId);
    if (!b) ai.scoutId = null;
    else if (b.order) return;
    else ai.scoutId = null; // arrived; free it up
  }
  if (game.tick - ai.lastScout < diff.scoutTicks) return;
  const s = setts.find(x => x.garrison.deploy >= 2);
  if (!s) return;
  const r = S.opFieldRole(game, s, 'deploy', 1);
  if (!r.ok) return;
  // probe toward a known player settlement, else the mirrored start,
  // else a random quadrant
  const knowns = Object.values(ai.known);
  let tx, ty;
  if (knowns.length && Math.random() < 0.6) {
    const k = knowns[Math.floor(Math.random() * knowns.length)];
    tx = k.x; ty = k.y;
  } else if (Math.random() < 0.6) {
    tx = game.map.starts[0].x; ty = game.map.starts[0].y;
  } else {
    tx = 4 + Math.random() * (game.map.w - 8);
    ty = 4 + Math.random() * (game.map.h - 8);
  }
  if (S.opMove(game, r.blob, tx, ty).ok) {
    ai.scoutId = r.blob.id;
    ai.lastScout = game.tick;
  }
}

// -- muster & attack ---------------------------------------------------

function muster(game, S, setts, mine, ai, diff) {
  if (ai.attacking) return;
  // idle deploy blobs (not tasked) drift to the rally and merge up
  for (const b of mine) {
    if (b.order || b.pillaging || b.id === ai.armyId || b.id === ai.scoutId) continue;
    if (ai.expand && ai.expand.blobId === b.id) continue;
    if (b.count.deploy === 0) continue;
    const r = rallyPoint(game, setts);
    if (dist(b.x, b.y, r.x, r.y) > 3) S.opMove(game, b, r.x, r.y);
  }
}

function attack(game, S, setts, mine, ai, diff) {
  // manage an army already in the field
  if (ai.armyId) {
    const army = mine.find(b => b.id === ai.armyId);
    if (!army) { ai.armyId = null; ai.attacking = false; return; }
    const meter = S.fedMeter(army);
    // live off the land while campaigning: pillage is a persistent
    // stance independent of movement, so a hungry army forages on the
    // march and drops the torch once well-fed again
    if (meter < 0.85 && !army.pillaging) S.opPillage(game, army, true);
    else if (meter > 0.95 && army.pillaging) S.opPillage(game, army, false);
    if (meter < 0.5) {
      // starving offensive: retreat home
      const home = setts[0];
      S.opPillage(game, army, false);
      S.opMove(game, army, home.x + 2.5, home.y + 1);
      ai.armyId = null; ai.attacking = false; ai.siege = null;
      return;
    }
    // siege stall guard (#108): walls now protect garrisons, so a siege
    // that isn't shrinking the garrison after ~2 min of sim time is a
    // grind the AI abandons rather than starving at the walls forever
    if (army.order && army.order.type === 'move' && army.order.tkind === 'settlement') {
      const st = game.settlements.find(x => x.id === army.order.tid);
      const g = st ? st.garrison.deploy + st.garrison.supply + st.garrison.farm : 0;
      if (!st || g === 0) ai.siege = null;
      else if (!ai.siege || ai.siege.settId !== st.id || g < ai.siege.g) {
        ai.siege = { settId: st.id, g, t: game.tick };
      } else if (game.tick - ai.siege.t > 1200) {
        ai.siege = null;
        const home = setts[0];
        S.opPillage(game, army, false);
        S.opMove(game, army, home.x + 2.5, home.y + 1);
        ai.armyId = null; ai.attacking = false;
        return;
      }
    } else ai.siege = null;
    if (!army.order && !army.pillaging) {
      // arrived / target gone — pick the next known target or head home.
      // Plain moves no longer attack-move (#74), so offensives are
      // explicit siege orders on the remembered settlement.
      const t = nearestKnown(ai, army.x, army.y, game);
      if (t) S.opMove(game, army, t.x + 1, t.y + 1, { kind: 'settlement', id: t.id });
      else { ai.attacking = false; ai.armyId = null; }
    }
    return;
  }
  if (ai.attacking) { ai.attacking = false; return; }

  // launch a new offensive when the rally blob is big enough
  const candidates = mine.filter(b =>
    b.count.deploy >= diff.muster && b.id !== ai.scoutId &&
    !(ai.expand && ai.expand.blobId === b.id));
  if (!candidates.length) return;
  const army = candidates[0];
  const t = nearestKnown(ai, army.x, army.y, game);
  if (!t) return; // scouts haven't found the player yet
  if (!S.opMove(game, army, t.x + 1, t.y + 1, { kind: 'settlement', id: t.id }).ok) return;
  ai.armyId = army.id;
  ai.attacking = true;
  ai.lastAttack = game.tick;

  // attach a supply chain sized to distance: reuse an idle pure-supply
  // blob if one is sitting around, else field from a garrison. Carriers
  // move at deploy speed now (#80), so ~1 supply feeds 2.5 fighters at a
  // quarter-map haul instead of the old 5.
  const d = dist(army.x, army.y, t.x, t.y);
  const wanted = Math.max(2, Math.ceil((army.count.deploy / 2.5) * (d / (game.map.w * 0.25))));
  let carrier = mine.find(b =>
    !b.order && b.count.supply > 0 && b.count.deploy === 0 && b.count.farm === 0 && b.id !== army.id);
  if (!carrier) {
    for (const s of setts) {
      if (s.garrison.supply <= 0) continue;
      const r = S.opFieldRole(game, s, 'supply', Math.min(wanted, s.garrison.supply));
      if (r.ok) { carrier = r.blob; break; }
    }
  }
  if (carrier) S.opRoute(game, carrier, { kind: 'blob', id: army.id });
}

function nearestKnown(ai, x, y, game) {
  let best = null, bd = Infinity;
  for (const [id, k] of Object.entries(ai.known)) {
    const d = dist(k.x, k.y, x, y);
    if (d < bd) { bd = d; best = { id: +id, x: k.x, y: k.y }; }
  }
  return best;
}

// -- defend -------------------------------------------------------------

function defend(game, S, setts, mine, ai) {
  const hit = setts.find(s => game.tick - s.lastHitT < 100);
  if (!hit) return;
  // divert the nearest deploy blob with some strength
  let best = null, bd = Infinity;
  for (const b of mine) {
    if (b.count.deploy < 4) continue;
    const d = dist(b.x, b.y, hit.x + 1, hit.y + 1);
    if (d < bd) { bd = d; best = b; }
  }
  if (best && bd > 3) {
    S.opMove(game, best, hit.x + 1, hit.y + 1);
    if (best.id === ai.armyId) { ai.armyId = null; ai.attacking = false; }
  }
}
