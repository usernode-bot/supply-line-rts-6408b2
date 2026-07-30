// Headless tests for the hit-test geometry (#224). Run manually:
//   node test/pick.mjs
// public/js/pick.js is deliberately DOM-free and sim-free so the rules a
// tap actually resolves with can be asserted without a browser. What's
// being locked in: a tap on the land beside a settlement selects the
// LAND, a tap on a worked plot reaches the PLOT and not the field hand's
// invisible halo, and the forgiveness band stays a fixed number of
// SCREEN pixels instead of growing to several tiles as you zoom out.

import {
  pickTol, pickRadius, footprintDist, tileDist, blobOverlap, blobHit,
  PICK_SLOP_PX, PICK_TOL_MAX,
} from '../public/js/pick.js';

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// The three zooms that matter: fully zoomed out on a phone (input.js
// clamps minScale to max(3, fit*0.9) — ~3.7 for a 390px-wide phone on a
// 96-tile map), the default, and the 96 px/tile close-up cap.
const SCALES = [3.7, 14, 96];

// The old rule, kept here as the thing being replaced: 24/scale world
// units of slack, plus a 1.9 centre-distance floor for settlements.
const oldHitR = (scale) => 24 / scale;

console.log('the forgiveness band is a fixed screen distance, not a tile distance:');
{
  for (const s of SCALES) {
    const tol = pickTol(s);
    check(`scale ${s}: band is at most ${PICK_TOL_MAX} tiles`, tol <= PICK_TOL_MAX + 1e-9,
      `${tol}`);
    check(`scale ${s}: band is at most ${PICK_SLOP_PX} css px`, tol * s <= PICK_SLOP_PX + 1e-9,
      `${(tol * s).toFixed(2)} px`);
  }
  check('zoomed in, the band is the full 8 px', Math.abs(pickTol(96) - 8 / 96) < 1e-9);
  check('zoomed out, the band clamps instead of reaching whole tiles',
    Math.abs(pickTol(3.7) - PICK_TOL_MAX) < 1e-9, `${pickTol(3.7)}`);
  // the whole point of the change: the old slack was 6.5 tiles here
  check('the old rule grabbed multiple tiles at far zoom (regression guard)',
    oldHitR(3.7) > 6 && pickTol(3.7) < 0.4,
    `old ${oldHitR(3.7).toFixed(2)} vs new ${pickTol(3.7)}`);
  check('a zero/garbage scale never divides by zero', isFinite(pickTol(0)) && pickTol(0) > 0);
}

console.log('\nsettlements are hit on their 2x2 grounds, not a radius past them:');
{
  // a settlement anchored at (10, 10) covers [10, 12] x [10, 12]
  const sx = 10, sy = 10;
  check('the footprint centre is inside', footprintDist(sx, sy, 11, 11) === 0);
  check('each of the four tiles is inside',
    footprintDist(sx, sy, 10.5, 10.5) === 0 && footprintDist(sx, sy, 11.5, 10.5) === 0
    && footprintDist(sx, sy, 10.5, 11.5) === 0 && footprintDist(sx, sy, 11.5, 11.5) === 0);
  // the reported case: 1.4 tiles from the centre is plainly the next tile
  // over, but the old max(1.9, hitR) centre test claimed it
  const p = { x: 11, y: 12.4 }; // 1.4 from centre (11,11), 0.4 past the edge
  check('a point 1.4 tiles from the centre is 0.4 past the grounds',
    Math.abs(footprintDist(sx, sy, p.x, p.y) - 0.4) < 1e-9,
    `${footprintDist(sx, sy, p.x, p.y)}`);
  for (const s of SCALES) {
    check(`scale ${s}: that point misses the settlement`,
      footprintDist(sx, sy, p.x, p.y) > pickTol(s));
  }
  check('the old rule claimed it (regression guard)',
    Math.hypot(p.x - (sx + 1), p.y - (sy + 1)) < 1.9);
  // but the grounds themselves stay tappable at every zoom
  for (const s of SCALES) {
    check(`scale ${s}: a tap just outside the edge still hits (grace band)`,
      footprintDist(sx, sy, 12 + pickTol(s) * 0.5, 11) <= pickTol(s));
  }
  check('the grace band never reaches a whole tile past the grounds',
    footprintDist(sx, sy, 13.01, 11) > pickTol(3.7));
}

console.log('\nwall tiles get the same band (garrison clicks, #222):');
{
  const wx = 20, wy = 7; // one tile: [20, 21] x [7, 8]
  check('the tile centre is inside', tileDist(wx, wy, 20.5, 7.5) === 0);
  check('a near-miss just off the tile is inside the band',
    tileDist(wx, wy, 21 + 0.2, 7.5) <= pickTol(14), `${tileDist(wx, wy, 21.2, 7.5)}`);
  check('the tile NEXT DOOR is still outside the band',
    tileDist(wx, wy, 22.5, 7.5) > pickTol(3.7), `${tileDist(wx, wy, 22.5, 7.5)}`);
  // at the default zoom a wall tile is ~14 px; the 0.35-tile cap binds
  // below ~23 px/tile, so the band is ~5 px there — a meaningful widening
  // of a 14 px target without ever reaching the tile next door
  check('the band widens a 14px tile without reaching the next one',
    pickTol(14) * 14 >= 4 && pickTol(14) * 14 <= PICK_SLOP_PX + 1e-9,
    `${(pickTol(14) * 14).toFixed(2)} px`);
  check('a whole tile away is never inside the band at any zoom',
    SCALES.every(s => tileDist(wx, wy, wx + 2.5, wy + 0.5) > pickTol(s)));
}

