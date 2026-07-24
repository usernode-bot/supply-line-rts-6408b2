// Click-through tutorial controller (#185): owns the 14-step script, the
// input-gating whitelist main.js consults at its dispatch choke points,
// and the #tutorial-box card. Step state is session-local UI state —
// never serialized (same policy as control groups).

import * as S from './sim.js';
import { dist, passable } from './mapgen.js';

const $ = (id) => document.getElementById(id);

let st = null;      // { game, ui, idx, flashUntil, movePoint, wallA, wallB, camStart } while active
let deps = null;    // { ui, view, isMobile, onExit, onFinish, onKeepPlaying } from main.js
let wired = false;
let lastText = '';
let lastNudge = 0;
let domObserver = null; // re-applies dim/pulse the instant a panel/popup rebuilds

// Follow the merge log like main.js's findBlob so a tracked blob survives
// merges (e.g. the army absorbing a stray friendly on the march).
function resolveBlob(game, id) {
  let cur = id, hops = 0;
  while (hops++ < 10) {
    const b = game.blobs.find(x => x.id === cur && !x.dead);
    if (b) return b;
    if (game.mergeLog[cur] != null) cur = game.mergeLog[cur];
    else return null;
  }
  return null;
}

const home = (g) => g.settlements.find(s => s.id === g.tutorialIds.home) || null;
const outpost = (g) => g.settlements.find(s => s.id === g.tutorialIds.outpost) || null;
const army = (g) => resolveBlob(g, g.tutorialIds.army);
const enemy = (g) => resolveBlob(g, g.tutorialIds.enemy);
const carriers = (g) => resolveBlob(g, g.tutorialIds.carriers);

// Whether the selection is exactly the tracked blob (alone or as every
// member of a multi-select), following the merge log.
function selIsTracked(g, sel, tracked) {
  if (!sel || !tracked) return false;
  if (sel.kind === 'blob') {
    const b = resolveBlob(g, sel.id);
    return !!b && b.id === tracked.id;
  }
  if (sel.kind === 'multi') {
    return sel.ids.length > 0 && sel.ids.every(id => {
      const b = resolveBlob(g, id);
      return !!b && b.id === tracked.id;
    });
  }
  return false;
}

const selIsArmy = (g, sel) => selIsTracked(g, sel, army(g));
const selIsCarriers = (g, sel) => selIsTracked(g, sel, carriers(g));

function selIsHome(g, sel) {
  const h = home(g);
  return !!h && !!sel && sel.kind === 'settlement' && sel.id === h.id;
}

