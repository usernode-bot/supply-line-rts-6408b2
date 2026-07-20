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
const ATTRACT_SCALE = 32;    // fixed zoom (px/tile) — close enough that blobs and
                             // settlements read as the subject, not map texture (#119)
const PAN_SPEED = 2.6;       // cruise speed in tiles/s while gliding between POIs
const PAN_RAMP_MS = 1400;    // ease-in time from a standstill to cruise speed
const DWELL_MS = 5000;       // hold on a POI (soft-following it if it marches) before moving on
const HOP_MIN = 6;           // preferred next-POI distance band (tiles) — far enough
const HOP_MAX = 60;          // to feel like a pan, near enough to arrive within ~20 s

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

// camera: tours points of interest (settlements, armies, fights)
const view = { cx: 0, cy: 0, scale: ATTRACT_SCALE };
let poi = null;           // { kind: 'combat'|'army'|'sett'|'center', ref, x, y }
let camMode = 'dwell';    // 'travel' (gliding to poi) | 'dwell' (holding on it)
let dwellUntil = 0;       // ts when the current dwell ends
let travelT = 0;          // ms spent on the current glide, for the ease-in ramp

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
  poi = null; camMode = 'dwell'; dwellUntil = 0; travelT = 0;
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
  poi = openingPoi();
  view.cx = poi.x; view.cy = poi.y; view.scale = ATTRACT_SCALE;
  clampView();
  camMode = 'dwell';
  dwellUntil = performance.now() + DWELL_MS;
  travelT = 0;
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

  updateCamera(dt, ts);
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

// -- camera: close zoom, slow glide between points of interest ------------
//
// The camera tours the match like a spectator: glide to a settlement,
// army or fight, hold on it for DWELL_MS (soft-following it if it
// marches), then pick the next stop and glide again. Fights always win
// the pick; otherwise it's a random settlement/army a medium hop away.

// Everything worth looking at right now. Combat entries come from the
// engagement links ({kind:'bb', a, b} blob ids / {kind:'bs', b, s}).
function gatherPois() {
  const out = [];
  if (game.combat) {
    for (const l of game.combat) {
      const ba = game.blobs.find(b => b.id === l.a && !b.dead);
      const bb = game.blobs.find(b => b.id === l.b && !b.dead);
      if (l.kind === 'bb' && ba && bb) out.push({ kind: 'combat', ref: bb, x: (ba.x + bb.x) / 2, y: (ba.y + bb.y) / 2 });
      else if (l.kind === 'bs' && bb) out.push({ kind: 'combat', ref: bb, x: bb.x, y: bb.y });
    }
  }
  for (const b of game.blobs) {
    if (!b.dead && b.count.deploy >= 2) out.push({ kind: 'army', ref: b, x: b.x, y: b.y });
  }
  for (const s of game.settlements) {
    const c = S.settCenter(s);
    out.push({ kind: 'sett', ref: s, x: c.x, y: c.y });
  }
  return out;
}

// Opening frame for reveal(): a fight if one is on, else the largest army.
function openingPoi() {
  const pois = gatherPois();
  const fight = pois.find(p => p.kind === 'combat');
  if (fight) return fight;
  let best = null;
  for (const p of pois) {
    if (p.kind !== 'army') continue;
    if (!best || p.ref.count.deploy > best.ref.count.deploy) best = p;
  }
  return best || pois[0] || { kind: 'center', ref: null, x: game.map.w / 2, y: game.map.h / 2 };
}

// Next tour stop: any fight beats everything; otherwise a random
// settlement/army in the HOP_MIN..HOP_MAX band (a visible pan that still
// arrives promptly), widening to anything else if the band is empty.
function nextPoi() {
  const pois = gatherPois();
  const fights = pois.filter(p => p.kind === 'combat' && p.ref !== (poi && poi.ref));
  if (fights.length) return fights[(Math.random() * fights.length) | 0];
  const others = pois.filter(p => p.kind !== 'combat' && p.ref !== (poi && poi.ref));
  const banded = others.filter(p => {
    const d = Math.hypot(p.x - view.cx, p.y - view.cy);
    return d >= HOP_MIN && d <= HOP_MAX;
  });
  const pool = banded.length ? banded : others;
  if (pool.length) return pool[(Math.random() * pool.length) | 0];
  return poi || { kind: 'center', ref: null, x: game.map.w / 2, y: game.map.h / 2 };
}

// Is the current poi's subject still in the game?
function poiAlive() {
  if (!poi || !poi.ref) return !!poi;
  if (poi.kind === 'sett') return game.settlements.includes(poi.ref);
  return !poi.ref.dead;
}

// Keep a moving subject's coordinates fresh (armies march, fights drift).
function refreshPoi() {
  if (!poi || !poi.ref) return;
  if (poi.kind === 'sett') return; // settlements don't move
  poi.x = poi.ref.x; poi.y = poi.ref.y;
}

function updateCamera(dt, ts) {
  if (!poiAlive()) { poi = nextPoi(); camMode = 'travel'; travelT = 0; }
  refreshPoi();
  // head for where the camera can actually center — a poi hugging the
  // map edge is unreachable past the clamp, so aim at the clamped spot
  const t = clampPoint(poi.x, poi.y);
  const dx = t.x - view.cx, dy = t.y - view.cy;
  const d = Math.hypot(dx, dy);
  if (camMode === 'travel') {
    travelT += dt;
    if (d < 0.3) {
      camMode = 'dwell';
      dwellUntil = ts + DWELL_MS;
    } else {
      // ease in from a standstill, cruise, ease out on approach
      const ramp = Math.min(1, travelT / PAN_RAMP_MS);
      const speed = Math.min(PAN_SPEED * ramp, Math.max(0.5, d * 1.2));
      const step = Math.min(d, speed * (dt / 1000));
      view.cx += (dx / d) * step;
      view.cy += (dy / d) * step;
    }
  } else {
    // dwell: soft-follow the subject so a marching army stays framed
    const k = 1 - Math.exp(-dt / 500);
    view.cx += dx * k;
    view.cy += dy * k;
    if (ts >= dwellUntil) { poi = nextPoi(); camMode = 'travel'; travelT = 0; }
  }
  clampView();
}

// The nearest point to (x, y) the camera center can reach under clampView.
function clampPoint(x, y) {
  const c = $('menu-canvas');
  const w = c.clientWidth || window.innerWidth;
  const h = c.clientHeight || window.innerHeight;
  const halfW = w / view.scale / 2, halfH = h / view.scale / 2;
  return {
    x: game.map.w > halfW * 2 ? Math.max(halfW, Math.min(game.map.w - halfW, x)) : game.map.w / 2,
    y: game.map.h > halfH * 2 ? Math.max(halfH, Math.min(game.map.h - halfH, y)) : game.map.h / 2,
  };
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
  const p = clampPoint(view.cx, view.cy);
  view.cx = p.x; view.cy = p.y;
}
