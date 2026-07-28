// Controls tour (#212): a hands-on touch-controls card. Every touch step is
// completed by actually performing the gesture — the step's gate is satisfied
// either by a state predicate (`practice`) or by a `signal()` fired from the
// place in main.js / input.js where the gesture really lands. Next stays
// enabled on every step, so a gesture a device or a pair of hands won't do can
// never trap the player.
//
// Deliberately NOT part of tutorial.js: that module is a gated scenario keyed
// to game.tutorial (fixed seed, tracked blob ids, whitelisted ops/acts). This
// tour runs over ANY match — a real one, the tutorial map before its scenario
// begins, or the throwaway practice map behind the menu's 🕹️ button — and it
// never gates or swallows input. All state here is session-local UI state;
// nothing is serialized into the sim save.

const $ = (id) => document.getElementById(id);

// This module owns no persistence: which page sets a player has read lives in
// main.js's playerState section (account-backed, localStorage-cached). All the
// tour does is report, through onClose({ set, seen }), which set was on screen
// when it closed and whether the player reached the end — main.js decides what
// that means.

// -- figures: inline SVG only, no assets and no build step ----------------

const FIG_PAN = `<svg viewBox="0 0 120 48" class="w-full h-12" aria-hidden="true">
  <rect x="2" y="4" width="116" height="40" rx="6" fill="none" stroke="currentColor" stroke-opacity="0.3"/>
  <path d="M22 24h76" stroke="#38bdf8" stroke-width="2" stroke-dasharray="5 4" class="ct-fig-dash"/>
  <circle cx="30" cy="24" r="7" fill="#38bdf8" fill-opacity="0.35" stroke="#38bdf8" stroke-width="2" class="ct-fig-slide"/>
</svg>`;

const FIG_MINIMAP = `<svg viewBox="0 0 120 48" class="w-full h-12" aria-hidden="true">
  <rect x="2" y="4" width="116" height="40" rx="6" fill="none" stroke="currentColor" stroke-opacity="0.3"/>
  <rect x="84" y="8" width="30" height="24" rx="3" fill="#166534" fill-opacity="0.5" stroke="#4ade80" stroke-opacity="0.7"/>
  <rect x="92" y="14" width="12" height="10" rx="1" fill="none" stroke="#e4e4e7" stroke-opacity="0.8"/>
  <circle cx="98" cy="19" r="8" fill="none" stroke="#a78bfa" stroke-width="2" class="ct-fig-tap"/>
</svg>`;

const FIG_PINCH = `<svg viewBox="0 0 120 48" class="w-full h-12" aria-hidden="true">
  <rect x="2" y="4" width="116" height="40" rx="6" fill="none" stroke="currentColor" stroke-opacity="0.3"/>
  <circle cx="44" cy="24" r="7" fill="#38bdf8" fill-opacity="0.35" stroke="#38bdf8" stroke-width="2" class="ct-fig-pinch-a"/>
  <circle cx="76" cy="24" r="7" fill="#38bdf8" fill-opacity="0.35" stroke="#38bdf8" stroke-width="2" class="ct-fig-pinch-b"/>
</svg>`;

const FIG_TAP = `<svg viewBox="0 0 120 48" class="w-full h-12" aria-hidden="true">
  <rect x="2" y="4" width="116" height="40" rx="6" fill="none" stroke="currentColor" stroke-opacity="0.3"/>
  <circle cx="60" cy="24" r="8" fill="#a78bfa" fill-opacity="0.5" stroke="#a78bfa" stroke-width="2"/>
  <circle cx="60" cy="24" r="8" fill="none" stroke="#a78bfa" stroke-width="2" class="ct-fig-tap"/>
</svg>`;

// Select (cursor) + Drag (dashed box) icons, copied from the real
// #mode-toggle buttons so the mode step reads correctly even when the live
// toggle is off-screen (it is display:none at ≥640px).
const FIG_MODES = `<div class="flex items-center justify-center gap-3 py-1" aria-hidden="true">
  <span class="inline-flex items-center gap-1 px-2 py-1 rounded-lg border border-violet-400 bg-violet-600 text-white">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M5 2v17l4.5-4.2 2.8 6 2.9-1.3-2.8-6H19z"/></svg>
    <span class="text-xs font-semibold">Select</span>
  </span>
  <span class="inline-flex items-center gap-1 px-2 py-1 rounded-lg border border-zinc-700 bg-zinc-900/85 text-zinc-300">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="4 3"><rect x="3.5" y="3.5" width="17" height="17" rx="2"/></svg>
    <span class="text-xs font-semibold">Drag</span>
  </span>
</div>`;