// Each step: text(mobile, game, ui); next (explanation step — advance via
// the card button); finish (last step — the button ends the tutorial);
// ops — allowed sim-op names (the do* dispatchers in main.js); acts —
// allowed [data-act] buttons (string, or {act, mode?, role?}); select —
// allowed selection targets; target — the allowed world circle for
// orders/armed-pending taps; marker — the pulsing map ring; done —
// completion predicate polled each frame (state-based, so any input path
// that reaches the goal counts). ops/acts may also be (game, ui) =>
// array, for steps whose buttons only apply to one specific selection —
// e.g. the wall step must not let a pulsing 🧱 arm for the supply
// carriers left selected by the resupply step.
const STEPS = [
  { // 1 — welcome
    next: true,
    text: () => 'Welcome to Supply Line! The goal: wipe out the enemy — but every army marches on its stomach. This quick tour covers the basics, then supply lines.',
  },
  { // 2 — move the camera (#198): interactive — completes once the view
    // center has actually panned, by any modality (keys, drag, edge
    // scroll, trackpad, minimap). Start position is captured lazily on
    // the first poll, since the player may pan during the welcome card.
    text: (m) => m
      ? 'Look around: drag with one finger to pan and pinch to zoom — or tap the minimap to jump. Pan the camera a little to continue.'
      : 'Look around: pan the map with WASD or the arrow keys — dragging with the middle mouse button or clicking the minimap works too, and the mouse wheel zooms. Pan the camera a little to continue.',
    done: () => {
      const v = deps && deps.view;
      if (!v) return true; // no camera handle — never block the tour
      if (!st.camStart) { st.camStart = { cx: v.cx, cy: v.cy }; return false; }
      return dist(v.cx, v.cy, st.camStart.cx, st.camStart.cy) >= 3;
    },
  },
  { // 3 — select the army
    text: (m) => `This is your army — 10 soldiers camped by your home settlement. ${m ? 'Tap' : 'Click'} the pulsing ring to select it.`,
    select: (g, sel) => selIsArmy(g, sel),
    marker: (g) => { const a = army(g); return a ? { x: a.x, y: a.y, r: 1.8 } : null; },
    done: (g, ui) => selIsArmy(g, ui.selected),
  },
  { // 4 — move out
    text: (m) => m
      ? 'March to the marked spot: tap your selected army, choose 📍 Move…, then tap the pulsing marker.'
      : 'March to the marked spot: right-click the marker — or press 📍 Move in the panel, then click the marker.',
    ops: ['move'],
    acts: ['move', 'pmove', 'pmovearm'],
    select: (g, sel) => selIsArmy(g, sel),
    target: () => ({ x: st.movePoint.x, y: st.movePoint.y, r: 2 }),
    marker: () => ({ x: st.movePoint.x, y: st.movePoint.y, r: 1.6 }),
    done: (g) => {
      const a = army(g);
      if (!a) return false;
      if (dist(a.x, a.y, st.movePoint.x, st.movePoint.y) <= 2) return true;
      return !!(a.order && a.order.type === 'move' && !a.order.tkind
        && dist(a.order.x, a.order.y, st.movePoint.x, st.movePoint.y) <= 2.5);
    },
  },
  { // 5 — inspect the home settlement
    text: (m) => `${m ? 'Tap' : 'Click'} your marked home settlement. Its panel shows the food stockpile, the live income breakdown, and the garrison sheltering inside its walls.`,
    acts: ['pselsett'],
    select: (g, sel) => selIsHome(g, sel),
    marker: (g) => { const h = home(g); return h ? { x: h.x + 1, y: h.y + 1, r: 2.3 } : null; },
    done: (g, ui) => selIsHome(g, ui.selected),
  },
  { // 6 — production modes
    text: () => 'A settlement trains one kind of unit at a time. Press the highlighted 🚚 Supply mode — this town will now grow supply units, the haulers of your war effort.',
    ops: ['setMode'],
    acts: [{ act: 'mode', mode: 'supply' }, 'modemenu', 'pselsett'],
    select: (g, sel) => selIsHome(g, sel),
    marker: (g, ui) => {
      if (selIsHome(g, ui.selected)) return null; // the button pulses instead
      const h = home(g);
      return h ? { x: h.x + 1, y: h.y + 1, r: 2.3 } : null;
    },
    done: (g) => { const h = home(g); return !!h && h.mode === 'supply'; },
  },
  { // 7 — why supply lines matter
    next: true,
    text: () => 'Why supply? Every unit eats. Near your own settlements armies are fed automatically — but out in enemy land they starve unless they pillage the land or a supply route feeds them. Hungry armies fight badly, and starve at zero.',
  },
  { // 8 — create the supply line (two-phase: arm the button, pick the destination)
    text: (m, g, ui) => ui.pending === 'route-sett'
      ? `Now ${m ? 'tap' : 'click'} the marked outpost to set the destination.`
      : 'Time for a supply line. With your home settlement selected, press the highlighted "🚚 Supply route to another settlement…" button.',
    ops: ['supplyRoute'],
    acts: ['settroute', 'pselsett'],
    select: (g, sel) => selIsHome(g, sel),
    target: (g, ui) => {
      if (ui.pending !== 'route-sett') return null;
      const o = outpost(g);
      return o ? { x: o.x + 1, y: o.y + 1, r: 2.4 } : null;
    },
    marker: (g, ui) => {
      const o = outpost(g);
      if (ui.pending === 'route-sett') return o ? { x: o.x + 1, y: o.y + 1, r: 2.3 } : null;
      if (selIsHome(g, ui.selected)) return null; // the button pulses instead
      const h = home(g);
      return h ? { x: h.x + 1, y: h.y + 1, r: 2.3 } : null;
    },
    done: (g) => {
      const h = home(g), o = outpost(g);
      return !!(h && o && g.routes.some(r =>
        r.owner === 0 && r.settlementId === h.id && r.targetKind === 'settlement' && r.targetId === o.id));
    },
  },
  { // 9 — watch it work
    next: true,
    text: () => 'A caravan is loading up at home and hauling food to the outpost — that\'s the marked group on the road. It shuttles back and forth on its own. Raiders love caravans, so in a real match routes need guarding.',
    marker: (g) => {
      const h = home(g);
      const r = h && g.routes.find(x => x.owner === 0 && x.settlementId === h.id);
      const c = r && r.carrierIds && r.carrierIds.length ? resolveBlob(g, r.carrierIds[0]) : null;
      return c ? { x: c.x, y: c.y, r: 1.3 } : null;
    },
  },
  { // 10 — attack
    text: (m) => m
      ? 'An enemy war party is camped nearby. Tap your army to select it, then tap the marked enemy and choose ⚔️ Attack. Your troops are fed and rested — theirs won\'t save them.'
      : 'An enemy war party is camped nearby. Select your army, then right-click the marked enemy to attack. Your troops are fed and rested — theirs won\'t save them.',
    ops: ['move'],
    acts: ['move', 'pmove', 'pmovearm', 'pattack'],
    select: (g, sel) => selIsArmy(g, sel),
    target: (g) => { const e = enemy(g); return e ? { x: e.x, y: e.y, r: 3.2 } : null; },
    marker: (g) => { const e = enemy(g); return e ? { x: e.x, y: e.y, r: 2 } : null; },
    done: (g) => !enemy(g),
  },
  { // 11 — resupply the army in the field: put the supply band camped by
    // the outpost onto a route feeding the army — the select-units-then-
    // route flow, including the load-from tap that garrison sourcing
    // (step 8) skips. Four phases, each with its own ring/pulse.
    text: (m, g, ui) => {
      const o = outpost(g);
      const oName = (o && o.name) || 'the outpost';
      if (ui.pending === 'route') {
        return ui.routeSrc != null
          ? `Now ${m ? 'tap' : 'click'} your army in the field to set the destination.`
          : `First ${m ? 'tap' : 'click'} ${oName} — the settlement the caravan will load food from.`;
      }
      if (selIsCarriers(g, ui.selected)) {
        return m
          ? 'Tap the selected supply units again and choose the highlighted 🚚 Supply route… button.'
          : 'Press the highlighted 🚚 Supply route… button.';
      }
      return `Your army won — but far from your territory, units go hungry: they must pillage or be resupplied. Supply units are camped outside ${oName} — ${m ? 'tap' : 'click'} the marked group to select them.`;
    },
    // only live while the carriers are the selection — the army arrives
    // here selected from the attack step, and its (disabled) route
    // button must not pulse or answer
    ops: (g, ui) => selIsCarriers(g, ui.selected) ? ['route'] : [],
    acts: (g, ui) => selIsCarriers(g, ui.selected) ? ['route', 'proutearm'] : [],
    select: (g, sel) => selIsCarriers(g, sel),
    target: (g, ui) => {
      if (ui.pending !== 'route') return null;
      if (ui.routeSrc == null) {
        const o = outpost(g);
        return o ? { x: o.x + 1, y: o.y + 1, r: 2.4 } : null;
      }
      const a = army(g);
      return a ? { x: a.x, y: a.y, r: 2.5 } : null;
    },
    marker: (g, ui) => {
      if (ui.pending === 'route') {
        if (ui.routeSrc == null) {
          const o = outpost(g);
          return o ? { x: o.x + 1, y: o.y + 1, r: 2.3 } : null;
        }
        const a = army(g);
        return a ? { x: a.x, y: a.y, r: 2 } : null;
      }
      if (selIsCarriers(g, ui.selected)) return null; // the button pulses instead
      const c = carriers(g);
      return c ? { x: c.x, y: c.y, r: 1.8 } : null;
    },
    done: (g) => {
      const o = outpost(g);
      return !!o && g.routes.some(r => r.owner === 0 && r.settlementId === o.id && r.targetKind === 'blob');
    },
  },
  { // 12 — build a wall: seal the mountain gap west of the fallen camp.
    // Two rings guide the exact endpoints — A just below the mountain's
    // southern tip, B diagonally down-left toward the far chain — so the
    // confirmed line plugs the corridor the army just fought through.
    text: (m, g, ui) => {
      if (ui.pending === 'wall') {
        if (ui.wallEnd) return 'Press the ✓ Build wall button to confirm — or tap elsewhere to move the end.';
        if (ui.wallStart) return `Now ${m ? 'tap' : 'click'} the second marked tile to close the gap between the mountains.`;
        return `${m ? 'Tap' : 'Click'} the marked tile just below the mountain to start the wall.`;
      }
      return m
        ? 'Now hold what you took: enemies can\'t cross finished walls. Tap your army, then tap it again and choose the highlighted 🧱 Wall… button.'
        : 'Now hold what you took: enemies can\'t cross finished walls. Select your army, then press the highlighted 🧱 Wall… button.';
    },
    // only live while the ARMY is the selection: the carriers arrive
    // here selected from the resupply step, and their wall button must
    // stay dimmed — soldiers build this wall, not the supply band
    ops: (g, ui) => selIsArmy(g, ui.selected) ? ['wallBuild'] : [],
    acts: (g, ui) => selIsArmy(g, ui.selected) ? ['wall', 'pwallarm', 'pwall', 'pwallx'] : [],
    select: (g, sel) => selIsArmy(g, sel),
    target: (g, ui) => {
      if (ui.pending !== 'wall') return null;
      const p = ui.wallStart ? st.wallB : st.wallA;
      return { x: p.x, y: p.y, r: 1.4 };
    },
    marker: (g, ui) => {
      if (ui.pending === 'wall') {
        const p = ui.wallStart ? st.wallB : st.wallA;
        return { x: p.x, y: p.y, r: 1.2 };
      }
      if (selIsArmy(g, ui.selected)) return null; // the button pulses instead
      const a = army(g);
      return a ? { x: a.x, y: a.y, r: 1.8 } : null;
    },
    done: (g) => g.blobs.some(b => b.owner === 0 && !b.dead && b.order && b.order.type === 'wall')
      || g.walls.some(w => w.owner === 0),
  },
  { // 13 — what walls do
    next: true,
    text: () => `Your soldiers will raise the wall on their own — any unit can build, and the only price is time. Finished walls stop enemy units while yours pass freely. March units onto a wall tile to garrison it (up to ${S.C.WALL_GARRISON_CAP} per tile): a garrisoned wall fires on enemies beside it and holds up far better, and a supply route can keep it fed.`,
    marker: (g) => {
      const w = g.walls.find(x => x.owner === 0);
      if (w) return { x: w.x + 0.5, y: w.y + 0.5, r: 1.5 };
      if (!st.wallA) return null;
      return { x: (st.wallA.x + st.wallB.x) / 2, y: (st.wallA.y + st.wallB.y) / 2, r: 1.5 };
    },
  },
  { // 14 — done
    next: true,
    finish: true,
    text: () => 'Victory! You\'ve covered selecting, moving, wall-building, settlement modes, supply lines, and combat. Keep playing on this map — the enemy commander wakes up — or head back to the menu. Good luck, commander!',
  },
];

