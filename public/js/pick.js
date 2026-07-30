// Hit-test geometry (#224). Pure functions, no DOM and no sim import, so
// the picking rules a tap actually resolves with are testable headlessly
// (see test/pick.mjs).
//
// The old rules grabbed with a slack of `24 / view.scale` world units,
// which is 0.25 tiles zoomed right in but 6–8 tiles zoomed right out —
// so at far zoom a tap landed on whatever happened to be nearest within
// several tiles. Everything here is instead anchored on what the
// RENDERER draws, plus one fixed screen-space forgiveness band, so tap
// precision equals visual precision at every zoom.

// Forgiveness band in world units: 8 CSS px (the same slop input.js uses
// to tell a tap from a drag), capped at about a third of a tile so far
// zoom can never reopen the multi-tile grab.
export const PICK_SLOP_PX = 8;
export const PICK_TOL_MAX = 0.35;

export function pickTol(scale) {
  const s = scale > 0 ? scale : 1;
  return Math.min(PICK_TOL_MAX, PICK_SLOP_PX / s);
}

// A blob's DRAWN radius in world units — mirrors the renderer's own
// "what you see" helper (`blobPxR` in render.js): a working field hand
// is a small dot (body + head span), everything else is the blob circle
// with the renderer's 10 px floor. `radius` is the sim's blobRadius, so
// this module never has to import sim.js.
export function pickRadius(scale, radius, working) {
  const s = scale > 0 ? scale : 1;
  if (working) return (Math.max(2, s * 0.13) * 2) / s;
  return Math.max(10 / s, radius);
}

// Distance from a point to a settlement's 2×2 footprint RECTANGLE
// ([s.x, s.x+2] × [s.y, s.y+2]) — 0 anywhere on the grounds. The old
// rule measured from the footprint CENTRE against 1.9, which reached
// ~0.9 tiles past the edge onto the neighbouring land.
export function footprintDist(sx, sy, x, y) {
  const dx = sx > x ? sx - x : x > sx + 2 ? x - (sx + 2) : 0;
  const dy = sy > y ? sy - y : y > sy + 2 ? y - (sy + 2) : 0;
  return Math.hypot(dx, dy);
}

// Distance from a point to a single tile's square ([tx, tx+1] × …) —
// the wall analogue of footprintDist.
export function tileDist(tx, ty, x, y) {
  const dx = tx > x ? tx - x : x > tx + 1 ? x - (tx + 1) : 0;
  const dy = ty > y ? ty - y : y > ty + 1 ? y - (ty + 1) : 0;
  return Math.hypot(dx, dy);
}

// How far inside this blob's drawn circle the point (x, y) falls —
// negative means outside. Only used for the hit TEST; candidates are
// ranked by centre distance (below), not by depth: ranking by depth
// would hand every tap inside a 2.2-tile stack to the stack, even one
// aimed squarely at a lone scout standing on top of it.
export function blobOverlap(scale, blob, x, y) {
  const r = pickRadius(scale, blob.radius, blob.working);
  return r - Math.hypot(blob.x - x, blob.y - y);
}

export function blobHit(scale, blob, x, y) {
  return blobOverlap(scale, blob, x, y) >= -pickTol(scale);
}