console.log('\nblobs are hit inside the circle the renderer draws:');
{
  // render.js: blobPxR = working ? max(2, s*0.13)*2 : max(10, blobRadius*s)
  const drawnPx = (s, radius, working) =>
    working ? Math.max(2, s * 0.13) * 2 : Math.max(10, radius * s);
  for (const s of SCALES) {
    for (const [radius, working] of [[0.4, true], [0.4, false], [1.86, false], [2.2, false]]) {
      const world = pickRadius(s, radius, working);
      check(`scale ${s}, r=${radius}${working ? ' (field hand)' : ''}: pick radius === drawn radius`,
        Math.abs(world * s - drawnPx(s, radius, working)) < 1e-6,
        `${(world * s).toFixed(3)} px vs drawn ${drawnPx(s, radius, working).toFixed(3)} px`);
    }
  }
  // a 40-unit stack: blobRadius = 0.35*sqrt(40)+0.3 = 2.513 -> clamped 2.2
  const stackR = Math.max(0.4, Math.min(2.2, 0.35 * Math.sqrt(40) + 0.3));
  for (const s of SCALES) {
    const reach = pickRadius(s, stackR, false) + pickTol(s);
    check(`scale ${s}: a 40-unit stack reaches its drawn circle + 8 px`,
      Math.abs(reach * s - (drawnPx(s, stackR, false) + Math.min(PICK_SLOP_PX, PICK_TOL_MAX * s))) < 1e-6,
      `${(reach * s).toFixed(2)} px`);
  }
}

console.log('\na field hand no longer swallows taps meant for its plot:');
{
  // one working farmer at the centre of the tile it works
  const hand = { x: 40.5, y: 12.5, radius: 0.4, working: true };
  // Screen-relative, because that's what the fix promises: a tap misses
  // the hand once it is further away than the dot you can see plus the
  // band. (In world tiles the reach VARIES with zoom, and must — at
  // scale 3.7 a tile is under 4 px, so the renderer's own 2 px dot floor
  // legitimately covers more than a tile. Asserting a fixed tile
  // distance there would be asserting against the renderer.)
  for (const s of SCALES) {
    const reachPx = (pickRadius(s, hand.radius, true) + pickTol(s)) * s;
    const missPx = reachPx + 2;
    check(`scale ${s}: a tap ${missPx.toFixed(0)} px away misses the hand (tile wins)`,
      !blobHit(s, hand, hand.x + missPx / s, hand.y),
      `overlap ${blobOverlap(s, hand, hand.x + missPx / s, hand.y)}`);
    // ...but the dot itself is still tappable
    check(`scale ${s}: a tap on the dot still selects the hand`,
      blobHit(s, hand, hand.x, hand.y));
    check(`scale ${s}: the hand's whole reach is at most ${PICK_SLOP_PX} px past the dot`,
      reachPx - pickRadius(s, hand.radius, true) * s <= PICK_SLOP_PX + 1e-9);
  }
  // the reported case at the zooms where a tile is actually aimable
  for (const s of [14, 96]) {
    check(`scale ${s}: a tap 0.8 tiles away misses the hand (fertility reachable)`,
      !blobHit(s, hand, hand.x + 0.8, hand.y));
    check(`scale ${s}: a tap on the neighbouring tile misses the hand`,
      !blobHit(s, hand, hand.x + 1, hand.y));
  }
  check('the old rule grabbed ~2.1 tiles at default zoom (regression guard)',
    hand.radius + oldHitR(14) > 2, `${(hand.radius + oldHitR(14)).toFixed(2)}`);
  // 2.11 tiles before, ~0.64 now (a 4 px dot plus the capped band ≈ 9 px)
  check('the new rule grabs under a tile at default zoom',
    pickRadius(14, hand.radius, true) + pickTol(14) < 0.7,
    `${(pickRadius(14, hand.radius, true) + pickTol(14)).toFixed(2)}`);

  // and a real army stays an easy target
  const army = { x: 40.5, y: 12.5, radius: 1.5, working: false };
  check('an army is hit anywhere inside its circle', blobHit(14, army, army.x + 1.4, army.y));
  check('an army is not hit two tiles outside it', !blobHit(14, army, army.x + 2.6, army.y));
}

console.log('\noverlapping units rank by centre distance, so the one aimed at wins:');
{
  // main.js's pickBlobAt: candidates are everything blobHit accepts,
  // ranked by distance to CENTRE. Ranking by depth instead would give a
  // 2.2-tile stack every tap inside it, scout or no scout.
  const pick = (scale, blobs, x, y) => {
    let best = null, bd = Infinity;
    for (const b of blobs) {
      if (!blobHit(scale, b, x, y)) continue;
      const d = Math.hypot(b.x - x, b.y - y);
      if (d < bd) { bd = d; best = b; }
    }
    return best;
  };
  const stack = { id: 'stack', x: 30.5, y: 30.5, radius: 2.2, working: false };
  const scout = { id: 'scout', x: 31.2, y: 30.5, radius: 0.4, working: false };
  const both = [stack, scout];
  check('both are candidates at the scout\'s spot',
    blobHit(14, stack, scout.x, scout.y) && blobHit(14, scout, scout.x, scout.y));
  check('a tap on the scout picks the scout',
    pick(14, both, scout.x, scout.y) === scout);
  check('a tap elsewhere inside the stack still picks the stack',
    pick(14, both, 29.5, 30.5) === stack);
  check('depth ranking would have picked the stack (regression guard)',
    blobOverlap(14, stack, scout.x, scout.y) > blobOverlap(14, scout, scout.x, scout.y));
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
