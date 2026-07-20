// Attract mode: a real AI-vs-AI match rendered behind the main menu.
// Pure scenery — its own game object, renderer and rAF loop, never the
// module-level `game` in main.js, so autosave / result posting / HUD
// stay completely out of this path. Acquisition is snapshot-first: the
// server pre-simulates matches to a developed mid-game and serves one
// from /api/attract-snapshot; if that fails, we warm one up invisibly
// on the client and only then fade the canvas in.

import * as S from './sim.js';
import { aiTick } from './ai.js';
import { createRenderer } from './render.js';

const WARMUP_TICKS = 4500;   // mid-game seek target (matches attract-pool.js)
const FETCH_TIMEOUT = 2500;  // ms before we give up on the server snapshot
const WARMUP_BUDGET = 8;     // ms of sim per frame during invisible warm-up
const LINGER_MS = 6000;      // hold the final scene before restarting
const FADE_MS = 700;         // slightly past the CSS 600 ms transition
const ATTRACT_SCALE = 13.5;  // fixed zoom (px/tile); clampView may raise it on huge screens
const PAN_VX = 1.0;          // drift speed in tiles/s — unequal axes so the
const PAN_VY = 0.7;          // billiard-bounce path doesn't visibly retrace

const $ = (id) => document.getElementById(id);

// Frozen selection stub: covers every ui.* read in render.js so the
// renderer draws no selection chrome, pings or placement outlines.
const UI = Object.freeze({ selected: null, pending: null, ping: null, hover: null, buildSite: null });

let active = false;
let session = 0;          // bumped by stop(); async callbacks check it
let game = null, ai0 = null, ai1 = null;
let renderer = null;
let fetchCtl = null;
let warmupTarget = 0;     // >0 while the invisible client warm-up runs
let revealed = false;
let acc = 0, lastT = 0;
let endedAt = 0;          // performance.now() when game.result was first seen
let rafId = 0;

// camera
const view = { cx: 0, cy: 0, scale: ATTRACT_SCALE };
const vel = { x: 0, y: 0 }; // tiles/s, set at reveal()
let poi = null;

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function startAttract() {
  if (active) return;
  active = true;
  const sid = ++session;
  if (!renderer) renderer = createRenderer($('menu-canvas'), offscreenMinimap());
  renderer.resize(); // the canvas may have been display:none during a match
  acquire(sid);
  lastT = 0;
  rafId = requestAnimationFrame(frame);
}

export function stopAttract() {
  session++;
  active = false;
  if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
  if (fetchCtl) { fetchCtl.abort(); fetchCtl = null; }
  game = null; ai0 = null; ai1 = null;
  warmupTarget = 0; revealed = false; acc = 0; endedAt = 0;
  poi = null; vel.x = 0; vel.y = 0;
  $('menu-canvas').classList.remove('attract-visible');
}

// createRenderer requires a minimap context and paints it every frame;
// a small detached canvas keeps that cost negligible and invisible.
function offscreenMinimap() {
  const c = document.createElement('canvas');
  c.width = 144; c.height = 144;
  return c;
}

function freshAiState() {
  return { known: {}, lastExpand: 0, lastScout: 0, lastAttack: 0, attacking: false, armyId: null, scoutId: null, expand: null };
}

function randomSeed() { return Math.random().toString(36).slice(2, 10); }

// -- acquisition: server snapshot first, invisible warm-up as fallback --

async function acquire(sid) {
  try {
    fetchCtl = new AbortController();
    const timer = setTimeout(() => fetchCtl.abort(), FETCH_TIMEOUT);
    const res = await fetch('/api/attract-snapshot', { signal: fetchCtl.signal });
    clearTimeout(timer);
    if (sid !== session) return;
    if (res.ok) {
      const body = await res.json();
      if (sid !== session) return;
      const g = S.deserialize(body.snapshot);
      if (!g.result) {
        beginMatch(g, body.ai0);
        return;
      }
    }
  } catch { /* aborted, offline, 503, malformed — all fall back */ }
  if (sid !== session) return;
  beginWarmup();
}

function beginMatch(g, restoredAi0) {
  game = g;
  ai1 = g.ai;
  ai0 = restoredAi0 && restoredAi0.known ? restoredAi0 : freshAiState();
  warmupTarget = 0;
  reveal();
}

function beginWarmup() {
  game = S.newGame(randomSeed(), 'small', 'normal');
  ai1 = game.ai;
  ai0 = freshAiState();
  warmupTarget = WARMUP_TICKS;
}

function reveal() {
  game.fog.fill(2);
  game.events.length = 0;
  evalPoi();
  view.cx = poi.x; view.cy = poi.y; view.scale = ATTRACT_SCALE;
  clampView();
  // drift toward map center so the opening leg runs long before the first bounce
  vel.x = PAN_VX * (Math.sign(game.map.w / 2 - view.cx) || 1);
  vel.y = PAN_VY * (Math.sign(game.map.h / 2 - view.cy) || 1);
  revealed = true;
  acc = 0;
  renderer.draw(game, view, UI, 0);
  $('menu-canvas').classList.add('attract-visible');
  if (reducedMotion()) {
    // a still painting instead of animation — freeze here
    active = false;
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
  }
}

