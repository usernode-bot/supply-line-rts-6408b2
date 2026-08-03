// Army formation geometry (#251). Pure functions, no DOM and no sim import,
// so the rules that decide where each figure stands are testable headlessly
// (see test/formation.mjs) — same discipline as pick.js.
//
// The old renderer scattered a group's figures on a golden-angle spiral, so a
// 30-unit army read as speckle and a mixed force looked exactly like a pure
// one. Everything here answers three questions instead:
//
//   how many rows, and how wide      -> rowSplit
//   which roles share a block, and   -> groups
//     in what order front-to-back
//   where does slot (row, col) land  -> layout / fitPitch
//
// Coordinates are LOCAL and UNROTATED: +x is along a row, +y is toward the
// REAR. The renderer rotates them by the group's facing, so this module never
// has to know which way is north.

// The issue's hard ceiling. Rows only actually reach it in armies of ~30+;
// small discs narrow further via fitCols() below, because ten figures across
// a 60 px disc is two pixels each and reads as texture, not soldiers.
export const MAX_PER_ROW = 10;

// Figure size band the old spiral used, kept so nothing shrinks or grows
// relative to today at the same zoom.
export const FIG_MIN = 1.5;
export const FIG_MAX = 4;

// The block is fitted inside this fraction of the drawn blob radius, leaving
// the health band, the dashed fed ring and the count badge their room.
export const FIT = 0.78;

// Extra depth between two role blocks, in rows.
export const BLOCK_GAP = 0.6;

// Split `n` figures into rows, front row first.
//
//   1. at least ceil(n / maxPerRow) rows, plus a depth target of
//      round(sqrt(n / 3)) so a 10-unit group stands 5/5 instead of drawing a
//      flat ten-wide line;
//   2. never more than floor(n / 2) rows, which is what guarantees no row
//      holds a single figure once n >= 2;
//   3. the front `n % rows` rows get one extra, so front rows stay full and
//      each row back has the same count or one fewer.
//
// `wide` drops the depth target: a block that is one of SEVERAL stacked blocks
// spends its rows on the whole group's depth, so it packs as few rows as the
// cap allows and the column stays wider than it is deep.
export function rowSplit(n, maxPerRow, wide) {
  const total = Math.max(0, Math.floor(n));
  if (total <= 0) return [];
  const cap = Math.max(1, Math.floor(maxPerRow || MAX_PER_ROW));
  if (total === 1) return [1];
  let rows = wide
    ? Math.ceil(total / cap)
    : Math.max(Math.ceil(total / cap), Math.round(Math.sqrt(total / 3)));
  rows = Math.min(rows, Math.max(1, Math.floor(total / 2)));
  rows = Math.max(1, rows);
  // a cap so tight that floor(n/2) rows still can't hold everyone (n > 2*cap
  // with cap 2, say) has to widen the row count back out — correctness of
  // "every figure gets a slot" beats the no-lonely-row preference.
  rows = Math.max(rows, Math.ceil(total / cap));
  const base = Math.floor(total / rows);
  const rem = total % rows;
  const out = [];
  for (let i = 0; i < rows; i++) out.push(base + (i < rem ? 1 : 0));
  return out;
}

// The role blocks of one group, front to back, from a sim `count` object.
// Attack units bracket the column when there is anything to protect: the
// front rank and the rear guard are both attackers, suppliers and farmhands
// ride in between. Splitting below 4 attackers would leave a block of one, so
// it doesn't; a pure-attack army is one block.
export function groups(counts) {
  const deploy = Math.max(0, Math.floor((counts && counts.deploy) || 0));
  const supply = Math.max(0, Math.floor((counts && counts.supply) || 0));
  const farm = Math.max(0, Math.floor((counts && counts.farm) || 0));
  const others = supply + farm;
  const out = [];
  if (deploy > 0 && others > 0 && deploy >= 4) {
    out.push({ role: 'deploy', n: Math.ceil(deploy / 2) });
    if (supply > 0) out.push({ role: 'supply', n: supply });
    if (farm > 0) out.push({ role: 'farm', n: farm });
    out.push({ role: 'deploy', n: Math.floor(deploy / 2) });
    return out;
  }
  if (deploy > 0) out.push({ role: 'deploy', n: deploy });
  if (supply > 0) out.push({ role: 'supply', n: supply });
  if (farm > 0) out.push({ role: 'farm', n: farm });
  return out;
}

// How wide a row may be inside a disc of `rPx`: the hard 10 ceiling, narrowed
// so a figure never has to draw below `minPitch` screen px of elbow room.
export function fitCols(rPx, minPitch) {
  const usable = 2 * FIT * Math.max(0, rPx);
  const pitch = Math.max(1, minPitch || 4);
  return Math.max(2, Math.min(MAX_PER_ROW, Math.floor(usable / pitch) || 2));
}

