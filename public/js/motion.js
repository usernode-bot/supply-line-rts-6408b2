// Frame-rate-independent easing used by the renderer's two smoothing jobs
// (#247, #251). Pure functions, no DOM and no sim import, so the physics can be
// asserted headlessly (see test/motion.mjs) — the same discipline pick.js and
// formation.js follow. render.js is a canvas module and can't be imported in
// Node, which is exactly why this arithmetic lives out here.
//
// Everything is expressed as a TIME CONSTANT in ms rather than a per-frame
// fraction: `a += (t - a) * 0.2` settles in half the wall-clock time at 120 Hz
// that it does at 60, so a per-frame factor makes the game's motion depend on
// the display. `1 - exp(-dt / tau)` doesn't.

// Ease `a` toward `t`. After `tau` ms about 63% of the gap is closed; ~3×tau is
// visually settled.
export function easeToward(a, t, dt, tau) {
  if (!(tau > 0)) return t;
  return a + (t - a) * (1 - Math.exp(-Math.max(0, dt) / tau));
}

// Same, for an angle: takes the SHORT way round, so a group whose facing
// crosses ±π doesn't spin its ranks the long way.
export function easeAngle(a, t, dt, tau) {
  if (!(tau > 0)) return t;
  let d = (t - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * (1 - Math.exp(-Math.max(0, dt) / tau));
}

// A PvP snapshot correction, as a visual offset to ease away (#247).
//
// `was` is where the blob was actually being DRAWN, `now` where the incoming
// authoritative state puts it. The returned offset is applied on top of the new
// state's own interpolation, so the blob starts the frame where the eye left it
// and glides to the truth.
//
// Two cases return null — no offset, draw the authoritative position directly:
//   * a correction under `dead` tiles, which is beneath noticing;
//   * a correction over `max` tiles, where the blob genuinely moved that far
//     and sliding it across the map would be a lie rather than a smoothing.
export function resyncOffset(was, now, max, dead) {
  const dx = was.x - now.x, dy = was.y - now.y;
  const m = max > 0 ? max : Infinity;
  if (Math.abs(dx) > m || Math.abs(dy) > m) return null;
  const d = dead >= 0 ? dead : 0;
  if (Math.abs(dx) <= d && Math.abs(dy) <= d) return null;
  return { dx, dy };
}

// Drain a spread-over-frames catch-up (#247): how many extra sim ticks to run
// this frame, and what's left owed. Correcting a whole second of drift in one
// frame is the jerk the issue reports; a couple of ticks a frame is invisible.
export function drainCatchUp(owed, perFrame) {
  const left = Math.max(0, Math.floor(owed) || 0);
  const step = Math.max(1, Math.floor(perFrame) || 1);
  const run = Math.min(step, left);
  return { run, left: left - run };
}

// Keep an accumulator's PHASE when dropping a backlog. Zeroing it snapped the
// renderer's interpolation alpha to 0 every time the frame loop overran, which
// is its own visible stutter; the remainder is the phase within the tick and
// carrying it is free.
export function dropBacklog(acc, tickMs) {
  const t = tickMs > 0 ? tickMs : 100;
  if (!(acc >= t)) return acc;
  return acc % t;
}
