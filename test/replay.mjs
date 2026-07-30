// Headless tests for match replays (#223). Run manually:
//   node test/replay.mjs
//
// A replay is an order log re-run through the sim, so these tests are really
// about one property: the simulation must be a pure function of (seed, sizeKey,
// difficulty, orders). Everything else — seeking, the version gate, the caps,
// the local store — hangs off that.
//
// DOM-free, like the other suites here: replay.js is storage-injected exactly
// so it can be driven from Node.

import * as S from '../public/js/sim.js';
import * as RP from '../public/js/replay.js';
import { applyCommand } from '../public/js/commands.js';
import { createStore } from '../public/js/offline.js';
import { hashSeed } from '../public/js/mapgen.js';

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const snap = (g) => JSON.stringify(S.serialize(g));

// A short scripted match. The home settlement is id 1 and the opening war party
// is blobs 2/3/4 on any fresh game (newGame assigns ids in a fixed order).
function script(size) {
  const far = size === 'xsmall' ? 16 : 30;
  return [
    [20, { op: 'setMode', settlementId: 1, mode: 'farm' }],
    [60, { op: 'move', blobId: 2, x: far, y: far - 2 }],
    [240, { op: 'move', blobId: 3, x: 13, y: 16 }],
    [420, { op: 'pillage', blobId: 2, on: true }],
    [600, { op: 'setRole', blobId: 4, role: 'farm' }],
    [800, { op: 'backToWork' }],
  ];
}

// Drive a live match with the recorder attached, exactly the way main.js's frame
// loop does: advance, checkpoint, then apply the tick's orders.
function play(seed, size, diff, ticks, orders) {
  const g = S.newGame(seed, size, diff);
  const rec = RP.createRecorder(g);
  let i = 0;
  while (g.tick < ticks && !g.result) {
    RP.advance(g);
    RP.recordTick(rec, g);
    while (i < orders.length && orders[i][0] <= g.tick) {
      applyCommand(g, 0, orders[i][1]);
      RP.recordCommand(rec, g.tick, orders[i][1]);
      i++;
    }
  }
  RP.recordEnd(rec, g, g.result || 'surrender');
  return { g, rec, payload: RP.finishRecording(rec) };
}

// ---------------------------------------------------------------- determinism

console.log('determinism — the sim is a pure function of its inputs');
for (const diff of ['easy', 'normal', 'hard', 'veryhard']) {
  const a = play('det-' + diff, 'xsmall', diff, 2000, script('xsmall'));
  const b = play('det-' + diff, 'xsmall', diff, 2000, script('xsmall'));
  // Easy is the one that matters most: its commander is the only one whose
  // decisions ever consumed Math.random (site noise + the random scout probe).
  check(`${diff}: two identical runs are byte-identical`, snap(a.g) === snap(b.g));
}
{
  const a = play('det-seedcheck', 'xsmall', 'normal', 800, script('xsmall'));
  const b = play('det-seedcheck-2', 'xsmall', 'normal', 800, script('xsmall'));
  check('a different seed still produces a different match', snap(a.g) !== snap(b.g));
}
{
  const g = S.newGame('rng-1', 'xsmall', 'normal');
  const first = S.simRand(g), second = S.simRand(g);
  check('simRand advances its state', first !== second);
  check('simRand stays in [0,1)', first >= 0 && first < 1 && second >= 0 && second < 1);
  const h = S.newGame('rng-1', 'xsmall', 'normal');
  check('simRand is seeded from the map seed', S.simRand(h) === first);
}

// ---------------------------------------------------------------- fidelity

