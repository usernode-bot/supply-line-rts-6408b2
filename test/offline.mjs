// Headless test for the offline solo-play bookkeeping (#221). Run manually:
//   node test/offline.mjs
// Covers the outbox FIFO cap, dedupe by client_id, the history/outbox
// transitions (sync / drop), the account-mismatch rule that decides whether a
// queued result may be credited to whoever is signed in now, the menu's
// server+local merge ordering, and a corrupt store degrading to empty rather
// than throwing on boot.

import * as O from '../public/js/offline.js';

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// A localStorage stand-in.
function memStorage(initial) {
  const map = new Map(Object.entries(initial || {}));
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, v); },
    removeItem: (k) => { map.delete(k); },
  };
}

const rec = (id, over) => ({
  client_id: id,
  result: 'win',
  difficulty: 'normal',
  duration_seconds: 900,
  map_seed: 'seed-' + id,
  ended_at: 1000 + Number(String(id).replace(/\D/g, '') || 0),
  username: null,
  ...over,
});

// ---------------------------------------------------------------- client ids

console.log('client ids');
{
  const id = O.newClientId('abc123', 4200, () => 0.5);
  check('deterministic for a fixed rand', id === O.newClientId('abc123', 4200, () => 0.5), id);
  check('varies with the tick', id !== O.newClientId('abc123', 4201, () => 0.5));
  check('varies with the seed', id !== O.newClientId('abc124', 4200, () => 0.5));
  check('survives a missing rand', typeof O.newClientId('s', 1) === 'string');
  check('bounded length', O.newClientId('x'.repeat(200), 1, () => 0.9).length <= 64);
}

// ---------------------------------------------------------------- recording

console.log('recording a finished match');
{
  const store = O.createStore(memStorage());
  O.recordResult(store, rec('m1'));
  O.recordResult(store, rec('m2', { result: 'loss' }));

  const hist = O.readHistory(store);
  const out = O.readOutbox(store);
  check('history is newest-first', hist.length === 2 && hist[0].client_id === 'm2', JSON.stringify(hist.map(r => r.client_id)));
  check('outbox is oldest-first (Elo order)', out.length === 2 && out[0].client_id === 'm1');
  check('recorded rows start unsynced', hist.every((r) => r.synced === false));
  check('pendingCount tracks the outbox', O.pendingCount(store) === 2);

  // idempotent on client_id
  O.recordResult(store, rec('m2', { result: 'loss' }));
  check('re-recording the same match does not duplicate',
    O.readHistory(store).length === 2 && O.readOutbox(store).length === 2);

  // a record with no client_id is ignored outright
  O.recordResult(store, { result: 'win', difficulty: 'easy' });
  check('a record with no client_id is refused', O.readHistory(store).length === 2);

  // field normalisation
  const store2 = O.createStore(memStorage());
  O.recordResult(store2, rec('m3', { duration_seconds: -5 }));
  check('negative durations clamp to 0', O.readHistory(store2)[0].duration_seconds === 0);
}

// ---------------------------------------------------------------- outbox cap

console.log('outbox cap');
{
  const list = Array.from({ length: 25 }, (_, i) => rec('c' + i));
  const capped = O.capOutbox(list, 20);
  check('caps at the max', capped.list.length === 20);
  check('drops the OLDEST', capped.dropped.length === 5 && capped.dropped[0].client_id === 'c0');
  check('keeps the newest', capped.list[capped.list.length - 1].client_id === 'c24');
  const under = O.capOutbox(list.slice(0, 3), 20);
  check('under the cap is a copy, nothing dropped', under.list.length === 3 && under.dropped.length === 0);
  check('a non-array is tolerated', O.capOutbox(null, 5).list.length === 0);

  const store = O.createStore(memStorage());
  for (let i = 0; i < O.OUTBOX_MAX + 1; i++) O.recordResult(store, rec('q' + i));
  check('recording past the cap keeps the cap', O.readOutbox(store).length === O.OUTBOX_MAX);
  const dropped = O.readHistory(store).find((r) => r.client_id === 'q0');
  check('the dropped result is flagged in the history log, not deleted', !!dropped && dropped.dropped === true);
  check('the dropped result is off the outbox',
    !O.readOutbox(store).some((r) => r.client_id === 'q0'));
  check('history itself is capped', O.readHistory(store).length <= O.HISTORY_MAX);
}

// ---------------------------------------------------------------- sync / drop

console.log('sync and drop transitions');
{
  const store = O.createStore(memStorage());
  O.recordResult(store, rec('s1'));
  O.recordResult(store, rec('s2'));
  O.markSynced(store, 's1');
  check('a synced result leaves the outbox', O.readOutbox(store).map((r) => r.client_id).join() === 's2');
  check('a synced result stays in history, marked synced',
    O.readHistory(store).find((r) => r.client_id === 's1').synced === true);

  O.dropRecord(store, 's2');
  check('a dropped result leaves the outbox', O.readOutbox(store).length === 0);
  const s2 = O.readHistory(store).find((r) => r.client_id === 's2');
  check('a dropped result is flagged in history', s2.dropped === true && s2.synced === false);

  // syncing a record that was previously dropped clears the flag (the retry won)
  O.markSynced(store, 's2');
  check('syncing clears a stale dropped flag',
    O.readHistory(store).find((r) => r.client_id === 's2').dropped === false);
}

