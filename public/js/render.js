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

// Viewer-relative palette: on your own screen YOU are always violet and
// the opponent red, whichever raw owner index you play in PvP.
function viewer(game) { return game.me || 0; }
function ownerColor(game, o) { return OWNER_COLOR[o === viewer(game) ? 0 : 1]; }
function ownerDark(game, o) { return OWNER_DARK[o === viewer(game) ? 0 : 1]; }
function knownOf(game) { return game.pvp ? game.knowns[viewer(game)] : game.known; }

function lerp(a, b, t) { return a + (b - a) * t; }
function mix(c1, c2, t) {
  return [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];
}
const BARREN = [192, 172, 126], MID = [127, 160, 84], LUSH = [42, 110, 48];

function tileRGB(game, i) {
  if (game.map.mountain[i]) {
    const v = 108 + ((i * 2654435761) % 24);
    return [v, v + 4, v + 10];
  }
  // built-over settlement ground: a flat stone/earth plaza, not farmland
  if (game.settAt && game.settAt[i]) {
    const v = (i * 2654435761) % 10;
    return [148 + v, 131 + v, 104 + v];
  }
  // five flat shades, one per fertility tier; farmland keeps the plain
  // tier color and is marked by the stripe overlay in paintTile (#43)
  const f = fertTier(game.map.fert[i]) / 4;
  return f < 0.5 ? mix(BARREN, MID, f * 2) : mix(MID, LUSH, (f - 0.5) * 2);
}

function fogTarget(v) { return v === 2 ? 0 : v === 1 ? 150 : 255; }

