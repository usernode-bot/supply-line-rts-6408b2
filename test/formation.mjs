// Headless tests for the army-formation geometry (#251). Run manually:
//   node test/formation.mjs
// public/js/formation.js is deliberately DOM-free and sim-free so the rules
// that decide where each figure stands can be asserted without a browser.
// What's being locked in: rows are balanced with the FRONT rows full, no row
// ever holds a single figure once there are two of them, attack units bracket
// a mixed group without producing a block of one, the whole block fits inside
// the drawn disc at every zoom, and the slot a unit gets does NOT depend on
// where it happens to sit in b.units (deserialize re-sorts that array).

import {
  rowSplit, groups, layout, fitPitch, fitCols, assign, orderUnits,
  MAX_PER_ROW, FIT, FIG_MIN, FIG_MAX,
} from '../public/js/formation.js';

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log('rows are balanced, front rows full:');
{
  const cases = [
    [1, [1]], [2, [2]], [3, [3]], [7, [4, 3]], [10, [5, 5]],
    [13, [7, 6]], [20, [7, 7, 6]], [30, [10, 10, 10]], [40, [10, 10, 10, 10]],
  ];
  for (const [n, want] of cases) {
    const got = rowSplit(n, MAX_PER_ROW);
    check(`${n} units stand ${want.join('/')}`, eq(got, want), got.join('/'));
  }
  check('0 units is no rows', eq(rowSplit(0, 10), []));
}

console.log('the invariants hold for every size up to 200:');
{
  for (const cap of [2, 4, 8, 10]) {
    let sumOk = true, loneOk = true, monoOk = true, capOk = true;
    for (let n = 1; n <= 200; n++) {
      const rows = rowSplit(n, cap);
      if (rows.reduce((a, b) => a + b, 0) !== n) sumOk = false;
      // A lonely row is only tolerable when the cap makes it unavoidable:
      // 3 figures at most 2 abreast HAS to stand 2/1. Everywhere the cap
      // leaves a choice, nobody stands alone.
      const forced = Math.floor(n / 2) < Math.ceil(n / cap);
      if (n >= 2 && !forced && rows.some(r => r < 2)) loneOk = false;
      for (let i = 1; i < rows.length; i++) if (rows[i] > rows[i - 1]) monoOk = false;
      if (rows.some(r => r > cap)) capOk = false;
    }
    check(`cap ${cap}: every figure gets a row`, sumOk);
    check(`cap ${cap}: no row holds a single figure unless the cap forces it`, loneOk);
    check(`cap ${cap}: rows never grow toward the rear`, monoOk);
    check(`cap ${cap}: no row exceeds the cap`, capOk);
  }
}

console.log('a block that is one of several packs WIDE, not deep:');
{
  // depth is what a stacked group is short of: four blocks each choosing a
  // sqrt-shaped depth would make the column deeper than it is wide.
  check('10 in a stacked block is one row of 10', eq(rowSplit(10, 10, true), [10]));
  check('...but 10 on its own still stands 5/5', eq(rowSplit(10, 10, false), [5, 5]));
  check('20 in a stacked block is two full rows', eq(rowSplit(20, 10, true), [10, 10]));
  const slots = layout({ deploy: 9, supply: 6, farm: 4 }, MAX_PER_ROW);
  let maxDepth = 0, maxWide = 0;
  for (const s of slots) {
    if (s.depth > maxDepth) maxDepth = s.depth;
    if (s.rowWidth > maxWide) maxWide = s.rowWidth;
  }
  check('a 19-strong mixed group is wider than it is deep',
    maxWide > maxDepth, `${maxWide} wide vs ${maxDepth.toFixed(1)} deep`);
}

