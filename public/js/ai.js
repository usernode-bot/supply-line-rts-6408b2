// Scripted opponent. Evaluated every ~2 s (20 ticks) from the main loop.
// Uses the same sim ops as the player. Terrain is fully known to it, but
// enemy positions must be discovered by scouting (its own vision +
// memory) — no fog cheating on enemy entities at any difficulty, and no
// economy cheating either: difficulty scales decision-making via the
// behavior flags on S.DIFF (see sim.js), never income.
//
// State machine per the spec: Expand → Develop → Scout → Attack → Defend.
// In a real match the AI drives owner 1 with state on game.ai (so it
// survives save/resume). Attract mode drives BOTH sides by calling
// aiTick once per owner with its own state object — the defaults keep
// every existing call site behaving exactly as before.

import { dist } from './mapgen.js';

const SETT_TARGETS = { small: 3, medium: 4, large: 5 };

export function aiTick(game, S, owner = 1, state = game.ai) {
  if (game.result) return;
  // state.diffKey lets a harness (or attract variant) pit difficulties
  // against each other per-owner; real matches fall through to the game's
  const diff = S.DIFF[state.diffKey || game.difficulty];
  const mine = game.blobs.filter(b => !b.dead && b.owner === owner);
  const setts = game.settlements.filter(s => s.owner === owner);
  if (setts.length === 0) { rebuild(game, S, mine, state, diff); return; }

  updateMemory(game, S, mine, setts, owner, state, diff);
  develop(game, S, setts, mine);
  defend(game, S, setts, mine, state, diff);
  expand(game, S, setts, mine, state, diff);
  scout(game, S, setts, mine, state, diff, owner);
  attack(game, S, setts, mine, state, diff);
  muster(game, S, setts, mine, state, diff);
}

// -- memory: what the AI has actually seen ----------------------------

function canSee(mine, setts, x, y, S) {
  for (const s of setts) if (dist(s.x + 1, s.y + 1, x, y) <= S.C.VISION_SETT) return true;
  for (const b of mine) if (dist(b.x, b.y, x, y) <= S.C.VISION_BLOB) return true;
  return false;
}

