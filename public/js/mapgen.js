// Map generation: seeded value-noise fertility + ridged-noise mountains,
// mirrored 180° for fairness. Also hosts grid utilities (A*, LOS-free
// distance helpers) shared by sim and supply logic.

export function hashSeed(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return (h ^= h >>> 16) >>> 0;
}

export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const MAP_SIZES = { small: 72, medium: 96, large: 128 };

// Fertility is presented as exactly five tiers. Generation quantizes to
// multiples of 0.25; pillage/regen drift fractionally in between, so
// display code maps back through fertTier().
export const FERT_TIERS = ['Barren', 'Sparse', 'Fair', 'Fertile', 'Lush'];
export function fertTier(f) { return Math.max(0, Math.min(4, Math.round(f * 4))); }

// -- value noise ------------------------------------------------------

function makeNoise(rng, w, h, freq) {
  const gw = Math.ceil(w * freq) + 2, gh = Math.ceil(h * freq) + 2;
  const grid = new Float32Array(gw * gh);
  for (let i = 0; i < grid.length; i++) grid[i] = rng();
  return (x, y) => {
    const fx = x * freq, fy = y * freq;
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const tx = fx - x0, ty = fy - y0;
    const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
    const a = grid[y0 * gw + x0], b = grid[y0 * gw + x0 + 1];
    const c = grid[(y0 + 1) * gw + x0], d = grid[(y0 + 1) * gw + x0 + 1];
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  };
}

// -- generation -------------------------------------------------------

export function generateMap(seedStr, sizeKey) {
  const w = MAP_SIZES[sizeKey] || MAP_SIZES.medium;
  const h = w;
  const rng = mulberry32(hashSeed(seedStr));
  const n1 = makeNoise(rng, w, h, 1 / 16);
  const n2 = makeNoise(rng, w, h, 1 / 8);
  const n3 = makeNoise(rng, w, h, 1 / 4);
  const m1 = makeNoise(rng, w, h, 1 / 12);
  const m2 = makeNoise(rng, w, h, 1 / 5);

  const fert = new Float32Array(w * h);
  const ridge = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const f = 0.55 * n1(x, y) + 0.3 * n2(x, y) + 0.15 * n3(x, y);
      fert[i] = Math.min(1, Math.max(0, (f - 0.15) / 0.7));
      const r = 1 - Math.abs(2 * (0.7 * m1(x, y) + 0.3 * m2(x, y)) - 1);
      ridge[i] = r;
    }
  }

  // Mountains: pick a ridge threshold hitting ~13% coverage.
  const sorted = Float32Array.from(ridge).sort();
  const thresh = sorted[Math.floor(sorted.length * 0.87)];
  const mountain = new Uint8Array(w * h);
  for (let i = 0; i < mountain.length; i++) mountain[i] = ridge[i] >= thresh ? 1 : 0;

  // Mirror by 180° rotation so both halves are identical terrain.
  const half = Math.floor((w * h) / 2);
  for (let i = 0; i < half; i++) {
    const j = w * h - 1 - i;
    fert[j] = fert[i];
    mountain[j] = mountain[i];
  }

  // Start locations at opposite quadrant centers, cleared and fertile.
  const starts = [
    { x: Math.floor(w * 0.25), y: Math.floor(h * 0.25) },
    { x: Math.floor(w * 0.75), y: Math.floor(h * 0.75) },
  ];
  for (const s of starts) {
    for (let dy = -6; dy <= 6; dy++) {
      for (let dx = -6; dx <= 6; dx++) {
        const x = s.x + dx, y = s.y + dy;
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        if (dx * dx + dy * dy > 36) continue;
        const i = y * w + x;
        mountain[i] = 0;
        if (fert[i] < 0.55) fert[i] = 0.55 + 0.2 * ((dx * 31 + dy * 17 + 100) % 10) / 10;
      }
    }
  }

  // Guarantee the two starts connect: flood fill, carve a pass if not.
  if (!connected(w, h, mountain, starts[0], starts[1])) {
    carveLine(w, h, mountain, starts[0], starts[1]);
  }

  // Quantize fertility to the five tiers (multiples of 0.25) so one
  // pillage pass burns exactly one visible level.
  for (let i = 0; i < fert.length; i++) fert[i] = fertTier(fert[i]) / 4;

  const orig = Float32Array.from(fert);
  return { w, h, fert, orig, mountain, starts, seed: seedStr, sizeKey };
}

function connected(w, h, mountain, a, b) {
  const seen = new Uint8Array(w * h);
  const stack = [a.y * w + a.x];
  seen[stack[0]] = 1;
  const target = b.y * w + b.x;
  while (stack.length) {
    const i = stack.pop();
    if (i === target) return true;
    const x = i % w, y = (i / w) | 0;
    if (x > 0 && !seen[i - 1] && !mountain[i - 1]) { seen[i - 1] = 1; stack.push(i - 1); }
    if (x < w - 1 && !seen[i + 1] && !mountain[i + 1]) { seen[i + 1] = 1; stack.push(i + 1); }
    if (y > 0 && !seen[i - w] && !mountain[i - w]) { seen[i - w] = 1; stack.push(i - w); }
    if (y < h - 1 && !seen[i + w] && !mountain[i + w]) { seen[i + w] = 1; stack.push(i + w); }
  }
  return false;
}

function carveLine(w, h, mountain, a, b) {
  let x = a.x, y = a.y;
  const dx = Math.abs(b.x - a.x), dy = Math.abs(b.y - a.y);
  const sx = a.x < b.x ? 1 : -1, sy = a.y < b.y ? 1 : -1;
  let err = dx - dy;
  while (true) {
    for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
      const cx = x + ox, cy = y + oy;
      if (cx >= 0 && cy >= 0 && cx < w && cy < h) mountain[cy * w + cx] = 0;
    }
    if (x === b.x && y === b.y) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x += sx; }
    if (e2 < dx) { err += dx; y += sy; }
  }
}

