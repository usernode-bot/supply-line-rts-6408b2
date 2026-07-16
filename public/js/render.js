// Canvas rendering: pre-rendered terrain layer (patched from game.dirty),
// fog overlay at tile resolution, entities, supply lines, minimap.

import * as S from './sim.js';
import * as SUP from './supply.js';

const T = 8; // terrain layer px per tile

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

export function createRenderer(canvas, minimap) {
  const ctx = canvas.getContext('2d');
  const mctx = minimap.getContext('2d');
  let terrain = null, tctx = null;
  let fogCanvas = null, fctx = null, fogData = null, lastFogStamp = -1;
  let mapRef = null;
  let dpr = 1, cssW = 0, cssH = 0;

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
    fogCanvas.width = w; fogCanvas.height = h;
    fctx = fogCanvas.getContext('2d');
    fogData = fctx.createImageData(w, h);
    lastFogStamp = -1;
  }

  function paintTile(game, i) {
    const { w } = game.map;
    const [r, g, b] = tileRGB(game, i);
    tctx.fillStyle = `rgb(${r | 0},${g | 0},${b | 0})`;
    tctx.fillRect((i % w) * T, ((i / w) | 0) * T, T, T);
  }

  function updateFog(game) {
    if (game.tick === lastFogStamp) return;
    lastFogStamp = game.tick;
    const fog = game.fog, d = fogData.data;
    for (let i = 0; i < fog.length; i++) {
      const o = i * 4;
      d[o] = 5; d[o + 1] = 6; d[o + 2] = 10;
      d[o + 3] = fog[i] === 2 ? 0 : fog[i] === 1 ? 150 : 255;
    }
    fctx.putImageData(fogData, 0, 0);
  }

  function draw(game, view, ui) {
    ensureLayers(game);
    for (const i of game.dirty) paintTile(game, i);
    game.dirty.clear();
    updateFog(game);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#05060a';
    ctx.fillRect(0, 0, cssW, cssH);

    const s = view.scale;
    const ox = cssW / 2 - view.cx * s;
    const oy = cssH / 2 - view.cy * s;
    const wx = x => x * s + ox;
    const wy = y => y * s + oy;

    // terrain
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(terrain, ox, oy, game.map.w * s, game.map.h * s);

    // supply routes (under entities)
    for (const r of game.routes) {
      const src = SUP.routeSource(game, r);
      const tgt = SUP.routeTarget(game, r);
      if (!src || !tgt) continue;
      const tp = r.targetKind === 'blob' ? { x: tgt.x, y: tgt.y } : { x: tgt.x + 0.5, y: tgt.y + 0.5 };
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
        ctx.moveTo(wx(b.x), wy(b.y));
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

    // blobs
    for (const b of game.blobs) {
      if (b.dead) continue;
      if (b.owner === 1 && !S.isVisible(game, b.x, b.y)) continue;
      const r = Math.max(10, S.blobRadius(b) * s);
      const px = wx(b.x), py = wy(b.y);
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

    // fog on top
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(fogCanvas, ox, oy, game.map.w * s, game.map.h * s);

    drawMinimap(game, view);
  }

  function drawSettlement(game, st, wx, wy, s, ghost, sel) {
    const px = wx(st.x + 0.5), py = wy(st.y + 0.5);
    const half = Math.max(8, 0.85 * s);
    ctx.globalAlpha = ghost ? 0.4 : 1;
    ctx.fillStyle = OWNER_DARK[st.owner];
    ctx.strokeStyle = sel ? '#ffffff' : OWNER_COLOR[st.owner];
    ctx.lineWidth = sel ? 3 : 2;
    ctx.beginPath();
    ctx.rect(px - half, py - half * 0.7, half * 2, half * 1.5);
    ctx.fill(); ctx.stroke();
    // roof
    ctx.beginPath();
    ctx.moveTo(px - half * 1.15, py - half * 0.7);
    ctx.lineTo(px, py - half * 1.5);
    ctx.lineTo(px + half * 1.15, py - half * 0.7);
    ctx.closePath();
    ctx.fillStyle = OWNER_COLOR[st.owner];
    ctx.fill();
    if (!ghost && st.hp < S.C.SETT_HP) {
      ctx.fillStyle = '#111827';
      ctx.fillRect(px - half, py + half * 0.95, half * 2, 4);
      ctx.fillStyle = '#f87171';
      ctx.fillRect(px - half, py + half * 0.95, half * 2 * (st.hp / S.C.SETT_HP), 4);
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
