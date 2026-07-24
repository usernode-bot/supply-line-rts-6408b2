// Click-through tutorial controller (#185): owns the 10-step script, the
// input-gating whitelist main.js consults at its dispatch choke points,
// and the #tutorial-box card. Step state is session-local UI state —
// never serialized (same policy as control groups).

import * as S from './sim.js';
import { dist, passable } from './mapgen.js';

const $ = (id) => document.getElementById(id);

let st = null;      // { game, ui, idx, flashUntil, movePoint } while active
let deps = null;    // { ui, isMobile, onExit, onFinish, onKeepPlaying } from main.js
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

function selIsArmy(g, sel) {
  if (!sel) return false;
  const a = army(g);
  if (!a) return false;
  if (sel.kind === 'blob') {
    const b = resolveBlob(g, sel.id);
    return !!b && b.id === a.id;
  }
  if (sel.kind === 'multi') {
    return sel.ids.length > 0 && sel.ids.every(id => {
      const b = resolveBlob(g, id);
      return !!b && b.id === a.id;
    });
  }
  return false;
}

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
// that reaches the goal counts).
const STEPS = [
  { // 1 — welcome
    next: true,
    text: () => 'Welcome to Supply Line! The goal: wipe out the enemy — but every army marches on its stomach. This quick tour covers the basics, then supply lines. You can pan and zoom freely the whole time.',
  },
  { // 2 — select the army
    text: (m) => `This is your army — 10 soldiers camped by your home settlement. ${m ? 'Tap' : 'Click'} the pulsing ring to select it.`,
    select: (g, sel) => selIsArmy(g, sel),
    marker: (g) => { const a = army(g); return a ? { x: a.x, y: a.y, r: 1.8 } : null; },
    done: (g, ui) => selIsArmy(g, ui.selected),
  },
  { // 3 — move out
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
  { // 4 — inspect the home settlement
    text: (m) => `${m ? 'Tap' : 'Click'} your marked home settlement. Its panel shows the food stockpile, the live income breakdown, and the garrison sheltering inside its walls.`,
    acts: ['pselsett'],
    select: (g, sel) => selIsHome(g, sel),
    marker: (g) => { const h = home(g); return h ? { x: h.x + 1, y: h.y + 1, r: 2.3 } : null; },
    done: (g, ui) => selIsHome(g, ui.selected),
  },
  { // 5 — production modes
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
  { // 6 — why supply lines matter
    next: true,
    text: () => 'Why supply? Every unit eats. Near your own settlements armies are fed automatically — but out in enemy land they starve unless they pillage the land or a supply route feeds them. Hungry armies fight badly, and starve at zero.',
  },
  { // 7 — create the supply line (two-phase: arm the button, pick the destination)
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
  { // 8 — watch it work
    next: true,
    text: () => 'A caravan is loading up at home and hauling food to the outpost — that\'s the marked group on the road. It shuttles back and forth on its own. Raiders love caravans, so in a real match routes need guarding.',
    marker: (g) => {
      const h = home(g);
      const r = h && g.routes.find(x => x.owner === 0 && x.settlementId === h.id);
      const c = r && r.carrierIds && r.carrierIds.length ? resolveBlob(g, r.carrierIds[0]) : null;
      return c ? { x: c.x, y: c.y, r: 1.3 } : null;
    },
  },
  { // 9 — attack
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
  { // 10 — done
    next: true,
    finish: true,
    text: () => 'Victory! You\'ve covered selecting, moving, settlement modes, supply lines, and combat. Keep playing on this map — the enemy commander wakes up — or head back to the menu. Good luck, commander!',
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

function actAllowed(step, ds) {
  const acts = step.acts || [];
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
  st = { game, ui: d.ui, idx: 0, flashUntil: 0, movePoint: null };
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
  const s = STEPS[st.idx];
  return !!(s.ops && s.ops.includes(op));
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
