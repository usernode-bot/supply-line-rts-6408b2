// Headless test for solo save/resume (#240). Run manually:
//   node test/resume.mjs
//
// The bug this file exists to prevent: serialize() stamped v5 while the menu's
// gate accepted 2–4, so every autosave was written faithfully and then thrown
// away at load time — the Resume button never appeared and players reported
// their match simply gone. The first block below is the regression guard for
// exactly that drift; nothing here hard-codes a version number.
//
// Also covers: what each unreadable payload classifies as, the local/remote
// pick, the save→resume round trip continuing the same sim, the session
// breadcrumb that distinguishes "the page vanished" from "I quit to the menu",
// and the quota path where a write fails and pruning has to rescue it.

import * as S from '../public/js/sim.js';
import * as RES from '../public/js/resume.js';
import * as O from '../public/js/offline.js';
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

// A localStorage stand-in, optionally one whose quota is already full.
function memStorage(opts) {
  const map = new Map();
  const full = !!(opts && opts.full);
  let rejectKeys = (opts && opts.rejectKeys) || null;
  return {
    map,
    setRejectKeys(k) { rejectKeys = k; },
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => {
      if (full || (rejectKeys && rejectKeys.has(k))) {
        const e = new Error('QuotaExceededError');
        e.name = 'QuotaExceededError';
        throw e;
      }
      map.set(k, v);
    },
    removeItem: (k) => { map.delete(k); },
  };
}

const freshSave = (seed = 'resume-1', ticks = 200) => {
  const g = S.newGame(seed, 'xsmall', 'normal');
  for (let i = 0; i < ticks; i++) RP.advance(g);
  const data = S.serialize(g);
  data.savedAt = 1000;
  return data;
};

// ------------------------------------------------ the version gate (#240)

console.log('version gate — the serializer and the classifier must agree');
{
  check('sim.js exports a save range', Number.isInteger(S.SAVE_VERSION)
    && Number.isInteger(S.MIN_SAVE_VERSION) && S.MIN_SAVE_VERSION <= S.SAVE_VERSION,
    `${S.MIN_SAVE_VERSION}..${S.SAVE_VERSION}`);

  // THE regression guard. Asserted against the constant, never a literal — a
  // future bump has to move both or this fails.
  const data = S.serialize(S.newGame('gate-1', 'xsmall', 'normal'));
  check('serialize() stamps SAVE_VERSION', data.v === S.SAVE_VERSION,
    `stamped ${data.v}, constant is ${S.SAVE_VERSION}`);
  check('a freshly serialized save classifies as ok',
    RES.classifySave(data) === 'ok', RES.classifySave(data));

  // Every version the classifier claims to accept must actually be accepted,
  // so nobody can narrow the range without noticing.
  for (let v = S.MIN_SAVE_VERSION; v <= S.SAVE_VERSION; v++) {
    check(`v${v} is accepted`, RES.classifySave({ ...data, v }) === 'ok');
  }
  check('the server range matches the client range',
    S.SAVE_VERSION >= 5 && S.MIN_SAVE_VERSION === 2,
    'server.js imports these two constants — update this test if they move');
}

console.log('classify — a damaged save reports WHY, never just vanishes');
{
  const ok = freshSave();
  check('absent -> none', RES.classifySave(null) === 'none');
  check('undefined -> none', RES.classifySave(undefined) === 'none');
  check('a finished match -> none', RES.classifySave({ ...ok, result: 'win' }) === 'none');
  check('a PvP snapshot -> none', RES.classifySave({ ...ok, pvp: true }) === 'none');
  check('a newer build -> too-new',
    RES.classifySave({ ...ok, v: S.SAVE_VERSION + 1 }) === 'too-new');
  check('v1 -> unreadable', RES.classifySave({ ...ok, v: 1 }) === 'unreadable');
  check('a non-numeric version -> unreadable',
    RES.classifySave({ ...ok, v: 'five' }) === 'unreadable');
  check('an array -> unreadable', RES.classifySave([1, 2, 3]) === 'unreadable');
  check('missing blobs -> unreadable',
    RES.classifySave({ ...ok, blobs: undefined }) === 'unreadable');
  check('missing settlements -> unreadable',
    RES.classifySave({ ...ok, settlements: undefined }) === 'unreadable');
  check('missing seed -> unreadable', RES.classifySave({ ...ok, seed: null }) === 'unreadable');
  check('missing tick -> unreadable', RES.classifySave({ ...ok, tick: null }) === 'unreadable');

  // Corrupt JSON must survive as "damaged", not decay into "nothing saved" —
  // the two produce different screens.
  check('truncated JSON -> unreadable', RES.parseSave('{"v":5,"seed":"a"').code === 'unreadable');
  check('an empty string -> none', RES.parseSave('').code === 'none');
  check('null raw -> none', RES.parseSave(null).code === 'none');
  check('a good payload round-trips through parseSave',
    RES.parseSave(JSON.stringify(ok)).code === 'ok');
}

