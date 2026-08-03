// Headless tests for the renderer's smoothing physics (#247, #251). Run:
//   node test/motion.mjs
// public/js/motion.js is deliberately DOM-free so the arithmetic behind "a PvP
// correction glides instead of jerking" is assertable without a browser (and a
// live PvP match, which no test harness can stage). What's being locked in:
// easing that does NOT depend on frame rate, angles that turn the short way,
// corrections that snap when they're real movement rather than jitter, and a
// catch-up that can't dump a second of drift into one frame.

import {
  easeToward, easeAngle, resyncOffset, drainCatchUp, dropBacklog,
} from '../public/js/motion.js';

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

console.log('easing settles in wall-clock time, not frames:');
{
  const tau = 100;
  // 60 Hz and 240 Hz must arrive at the same place after the same 200 ms
  const run = (steps, total) => {
    let a = 0;
    for (let i = 0; i < steps; i++) a = easeToward(a, 1, total / steps, tau);
    return a;
  };
  const slow = run(12, 200);    // ~60 fps
  const fast = run(48, 200);    // ~240 fps
  check('60 Hz and 240 Hz agree after 200 ms', near(slow, fast, 0.01),
    `${slow.toFixed(4)} vs ${fast.toFixed(4)}`);
  check('one tau closes about 63% of the gap',
    near(easeToward(0, 1, tau, tau), 1 - Math.exp(-1), 1e-9),
    String(easeToward(0, 1, tau, tau)));
  check('three tau is visually settled', easeToward(0, 1, 3 * tau, tau) > 0.95);
  check('a zero-length frame moves nothing', easeToward(0.3, 1, 0, tau) === 0.3);
  check('it never overshoots the target', easeToward(0, 1, 100000, tau) <= 1);
  check('it works downhill too', easeToward(1, 0, tau, tau) < 1);
  check('a zero time constant snaps', easeToward(0, 5, 16, 0) === 5);
  check('a negative frame time is treated as zero', easeToward(0.3, 1, -50, tau) === 0.3);
}

console.log('angles turn the short way:');
{
  const tau = 100;
  const PI = Math.PI;
  // from just under +π to just over -π is a 0.2 rad step, not a 6.1 rad spin
  const a = easeAngle(PI - 0.1, -PI + 0.1, tau, tau);
  check('crossing +/-pi steps forward, not backward', a > PI - 0.1,
    `${a.toFixed(4)} vs start ${(PI - 0.1).toFixed(4)}`);
  check('...and by less than the wrapped distance', a - (PI - 0.1) < 0.2);
  const b = easeAngle(0, PI / 2, tau, tau);
  check('an ordinary turn eases toward the target', b > 0 && b < PI / 2, String(b));
  const c = easeAngle(0, -PI / 2, tau, tau);
  check('and turns the other way when asked', c < 0 && c > -PI / 2, String(c));
  check('no turn means no movement', near(easeAngle(1.2, 1.2, tau, tau), 1.2));
  // a full-circle-equivalent target is not a turn at all
  check('a 2pi-equivalent target does not spin',
    near(easeAngle(0.5, 0.5 + Math.PI * 2, tau, tau), 0.5, 1e-9),
    String(easeAngle(0.5, 0.5 + Math.PI * 2, tau, tau)));
}

console.log('a snapshot correction glides only when it IS a correction:');
{
  const MAX = 3, DEAD = 0.01;
  const small = resyncOffset({ x: 10.4, y: 8.1 }, { x: 10.0, y: 8.0 }, MAX, DEAD);
  check('a sub-tile correction produces an offset', !!small);
  check('...pointing from the new position back to the drawn one',
    small && near(small.dx, 0.4, 1e-9) && near(small.dy, 0.1, 1e-9), JSON.stringify(small));
  check('a correction beyond the cap snaps instead (real movement)',
    resyncOffset({ x: 30, y: 8 }, { x: 10, y: 8 }, MAX, DEAD) === null);
  check('the cap applies per axis',
    resyncOffset({ x: 10.2, y: 40 }, { x: 10, y: 8 }, MAX, DEAD) === null);
  check('a correction under the dead zone is ignored',
    resyncOffset({ x: 10.005, y: 8 }, { x: 10, y: 8 }, MAX, DEAD) === null);
  check('an exactly-zero correction is ignored',
    resyncOffset({ x: 10, y: 8 }, { x: 10, y: 8 }, MAX, DEAD) === null);
  check('a correction exactly at the cap still glides',
    !!resyncOffset({ x: 13, y: 8 }, { x: 10, y: 8 }, MAX, DEAD));

  // and the offset decays to nothing — the blob ends up on the truth
  // 0.02 tiles is a quarter of a pixel at the default zoom — below that the
  // renderer drops the offset entirely
  let off = resyncOffset({ x: 10.9, y: 8 }, { x: 10, y: 8 }, MAX, DEAD);
  let frames = 0;
  while (Math.abs(off.dx) > 0.02 && frames < 600) {
    off.dx = easeToward(off.dx, 0, 16, 90);
    frames++;
  }
  check('it decays away within ~400 ms', frames > 0 && frames * 16 < 400,
    `${frames} frames (${frames * 16} ms)`);
  check('and lands on the authoritative position', Math.abs(off.dx) <= 0.02);
}

console.log('catch-up is spread across frames:');
{
  const d1 = drainCatchUp(25, 2);
  check('a 25-tick correction runs 2 ticks now', d1.run === 2, JSON.stringify(d1));
  check('...and still owes 23', d1.left === 23);
  // the whole backlog drains, and never in one frame
  let owed = 25, frames = 0, worst = 0;
  while (owed > 0 && frames < 100) {
    const d = drainCatchUp(owed, 2);
    worst = Math.max(worst, d.run);
    owed = d.left;
    frames++;
  }
  check('the backlog fully drains', owed === 0, `${owed} left after ${frames} frames`);
  check('no single frame ran more than the per-frame bound', worst === 2, String(worst));
  check('it takes several frames, which is the whole point', frames >= 13, String(frames));
  check('a smaller debt than the bound runs exactly the debt',
    drainCatchUp(1, 2).run === 1 && drainCatchUp(1, 2).left === 0);
  check('nothing owed runs nothing', drainCatchUp(0, 2).run === 0);
  check('a negative debt is not a credit', drainCatchUp(-5, 2).run === 0);
}

console.log('dropping a backlog keeps the interpolation phase:');
{
  check('an overrun keeps its remainder', near(dropBacklog(2340, 100), 40));
  check('...instead of snapping the phase to zero', dropBacklog(2340, 100) !== 0);
  check('an in-range accumulator is untouched', dropBacklog(73, 100) === 73);
  check('an exact multiple lands on zero', dropBacklog(300, 100) === 0);
  check('a negative accumulator is left alone', dropBacklog(-5, 100) === -5);
}

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall motion checks passed');