const FIG_SHEET = `<svg viewBox="0 0 120 56" class="w-full h-14" aria-hidden="true">
  <rect x="2" y="2" width="116" height="52" rx="6" fill="none" stroke="currentColor" stroke-opacity="0.3"/>
  <rect x="88" y="7" width="25" height="20" rx="3" fill="#27272a" stroke="#52525b"/>
  <rect x="7" y="34" width="106" height="6" rx="2" fill="#3f3f46"/>
  <rect x="2" y="42" width="116" height="12" rx="3" fill="#18181b" stroke="#52525b"/>
</svg>`;

const FIG_HOLD = `<svg viewBox="0 0 120 48" class="w-full h-12" aria-hidden="true">
  <rect x="10" y="10" width="100" height="14" rx="4" fill="#27272a" stroke="#52525b"/>
  <rect x="10" y="30" width="100" height="6" rx="3" fill="#3f3f46"/>
  <rect x="10" y="30" width="46" height="6" rx="3" fill="#8b5cf6" class="ct-fig-fill"/>
  <circle cx="56" cy="33" r="7" fill="#a78bfa" fill-opacity="0.5" stroke="#a78bfa" stroke-width="2" class="ct-fig-slide"/>
</svg>`;

const FIG_GROUPS = `<div class="flex items-center justify-center gap-1 py-1" aria-hidden="true">
  <span class="inline-flex items-center gap-1 px-2 py-1 rounded-lg border border-violet-500 bg-violet-700 text-white text-xs font-semibold"><b>1</b>👥12</span>
  <span class="inline-flex items-center gap-1 px-2 py-1 rounded-lg border border-zinc-700 bg-zinc-900/85 text-zinc-200 text-xs font-semibold"><b>2</b>🏠</span>
  <span class="inline-flex items-center px-2 py-1 rounded-lg border border-dashed border-zinc-600 bg-zinc-900/70 text-zinc-400 text-xs">＋</span>
</div>`;

const FIG_MOUSE = `<svg viewBox="0 0 120 48" class="w-full h-12" aria-hidden="true">
  <rect x="46" y="6" width="28" height="38" rx="14" fill="none" stroke="currentColor" stroke-opacity="0.5" stroke-width="2"/>
  <path d="M60 6v16" stroke="currentColor" stroke-opacity="0.5" stroke-width="2"/>
  <path d="M46 22h28" stroke="currentColor" stroke-opacity="0.5" stroke-width="2"/>
</svg>`;

const FIG_KEYS = `<div class="flex items-center justify-center gap-1 py-1 font-mono text-xs text-zinc-300" aria-hidden="true">
  <span class="px-2 py-1 rounded bg-zinc-800 border border-zinc-600">W</span>
  <span class="px-2 py-1 rounded bg-zinc-800 border border-zinc-600">A</span>
  <span class="px-2 py-1 rounded bg-zinc-800 border border-zinc-600">S</span>
  <span class="px-2 py-1 rounded bg-zinc-800 border border-zinc-600">D</span>
</div>`;

// -- step scripts ---------------------------------------------------------
//
// { title, text, figure?, ring?, anchor?, todo?, practice?, needs?, stages?,
//   available? }
//   ring      — element id outlined with .ct-ring while the step is up
//               (skipped silently when the target is hidden)
//   anchor    — 'top' (default) or 'bottom'; the map/minimap steps anchor
//               bottom so the card can't cover what they point at
//   todo      — the "▸ Try it: …" line shown while the gate is open
//   practice  — (view, ui, st) => boolean, polled each frame
//   needs     — signal names; ANY ONE satisfies the step (see signal())
//   stages    — ordered sub-goals [{ label, needs?, test? }] for the
//               multi-part steps; forward-only, ticked off in #ct-todo
//   available — (game, ui, st) => true | 'reason'. A string means the gate
//               cannot be met in this match (control groups are switched off
//               during the guided tutorial; the mode toggle doesn't exist at
//               desktop widths), so the step renders the reason and relies on
//               Next instead of waiting forever.
//
// Every step keeps a working Next, so an awkward gesture never traps anyone.

