// Scripted opponent. Evaluated every ~2 s (20 ticks) from the main loop.
// Uses the same sim ops as the player. Terrain is fully known to it, but
// enemy positions must be discovered by scouting (its own vision +
// memory) — no fog cheating on enemy entities at any difficulty, and no
// economy cheating either: difficulty scales decision-making via the
// behavior flags on S.DIFF (see sim.js), never income.
//
// State machine per the spec: Expand → Develop → Scout → Attack → Defend.
// Normal and Hard add three layers on top of that skeleton (#207):
//   * target *evaluation* — every remembered enemy town is scored on the
//     force needed to take it (garrisons behind walls fight at ~4.5×, so
//     the commit bar is ~2.4× the remembered defenders), its distance and
//     how fresh the intel is, instead of blindly marching at the nearest.
//   * reinforcement — idle strength is fed into a live siege by issuing
//     the *same* order, which is exactly what tickMerge folds together.
//   * raiding (hard) — a small party sent after remembered caravans and
//     field hands, the cheapest damage on the board.
// Very Hard layers on top of Hard again (#208 follow-up): it is evaluated
// twice as often (evalTicks), ranks a town down when a remembered enemy
// field army is covering it (fieldThreats), stacks a second army onto a
// stalled assault (massAssault), runs its caravans through a siege ring
// and out to its walls (siegeRun / wallSupply), raids with two parties,
// arms farm hands the land can't pay for (reroleSurplus) and rotates a
// bled army home to heal (rotateHome). Still zero hidden information.
// Easy is untouched: it holds none of the new flags, so every new branch
// falls through to the original code path.
//
// In a real match the AI drives owner 1 with state on game.ai (so it
// survives save/resume). Attract mode drives BOTH sides by calling
// aiTick once per owner with its own state object — the defaults keep
// every existing call site behaving exactly as before. Nothing here may
// touch game.ai directly or assume owner === 1.

import { dist, passable } from './mapgen.js';

const SETT_TARGETS = { small: 3, medium: 4, large: 5 };

// Garrison-behind-cover math (see tickCombat): WALL_PROT 3 cuts incoming
// damage and WALL_DEF 1.5 boosts return fire, so a defender is worth
// ~4.5 attackers and the break-even ratio is ~2.12. Commit at 2.4 so the
// storm actually resolves instead of grinding.
const COMMIT_RATIO = 2.4;

export function aiTick(game, S, owner = 1, state = game.ai) {
  if (game.result) return;
  // state.diffKey lets a harness (or attract variant) pit difficulties
  // against each other per-owner; real matches fall through to the game's.
  // An unknown key (a save from a newer build) degrades to normal rather
  // than throwing on the first flag read.
  const diff = S.DIFF[state.diffKey || game.difficulty] || S.DIFF.normal;
  ensureState(state);
  const mine = game.blobs.filter(b => !b.dead && b.owner === owner);
  const setts = game.settlements.filter(s => s.owner === owner);
  if (setts.length === 0) { rebuild(game, S, mine, state, diff); return; }

  const frontier = frontierSett(game, setts, owner);
  updateMemory(game, S, mine, setts, owner, state, diff);
  develop(game, S, setts, mine, state, diff, frontier);
  defend(game, S, setts, mine, state, diff, frontier);
  walls(game, S, setts, mine, state, diff, owner);
  wallSupply(game, S, setts, state, diff, owner);
  expand(game, S, setts, mine, state, diff);
  scout(game, S, setts, mine, state, diff, owner);
  attack(game, S, setts, mine, state, diff);
  reinforce(game, S, setts, mine, state, diff);
  raid(game, S, setts, mine, state, diff);
  muster(game, S, setts, mine, state, diff);

  // legacy mirrors: older saves, the attract pool and anything else
  // reading state.armyId / scoutId / attacking / raid keep seeing sane values
  state.armyId = state.armies.length ? state.armies[0].id : null;
  state.scoutId = state.scoutIds.length ? state.scoutIds[0] : null;
  state.attacking = state.armies.length > 0;
  state.raid = state.raids.length ? state.raids[0] : null;
}

// Fill in fields a save (or an attract-mode caller) predates. Keeps every
// pass below free of `|| {}` noise and keeps the state JSON-serializable.
function ensureState(state) {
  if (!state.known) state.known = {};
  if (!state.knownWalls) state.knownWalls = {};
  if (!state.threats) state.threats = {};
  if (!state.prey) state.prey = {};
  if (!state.rumors) state.rumors = [];
  if (!Array.isArray(state.armies)) {
    state.armies = [];
    if (state.armyId != null) {
      state.armies.push({
        id: state.armyId, targetId: null, order: null, reinf: [],
        siege: state.siege || null, t: state.lastAttack || 0, start: 0,
      });
    }
  }
  if (!Array.isArray(state.scoutIds)) {
    state.scoutIds = state.scoutId != null ? [state.scoutId] : [];
  }
  if (state.scoutSeq == null) state.scoutSeq = 0;
  if (state.raid === undefined) state.raid = null;
  // one raid slot became many (veryhard): migrate the legacy single
  // record, and keep mirroring raids[0] back onto state.raid each tick
  if (!Array.isArray(state.raids)) state.raids = state.raid ? [state.raid] : [];
  if (!state.reroleT) state.reroleT = {};
}

// Is this blob already spoken for by another pass?
function isTasked(state, id) {
  if (state.expand && state.expand.blobId === id) return true;
  if (state.wallPlan && state.wallPlan.blobId === id) return true;
  for (const r of state.raids) if (r.blobId === id) return true;
  if (state.scoutIds.includes(id)) return true;
  for (const a of state.armies) if (a.id === id) return true;
  return false;
}

// Release a blob from whatever job held it (defence outranks everything).
function clearTask(state, id) {
  state.armies = state.armies.filter(a => a.id !== id);
  state.scoutIds = state.scoutIds.filter(x => x !== id);
  if (state.wallPlan && state.wallPlan.blobId === id) state.wallPlan = null;
  state.raids = state.raids.filter(r => r.blobId !== id);
  if (state.raid && state.raid.blobId === id) state.raid = null;
}

// The own settlement closest to the enemy start — the town that takes the
// first punch, and the one worth garrisoning and walling hardest.
function frontierSett(game, setts, owner) {
  const es = game.map.starts[1 - owner];
  let best = null, bd = Infinity;
  for (const s of setts) {
    if (s.building) continue;
    const d = dist(s.x + 1, s.y + 1, es.x, es.y);
    if (d < bd) { bd = d; best = s; }
  }
  return best;
}