console.log('readSave — the store reports damage rather than swallowing it');
{
  const storage = memStorage();
  const store = O.createStore(storage);
  check('an empty store -> none', RES.readSave(store).code === 'none');

  storage.setItem(RES.SAVE_KEY, '{"v":5,"seed":');
  check('a corrupt value -> unreadable', RES.readSave(store).code === 'unreadable');

  const good = freshSave();
  store.write(RES.SAVE_KEY, good);
  const back = RES.readSave(store);
  check('a good value -> ok with its data', back.code === 'ok' && back.data.seed === good.seed);

  RES.clearSave(store);
  check('clearSave empties the slot', RES.readSave(store).code === 'none');
}

console.log('pick — freshest wins, local wins a tie');
{
  const local = { ...freshSave('pick-a'), savedAt: 500 };
  const remote = { ...freshSave('pick-b'), savedAt: 900 };
  check('a fresher account copy wins', RES.pickSave(local, remote).source === 'remote');
  check('a fresher local copy wins',
    RES.pickSave({ ...local, savedAt: 1200 }, remote).source === 'local');
  check('a tie goes to local',
    RES.pickSave({ ...local, savedAt: 900 }, remote).source === 'local');
  check('an unreadable local copy falls through to the account',
    RES.pickSave({ ...local, v: 1 }, remote).source === 'remote');
  check('two bad copies pick nothing', RES.pickSave(null, { v: 1 }).data === null);
  check('a save with no savedAt still counts as a save',
    RES.pickSave({ ...local, savedAt: undefined }, null).source === 'local');
}

console.log('summary — what the menu card prints');
{
  const data = { ...freshSave('sum-1'), savedAt: 10_000 };
  const sum = RES.saveSummary(data, 70_000);
  check('carries the match description',
    sum.difficulty === 'normal' && sum.sizeKey === 'xsmall' && sum.tick === data.tick);
  check('ages the save', sum.ageMs === 60_000);
  check('a recent save is not stale', sum.stale === false);
  check('a day-old save is stale',
    RES.saveSummary(data, 10_000 + RES.STALE_MS + 1).stale === true);
  check('an unreadable payload has no summary', RES.saveSummary({ v: 1 }, 0) === null);
}

// ------------------------------------------------ the resume round trip

console.log('round trip — a resumed match continues the same simulation');
{
  const g = S.newGame('rt-resume', 'xsmall', 'normal');
  for (let i = 0; i < 400; i++) RP.advance(g);

  const store = O.createStore(memStorage());
  const data = S.serialize(g);
  data.savedAt = 1;
  // Non-sim fields ride along and must not disturb the gate or deserialize.
  data.view = { cx: 12.5, cy: 9.25, scale: 22 };
  const written = RES.persistSave(store, data, []);
  check('the save persists', written.ok === true);

  const read = RES.readSave(store);
  check('it reads back as ok', read.code === 'ok');
  check('the camera survives', read.data.view && read.data.view.scale === 22);

  const resumed = S.deserialize(read.data);
  check('the PRNG cursor survives', resumed.rngState === g.rngState);

  // Resumed and continuous play must agree from here on.
  const snap = (x) => JSON.stringify([x.tick, x.rngState, x.blobs.filter(b => !b.dead).length,
    x.settlements.map(s => [s.id, Math.round(s.stockpile), s.garrison.deploy]),
    x.blobs.filter(b => !b.dead).map(b => [b.id, b.x.toFixed(4), b.y.toFixed(4), Math.round(b.food)])]);
  for (let i = 0; i < 300; i++) { RP.advance(g); RP.advance(resumed); }
  check('300 ticks later the two agree', snap(g) === snap(resumed));
}

// ------------------------------------------------ the session breadcrumb