const PAN_MIN = 3;      // tiles the view centre must move
const ZOOM_IN = 1.3;    // scale ratio counted as a zoom
const ZOOM_OUT = 0.77;

const hasUnits = (ui) => !!(ui && ui.selected && (ui.selected.kind === 'blob' || ui.selected.kind === 'multi'));

// Is anything on screen that the hold-and-slide gesture can be tried on?
// #recall-hold / #field-hold live in the settlement panel; psplit lives in the
// unit-options popup. All three are wired through the same 350 ms hold.
function holdTargetExists() {
  return !!($('recall-hold') || $('field-hold') ||
    document.querySelector('#order-popup [data-act="psplit"]'));
}

function toggleVisible() {
  const el = $('mode-toggle');
  return !!(el && el.offsetParent !== null && el.offsetHeight > 0);
}

const TOUCH_STEPS = [
  {
    title: 'Look around',
    text: 'Drag with one finger to pan the map. Zoomed out you see your whole front; zoomed in you can read a single fight.',
    todo: 'drag one finger across the map',
    figure: FIG_PAN,
    anchor: 'bottom',
    practice: (view, ui, st) => {
      if (!view) return true;
      if (!st.camStart) { st.camStart = { cx: view.cx, cy: view.cy }; return false; }
      return Math.hypot(view.cx - st.camStart.cx, view.cy - st.camStart.cy) >= PAN_MIN;
    },
  },
  {
    title: 'Jump anywhere',
    text: 'The minimap in the top-right corner is a shortcut across the whole map: tap it to jump the camera there, or drag across it to sweep.',
    todo: 'tap the minimap in the corner',
    figure: FIG_MINIMAP,
    anchor: 'bottom',
    needs: ['minimap'],
  },
  {
    title: 'Zoom',
    text: 'Pinch with two fingers on the map to zoom in and out.',
    todo: 'pinch two fingers on the map',
    figure: FIG_PINCH,
    anchor: 'bottom',
    needs: ['pinch'],
    practice: (view, ui, st) => {
      if (!view) return true;
      if (!st.zoomStart) { st.zoomStart = view.scale; return false; }
      const r = view.scale / Math.max(0.001, st.zoomStart);
      return r >= ZOOM_IN || r <= ZOOM_OUT;
    },
  },
  {
    title: 'Select',
    text: 'Tap a group of your units to select it — the panel at the bottom shows its health, food and roles. With nothing selected, tapping ground, a settlement or a wall inspects it instead.',
    todo: 'tap one of your unit groups',
    figure: FIG_TAP,
    practice: (view, ui) => hasUnits(ui),
  },
  {
    title: 'Give orders',
    text: 'Tap your selection again to open its action list beside your finger: 📍 Move…, 🔥 Pillage, ✂️ Split, 🏠 Build, 🧱 Wall…, 🚚 Supply route… and the three roles. Orders that need a destination arm first — then you tap the map.',
    todo: 'tap your selected units again',
    figure: FIG_TAP,
    needs: ['unit-options'],
    available: (game, ui) => hasUnits(ui) || 'Select some units first — tap Back for that step.',
  },
  {
    title: 'Tapping with units in hand',
    text: 'A tap always asks before it acts. Empty ground offers Move / Attack / Deselect, so a stray tap never marches your army off. Your own settlement offers Select settlement / Garrison units. Founding a settlement or a wall shows a ✓ / ✕ pair you can pan the map under before you confirm.',
    todo: 'with units selected, tap empty ground',
    figure: FIG_TAP,
    needs: ['ask-popup'],
    available: (game, ui) => hasUnits(ui) || 'Select some units first — tap Back for that step.',
  },
  {
    title: 'Select vs Drag',
    text: 'The two icons in the bottom-left corner switch input modes. In Select mode taps do everything above. In Drag mode a one-finger drag draws a selection box that adds to your group — drag as many times as you like — while two-finger pan still works. Switching into Drag clears the current selection; orders resume in Select mode.',
    figure: FIG_MODES,
    ring: 'mode-toggle',
    stages: [
      { label: 'tap Drag', needs: ['mode-drag'] },
      { label: 'drag a box on the map', needs: ['touch-box'] },
      { label: 'tap Select again', needs: ['mode-select'] },
    ],
    available: (game, ui, st) => st.force || toggleVisible()
      || 'The Select / Drag toggle only exists on phone-sized screens.',
  },
  {
    title: 'Reading the screen',
    text: 'The selection panel is a bottom sheet on phones, with the per-unit health strip just above it and the minimap up in the top-right corner. Everything scrolls inside the sheet — the map behind it stays live.',
    todo: 'tap your own settlement to fill the sheet',
    figure: FIG_SHEET,
    ring: 'panel',
    practice: (view, ui) => !!(ui && ui.selected && ui.selected.kind === 'settlement'),
  },
  {
    title: 'Hold and slide',
    text: 'Press and hold ✂️ Split, Recall or Field for about a third of a second: a slider bar appears, sliding left or right picks a number, and releasing commits it. Let go without sliding and nothing happens.',
    todo: 'press and hold Recall (or ✂️ Split) until the bar appears',
    figure: FIG_HOLD,
    needs: ['hold-arm'],
    available: () => holdTargetExists()
      || 'Select your settlement (the step before this) to reach its Recall button.',
  },
  {
    title: 'Control groups',
    text: 'The numbered chips down the left edge are control groups: ＋ stores whatever you have selected, tapping a chip selects it again, and tapping the same chip twice centres the camera on it.',
    figure: FIG_GROUPS,
    ring: 'groups-bar',
    stages: [
      { label: 'tap ＋ with something selected', needs: ['group-assign'] },
      { label: 'tap the chip to select it again', needs: ['group-select'] },
    ],
    available: (game) => !(game && game.tutorial)
      || 'Control groups are switched off during the tutorial — tap Next.',
  },
];