function updateMemory(game, S, mine, setts, owner, state, diff) {
  const known = state.known;
  for (const s of game.settlements) {
    if (s.owner === 1 - owner && canSee(mine, setts, s.x, s.y, S)) known[s.id] = { x: s.x, y: s.y, t: game.tick };
  }
  // public founding rumors queued by the sim: a rumor-following commander
  // files them as known targets; everyone else discards them (drain
  // either way so the queue can't grow)
  const rumors = state.rumors;
  if (rumors && rumors.length) {
    if (diff.rumors) {
      for (const r of rumors) {
        if (game.settlements.some(s => s.id === r.id)) known[r.id] = { x: r.x, y: r.y, t: r.t };
      }
    }
    rumors.length = 0;
  }
  for (const id of Object.keys(known)) {
    const k = known[id];
    if (k.t == null) k.t = game.tick; // pre-timestamp saves
    if (canSee(mine, setts, k.x, k.y, S) && !game.settlements.some(s => s.id === +id)) {
      delete known[id];
    } else if (diff.memoryTicks && game.tick - k.t > diff.memoryTicks) {
      delete known[id]; // a forgetful commander loses stale intel
    }
  }
  // sighted enemy war parties (fog-fair: recorded only while actually
  // visible; entries are last-seen snapshots, not live tracking)
  if (diff.threats) {
    const threats = state.threats || (state.threats = {});
    for (const b of game.blobs) {
      if (b.dead || b.owner !== 1 - owner || b.count.deploy < 5) continue;
      if (canSee(mine, setts, b.x, b.y, S)) threats[b.id] = { x: b.x, y: b.y, size: b.count.deploy, t: game.tick };
    }
    for (const id of Object.keys(threats)) {
      const k = threats[id];
      const gone = !game.blobs.some(b => !b.dead && b.id === +id && b.count.deploy > 0);
      if (game.tick - k.t > 600 || (gone && canSee(mine, setts, k.x, k.y, S))) delete threats[id];
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

function expand(game, S, setts, mine, state, diff) {
  // finish an in-flight expansion first
  if (state.expand) {
    const b = mine.find(x => x.id === state.expand.blobId);
    if (!b) { state.expand = null; }
    else if (!b.order) {
      if (dist(b.x, b.y, state.expand.x, state.expand.y) < 2.5) {
        const res = S.opBuild(game, b);
        state.expand = null;
        if (res.err) { /* site got contested; try again later */ }
      } else {
        // stalled — retry the move once, then give up on this site
        if (S.opMove(game, b, state.expand.x, state.expand.y).err) state.expand = null;
        else state.expand.retried = (state.expand.retried || 0) + 1;
        if (state.expand && state.expand.retried > 2) { state.expand = null; }
      }
    }
    return;
  }
  const target = SETT_TARGETS[game.sizeKey] || 4;
  if (setts.length >= target) return;
  if (game.tick - state.lastExpand < diff.expandTicks) return;

  // need 5+ deploy: prefer an idle field blob, else field from a garrison
  let b = mine.find(x => !x.order && x.count.deploy >= 6 && x.id !== state.armyId && x.id !== state.scoutId);
  if (!b) {
    const s = setts.find(x => x.garrison.deploy >= 9); // 5 to build + keep guard
    if (!s) return;
    const r = S.opFieldRole(game, s, 'deploy', 6);
    if (!r.ok) return;
    b = r.blob;
  }
  const site = pickSite(game, S, setts, state, diff);
  if (!site) return;
  if (S.opMove(game, b, site.x + 1, site.y + 1).ok) {
    state.expand = { blobId: b.id, x: site.x + 1, y: site.y + 1 };
    state.lastExpand = game.tick;
  }
}

function pickSite(game, S, setts, state, diff) {
  const { w, h } = game.map;
  let best = null, bestScore = -Infinity;
  for (let y = 4; y < h - 4; y += 3) {
    for (let x = 4; x < w - 4; x += 3) {
      // the whole 2×2 footprint anchored here must be buildable
      if (!S.footprintFits(game, x, y)) continue;
      let ok = true, nearest = Infinity;
      for (const s of game.settlements) {
        const d = dist(s.x, s.y, x, y);
        if (d < 9) { ok = false; break; }
        if (setts.includes(s) && d < nearest) nearest = d;
      }
      if (!ok || nearest > 26) continue;
      const fert = siteFertility(game, x, y);
      let danger = 0;
      for (const k of Object.values(state.known)) danger += Math.max(0, 30 - dist(k.x, k.y, x, y));
      let score = fert - nearest * 0.15 - danger * 0.2;
      // a sloppy surveyor mis-judges land quality, so the best site
      // doesn't reliably win (easy)
      if (diff.siteNoise) score *= 1 - Math.random() * diff.siteNoise;
      if (score > bestScore) { bestScore = score; best = { x, y }; }
    }
  }
  return best;
}

// score the farmland ring around a prospective footprint center
function siteFertility(game, x, y) {
  const { w, h, orig } = game.map;
  let fert = 0;
  for (let dy = -2; dy <= 3; dy++) for (let dx = -2; dx <= 3; dx++) {
    const tx = x + dx, ty = y + dy;
    if (tx < 0 || ty < 0 || tx >= w || ty >= h) continue;
    if (dist(tx + 0.5, ty + 0.5, x + 1, y + 1) > 2.7) continue;
    if (dx >= 0 && dx <= 1 && dy >= 0 && dy <= 1) continue; // footprint
    fert += orig[ty * w + tx];
  }
  return fert;
}

// -- last stand: refound after losing every settlement (#148) ----------
// Losing all settlements no longer ends the match while SETT_COST+ units
// survive (see checkResult in sim.js), so instead of idling the AI pools
// its survivors and walks them to a fresh site. opBuildAt handles the
// rest: the founder builds on arrival, or waits for escorts to merge in
// when it carries fewer than SETT_COST units itself (#130).
function rebuild(game, S, mine, state, diff) {
  const alive = mine.reduce((n, b) => n + S.total(b), 0);
  if (alive < S.C.SETT_COST) return; // truly beaten — checkResult ends it
  if (state.expand) {
    const b = mine.find(x => x.id === state.expand.blobId);
    if (b && b.order) {
      // keep stragglers converging on the site so the founding completes
      for (const o of mine) {
        if (o.id !== b.id && !o.order) S.opMove(game, o, state.expand.x, state.expand.y);
      }
      return;
    }
    state.expand = null; // founder died or built — re-evaluate next pass
  }
  // strongest surviving blob leads the founding
  let founder = mine[0];
  for (const b of mine) if (S.total(b) > S.total(founder)) founder = b;
  if (!founder) return;
  const site = pickRebuildSite(game, S, founder, state);
  if (!site) return;
  if (S.opBuildAt(game, founder, site.x + 1, site.y + 1).ok) {
    state.expand = { blobId: founder.id, x: site.x + 1, y: site.y + 1 };
    state.lastExpand = game.tick;
    for (const o of mine) {
      if (o.id !== founder.id) S.opMove(game, o, site.x + 1, site.y + 1);
    }
  }
}

// like pickSite, but with no own settlements to anchor on: weigh the
// founder's trek instead, and steer clear of remembered enemy positions
function pickRebuildSite(game, S, founder, state) {
  const { w, h } = game.map;
  let best = null, bestScore = -Infinity;
  for (let y = 4; y < h - 4; y += 3) {
    for (let x = 4; x < w - 4; x += 3) {
      if (!S.footprintFits(game, x, y)) continue;
      let ok = true;
      for (const s of game.settlements) {
        if (dist(s.x, s.y, x, y) < 9) { ok = false; break; }
      }
      if (!ok) continue;
      const trek = dist(founder.x, founder.y, x, y);
      let danger = 0;
      for (const k of Object.values(state.known)) danger += Math.max(0, 30 - dist(k.x, k.y, x, y));
      const score = siteFertility(game, x, y) - trek * 0.3 - danger * 0.3;
      if (score > bestScore) { bestScore = score; best = { x, y }; }
    }
  }
  return best;
}

// -- scout: find the enemy ----------------------------------------------

function scout(game, S, setts, mine, state, diff, owner) {
  if (state.scoutId) {
    const b = mine.find(x => x.id === state.scoutId);
    if (!b) state.scoutId = null;
    else if (b.order) return;
    else state.scoutId = null; // arrived; free it up
  }
  if (game.tick - state.lastScout < diff.scoutTicks) return;
  const s = setts.find(x => x.garrison.deploy >= 2);
  if (!s) return;
  const r = S.opFieldRole(game, s, 'deploy', 1);
  if (!r.ok) return;
  // probe toward a known enemy settlement, else the mirrored start,
  // else a random quadrant
  const knowns = Object.values(state.known);
  let tx, ty;
  if (knowns.length && Math.random() < 0.6) {
    const k = knowns[Math.floor(Math.random() * knowns.length)];
    tx = k.x; ty = k.y;
  } else if (Math.random() < 0.6) {
    tx = game.map.starts[1 - owner].x; ty = game.map.starts[1 - owner].y;
  } else {
    tx = 4 + Math.random() * (game.map.w - 8);
    ty = 4 + Math.random() * (game.map.h - 8);
  }
  if (S.opMove(game, r.blob, tx, ty).ok) {
    state.scoutId = r.blob.id;
    state.lastScout = game.tick;
  }
}

// -- muster & attack ---------------------------------------------------

function muster(game, S, setts, mine, state, diff) {
  if (state.attacking) return;
  // idle deploy blobs (not tasked) drift to the rally and merge up
  for (const b of mine) {
    if (b.order || b.pillaging || b.id === state.armyId || b.id === state.scoutId) continue;
    if (state.expand && state.expand.blobId === b.id) continue;
    if (b.count.deploy === 0) continue;
    const r = rallyPoint(game, setts);
    if (dist(b.x, b.y, r.x, r.y) > 3) S.opMove(game, b, r.x, r.y);
  }
}

function attack(game, S, setts, mine, state, diff) {
  // manage an army already in the field
  if (state.armyId) {
    const army = mine.find(b => b.id === state.armyId);
    if (!army) { state.armyId = null; state.attacking = false; return; }
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
      state.armyId = null; state.attacking = false; state.siege = null;
      return;
    }
    // siege stall guard (#108): walls now protect garrisons, so a siege
    // that isn't shrinking the garrison after ~2 min of sim time is a
    // grind the AI abandons rather than starving at the walls forever
    if (army.order && army.order.type === 'move' && army.order.tkind === 'settlement') {
      const st = game.settlements.find(x => x.id === army.order.tid);
      const g = st ? st.garrison.deploy + st.garrison.supply + st.garrison.farm : 0;
      if (!st || g === 0) state.siege = null;
      else if (!state.siege || state.siege.settId !== st.id || g < state.siege.g) {
        state.siege = { settId: st.id, g, t: game.tick };
      } else if (game.tick - state.siege.t > 1200) {
        state.siege = null;
        const home = setts[0];
        S.opPillage(game, army, false);
        S.opMove(game, army, home.x + 2.5, home.y + 1);
        state.armyId = null; state.attacking = false;
        return;
      }
    } else state.siege = null;
    // resupply (hard): a campaigning army whose caravan was lost gets a
    // replacement before the siege withers
    if (diff.resupply && meter < 0.85 && !hasLiveRoute(game, army)) {
      const home = rallyPoint(game, setts);
      attachCarriers(game, S, setts, mine, army, dist(army.x, army.y, home.x, home.y));
    }
    if (!army.order && !army.pillaging) {
      // arrived / target gone — pick the next known target or head home.
      // Plain moves no longer attack-move (#74), so offensives are
      // explicit siege orders on the remembered settlement.
      const t = nearestKnown(state, army.x, army.y, game, diff);
      if (t) S.opMove(game, army, t.x + 1, t.y + 1, { kind: 'settlement', id: t.id });
      else { state.attacking = false; state.armyId = null; }
    }
    return;
  }
  if (state.attacking) { state.attacking = false; return; }

  // launch a new offensive when the rally blob is big enough
  const candidates = mine.filter(b =>
    b.count.deploy >= diff.muster && b.id !== state.scoutId &&
    !(state.expand && state.expand.blobId === b.id));
  if (!candidates.length) return;
  const army = candidates[0];
  const t = nearestKnown(state, army.x, army.y, game, diff);
  if (!t) return; // scouts haven't found the enemy yet
  if (!S.opMove(game, army, t.x + 1, t.y + 1, { kind: 'settlement', id: t.id }).ok) return;
  state.armyId = army.id;
  state.attacking = true;
  state.lastAttack = game.tick;

  // a careless commander (easy) marches without a supply chain and has
  // to live off pillage alone — long campaigns starve out and turn back
  if (diff.carriers !== false) attachCarriers(game, S, setts, mine, army, dist(army.x, army.y, t.x, t.y));
}

// attach a supply chain sized to the haul distance: reuse an idle
// pure-supply blob if one is sitting around, else field from a garrison.
// Carriers move at deploy speed now (#80), so ~1 supply feeds 2.5
// fighters at a quarter-map haul instead of the old 5.
function attachCarriers(game, S, setts, mine, army, d) {
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

// any route still feeding this army with at least one surviving carrier?
function hasLiveRoute(game, army) {
  for (const r of game.routes) {
    if (r.owner !== army.owner || r.targetKind !== 'blob' || r.targetId !== army.id) continue;
    if ((r.carrierIds || []).some(id => game.blobs.some(b => !b.dead && b.id === id))) return true;
  }
  return false;
}

function nearestKnown(state, x, y, game, diff) {
  let best = null, bd = Infinity;
  for (const [id, k] of Object.entries(state.known)) {
    let d = dist(k.x, k.y, x, y);
    // an opportunist (hard) leans toward freshly discovered settlements —
    // typically the enemy's newest, weakest outposts
    if (diff && diff.recencyTarget && k.t != null) {
      const age = game.tick - k.t;
      if (age < 1500) d -= 15 * (1 - age / 1500);
    }
    if (d < bd) { bd = d; best = { id: +id, x: k.x, y: k.y }; }
  }
  return best;
}

// -- defend -------------------------------------------------------------

function defend(game, S, setts, mine, state, diff) {
  // proactive (hard): a remembered enemy war party bearing down on one of
  // our settlements arms its garrison NOW (arming takes ~10 s, so waiting
  // for the first hit is too late) and vectors an intercept
  if (diff.threats && state.threats) {
    const range = S.C.TERRITORY + S.C.AGGRO; // settlementInDanger's radius
    for (const s of setts) {
      if (s.building) continue;
      let close = null;
      for (const k of Object.values(state.threats)) {
        if (dist(k.x, k.y, s.x + 1, s.y + 1) <= range) { close = k; break; }
      }
      if (!close) continue;
      if (S.garrisonTotal(s) > 0) S.opGarrisonRole(game, s, 'deploy');
      let best = null, bd = Infinity;
      for (const b of mine) {
        if (b.count.deploy < Math.max(4, close.size / 2) || b.id === state.scoutId) continue;
        if (state.expand && state.expand.blobId === b.id) continue;
        const d = dist(b.x, b.y, s.x + 1, s.y + 1);
        if (d < bd) { bd = d; best = b; }
      }
      if (best && bd > 3) {
        S.opMove(game, best, s.x + 1, s.y + 1);
        if (best.id === state.armyId) { state.armyId = null; state.attacking = false; }
      }
      break; // one proactive response per evaluation is plenty
    }
  }
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
    if (best.id === state.armyId) { state.armyId = null; state.attacking = false; }
  }
}