// -- loop ---------------------------------------------------------------

function stepOnce() {
  S.step(game);
  if (game.tick % 20 === 0) aiTick(game, S, 1, ai1);
  else if (game.tick % 20 === 10) aiTick(game, S, 0, ai0);
}

function frame(ts) {
  if (!active) return;
  rafId = requestAnimationFrame(frame);
  const dt = Math.min(100, ts - lastT || 16);
  lastT = ts;
  if (!game) return; // still fetching the snapshot

  if (warmupTarget > 0) {
    // invisible, frame-budgeted seek — nothing is drawn until we arrive
    const t0 = performance.now();
    while (game.tick < warmupTarget && !game.result && performance.now() - t0 < WARMUP_BUDGET) {
      stepOnce();
    }
    game.fog.fill(2); // spectator omniscience; also owner 0's pathing fog
    game.events.length = 0;
    if (game.result) { beginWarmup(); return; } // degenerate map — new seed
    if (game.tick >= warmupTarget) { warmupTarget = 0; reveal(); }
    return;
  }
  if (!revealed) return;

  if (game.result) {
    // one AI eliminated the other: linger on the final scene, then
    // fade out and acquire a fresh match
    if (!endedAt) endedAt = ts;
    if (ts - endedAt > LINGER_MS) { restart(); return; }
  } else {
    // 1× player speed: same dt × 0.5 accumulator as speed step 1 in main.js
    acc += dt * 0.5;
    let iter = 0;
    while (acc >= 100 && iter++ < 40) { stepOnce(); acc -= 100; }
    if (acc >= 100) acc = 0; // backlog from a hidden tab — drop it
    game.fog.fill(2);
    game.events.length = 0;
  }

  updateCamera(dt);
  renderer.draw(game, view, UI, Math.max(0, Math.min(1, acc / 100)));
}

function restart() {
  const sid = session;
  endedAt = 0;
  revealed = false;
  $('menu-canvas').classList.remove('attract-visible');
  const dead = game;
  game = null;
  setTimeout(() => {
    if (sid !== session || !active) return;
    void dead; // dropped for GC
    acquire(sid);
  }, FADE_MS);
}

// -- camera: fixed zoom, steady drift, billiard bounce at map edges -------

// Pick a good opening frame for reveal(): this tick's fight if there is
// one (combat holds engagement links: {kind:'bb', a, b} blob ids /
// {kind:'bs', b, s}), else the largest army, else map center.
function evalPoi() {
  if (game.combat && game.combat.length) {
    const l = game.combat[0];
    const ba = game.blobs.find(b => b.id === l.a && !b.dead);
    const bb = game.blobs.find(b => b.id === l.b && !b.dead);
    if (l.kind === 'bb' && ba && bb) { poi = { x: (ba.x + bb.x) / 2, y: (ba.y + bb.y) / 2 }; return; }
    if (l.kind === 'bs' && bb) { poi = { x: bb.x, y: bb.y }; return; }
  }
  let best = null;
  for (const b of game.blobs) {
    if (b.dead) continue;
    if (!best || b.count.deploy > best.count.deploy) best = b;
  }
  poi = best ? { x: best.x, y: best.y } : { x: game.map.w / 2, y: game.map.h / 2 };
}

function updateCamera(dt) {
  // an axis where the whole map fits on screen is pinned to center by
  // clampView — kill drift there instead of flip-flopping every frame
  const c = $('menu-canvas');
  const w = c.clientWidth || window.innerWidth;
  const h = c.clientHeight || window.innerHeight;
  if (game.map.w <= w / view.scale) vel.x = 0;
  if (game.map.h <= h / view.scale) vel.y = 0;
  view.cx += vel.x * (dt / 1000);
  view.cy += vel.y * (dt / 1000);
  const px = view.cx, py = view.cy;
  clampView();
  // clamping moved us: we hit an edge — reflect that axis
  if (view.cx !== px) vel.x = -vel.x;
  if (view.cy !== py) vel.y = -vel.y;
}

// Like input.js clampView, but stricter: scenery should never show
// off-map void, so keep the whole viewport inside the map on any axis
// where the map is larger than the screen (center it otherwise).
function clampView() {
  const c = $('menu-canvas');
  const w = c.clientWidth || window.innerWidth;
  const h = c.clientHeight || window.innerHeight;
  const minScale = Math.max(3, Math.min(w / game.map.w, h / game.map.h) * 0.9);
  view.scale = Math.max(minScale, Math.min(96, view.scale));
  const halfW = w / view.scale / 2, halfH = h / view.scale / 2;
  view.cx = game.map.w > halfW * 2
    ? Math.max(halfW, Math.min(game.map.w - halfW, view.cx))
    : game.map.w / 2;
  view.cy = game.map.h > halfH * 2
    ? Math.max(halfH, Math.min(game.map.h - halfH, view.cy))
    : game.map.h / 2;
}