function wire() {
  if (wired) return;
  wired = true;
  $('tut-next').addEventListener('click', () => {
    if (!st) return;
    const step = STEPS[st.idx];
    if (step.finish) { if (deps && deps.onFinish) deps.onFinish(); return; }
    st.idx = Math.min(st.idx + 1, STEPS.length - 1);
    lastText = '';
    render(st.game, st.ui);
    syncButtons();
  });
  $('tut-keep').addEventListener('click', () => {
    if (!st) return;
    if (deps && deps.onKeepPlaying) deps.onKeepPlaying();
  });
  $('tut-exit').addEventListener('click', () => {
    if (deps && deps.onExit) deps.onExit();
  });
}

function render(game, ui) {
  const step = STEPS[st.idx];
  const mobile = deps && deps.isMobile ? deps.isMobile() : false;
  const text = step.text(mobile, game, ui);
  if (text === lastText) return;
  lastText = text;
  $('tut-step').textContent = `Step ${st.idx + 1} of ${STEPS.length}`;
  const t = $('tut-text');
  t.textContent = text;
  t.classList.remove('text-emerald-300');
  const next = $('tut-next');
  next.classList.toggle('hidden', !step.next);
  next.textContent = step.finish ? '🏠 Back to menu' : 'Next';
  $('tut-keep').classList.toggle('hidden', !step.finish);
}