// Slot list for a whole group, ordered REAR FIRST so the caller can just draw
// in order and have front ranks overlap the ones behind them.
//
// Each slot: { role, block, row, col, rowWidth, depth, x, y }
//   depth  rows from the front, counted across every block (0 = front rank),
//          which is what the renderer dims by
//   x, y   position in PITCH units — x along the row (centred on 0), y toward
//          the rear (0 = front rank). Multiply by pitchX / pitchY.
export function layout(counts, maxPerRow) {
  const blocks = groups(counts);
  const cap = Math.max(1, Math.floor(maxPerRow || MAX_PER_ROW));
  // several blocks already give the group its depth, so each one packs wide
  const wide = blocks.length > 1;
  const slots = [];
  let depth = 0;
  for (let bi = 0; bi < blocks.length; bi++) {
    const block = blocks[bi];
    if (block.n <= 0) continue;
    if (bi > 0) depth += BLOCK_GAP;
    const rows = rowSplit(block.n, cap, wide);
    for (let r = 0; r < rows.length; r++) {
      const w = rows[r];
      // shorter rows sit centred; a half-pitch nudge on odd/even rows keeps
      // the block from reading as a perfect grid
      const stagger = (r % 2 === 1) ? 0.25 : 0;
      for (let c = 0; c < w; c++) {
        slots.push({
          role: block.role, block: bi, row: r, col: c, rowWidth: w,
          depth: depth + r,
          x: (c - (w - 1) / 2) + stagger,
          y: depth + r,
        });
      }
    }
    depth += rows.length;
  }
  // total depth spans [0, maxY]; recentre so the block sits on the disc's
  // middle instead of hanging off the back
  let maxY = 0;
  for (const s of slots) if (s.y > maxY) maxY = s.y;
  for (const s of slots) s.y -= maxY / 2;
  // rear first
  slots.sort((a, b) => b.y - a.y || a.col - b.col);
  return slots;
}

// Pitch (px between neighbours) and figure radius that fit a `cols` wide,
// `rowSpan` deep block inside a disc of `rPx`. Both axes are solved against
// FIT * rPx with half a slot of margin, so the widest row's outer edge — its
// centre offset plus one figure radius — stays inside the fit circle. Ranks
// stand closer front-to-back (0.85) than shoulder-to-shoulder.
export function fitPitch(rPx, cols, rowSpan) {
  const half = FIT * Math.max(0, rPx);
  const c = Math.max(1, cols);
  const rs = Math.max(0, rowSpan);
  const pitchX = 2 * half / (c + 0.5);
  const pitchY = 2 * half * 0.85 / (rs + 1.5);
  const figR = Math.max(FIG_MIN, Math.min(FIG_MAX, Math.min(pitchX, pitchY) * 0.42));
  return { pitchX, pitchY, figR };
}

// The deterministic order figures take their slots in: role block first, then
// unit seed. NEVER array index — deserialize() re-sorts b.units by seed, so an
// index-based formation would reshuffle on every PvP snapshot and every
// resume. `units` is not mutated.
const ROLE_RANK = { deploy: 0, supply: 1, farm: 2 };
export function orderUnits(units) {
  return units.slice().sort((a, z) => {
    const ra = ROLE_RANK[a.role] == null ? 3 : ROLE_RANK[a.role];
    const rz = ROLE_RANK[z.role] == null ? 3 : ROLE_RANK[z.role];
    if (ra !== rz) return ra - rz;
    return a.seed - z.seed;
  });
}

// Pair the ordered units with the ordered slots. Slots come out of layout()
// rear-first, so they're grouped back into per-role queues and handed out in
// (block order, seed) order — the front deploy block fills before the rear
// one, and within a block the same seeds always land on the same slot.
export function assign(units, maxPerRow) {
  const ordered = orderUnits(units);
  const counts = { deploy: 0, supply: 0, farm: 0 };
  for (const u of ordered) if (counts[u.role] != null) counts[u.role]++;
  const slots = layout(counts, maxPerRow);
  // per-role slot queues in block/row/col order (front block first)
  const byRole = { deploy: [], supply: [], farm: [] };
  const forward = slots.slice().sort((a, b) =>
    a.block - b.block || a.row - b.row || a.col - b.col);
  for (const s of forward) if (byRole[s.role]) byRole[s.role].push(s);
  const out = [];
  const cursor = { deploy: 0, supply: 0, farm: 0 };
  for (const u of ordered) {
    const q = byRole[u.role];
    if (!q) continue;
    const s = q[cursor[u.role]++];
    if (!s) continue;
    out.push({ unit: u, slot: s });
  }
  // rear first, so the caller draws back ranks before front ones
  out.sort((a, b) => b.slot.y - a.slot.y || a.slot.col - b.slot.col);
  return out;
}
