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
// unit-figure bodies: brighter than OWNER_DARK so the tiny figures
// themselves read team at 1.5–4 px (#122)
const OWNER_BODY = ['#7c3aed', '#dc2626'];

// Viewer-relative palette: on your own screen YOU are always violet and
// the opponent red, whichever raw owner index you play in PvP.
function viewer(game) { return game.me || 0; }
function ownerColor(game, o) { return OWNER_COLOR[o === viewer(game) ? 0 : 1]; }
function ownerDark(game, o) { return OWNER_DARK[o === viewer(game) ? 0 : 1]; }
function ownerBody(game, o) { return OWNER_BODY[o === viewer(game) ? 0 : 1]; }
function knownOf(game) { return game.pvp ? game.knowns[viewer(game)] : game.known; }

function lerp(a, b, t) { return a + (b - a) * t; }
function mix(c1, c2, t) {
  return [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];
}
const BARREN = [192, 172, 126], MID = [127, 160, 84], LUSH = [42, 110, 48];

// Fog secrecy for terrain (#182): enemy-built plaza/farmland renders only
// once the viewer has discovered the owning settlement (it's in `known`)
// or currently sees the tile. Own and neutral terrain always renders.
function terrainKnown(game, i) {
  const sid = (game.settAt && game.settAt[i]) || game.tilledBy[i];
  if (!sid) return true;
  const s = game.settlements.find(x => x.id === sid);
  if (!s || s.owner === viewer(game)) return true;
  return knownOf(game)[sid] != null || game.fog[i] === 2;
}

