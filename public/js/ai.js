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

import { dist, passable } from './mapgen.js';

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
  walls(game, S, setts, mine, state, diff, owner);
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
  // enemy walls (#187), fog-fair like settlement memory: the AI blocks
  // (and breaches) only walls it has actually seen
  const knownWalls = state.knownWalls || (state.knownWalls = {});
  for (const w of game.walls || []) {
    if (w.owner === 1 - owner && canSee(mine, setts, w.x + 0.5, w.y + 0.5, S)) {
      knownWalls[w.id] = { x: w.x, y: w.y };
    }
  }
  for (const id of Object.keys(knownWalls)) {
    const k = knownWalls[id];
    if (canSee(mine, setts, k.x + 0.5, k.y + 0.5, S) && !(game.walls || []).some(w => w.id === +id)) {
      delete knownWalls[id];
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
  const owner = setts[0].owner;
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
      // own wall tiles inside the would-be farm ring cost plots
      // (previewFields skips walls, #205) — steer founding away from them
      let wallPen = 0;
      for (const wl of game.walls || []) {
        if (wl.owner === owner && dist(wl.x + 0.5, wl.y + 0.5, x + 1, y + 1) <= 2.7) wallPen += 1.5;
      }
      let score = fert - nearest * 0.15 - danger * 0.2 - wallPen;
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
    if (state.wallPlan && state.wallPlan.blobId === b.id) continue; // crew about to garrison (#205)
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
    !(state.expand && state.expand.blobId === b.id) &&
    !(state.wallPlan && state.wallPlan.blobId === b.id));
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
        if (state.wallPlan && best.id === state.wallPlan.blobId) state.wallPlan = null;
      }
      break; // one proactive response per evaluation is plenty
    }
  }
  // wall upkeep (hard, #205): arm any manned own wall that isn't deploy
  // yet, and re-garrison a bared in-territory wall with a remembered war
  // party bearing down — one re-garrison per evaluation is plenty
  if (diff.wallGarrison && game.walls && game.walls.length) {
    const owner = setts[0].owner;
    for (const w of game.walls) {
      if (w.owner !== owner || w.building || w.convert) continue;
      const g = S.wallGarrisonTotal(w);
      if (g > 0 && w.garrison.deploy < g) S.opWallGarrisonRole(game, w.id, 'deploy');
    }
    if (state.threats) {
      const range = S.C.TERRITORY + S.C.AGGRO;
      for (const w of game.walls) {
        if (w.owner !== owner || w.building || S.wallGarrisonTotal(w) > 0) continue;
        let close = false;
        for (const k of Object.values(state.threats)) {
          if (dist(k.x, k.y, w.x + 0.5, w.y + 0.5) <= range) { close = true; break; }
        }
        if (!close) continue;
        // only walls a settlement's drip can feed get a fresh garrison
        const home = setts.find(x => !x.building && S.garrisonTotal(x) >= 8 &&
          S.inTerritory(game, x, w.x + 0.5, w.y + 0.5));
        if (!home) continue;
        const role = home.garrison.supply >= 4 ? 'supply'
          : home.garrison.farm >= 4 ? 'farm'
          : home.garrison.deploy >= 8 ? 'deploy' : null;
        if (!role) continue;
        const r = S.opFieldRole(game, home, role, 4);
        if (r.ok) S.opMove(game, r.blob, w.x + 0.5, w.y + 0.5);
        break;
      }
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
    if (state.wallPlan && best.id === state.wallPlan.blobId) state.wallPlan = null;
  }
}

// -- walls (#205): fortify threatened and frontier settlements ----------
// Shares the player's rules exactly: any unit builds, and a wall costs
// only time and hands. Shields go in the 3.2–4.4 band around a
// settlement's footprint center — outside the 2.7 farm ring (no plot is
// ever denied), inside TERRITORY (the stockpile drip feeds a garrison).
// No Math.random anywhere in placement, so attract snapshots and
// save/resume replays stay reproducible.

const WALL_ARC = Math.PI * 35 / 180; // ± around the threat bearing
const WALL_JOB_TICKS = 1800;         // stalled-job deadline (~6 min at 1×)
const WALL_RING_MIN = 3.2;
const WALL_RING_MAX = 4.4;
const WALL_PER_SETT = 6;             // per-settlement fortification cap

