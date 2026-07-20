// Supply routes: creation, carrier bookkeeping, delivery window, health.
// Carrier movement itself is ticked by sim.js (it owns movement/pathing);
// this module owns the route objects and their math.

export const CARRY_PER_UNIT = 10;      // food capacity per supply unit
export const HEALTH_WINDOW_TICKS = 300; // 30 s rolling window

export function createRoute(game, blob, target, initialCargo, sourceId) {
  // target: { kind: 'blob'|'settlement', id }
  // initialCargo: food carried over from a previous route (#103).
  // Source settlement = explicit sourceId when given (#108 —
  // settlement-to-settlement lines stay pinned to their chosen source),
  // else the nearest friendly settlement to the carrier.
  let src = null;
  if (sourceId != null) {
    src = game.settlements.find(s =>
      s.id === sourceId && s.owner === blob.owner && !s.building) || null;
  }
  if (!src) src = nearestSettlement(game, blob.owner, blob.x, blob.y);
  if (!src) return { err: 'No friendly settlement to load from' };
  if (target.kind === 'settlement' && target.id === src.id) {
    return { err: 'Route must lead away from its source' };
  }
  if (target.kind === 'settlement') {
    const tgt = game.settlements.find(s => s.id === target.id);
    if (tgt && tgt.building) return { err: 'Still under construction' };
  }
  const route = {
    id: game.nextId++,
    owner: blob.owner,
    settlementId: src.id,
    targetKind: target.kind,
    targetId: target.id,
    carrierIds: [blob.id],
    window: [], // [{t, amt}]
  };
  game.routes.push(route);
  // carried-over cargo stays aboard (#103): a full carrier heads straight
  // out; a partial one loads first (the load phase tops up, never resets)
  const cap = (blob.count.deploy + blob.count.supply + blob.count.farm) * CARRY_PER_UNIT;
  const cargo = Math.min(initialCargo || 0, cap);
  const phase = cargo >= cap - 0.01 ? 'go' : 'load';
  blob.order = { type: 'route', routeId: route.id, phase, cargo, wait: 0 };
  blob.path = null;
  return { route };
}

export function nearestSettlement(game, owner, x, y) {
  let best = null, bd = Infinity;
  for (const s of game.settlements) {
    if (s.owner !== owner || s.building) continue; // sites can't load routes (#95)
    // measure from the 2×2 footprint center
    const dx = s.x + 1 - x, dy = s.y + 1 - y, d = dx * dx + dy * dy;
    if (d < bd) { bd = d; best = s; }
  }
  return best;
}

export function findRoute(game, id) {
  return game.routes.find(r => r.id === id) || null;
}

export function routeTarget(game, route) {
  if (route.targetKind === 'blob') {
    return game.blobs.find(b => b.id === route.targetId && !b.dead) || null;
  }
  return game.settlements.find(s => s.id === route.targetId) || null;
}

export function routeSource(game, route) {
  return game.settlements.find(s => s.id === route.settlementId) || null;
}

export function recordDelivery(game, route, amt) {
  route.window.push({ t: game.tick, amt });
}

// Delivered ÷ consumed over the rolling window. >1 means keeping up.
export function routeHealth(game, route) {
  const cutoff = game.tick - HEALTH_WINDOW_TICKS;
  route.window = route.window.filter(e => e.t >= cutoff);
  let delivered = 0;
  for (const e of route.window) delivered += e.amt;
  const target = routeTarget(game, route);
  if (!target) return 0;
  const units = route.targetKind === 'blob'
    ? target.count.deploy + target.count.supply + target.count.farm
    : target.garrison.deploy + target.garrison.supply + target.garrison.farm;
  if (units <= 0) return 1;
  // consumption: units × (1/12) food/s over the window span
  const span = Math.min(game.tick, HEALTH_WINDOW_TICKS) / 10; // seconds
  const consumed = units * (1 / 12) * Math.max(1, span);
  return delivered / consumed;
}

export function removeCarrier(game, route, blobId) {
  route.carrierIds = route.carrierIds.filter(id => id !== blobId);
  if (route.carrierIds.length === 0) dissolveRoute(game, route);
}

export function dissolveRoute(game, route) {
  for (const id of route.carrierIds) {
    const b = game.blobs.find(x => x.id === id && !x.dead);
    if (b && b.order && b.order.type === 'route' && b.order.routeId === route.id) {
      // carried cargo folds into the blob's own food (nothing lost)
      b.food = Math.min(foodCap(b), b.food + (b.order.cargo || 0));
      b.order = null;
      b.path = null;
    }
  }
  game.routes = game.routes.filter(r => r.id !== route.id);
}

function foodCap(b) {
  return (b.count.deploy + b.count.supply + b.count.farm) * 10;
}