const DESK_STEPS = [
  {
    title: 'Mouse',
    text: 'Left-click selects and inspects; right-click is the order button — right-click ground to move, an enemy to attack, your own wall or town to march in and garrison. Left-drag box-selects, and shift-drag adds to the selection.',
    figure: FIG_MOUSE,
  },
  {
    title: 'Camera',
    text: 'Pan with WASD or the arrow keys, by dragging with the middle mouse button, or by pushing the pointer against a screen edge. The wheel zooms; on a trackpad, two-finger scroll pans and pinch zooms. Clicking or dragging the minimap jumps the view.',
    figure: FIG_KEYS,
  },
  {
    title: 'Keys',
    text: 'Shift + a number key assigns the selection to a control group; the number key alone selects it and pressing it twice centres the camera on it. Space pauses a solo match, and Esc cancels an armed order or clears the selection.',
    figure: FIG_KEYS,
  },
  {
    title: 'Orders that need two clicks',
    text: 'Supply route, Wall and Build all arm first: press the button, then click the source, the endpoints or the site. A hint bar at the top says what the game is waiting for, and Esc backs out at any point.',
  },
];

// -- state ----------------------------------------------------------------

let st = null;     // { mode, set, idx, hits, stage, flashUntil, … } while open
let deps = null;   // { onClose } from main.js
let wired = false;
let ringEl = null;
let lastGame = null; // most recent game handle from tick(), for signal()'s re-eval
const PULSE_MS = 1300; // keep in sync with the .tut-pulse / .ct-ring animation
const FLASH_MS = 700;

function steps() { return st && st.set === 'desktop' ? DESK_STEPS : TOUCH_STEPS; }

// Whether the current pages wait for real gestures. Decided by the CALLER at
// open() time (see the `gated` option) rather than derived from the page set,
// because the touch pages shown on a desktop-width screen must read through
// rather than ask for fingers that aren't there.
function gating() { return !!st && st.mode === 'tour' && !!st.gated; }

function clearRing() {
  if (ringEl) {
    ringEl.classList.remove('ct-ring');
    ringEl.style.animationDelay = '';
    ringEl = null;
  }
}

