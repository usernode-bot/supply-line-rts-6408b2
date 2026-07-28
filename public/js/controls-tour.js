// Controls tour (#212): a first-run, step-by-step touch-controls card that
// opens the first time a player enters a match on a phone-sized screen, plus
// a permanent 🕹️ help button that re-opens it as a reference.
//
// Deliberately NOT part of tutorial.js: that module is a gated scenario keyed
// to game.tutorial (fixed seed, tracked blob ids, whitelisted ops/acts). This
// tour runs over ANY match — including a resumed save — and never gates or
// swallows input. All state here is session-local UI state; nothing is
// serialized into the sim save.

const $ = (id) => document.getElementById(id);

const SEEN_KEY = 'supply-line-controls-tour-v1';

export function seen() {
  try { return localStorage.getItem(SEEN_KEY) === '1'; } catch { return false; }
}
// Exported so main.js can mark the tour delivered on a path that doesn't run
// through close({ seen: true }) — the phone tutorial prelude marks seen the
// moment it actually hands over to the scenario, whichever way it was closed.
export function markSeen() {
  try { localStorage.setItem(SEEN_KEY, '1'); } catch { }
}

// -- figures: inline SVG only, no assets and no build step ----------------

const FIG_PAN = `<svg viewBox="0 0 120 48" class="w-full h-12" aria-hidden="true">
  <rect x="2" y="4" width="116" height="40" rx="6" fill="none" stroke="currentColor" stroke-opacity="0.3"/>
  <path d="M22 24h76" stroke="#38bdf8" stroke-width="2" stroke-dasharray="5 4" class="ct-fig-dash"/>
  <circle cx="30" cy="24" r="7" fill="#38bdf8" fill-opacity="0.35" stroke="#38bdf8" stroke-width="2" class="ct-fig-slide"/>
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
// #mode-toggle buttons so step 6 reads correctly even when the live toggle
// is off-screen (it is display:none at ≥640px).
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
// { title, text, figure?, ring?, anchor?, practice? }
//   ring     — element id outlined with .ct-ring while the step is up
//              (skipped silently when the target is hidden)
//   anchor   — 'top' (default) or 'bottom'; step 1 anchors bottom so the
//              card can't cover the phone minimap it talks about
//   practice — (view, ui, st) => boolean, polled each frame; auto-advances.
//              Every step also keeps a working Next, so a device where the
//              gesture is awkward can never trap the player.

const PAN_MIN = 3;      // tiles the view centre must move
const ZOOM_IN = 1.3;    // scale ratio counted as a zoom
const ZOOM_OUT = 0.77;

const TOUCH_STEPS = [
  {
    title: 'Look around',
    text: 'Drag with one finger to pan the map. The minimap in the corner jumps you anywhere — tap it, or drag across it. Pan a little to continue.',
    figure: FIG_PAN,
    anchor: 'bottom',
    practice: (view, ui, st) => {
      if (!view) return true;
      if (!st.camStart) { st.camStart = { cx: view.cx, cy: view.cy }; return false; }
      return Math.hypot(view.cx - st.camStart.cx, view.cy - st.camStart.cy) >= PAN_MIN;
    },
  },
  {
    title: 'Zoom',
    text: 'Pinch with two fingers on the map to zoom in and out. Zoom in to read a fight, out to see your whole front. Try a pinch to continue.',
    figure: FIG_PINCH,
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
    figure: FIG_TAP,
    practice: (view, ui) => !!(ui && ui.selected && (ui.selected.kind === 'blob' || ui.selected.kind === 'multi')),
  },
  {
    title: 'Give orders',
    text: 'Tap your selection again to open its action list beside your finger: 📍 Move…, 🔥 Pillage, ✂️ Split, 🏠 Build, 🧱 Wall…, 🚚 Supply route… and the three roles. Orders that need a destination arm first — then you tap the map.',
    figure: FIG_TAP,
  },
  {
    title: 'Tapping with units in hand',
    text: 'A tap always asks before it acts. Empty ground offers Move / Attack / Deselect, so a stray tap never marches your army off. Your own settlement offers Select settlement / Garrison units. Founding a settlement or a wall shows a ✓ / ✕ pair you can pan the map under before you confirm.',
  },
  {
    title: 'Select vs Drag',
    text: 'The two icons in the bottom-left corner switch input modes. In Select mode taps do everything above. In Drag mode a one-finger drag draws a selection box that adds to your group — drag as many times as you like — while two-finger pan still works. Switching into Drag clears the current selection; orders resume in Select mode.',
    figure: FIG_MODES,
    ring: 'mode-toggle',
  },
  {
    title: 'Reading the screen',
    text: 'The selection panel is a bottom sheet on phones, with the per-unit health strip just above it and the minimap up in the top-right corner. Everything scrolls inside the sheet — the map behind it stays live.',
    figure: FIG_SHEET,
    ring: 'panel',
  },
  {
    title: 'Two shortcuts',
    text: 'Press and hold ✂️ Split, Recall or Field for about a third of a second, then slide left or right to pick a number and release to commit. And the numbered chips down the left edge are control groups: tap to select, tap again to centre, ＋ assigns whatever you have selected.',
    figure: FIG_HOLD,
    ring: 'groups-bar',
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

let st = null;     // { mode, set, idx, flashUntil, camStart, zoomStart } while open
let deps = null;   // { onClose } from main.js
let wired = false;
let ringEl = null;
const PULSE_MS = 1300; // keep in sync with the .tut-pulse / .ct-ring animation

function steps() { return st && st.set === 'desktop' ? DESK_STEPS : TOUCH_STEPS; }

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
  st.camStart = null;
  st.zoomStart = null;
  st.flashUntil = 0;
  render();
}

function wire() {
  if (wired) return;
  wired = true;
  $('ct-next').addEventListener('click', () => go(1));
  $('ct-back').addEventListener('click', () => go(-1));
  $('ct-skip').addEventListener('click', () => close({ seen: true }));
  $('ct-swap').addEventListener('click', () => {
    if (!st) return;
    st.set = st.set === 'desktop' ? 'touch' : 'desktop';
    st.idx = 0;
    st.camStart = null;
    st.zoomStart = null;
    st.flashUntil = 0;
    render();
  });
  $('ct-scrim').addEventListener('click', () => close({ seen: false }));
  window.addEventListener('keydown', (e) => {
    if (!st || st.mode === 'tour') return;
    if (e.code === 'Escape') close({ seen: false });
  });
}

// -- API ------------------------------------------------------------------

// open({ mode, set, step, force, finishLabel, skipLabel, onClose })
//   mode        'tour' (non-modal, over a live match) | 'reference' (modal card)
//   set         'touch' | 'desktop' — which page set to show
//   step        0-based starting index
//   force       screenshot deep links: ignore the seen flag / viewport width
//   finishLabel replaces '✓ Got it' on the last step
//   skipLabel   replaces 'Skip tour'
// The two labels are plain overrides on purpose: the caller (main.js's phone
// tutorial prelude) owns the wording, so this module needs to know nothing
// about tutorials.
export function open(opts) {
  const o = opts || {};
  wire();
  deps = { onClose: o.onClose || null };
  st = {
    mode: o.mode === 'reference' ? 'reference' : 'tour',
    set: o.set === 'desktop' ? 'desktop' : 'touch',
    idx: Math.max(0, o.step || 0),
    finishLabel: o.finishLabel || null,
    skipLabel: o.skipLabel || null,
    flashUntil: 0,
    camStart: null,
    zoomStart: null,
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

export function close(opts) {
  if (!st) return;
  const o = opts || {};
  if (o.seen) markSeen();
  const hid = st.hidTutBox;
  const cb = deps && deps.onClose;
  clearRing();
  st = null;
  deps = null;
  $('controls-tour').classList.add('hidden');
  if (hid) {
    const tbox = $('tutorial-box');
    if (tbox) tbox.classList.remove('hidden');
  }
  if (cb) cb();
}

export function active() { return !!st; }

// Called each frame from main.js's loop while the tour is open: polls the
// step's practice predicate (with a brief ✓ flash before advancing), and
// keeps the ring and the bottom-anchor offset current as the panel grows
// and shrinks underneath.
export function tick(view, ui) {
  if (!st) return;
  const now = performance.now();
  if (st.flashUntil) {
    if (now < st.flashUntil) return;
    st.flashUntil = 0;
    go(1);
    return;
  }
  syncAnchor();
  syncRing();
  if (st.mode !== 'tour') return;
  const step = steps()[st.idx];
  if (!step || !step.practice) return;
  if (step.practice(view, ui, st)) {
    st.flashUntil = now + 700;
    const t = $('ct-text');
    t.textContent = '✓ Nicely done!';
    t.classList.add('text-emerald-300');
  }
}