// Resolve a step's ops/acts field: plain array, or a (game, ui) =>
// array function for selection-aware steps.
function stepList(v) {
  if (typeof v === 'function') return (st && v(st.game, st.ui)) || [];
  return v || [];
}

function actAllowed(step, ds) {
  const acts = stepList(step.acts);
  return acts.some(a => typeof a === 'string'
    ? a === ds.act
    : a.act === ds.act && (!a.mode || a.mode === ds.mode) && (!a.role || a.role === ds.role));
}

// Dim every [data-act] button the step doesn't allow and pulse the ones
// it does. The panel rebuilds its whole innerHTML every 400 ms while its
// live numbers change, wiping these classes — a MutationObserver (see
// begin) re-applies them in the same microtask, before the browser can
// paint an un-dimmed frame. The pulse animation is phased off a global
// clock so those rebuilds (shorter than its 1.3 s period) continue the
// pulse instead of restarting it — a restarting animation reads as
// flicker.
const PULSE_MS = 1300; // keep in sync with the .tut-pulse animation duration
function syncButtons() {
  if (!st) return;
  const step = STEPS[st.idx];
  for (const rootId of ['panel', 'order-popup']) {
    const root = $(rootId);
    if (!root) continue;
    for (const btn of root.querySelectorAll('[data-act]')) {
      const ok = actAllowed(step, btn.dataset);
      btn.classList.toggle('tut-dim', !ok);
      if (ok && !btn.classList.contains('tut-pulse')) {
        btn.style.animationDelay = (-(performance.now() % PULSE_MS)) + 'ms';
        btn.classList.add('tut-pulse');
      } else if (!ok && btn.classList.contains('tut-pulse')) {
        btn.classList.remove('tut-pulse');
        btn.style.animationDelay = '';
      }
    }
  }
}

