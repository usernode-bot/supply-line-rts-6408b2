// Match-statistics coverage (#244). Run manually:
//   node test/stats.mjs
//
// The reported bug: after a resume the end-of-match graph started mid-match and
// the earlier half was simply gone. Two causes, both checked here:
//
//   * the series is sparse by tick index, so one that only began at the resume
//     point leaves holes at rows[0..n]. summary()/peak() filter them out and the
//     chart then draws a short run of samples against a full-width time axis —
//     which reads as "the match started here". coverage() makes the hole a fact
//     the chart can label.
//   * the series used to be restored ONLY when the replay's strict provenance
//     check passed, and was deleted with the rejected journal. It now rides its
//     own looser gate (statsFromJournal), which belongs to #244 but lives in
//     replay.js beside the journal it reads.

import * as S from '../public/js/sim.js';
import * as ST from '../public/js/stats.js';
import * as RP from '../public/js/replay.js';

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// Sample a real match, optionally skipping everything before `from` — which is
// exactly the shape a session that resumed without its history produces.
function series(g, ticks, from) {
  const s = ST.createSeries();
  if (from == null) ST.sample(s, g);
  for (let k = 0; k < ticks && !g.result; k++) {
    RP.advance(g);
    if (from == null || g.tick >= from) ST.sample(s, g);
  }
  return s;
}

console.log('coverage — a whole match, and one with its beginning missing');
{
  const g = S.newGame('stats-1', 'xsmall', 'normal');
  const whole = series(g, 600);
  const cov = ST.coverage(whole);
  check('a match sampled from the start reports no gap', cov.gap === false);
  check('it starts at tick 0', cov.fromTick === 0, String(cov.fromTick));
  check('and counts its samples', cov.samples === whole.rows.filter(Boolean).length);

  const g2 = S.newGame('stats-1', 'xsmall', 'normal');
  const partial = series(g2, 600, 300);
  // rows are sparse: the pre-300 slots are holes, not absent
  check('the missing part leaves holes, not a shorter array',
    partial.rows.length > partial.rows.filter(Boolean).length,
    `${partial.rows.filter(Boolean).length} of ${partial.rows.length}`);
  const cov2 = ST.coverage(partial);
  check('a resumed-without-history series reports a gap', cov2.gap === true);
  check('and says where the history actually starts',
    cov2.fromTick >= 300 && cov2.fromTick < 300 + ST.SAMPLE_TICKS, String(cov2.fromTick));
  check('the summary still reads off the samples it has', !!ST.summary(partial));
  check('an empty series reports nothing rather than a gap',
    ST.coverage(ST.createSeries()).gap === false
    && ST.coverage(ST.createSeries()).samples === 0);
  check('a null series is tolerated', ST.coverage(null).samples === 0);
}

console.log('statsFromJournal — restored on its own, looser gate');
{
  const g = S.newGame('stats-2', 'xsmall', 'normal');
  const s = series(g, 400);
  const j = RP.journalOf(RP.createRecorder(g), g, s);
  const resumed = S.deserialize(S.serialize(g));

  const back = RP.statsFromJournal(j, resumed);
  check('a journal from this match restores the whole series',
    back && back.rows.length === s.rows.length,
    back ? `${back.rows.length} of ${s.rows.length}` : 'nothing');

  // the two things the replay gate refuses and the chart must not care about
  check('a journal from another engine version still restores the chart',
    !!RP.statsFromJournal({ ...j, sim_version: S.SIM_VERSION + 1 }, resumed));
  check('…and the replay itself is still refused for it',
    RP.recorderFromJournal({ ...j, sim_version: S.SIM_VERSION + 1 }, resumed) === null);
  check('a journal stamped at a different tick still restores the chart',
    !!RP.statsFromJournal({ ...j, tick: (j.tick | 0) - 1 }, resumed));
  check('…and the replay itself is still refused for it',
    RP.recorderFromJournal({ ...j, tick: (j.tick | 0) - 1 }, resumed) === null);
  check('a stats-only journal (no order log at all) restores',
    !!RP.statsFromJournal(RP.statsJournalOf(g, s), resumed));

  // …and the things that mean it belongs to a different match
  check('another seed is refused', RP.statsFromJournal({ ...j, seed: 'other' }, resumed) === null);
  check('another map size is refused', RP.statsFromJournal({ ...j, size_key: 'large' }, resumed) === null);
  check('another difficulty is refused', RP.statsFromJournal({ ...j, difficulty: 'hard' }, resumed) === null);
  check('a journal with no series is refused', RP.statsFromJournal({ ...j, stats: null }, resumed) === null);
  check('a missing journal is refused', RP.statsFromJournal(null, resumed) === null);

  // a save rolled back behind the journal (pickSave can choose an older copy):
  // the restore must not carry samples describing a future that un-happened
  const older = S.deserialize(S.serialize(g));
  older.tick = 200;
  const trimmed = RP.statsFromJournal(j, older);
  check('a rolled-back save truncates the restored series',
    trimmed && trimmed.rows.length === Math.floor(200 / ST.SAMPLE_TICKS) + 1,
    trimmed ? String(trimmed.rows.length) : 'nothing');
  check('and every row it kept is at or before the resumed tick',
    trimmed.rows.filter(Boolean).every((r) => r.t <= 200));
  check('the journal it was read from is untouched', j.stats.rows.length === s.rows.length);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall stats checks passed');
process.exit(failures ? 1 : 0);