console.log('fidelity — a replay reproduces the match it recorded');
{
  const { g, payload } = play('fid-1', 'xsmall', 'normal', 1500, script('xsmall'));
  check('a finished match yields a payload', !!payload);
  check('the payload carries the current engine version', payload.sim_version === S.SIM_VERSION);
  check('the payload records where the match ended', payload.end_tick === g.tick);
  const p = RP.createPlayer(payload);
  while (RP.stepPlayer(p)) { /* run it out */ }
  check('playback reaches the recorded end tick', p.game.tick === g.tick, `${p.game.tick} vs ${g.tick}`);
  check('no integrity checkpoint diverged', p.drift === false);
  const live = S.unitCounts(g, 0), back = S.unitCounts(p.game, 0);
  const liveFoe = S.unitCounts(g, 1), backFoe = S.unitCounts(p.game, 1);
  check('the player ends with the same forces', live.units === back.units && live.setts === back.setts,
    `${live.units}/${live.setts} vs ${back.units}/${back.setts}`);
  check('the enemy ends with the same forces', liveFoe.units === backFoe.units && liveFoe.setts === backFoe.setts,
    `${liveFoe.units}/${liveFoe.setts} vs ${backFoe.units}/${backFoe.setts}`);
  // The one legitimate difference: the live game never reached a result, while
  // the log's terminal entry states one. Everything else must match byte for byte.
  const a = S.serialize(g), b = S.serialize(p.game);
  a.result = b.result = null;
  check('the whole final state matches byte for byte', JSON.stringify(a) === JSON.stringify(b));
  check('the log is small (order log, not snapshots)', JSON.stringify(payload.log).length < 4096,
    `${JSON.stringify(payload.log).length} bytes`);
}
{
  // Integrity checkpoints have to actually fire, or "no drift" means nothing.
  const { payload } = play('fid-2', 'xsmall', 'normal', 1500, script('xsmall'));
  const checks = payload.log.filter((e) => e.u0 != null);
  check('checkpoints are recorded on the 600-tick cadence', checks.length === 2,
    `${checks.length} checkpoints`);
  // Corrupt one and confirm playback notices.
  const bent = { ...payload, log: payload.log.map((e) => (e.u0 != null ? { ...e, u0: e.u0 + 7 } : e)) };
  const p = RP.createPlayer(bent);
  while (RP.stepPlayer(p)) { /* run it out */ }
  check('a mismatched checkpoint is detected as drift', p.drift === true);
}

// ---------------------------------------------------------------- seeking

console.log('seeking — keyframes and re-simulation land on the same state');
{
  const { payload } = play('seek-1', 'xsmall', 'normal', 1500, script('xsmall'));
  const straight = RP.createPlayer(payload);
  await RP.seek(straight, 900);
  const want = snap(straight.game);

  const p = RP.createPlayer(payload);
  await RP.seek(p, 900);
  await RP.seek(p, 300);
  check('a backward seek moves the clock back', p.game.tick === 300);
  await RP.seek(p, 900);
  check('seek back then forward matches playing straight through', snap(p.game) === want);

  await RP.seek(p, 0);
  check('seeking to zero rebuilds the opening state', p.game.tick === 0);
  await RP.seek(p, 900);
  check('replaying from zero still lands on the same state', snap(p.game) === want);

  await RP.seek(p, 999999);
  check('seeking past the end stops at the recorded end', p.game.tick <= payload.end_tick);
  check('atEnd reports a finished replay', RP.atEnd(p));
}
{
  // Reveal-map must not change the simulation — only what is drawn.
  const { payload } = play('seek-2', 'xsmall', 'normal', 900, script('xsmall'));
  const plain = RP.createPlayer(payload);
  RP.runTicks(plain, 600);
  const lit = RP.createPlayer(payload);
  RP.setReveal(lit, true);
  RP.runTicks(lit, 600);
  const a = S.serialize(plain.game), b = S.serialize(lit.game);
  a.fog = b.fog = null;   // fog is the one thing reveal is allowed to touch
  a.known = b.known = null;
  check('revealing the map leaves the simulation untouched', JSON.stringify(a) === JSON.stringify(b));
}

// ---------------------------------------------------------------- version gate