// Grid-aligned territory outline: the border edges of the disc of tiles
// whose centers lie within TERRITORY of a settlement's 2×2 footprint
// center (anchor + (1, 1)), as segment endpoints in tile offsets from
// the settlement's anchor tile. Computed once — the shape is identical
// for every settlement.
const TERRITORY_EDGES = (() => {
  const R = S.C.TERRITORY;
  // tile (dx, dy) center relative to the footprint center is (dx - 0.5, dy - 0.5)
  const inSet = (dx, dy) => (dx - 0.5) * (dx - 0.5) + (dy - 0.5) * (dy - 0.5) <= R * R;
  const segs = [];
  for (let dy = -R; dy <= R + 1; dy++) {
    for (let dx = -R; dx <= R + 1; dx++) {
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
    const px = (i % w) * T, py = ((i / w) | 0) * T;
    let [r, g, b] = tileRGB(game, i);
    const sid = game.tilledBy[i];
    if (sid) {
      // per-tile tone jitter on farmland only — breaks up the flat tier
      // color so a plot reads as worked ground, not wallpaper (#49)
      const jh = (i * 2246822519) >>> 0;
      r += (jh & 7) - 3; g += ((jh >>> 3) & 7) - 3; b += ((jh >>> 6) & 7) - 3;
    }
    tctx.fillStyle = `rgb(${r | 0},${g | 0},${b | 0})`;
    tctx.fillRect(px, py, T, T);
    // farmland: plough furrows as a world-space wavy stripe function keyed
    // on the owning settlement id AND a 2×2-tile patch grid, so one
    // settlement's farmland breaks into small plots with mixed row
    // directions (#61); tiles of one patch join seamlessly, and repainting
    // a single dirty tile reproduces identical pixels (#49).
    if (sid) {
      const WOB_LEN = 14, WOB_AMP = 1.2;        // waviness wavelength / amplitude (px)
      const patchX = (i % w) >> 1, patchY = ((i / w) | 0) >> 1;
      let hash = (sid * 2654435761 + patchX * 668265263 + patchY * 374761393) >>> 0;
      hash = Math.imul(hash ^ (hash >>> 15), 2246822519) >>> 0;
      hash = (hash ^ (hash >>> 13)) >>> 0;
      // rows are strictly horizontal or vertical (~50/50 per plot) — exact
      // 0/1 axis vectors, no diagonals
      const vert = (hash >>> 3) & 1;
      const cos = vert ? 1 : 0, sin = vert ? 0 : 1;
      const period = 5 + (hash & 3);            // 5–8 px between furrows
      const lw = 2 + ((hash >>> 2) & 1);        // 2 or 3 px furrow width
      const phase = (hash >>> 6) % period;
      const wobPhase = ((hash >>> 9) & 255) / 255 * Math.PI * 2;
      const depth = 0.18 + ((hash >>> 17) & 3) * 0.04 + ((i * 40503) & 3) * 0.015;
      const [dr, dg, db] = mix([r, g, b], [0, 0, 0], depth);
      tctx.fillStyle = `rgb(${dr | 0},${dg | 0},${db | 0})`;
      for (let y = 0; y < T; y++) {
        const gy = py + y;
        let run = -1;
        for (let x = 0; x <= T; x++) {
          let on = false;
          if (x < T) {
            const gx = px + x;
            const u = gx * cos + gy * sin;                 // along-rows coord
            const v = -gx * sin + gy * cos;                // across-rows coord
            const m = (u + phase + Math.sin(v / WOB_LEN + wobPhase) * WOB_AMP) % period;
            on = (m < 0 ? m + period : m) < lw;
          }
          if (on && run < 0) run = x;
          else if (!on && run >= 0) { tctx.fillRect(px + run, py + y, x - run, 1); run = -1; }
        }
      }
      // sparse crop tufts: 2–4 warm flecks hashed from the tile index,
      // kept a pixel off the tile border so they never bleed across tiles
      const th = (i * 3266489917) >>> 0;
      const tufts = 2 + (th & 1) + ((th >>> 1) & 1);
      const [cr, cg, cb] = mix([r, g, b], [214, 196, 110], 0.35);
      tctx.fillStyle = `rgb(${cr | 0},${cg | 0},${cb | 0})`;
      for (let k = 0; k < tufts; k++) {
        const kh = ((i + 1) * 374761393 + k * 668265263) >>> 0;
        const size = 1 + (kh & 1);
        tctx.fillRect(px + 1 + ((kh >>> 1) % (T - 2 - size)),
                      py + 1 + ((kh >>> 9) % (T - 2 - size)), size, size);
      }
    }
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
      const tp = r.targetKind === 'blob' ? { x: bx(tgt), y: by(tgt) } : S.settCenter(tgt);
      if (r.owner !== viewer(game)) {
        const seen = S.settVisible(game, src) || S.isVisible(game, tp.x, tp.y);
        if (!seen) continue;
      }
      const health = SUP.routeHealth(game, r);
      ctx.strokeStyle = health >= 0.9 ? 'rgba(74,222,128,0.8)'
        : health >= 0.5 ? 'rgba(251,191,36,0.8)' : 'rgba(248,113,113,0.85)';
      ctx.lineWidth = 2;
      ctx.setLineDash(r.owner !== viewer(game) ? [6, 5] : [10, 4]);
      ctx.beginPath();
      ctx.moveTo(wx(src.x + 1), wy(src.y + 1));
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
      if (st.owner !== viewer(game) && !S.settVisible(game, st)) continue;
      ctx.strokeStyle = ownerColor(game, st.owner);
      ctx.globalAlpha = 0.55;
      strokeTerritory(st.x, st.y);
    }
    for (const k of Object.values(knownOf(game))) {
      if (S.settVisible(game, k)) continue;
      ctx.strokeStyle = OWNER_COLOR[1];
      ctx.globalAlpha = 0.25;
      strokeTerritory(k.x, k.y);
    }
    ctx.globalAlpha = 1;

    // selected blob ids — single tap OR box multi-select (#62): the same
    // white ring / path treatment applies to every selected blob,
    // working farmers included
    let selSet = null;
    if (ui.selected) {
      if (ui.selected.kind === 'multi') selSet = new Set(ui.selected.ids);
      else if (ui.selected.kind === 'blob' || ui.selected.kind === 'enemy-blob') selSet = new Set([ui.selected.id]);
    }

    // selected blob paths (own blobs only — never reveal enemy plans)
    if (selSet) {
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 1.5;
      for (const b of game.blobs) {
        if (b.dead || !selSet.has(b.id) || b.owner !== viewer(game)) continue;
        if (!b.path || !b.path.length) continue;
        ctx.beginPath();
        ctx.moveTo(wx(bx(b)), wy(by(b)));
        for (const p of b.path) ctx.lineTo(wx(p.x), wy(p.y));
        ctx.stroke();
      }
    }

    // ghost settlements (remembered but not visible)
    for (const [id, k] of Object.entries(knownOf(game))) {
      if (S.settVisible(game, k)) continue;
      const gsel = ui.selected && ui.selected.kind === 'enemy-settlement' && ui.selected.id === +id;
      drawSettlement(game, { x: k.x, y: k.y, owner: 1 - viewer(game), hp: S.C.SETT_HP }, wx, wy, s, true, gsel, 0);
    }

    // working farmers — drawn before settlements so they can never cover
    // the garrison readouts
    for (const b of game.blobs) {
      if (b.dead || b.working == null) continue;
      if (b.owner !== viewer(game) && !S.isVisible(game, b.x, b.y)) continue;
      drawWorkingFarmer(game, b, wx, wy, s, alpha, selSet);
    }

    // settlements (with per-settlement working-farmer totals, one sweep)
    const workingBy = new Map();
    for (const b of game.blobs) {
      if (!b.dead && b.working != null) workingBy.set(b.working, (workingBy.get(b.working) || 0) + S.total(b));
    }
    for (const st of game.settlements) {
      if (st.owner !== viewer(game) && !S.settVisible(game, st)) continue;
      const sel = ui.selected && (ui.selected.kind === 'settlement' || ui.selected.kind === 'enemy-settlement') && ui.selected.id === st.id;
      drawSettlement(game, st, wx, wy, s, false, sel, workingBy.get(st.id) || 0);
    }

    // blobs
    for (const b of game.blobs) {
      if (b.dead || b.working != null) continue;
      if (b.owner !== viewer(game) && !S.isVisible(game, b.x, b.y)) continue;
      const r = Math.max(10, S.blobRadius(b) * s);
      const px = wx(bx(b)), py = wy(by(b));
      const isSupply = b.count.supply > 0 && b.count.deploy === 0 && b.count.farm === 0;
      // faint team-colored fill keeps a readable tap target; the units
      // inside carry the identity now
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fillStyle = ownerColor(game, b.owner);
      ctx.globalAlpha = isSupply ? 0.12 : 0.16;
      ctx.fill();
      ctx.globalAlpha = 1;
      // individual unit figures inside the ring (number-only at far zoom)
      if (r >= 12) drawBlobUnits(game, b, px, py, r);
      // dashed fed-state ring
      const m = S.fedMeter(b);
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = m >= 0.75 ? '#4ade80' : m >= 0.5 ? '#a3e635' : m >= 0.25 ? '#fbbf24' : '#f87171';
      ctx.setLineDash([Math.max(3, r * 0.25), Math.max(2, r * 0.18)]);
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      // taking-damage flash
      if (game.tick - b.engagedT < 3) {
        const pulse = 0.55 + 0.45 * Math.sin((game.tick + alpha) * 2.2);
        ctx.beginPath();
        ctx.arc(px, py, r + 3, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(248,113,113,${pulse.toFixed(2)})`;
        ctx.lineWidth = 3;
        ctx.stroke();
      }
      if (selSet && selSet.has(b.id)) {
        ctx.beginPath();
        ctx.arc(px, py, r + 4, 0, Math.PI * 2);
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      // role marker (kept clear of the count badge below)
      const roleMarked = isSupply || (b.count.farm > 0 && b.count.deploy === 0);
      if (isSupply) {
        ctx.fillStyle = '#fff';
        ctx.font = `${Math.max(9, r * 0.6)}px system-ui`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('⇄', px, py - r * 0.5);
      } else if (roleMarked) {
        ctx.fillStyle = '#bbf7d0';
        ctx.font = `${Math.max(9, r * 0.6)}px system-ui`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('🌱', px, py - r * 0.5);
      }
      // unit count on a dark backing pill so it reads over the figures
      const fs = roleMarked ? Math.max(9, Math.min(13, r * 0.6)) : Math.max(10, Math.min(16, r * 0.8));
      const cy2 = roleMarked ? py + r * 0.5 : py;
      const label = String(S.total(b));
      ctx.font = `bold ${fs}px system-ui`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fillRect(px - tw / 2 - 3, cy2 - fs * 0.7, tw + 6, fs * 1.4);
      ctx.fillStyle = '#fff';
      ctx.fillText(label, px, cy2);
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
      if (b.owner !== viewer(game) && !S.isVisible(game, b.x, b.y)) continue;
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
      const settSeen = st => st.owner !== 1 || S.settVisible(game, st);
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
        if (b.dead || !b.order || b.order.type !== 'move' || b.chaseId == null) continue;
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

      // sieges: solid line from attacker edge to the settlement's box
      // edge, with the same pulsing ⚔️ as blob melees at the midpoint (#84)
      const half = Math.max(8, 1.0 * s);
      const siegeSwords = [];
      ctx.strokeStyle = 'rgba(248,113,113,0.85)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      arrows.length = 0;
      for (const l of game.combat || []) {
        if (l.kind !== 'bs') continue;
        const b = blobById.get(l.b), st = settById.get(l.s);
        if (!b || !st || !blobSeen(b) || !settSeen(st)) continue;
        const x1 = wx(bx(b)), y1 = wy(by(b)), x2 = wx(st.x + 1), y2 = wy(st.y + 1);
        const ang = Math.atan2(y2 - y1, x2 - x1);
        const ex = x2 - Math.cos(ang) * (half + 3), ey = y2 - Math.sin(ang) * (half + 3);
        const sx = x1 + Math.cos(ang) * blobPxR(b), sy = y1 + Math.sin(ang) * blobPxR(b);
        ctx.moveTo(sx, sy);
        ctx.lineTo(ex, ey);
        arrows.push([ex, ey, ang]);
        siegeSwords.push([(sx + ex) / 2, (sy + ey) / 2]);
      }
      ctx.stroke();
      ctx.fillStyle = 'rgba(248,113,113,0.85)';
      for (const [ax, ay, ang] of arrows) arrowAt(ax, ay, ang, 6);
      if (siegeSwords.length) {
        ctx.globalAlpha = pulse;
        ctx.font = `${Math.max(11, s * 0.7)}px system-ui`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        for (const [mx, my] of siegeSwords) ctx.fillText('⚔️', mx, my);
        ctx.globalAlpha = 1;
      }
    }

    // floating damage numbers + resource-flow particles (wheat: farmers →
    // settlement; loot: pillaged land → army). Particles ride the same
    // fx channel: the sim emits deterministically per tick, motion here
    // derives from game.tick + alpha so they pause/speed with the game.
    if (game.fx && game.fx.length) {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      let flowBlobs = null; // lazy live-blob map for loot particle targets
      const DUR = S.C.FLOW_FX_TICKS;
      for (const f of game.fx) {
        const age = game.tick - f.t + alpha;
        if (f.kind === 'wheat' || f.kind === 'loot') {
          if (age < 0 || age >= DUR) continue;
          const p = age / DUR;
          let tx2 = f.tx, ty2 = f.ty;
          if (f.kind === 'loot') {
            // track the (possibly marching) army; fall back to the
            // emit-time position if it died or merged away mid-flight
            if (!flowBlobs) {
              flowBlobs = new Map();
              for (const b of game.blobs) if (!b.dead) flowBlobs.set(b.id, b);
            }
            const tb = flowBlobs.get(f.bid);
            if (tb) { tx2 = bx(tb); ty2 = by(tb); }
          }
          const e = p * p; // ease-in: drawn toward the destination
          const lift = Math.sin(p * Math.PI) * (f.kind === 'wheat' ? 0.4 : 0.15);
          const cx2 = lerp(f.x, tx2, e), cy2 = lerp(f.y, ty2, e) - lift;
          if (!S.isVisible(game, cx2, cy2)) continue; // same fog rule as damage numbers
          const fade = p < 0.15 ? p / 0.15 : p > 0.8 ? (1 - p) / 0.2 : 1;
          ctx.beginPath();
          ctx.arc(wx(cx2), wy(cy2), Math.max(1.5, 0.09 * s), 0, Math.PI * 2);
          ctx.fillStyle = f.kind === 'wheat' ? '#fbbf24' : '#fb923c';
          ctx.globalAlpha = Math.max(0, Math.min(1, fade));
          ctx.fill();
          ctx.globalAlpha = 1;
          continue;
        }
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

    // map boundary — drawn above the fog so the world's edge always
    // reads, even where the tiles beside it are unexplored (#70)
    ctx.strokeStyle = 'rgba(148,163,184,0.55)';
    ctx.lineWidth = 2;
    ctx.strokeRect(ox, oy, game.map.w * s, game.map.h * s);

    // order-confirmation ping: a single collapsing ring at the ordered
    // destination so a tap visibly lands (#71, #78) — red for an attack
    // order, white for a plain move. Above fog: the destination may
    // still be unexplored.
    if (ui.ping) {
      const age = now - ui.ping.t;
      const DUR = 600;
      if (age >= DUR) ui.ping = null;
      else {
        const px = wx(ui.ping.x), py = wy(ui.ping.y);
        const col = ui.ping.kind === 'attack' ? '248,113,113' : '255,255,255';
        const p = age / DUR;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(px, py, (1 - p) * Math.max(18, s * 1.1) + 3, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(${col},${(0.15 + 0.85 * (1 - p)).toFixed(2)})`;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(px, py, 2.5, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${col},${(1 - p).toFixed(2)})`;
        ctx.fill();
      }
    }

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

  // Individual unit figures inside a blob's dashed ring: a deterministic
  // golden-angle spiral (index-ordered, jittered per unit from its seed —
  // no Math.random(), so host/guest frames match). Heads are role-tinted;
  // bodies use the owner's dark tone. Capped for very large armies — the
  // count badge stays authoritative.
  const GOLDEN_ANGLE = 2.399963229728653;
  function drawBlobUnits(game, b, px, py, rPx) {
    const n = Math.min(b.units.length, 40);
    if (!n) return;
    const ur = Math.max(1.5, Math.min(4, rPx / (2.2 * Math.sqrt(n))));
    const body = ownerDark(game, b.owner);
    for (let i = 0; i < n; i++) {
      const u = b.units[i];
      const h = Math.floor(u.seed * 4096);
      const fr = n === 1 ? 0 : Math.sqrt((i + 0.5) / n) * rPx * 0.72;
      const ang = i * GOLDEN_ANGLE + ((h & 63) / 63 - 0.5) * 0.4;
      const ux = px + Math.cos(ang) * fr + (((h >> 6) & 3) - 1.5) * ur * 0.2;
      const uy = py + Math.sin(ang) * fr + (((h >> 8) & 3) - 1.5) * ur * 0.2;
      ctx.beginPath();
      ctx.arc(ux, uy + ur * 0.3, ur, 0, Math.PI * 2);
      ctx.fillStyle = body;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(ux, uy - ur * 0.75, ur * 0.55, 0, Math.PI * 2);
      ctx.fillStyle = u.role === 'deploy' ? '#f4f4f5' : u.role === 'supply' ? '#7dd3fc' : '#86efac';
      ctx.fill();
    }
  }

  // Working farmers are real 1-unit blobs standing in the fields — drawn
  // as the little farmer figure, but selectable and attackable.
  function drawWorkingFarmer(game, b, wx, wy, s, alpha, selSet) {
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
    if (selSet && selSet.has(b.id)) {
      ctx.beginPath();
      ctx.arc(px, py - r * 0.5, r * 2.2, 0, Math.PI * 2);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    // body
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fillStyle = b.owner === viewer(game) ? '#166534' : '#7f1d1d';
    ctx.fill();
    // head
    ctx.beginPath();
    ctx.arc(px, py - r * 1.1, r * 0.55, 0, Math.PI * 2);
    ctx.fillStyle = b.owner === viewer(game) ? '#86efac' : '#fca5a5';
    ctx.fill();
  }

  function drawSettlement(game, st, wx, wy, s, ghost, sel, workingN) {
    // fills the 2×2 footprint exactly: a plain square keep — no roof
    // triangle (#67) — with unit counts inside in a loose triangle (#40)
    const x0 = wx(st.x), y0 = wy(st.y);
    const size = 2 * s;
    const cx = x0 + size / 2, cy = y0 + size / 2;
    const hit = !ghost && st.lastHitT != null && game.tick - st.lastHitT < 3;
    ctx.globalAlpha = ghost ? 0.4 : 1;
    // body: the whole plot as one square
    ctx.fillStyle = ownerDark(game, st.owner);
    ctx.fillRect(x0, y0, size, size);
    if (hit) {
      ctx.fillStyle = 'rgba(248,113,113,0.4)';
      ctx.fillRect(x0, y0, size, size);
    }
    // outline around the full plot (white when selected, red when hit)
    ctx.strokeStyle = hit ? '#f87171' : sel ? '#ffffff' : ownerColor(game, st.owner);
    ctx.lineWidth = sel || hit ? 3 : 2;
    ctx.strokeRect(x0, y0, size, size);
    // unit counts inside, loose triangle: ⚔️ upper-left, 🚚 upper-right,
    // 🌱 (garrisoned + working the fields) bottom-center; own settlements
    // also show the 🌾 stockpile top-center (#86 — the enemy's stays private)
    if (!ghost && st.garrison && s >= 8) {
      const fs = Math.max(9, Math.min(12, s * 0.55));
      ctx.font = `600 ${fs}px system-ui`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const chips = [
        [`⚔️${st.garrison.deploy}`, cx - 0.45 * s, cy - 0.05 * s],
        [`🚚${st.garrison.supply}`, cx + 0.45 * s, cy + 0.10 * s],
        [`🌱${st.garrison.farm + (workingN || 0)}`, cx, cy + 0.60 * s],
      ];
      if (st.owner === viewer(game) && st.stockpile != null) {
        chips.push([`🌾${Math.floor(st.stockpile)}`, cx, cy - 0.55 * s]);
      }
      for (const [label, lx, ly] of chips) {
        const tw = ctx.measureText(label).width;
        ctx.fillStyle = 'rgba(0,0,0,0.45)';
        ctx.fillRect(lx - tw / 2 - 2, ly - fs * 0.7, tw + 4, fs * 1.4);
        ctx.fillStyle = '#e4e4e7';
        ctx.fillText(label, lx, ly);
      }
    }
    // health / production bars just below the plot
    let barY = y0 + size + 2;
    if (!ghost && st.hp < S.C.SETT_HP) {
      ctx.fillStyle = '#111827';
      ctx.fillRect(x0, barY, size, 4);
      ctx.fillStyle = '#f87171';
      ctx.fillRect(x0, barY, size * (st.hp / S.C.SETT_HP), 4);
      barY += 5;
    }
    // production progress (own settlements only)
    if (!ghost && st.owner === viewer(game) && st.trainAcc > 0) {
      ctx.fillStyle = '#111827';
      ctx.fillRect(x0, barY, size, 3);
      ctx.fillStyle = '#fbbf24';
      ctx.fillRect(x0, barY, size * (st.trainAcc / S.C.TRAIN_COST), 3);
      barY += 4;
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
      if (st.owner !== viewer(game) && !S.settVisible(game, st)) continue;
      mctx.fillStyle = ownerColor(game, st.owner);
      mctx.fillRect((st.x + 1) * sx - 3, (st.y + 1) * sy - 3, 6, 6);
    }
    for (const k of Object.values(knownOf(game))) {
      mctx.fillStyle = 'rgba(239,68,68,0.5)';
      mctx.fillRect((k.x + 1) * sx - 3, (k.y + 1) * sy - 3, 6, 6);
    }
    for (const b of game.blobs) {
      if (b.dead) continue;
      if (b.owner !== viewer(game) && !S.isVisible(game, b.x, b.y)) continue;
      mctx.fillStyle = ownerColor(game, b.owner);
      mctx.fillRect(b.x * sx - 1, b.y * sy - 1, 3, 3);
    }
    // map boundary (matches the main view's always-visible edge, #70)
    mctx.strokeStyle = 'rgba(148,163,184,0.8)';
    mctx.lineWidth = 1;
    mctx.strokeRect(0.5, 0.5, mw - 1, mh - 1);
    // view rectangle
    const vw = (canvas.clientWidth / view.scale) * sx;
    const vh = (canvas.clientHeight / view.scale) * sy;
    mctx.strokeStyle = 'rgba(255,255,255,0.7)';
    mctx.lineWidth = 1;
    mctx.strokeRect(view.cx * sx - vw / 2, view.cy * sy - vh / 2, vw, vh);
  }

  return { draw, resize, get cssSize() { return { w: cssW, h: cssH }; } };
}