function nearestOwn(setts, x, y) {
  let best = null, bd = Infinity;
  for (const s of setts) {
    const d = dist(s.x + 1, s.y + 1, x, y);
    if (d < bd) { bd = d; best = s; }
  }
  return best;
}

// How many settlements this commander wants. Easy has no settBonus, so
// it keeps the original table exactly.
function settTarget(game, diff) {
  const base = SETT_TARGETS[game.sizeKey] || 4;
  return diff.settBonus ? base + diff.settBonus : base;
}

// -- memory: what the AI has actually seen ----------------------------

function canSee(mine, setts, x, y, S) {
  for (const s of setts) if (dist(s.x + 1, s.y + 1, x, y) <= S.C.VISION_SETT) return true;
  for (const b of mine) if (dist(b.x, b.y, x, y) <= S.C.VISION_BLOB) return true;
  return false;
}

// The garrison weighting tickCombat actually fights with: carriers and
// field hands pull half a fighter's weight behind cover.
function garrEff(g) {
  return g.deploy + 0.5 * g.supply + 0.5 * g.farm;
}

function updateMemory(game, S, mine, setts, owner, state, diff) {
  const known = state.known;
  for (const s of game.settlements) {
    if (s.owner !== 1 - owner || !canSee(mine, setts, s.x, s.y, S)) continue;
    const rec = { x: s.x, y: s.y, t: game.tick };
    if (diff.evalTargets) {
      // record the strength seen, not the strength that is there now —
      // everything downstream plans off this snapshot (#207)
      rec.g = garrEff(s.garrison);
      const home = nearestOwn(setts, s.x + 1, s.y + 1);
      rec.bd = home ? dist(home.x + 1, home.y + 1, s.x + 1, s.y + 1) : null;
    } else if (known[s.id]) {
      rec.g = known[s.id].g; rec.bd = known[s.id].bd;
    }
    known[s.id] = rec;
  }
  // public founding rumors queued by the sim: a rumor-following commander
  // files them as known targets; everyone else discards them (drain
  // either way so the queue can't grow)
  const rumors = state.rumors;
  if (rumors && rumors.length) {
    if (diff.rumors) {
      for (const r of rumors) {
        if (!game.settlements.some(s => s.id === r.id)) continue;
        // a rumor says "a town was founded here", never how well it is
        // held — a brand-new site is worth a guess of its founding cost
        known[r.id] = { x: r.x, y: r.y, t: r.t, g: diff.evalTargets ? S.C.SETT_COST : undefined, bd: null };
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
  // (and breaches) only walls it has actually seen. The garrison seen on
  // the tile is remembered too, so breach picking reads memory alone.
  const knownWalls = state.knownWalls;
  for (const w of game.walls || []) {
    if (w.owner === 1 - owner && canSee(mine, setts, w.x + 0.5, w.y + 0.5, S)) {
      knownWalls[w.id] = { x: w.x, y: w.y, g: garrEff(w.garrison), t: game.tick };
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
    const threats = state.threats;
    const expiry = diff.threatTicks || 600;
    for (const b of game.blobs) {
      if (b.dead || b.owner !== 1 - owner || b.count.deploy < 5) continue;
      if (canSee(mine, setts, b.x, b.y, S)) threats[b.id] = { x: b.x, y: b.y, size: b.count.deploy, t: game.tick };
    }
    for (const id of Object.keys(threats)) {
      const k = threats[id];
      const gone = !game.blobs.some(b => !b.dead && b.id === +id && b.count.deploy > 0);
      if (game.tick - k.t > expiry || (gone && canSee(mine, setts, k.x, k.y, S))) delete threats[id];
    }
  }
  // soft targets (hard, #207): caravans and loose field hands carry no
  // deploy, so they never shoot back — remembering where they were seen
  // is what makes the raid pass possible without any fog cheat.
  if (diff.raid) {
    const prey = state.prey;
    for (const b of game.blobs) {
      if (b.dead || b.owner !== 1 - owner || b.count.deploy > 0) continue;
      if (b.count.supply + b.count.farm <= 0) continue;
      if (!canSee(mine, setts, b.x, b.y, S)) continue;
      prey[b.id] = {
        x: b.x, y: b.y, t: game.tick, n: S.total(b),
        kind: b.count.supply > 0 ? 'carrier' : 'farmer',
      };
    }
    for (const id of Object.keys(prey)) {
      const k = prey[id];
      const gone = !game.blobs.some(b => !b.dead && b.id === +id);
      if (game.tick - k.t > 900 || (gone && canSee(mine, setts, k.x, k.y, S))) delete prey[id];
    }
  }
}

// -- evaluate: what is worth attacking, and with how much ---------------

// Every remembered enemy town, scored. Reads state.known / state.knownWalls
// ONLY — never a live settlement — so a smarter commander is a
// better-informed one, not a cheating one.
function rankTargets(game, state, x, y, size, diff) {
  const out = [];
  for (const [idStr, k] of Object.entries(state.known)) {
    const id = +idStr;
    const age = k.t == null ? 0 : Math.max(0, game.tick - k.t);
    // stale intel is assumed to have grown: roughly one more defender per
    // 600 ticks since the sighting, capped so old memories stay usable
    const grow = Math.min(6, age / 600);
    let g = (k.g == null ? 6 : k.g) + grow;
    // a remembered wall ring is part of the defence: without a breach
    // doctrine it all has to be chewed through, with one it is a detour
    let walls = 0, wallG = 0;
    for (const w of Object.values(state.knownWalls)) {
      if (dist(w.x + 0.5, w.y + 0.5, k.x + 1, k.y + 1) > 5) continue;
      walls++; wallG += (w.g || 0);
    }
    g += diff.breachWalls ? wallG * 0.5 : wallG;
    // remembered enemy FIELD armies near the town (veryhard): a relief
    // force fights in the open, so it counts at 1× rather than the
    // garrison's ~4.5×, but ignoring it entirely is how an assault walks
    // into two defences at once. Memory-only, like everything else here.
    //
    // It steers WHICH town, and only that — measured, not assumed. An
    // enemy's own muster loiters beside its capital, so folding a sighted
    // relief force into the commit bar roughly doubles it on the one town
    // that matters, and the commander dithers until commitTicks instead
    // of fighting: head-to-head against Hard that cost ~0.19 of the score
    // rate. As a pure ranking penalty it does the useful half — take the
    // town they left uncovered — and none of the paralysis.
    let field = 0;
    if (diff.fieldThreats) {
      for (const t of Object.values(state.threats || {})) {
        if (dist(t.x, t.y, k.x + 1, k.y + 1) > 10) continue;
        const tAge = t.t == null ? 0 : Math.max(0, game.tick - t.t);
        field += (t.size || 0) * Math.max(0.4, 1 - tAge / 1800);
      }
    }
    const need = Math.max(2, g * COMMIT_RATIO);
    const d = dist(x, y, k.x + 1, k.y + 1);
    let score = 100 - d * 1.2 - need * 3 - field * 2.5;
    // an opportunist (hard) leans toward freshly discovered settlements —
    // typically the enemy's newest, weakest outposts
    if (diff.recencyTarget && age < 1500) score += 15 * (1 - age / 1500);
    // a town pressing on our own is worth taking before a far-off capital
    if (k.bd != null) score += Math.max(0, 12 - k.bd);
    out.push({ id, x: k.x, y: k.y, g, need, walls, d, score, takeable: size >= need });
  }
  out.sort((a, b) => b.score - a.score || a.id - b.id);
  return out;
}

// A wall tile worth punching through on the way in: near the target town,
// cheapest to reach, emptiest garrison remembered. Memory-only by design —
// an order onto a tile whose wall is already gone just cancels itself in
// tickTargetedMove, and the next pass re-plans.
function breachTile(state, x, y, tgt) {
  let best = null, bs = Infinity;
  for (const [idStr, w] of Object.entries(state.knownWalls)) {
    if (dist(w.x + 0.5, w.y + 0.5, tgt.x + 1, tgt.y + 1) > 5) continue;
    const s = (w.g || 0) * 6 + dist(x, y, w.x + 0.5, w.y + 0.5);
    if (s < bs) { bs = s; best = { id: +idStr, x: w.x, y: w.y }; }
  }
  return best;
}

// -- develop: production modes + fielding trained units ---------------

// The home guard a town keeps back. Easy has no `guard` flag and keeps
// the flat 4 it always had. Smarter commanders hold the full guard only
// where there is remembered danger, so quiet games stay expansionist.
function guardNeed(game, S, state, diff, s, frontier) {
  if (!diff.guard) return 4;
  if (game.tick - s.lastHitT < 600 || S.besieged(game, s)) return diff.guard;
  const range = S.C.TERRITORY + S.C.AGGRO + 6;
  for (const k of Object.values(state.threats)) {
    if (dist(k.x, k.y, s.x + 1, s.y + 1) <= range) return diff.guard;
  }
  return s === frontier ? (diff.guardRear || 4) : 4;
}

function develop(game, S, setts, mine, state, diff, frontier) {
  let supplyCount = 0, deployCount = 0;
  for (const b of mine) { supplyCount += b.count.supply; deployCount += b.count.deploy; }
  for (const s of setts) { supplyCount += s.garrison.supply; deployCount += s.garrison.deploy; }
  const wantSupply = supplyCount < Math.max(3, deployCount / 4);

  for (const s of setts) {
    if (s.building) continue; // construction sites can't train or field (#95)
    if (!diff.evalTargets) {
      if (s.stockpile < 50) S.opSetMode(game, s, 'farm');
      else if (s.stockpile > 150 && s.mode === 'farm') {
        S.opSetMode(game, s, wantSupply ? 'supply' : 'deploy');
      }
    } else {
      // the classic hysteresis, plus two fixes (#207): the supply/deploy
      // split is re-read every pass instead of latching at the moment of
      // the switch, and a town whose flow is too thin to train anything
      // at all goes back to the fields instead of idling in train mode.
      const y = S.farmYield(game, s);
      const room = S.workingCount(game, s) + s.garrison.farm < y.worthwhileCells;
      if (s.stockpile < 50) S.opSetMode(game, s, 'farm');
      else if (S.trainGated(s) && room && s.stockpile < 150) S.opSetMode(game, s, 'farm');
      else if (s.mode === 'farm' && s.stockpile <= 150) { /* keep filling the granary */ }
      else S.opSetMode(game, s, wantSupply ? 'supply' : 'deploy');
    }
    // keep a home guard; field the rest to the rally
    if (diff.evalTargets && s.convert) continue; // don't cancel a pending arm-up (#108)
    const guard = guardNeed(game, S, state, diff, s, frontier);
    if (s.garrison.deploy > guard) {
      const r = S.opFieldRole(game, s, 'deploy', s.garrison.deploy - guard);
      if (r.ok) sendToRally(game, S, setts, state, diff, r.blob);
    }
    reroleSurplus(game, S, setts, state, diff, s);
  }
  foodLines(game, S, setts, diff);
}

// Total mobilization (veryhard): hands beyond the plots a town can
// actually pay for earn NOTHING — farmYield only pays for cells a farmer
// is actually standing on, and growth stops adding hands at
// worthwhileCells but never removes the ones a returning field crew left
// behind. Those hands are worth more as fighters. Same two ops a player
// would use: arm them (CONVERT_TICKS) and march them to the rally.
// Garrisoned hands go first (fielded as one group, split so only the
// surplus leaves); after that the surplus is taken off the plots.
//
// The armed group is deliberately NOT marched anywhere: while it is
// still farm-role, any move onto own tilled land runs fieldAssign, which
// cancels the pending arm-up and puts the hands straight back on the
// plots. They wait out CONVERT_TICKS where they stand, and muster()
// walks them to the rally on a later pass — once they are fighters.
const REROLE_COOLDOWN = 900;

function reroleSurplus(game, S, setts, state, diff, s) {
  if (!diff.reroleSurplus) return;
  if (s.building || s.convert) return;
  if (S.besieged(game, s) || game.tick - s.lastHitT < 600) return;
  const last = state.reroleT[s.id] || -Infinity;
  if (game.tick - last < REROLE_COOLDOWN) return;
  const y = S.farmYield(game, s);
  let surplus = S.workingCount(game, s) + s.garrison.farm - y.worthwhileCells;
  if (surplus < 3) return;

  if (s.garrison.farm >= 3) {
    const r = S.opFieldFarmerGroup(game, s);
    if (!r.ok) return;
    state.reroleT[s.id] = game.tick;
    const group = r.blob;
    if (surplus >= S.total(group)) {
      if (!S.opSetRole(game, group, 'deploy').ok) S.opSetRole(game, group, 'farm');
      return;
    }
    const split = S.opSplit(game, group, surplus);
    if (!split.ok) { S.opSetRole(game, group, 'farm'); return; }
    if (!S.opSetRole(game, split.blob, 'deploy').ok) S.opSetRole(game, split.blob, 'farm');
    S.opSetRole(game, group, 'farm'); // the rest disperses back onto the plots
    return;
  }

  // the hands are already out on the fields — arm the surplus where it
  // stands, lowest id first so the choice stays deterministic
  const hands = game.blobs
    .filter(b => !b.dead && b.owner === s.owner && b.working === s.id
      && !b.order && !b.convert && b.count.farm === S.total(b))
    .sort((a, b) => a.id - b.id);
  if (!hands.length) return;
  state.reroleT[s.id] = game.tick;
  for (const b of hands) {
    if (surplus <= 0) break;
    if (!S.opSetRole(game, b, 'deploy').ok) continue;
    surplus -= S.total(b);
  }
}

// Internal food lines (hard, #207): a town whose flow can't even feed its
// own garrison trains nothing. One caravan from a fat neighbour unsticks
// it, which is what a human player does with a stalled second city.
function foodLines(game, S, setts, diff) {
  if (!diff.foodLines) return;
  const gated = setts.find(s => !s.building && !s.convert && S.trainGated(s) && s.stockpile < 60);
  if (!gated) return;
  const fed = game.routes.some(r =>
    r.owner === gated.owner && r.targetKind === 'settlement' && r.targetId === gated.id
    && (r.carrierIds || []).some(id => game.blobs.some(b => !b.dead && b.id === id)));
  if (fed) return;
  const rich = setts.find(s =>
    !s.building && !s.convert && s.id !== gated.id && s.stockpile > 250 && s.garrison.supply >= 3);
  if (rich) S.opSupplyRoute(game, rich, { kind: 'settlement', id: gated.id });
}

// Where fresh units gather. The classic version pulls toward map center;
// an evaluating commander pulls toward the enemy start instead, out of
// the richest town that isn't the one about to be overrun — so the muster
// forms up on the way to the fight rather than behind it.
function rallyPoint(game, setts, state, diff) {
  // never rally at a construction site — it can't feed the muster (#95)
  const ready = setts.filter(s => !s.building);
  const pool = ready.length ? ready : setts;
  let best = pool[0];
  if (!best) return { x: game.map.w / 2, y: game.map.h / 2 };
  let tx = game.map.w / 2, ty = game.map.h / 2;
  if (diff.evalTargets) {
    const es = game.map.starts[1 - best.owner];
    tx = es.x; ty = es.y;
    let bs = -Infinity;
    for (const s of pool) {
      if (s.stockpile < 80) continue;
      const sc = s.stockpile * 0.05 - dist(s.x + 1, s.y + 1, es.x, es.y);
      if (sc > bs) { bs = sc; best = s; }
    }
    if (bs === -Infinity) for (const s of pool) if (s.stockpile > best.stockpile) best = s;
  } else {
    for (const s of pool) if (s.stockpile > best.stockpile) best = s;
  }
  // stay inside the settlement's feed radius so the mustering army eats
  const dx = tx - best.x, dy = ty - best.y;
  const d = Math.max(1, Math.sqrt(dx * dx + dy * dy));
  return { x: best.x + 1 + (dx / d) * 2.6, y: best.y + 1 + (dy / d) * 2.6 };
}

function sendToRally(game, S, setts, state, diff, b) {
  const r = rallyPoint(game, setts, state, diff);
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
  if (setts.length >= settTarget(game, diff)) return;
  if (game.tick - state.lastExpand < diff.expandTicks) return;

  // need 5+ deploy: prefer an idle field blob, else field from a garrison
  let b = mine.find(x => !x.order && x.count.deploy >= 6 && !isTasked(state, x.id));
  if (!b) {
    const s = setts.find(x => x.garrison.deploy >= 9 && !(diff.evalTargets && x.convert));
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
  if (diff.evalTargets) {
    // nothing left to campaign from: every survivor belongs to the refound
    state.armies = []; state.raid = null; state.raids = []; state.wallPlan = null; state.scoutIds = [];
  }
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
  const ids = state.scoutIds;
  for (let i = ids.length - 1; i >= 0; i--) {
    const b = mine.find(x => x.id === ids[i]);
    if (!b || !b.order) ids.splice(i, 1); // died, or arrived — free it up
  }
  if (ids.length >= (diff.scouts || 1)) return;
  if (game.tick - state.lastScout < diff.scoutTicks) return;
  const s = diff.scouts
    ? setts.find(x => !x.building && !x.convert && x.garrison.deploy >= 2)
    : setts.find(x => x.garrison.deploy >= 2);
  if (!s) return;
  const r = S.opFieldRole(game, s, 'deploy', 1);
  if (!r.ok) return;
  let tx, ty;
  if (diff.scouts) {
    // deterministic sweep (#207): stale memories first, then the enemy
    // start, then a fixed lattice — no Math.random, so attract snapshots
    // and seeded replays stay reproducible
    const p = probe(game, state, diff, owner);
    tx = p.x; ty = p.y;
  } else {
    // probe toward a known enemy settlement, else the mirrored start,
    // else a random quadrant
    const knowns = Object.values(state.known);
    if (knowns.length && Math.random() < 0.6) {
      const k = knowns[Math.floor(Math.random() * knowns.length)];
      tx = k.x; ty = k.y;
    } else if (Math.random() < 0.6) {
      tx = game.map.starts[1 - owner].x; ty = game.map.starts[1 - owner].y;
    } else {
      tx = 4 + Math.random() * (game.map.w - 8);
      ty = 4 + Math.random() * (game.map.h - 8);
    }
  }
  if (S.opMove(game, r.blob, tx, ty).ok) {
    ids.push(r.blob.id);
    state.lastScout = game.tick;
  }
}

// Rotating probe list: refresh what has gone stale, otherwise sweep.
function probe(game, state, diff, owner) {
  const stale = [];
  const staleTicks = diff.staleTicks || 900;
  for (const k of Object.values(state.known)) {
    if (k.t != null && game.tick - k.t > staleTicks) stale.push({ x: k.x + 1, y: k.y + 1 });
  }
  const list = [{ x: game.map.starts[1 - owner].x, y: game.map.starts[1 - owner].y }];
  for (let j = 1; j <= 3; j++) {
    for (let i = 1; i <= 3; i++) list.push({ x: game.map.w * i / 4, y: game.map.h * j / 4 });
  }
  const all = stale.length ? stale.concat(list) : list;
  const seq = state.scoutSeq = (state.scoutSeq + 1) % 1000000;
  return all[seq % all.length];
}

// -- muster & attack ---------------------------------------------------

function muster(game, S, setts, mine, state, diff) {
  // the classic commander runs one campaign at a time and leaves the rest
  // standing; a reinforcing one keeps feeding the rally either way
  if (!diff.reinforce && state.armies.length) return;
  // idle deploy blobs (not tasked) drift to the rally and merge up
  for (const b of mine) {
    if (b.order || b.pillaging || isTasked(state, b.id)) continue;
    if (b.count.deploy === 0) continue;
    const r = rallyPoint(game, setts, state, diff);
    if (dist(b.x, b.y, r.x, r.y) > 3) S.opMove(game, b, r.x, r.y);
  }
}

function attack(game, S, setts, mine, state, diff) {
  // manage armies already in the field; a record that returns false is
  // finished (dead, starved, or given up) and is dropped
  let dropped = false;
  for (let i = state.armies.length - 1; i >= 0; i--) {
    if (!manageArmy(game, S, setts, mine, state, diff, state.armies[i])) {
      state.armies.splice(i, 1);
      dropped = true;
    }
  }
  if (dropped) return;                                 // re-evaluate next pass
  if (state.armies.length >= (diff.armies || 1)) return;

  if (!diff.evalTargets) {
    // launch a new offensive when the rally blob is big enough
    const candidates = mine.filter(b => b.count.deploy >= diff.muster && !isTasked(state, b.id));
    if (!candidates.length) return;
    const army = candidates[0];
    const t = nearestKnown(state, army.x, army.y, game, diff);
    if (!t) return; // scouts haven't found the enemy yet
    if (!S.opMove(game, army, t.x + 1, t.y + 1, { kind: 'settlement', id: t.id }).ok) return;
    state.armies.push({
      id: army.id, targetId: t.id, siege: null, t: game.tick, start: army.count.deploy,
      reinf: [], order: { kind: 'settlement', id: t.id, x: t.x + 1, y: t.y + 1 },
    });
    state.lastAttack = game.tick;
    // a careless commander (easy) marches without a supply chain and has
    // to live off pillage alone — long campaigns starve out and turn back
    if (diff.carriers !== false) attachCarriers(game, S, setts, mine, army, dist(army.x, army.y, t.x, t.y));
    return;
  }

  // -- evaluating launch (#207) --
  // defence outranks greed: while a town is actually being hit, every
  // spare blob belongs to the relief column defend() just vectored
  if (underAttack(game, S, setts)) return;
  const busy = new Set(state.armies.map(a => a.targetId));
  const cands = mine.filter(b =>
    b.count.deploy >= 4 && !b.pillaging && b.working == null && !isTasked(state, b.id));
  if (!cands.length) return;
  let army = cands[0];
  for (const b of cands) {
    if (b.count.deploy > army.count.deploy || (b.count.deploy === army.count.deploy && b.id < army.id)) army = b;
  }
  // a second front only opens when there is genuinely enough army for two
  if (state.armies.length) {
    let pool = 0;
    for (const b of mine) pool += b.count.deploy;
    for (const s of setts) pool += s.garrison.deploy;
    if (pool < 2 * diff.muster + (diff.guard || 4)) return;
  }
  const all = rankTargets(game, state, army.x, army.y, army.count.deploy, diff);
  const ranked = all.filter(r => !busy.has(r.id));
  let pick = ranked.find(r => r.takeable);
  // if nothing is takeable for far too long, take the best odds anyway —
  // a commander that never commits loses on the economy
  if (!pick && diff.commitTicks && game.tick - (state.lastAttack || 0) > diff.commitTicks) pick = ranked[0];
  // mass assault (veryhard): with no fresh target worth taking, join the
  // assault already running rather than idling at the rally. Issuing the
  // identical order is what tickMerge folds together, so the two columns
  // arrive as one army instead of two half-strength ones.
  if (!pick && diff.massAssault) pick = pickMassTarget(game, mine, state, all);
  if (!pick) return;
  const need = pick.mass ? diff.muster
    : pick.takeable ? Math.max(diff.muster, Math.ceil(pick.need)) : diff.muster;
  if (army.count.deploy < need) return; // keep massing

  const rec = {
    id: army.id, targetId: pick.id, siege: null, t: game.tick,
    start: army.count.deploy, reinf: [], order: null,
  };
  if (!issueArmyOrder(game, S, state, diff, army, rec, pick)) return;
  state.armies.push(rec);
  state.lastAttack = game.tick;
  if (diff.carriers !== false) attachCarriers(game, S, setts, mine, army, pick.d);
}

// The busiest target still short of the force it needs (veryhard). Only
// targets whose assigned army is genuinely undersized qualify — piling
// onto a siege that is already winning wastes the second column.
function pickMassTarget(game, mine, state, ranked) {
  for (const rec of state.armies) {
    if (rec.targetId == null) continue;
    const cur = mine.find(b => b.id === rec.id);
    if (!cur) continue;
    const t = ranked.find(r => r.id === rec.targetId);
    if (!t || cur.count.deploy >= t.need) continue;
    return { ...t, mass: true };
  }
  return null;
}

// March on the town — through a remembered wall tile first when this
// commander knows how to breach and the town is ringed.
function issueArmyOrder(game, S, state, diff, army, rec, tgt) {
  if (diff.breachWalls && tgt.walls >= 2) {
    const w = breachTile(state, army.x, army.y, tgt);
    if (w && S.opMove(game, army, w.x + 0.5, w.y + 0.5, { kind: 'wall', id: w.id }).ok) {
      rec.order = { kind: 'wall', id: w.id, x: w.x + 0.5, y: w.y + 0.5 };
      return true;
    }
  }
  if (!S.opMove(game, army, tgt.x + 1, tgt.y + 1, { kind: 'settlement', id: tgt.id }).ok) return false;
  rec.order = { kind: 'settlement', id: tgt.id, x: tgt.x + 1, y: tgt.y + 1 };
  return true;
}

function homeFor(setts, b, diff) {
  if (!setts.length) return null;
  if (!diff.evalTargets) return setts[0];
  return nearestOwn(setts, b.x, b.y) || setts[0];
}

// Returns false when the record should be retired.
function manageArmy(game, S, setts, mine, state, diff, rec) {
  let army = mine.find(b => b.id === rec.id);
  if (!army) {
    // a reinforcement wave can absorb the army it was sent to help —
    // follow the merge log (#141) rather than declaring the campaign over
    let cur = rec.id, hops = 0;
    while (hops++ < 10 && game.mergeLog && game.mergeLog[cur] != null) {
      cur = game.mergeLog[cur];
      const b = mine.find(x => x.id === cur);
      if (b) { army = b; break; }
    }
    if (!army) return false;
    rec.id = army.id;
  }
  const meter = S.fedMeter(army);
  // live off the land while campaigning: pillage is a persistent stance
  // independent of movement, so a hungry army forages on the march and
  // drops the torch once well-fed again
  if (meter < 0.85 && !army.pillaging) S.opPillage(game, army, true);
  else if (meter > 0.95 && army.pillaging) S.opPillage(game, army, false);
  if (meter < 0.5) {
    goHome(game, S, setts, diff, army);   // starving offensive: retreat
    return false;
  }
  // siege stall guard (#108): walls now protect garrisons, so a siege
  // that isn't shrinking the garrison after ~2 min of sim time is a
  // grind the AI abandons rather than starving at the walls forever
  if (army.order && army.order.type === 'move' && army.order.tkind === 'settlement') {
    const st = game.settlements.find(x => x.id === army.order.tid);
    const g = st ? st.garrison.deploy + st.garrison.supply + st.garrison.farm : 0;
    if (!st || g === 0) rec.siege = null;
    else if (!rec.siege || rec.siege.settId !== st.id || g < rec.siege.g) {
      rec.siege = { settId: st.id, g, t: game.tick, n: army.count.deploy };
    } else if (game.tick - rec.siege.t > 1200) {
      rec.siege = null;
      goHome(game, S, setts, diff, army);
      return false;
    } else if (diff.evalTargets && rec.siege.n && army.count.deploy <= rec.siege.n * 0.55) {
      // bleeding out against an undented garrison — break off early and
      // keep the survivors rather than feeding them to the walls
      rec.siege = null;
      goHome(game, S, setts, diff, army);
      return false;
    }
  } else rec.siege = null;
  // resupply (hard): a campaigning army whose caravan was lost gets a
  // replacement before the siege withers
  if (diff.resupply && meter < 0.85 && !hasLiveRoute(game, army)) {
    const home = rallyPoint(game, setts, state, diff);
    attachCarriers(game, S, setts, mine, army, dist(army.x, army.y, home.x, home.y));
  }
  if (army.order || army.pillaging) return true;

  // arrived / target gone (or a breached wall fell away) — re-plan.
  // Plain moves no longer attack-move (#74), so offensives are explicit
  // siege orders on the remembered settlement.
  if (!diff.evalTargets) {
    const t = nearestKnown(state, army.x, army.y, game, diff);
    if (!t) return false;
    if (!S.opMove(game, army, t.x + 1, t.y + 1, { kind: 'settlement', id: t.id }).ok) return false;
    rec.targetId = t.id;
    rec.order = { kind: 'settlement', id: t.id, x: t.x + 1, y: t.y + 1 };
    return true;
  }
  const busy = new Set(state.armies.filter(a => a !== rec).map(a => a.targetId));
  const ranked = rankTargets(game, state, army.x, army.y, army.count.deploy, diff)
    .filter(r => !busy.has(r.id));
  // staying on the current target is the default: a breach that just
  // finished should be followed straight into the town behind it
  const pick = ranked.find(r => r.id === rec.targetId) || ranked.find(r => r.takeable);
  // rotate home (veryhard): a bled column with nothing it can actually
  // take heals at home (tickHeal only mends units inside own territory)
  // instead of loitering in the field at half HP
  if (diff.rotateHome && (!pick || !pick.takeable) && S.blobHealth(army) < diff.rotateHome) {
    goHome(game, S, setts, diff, army);
    return false;
  }
  if (!pick) return false;
  if (!issueArmyOrder(game, S, state, diff, army, rec, pick)) return false;
  rec.targetId = pick.id;
  return true;
}

function goHome(game, S, setts, diff, b) {
  const home = homeFor(setts, b, diff);
  S.opPillage(game, b, false);
  if (home) S.opMove(game, b, home.x + 2.5, home.y + 1);
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

// -- reinforce (#207): feed a live siege ---------------------------------
// tickMerge folds two same-owner blobs together when both are idle OR
// both carry the same attack order, mid-combat included — so the way to
// reinforce an assault is simply to issue the identical order. Waves
// arrive and merge into the army instead of milling around beside it.

function underAttack(game, S, setts) {
  for (const s of setts) {
    if (game.tick - s.lastHitT < 100 || S.besieged(game, s)) return true;
  }
  return false;
}

function reinforce(game, S, setts, mine, state, diff) {
  if (!diff.reinforce || !state.armies.length) return;
  if (underAttack(game, S, setts)) return; // the relief column comes first
  for (const rec of state.armies) {
    if (!rec.order) continue;
    const army = mine.find(b => b.id === rec.id);
    if (!army) continue;
    const want = Math.ceil(Math.max(2, estGarrison(state, rec.targetId) * COMMIT_RATIO)) + 2;
    if (army.count.deploy >= want) continue;
    let sent = 0;
    for (const b of mine) {
      if (sent >= 2) break;
      if (b.id === army.id || isTasked(state, b.id)) continue;
      if (b.pillaging || b.working != null || b.count.deploy < 3) continue;
      if (b.order && b.order.type !== 'move') continue;  // building / routing / working
      if (b.order && b.order.tkind === rec.order.kind && b.order.tid === rec.order.id) continue; // already marching
      if (dist(b.x, b.y, army.x, army.y) > game.map.w * 0.8) continue;
      if (!S.opMove(game, b, rec.order.x, rec.order.y, { kind: rec.order.kind, id: rec.order.id }).ok) continue;
      if (!rec.reinf.includes(b.id)) rec.reinf.push(b.id);
      sent++;
    }
  }
}

function estGarrison(state, id) {
  const k = id == null ? null : state.known[id];
  return k && k.g != null ? k.g : 6;
}

// -- raid (#207, hard): hunt caravans and field hands --------------------
// Carriers and farmers carry no deploy, so they never return fire, and a
// slain carrier hands half its cargo to the killer (raidCargo). Cutting a
// supply line is the cheapest damage on the board — and the AI's own
// farmers auto-shelter, so it is a move only Hard gets, on a long timer.

function raid(game, S, setts, mine, state, diff) {
  if (!diff.raid) return;
  const every = diff.raidTicks || 1200;
  // -- steer the parties already out (one slot on hard, two on veryhard) --
  const taken = new Set();
  for (let i = state.raids.length - 1; i >= 0; i--) {
    const rec = state.raids[i];
    let b = mine.find(x => x.id === rec.blobId);
    if (!b) {
      // absorbed by another group — follow the merge log (#141) instead of
      // declaring the party lost, exactly as manageArmy does
      let cur = rec.blobId, hops = 0;
      while (hops++ < 10 && game.mergeLog && game.mergeLog[cur] != null) {
        cur = game.mergeLog[cur];
        const m = mine.find(x => x.id === cur);
        if (m) { b = m; break; }
      }
      if (!b) { state.raids.splice(i, 1); continue; }
      rec.blobId = b.id;
    }
    if (game.tick - rec.t > every * 2 || S.fedMeter(b) < 0.45) {
      goHome(game, S, setts, diff, b);
      state.raids.splice(i, 1);
      continue;
    }
    if (b.order) { if (rec.preyId != null) taken.add(rec.preyId); continue; }
    const p = pickPrey(game, state, b.x, b.y, taken);
    if (p && S.opMove(game, b, p.x, p.y, { kind: 'blob', id: p.id }).ok) {
      rec.preyId = p.id;
      taken.add(p.id);
    } else {
      goHome(game, S, setts, diff, b);
      state.raids.splice(i, 1);
    }
  }
  if (state.raids.length >= (diff.raidParties || 1)) return;
  if (game.tick - (state.lastRaid || 0) < every) return;
  for (const s of setts) if (S.besieged(game, s)) return;  // no raiding under siege
  const seed = setts[0];
  if (!pickPrey(game, state, seed.x + 1, seed.y + 1, taken)) return;
  // a small fast party: spare hands if any are loose, else four off a
  // garrison that can lose them without dropping below its guard
  let b = mine.find(x =>
    !x.order && !x.pillaging && x.working == null && !isTasked(state, x.id)
    && x.count.deploy >= 3 && x.count.deploy <= 8);
  if (!b) {
    const s = setts.find(x =>
      !x.building && !x.convert && x.garrison.deploy >= (diff.guard || 8) + 4);
    if (!s) return;
    const r = S.opFieldRole(game, s, 'deploy', 4);
    if (!r.ok) return;
    b = r.blob;
  }
  const p = pickPrey(game, state, b.x, b.y, taken);
  if (!p || !S.opMove(game, b, p.x, p.y, { kind: 'blob', id: p.id }).ok) return;
  S.opPillage(game, b, true); // raiders live off the land they cross
  state.raids.push({ blobId: b.id, preyId: p.id, t: game.tick });
  state.lastRaid = game.tick;
}

// Best remembered soft target: caravans over field hands, fat over thin,
// close over far, fresh over stale. `taken` keeps two parties (veryhard)
// off the same caravan.
function pickPrey(game, state, x, y, taken) {
  let best = null, bs = -Infinity;
  for (const [idStr, k] of Object.entries(state.prey)) {
    if (taken && taken.has(+idStr)) continue;
    const age = game.tick - (k.t || 0);
    const s = (k.kind === 'carrier' ? 20 : 10) + (k.n || 1) * 2
      - dist(x, y, k.x, k.y) * 0.8 - age * 0.01;
    if (s > bs) { bs = s; best = { id: +idStr, x: k.x, y: k.y, kind: k.kind }; }
  }
  return best;
}

// -- defend -------------------------------------------------------------

// Run the siege line (veryhard, #181): a caravan bound for a surrounded
// town holds outside the ring by default and the town starves. Ordering
// the route to run it is the player's own toggle — carriers can die
// doing it, which is exactly the trade a besieged town wants. The flag
// is cleared again the moment the ring lifts, so ordinary hauls go back
// to waiting the fight out.
function siegeRuns(game, S, setts, diff) {
  if (!diff.siegeRun) return;
  for (const r of game.routes) {
    if (r.targetKind !== 'settlement') continue;
    const tgt = setts.find(s => s.id === r.targetId);
    if (!tgt || r.owner !== tgt.owner) continue;
    const want = S.besieged(game, tgt);
    if (!!r.runSiege !== want) S.opSiegeRun(game, r.id, want);
  }
}

// Provision the walls (veryhard, #200): a wall garrison eats out of the
// tile's own stash, refilled by a settlement drip only inside territory —
// which is why hard leaves its choke plugs unmanned. A caravan reaches
// anywhere, so a supplied plug can actually hold the pass. One route per
// evaluation so this can never strip a town of its carriers.
function wallSupply(game, S, setts, state, diff, owner) {
  if (!diff.wallSupply || !game.walls || !game.walls.length) return;
  for (const w of game.walls) {
    if (w.owner !== owner || w.building || w.convert) continue;
    if (S.wallGarrisonTotal(w) <= 0) continue;
    if (S.wallStockFrac(w) > 0.35 && !S.wallStarving(w)) continue;
    const fed = game.routes.some(r =>
      r.owner === owner && r.targetKind === 'wall' && r.targetId === w.id
      && (r.carrierIds || []).some(id => game.blobs.some(b => !b.dead && b.id === id)));
    if (fed) continue;
    const rich = setts.find(s =>
      !s.building && !s.convert && s.stockpile > 250 && s.garrison.supply >= 3);
    if (!rich) return;
    S.opSupplyRoute(game, rich, { kind: 'wall', id: w.id });
    return;
  }
}

function defend(game, S, setts, mine, state, diff, frontier) {
  siegeRuns(game, S, setts, diff);
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
        if (b.count.deploy < Math.max(4, close.size / 2) || state.scoutIds.includes(b.id)) continue;
        if (state.expand && state.expand.blobId === b.id) continue;
        const d = dist(b.x, b.y, s.x + 1, s.y + 1);
        if (d < bd) { bd = d; best = b; }
      }
      if (best && bd > 3) {
        S.opMove(game, best, s.x + 1, s.y + 1);
        clearTask(state, best.id);
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
        // only walls a settlement's drip can feed get a fresh garrison —
        // unless this commander runs caravans out to its walls (veryhard),
        // in which case any nearby town can man it and wallSupply feeds it
        const home = setts.find(x => !x.building && S.garrisonTotal(x) >= 8 &&
          S.inTerritory(game, x, w.x + 0.5, w.y + 0.5))
          || (diff.wallSupply
            ? setts.find(x => !x.building && S.garrisonTotal(x) >= 8
              && dist(x.x + 1, x.y + 1, w.x + 0.5, w.y + 0.5) <= 16)
            : null);
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

  if (!diff.evalTargets) {
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
      clearTask(state, best.id);
    }
    return;
  }

  // -- massed relief (#207) --
  // One blob "diverted toward the town" was never enough: it trickled in
  // and died piecemeal. Send enough to win, aim it at the besieger itself
  // rather than at the map square, and (hard) come in from behind it —
  // a besieger is lockedFacing the settlement, so relief approaching from
  // beyond it lands the full REAR_MULT.
  const hit = setts.find(s => game.tick - s.lastHitT < 100 || S.besieged(game, s));
  if (!hit) return;
  const cx = hit.x + 1, cy = hit.y + 1;
  let atk = 0, lead = null;
  for (const b of game.blobs) {
    if (b.dead || b.owner === hit.owner || b.count.deploy <= 0) continue;
    if (dist(b.x, b.y, cx, cy) > S.C.VISION_SETT) continue; // the town can see this far
    atk += b.count.deploy;
    if (!lead || b.count.deploy > lead.count.deploy) lead = b;
  }
  if (!atk) return;
  // arm the garrison it already has — a farmer behind a keep wall still
  // shoots back at half weight, an armed one at full
  if (diff.reactiveArm && !hit.convert && S.garrisonTotal(hit) > 0
    && hit.garrison.deploy < S.garrisonTotal(hit)) {
    S.opGarrisonRole(game, hit, 'deploy');
  }
  const want = Math.max(4, Math.ceil(atk * 1.5));
  const pool = mine
    .filter(b => b.count.deploy >= 2 && b.working == null
      && dist(b.x, b.y, cx, cy) < game.map.w * 0.8)
    .sort((a, b) => dist(a.x, a.y, cx, cy) - dist(b.x, b.y, cx, cy) || a.id - b.id);
  let got = 0;
  for (const b of pool) {
    if (got >= want) break;
    got += b.count.deploy;
    const d = dist(b.x, b.y, cx, cy);
    if (d <= 3) continue;                                          // already in the fight
    if (lead && b.order && b.order.type === 'move'
      && b.order.tkind === 'blob' && b.order.tid === lead.id) continue; // already vectored
    clearTask(state, b.id);
    if (!lead) { S.opMove(game, b, cx, cy); continue; }
    if (diff.flank && dist(b.x, b.y, lead.x, lead.y) > 4) {
      const vx = lead.x - cx, vy = lead.y - cy;
      const vd = Math.max(0.5, Math.hypot(vx, vy));
      const wx = lead.x + (vx / vd) * 3, wy = lead.y + (vy / vd) * 3;
      if (passable(game.map, Math.floor(wx), Math.floor(wy))
        && S.opMove(game, b, wx, wy).ok) continue;
    }
    S.opMove(game, b, lead.x, lead.y, { kind: 'blob', id: lead.id });
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
      sendToRally(game, S, setts, state, diff, b);
      return;
    }
    if (b.order && b.order.type !== 'wall') { state.wallPlan = null; return; } // crew repurposed
    if (game.tick - plan.t > WALL_JOB_TICKS) {
      // stalled — abandon the job (the move overrides the wall order)
      state.wallPlan = null;
      sendToRally(game, S, setts, state, diff, b);
      return;
    }
    if (!b.order) {
      // run finished (or was cancelled by the sim). A choke plug is manned
      // too once this commander can caravan food out to it (veryhard) —
      // otherwise it sits outside territory where a garrison would starve.
      if (diff.wallGarrison && (plan.kind === 'shield' || (diff.wallSupply && plan.kind === 'choke'))) {
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
      if (b.count.deploy > 0) sendToRally(game, S, setts, state, diff, b);
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

  const target = settTarget(game, diff);
  const reactiveOnly = setts.length < target; // defence beats greed pre-target
  const threshold = diff.threats ? 1 : 3;     // an alert commander walls pre-emptively

  // -- threat score per settlement (fog-fair evidence only) --
  const frontier = frontierSett(game, setts, owner);
  const ranked = [];
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
    if (score > 0) ranked.push({ s, score });
  }
  // Highest score first, ties by founding order (id) so placement stays
  // deterministic. Walking the whole list instead of only the top town
  // matters now that a commander can hold more settlements (#207): the
  // hottest one is often a days-old frontier town with an empty granary
  // and no hands to spare, and stopping there used to burn the entire
  // wallTicks window on a town that could never raise a crew.
  ranked.sort((a, b) => b.score - a.score || a.s.id - b.s.id);

  let attempted = false;
  for (const { s: best, score: bestScore } of ranked) {
    if (bestScore < threshold || (reactiveOnly && bestScore < 3)) continue;
    attempted = true;
    const reactive = game.tick - best.lastHitT < 600 || S.besieged(game, best);
    const span = Math.min(diff.wallSpan || 3, diff.wallCap - ownTiles);
    if (span < 2) break; // a 1-tile stub shields nothing
    const tiles = planShield(game, S, best, threatBearing(game, state, best, owner), span, owner);
    if (!tiles) continue;
    const crew = wallCrew(game, S, setts, mine, state, best, reactive, target, diff);
    if (!crew) continue;
    dispatchWallJob(game, S, state, crew, 'shield', best.id, tiles);
    break;
  }
  if (attempted) {
    state.lastWall = game.tick; // started OR refused — back off either way
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
    !b.order && !b.pillaging && b.working == null && !b.convert && !isTasked(state, b.id) &&
    S.total(b) >= 3 && dist(b.x, b.y, s.x + 1, s.y + 1) <= 12);
  if (idle) return idle;
  if (diff.evalTargets && s.convert) return null; // don't cancel a pending arm-up (#108)
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