console.log('version gate — one engine, one playable version');
{
  const { payload } = play('gate-1', 'xsmall', 'normal', 600, script('xsmall'));
  check('a current recording is playable', RP.playable(payload) === true);
  check('an older recording is refused', RP.playable({ ...payload, sim_version: S.SIM_VERSION - 1 }) === false);
  check('a newer recording is refused', RP.playable({ ...payload, sim_version: S.SIM_VERSION + 1 }) === false);
  check('a versionless recording is refused', RP.playable({ ...payload, sim_version: undefined }) === false);
  check('createPlayer refuses an older recording rather than half-opening',
    RP.createPlayer({ ...payload, sim_version: S.SIM_VERSION - 1 }) === null);
  check('createPlayer refuses a newer recording',
    RP.createPlayer({ ...payload, sim_version: S.SIM_VERSION + 1 }) === null);
  check('SIM_VERSION is a positive integer', Number.isInteger(S.SIM_VERSION) && S.SIM_VERSION > 0);
}

// ---------------------------------------------------------------- payload round trip

console.log('payload round trip — the PRNG cursor survives save/resume');
{
  const g = S.newGame('rt-1', 'xsmall', 'normal');
  for (let i = 0; i < 400; i++) RP.advance(g);
  const data = S.serialize(g);
  check('serialize stamps v5', data.v === 5);
  check('serialize carries the PRNG cursor', typeof data.rng === 'number');
  const back = S.deserialize(data);
  check('deserialize restores the PRNG cursor', back.rngState === g.rngState);
  // Resumed and continuous play must agree from here on.
  const cont = S.deserialize(S.serialize(g));
  for (let i = 0; i < 300; i++) { RP.advance(g); RP.advance(cont); }
  check('a resumed game continues the same draw sequence', snap(g) === snap(cont));

  // A pre-v5 save has no cursor, so deserialize derives the PRISTINE opening
  // one from the seed (a fresh newGame has already drawn for its start units,
  // so its live cursor sits past that).
  const legacy = S.serialize(S.newGame('rt-legacy', 'xsmall', 'normal'));
  delete legacy.rng;
  legacy.v = 4;
  const old = S.deserialize(legacy);
  check('a pre-v5 payload derives its cursor from the seed',
    old.rngState === hashSeed('rt-legacy:sim'), String(old.rngState));
  check('a pre-v5 payload still deserializes into a usable game',
    old.settlements.length === 2 && old.blobs.length > 0);
}

// ---------------------------------------------------------------- caps

console.log('caps — an outsized recording is dropped, not truncated silently');
{
  const g = S.newGame('cap-1', 'xsmall', 'normal');
  const rec = RP.createRecorder(g);
  for (let i = 0; i < RP.LOG_MAX_ENTRIES + 50; i++) {
    RP.recordCommand(rec, i, { op: 'pillage', blobId: 2, on: true });
  }
  check('the entry cap stops the recorder', rec.overflow === true);
  check('the recorder stops at the cap', rec.orders <= RP.LOG_MAX_ENTRIES);
  RP.recordEnd(rec, g, 'win');
  check('an overrun match yields no payload', RP.finishRecording(rec) === null);
}
{
  const g = S.newGame('cap-2', 'xsmall', 'normal');
  const rec = RP.createRecorder(g);
  // Wall orders carry up to 64 tiles each, so bytes can run out well before
  // entries do — that's why the recorder checks the real serialized length.
  const tiles = Array.from({ length: 64 }, (_, k) => ({ x: k, y: k }));
  for (let i = 0; i < 400; i++) RP.recordCommand(rec, i, { op: 'wallBuild', blobId: 2, tiles });
  check('the byte cap stops the recorder before the entry cap does',
    rec.overflow === true && rec.orders < RP.LOG_MAX_ENTRIES);
  check('an oversized match yields no payload', RP.finishRecording(rec) === null);
}
{
  const g = S.newGame('cap-3', 'xsmall', 'normal');
  const rec = RP.createRecorder(g);
  check('a recording with nothing in it yields no payload', RP.finishRecording(rec) === null);
}