// ---------------------------------------------------------------- API

export function begin(game, d) {
  deps = d;
  st = { game, ui: d.ui, idx: 0, flashUntil: 0, movePoint: null, wallA: null, wallB: null, camStart: null };
  // Step 3's destination: a passable spot 4–5 tiles from home (just past
  // the fields, still inside home territory so the army stays fed),
  // leaning toward the outpost but kept ≥ 3.5 from both the army's camp
  // (so the step can't self-complete) and each settlement center (so the
  // arriving army can't auto-garrison, which triggers within 1.9).
  const h = home(game), o = outpost(game);
  const a0 = army(game);
  const hc = { x: h.x + 1, y: h.y + 1 }, oc = { x: o.x + 1, y: o.y + 1 };
  const len = Math.max(0.001, dist(hc.x, hc.y, oc.x, oc.y));
  const dir = { x: (oc.x - hc.x) / len, y: (oc.y - hc.y) / len };
  let bestPt = null;
  for (const [lo, hi] of [[4, 5], [3.5, 6]]) {
    for (let ty = 1; ty < game.map.h - 1; ty++) {
      for (let tx = 1; tx < game.map.w - 1; tx++) {
        const px = tx + 0.5, py = ty + 0.5;
        const d = dist(px, py, hc.x, hc.y);
        if (d < lo || d > hi) continue;
        if (dist(px, py, oc.x, oc.y) < 3.5) continue;
        if (a0 && dist(px, py, a0.x, a0.y) < 3.5) continue;
        if (!passable(game.map, px, py)) continue;
        const i = ty * game.map.w + tx;
        if (game.settAt[i]) continue;
        const score = (px - hc.x) * dir.x + (py - hc.y) * dir.y;
        if (!bestPt || score > bestPt.score) bestPt = { x: px, y: py, score };
      }
    }
    if (bestPt) break;
  }
  st.movePoint = bestPt || { x: hc.x + dir.x * 4.5, y: hc.y + dir.y * 4.5 };
  // Step 12's wall line: seal the mountain gap west of the enemy camp
  // (coordinates captured now — the war party is dead by the time the
  // step runs). Walk: first mountain tile west of the camp row, down its
  // column to the southern tip, A = the tile just below it, then B =
  // extend diagonally down-left while tiles stay placeable — on the
  // tutorial seed that plugs the corridor between the two chains.
  // Fallbacks: no gap found → the widest clear tile near the camp; no
  // such tile → the camp tile itself (passable, un-settled and un-tilled
  // by scenario construction, so canPlaceWall accepts it).
  const e0 = enemy(game);
  const camp = e0 ? { x: Math.floor(e0.x), y: Math.floor(e0.y) } : { x: o.x, y: o.y };
  const mtn = (x, y) => x >= 0 && y >= 0 && x < game.map.w && y < game.map.h
    && !!game.map.mountain[y * game.map.w + x];
  const placeable = (x, y) => x >= 0 && y >= 0 && x < game.map.w && y < game.map.h
    && !S.canPlaceWall(game, 0, x, y).err;
  let A = null;
  for (const dy of [0, -1, 1]) {
    const ry = camp.y + dy;
    for (let x = camp.x - 1; x >= Math.max(0, camp.x - 8); x--) {
      if (!mtn(x, ry)) continue;
      let tipY = ry;
      while (mtn(x, tipY + 1)) tipY++;
      if (placeable(x, tipY + 1)) A = { x, y: tipY + 1 };
      break; // the first mountain west on this row decides; else try the next row
    }
    if (A) break;
  }
  if (!A) {
    let bestW = null;
    for (const [lo, hi] of [[1.5, 3.5], [1, 5]]) {
      for (let ty = 1; ty < game.map.h - 1; ty++) {
        for (let tx = 1; tx < game.map.w - 1; tx++) {
          const d = dist(tx + 0.5, ty + 0.5, camp.x + 0.5, camp.y + 0.5);
          if (d < lo || d > hi) continue;
          if (!placeable(tx, ty)) continue;
          const score = dist(tx + 0.5, ty + 0.5, oc.x, oc.y);
          if (!bestW || score > bestW.score) bestW = { x: tx, y: ty, score };
        }
      }
      if (bestW) break;
    }
    A = bestW ? { x: bestW.x, y: bestW.y } : { x: camp.x, y: camp.y };
  }
  let B = { x: A.x, y: A.y };
  for (let k = 0; k < 3 && placeable(B.x - 1, B.y + 1); k++) B = { x: B.x - 1, y: B.y + 1 };
  st.wallA = { x: A.x + 0.5, y: A.y + 0.5 };
  st.wallB = { x: B.x + 0.5, y: B.y + 0.5 };
  wire();
  lastText = '';
  render(game, d.ui);
  // childList-only observer: fires (as a microtask, pre-paint) whenever a
  // panel/popup innerHTML rebuild replaces the buttons, so dim/pulse state
  // never misses a frame. Class toggles are attribute mutations — they
  // don't retrigger it.
  domObserver = new MutationObserver(syncButtons);
  domObserver.observe($('panel'), { childList: true, subtree: true });
  domObserver.observe($('order-popup'), { childList: true, subtree: true });
  syncButtons();
  $('tutorial-box').classList.remove('hidden');
}

