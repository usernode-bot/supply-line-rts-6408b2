// Shared application of a player's relayed orders — used by the server's
// match runner against the authoritative game, and by clients to replay
// their unacked orders onto a fresh snapshot. DOM-free so it loads in
// Node via dynamic import() (same pattern as sim.js in attract-pool.js).
//
// Every entity id is re-resolved against `g` and must belong to the
// acting `owner`; targeted attack orders must point at the enemy
// (`1 - owner`). Anything invalid degrades or is dropped — the sim is
// never trusted with raw client ids.

import * as S from './sim.js';

export function resolveBlobIn(g, owner, id) {
  let cur = id, hops = 0;
  while (hops++ < 10) {
    const b = g.blobs.find(x => x.id === cur && !x.dead);
    if (b) return b.owner === owner ? b : null;
    if (g.mergeLog[cur] != null) cur = g.mergeLog[cur];
    else return null;
  }
  return null;
}

export function applyCommand(g, owner, c) {
  if (!g || g.result || !c || typeof c !== 'object') return;
  if (owner !== 0 && owner !== 1) return;
  const enemy = 1 - owner;
  const b = c.blobId != null ? resolveBlobIn(g, owner, c.blobId) : null;
  const st = c.settlementId != null
    ? g.settlements.find(s => s.id === c.settlementId && s.owner === owner) : null;
  switch (c.op) {
    case 'surrender':
      g.result = owner === 0 ? 'p1-win' : 'p0-win';
      g.resultReason = 'surrender';
      break;
    case 'move': {
      if (!b) break;
      // targeted orders point at the acting player's ENEMY — validate
      // against authoritative state; anything invalid degrades to a tile move
      let target = null;
      if (c.target && c.target.kind === 'blob') {
        const t = resolveBlobIn(g, enemy, c.target.id);
        if (t) target = { kind: 'blob', id: t.id };
      } else if (c.target && c.target.kind === 'settlement') {
        const t = g.settlements.find(s => s.id === c.target.id && s.owner === enemy);
        if (t) target = { kind: 'settlement', id: t.id };
      } else if (c.target && c.target.kind === 'wall') {
        const t = g.walls.find(w => w.id === c.target.id && w.owner === enemy);
        if (t) target = { kind: 'wall', id: t.id };
      }
      S.opMove(g, b, +c.x || 0, +c.y || 0, target);
      break;
    }
    case 'setRole': if (b) S.opSetRole(g, b, c.role); break;
    case 'split': if (b) S.opSplit(g, b, c.take | 0); break;
    case 'build': if (b) S.opBuild(g, b); break;
    case 'buildAt': if (b) S.opBuildAt(g, b, +c.x || 0, +c.y || 0); break;
    case 'pillage': if (b) S.opPillage(g, b, !!c.on); break;
    case 'route':
      if (b && c.target) {
        // explicit source (#131): only the acting player's own completed
        // settlement is honoured; anything else degrades to the nearest-
        // settlement fallback inside createRoute
        let srcId = null;
        if (c.sourceId != null) {
          const s = g.settlements.find(x => x.id === c.sourceId && x.owner === owner && !x.building);
          if (s) srcId = s.id;
        }
        if (c.target.kind === 'blob') {
          const t = resolveBlobIn(g, owner, c.target.id);
          if (t && t.id !== b.id) S.opRoute(g, b, { kind: 'blob', id: t.id }, srcId);
        } else if (c.target.kind === 'settlement') {
          const t = g.settlements.find(s => s.id === c.target.id && s.owner === owner);
          if (t) S.opRoute(g, b, { kind: 'settlement', id: t.id }, srcId);
        } else if (c.target.kind === 'wall') {
          // wall-garrison supply line (#187): own finished walls only
          const t = g.walls.find(w => w.id === c.target.id && w.owner === owner && !w.building);
          if (t) S.opRoute(g, b, { kind: 'wall', id: t.id }, srcId);
        }
      }
      break;
    case 'siegeRun': {
      // run-the-siege toggle (#181): only the acting player's own route
      const r = g.routes.find(x => x.id === c.routeId && x.owner === owner);
      if (r) S.opSiegeRun(g, r.id, !!c.on);
      break;
    }
    case 'wallBuild':
      // walls (#187): tiles are re-validated inside opBuildWalls against
      // the authoritative state — malformed entries just get skipped
      if (b && Array.isArray(c.tiles)) {
        S.opBuildWalls(g, b, c.tiles.slice(0, 64).map(t => ({ x: (t && t.x) | 0, y: (t && t.y) | 0 })));
      }
      break;
    case 'fieldWall': {
      const w = g.walls.find(x => x.id === c.wallId && x.owner === owner);
      if (w) S.opFieldWall(g, w.id);
      break;
    }
    case 'wallRole': {
      // wall-garrison role switch (#187): own walls only; the op
      // whitelists the role string itself
      const w = g.walls.find(x => x.id === c.wallId && x.owner === owner);
      if (w) S.opWallGarrisonRole(g, w.id, c.role);
      break;
    }
    case 'setMode': if (st) S.opSetMode(g, st, c.mode); break;
    case 'fieldGarrison': if (st) S.opFieldGarrison(g, st); break;
    case 'fieldRole': if (st) S.opFieldRole(g, st, c.role, Math.max(1, c.n | 0)); break;
    case 'fieldFarmerGroup': if (st) S.opFieldFarmerGroup(g, st); break;
    case 'garrisonRole': if (st) S.opGarrisonRole(g, st, c.role); break;
    case 'supplyRoute':
      // settlement-to-settlement line (#108): validate the target is the
      // acting player's own entity, then field + route in one op
      if (st && c.target) {
        if (c.target.kind === 'settlement') {
          const t = g.settlements.find(s => s.id === c.target.id && s.owner === owner);
          if (t && t.id !== st.id) S.opSupplyRoute(g, st, { kind: 'settlement', id: t.id });
        } else if (c.target.kind === 'blob') {
          const t = resolveBlobIn(g, owner, c.target.id);
          if (t) S.opSupplyRoute(g, st, { kind: 'blob', id: t.id });
        } else if (c.target.kind === 'wall') {
          const t = g.walls.find(w => w.id === c.target.id && w.owner === owner && !w.building);
          if (t) S.opSupplyRoute(g, st, { kind: 'wall', id: t.id });
        }
      }
      break;
  }
}