function walls(game, S, setts, mine, state, diff, owner) {
  // -- finish an in-flight job first (mirrors expand's shape) --
  if (state.wallPlan) {
    const plan = state.wallPlan;
    // garrison phase (hard): the crew is marching onto the finished
    // chain; once folded into the tile, arm the wall garrison
    if (plan.phase === 'garrison') {
      const wid = game.wallAt[plan.gy * game.map.w + plan.gx];
      const w = wid ? game.walls.find(x => x.id === wid && x.owner === owner) : null;
      if (!w || game.tick - plan.t > WALL_JOB_TICKS) { state.wallPlan = null; return; }
      if (S.wallGarrisonTotal(w) > 0) {
        S.opWallGarrisonRole(game, w.id, 'deploy');
        state.wallPlan = null;
      }
      return;
    }
    let b = mine.find(x => x.id === plan.blobId);
    if (!b && game.mergeLog && game.mergeLog[plan.blobId] != null) {
      b = mine.find(x => x.id === game.mergeLog[plan.blobId]);
      if (b) plan.blobId = b.id;
    }
    if (!b) { state.wallPlan = null; return; } // crew died
    if (plan.kind === 'shield' && !game.settlements.some(x => x.id === plan.settId)) {
      state.wallPlan = null; // shielded town fell — nothing left to cover
      sendToRally(game, S, setts, b);
      return;
    }
    if (b.order && b.order.type !== 'wall') { state.wallPlan = null; return; } // crew repurposed
    if (game.tick - plan.t > WALL_JOB_TICKS) {
      // stalled — abandon the job (the move overrides the wall order)
      state.wallPlan = null;
      sendToRally(game, S, setts, b);
      return;
    }
    if (!b.order) {
      // run finished (or was cancelled by the sim)
      if (diff.wallGarrison && plan.kind === 'shield') {
        const done = plan.tiles.filter(t => {
          const wid = game.wallAt[t.y * game.map.w + t.x];
          const w = wid && game.walls.find(x => x.id === wid);
          return w && w.owner === owner && !w.building;
        });
        if (done.length) {
          // man the middle of the chain — arrival folds the crew in
          const t = done[(done.length - 1) >> 1];
          if (S.opMove(game, b, t.x + 0.5, t.y + 0.5).ok) {
            plan.phase = 'garrison'; plan.gx = t.x; plan.gy = t.y; plan.t = game.tick;
            return;
          }
        }
      }
      state.wallPlan = null;
      if (b.count.deploy > 0) sendToRally(game, S, setts, b);
      else S.opMove(game, b, setts[0].x + 1, setts[0].y + 1); // reabsorb the hands
    }
    return;
  }

  // -- gates --
  if (!diff.wallCap) return; // a careless commander never walls (easy)
  if (game.tick - (state.lastWall || 0) < diff.wallTicks) return;
  if (state.expand) return; // never compete with a founding
  let ownTiles = 0;
  for (const w of game.walls || []) if (w.owner === owner) ownTiles++;
  if (ownTiles >= diff.wallCap) return;

  const target = SETT_TARGETS[game.sizeKey] || 4;
  const reactiveOnly = setts.length < target; // defence beats greed pre-target
  const threshold = diff.threats ? 1 : 3;     // an alert commander walls pre-emptively

  // -- threat score per settlement (fog-fair evidence only) --
  const enemyStart = game.map.starts[1 - owner];
  let frontier = null, fd = Infinity;
  for (const s of setts) {
    if (s.building) continue;
    const d = dist(s.x + 1, s.y + 1, enemyStart.x, enemyStart.y);
    if (d < fd) { fd = d; frontier = s; }
  }
  let best = null, bestScore = 0;
  for (const s of setts) {
    if (s.building) continue;
    let near = 0;
    for (const w of game.walls || []) {
      if (w.owner === owner && dist(w.x + 0.5, w.y + 0.5, s.x + 1, s.y + 1) <= S.C.TERRITORY) near++;
    }
    if (near >= WALL_PER_SETT) continue; // already fortified
    let score = 0;
    if (game.tick - s.lastHitT < 600) score += 3;
    if (S.besieged(game, s)) score += 3;
    if (diff.threats && state.threats) {
      const range = S.C.TERRITORY + S.C.AGGRO + 6;
      for (const k of Object.values(state.threats)) {
        if (dist(k.x, k.y, s.x + 1, s.y + 1) <= range) { score += 2; break; }
      }
    }
    for (const k of Object.values(state.known)) {
      if (dist(k.x, k.y, s.x + 1, s.y + 1) <= 22) { score += 1; break; }
    }
    if (diff.threats && s === frontier) score += 1; // frontier fortification
    if (score > bestScore) { bestScore = score; best = s; } // first-in-list keeps ties
  }

  if (best && bestScore >= threshold && (!reactiveOnly || bestScore >= 3)) {
    state.lastWall = game.tick; // started OR refused — back off either way
    const reactive = game.tick - best.lastHitT < 600 || S.besieged(game, best);
    const span = Math.min(diff.wallSpan || 3, diff.wallCap - ownTiles);
    if (span < 2) return; // a 1-tile stub shields nothing
    const tiles = planShield(game, S, best, threatBearing(game, state, best, owner), span, owner);
    if (!tiles) return;
    const crew = wallCrew(game, S, setts, mine, state, best, reactive, target, diff);
    if (!crew) return;
    dispatchWallJob(game, S, state, crew, 'shield', best.id, tiles);
    return;
  }
  // choke plug (hard): no settlement calls for a shield — seal a narrow
  // pass on the approach to the frontier town instead. Left unmanned by
  // design: it sits outside territory, where a garrison would starve.
  if (diff.wallChoke && !reactiveOnly && frontier) {
    state.lastWall = game.tick;
    const tiles = planChoke(game, S, frontier, threatBearing(game, state, frontier, owner), owner,
      Math.min(4, diff.wallCap - ownTiles));
    if (!tiles) return;
    const crew = wallCrew(game, S, setts, mine, state, frontier, false, target, diff);
    if (!crew) return;
    dispatchWallJob(game, S, state, crew, 'choke', frontier.id, tiles);
  }
}