console.log('session breadcrumb — reload vs. quit to the menu');
{
  const store = O.createStore(memStorage());
  check('a fresh device has no session', RES.readSession(store) === null);

  RES.markSession(store, 'solo', { savedAt: 42 });
  const s = RES.readSession(store);
  check('a saved match marks the session', s && s.mode === 'solo' && s.savedAt === 42);

  RES.clearSession(store);
  check('leaving to the menu clears it', RES.readSession(store) === null);

  RES.markSession(store, 'pvp', { lobbyId: 77 });
  const p = RES.readSession(store);
  check('a PvP session carries its lobby', p.mode === 'pvp' && p.lobbyId === 77);

  check('an inactive record reads as no session',
    (store.write(RES.SESSION_KEY, { active: false, mode: 'solo' }),
      RES.readSession(store) === null));
  check('a junk record reads as no session',
    (store.write(RES.SESSION_KEY, 'nope'), RES.readSession(store) === null));
}

console.log('auto-resume decision');
{
  const solo = { active: true, mode: 'solo' };
  const pvp = { active: true, mode: 'pvp', lobbyId: 5 };
  check('solo + a good save resumes', RES.shouldAutoResume(solo, 'ok', false) === true);
  check('solo + an unreadable save does NOT resume',
    RES.shouldAutoResume(solo, 'unreadable', false) === false);
  check('solo + no save does NOT resume', RES.shouldAutoResume(solo, 'none', false) === false);
  check('no breadcrumb never resumes', RES.shouldAutoResume(null, 'ok', false) === false);
  check('a deliberate exit never resumes',
    RES.shouldAutoResume({ active: false, mode: 'solo' }, 'ok', false) === false);
  check('pvp resumes on its lobby id, save or no save',
    RES.shouldAutoResume(pvp, 'none', false) === true);
  check('pvp with no lobby id does NOT resume',
    RES.shouldAutoResume({ active: true, mode: 'pvp' }, 'ok', false) === false);
  // ?shot= / ?demo=1 boots must never be dropped into a real match.
  check('a blocked boot never resumes', RES.shouldAutoResume(solo, 'ok', true) === false);
}

// ------------------------------------------------ the quota path

console.log('quota — a failed write prunes and retries instead of giving up silently');
{
  const data = freshSave('quota-1');

  // Nothing can rescue a store that refuses everything: the caller is told.
  const dead = O.createStore(memStorage({ full: true }));
  const res = RES.persistSave(dead, data, []);
  check('a hopeless write reports failure', res.ok === false && res.pruned.length === 0);

  // With a prune step that frees room, the retry succeeds and names what went.
  const storage = memStorage({ rejectKeys: new Set([RES.SAVE_KEY]) });
  const store = O.createStore(storage);
  let dropped = 0;
  const ok = RES.persistSave(store, data, [
    { name: 'replays', run: () => { dropped++; storage.setRejectKeys(null); return true; } },
  ]);
  check('the retry after pruning succeeds', ok.ok === true);
  check('it says what it pruned', ok.pruned.join(',') === 'replays', ok.pruned.join(','));
  check('the prune actually ran once', dropped === 1);
  check('the save really landed', RES.readSave(store).code === 'ok');

  // Steps that decline (nothing left to free) or throw are skipped, not
  // counted, and must not stop the ones behind them.
  const storage2 = memStorage({ rejectKeys: new Set([RES.SAVE_KEY]) });
  const store2 = O.createStore(storage2);
  const order = [];
  const res2 = RES.persistSave(store2, data, [
    { name: 'empty', run: () => { order.push('empty'); return false; } },
    { name: 'boom', run: () => { order.push('boom'); throw new Error('nope'); } },
    { name: 'journal', run: () => { order.push('journal'); storage2.setRejectKeys(null); return true; } },
  ]);
  check('steps run in order until one frees room', order.join(',') === 'empty,boom,journal');
  check('only the effective step is reported',
    res2.ok === true && res2.pruned.join(',') === 'journal', res2.pruned.join(','));

  // A store with no backing storage at all (the ?shot= memory store) still
  // works — a preview boot must never crash on a save it isn't allowed to make.
  const mem = O.createStore(null);
  check('the memory store accepts a save', RES.persistSave(mem, data, []).ok === true);
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall resume checks passed');
process.exit(failures ? 1 : 0);
