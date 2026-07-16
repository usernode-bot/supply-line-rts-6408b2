// Canvas rendering: pre-rendered terrain layer (patched from game.dirty),
// fog overlay with per-tile eased alpha at FOG_T px/tile, entities drawn
// at interpolated positions (alpha = fraction of the current sim tick),
// damage fx, supply lines, minimap.

import * as S from './sim.js';
import * as SUP from './supply.js';
import { fertTier } from './mapgen.js';

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
  // five flat shades, one per fertility tier
  const f = fertTier(game.map.fert[i]) / 4;
  let c = f < 0.5 ? mix(BARREN, MID, f * 2) : mix(MID, LUSH, (f - 0.5) * 2);
  if (game.tilledBy[i]) c = mix(c, TILL, 0.45);
  return c;
}

function fogTarget(v) { return v === 2 ? 0 : v === 1 ? 150 : 255; }

// Grid-aligned territory outline: the border edges of the disc of tiles
// whose centers lie within TERRITORY of a settlement's center, as segment
// endpoints in tile offsets from the settlement's tile. Computed once —
// the shape is identical for every settlement.
const TERRITORY_EDGES = (() => {
  const R = S.C.TERRITORY;
  const inSet = (dx, dy) => dx * dx + dy * dy <= R * R;
  const segs = [];
  for (let dy = -R; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      if (!inSet(dx, dy)) continue;
      if (!inSet(dx, dy - 1)) segs.push([dx, dy, dx + 1, dy]);
      if (!inSet(dx, dy + 1)) segs.push([dx, dy + 1, dx + 1, dy + 1]);
      if (!inSet(dx - 1, dy)) segs.push([dx, dy, dx, dy + 1]);
      if (!inSet(dx + 1, dy)) segs.push([dx + 1, dy, dx + 1, dy + 1]);
    }
  }
  return segs;
})();

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

    // territory borders — armies inside get fed from the stockpile.
    // Solid, team-coloured, grid-aligned outlines (not circles).
    function strokeTerritory(px0, py0) {
      ctx.beginPath();
      for (const [ax, ay, ex, ey] of TERRITORY_EDGES) {
        ctx.moveTo(wx(px0 + ax), wy(py0 + ay));
        ctx.lineTo(wx(px0 + ex), wy(py0 + ey));
      }
      ctx.stroke();
    }
    ctx.lineWidth = 2;
    for (const st of game.settlements) {
      if (st.owner === 1 && !S.isVisible(game, st.x + 0.5, st.y + 0.5)) continue;
      ctx.strokeStyle = OWNER_COLOR[st.owner];
      ctx.globalAlpha = 0.55;
      strokeTerritory(st.x, st.y);
    }
    for (const k of Object.values(game.known)) {
      if (S.isVisible(game, k.x + 0.5, k.y + 0.5)) continue;
      ctx.strokeStyle = OWNER_COLOR[1];
      ctx.globalAlpha = 0.25;
      strokeTerritory(k.x, k.y);
    }
    ctx.globalAlpha = 1;

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
      const gsel = ui.selected && ui.selected.kind === 'enemy-settlement' && ui.selected.id === +id;
      drawSettlement(game, { x: k.x, y: k.y, owner: 1, hp: S.C.SETT_HP }, wx, wy, s, true, gsel, 0);
    }

    // working farmers — drawn before settlements so they can never cover
    // the garrison readouts
    for (const b of game.blobs) {
      if (b.dead || b.working == null) continue;
      if (b.owner === 1 && !S.isVisible(game, b.x, b.y)) continue;
      drawWorkingFarmer(game, b, wx, wy, s, alpha, ui);
    }

    // settlements (with per-settlement working-farmer totals, one sweep)
    const workingBy = new Map();
    for (const b of game.blobs) {
      if (!b.dead && b.working != null) workingBy.set(b.working, (workingBy.get(b.working) || 0) + S.total(b));
    }
    for (const st of game.settlements) {
      if (st.owner === 1 && !S.isVisible(game, st.x + 0.5, st.y + 0.5)) continue;
      const sel = ui.selected && (ui.selected.kind === 'settlement' || ui.selected.kind === 'enemy-settlement') && ui.selected.id === st.id;
      drawSettlement(game, st, wx, wy, s, false, sel, workingBy.get(st.id) || 0);
    }

    // blobs
    for (const b of game.blobs) {
      if (b.dead || b.working != null) continue;
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
      if (ui.selected && (ui.selected.kind === 'blob' || ui.selected.kind === 'enemy-blob') && ui.selected.id === b.id) {
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

    // pillage-target grid: outline the exact cells each pillaging army is
    // stripping — the same cell set the sim harvests from. Drawn above the
    // blobs (their circles cover the cells at most zoom levels): a bright
    // boundary around the group, faint interior grid lines.
    for (const b of game.blobs) {
      if (b.dead || !b.pillaging) continue;
      if (b.owner === 1 && !S.isVisible(game, b.x, b.y)) continue;
      const cells = S.pillageCells(game, b);
      const set = new Set(cells);
      const w = game.map.w;
      ctx.strokeStyle = 'rgba(251,146,60,0.4)';
      ctx.lineWidth = 1;
      for (const i of cells) {
        const tx = i % w, ty = (i / w) | 0;
        ctx.strokeRect(wx(tx), wy(ty), s, s);
      }
      ctx.strokeStyle = 'rgba(251,146,60,0.9)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (const i of cells) {
        const tx = i % w, ty = (i / w) | 0;
        if (!(ty > 0 && set.has(i - w))) { ctx.moveTo(wx(tx), wy(ty)); ctx.lineTo(wx(tx + 1), wy(ty)); }
        if (!(ty < game.map.h - 1 && set.has(i + w))) { ctx.moveTo(wx(tx), wy(ty + 1)); ctx.lineTo(wx(tx + 1), wy(ty + 1)); }
        if (!(tx > 0 && set.has(i - 1))) { ctx.moveTo(wx(tx), wy(ty)); ctx.lineTo(wx(tx), wy(ty + 1)); }
        if (!(tx < w - 1 && set.has(i + 1))) { ctx.moveTo(wx(tx + 1), wy(ty)); ctx.lineTo(wx(tx + 1), wy(ty + 1)); }
      }
      ctx.stroke();
    }

    // combat links: chase/targeting lines while attack-movers close in,
    // ⚔️ markers on engaged pairs, siege lines onto settlements. Drawn
    // above the unit circles, below damage numbers and fog. Fog rule is
    // per-entity, same as when drawing the entities themselves — a link
    // never reveals a fogged unit.
    {
      const blobById = new Map();
      for (const b of game.blobs) if (!b.dead) blobById.set(b.id, b);
      const settById = new Map();
      for (const st of game.settlements) settById.set(st.id, st);
      const blobSeen = b => b.owner !== 1 || S.isVisible(game, b.x, b.y);
      const settSeen = st => st.owner !== 1 || S.isVisible(game, st.x + 0.5, st.y + 0.5);
      const blobPxR = b => b.working != null ? Math.max(2, s * 0.13) * 2 : Math.max(10, S.blobRadius(b) * s);
      const pulse = 0.55 + 0.45 * Math.sin((game.tick + alpha) * 2.2);
      const arrowAt = (x, y, ang, size) => {
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x - Math.cos(ang - 0.45) * size, y - Math.sin(ang - 0.45) * size);
        ctx.lineTo(x - Math.cos(ang + 0.45) * size, y - Math.sin(ang + 0.45) * size);
        ctx.closePath();
        ctx.fill();
      };

      // chase/targeting: attack-movers locked onto an enemy, not yet in contact
      const arrows = [], reticles = [];
      ctx.strokeStyle = 'rgba(248,113,113,0.8)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([2, 4]);
      ctx.beginPath();
      for (const b of game.blobs) {
        if (b.dead || !b.order || b.order.type !== 'attack' || b.chaseId == null) continue;
        const t = blobById.get(b.chaseId);
        if (!t || !blobSeen(b) || !blobSeen(t)) continue;
        if (Math.hypot(t.x - b.x, t.y - b.y) <= S.blobRadius(b) + S.blobRadius(t) + 0.2) continue;
        const x1 = wx(bx(b)), y1 = wy(by(b)), x2 = wx(bx(t)), y2 = wy(by(t));
        const ang = Math.atan2(y2 - y1, x2 - x1);
        const r1 = blobPxR(b), r2 = blobPxR(t);
        const ex = x2 - Math.cos(ang) * (r2 + 2), ey = y2 - Math.sin(ang) * (r2 + 2);
        ctx.moveTo(x1 + Math.cos(ang) * r1, y1 + Math.sin(ang) * r1);
        ctx.lineTo(ex, ey);
        arrows.push([ex, ey, ang]);
        reticles.push([x2, y2, r2 + 5]);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(248,113,113,0.8)';
      for (const [ax, ay, ang] of arrows) arrowAt(ax, ay, ang, 5);
      // corner-bracket reticle on each chased target
      ctx.strokeStyle = 'rgba(248,113,113,0.7)';
      ctx.beginPath();
      for (const [cx2, cy2, rr] of reticles) {
        for (let q = 0; q < 4; q++) {
          const a0 = q * Math.PI / 2 + Math.PI / 4 - 0.35;
          ctx.moveTo(cx2 + Math.cos(a0) * rr, cy2 + Math.sin(a0) * rr);
          ctx.arc(cx2, cy2, rr, a0, a0 + 0.7);
        }
      }
      ctx.stroke();

      // engaged blob pairs: bright pulsing link + ⚔️ at the midpoint
      const swords = [];
      ctx.strokeStyle = `rgba(248,113,113,${pulse.toFixed(2)})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (const l of game.combat || []) {
        if (l.kind !== 'bb') continue;
        const a = blobById.get(l.a), b = blobById.get(l.b);
        if (!a || !b || !blobSeen(a) || !blobSeen(b)) continue;
        const x1 = wx(bx(a)), y1 = wy(by(a)), x2 = wx(bx(b)), y2 = wy(by(b));
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        swords.push([(x1 + x2) / 2, (y1 + y2) / 2]);
      }
      ctx.stroke();
      if (swords.length) {
        ctx.globalAlpha = pulse;
        ctx.font = `${Math.max(11, s * 0.7)}px system-ui`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        for (const [mx, my] of swords) ctx.fillText('⚔️', mx, my);
        ctx.globalAlpha = 1;
      }

      // sieges: solid line from attacker edge to the settlement's box edge
      const half = Math.max(8, 0.85 * s);
      ctx.strokeStyle = 'rgba(248,113,113,0.85)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      arrows.length = 0;
      for (const l of game.combat || []) {
        if (l.kind !== 'bs') continue;
        const b = blobById.get(l.b), st = settById.get(l.s);
        if (!b || !st || !blobSeen(b) || !settSeen(st)) continue;
        const x1 = wx(bx(b)), y1 = wy(by(b)), x2 = wx(st.x + 0.5), y2 = wy(st.y + 0.5);
        const ang = Math.atan2(y2 - y1, x2 - x1);
        const ex = x2 - Math.cos(ang) * (half + 3), ey = y2 - Math.sin(ang) * (half + 3);
        ctx.moveTo(x1 + Math.cos(ang) * blobPxR(b), y1 + Math.sin(ang) * blobPxR(b));
        ctx.lineTo(ex, ey);
        arrows.push([ex, ey, ang]);
      }
      ctx.stroke();
      ctx.fillStyle = 'rgba(248,113,113,0.85)';
      for (const [ax, ay, ang] of arrows) arrowAt(ax, ay, ang, 6);
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

    // inspected-tile outline (above fog so it stays crisp)
    if (ui.selected && ui.selected.kind === 'tile') {
      const ti = ui.selected.i;
      const tx = ti % game.map.w, ty = (ti / game.map.w) | 0;
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 2;
      ctx.strokeRect(wx(tx) + 1, wy(ty) + 1, s - 2, s - 2);
    }

    drawMinimap(game, view);
  }

  // Working farmers are real 1-unit blobs standing in the fields — drawn
  // as the little farmer figure, but selectable and attackable.
  function drawWorkingFarmer(game, b, wx, wy, s, alpha, ui) {
    const t = game.tick + alpha;
    const bob = Math.abs(Math.sin(t * 0.14 + (b.id % 7) * 1.7)) * 0.1;
    const ix = lerp(b.prevX != null ? b.prevX : b.x, b.x, alpha);
    const iy = lerp(b.prevY != null ? b.prevY : b.y, b.y, alpha);
    const px = wx(ix), py = wy(iy - bob);
    const r = Math.max(2, s * 0.13);
    // taking-damage flash
    if (game.tick - b.engagedT < 3) {
      const pulse = 0.55 + 0.45 * Math.sin(t * 2.2);
      ctx.beginPath();
      ctx.arc(px, py - r * 0.5, r * 2.4, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(248,113,113,${pulse.toFixed(2)})`;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    if (ui.selected && (ui.selected.kind === 'blob' || ui.selected.kind === 'enemy-blob') && ui.selected.id === b.id) {
      ctx.beginPath();
      ctx.arc(px, py - r * 0.5, r * 2.2, 0, Math.PI * 2);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    // body
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fillStyle = b.owner === 0 ? '#166534' : '#7f1d1d';
    ctx.fill();
    // head
    ctx.beginPath();
    ctx.arc(px, py - r * 1.1, r * 0.55, 0, Math.PI * 2);
    ctx.fillStyle = b.owner === 0 ? '#86efac' : '#fca5a5';
    ctx.fill();
  }

  function drawSettlement(game, st, wx, wy, s, ghost, sel, workingN) {
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
      barY += 4;
    }
    // unit counts: garrison ⚔️/🚚 plus farmers (garrisoned + in the fields)
    if (!ghost && st.garrison && s >= 8) {
      const label = `⚔️${st.garrison.deploy} 🚚${st.garrison.supply} 🌱${st.garrison.farm + (workingN || 0)}`;
      const fs = Math.max(9, Math.min(12, s * 0.75));
      ctx.font = `600 ${fs}px system-ui`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const tw = ctx.measureText(label).width;
      const ty = barY + fs * 0.8;
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fillRect(px - tw / 2 - 3, ty - fs * 0.7, tw + 6, fs * 1.4);
      ctx.fillStyle = '#e4e4e7';
      ctx.fillText(label, px, ty);
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