// Apply the step's ring to its target, skipping hidden / zero-box targets
// (#mode-toggle is display:none on desktop, #groups-bar and #panel are
// hidden until they have something to show).
function syncRing() {
  if (!st) { clearRing(); return; }
  const step = steps()[st.idx];
  const want = (st.mode === 'tour' && step && step.ring) ? $(step.ring) : null;
  const visible = want && want.offsetParent !== null && want.offsetHeight > 0;
  const target = visible ? want : null;
  if (target === ringEl) return;
  clearRing();
  if (!target) return;
  ringEl = target;
  ringEl.style.animationDelay = (-(performance.now() % PULSE_MS)) + 'ms';
  ringEl.classList.add('ct-ring');
}

// Bottom-anchored cards float above the bottom sheet + unit strip, using the
// same offset arithmetic as main.js's updateModeToggle.
function syncAnchor() {
  if (!st) return;
  const step = steps()[st.idx];
  const card = $('controls-tour-card');
  if (!card) return;
  if (st.mode !== 'tour') {
    card.style.top = '';
    card.style.bottom = '';
    return;
  }
  if (step && step.anchor === 'bottom') {
    let bottom = 8;
    const panel = $('panel'), strip = $('unit-strip');
    if (panel && !panel.classList.contains('hidden')) bottom += panel.offsetHeight;
    if (strip && !strip.classList.contains('hidden')) bottom += strip.offsetHeight;
    card.style.top = 'auto';
    card.style.bottom = bottom + 'px';
  } else {
    card.style.top = '';
    card.style.bottom = 'auto';
  }
}

// -- gate evaluation ------------------------------------------------------

// true, or the reason string the step can't be gated here.
function availability(step) {
  if (!step || !step.available) return true;
  let r = true;
  try { r = step.available(lastGame, st.ui || null, st); } catch { r = true; }
  return r === true ? true : (typeof r === 'string' ? r : true);
}

function stageDone(stage) {
  if (!stage) return false;
  if (stage.needs && stage.needs.some(n => st.hits.has(n))) return true;
  if (stage.test) {
    try { return !!stage.test(st.view || null, st.ui || null, st); } catch { return false; }
  }
  return false;
}

// Advance st.stage over every satisfied sub-goal (forward only, so tapping
// Drag → Select → Drag can't walk the checklist backwards).
function advanceStages(step) {
  let moved = false;
  while (st.stage < step.stages.length && stageDone(step.stages[st.stage])) {
    st.stage++;
    moved = true;
  }
  return moved;
}

// Renders the "▸ Try it: …" line, the stage checklist, or the muted reason.
function renderTodo() {
  const el = $('ct-todo');
  if (!el) return;
  const step = steps()[st.idx];
  if (!gating() || !step) { el.classList.add('hidden'); el.textContent = ''; return; }
  const avail = availability(step);
  if (avail !== true) {
    el.textContent = avail;
    el.className = 'mt-2 text-xs text-zinc-500 italic';
    el.classList.remove('hidden');
    return;
  }
  if (step.stages) {
    el.innerHTML = step.stages.map((s, i) => {
      if (i < st.stage) return `<span class="text-emerald-400">✓ ${s.label}</span>`;
      if (i === st.stage) return `<span class="text-sky-300 font-semibold">▸ ${s.label}</span>`;
      return `<span class="text-zinc-500">${s.label}</span>`;
    }).join('<span class="text-zinc-600"> · </span>');
    el.className = 'mt-2 text-xs';
    el.classList.remove('hidden');
    return;
  }
  if (step.todo || step.needs || step.practice) {
    el.textContent = `▸ Try it: ${step.todo || 'perform the gesture above'}`;
    el.className = 'mt-2 text-xs text-sky-300 font-semibold';
    el.classList.remove('hidden');
    return;
  }
  el.classList.add('hidden');
  el.textContent = '';
}

function flashDone() {
  st.flashUntil = performance.now() + FLASH_MS;
  const t = $('ct-text');
  t.textContent = '✓ Nicely done!';
  t.classList.add('text-emerald-300');
  const todo = $('ct-todo');
  if (todo) todo.classList.add('hidden');
}