// -- grid helpers -----------------------------------------------------

export function inBounds(map, x, y) {
  return x >= 0 && y >= 0 && x < map.w && y < map.h;
}
export function passable(map, x, y) {
  return inBounds(map, x, y) && !map.mountain[y * map.w + x];
}
// Fog-aware passability: tiles never seen (fog === 0) are optimistically
// assumed passable; explored tiles use real terrain. `fog` may be null
// for omniscient callers (the AI knows terrain by design). `blocked` is
// an optional Set of tile indices treated as impassable (known enemy
// settlement tiles) — checked before fog optimism, since it only ever
// contains tiles the mover already knows about.
function fogPassable(map, fog, x, y, blocked) {
  if (!inBounds(map, x, y)) return false;
  const i = y * map.w + x;
  if (blocked && blocked.has(i)) return false;
  if (fog && fog[i] === 0) return true;
  return !map.mountain[i];
}
export function dist(ax, ay, bx, by) {
  const dx = ax - bx, dy = ay - by;
  return Math.sqrt(dx * dx + dy * dy);
}

// A* on the tile grid, 8-directional with corner-cut prevention.
// Returns array of {x, y} tile-center waypoints (excluding start), or null.
export function findPath(map, sx, sy, tx, ty, fog, blocked) {
  sx = clampT(map, sx); sy = clampT(map, sy); tx = clampT(map, tx); ty = clampT(map, ty);
  const { w, h } = map;
  if (!fogPassable(map, fog, tx, ty, blocked)) {
    const alt = nearestPassable(map, tx, ty, 6, fog, blocked);
    if (!alt) return null;
    tx = alt.x; ty = alt.y;
  }
  if (!fogPassable(map, fog, sx, sy, blocked)) {
    const alt = nearestPassable(map, sx, sy, 6, fog, blocked);
    if (!alt) return null;
    sx = alt.x; sy = alt.y;
  }
  const start = sy * w + sx, goal = ty * w + tx;
  if (start === goal) return [{ x: tx + 0.5, y: ty + 0.5 }];
  const g = new Float32Array(w * h).fill(Infinity);
  const came = new Int32Array(w * h).fill(-1);
  const closed = new Uint8Array(w * h);
  g[start] = 0;
  // simple binary heap of [f, idx]
  const heap = [[octile(sx, sy, tx, ty), start]];
  const push = (f, i) => {
    heap.push([f, i]);
    let c = heap.length - 1;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (heap[p][0] <= heap[c][0]) break;
      [heap[p], heap[c]] = [heap[c], heap[p]]; c = p;
    }
  };
  const pop = () => {
    const top = heap[0], last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let c = 0;
      while (true) {
        const l = 2 * c + 1, r = l + 1;
        let m = c;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === c) break;
        [heap[m], heap[c]] = [heap[c], heap[m]]; c = m;
      }
    }
    return top;
  };
  const DIRS = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, 1.414], [1, -1, 1.414], [-1, 1, 1.414], [-1, -1, 1.414]];
  let expansions = 0;
  while (heap.length) {
    const [, cur] = pop();
    if (closed[cur]) continue;
    closed[cur] = 1;
    if (cur === goal) break;
    if (++expansions > 20000) return null;
    const cx = cur % w, cy = (cur / w) | 0;
    for (const [dx, dy, cost] of DIRS) {
      const nx = cx + dx, ny = cy + dy;
      if (!fogPassable(map, fog, nx, ny, blocked)) continue;
      // no cutting corners past a mountain
      if (dx && dy && (!fogPassable(map, fog, cx + dx, cy, blocked) || !fogPassable(map, fog, cx, cy + dy, blocked))) continue;
      const ni = ny * w + nx;
      if (closed[ni]) continue;
      const ng = g[cur] + cost;
      if (ng < g[ni]) {
        g[ni] = ng;
        came[ni] = cur;
        push(ng + octile(nx, ny, tx, ty), ni);
      }
    }
  }
  if (came[goal] === -1 && start !== goal) return null;
  const path = [];
  let cur = goal;
  while (cur !== start && cur !== -1) {
    path.push({ x: (cur % w) + 0.5, y: ((cur / w) | 0) + 0.5 });
    cur = came[cur];
  }
  path.reverse();
  // light smoothing: drop collinear waypoints
  const out = [];
  for (let i = 0; i < path.length; i++) {
    if (i > 0 && i < path.length - 1) {
      const a = path[i - 1], b = path[i], c = path[i + 1];
      if ((b.x - a.x) === (c.x - b.x) && (b.y - a.y) === (c.y - b.y)) continue;
    }
    out.push(path[i]);
  }
  return out;
}

function octile(ax, ay, bx, by) {
  const dx = Math.abs(ax - bx), dy = Math.abs(ay - by);
  return Math.max(dx, dy) + 0.414 * Math.min(dx, dy);
}

function clampT(map, v) {
  return Math.max(0, Math.min(map.w - 1, Math.floor(v)));
}

export function nearestPassable(map, x, y, r, fog, blocked) {
  for (let rad = 0; rad <= r; rad++) {
    for (let dy = -rad; dy <= rad; dy++) {
      for (let dx = -rad; dx <= rad; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== rad) continue;
        if (fogPassable(map, fog || null, x + dx, y + dy, blocked)) {
          return { x: x + dx, y: y + dy };
        }
      }
    }
  }
  return null;
}