// ---------------------------------------------------------------- account rule

console.log('account attribution');
{
  check('signed-out result goes to whoever is signed in',
    O.syncDecision(rec('a', { username: null }), 'evan') === 'send');
  check('same account sends', O.syncDecision(rec('a', { username: 'evan' }), 'evan') === 'send');
  check('case-insensitive match sends', O.syncDecision(rec('a', { username: 'Evan' }), 'evan') === 'send');
  check('different account is dropped, not mis-credited',
    O.syncDecision(rec('a', { username: 'someone-else' }), 'evan') === 'drop');
  check('no current username still sends a stamped record',
    O.syncDecision(rec('a', { username: 'evan' }), null) === 'send');
  check('a junk record is dropped', O.syncDecision(null, 'evan') === 'drop');
}

// ---------------------------------------------------------------- merge

console.log('history merge for the menu');
{
  const server = [
    { result: 'win', difficulty: 'hard', duration_seconds: 1800, created_at: 5000, client_id: 'synced-1', rating_delta: 12 },
    { result: 'loss', difficulty: 'normal', duration_seconds: 600, created_at: 3000, client_id: null, rating_delta: -9 },
  ];
  const local = [
    { client_id: 'pending-1', result: 'win', difficulty: 'veryhard', duration_seconds: 2400, ended_at: 9000, synced: false },
    { client_id: 'synced-1', result: 'win', difficulty: 'hard', duration_seconds: 1800, ended_at: 5000, synced: true },
    { client_id: 'gone-1', result: 'loss', difficulty: 'easy', duration_seconds: 300, ended_at: 4000, synced: false, dropped: true },
  ];
  const merged = O.mergeHistory(server, local);
  check('newest first across both sources',
    merged.map((r) => r.client_id || 'x').join() === 'pending-1,synced-1,gone-1,x',
    merged.map((r) => (r.client_id || 'x') + '@' + (r.created_at || r.ended_at)).join());
  check('an unsent local row is marked pending', merged[0].pending === true);
  check('a server row is never pending', merged[1].pending === false);
  check('a synced local row is not duplicated',
    merged.filter((r) => r.client_id === 'synced-1').length === 1);
  check('a dropped local row shows, not pending', merged[2].dropped === true && merged[2].pending === false);
  check('local rows are tagged solo', merged[0].mode === 'solo');
  check('local rows carry no rating delta', merged[0].rating_delta === null);
  check('display is capped',
    O.mergeHistory(Array.from({ length: 40 }, (_, i) => ({ created_at: i })), [], 10).length === 10);
  check('empty inputs are safe', O.mergeHistory(null, undefined).length === 0);
  check('server-only still works', O.mergeHistory(server, []).length === 2);
}

// ---------------------------------------------------------------- ai ratings cache

console.log('commander rating cache');
{
  const store = O.createStore(memStorage());
  check('no cache yet reads null', O.readAiRatings(store) === null);
  O.cacheAiRatings(store, [{ participant: 'ai:normal', rating: 1000 }]);
  check('cached anchors read back', O.readAiRatings(store)[0].rating === 1000);
  O.cacheAiRatings(store, []);
  check('an empty payload never clobbers the cache', O.readAiRatings(store)[0].rating === 1000);
  O.cacheAiRatings(store, 'nonsense');
  check('junk never clobbers the cache', O.readAiRatings(store)[0].rating === 1000);
}

// ---------------------------------------------------------------- resilience

console.log('resilience');
{
  const corrupt = O.createStore(memStorage({
    [O.HISTORY_KEY]: '{not json',
    [O.OUTBOX_KEY]: '"a string, not a list"',
    [O.AI_RATINGS_KEY]: 'null',
  }));
  check('corrupt history degrades to empty', O.readHistory(corrupt).length === 0);
  check('wrong-typed outbox degrades to empty', O.readOutbox(corrupt).length === 0);
  check('null ratings cache reads null', O.readAiRatings(corrupt) === null);
  // and a write still lands on top of the junk
  O.recordResult(corrupt, rec('r1'));
  check('recording over a corrupt store works', O.readHistory(corrupt).length === 1);

  const throwing = O.createStore({
    getItem() { throw new Error('blocked'); },
    setItem() { throw new Error('blocked'); },
    removeItem() { throw new Error('blocked'); },
  });
  check('a storage that throws on read yields defaults', O.readHistory(throwing).length === 0);
  let threw = false;
  try { O.recordResult(throwing, rec('r2')); } catch { threw = true; }
  check('a storage that throws on write does not throw out', threw === false);

  const memOnly = O.createStore(null);
  O.recordResult(memOnly, rec('r3'));
  check('a storage-less store works in memory', O.readHistory(memOnly).length === 1);
}

console.log(failures ? `\n${failures} failure(s)` : '\nall offline checks passed');
process.exit(failures ? 1 : 0);