// The single gate check, shared by tick() (each frame) and signal() (the
// instant a gesture lands, so one that reverts in the same frame still counts).
function evaluate() {
  if (!gating() || st.flashUntil) return;
  const step = steps()[st.idx];
  if (!step) return;
  if (availability(step) !== true) { renderTodo(); return; }
  if (step.stages) {
    if (advanceStages(step)) {
      if (st.stage >= step.stages.length) { flashDone(); return; }
      renderTodo();
    }
    return;
  }
  let ok = false;
  if (step.needs && step.needs.some(n => st.hits.has(n))) ok = true;
  if (!ok && step.practice) {
    try { ok = !!step.practice(st.view || null, st.ui || null, st); } catch { ok = false; }
  }
  if (ok) flashDone();
}

// -- render ---------------------------------------------------------------

function render() {
  if (!st) return;
  const list = steps();
  const step = list[st.idx];
  const last = st.idx === list.length - 1;
  $('ct-step').textContent = `Step ${st.idx + 1} of ${list.length}`;
  $('ct-title').textContent = step.title;
  const fig = $('ct-figure');
  fig.innerHTML = step.figure || '';
  fig.classList.toggle('hidden', !step.figure);
  const text = $('ct-text');
  text.textContent = step.text;
  text.classList.remove('text-emerald-300');
  const back = $('ct-back');
  back.disabled = st.idx === 0;
  back.classList.toggle('opacity-40', st.idx === 0);
  $('ct-next').textContent = last ? (st.finishLabel || '✓ Got it') : 'Next';
  const skip = $('ct-skip');
  skip.textContent = st.skipLabel || 'Skip tour';
  skip.classList.toggle('hidden', st.mode !== 'tour');
  const exit = $('ct-exit');
  exit.textContent = st.exitLabel || '';
  exit.classList.toggle('hidden', !st.exitLabel);
  $('ct-swap').textContent = st.set === 'desktop'
    ? 'Show touch controls' : 'Show mouse & keyboard controls';
  // reference mode is modal (scrim + centred card); tour mode leaves the map
  // fully tappable behind a card that owns no scrim
  const root = $('controls-tour');
  const scrim = $('ct-scrim');
  const reference = st.mode !== 'tour';
  scrim.classList.toggle('hidden', !reference);
  root.classList.toggle('pointer-events-none', !reference);
  const card = $('controls-tour-card');
  card.classList.toggle('pointer-events-auto', true);
  card.classList.toggle('ct-card-center', reference);
  card.classList.toggle('ct-card-tour', !reference);
  card.classList.toggle('ct-card-collapsed', !!st.collapsed);
  const coll = $('ct-collapse');
  coll.textContent = st.collapsed ? '▴' : '▾';
  coll.setAttribute('aria-label', st.collapsed ? 'Expand the controls card' : 'Fold the controls card away');
  coll.classList.toggle('hidden', st.mode !== 'tour');
  renderTodo();
  syncAnchor();
  syncRing();
}

function go(delta) {
  if (!st) return;
  const list = steps();
  const next = st.idx + delta;
  if (next < 0) return;
  if (next >= list.length) { close({ seen: true }); return; }
  st.idx = next;
  resetStep();
  render();
  evaluate(); // a step whose gate is already satisfied shouldn't stall
}

function resetStep() {
  st.hits = new Set();
  st.stage = 0;
  st.camStart = null;
  st.zoomStart = null;
  st.flashUntil = 0;
}

function wire() {
  if (wired) return;
  wired = true;
  $('ct-next').addEventListener('click', () => go(1));
  $('ct-back').addEventListener('click', () => go(-1));
  $('ct-skip').addEventListener('click', () => close({ seen: true }));
  $('ct-exit').addEventListener('click', () => close({ seen: true }));
  $('ct-collapse').addEventListener('click', () => toggleCollapse());
  $('ct-swap').addEventListener('click', () => {
    if (!st) return;
    st.set = st.set === 'desktop' ? 'touch' : 'desktop';
    st.gated = false; // swapping is a lookup, never something to perform
    st.idx = 0;
    resetStep();
    render();
  });
  $('ct-scrim').addEventListener('click', () => close({ seen: false }));
  window.addEventListener('keydown', (e) => {
    if (!st || st.mode === 'tour') return;
    if (e.code === 'Escape') close({ seen: false });
  });
}