export function end() {
  if (!st) return;
  if (st.ui) st.ui.tutMarker = null;
  st = null;
  deps = null;
  lastText = '';
  if (domObserver) { domObserver.disconnect(); domObserver = null; }
  $('tutorial-box').classList.add('hidden');
  for (const el of document.querySelectorAll('.tut-dim, .tut-pulse')) {
    el.classList.remove('tut-dim', 'tut-pulse');
    el.style.animationDelay = '';
  }
}

export function active() { return !!st; }

// Called every frame from main.js's loop while a tutorial game runs:
// polls the step's completion predicate, advances (with a brief ✓ flash),
// keeps the map marker and card text current, and refreshes button state.
export function tick(game, ui) {
  if (!st) return;
  st.game = game;
  st.ui = ui;
  // The camp has no supply line of its own and would starve out in ~4
  // idle minutes — keep it fed so a slow player still gets their fight.
  // Stops the moment the guided session ends (finish, exit, keep playing).
  const en = enemy(game);
  if (en) en.food = S.foodCap(en);
  const now = performance.now();
  if (st.flashUntil) {
    if (now < st.flashUntil) return;
    st.flashUntil = 0;
    st.idx = Math.min(st.idx + 1, STEPS.length - 1);
    lastText = '';
    syncButtons(); // the allowed set changed without a DOM rebuild
  }
  const step = STEPS[st.idx];
  if (step.done && step.done(game, ui)) {
    st.flashUntil = now + 700;
    ui.tutMarker = null;
    lastText = '✓';
    $('tut-text').textContent = '✓ Nicely done!';
    $('tut-text').classList.add('text-emerald-300');
    return;
  }
  render(game, ui);
  ui.tutMarker = step.marker ? step.marker(game, ui) : null;
}

// -- gating queries (all default to "allowed" when no tutorial runs) ----

export function allowsOp(op) {
  if (!st) return true;
  return stepList(STEPS[st.idx].ops).includes(op);
}

export function allowsAct(ds) {
  if (!st) return true;
  return actAllowed(STEPS[st.idx], ds);
}

export function allowsSelect(sel) {
  if (!st) return true;
  const s = STEPS[st.idx];
  return !!(s.select && s.select(st.game, sel));
}

export function allowsTarget(world) {
  if (!st) return true;
  const s = STEPS[st.idx];
  const c = s.target ? s.target(st.game, st.ui) : null;
  return !!c && dist(world.x, world.y, c.x, c.y) <= c.r;
}

// Shake the card so a swallowed input visibly registered.
export function nudge() {
  if (!st) return;
  const now = performance.now();
  if (now - lastNudge < 450) return;
  lastNudge = now;
  const box = $('tutorial-box');
  box.classList.remove('tut-shake');
  void box.offsetWidth; // restart the animation
  box.classList.add('tut-shake');
}