function tileRGB(game, i) {
  if (game.map.mountain[i]) {
    const v = 108 + ((i * 2654435761) % 24);
    return [v, v + 4, v + 10];
  }
  // built-over settlement ground: a flat stone/earth plaza, not farmland —
  // hidden until the viewer discovers the settlement (#182)
  if (game.settAt && game.settAt[i] && terrainKnown(game, i)) {
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
// the settlement's anchor tile. Computed once. Since #188 live
// settlements stroke their OWNED region from game.terr instead; this
// idealized circle remains only for the ghost rings of remembered
// enemy settlements, which draw from a fog snapshot with no live
// ownership to consult.
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
  // dirty tiles the viewer can't currently see (#182): the terrain canvas
  // keeps their last-seen pixels; they repaint once they come into vision
  let pendingDirty = new Set();
  let dpr = 1, cssW = 0, cssH = 0;
  let lastFrameT = 0;
  // per-settlement territory border segments derived from the exclusive
  // ownership map (#188), cached until the sim rebuilds it (terrVer)
  let terrEdges = null, terrEdgesVer = -1, terrEdgesGame = null;

  // Border segments of each settlement's OWNED tiles, in world tile
  // coordinates: `outer` faces unowned or enemy-owned ground (the
  // national border), `seam` faces a same-player neighbor settlement
  // (the internal province line, kept on the lower-id side only so it
  // never double-strokes).
  function ensureTerrEdges(game) {
    if (!game.terr) S.rebuildTerritory(game);
    if (terrEdges && terrEdgesGame === game && terrEdgesVer === game.terrVer) return terrEdges;
    const { w, h } = game.map;
    const byId = new Map(game.settlements.map(s => [s.id, s]));
    terrEdges = new Map();
    const bag = (sid) => {
      let e = terrEdges.get(sid);
      if (!e) { e = { outer: [], seam: [] }; terrEdges.set(sid, e); }
      return e;
    };
    const terr = game.terr;
    for (let ty = 0; ty < h; ty++) {
      for (let tx = 0; tx < w; tx++) {
        const sid = terr[ty * w + tx];
        if (!sid) continue;
        const s = byId.get(sid);
        if (!s) continue;
        // [neighbor tx, neighbor ty, edge x1, y1, x2, y2]
        const sides = [
          [tx, ty - 1, tx, ty, tx + 1, ty],
          [tx, ty + 1, tx, ty + 1, tx + 1, ty + 1],
          [tx - 1, ty, tx, ty, tx, ty + 1],
          [tx + 1, ty, tx + 1, ty, tx + 1, ty + 1],
        ];
        for (const [nx, ny, x1, y1, x2, y2] of sides) {
          const nSid = nx < 0 || ny < 0 || nx >= w || ny >= h ? 0 : terr[ny * w + nx];
          if (nSid === sid) continue;
          const o = nSid ? byId.get(nSid) : null;
          if (o && o.owner === s.owner) {
            if (sid < nSid) bag(sid).seam.push([x1, y1, x2, y2]);
          } else {
            bag(sid).outer.push([x1, y1, x2, y2]);
          }
        }
      }
    }
    terrEdgesGame = game; terrEdgesVer = game.terrVer;
    return terrEdges;
  }

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
    pendingDirty.clear();
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
    // undiscovered enemy farmland paints as plain land (#182)
    const sid = terrainKnown(game, i) ? game.tilledBy[i] : 0;
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
    // pillage scorch (#144, recolored per #175 feedback): raided ground
    // reads as burnt earth, not naturally barren — a burnt-umber wash plus
    // ember-brown and pale ash-tan flecks whose strength tracks the
    // fraction of the tile's ORIGINAL fertility destroyed, so a lightly
    // nibbled tile shows a faint singe and only a near-Barren tile renders
    // fully scorched; it fades out as the land regenerates (the regen tick
    // re-dirties the tile every tick, so this repaints on its own).
    // Hashed per tile — repainting reproduces identical pixels.
    if (game.pillaged && game.pillaged.has(i)) {
      const orig = game.map.orig[i];
      const missing = orig - game.map.fert[i];
      const k = orig > 0 ? Math.max(0, Math.min(1, missing / orig)) : 0;
      // eased ramp (k²): a light nibble is a barely-there tint with no
      // flecks; the ember/ash fleck look builds in only as the tile
      // approaches Barren
      const e = k * k;
      if (e > 0.02) {
        tctx.fillStyle = `rgba(124,76,36,${(0.32 * e).toFixed(3)})`;
        tctx.fillRect(px, py, T, T);
        if (k > 0.35) {
          const flecks = 1 + Math.round(e * 4);
          tctx.fillStyle = `rgba(94,52,22,${(0.15 + 0.55 * e).toFixed(2)})`;
          for (let f = 0; f < flecks; f++) {
            const fh = ((i + 1) * 2654435761 + f * 40503) >>> 0;
            const size = 1 + (fh & 1);
            tctx.fillRect(px + 1 + ((fh >>> 3) % (T - 2 - size)),
                          py + 1 + ((fh >>> 11) % (T - 2 - size)), size, size);
          }
        }
        // pale ash-tan specks so a heavy burn reads dry and dusty, not muddy
        if (k > 0.6) {
          tctx.fillStyle = `rgba(205,176,132,${(0.08 + 0.4 * e).toFixed(2)})`;
          for (let f = 0; f < 2; f++) {
            const fh = ((i + 1) * 1597334677 + (f + 5) * 668265263) >>> 0;
            const size = 1 + (fh & 1);
            tctx.fillRect(px + 1 + ((fh >>> 3) % (T - 2 - size)),
                          py + 1 + ((fh >>> 11) % (T - 2 - size)), size, size);
          }
        }
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
    // fog memory (#182): repaint a dirty tile only while the viewer sees
    // it; everything else waits in pendingDirty so fogged terrain keeps
    // its last-seen pixels. (Own terrain changes always happen in vision —
    // VISION_SETT exceeds the farm ring — so nothing of ours is delayed.)
    const fog = game.fog;
    for (const i of game.dirty) {
      if (fog[i] === 2) paintTile(game, i);
      else pendingDirty.add(i);
    }
    game.dirty.clear();
    for (const i of pendingDirty) {
      if (fog[i] === 2) { paintTile(game, i); pendingDirty.delete(i); }
    }
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

    // selected blob ids — single tap OR box multi-select (#62): the same
    // white ring / path treatment applies to every selected blob,
    // working farmers included. Computed before the route pass so a
    // selected carrier can light up its supply line (#193).
    let selSet = null;
    if (ui.selected) {
      if (ui.selected.kind === 'multi') selSet = new Set(ui.selected.ids);
      else if (ui.selected.kind === 'blob' || ui.selected.kind === 'enemy-blob') selSet = new Set([ui.selected.id]);
    }
    // routes served by a selected carrier (#193) — drawn highlighted
    // below; the fog gate still decides whether an enemy line draws
    const hlRoutes = new Set();
    if (selSet) {
      for (const b of game.blobs) {
        if (!b.dead && selSet.has(b.id) && b.order && b.order.type === 'route') hlRoutes.add(b.order.routeId);
      }
    }

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
      const hl = hlRoutes.has(r.id);
      if (hl) {
        // soft sky underlay so the selected carrier's line pops (#193)
        ctx.strokeStyle = 'rgba(56,189,248,0.30)';
        ctx.lineWidth = 6;
        ctx.beginPath();
        ctx.moveTo(wx(src.x + 1), wy(src.y + 1));
        ctx.lineTo(wx(tp.x), wy(tp.y));
        ctx.stroke();
      }
      ctx.strokeStyle = health >= 0.9 ? `rgba(74,222,128,${hl ? 1 : 0.8})`
        : health >= 0.5 ? `rgba(251,191,36,${hl ? 1 : 0.8})` : `rgba(248,113,113,${hl ? 1 : 0.85})`;
      ctx.lineWidth = hl ? 3 : 2;
      ctx.setLineDash(r.owner !== viewer(game) ? [6, 5] : [10, 4]);
      // highlighted dashes march from source toward destination — wall
      // clock, like the armed-source halo, so they keep moving while
      // the game is paused
      if (hl) ctx.lineDashOffset = -((now / 40) % 14);
      ctx.beginPath();
      ctx.moveTo(wx(src.x + 1), wy(src.y + 1));
      ctx.lineTo(wx(tp.x), wy(tp.y));
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineDashOffset = 0;
    }

    // territory borders — armies inside get fed from the stockpile.
    // Exclusive per-tile ownership (#188): each settlement strokes the
    // outline of the tiles it OWNS, so close settlements split the land
    // at the midline instead of drawing overlapping rings. Seams between
    // two same-player settlements draw thinner, reading as a province
    // line rather than a frontier.
    function strokeSegs(segs) {
      ctx.beginPath();
      for (const [x1, y1, x2, y2] of segs) {
        ctx.moveTo(wx(x1), wy(y1));
        ctx.lineTo(wx(x2), wy(y2));
      }
      ctx.stroke();
    }
    const edges = ensureTerrEdges(game);
    for (const st of game.settlements) {
      if (st.building) continue; // construction sites feed nobody — no ring yet (#95)
      if (st.owner !== viewer(game) && !S.settVisible(game, st)) continue;
      const e = edges.get(st.id);
      if (!e) continue;
      ctx.strokeStyle = ownerColor(game, st.owner);
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = 2;
      strokeSegs(e.outer);
      if (e.seam.length) {
        ctx.globalAlpha = 0.35;
        ctx.lineWidth = 1;
        strokeSegs(e.seam);
      }
    }
    // ghost rings for remembered enemy settlements draw from the fog
    // snapshot, not live ownership — keep the plain circular outline
    function strokeTerritory(px0, py0) {
      ctx.beginPath();
      for (const [ax, ay, ex, ey] of TERRITORY_EDGES) {
        ctx.moveTo(wx(px0 + ax), wy(py0 + ay));
        ctx.lineTo(wx(px0 + ex), wy(py0 + ey));
      }
      ctx.stroke();
    }
    ctx.lineWidth = 2;
    for (const k of Object.values(knownOf(game))) {
      if (S.settVisible(game, k)) continue;
      ctx.strokeStyle = OWNER_COLOR[1];
      ctx.globalAlpha = 0.25;
      strokeTerritory(k.x, k.y);
    }
    ctx.globalAlpha = 1;

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

    // ruins (#106): permanent, neutral battle scars where settlements
    // fell — drawn under everything living, full-strength when the spot
    // is visible, dimmed like ghosts when merely explored
    for (const r of game.ruins || []) {
      let seen = 0; // 0 unseen, 1 explored, 2 visible
      for (let dy = 0; dy <= 1; dy++) {
        for (let dx = 0; dx <= 1; dx++) {
          seen = Math.max(seen, game.fog[(r.y + dy) * game.map.w + (r.x + dx)]);
        }
      }
      if (seen > 0) drawRuin(r, wx, wy, s, seen === 2);
    }

    // ghost settlements (remembered but not visible)
    for (const [id, k] of Object.entries(knownOf(game))) {
      if (S.settVisible(game, k)) continue;
      const gsel = ui.selected && ui.selected.kind === 'enemy-settlement' && ui.selected.id === +id;
      drawSettlement(game, { x: k.x, y: k.y, owner: 1 - viewer(game), hp: S.C.SETT_HP, name: k.name }, wx, wy, s, true, gsel, 0);
    }

    // working farmers — drawn before settlements so they can never cover
    // the garrison readouts. A farmer currently crossing a settlement
    // footprint (#135 — friendly footprints are walkable, so shortest
    // paths cut across the plot) is deferred to a second pass above the
    // keep, so it doesn't vanish under the opaque square.
    const crossingFarmers = [];
    for (const b of game.blobs) {
      if (b.dead || b.working == null) continue;
      if (b.owner !== viewer(game) && !S.isVisible(game, b.x, b.y)) continue;
      const ti = Math.floor(by(b)) * game.map.w + Math.floor(bx(b));
      if (game.settAt && game.settAt[ti]) { crossingFarmers.push(b); continue; }
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

    // selected-carrier route endpoints (#193): steady sky markers on the
    // highlighted line's source and destination — a dashed rect around a
    // settlement footprint, a ring around an army target. Deliberately
    // non-pulsing so they can't read as the armed-source halo below.
    if (hlRoutes.size) {
      ctx.strokeStyle = 'rgba(56,189,248,0.8)';
      ctx.lineWidth = 2.5;
      const markSett = (st2) => {
        ctx.setLineDash([4, 3]);
        ctx.strokeRect(wx(st2.x) - 3, wy(st2.y) - 3, 2 * s + 6, 2 * s + 6);
        ctx.setLineDash([]);
      };
      for (const r of game.routes) {
        if (!hlRoutes.has(r.id)) continue;
        const rsrc = SUP.routeSource(game, r);
        const rtgt = SUP.routeTarget(game, r);
        if (!rsrc || !rtgt) continue;
        if (r.owner !== viewer(game)) {
          // same fog gate as the line itself — markers never reveal more
          const tp2 = r.targetKind === 'blob' ? { x: bx(rtgt), y: by(rtgt) } : S.settCenter(rtgt);
          if (!S.settVisible(game, rsrc) && !S.isVisible(game, tp2.x, tp2.y)) continue;
        }
        markSett(rsrc);
        if (r.targetKind === 'blob') {
          ctx.beginPath();
          ctx.arc(wx(bx(rtgt)), wy(by(rtgt)), Math.max(10, S.blobRadius(rtgt) * s) + 4, 0, Math.PI * 2);
          ctx.stroke();
        } else {
          markSett(rtgt);
        }
      }
    }

    // armed supply-route source: while a route pick is pending, a pulsing
    // sky dashed halo marks the settlement the line will load from —
    // dashed + coloured so it can't read as the white selected outline,
    // pulsing (unlike the static amber siege halo) from wall-clock time
    // so it keeps breathing while the game is paused
    if (ui.routeSrc != null && (ui.pending === 'route' || ui.pending === 'route-sett')) {
      const src = game.settlements.find(st => st.id === ui.routeSrc && st.owner === viewer(game));
      if (src) {
        const x0 = wx(src.x), y0 = wy(src.y), size = 2 * s;
        const a = 0.55 + 0.45 * Math.sin(now / 180);
        ctx.strokeStyle = `rgba(56,189,248,${a.toFixed(2)})`;
        ctx.lineWidth = 2.5;
        ctx.setLineDash([4, 3]);
        ctx.strokeRect(x0 - 3, y0 - 3, size + 6, size + 6);
        ctx.setLineDash([]);
      }
    }

    // farmers mid-crossing over a footprint (#135): drawn above the keep
    // so they stay visible walking across instead of blinking out
    for (const b of crossingFarmers) drawWorkingFarmer(game, b, wx, wy, s, alpha, selSet);

    // blobs
    for (const b of game.blobs) {
      if (b.dead || b.working != null) continue;
      if (b.owner !== viewer(game) && !S.isVisible(game, b.x, b.y)) continue;
      const r = Math.max(10, S.blobRadius(b) * s);
      const px = wx(bx(b)), py = wy(by(b));
      const isSupply = b.count.supply > 0 && b.count.deploy === 0 && b.count.farm === 0;
      // translucent team-colored fill: strong enough to read allegiance
      // at far zoom, translucent enough to keep the terrain legible (#122)
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fillStyle = ownerColor(game, b.owner);
      ctx.globalAlpha = isSupply ? 0.24 : 0.32;
      ctx.fill();
      ctx.globalAlpha = 1;
      // individual unit figures inside the ring (number-only at far zoom)
      if (r >= 12) drawBlobUnits(game, b, px, py, r);
      // solid team band under the fed ring: band color = allegiance,
      // dash color on top = fed state (#122). The band doubles as the
      // group's total-health meter (#139): a dim full circle with a
      // full-strength arc covering the surviving HP fraction, clockwise
      // from 12 o'clock.
      const hp = S.blobHealth(b);
      ctx.lineWidth = 4.5;
      ctx.strokeStyle = ownerColor(game, b.owner);
      ctx.globalAlpha = 0.35;
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
      if (hp > 0.001) {
        ctx.beginPath();
        ctx.arc(px, py, r, -Math.PI / 2, -Math.PI / 2 + hp * Math.PI * 2);
        ctx.stroke();
      }
      // dashed fed-state ring
      const m = S.fedMeter(b);
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = m >= 0.75 ? '#4ade80' : m >= 0.5 ? '#a3e635' : m >= 0.25 ? '#fbbf24' : '#f87171';
      ctx.setLineDash([Math.max(3, r * 0.25), Math.max(2, r * 0.18)]);
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      // attack-direction line (#108): a group with soldiers shows its
      // facing while fighting or holding an attack order — the pincer
      // read for both players
      if (b.count.deploy > 0
        && (game.tick - b.engagedT < 5 || (b.order && b.order.type === 'move' && b.order.tkind))) {
        const fr = r + Math.max(6, 0.6 * s);
        const fx2 = Math.cos(b.facing || 0), fy2 = Math.sin(b.facing || 0);
        ctx.beginPath();
        ctx.moveTo(px + fx2 * r * 0.4, py + fy2 * r * 0.4);
        ctx.lineTo(px + fx2 * fr, py + fy2 * fr);
        ctx.strokeStyle = ownerColor(game, b.owner);
        ctx.lineWidth = 2.5;
        ctx.stroke();
      }
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
      // cargo chip: food a route carrier is hauling. Deliberately public —
      // drawn for every visible carrier regardless of owner, so enemy
      // caravans read as raid targets (killing one loots half its cargo).
      if (b.order && b.order.type === 'route') {
        const cfs = Math.max(9, Math.min(13, r * 0.6));
        const clabel = `🌾 ${Math.round(b.order.cargo || 0)}`;
        ctx.font = `bold ${cfs}px system-ui`;
        const cw = ctx.measureText(clabel).width;
        const ccy = py + r + cfs * 0.8;
        ctx.fillStyle = 'rgba(0,0,0,0.45)';
        ctx.fillRect(px - cw / 2 - 3, ccy - cfs * 0.7, cw + 6, cfs * 1.4);
        ctx.fillStyle = '#fff';
        ctx.fillText(clabel, px, ccy);
      }
      if (b.pillaging) {
        ctx.font = `${Math.max(10, r * 0.6)}px system-ui`;
        ctx.fillText('🔥', px + r * 0.9, py - r * 0.9);
      }
      // arm-up progress (#108): amber bar while the group converts to
      // fighters — until it fills, the units keep their old role
      if (b.convert) {
        const p = Math.max(0, Math.min(1, 1 - (b.convert.done - game.tick) / S.C.CONVERT_TICKS));
        const bw = Math.max(18, r * 1.6);
        const byy = py + r + 3;
        ctx.fillStyle = '#111827';
        ctx.fillRect(px - bw / 2, byy, bw, 3);
        ctx.fillStyle = '#fbbf24';
        ctx.fillRect(px - bw / 2, byy, bw * p, 3);
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
        if (Math.hypot(t.x - b.x, t.y - b.y) <= S.C.MELEE_RANGE + 0.2) continue;
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

      // engaged blob pairs: bright pulsing link + ⚔️ at the midpoint.
      // Links carrying a rear/flank bonus (#108) draw thicker in orange
      // so a successful pincer is readable at a glance.
      const swords = [];
      for (const pass of [0, 1]) {
        ctx.strokeStyle = pass === 1
          ? `rgba(251,146,60,${Math.min(1, pulse + 0.25).toFixed(2)})`
          : `rgba(248,113,113,${pulse.toFixed(2)})`;
        ctx.lineWidth = pass === 1 ? 3 : 2;
        ctx.beginPath();
        for (const l of game.combat || []) {
          if (l.kind !== 'bb' || (pass === 1) !== !!l.rear) continue;
          const a = blobById.get(l.a), b = blobById.get(l.b);
          if (!a || !b || !blobSeen(a) || !blobSeen(b)) continue;
          const x1 = wx(bx(a)), y1 = wy(by(a)), x2 = wx(bx(b)), y2 = wy(by(b));
          ctx.moveTo(x1, y1);
          ctx.lineTo(x2, y2);
          swords.push([(x1 + x2) / 2, (y1 + y2) / 2]);
        }
        ctx.stroke();
      }
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
        ctx.font = `bold ${Math.max(11, Math.min(16, s * 0.9))}px system-ui`;
        const fyPx = wy(f.y) - s * 0.6 - age * s * 0.09;
        if (f.kind === 'starve') {
          // starvation deaths: a skull instead of the plain damage number,
          // so hunger reads differently from combat losses
          ctx.globalAlpha = fade;
          ctx.fillStyle = '#d6d3d1';
          ctx.fillText(`💀−${f.n}`, wx(f.x), fyPx);
          ctx.globalAlpha = 1;
        } else {
          ctx.fillStyle = `rgba(248,113,113,${fade.toFixed(2)})`;
          ctx.fillText(`−${f.n}`, wx(f.x), fyPx);
        }
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

    // settlement placement (#94), above fog so outlines stay readable:
    // dashed 2×2 markers at every in-flight founding site, plus the
    // armed snapped preview (touch buildSite / desktop hover) coloured
    // by live validity — buildAnchorAt is re-run each frame so a site
    // that turns invalid while the player deliberates shows red.
    function dashedPlot(ax, ay, color, fill) {
      const px0 = wx(ax), py0 = wy(ay);
      if (fill) {
        ctx.fillStyle = fill;
        ctx.fillRect(px0, py0, 2 * s, 2 * s);
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(px0, py0, 2 * s, 2 * s);
      ctx.setLineDash([]);
    }
    for (const b of game.blobs) {
      if (b.dead || b.owner !== viewer(game)) continue;
      if (!b.order || b.order.type !== 'move' || !b.order.build) continue;
      dashedPlot(b.order.build.x, b.order.build.y, 'rgba(255,255,255,0.75)');
    }
    if (ui.pending === 'build') {
      let plot = null;
      if (ui.buildSite) plot = ui.buildSite;
      else if (ui.hover) {
        const tx = Math.floor(ui.hover.x), ty = Math.floor(ui.hover.y);
        if (tx >= 0 && ty >= 0 && tx < game.map.w && ty < game.map.h) plot = { x: tx, y: ty };
      }
      if (plot) {
        const a = S.buildAnchorAt(game, plot.x, plot.y);
        const ax = a.err ? plot.x : a.x, ay = a.err ? plot.y : a.y;
        if (!a.err) {
          // farm preview (#137): the exact plots tillFields will claim on
          // completion — same previewFields the sim commits from
          ctx.fillStyle = 'rgba(74,222,128,0.15)';
          ctx.strokeStyle = 'rgba(74,222,128,0.35)';
          ctx.lineWidth = 1;
          // owner-aware (#167): show the exact plots the site would win,
          // including contested same-owner tiles it takes from a neighbor
          for (const i of S.previewFields(game, ax, ay, viewer(game))) {
            const tx = i % game.map.w, ty = (i / game.map.w) | 0;
            ctx.fillRect(wx(tx), wy(ty), s, s);
            ctx.strokeRect(wx(tx) + 0.5, wy(ty) + 0.5, s - 1, s - 1);
          }
        }
        dashedPlot(ax, ay,
          a.err ? 'rgba(248,113,113,0.95)' : 'rgba(74,222,128,0.95)',
          a.err ? 'rgba(248,113,113,0.14)' : 'rgba(74,222,128,0.14)');
      }
    }

    // order-confirmation ping: a single collapsing ring at the ordered
    // destination so a tap visibly lands (#71, #78) — red for an attack
    // order, sky for a supply-route endpoint, white for a plain move.
    // Above fog: the destination may still be unexplored.
    if (ui.ping) {
      const age = now - ui.ping.t;
      const DUR = 600;
      if (age >= DUR) ui.ping = null;
      else {
        const px = wx(ui.ping.x), py = wy(ui.ping.y);
        const col = ui.ping.kind === 'attack' ? '248,113,113'
          : ui.ping.kind === 'route' ? '56,189,248' : '255,255,255';
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

    // tutorial marker (#185): a persistent slow-pulsing ring on the
    // current step's target — route-blue, above fog like the ping
    if (ui.tutMarker) {
      const PER = 1300;
      const p = (now % PER) / PER;
      const px = wx(ui.tutMarker.x), py = wy(ui.tutMarker.y);
      const base = Math.max(16, (ui.tutMarker.r || 1.5) * s);
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(px, py, base * (0.8 + 0.35 * p), 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(56,189,248,${(0.85 * (1 - p)).toFixed(2)})`;
      ctx.stroke();
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(px, py, base * 0.8, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(56,189,248,0.9)';
      ctx.stroke();
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
    const body = ownerBody(game, b.owner);
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
    // body — team-colored so enemy farmhands read red at a glance (#122)
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fillStyle = ownerBody(game, b.owner);
    ctx.fill();
    // head
    ctx.beginPath();
    ctx.arc(px, py - r * 1.1, r * 0.55, 0, Math.PI * 2);
    ctx.fillStyle = b.owner === viewer(game) ? '#86efac' : '#fca5a5';
    ctx.fill();
  }

  // a burnt-out 2×2 plot: charcoal fill, broken grey outline, 🏚️ when
  // zoomed in. No owner tint, no bars, no chips — ruins are scenery (#106).
  function drawRuin(r, wx, wy, s, visible) {
    const x0 = wx(r.x), y0 = wy(r.y);
    const size = 2 * s;
    ctx.globalAlpha = visible ? 0.9 : 0.4;
    ctx.fillStyle = '#27272a';
    ctx.fillRect(x0, y0, size, size);
    ctx.strokeStyle = '#52525b';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 3]);
    ctx.strokeRect(x0, y0, size, size);
    ctx.setLineDash([]);
    if (s >= 5) {
      const fs = Math.max(10, Math.min(22, s * 0.9));
      ctx.font = `${fs}px system-ui`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('🏚️', x0 + size / 2, y0 + size / 2);
    }
    ctx.globalAlpha = 1;
  }

  function drawSettlement(game, st, wx, wy, s, ghost, sel, workingN) {
    // fills the 2×2 footprint exactly: a plain square keep — no roof
    // triangle (#67) — with unit counts inside in a loose triangle (#40)
    const x0 = wx(st.x), y0 = wy(st.y);
    const size = 2 * s;
    const cx = x0 + size / 2, cy = y0 + size / 2;
    const hit = !ghost && st.lastHitT != null && game.tick - st.lastHitT < 3;
    const building = !ghost && st.building;
    // construction sites (#95) read as scaffolding: translucent body,
    // dashed outline, a 🔨 instead of the garrison chips, amber bar
    ctx.globalAlpha = ghost ? 0.4 : building ? 0.7 : 1;
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
    if (building) ctx.setLineDash([5, 4]);
    ctx.strokeRect(x0, y0, size, size);
    ctx.setLineDash([]);
    // siege state (#108): amber dashed halo + ⏳ — income cut, deliveries
    // blocked, the stockpile is the clock. Visible to both players.
    if (!ghost && !building && S.besieged(game, st)) {
      ctx.strokeStyle = '#fbbf24';
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(x0 - 3, y0 - 3, size + 6, size + 6);
      ctx.setLineDash([]);
      if (s >= 6) {
        ctx.font = `${Math.max(9, Math.min(16, s * 0.7))}px system-ui`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('⏳', x0 + size, y0 - 2);
      }
    }
    if (building && s >= 5) {
      const fs = Math.max(10, Math.min(22, s * 0.9));
      ctx.font = `${fs}px system-ui`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('🔨', cx, cy);
    }
    // unit counts inside, loose triangle: ⚔️ upper-left, 🚚 upper-right,
    // 🌱 (garrisoned + working the fields) bottom-center; own settlements
    // also show the 🌾 stockpile top-center (#86 — the enemy's stays private)
    if (!ghost && !building && st.garrison && s >= 8) {
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
    // health / production bars just below the plot — amber while under
    // construction, so the fill reads as build progress (#95)
    let barY = y0 + size + 2;
    if (!ghost && st.hp < S.C.SETT_HP) {
      ctx.fillStyle = '#111827';
      ctx.fillRect(x0, barY, size, 4);
      ctx.fillStyle = building ? '#fbbf24' : '#f87171';
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
    // name plate above the keep — every settlement wears its name; ghosts
    // keep the last-seen name from the viewer's memory
    if (st.name && s >= 5) {
      const nfs = Math.max(9, Math.min(13, s * 0.55));
      ctx.font = `600 ${nfs}px system-ui`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const ny = y0 - nfs * 0.9;
      const ntw = ctx.measureText(st.name).width;
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fillRect(cx - ntw / 2 - 3, ny - nfs * 0.7, ntw + 6, nfs * 1.4);
      ctx.fillStyle = ghost ? '#a1a1aa' : '#e4e4e7';
      ctx.fillText(st.name, cx, ny);
    }
    // garrison arm-up progress (#108, own settlements only)
    if (!ghost && st.owner === viewer(game) && st.convert) {
      const p = Math.max(0, Math.min(1, 1 - (st.convert.done - game.tick) / S.C.CONVERT_TICKS));
      ctx.fillStyle = '#111827';
      ctx.fillRect(x0, barY, size, 3);
      ctx.fillStyle = '#f59e0b';
      ctx.fillRect(x0, barY, size * p, 3);
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
    // ruins: dim grey dots on explored ground, under the settlement dots
    mctx.fillStyle = 'rgba(82,82,91,0.5)';
    for (const r of game.ruins || []) {
      if (game.fog[r.y * game.map.w + r.x] === 0) continue;
      mctx.fillRect((r.x + 1) * sx - 2, (r.y + 1) * sy - 2, 4, 4);
    }
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
      mctx.fillRect(b.x * sx - 2, b.y * sy - 2, 4, 4);
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