// -- API ------------------------------------------------------------------

// open({ mode, set, step, force, finishLabel, skipLabel, exitLabel, onClose })
//   mode        'tour' (non-modal, over a live match) | 'reference' (modal card)
//   set         'touch' | 'desktop' — which page set to show
//   step        0-based starting index
//   gated       whether the steps wait for real gestures; defaults to
//               set === 'touch'. The caller owns this because it depends on the
//               SCREEN, not the page set (see gating()).
//   force       screenshot deep links: ignore the viewport width, and treat
//               width-dependent gates as available
//   finishLabel replaces '✓ Got it' on the last step
//   skipLabel   replaces 'Skip tour'
//   exitLabel   adds an extra escape link (the practice map's "Exit practice")
// The labels are plain overrides on purpose: the caller (main.js's tutorial
// prelude / practice map) owns the wording and what closing means, so this
// module needs to know nothing about tutorials or sandboxes.
export function open(opts) {
  const o = opts || {};
  wire();
  deps = { onClose: o.onClose || null };
  const set = o.set === 'desktop' ? 'desktop' : 'touch';
  st = {
    mode: o.mode === 'reference' ? 'reference' : 'tour',
    set,
    gated: o.gated === undefined ? set === 'touch' : !!o.gated,
    idx: Math.max(0, o.step || 0),
    force: !!o.force,
    finishLabel: o.finishLabel || null,
    skipLabel: o.skipLabel || null,
    exitLabel: o.exitLabel || null,
    collapsed: false,
    hits: new Set(),
    stage: 0,
    flashUntil: 0,
    camStart: null,
    zoomStart: null,
    view: null,
    ui: null,
  };
  const list = steps();
  if (st.idx >= list.length) st.idx = list.length - 1;
  // never stack two instruction cards — the guided tutorial's card steps
  // aside for as long as the tour is up
  const tbox = $('tutorial-box');
  st.hidTutBox = !!(tbox && !tbox.classList.contains('hidden'));
  if (st.hidTutBox) tbox.classList.add('hidden');
  $('controls-tour').classList.remove('hidden');
  render();
}

// close({ seen }) — `seen` means the player reached the end or skipped, i.e.
// the pages were delivered. The set that was ON SCREEN at close time is
// reported to onClose, so a mid-tour swap credits the pages actually read.
export function close(opts) {
  if (!st) return;
  const o = opts || {};
  const info = { set: st.set, seen: !!o.seen };
  const hid = st.hidTutBox;
  const cb = deps && deps.onClose;
  clearRing();
  st = null;
  deps = null;
  lastGame = null;
  const card = $('controls-tour-card');
  if (card) card.classList.remove('ct-card-collapsed');
  $('controls-tour').classList.add('hidden');
  if (hid) {
    const tbox = $('tutorial-box');
    if (tbox) tbox.classList.remove('hidden');
  }
  if (cb) cb(info);
}

export function active() { return !!st; }

// Fold the card down to a header pill and back. Gating keeps running while
// folded, so the player can tuck the card away, do the gesture, and watch the
// step tick over.
export function toggleCollapse() {
  if (!st) return;
  st.collapsed = !st.collapsed;
  render();
}

// A gesture landed. No-op unless an interactive touch tour is open; otherwise
// latch the name for this step and re-check the gate immediately, so a gesture
// that resolves and reverts inside one frame still counts.
export function signal(name) {
  if (!gating() || !name) return;
  st.hits.add(name);
  evaluate();
}

// Called each frame from main.js's loop while the tour is open: keeps the
// step's view/ui/game handles current, polls the gate, and keeps the ring and
// the bottom-anchor offset in step with the panel growing and shrinking.
export function tick(view, ui, game) {
  if (!st) return;
  st.view = view || null;
  st.ui = ui || null;
  lastGame = game || null;
  const now = performance.now();
  if (st.flashUntil) {
    if (now < st.flashUntil) return;
    st.flashUntil = 0;
    go(1);
    return;
  }
  syncAnchor();
  syncRing();
  if (!gating()) return;
  renderTodo(); // availability can change as the panel rebuilds
  evaluate();
}
