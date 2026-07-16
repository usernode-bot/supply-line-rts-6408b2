// Canvas rendering: pre-rendered terrain layer (patched from game.dirty),
// fog overlay with per-tile eased alpha at FOG_T px/tile, entities drawn
// at interpolated positions (alpha = fraction of the current sim tick),
// damage fx, supply lines, minimap.

import * as S from './sim.js';
import * as SUP from './supply.js';

const T = 16;     // terrain layer px per tile (drawn smoothed — kills shimmer)
const FOG_T = 4;  // fog layer px per tile (tighter edge gradient)

const OWNER_COLOR = ['#8b5cf6', '#ef4444'];
const OWNER_DARK = ['#4c1d95', '#7f1d1d'];

function lerp(a, b, t) { return a + (b - a) * t; }
function mix(c1, c2, t) {
  return [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];
}
const BARREN = [192, 172, 126], MID = [127, 160, 84], LUSH = [42, 110, 48];
const TILL = [217, 193, 79];

function tileRGB(game, i) {
  if (game.map.mountain[i]) {
    const v = 108 + ((i * 2654435761) % 24);
    return [v, v + 4, v + 10];
  }
  const f = game.map.fert[i];
  let c = f < 0.5 ? mix(BARREN, MID, f * 2) : mix(MID, LUSH, (f - 0.5) * 2);
  if (game.tilledBy[i]) c = mix(c, TILL, 0.45);
  return c;
}

function fogTarget(v) { return v === 2 ? 0 : v === 1 ? 150 : 255; }