// ---------------------------------------------------------------- local store

console.log('local store — recordings on the device');
{
  const store = createStore(null);   // memory-only, like a ?shot= boot
  const { payload } = play('loc-1', 'xsmall', 'normal', 600, script('xsmall'));
  RP.saveLocal(store, 'cid-1', payload);
  check('a saved log reads back', !!RP.takeLocal(store, 'cid-1'));
  check('the index reports its version', RP.localIndex(store)['cid-1'] === S.SIM_VERSION);
  check('an unknown id reads back nothing', RP.takeLocal(store, 'nope') === null);

  RP.saveLocal(store, 'cid-1', payload);
  check('saving the same id twice does not duplicate it', RP.readLocal(store).length === 1);

  RP.dropLocal(store, 'cid-1');
  check('dropping removes it', RP.takeLocal(store, 'cid-1') === null);

  for (let i = 0; i < RP.LOCAL_MAX + 5; i++) RP.saveLocal(store, 'c' + i, payload);
  check('the device keeps only the newest logs', RP.readLocal(store).length === RP.LOCAL_MAX);
  check('the newest survives the cap', !!RP.takeLocal(store, 'c' + (RP.LOCAL_MAX + 4)));
  check('the oldest was dropped by the cap', RP.takeLocal(store, 'c0') === null);

  // A stale-engine local log can never be played, so reading is where it gets
  // swept rather than lingering behind a button that would refuse anyway.
  RP.saveLocal(store, 'cid-old', { ...payload, sim_version: S.SIM_VERSION - 1 });
  check('a stale local log reads back as nothing', RP.takeLocal(store, 'cid-old') === null);
  check('a stale local log is swept on read', RP.localIndex(store)['cid-old'] === undefined);
}

// ---------------------------------------------------------------- pvp shape

console.log('pvp — both sides\' orders replay from one log');
{
  // A PvP log is recorded server-side and carries an owner per entry, so the
  // player has to honour `o` instead of assuming the viewer gave every order.
  const g = S.newGame('pvp-1', 'small', 'normal', true);
  // Distinct, non-default modes ('farm' is the default, so it would prove
  // nothing) — and one order aimed at the OTHER side's settlement id, which
  // applyCommand must refuse rather than honour.
  const log = [
    { t: 40, o: 0, c: { op: 'setMode', settlementId: 1, mode: 'supply' } },
    { t: 80, o: 1, c: { op: 'setMode', settlementId: 5, mode: 'deploy' } },
    { t: 120, o: 1, c: { op: 'setMode', settlementId: 1, mode: 'off' } },
    { t: 200, o: 1, c: { op: 'move', blobId: 6, x: 40, y: 40 } },
    { t: 400, end: 'p0-win' },
  ];
  const payload = {
    mode: 'pvp', seed: 'pvp-1', size_key: 'small', difficulty: 'normal',
    viewer_owner: 1, result: 'win', duration_seconds: 80, end_tick: 400,
    sim_version: S.SIM_VERSION, log,
  };
  const p = RP.createPlayer(payload);
  check('a pvp replay opens on the viewer\'s own side', p.game.me === 1);
  check('a pvp replay keeps both fog arrays', Array.isArray(p.game.fogs) && p.game.fogs.length === 2);
  while (RP.stepPlayer(p)) { /* run it out */ }
  check('the terminal entry applies the recorded outcome', p.game.result === 'p0-win');
  const foe = p.game.settlements.find((s) => s.owner === 0);
  const mine = p.game.settlements.find((s) => s.owner === 1);
  check('owner 0\'s order was applied to owner 0', foe.mode === 'supply', foe.mode);
  check('owner 1\'s order was applied to owner 1', mine.mode === 'deploy', mine.mode);
  check('an order aimed at the other side\'s settlement is refused', foe.mode !== 'off');
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall replay checks passed');
process.exit(failures ? 1 : 0);