console.log('role blocks: attackers bracket a mixed group:');
{
  const mixed = groups({ deploy: 9, supply: 6, farm: 4 });
  check('mixed group is front-attack / supply / farm / rear-attack',
    eq(mixed.map(b => `${b.role}:${b.n}`), ['deploy:5', 'supply:6', 'farm:4', 'deploy:4']),
    JSON.stringify(mixed));
  const pure = groups({ deploy: 30, supply: 0, farm: 0 });
  check('a pure attack army is ONE block', pure.length === 1 && pure[0].n === 30);
  const three = groups({ deploy: 3, supply: 5, farm: 0 });
  check('3 attackers do not split (no block of one)',
    eq(three.map(b => `${b.role}:${b.n}`), ['deploy:3', 'supply:5']),
    JSON.stringify(three));
  const four = groups({ deploy: 4, supply: 5, farm: 0 });
  check('4 attackers do split, 2 front / 2 rear',
    eq(four.map(b => `${b.role}:${b.n}`), ['deploy:2', 'supply:5', 'deploy:2']),
    JSON.stringify(four));
  const five = groups({ deploy: 5, supply: 2, farm: 0 });
  check('5 attackers split 3 front / 2 rear',
    eq(five.map(b => `${b.role}:${b.n}`), ['deploy:3', 'supply:2', 'deploy:2']),
    JSON.stringify(five));
  check('no attackers means no attack block',
    eq(groups({ deploy: 0, supply: 4, farm: 3 }).map(b => b.role), ['supply', 'farm']));
  check('an empty group has no blocks', groups({ deploy: 0, supply: 0, farm: 0 }).length === 0);
  let neverOne = true;
  for (let d = 0; d <= 40; d++) {
    for (const others of [[0, 0], [1, 0], [0, 1], [5, 4]]) {
      for (const b of groups({ deploy: d, supply: others[0], farm: others[1] })) {
        if (b.n < 1) neverOne = false;
        // a split block that would hold one figure is never produced
        if (b.role === 'deploy' && d >= 4 && others[0] + others[1] > 0 && b.n < 2) neverOne = false;
      }
    }
  }
  check('a split attack block never holds fewer than two', neverOne);
}

console.log('layout: rear-first draw order, depth counted across blocks:');
{
  const slots = layout({ deploy: 9, supply: 6, farm: 4 }, MAX_PER_ROW);
  check('every unit gets exactly one slot', slots.length === 19, String(slots.length));
  let sortedRearFirst = true;
  for (let i = 1; i < slots.length; i++) if (slots[i].y > slots[i - 1].y + 1e-9) sortedRearFirst = false;
  check('slots come out rear rank first', sortedRearFirst);
  const roles = new Set(slots.map(s => s.role));
  check('all three roles are represented', roles.size === 3);
  const frontMost = slots[slots.length - 1];
  const rearMost = slots[0];
  check('the front rank is an attack rank', frontMost.role === 'deploy', frontMost.role);
  check('the rear rank is an attack rank', rearMost.role === 'deploy', rearMost.role);
  check('depth is non-negative and counted from the front',
    slots.every(s => s.depth >= 0));
  const single = layout({ deploy: 1, supply: 0, farm: 0 }, MAX_PER_ROW);
  check('a lone scout is one slot at the centre',
    single.length === 1 && Math.abs(single[0].x) < 1e-9 && Math.abs(single[0].y) < 1e-9);
}