// Direction trouble comes from: the nearest remembered war party, else
// the nearest known enemy settlement, else the mirrored start.
function threatBearing(game, state, s, owner) {
  const cx = s.x + 1, cy = s.y + 1;
  let bx = null, by = null, bd = Infinity;
  for (const k of Object.values(state.threats || {})) {
    const d = dist(k.x, k.y, cx, cy);
    if (d < bd) { bd = d; bx = k.x; by = k.y; }
  }
  if (bx == null) {
    for (const k of Object.values(state.known)) {
      const d = dist(k.x, k.y, cx, cy);
      if (d < bd) { bd = d; bx = k.x; by = k.y; }
    }
  }
  if (bx == null) { bx = game.map.starts[1 - owner].x; by = game.map.starts[1 - owner].y; }
  return Math.atan2(by - cy, bx - cx);
}

// A short arc of wall across the threatened side: legal tiles in the
// 3.2–4.4 band within ±35° of the bearing, chained 8-connected (diagonal
// adjacency seals — movement corner-cuts are prevented and the pillage /
// farm floods are 4-connected). Own construction sites count as free
// progress, so a stalled orphan site near the town gets resumed.
function planShield(game, S, s, bearing, span, owner) {
  const cx = s.x + 1, cy = s.y + 1;
  const { w, h } = game.map;
  const cand = [];
  for (let ty = Math.max(0, Math.floor(cy - 5)); ty <= Math.min(h - 1, Math.ceil(cy + 5)); ty++) {
    for (let tx = Math.max(0, Math.floor(cx - 5)); tx <= Math.min(w - 1, Math.ceil(cx + 5)); tx++) {
      const d = dist(tx + 0.5, ty + 0.5, cx, cy);
      if (d < WALL_RING_MIN || d > WALL_RING_MAX) continue;
      let da = Math.atan2(ty + 0.5 - cy, tx + 0.5 - cx) - bearing;
      while (da > Math.PI) da -= 2 * Math.PI;
      while (da < -Math.PI) da += 2 * Math.PI;
      if (Math.abs(da) > WALL_ARC) continue;
      const r = S.canPlaceWall(game, owner, tx, ty);
      if (r.err) continue;
      cand.push({ x: tx, y: ty, da, resume: r.resume ? 1 : 0 });
    }
  }
  if (cand.length < 2) return null;
  // sweep the arc in angle order and chain consecutive adjacent tiles
  cand.sort((a, b) => a.da - b.da || (a.y * w + a.x) - (b.y * w + b.x));
  const chains = [];
  let cur = [cand[0]];
  for (let i = 1; i < cand.length; i++) {
    const p = cur[cur.length - 1], t = cand[i];
    if (Math.max(Math.abs(t.x - p.x), Math.abs(t.y - p.y)) === 1) cur.push(t);
    else { chains.push(cur); cur = [t]; }
  }
  chains.push(cur);
  const scoreOf = c => c.length * 10 + c.reduce((a, t) => a + t.resume, 0);
  let best = chains[0];
  for (const c of chains) if (scoreOf(c) > scoreOf(best)) best = c;
  if (best.length < 2) return null;
  if (best.length > span) {
    // keep the middle of the chain so it stays centred on the bearing
    const off = (best.length - span) >> 1;
    best = best.slice(off, off + span);
  }
  return best.map(t => ({ x: t.x, y: t.y }));
}

