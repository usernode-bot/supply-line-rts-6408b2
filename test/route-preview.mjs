// Headless checks for the dispatch-time route preview (#267): previewRoute's
// ETA, risk spans and fog behaviour, plus fmtEta's quantisation. Run manually:
//   node test/route-preview.mjs
//
// previewRoute and fmtEta are pure UI helpers — the sim never calls them —
// so these run against minimal read-only game shells, no DOM.

import { previewRoute, fmtEta } from '../public/js/supply.js';

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// Minimal game shell: previewRoute only reads map/settlements/blobs and
// derives game.terr itself (the same lazy rebuild the renderer does).
function fakeGame(pairs) {
  return {
    map: { w: 48, h: 48 },
    settlements: pairs.map(([id, owner, x, y]) => ({ id, owner, x, y, building: false })),
    blobs: [],
  };
}

// ------------------------------------------------------------- ETA math
{
  console.log('ETA is the straight-line walk at the 1× display speed');
  // 12 tiles at SPEED_SUPPLY 1.2 tiles/sim-s, DT 0.1 s/tick, 5 ticks per
  // 1× second: 12 / 1.2 / 0.1 / 5 = 20 s
  const g = fakeGame([[1, 0, 8, 10]]);
  const r = previewRoute(g, 0, { x: 11, y: 11 }, { x: 23, y: 11 }, () => true, () => false);
  check('12-tile line reads 20 s', Math.abs(r.etaSec - 20) < 1e-9, r.etaSec);
  check('dist is the tile length', Math.abs(r.dist - 12) < 1e-9, r.dist);
  check('fmtEta(20) is ~20s', fmtEta(20) === '~20s', fmtEta(20));
  check('fmtEta(85) is ~1m 25s', fmtEta(85) === '~1m 25s', fmtEta(85));
  check('fmtEta(125) zero-pads seconds', fmtEta(125) === '~2m 05s', fmtEta(125));
  check('fmtEta(2) clamps to the 5 s minimum', fmtEta(2) === '~5s', fmtEta(2));
  check('fmtEta(50) stays under a minute', fmtEta(50) === '~50s', fmtEta(50));
}

// ------------------------------------------------------------ safe line
{
  console.log('a line through own and neutral land is one safe span');
  const g = fakeGame([[1, 0, 8, 10]]);
  const r = previewRoute(g, 0, { x: 11, y: 11 }, { x: 25, y: 11 }, () => true, () => true);
  check('one span', r.spans.length === 1, JSON.stringify(r.spans));
  check('span is safe', r.spans[0].risk === null, r.spans[0].risk);
  check('worst is null', r.worst === null, r.worst);
}

// ----------------------------------------------------------- enemy land
{
  console.log('a stretch crossing seen enemy territory reads enemy');
  // enemy settlement centred at (23,11) owns a 5-tile ring; the line at
  // y=11 crosses it between roughly x=18 and x=28
  const g = fakeGame([[1, 0, 8, 10], [2, 1, 22, 10]]);
  const r = previewRoute(g, 0, { x: 11, y: 11 }, { x: 36, y: 11 }, () => true, () => false);
  const mid = r.spans.find(sp => sp.risk === 'enemy');
  check('middle span is enemy', !!mid, JSON.stringify(r.spans));
  check('enemy span sits inside the territory ring',
    mid && mid.t0 > 0 && mid.t1 < 1, mid && `${mid.t0}..${mid.t1}`);
  check('worst is enemy', r.worst === 'enemy', r.worst);
  const hidden = previewRoute(g, 0, { x: 11, y: 11 }, { x: 36, y: 11 }, () => false, () => false);
  check('fogged enemy land never colours the line',
    hidden.spans.every(sp => sp.risk !== 'enemy') && hidden.worst !== 'enemy',
    JSON.stringify(hidden.spans));
  check('hidden line still has safe spans', hidden.spans.some(sp => sp.risk === null));
}

// --------------------------------------------------------- nearby army
{
  console.log('a stretch passing a seen enemy army reads near');
  // no enemy settlements, so any risk must come from the blob
  const g = fakeGame([[1, 0, 8, 10]]);
  g.blobs.push({ id: 3, owner: 1, x: 16, y: 14, dead: false, working: null,
    count: { deploy: 5, supply: 0, farm: 0 } });
  const r = previewRoute(g, 0, { x: 11, y: 11 }, { x: 25, y: 11 }, () => true, () => true);
  const near = r.spans.find(sp => sp.risk === 'near');
  check('3 tiles off the line is a near span', !!near, JSON.stringify(r.spans));
  check('worst is near', r.worst === 'near', r.worst);
  const far = { id: 3, owner: 1, x: 16, y: 21, dead: false, working: null,
    count: { deploy: 5, supply: 0, farm: 0 } };
  const g2 = fakeGame([[1, 0, 8, 10]]);
  g2.blobs.push(far);
  const r2 = previewRoute(g2, 0, { x: 11, y: 11 }, { x: 25, y: 11 }, () => true, () => true);
  check('10 tiles off the line is safe', r2.worst === null, JSON.stringify(r2.spans));
  const g3 = fakeGame([[1, 0, 8, 10]]);
  g3.blobs.push({ id: 3, owner: 1, x: 16, y: 14, dead: false, working: null,
    count: { deploy: 5, supply: 0, farm: 0 } });
  const r3 = previewRoute(g3, 0, { x: 11, y: 11 }, { x: 25, y: 11 }, () => true, () => false);
  check('a fogged army never colours the line', r3.worst === null, JSON.stringify(r3.spans));
  const g4 = fakeGame([[1, 0, 8, 10]]);
  g4.blobs.push({ id: 3, owner: 0, x: 16, y: 14, dead: false, working: null,
    count: { deploy: 5, supply: 0, farm: 0 } });
  const r4 = previewRoute(g4, 0, { x: 11, y: 11 }, { x: 25, y: 11 }, () => true, () => true);
  check('an own army is never a risk', r4.worst === null, JSON.stringify(r4.spans));
}

// ----------------------------------------------------- spans contiguity
{
  console.log('spans tile the line with no gaps');
  const g = fakeGame([[1, 0, 8, 10], [2, 1, 22, 10]]);
  g.blobs.push({ id: 3, owner: 1, x: 16, y: 14, dead: false, working: null,
    count: { deploy: 5, supply: 0, farm: 0 } });
  const r = previewRoute(g, 0, { x: 11, y: 11 }, { x: 36, y: 11 }, () => true, () => true);
  check('first span starts at 0', r.spans[0].t0 === 0, r.spans[0].t0);
  check('last span ends at 1', r.spans[r.spans.length - 1].t1 === 1,
    r.spans[r.spans.length - 1].t1);
  let ok = true;
  for (let i = 1; i < r.spans.length; i++) {
    if (r.spans[i].t0 !== r.spans[i - 1].t1) ok = false;
  }
  check('each span starts where the previous ended', ok, JSON.stringify(r.spans));
  check('consecutive spans differ in risk', r.spans.every((sp, i) =>
    i === 0 || sp.risk !== r.spans[i - 1].risk), JSON.stringify(r.spans));
}

if (failures) {
  console.error(`route-preview: ${failures} failure(s)`);
  process.exit(1);
}
console.log('route-preview: all checks passed');