console.log('the block fits inside the drawn disc at every zoom:');
{
  // the three zooms that matter, as pick.mjs uses: phone-fit far zoom, the
  // default, and the 96 px/tile close-up cap — times the 2.2-tile radius cap
  for (const s of [3.7, 14, 96]) {
    const rPx = Math.max(10, 2.2 * s);
    const cols = fitCols(rPx, 4);
    const rows = rowSplit(40, cols);
    const { pitchX, pitchY, figR } = fitPitch(rPx, cols, rows.length - 1);
    const slots = layout({ deploy: 40, supply: 0, farm: 0 }, cols);
    let worstX = 0, worstY = 0;
    for (const sl of slots) {
      worstX = Math.max(worstX, Math.abs(sl.x) * pitchX + figR);
      worstY = Math.max(worstY, Math.abs(sl.y) * pitchY + figR);
    }
    const lim = FIT * rPx;
    check(`scale ${s}: 40 figures stay inside ${FIT} of the disc across`,
      worstX <= lim + 1e-6, `${worstX.toFixed(2)} > ${lim.toFixed(2)}`);
    check(`scale ${s}: ...and front-to-back`,
      worstY <= lim + 1e-6, `${worstY.toFixed(2)} > ${lim.toFixed(2)}`);
    check(`scale ${s}: figure radius stays in the ${FIG_MIN}–${FIG_MAX} px band`,
      figR >= FIG_MIN - 1e-9 && figR <= FIG_MAX + 1e-9, String(figR));
    check(`scale ${s}: row width never exceeds the hard ${MAX_PER_ROW} ceiling`,
      cols <= MAX_PER_ROW && cols >= 2, String(cols));
  }
  check('a small disc narrows its rows below 10', fitCols(12, 4) < MAX_PER_ROW,
    String(fitCols(12, 4)));
  check('a big disc reaches the 10 ceiling', fitCols(2.2 * 96, 4) === MAX_PER_ROW,
    String(fitCols(2.2 * 96, 4)));
}

console.log('a unit keeps its slot when b.units is re-sorted:');
{
  // deserialize() re-sorts b.units by seed, so a formation keyed on array
  // index would reshuffle on every PvP snapshot. Same units, different array
  // order, must give every seed the same slot.
  const mk = (role, seed) => ({ role, seed, hp: 100 });
  const units = [
    mk('supply', 0.71), mk('deploy', 0.12), mk('farm', 0.44), mk('deploy', 0.93),
    mk('deploy', 0.05), mk('supply', 0.31), mk('deploy', 0.66), mk('farm', 0.02),
    mk('deploy', 0.5), mk('supply', 0.88),
  ];
  const key = (pairs) => pairs.map(p => `${p.unit.seed}@${p.slot.x.toFixed(3)},${p.slot.y.toFixed(3)}`)
    .sort().join('|');
  const a = assign(units, MAX_PER_ROW);
  const shuffled = [units[4], units[9], units[0], units[7], units[2],
                    units[8], units[1], units[6], units[3], units[5]];
  const b = assign(shuffled, MAX_PER_ROW);
  const reversed = assign(units.slice().reverse(), MAX_PER_ROW);
  check('shuffling the unit array does not move anybody', key(a) === key(b));
  check('reversing the unit array does not move anybody', key(a) === key(reversed));
  check('every unit is placed', a.length === units.length, String(a.length));
  check('a unit only ever sits in a slot of its own role',
    a.every(p => p.unit.role === p.slot.role));
  let rearFirst = true;
  for (let i = 1; i < a.length; i++) if (a[i].slot.y > a[i - 1].slot.y + 1e-9) rearFirst = false;
  check('assignments come out rear rank first', rearFirst);
  const ordered = orderUnits(units);
  check('orderUnits does not mutate its input', units[0].seed === 0.71);
  check('orderUnits groups roles then sorts by seed',
    ordered.filter(u => u.role === 'deploy').every((u, i, arr) => i === 0 || arr[i - 1].seed < u.seed));
}

console.log('degenerate inputs do not throw:');
{
  check('no counts', eq(layout({}, 10), []));
  check('negative counts', eq(layout({ deploy: -5, supply: 0, farm: 0 }, 10), []));
  check('assign with no units', assign([], 10).length === 0);
  check('fitPitch at zero radius returns finite numbers', (() => {
    const f = fitPitch(0, 5, 3);
    return Number.isFinite(f.pitchX) && Number.isFinite(f.pitchY) && Number.isFinite(f.figR);
  })());
  check('fitCols at zero radius still returns at least 2', fitCols(0, 4) === 2);
}

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall formation checks passed');