// A narrow mountain pass on the approach from the threat bearing,
// sealable end to end with at most `maxNew` fresh tiles. Sampled along
// the ray at 6–14 tiles out — close enough that the plug defends the
// town and rarely trips canPlaceWall's enemy-territory rule.
function planChoke(game, S, s, bearing, owner, maxNew) {
  if (maxNew < 1) return null;
  const cx = s.x + 1, cy = s.y + 1;
  const dx = Math.cos(bearing), dy = Math.sin(bearing);
  let px = Math.round(-dy), py = Math.round(dx); // perpendicular, snapped to the grid
  if (px === 0 && py === 0) py = 1;
  for (let r = 6; r <= 14; r++) {
    const sx = Math.floor(cx + dx * r), sy = Math.floor(cy + dy * r);
    if (!passable(game.map, sx, sy)) continue;
    // walk both ways to the flanking mountains (map edge counts)
    const gap = [{ x: sx, y: sy }];
    let wide = false;
    for (const dir of [1, -1]) {
      let closed = false;
      for (let k = 1; k <= 5; k++) {
        const tx = sx + px * k * dir, ty = sy + py * k * dir;
        if (!passable(game.map, tx, ty)) { closed = true; break; }
        gap.push({ x: tx, y: ty });
      }
      if (!closed) { wide = true; break; }
    }
    if (wide || gap.length > 5) continue; // not a choke
    // sealable end to end: every gap tile is an own wall already or placeable
    const fresh = [];
    let ok = true;
    for (const t of gap) {
      const wid = game.wallAt[t.y * game.map.w + t.x];
      if (wid) {
        const wl = game.walls.find(x => x.id === wid);
        if (wl && wl.owner === owner && !wl.building) continue; // already sealed
        if (wl && wl.owner === owner && wl.building) { fresh.push(t); continue; } // resume
        ok = false; break;
      }
      if (S.canPlaceWall(game, owner, t.x, t.y).err) { ok = false; break; }
      fresh.push(t);
    }
    if (!ok || !fresh.length || fresh.length > maxNew) continue;
    // order along the perpendicular so the build walks the line
    fresh.sort((a, b) => (a.x - b.x) * px + (a.y - b.y) * py);
    return fresh;
  }
  return null;
}

// A build crew: an idle nearby blob, else hands fielded from the target
// settlement's garrison — farmers and carriers first (any unit builds),
// deploy last and only when it doesn't undercut expansion's muster or
// the home guard.
function wallCrew(game, S, setts, mine, state, s, reactive, target, diff) {
  const size = diff.wallGarrison ? 6 : 4;
  const idle = mine.find(b =>
    !b.order && !b.pillaging && b.working == null && !b.convert &&
    b.id !== state.armyId && b.id !== state.scoutId &&
    !(state.expand && state.expand.blobId === b.id) &&
    S.total(b) >= 3 && dist(b.x, b.y, s.x + 1, s.y + 1) <= 12);
  if (idle) return idle;
  for (const role of ['farm', 'supply', 'deploy']) {
    const have = s.garrison[role];
    if (have <= 0) continue;
    const take = Math.min(size, have, S.garrisonTotal(s) - 4); // keep a home guard
    if (take <= 0) continue;
    if (role === 'deploy') {
      if (s.garrison.deploy - take < 4) continue;       // keep the guard ARMED
      if (setts.length < target && !reactive) continue; // protect expansion's 9-deploy muster
    }
    const r = S.opFieldRole(game, s, role, take);
    if (r.ok) return r.blob;
  }
  return null;
}

// Queue the chain from the end nearest the crew (tickWallOrder walks the
// list in order) and record the in-flight plan on success.
function dispatchWallJob(game, S, state, crew, kind, settId, tiles) {
  const t0 = tiles[0], tn = tiles[tiles.length - 1];
  if (dist(crew.x, crew.y, tn.x + 0.5, tn.y + 0.5) < dist(crew.x, crew.y, t0.x + 0.5, t0.y + 0.5)) {
    tiles.reverse();
  }
  const r = S.opBuildWalls(game, crew, tiles);
  if (r.err || !r.queued) return; // back off (lastWall is already stamped)
  state.wallPlan = { blobId: crew.id, settId, kind, tiles, t: game.tick };
}
