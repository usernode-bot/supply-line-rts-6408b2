// End-of-match statistics (#233): a tick-indexed time series of the three
// numbers that actually describe how a match went, sampled for BOTH sides.
//
// Deliberately client-side and deliberately NOT part of S.serialize. This is
// a record of what the viewer watched, not simulation state: adding it to the
// save format would change the save schema, bloat every autosave, and — worse
// — make a resumed match's chart claim continuity it doesn't have. It is
// journaled next to the replay order log instead (see replay.js), and a
// replay rebuilds it for free by sampling the playback the same way.
//
// DOM-free so test code can drive it in Node; main.js owns the canvas.

import * as S from './sim.js';

export const SAMPLE_TICKS = 50;   // 5 s of sim time per sample

export const METRICS = [
  { key: 'units', label: 'Units', color: ['#a78bfa', '#f87171'], fmt: (v) => String(Math.round(v)) },
  { key: 'land', label: 'Territory', color: ['#818cf8', '#fb923c'], fmt: (v) => `${Math.round(v)} tiles` },
  { key: 'food', label: 'Food/min', color: ['#4ade80', '#fbbf24'], fmt: (v) => v.toFixed(1) },
];

export function createSeries() {
  return { rows: [] };   // rows[i] = { t, units: [a,b], land: [a,b], food: [a,b] }
}

// Territory is derived (game.terr holds settlement ids), so map ids to owners
// once per sample rather than per tile.
function landCounts(game) {
  const out = [0, 0];
  if (!game.terr) return out;
  const owner = new Map();
  for (const s of game.settlements) owner.set(s.id, s.owner);
  for (let i = 0; i < game.terr.length; i++) {
    const id = game.terr[i];
    if (!id) continue;
    const o = owner.get(id);
    if (o === 0 || o === 1) out[o]++;
  }
  return out;
}

function foodRates(game) {
  const out = [0, 0];
  for (const s of game.settlements) {
    if (s.building) continue;
    if (s.owner === 0 || s.owner === 1) out[s.owner] += S.incomeRate(game, s) * 600;
  }
  return out;
}

// Sample if this tick is a sample point. Idempotent per tick AND truncating:
// a replay rewind re-runs ticks that were already sampled, so the row is
// overwritten and everything after it is dropped — the chart can never show
// a future that the current playback has walked back.
export function sample(series, game) {
  const t = game.tick | 0;
  if (t % SAMPLE_TICKS !== 0) return;
  const idx = t / SAMPLE_TICKS;
  const u0 = S.unitCounts(game, 0), u1 = S.unitCounts(game, 1);
  const land = landCounts(game);
  const food = foodRates(game);
  series.rows[idx] = { t, units: [u0.units, u1.units], land, food };
  if (series.rows.length > idx + 1) series.rows.length = idx + 1;
}

// Peak value across both sides for one metric — the chart's y scale.
export function peak(series, key) {
  let m = 0;
  for (const r of series.rows) {
    if (!r) continue;
    m = Math.max(m, r[key][0], r[key][1]);
  }
  return m;
}

// What span of the match this series actually covers (#244).
//
// Rows are sparse by tick index, so a series that only started at the resume
// point leaves holes at rows[0..n] and `filter(Boolean)` quietly hands back a
// chart that begins mid-match against a full-width time axis — which reads as
// "the match started here" rather than "this part wasn't recorded". The chart
// asks this instead and labels the hole.
export function coverage(series) {
  const rows = series && Array.isArray(series.rows) ? series.rows : [];
  let first = null, last = null, samples = 0;
  for (const r of rows) {
    if (!r) continue;
    if (!first) first = r;
    last = r;
    samples++;
  }
  if (!first) return { samples: 0, fromTick: 0, toTick: 0, gap: false };
  return {
    samples,
    fromTick: first.t | 0,
    toTick: last.t | 0,
    gap: (first.t | 0) > 0,
  };
}

// Headline numbers for the end card: where each side finished, and when
// each side's units peaked (the "high-water mark" a match turns on).
export function summary(series) {
  const rows = series.rows.filter(Boolean);
  if (!rows.length) return null;
  const last = rows[rows.length - 1];
  // gameSeconds, not tick/10: the sim runs 5 ticks per game second (#233)
  const out = { seconds: S.gameSeconds(last.t), last, peakUnits: [0, 0], peakAt: [0, 0] };
  for (const r of rows) {
    for (const o of [0, 1]) {
      if (r.units[o] > out.peakUnits[o]) { out.peakUnits[o] = r.units[o]; out.peakAt[o] = r.t; }
    }
  }
  return out;
}