export function createRenderer(canvas, minimap) {
  const ctx = canvas.getContext('2d');
  const mctx = minimap.getContext('2d');
  let terrain = null, tctx = null;
  let fogCanvas = null, fctx = null, fogData = null, fogAlpha = null;
  let mapRef = null;
  let dpr = 1, cssW = 0, cssH = 0;
  let lastFrameT = 0;

  function resize() {
    dpr = window.devicePixelRatio || 1;
    cssW = canvas.clientWidth || window.innerWidth;
    cssH = canvas.clientHeight || window.innerHeight;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
  }
  window.addEventListener('resize', resize);
  resize();

  function ensureLayers(game) {
    if (mapRef === game.map) return;
    mapRef = game.map;
    const { w, h } = game.map;
    terrain = document.createElement('canvas');
    terrain.width = w * T; terrain.height = h * T;
    tctx = terrain.getContext('2d');
    for (let i = 0; i < w * h; i++) paintTile(game, i);
    fogCanvas = document.createElement('canvas');
    fogCanvas.width = w * FOG_T; fogCanvas.height = h * FOG_T;
    fctx = fogCanvas.getContext('2d');
    fogData = fctx.createImageData(w * FOG_T, h * FOG_T);
    const d = fogData.data;
    for (let o = 0; o < d.length; o += 4) { d[o] = 5; d[o + 1] = 6; d[o + 2] = 10; }
    // seed alphas from the current fog so resumes don't fade in from black
    fogAlpha = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      fogAlpha[i] = fogTarget(game.fog[i]);
      writeFogBlock(game, i, fogAlpha[i]);
    }
    fctx.putImageData(fogData, 0, 0);
  }

  function writeFogBlock(game, i, a) {
    const w = game.map.w;
    const v = a | 0;
    const tx = (i % w) * FOG_T, ty = ((i / w) | 0) * FOG_T;
    const rowW = w * FOG_T;
    for (let yy = 0; yy < FOG_T; yy++) {
      let o = ((ty + yy) * rowW + tx) * 4 + 3;
      for (let xx = 0; xx < FOG_T; xx++, o += 4) fogData.data[o] = v;
    }
  }

  function paintTile(game, i) {
    const { w } = game.map;
    const [r, g, b] = tileRGB(game, i);
    tctx.fillStyle = `rgb(${r | 0},${g | 0},${b | 0})`;
    tctx.fillRect((i % w) * T, ((i / w) | 0) * T, T, T);
  }

  // Ease each tile's fog alpha toward its target so vision-circle edges
  // fade instead of blinking as blobs move.
  function updateFog(game, dt) {
    const fog = game.fog;
    const k = Math.min(1, dt / 120);
    let changed = false;
    for (let i = 0; i < fog.length; i++) {
      const t = fogTarget(fog[i]);
      let a = fogAlpha[i];
      if (a === t) continue;
      a += (t - a) * k;
      if (Math.abs(t - a) < 1) a = t;
      if ((a | 0) !== (fogAlpha[i] | 0)) { writeFogBlock(game, i, a); changed = true; }
      fogAlpha[i] = a;
    }
    if (changed) fctx.putImageData(fogData, 0, 0);
  }

  function draw(game, view, ui, alpha) {
    if (alpha == null) alpha = 1;
    ensureLayers(game);
    for (const i of game.dirty) paintTile(game, i);
    game.dirty.clear();
    const now = performance.now();
    const dt = Math.min(100, now - lastFrameT || 16);
    lastFrameT = now;
    updateFog(game, dt);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#05060a';
    ctx.fillRect(0, 0, cssW, cssH);

    const s = view.scale;
    // snap the map origin to whole device pixels so terrain and fog land
    // on the same grid frame-to-frame (no crawling edges while panning)
    const ox = Math.round((cssW / 2 - view.cx * s) * dpr) / dpr;
    const oy = Math.round((cssH / 2 - view.cy * s) * dpr) / dpr;
    const wx = x => x * s + ox;
    const wy = y => y * s + oy;
    // interpolated blob position for smooth motion between sim ticks
    const bx = b => lerp(b.prevX != null ? b.prevX : b.x, b.x, alpha);
    const by = b => lerp(b.prevY != null ? b.prevY : b.y, b.y, alpha);

    // terrain (high-res layer drawn smoothed — no nearest-neighbour shimmer)
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(terrain, ox, oy, game.map.w * s, game.map.h * s);

    // supply routes (under entities)
    for (const r of game.routes) {
      const src = SUP.routeSource(game, r);
      const tgt = SUP.routeTarget(game, r);
      if (!src || !tgt) continue;
      const tp = r.targetKind === 'blob' ? { x: bx(tgt), y: by(tgt) } : { x: tgt.x + 0.5, y: tgt.y + 0.5 };
      if (r.owner === 1) {
        const seen = S.isVisible(game, src.x, src.y) || S.isVisible(game, tp.x, tp.y);
        if (!seen) continue;
      }
      const health = SUP.routeHealth(game, r);
      ctx.strokeStyle = health >= 0.9 ? 'rgba(74,222,128,0.8)'
        : health >= 0.5 ? 'rgba(251,191,36,0.8)' : 'rgba(248,113,113,0.85)';
      ctx.lineWidth = 2;
      ctx.setLineDash(r.owner === 1 ? [6, 5] : [10, 4]);
      ctx.beginPath();
      ctx.moveTo(wx(src.x + 0.5), wy(src.y + 0.5));
      ctx.lineTo(wx(tp.x), wy(tp.y));
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // selected blob path
    if (ui.selected && ui.selected.kind === 'blob') {
      const b = game.blobs.find(x => x.id === ui.selected.id && !x.dead);
      if (b && b.path && b.path.length) {
        ctx.strokeStyle = 'rgba(255,255,255,0.35)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(wx(bx(b)), wy(by(b)));
        for (const p of b.path) ctx.lineTo(wx(p.x), wy(p.y));
        ctx.stroke();
      }
    }

    // ghost settlements (remembered but not visible)
    for (const [id, k] of Object.entries(game.known)) {
      if (S.isVisible(game, k.x + 0.5, k.y + 0.5)) continue;
      drawSettlement(game, { x: k.x, y: k.y, owner: 1, hp: S.C.SETT_HP }, wx, wy, s, true, false);
    }

    // settlements
    for (const st of game.settlements) {
      if (st.owner === 1 && !S.isVisible(game, st.x + 0.5, st.y + 0.5)) continue;
      const sel = ui.selected && ui.selected.kind === 'settlement' && ui.selected.id === st.id;
      drawSettlement(game, st, wx, wy, s, false, sel);
    }

    // garrisoned farmers working the tilled land around their settlement
    if (s >= 8) {
      for (const st of game.settlements) {
        if (st.garrison.farm <= 0 || !st.tilled || !st.tilled.length) continue;
        if (st.owner === 1 && !S.isVisible(game, st.x + 0.5, st.y + 0.5)) continue;
        drawFarmers(game, st, wx, wy, s, alpha);
      }
    }

    // blobs
    for (const b of game.blobs) {
      if (b.dead) continue;
      if (b.owner === 1 && !S.isVisible(game, b.x, b.y)) continue;
      const r = Math.max(10, S.blobRadius(b) * s);
      const px = wx(bx(b)), py = wy(by(b));
      const isSupply = b.count.supply > 0 && b.count.deploy === 0 && b.count.farm === 0;
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fillStyle = OWNER_COLOR[b.owner];
      ctx.globalAlpha = isSupply ? 0.75 : 0.92;
      ctx.fill();
      ctx.globalAlpha = 1;
      // fed-state ring
      const m = S.fedMeter(b);
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = m >= 0.75 ? '#4ade80' : m >= 0.5 ? '#a3e635' : m >= 0.25 ? '#fbbf24' : '#f87171';
      ctx.stroke();
      // taking-damage flash
      if (game.tick - b.engagedT < 3) {
        const pulse = 0.55 + 0.45 * Math.sin((game.tick + alpha) * 2.2);
        ctx.beginPath();
        ctx.arc(px, py, r + 3, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(248,113,113,${pulse.toFixed(2)})`;
        ctx.lineWidth = 3;
        ctx.stroke();
      }
      if (ui.selected && ui.selected.kind === 'blob' && ui.selected.id === b.id) {
        ctx.beginPath();
        ctx.arc(px, py, r + 4, 0, Math.PI * 2);
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      // role marker
      if (isSupply) {
        ctx.fillStyle = '#fff';
        ctx.font = `${Math.max(9, r * 0.7)}px system-ui`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('⇄', px, py - r * 0.05);
      } else if (b.count.farm > 0 && b.count.deploy === 0) {
        ctx.fillStyle = '#bbf7d0';
        ctx.font = `${Math.max(9, r * 0.7)}px system-ui`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('🌱', px, py);
      }
      // count
      ctx.fillStyle = '#fff';
      ctx.font = `bold ${Math.max(10, Math.min(16, r * 0.8))}px system-ui`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      if (!isSupply && !(b.count.farm > 0 && b.count.deploy === 0)) {
        ctx.fillText(String(S.total(b)), px, py);
      } else {
        ctx.font = `bold ${Math.max(9, Math.min(13, r * 0.6))}px system-ui`;
        ctx.fillText(String(S.total(b)), px, py + r * 0.55);
      }
      if (b.pillaging) {
        ctx.font = `${Math.max(10, r * 0.6)}px system-ui`;
        ctx.fillText('🔥', px + r * 0.9, py - r * 0.9);
      }
    }

    // floating damage numbers
    if (game.fx && game.fx.length) {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (const f of game.fx) {
        const age = game.tick - f.t + alpha;
        if (age < 0 || age > 12) continue;
        if (!S.isVisible(game, f.x, f.y)) continue;
        const fade = Math.max(0, 1 - age / 12);
        ctx.fillStyle = `rgba(248,113,113,${fade.toFixed(2)})`;
        ctx.font = `bold ${Math.max(11, Math.min(16, s * 0.9))}px system-ui`;
        ctx.fillText(`−${f.n}`, wx(f.x), wy(f.y) - s * 0.6 - age * s * 0.09);
      }
    }

    // fog on top
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(fogCanvas, ox, oy, game.map.w * s, game.map.h * s);

    drawMinimap(game, view);
  }

  function drawFarmers(game, st, wx, wy, s, alpha) {
    const w = game.map.w;
    const n = Math.min(st.garrison.farm, st.tilled.length);
    const t = game.tick + alpha;
    for (let k = 0; k < n; k++) {
      const i = st.tilled[(k * 7 + st.id) % st.tilled.length];
      const h = (i * 31 + k * 137 + st.id * 17) >>> 0;
      const cx = (i % w) + 0.22 + 0.56 * ((h % 13) / 13);
      const cy = ((i / w) | 0) + 0.22 + 0.56 * (((h >> 4) % 13) / 13);
      const bob = Math.abs(Math.sin(t * 0.14 + k * 1.7)) * 0.1;
      const px = wx(cx), py = wy(cy - bob);
      const r = Math.max(1.5, s * 0.12);
      // body
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fillStyle = st.owner === 0 ? '#166534' : '#7f1d1d';
      ctx.fill();
      // head
      ctx.beginPath();
      ctx.arc(px, py - r * 1.1, r * 0.55, 0, Math.PI * 2);
      ctx.fillStyle = st.owner === 0 ? '#86efac' : '#fca5a5';
      ctx.fill();
    }
  }

  function drawSettlement(game, st, wx, wy, s, ghost, sel) {
    const px = wx(st.x + 0.5), py = wy(st.y + 0.5);
    const half = Math.max(8, 0.85 * s);
    const hit = !ghost && st.lastHitT != null && game.tick - st.lastHitT < 3;
    ctx.globalAlpha = ghost ? 0.4 : 1;
    ctx.fillStyle = OWNER_DARK[st.owner];
    ctx.strokeStyle = hit ? '#f87171' : sel ? '#ffffff' : OWNER_COLOR[st.owner];
    ctx.lineWidth = sel || hit ? 3 : 2;
    ctx.beginPath();
    ctx.rect(px - half, py - half * 0.7, half * 2, half * 1.5);
    ctx.fill(); ctx.stroke();
    // roof
    ctx.beginPath();
    ctx.moveTo(px - half * 1.15, py - half * 0.7);
    ctx.lineTo(px, py - half * 1.5);
    ctx.lineTo(px + half * 1.15, py - half * 0.7);
    ctx.closePath();
    ctx.fillStyle = hit ? '#f87171' : OWNER_COLOR[st.owner];
    ctx.fill();
    let barY = py + half * 0.95;
    if (!ghost && st.hp < S.C.SETT_HP) {
      ctx.fillStyle = '#111827';
      ctx.fillRect(px - half, barY, half * 2, 4);
      ctx.fillStyle = '#f87171';
      ctx.fillRect(px - half, barY, half * 2 * (st.hp / S.C.SETT_HP), 4);
      barY += 5;
    }
    // production progress (own settlements only)
    if (!ghost && st.owner === 0 && st.trainTicks > 0) {
      ctx.fillStyle = '#111827';
      ctx.fillRect(px - half, barY, half * 2, 3);
      ctx.fillStyle = '#fbbf24';
      ctx.fillRect(px - half, barY, half * 2 * (st.trainTicks / S.C.TRAIN_TICKS), 3);
    }
    ctx.globalAlpha = 1;
  }

  function drawMinimap(game, view) {
    const mw = minimap.width, mh = minimap.height;
    mctx.imageSmoothingEnabled = false;
    mctx.clearRect(0, 0, mw, mh);
    mctx.drawImage(terrain, 0, 0, mw, mh);
    mctx.drawImage(fogCanvas, 0, 0, mw, mh);
    const sx = mw / game.map.w, sy = mh / game.map.h;
    for (const st of game.settlements) {
      if (st.owner === 1 && !S.isVisible(game, st.x + 0.5, st.y + 0.5)) continue;
      mctx.fillStyle = OWNER_COLOR[st.owner];
      mctx.fillRect(st.x * sx - 2, st.y * sy - 2, 5, 5);
    }
    for (const k of Object.values(game.known)) {
      mctx.fillStyle = 'rgba(239,68,68,0.5)';
      mctx.fillRect(k.x * sx - 2, k.y * sy - 2, 5, 5);
    }
    for (const b of game.blobs) {
      if (b.dead) continue;
      if (b.owner === 1 && !S.isVisible(game, b.x, b.y)) continue;
      mctx.fillStyle = OWNER_COLOR[b.owner];
      mctx.fillRect(b.x * sx - 1, b.y * sy - 1, 3, 3);
    }
    // view rectangle
    const vw = (canvas.clientWidth / view.scale) * sx;
    const vh = (canvas.clientHeight / view.scale) * sy;
    mctx.strokeStyle = 'rgba(255,255,255,0.7)';
    mctx.lineWidth = 1;
    mctx.strokeRect(view.cx * sx - vw / 2, view.cy * sy - vh / 2, vw, vh);
  }

  return { draw, resize, get cssSize() { return { w: cssW, h: cssH }; } };
}
