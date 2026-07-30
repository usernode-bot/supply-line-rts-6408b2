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

// A short scripted match.
//
// newGame assigns ids in ONE fixed order per side: the settlement, then its two
// working farmers, then the war party. So owner 0 is settlement 1, farmhands
// 2/3, WAR PARTY 4 — and owner 1 is settlement 5, farmhands 6/7, war party 8.
// The id-layout check further down pins that, because ordering the farmhands by
// mistake produces a "replay" in which the army never moves (#228).
function script(size) {
  const far = size === 'xsmall' ? 23 : 44;
  return [
    [20, { op: 'setMode', settlementId: 1, mode: 'farm' }],
    [60, { op: 'move', blobId: 4, x: far, y: far }],
    [420, { op: 'pillage', blobId: 4, on: true }],
    [600, { op: 'setMode', settlementId: 1, mode: 'deploy' }],
    [800, { op: 'backToWork' }],
    [900, { op: 'move', blobId: 4, x: far + 5, y: far + 5, target: { kind: 'settlement', id: 5 } }],
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

// ---------------------------------------------------------------- id layout

// The scripted logs above, the staging demo logs in server.js and the ?shot=
// payload in main.js all address entities by literal id, so the opening layout
// is a contract. It was mis-documented as "the war party is blobs 2/3/4", which
// made every hand-written log order farmhands about while the army stood still
// (#228) — pin it so that can't come back.
console.log('opening ids — settlement, two farmhands, then the war party');
{
  const g = S.newGame('ids-1', 'xsmall', 'normal');
  const sett = g.settlements.find((s) => s.owner === 0);
  const mine = g.blobs.filter((b) => b.owner === 0).sort((a, b) => a.id - b.id);
  const theirs = g.blobs.filter((b) => b.owner === 1).sort((a, b) => a.id - b.id);
  check('owner 0\'s home settlement is id 1', sett && sett.id === 1, sett && String(sett.id));
  check('blobs 2 and 3 are working farmhands',
    mine.length === 3 && mine[0].id === 2 && mine[1].id === 3
    && mine[0].working != null && mine[1].working != null,
    mine.map((b) => `${b.id}${b.working != null ? 'F' : ''}`).join(','));
  check('blob 4 is the war party', mine[2].id === 4 && mine[2].count.deploy > 0,
    `${mine[2].id} deploy=${mine[2].count.deploy}`);
  const foeSett = g.settlements.find((s) => s.owner === 1);
  check('owner 1 mirrors it: settlement 5, farmhands 6/7, war party 8',
    foeSett.id === 5 && theirs[0].id === 6 && theirs[1].id === 7
    && theirs[2].id === 8 && theirs[2].count.deploy > 0);
  // and the scripted log actually marches that war party somewhere
  const { g: played } = play('ids-2', 'xsmall', 'normal', 1200, script('xsmall'));
  const army = played.blobs.find((b) => b.id === 4 && !b.dead);
  const moved = !army || Math.hypot(army.x - 11.5, army.y - 9.5) > 4;
  check('the scripted war party actually leaves camp', moved,
    army ? `${army.x.toFixed(1)},${army.y.toFixed(1)}` : 'died in the field');
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
{
  // The end-of-playback card (#228). finishRecording emits no `result` field —
  // only the server's replay row carries one — so a card that read meta.result
  // announced "Defeat" for every local rewatch, including a match just won.
  // The log's terminal entry is the real source, and it lands on the game.
  const { payload } = play('end-1', 'xsmall', 'normal', 900, script('xsmall'));
  check('a local payload carries no result field', payload.result === undefined);
  const recorded = payload.log.find((e) => e.end) || null;
  check('the log states the outcome instead', !!recorded && !!recorded.end);
  const p = RP.createPlayer(payload);
  while (RP.stepPlayer(p)) { /* run it out */ }
  check('the outcome is readable off the played-out game', p.game.result === recorded.end,
    `${p.game.result} vs ${recorded.end}`);
  check('atEnd only goes true once that terminal entry has applied', RP.atEnd(p));
  // and a win reads back as a win, which is what the card renders
  const won = RP.createPlayer({ ...payload, log: payload.log.map((e) => (e.end ? { ...e, end: 'win' } : e)) });
  while (RP.stepPlayer(won)) { /* run it out */ }
  check('a winning recording plays back as a win', won.game.result === 'win', String(won.game.result));
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
  // The invariant main.js relies on (#228): a seek hands back the player's
  // CURRENT game, which a rewind has replaced. Holding the pre-seek object is
  // what made the viewer draw a frozen world while the player stepped a live
  // one — units interpolating back and forth on the spot forever.
  const { payload } = play('seek-3', 'xsmall', 'normal', 1500, script('xsmall'));
  const p = RP.createPlayer(payload);
  const first = p.game;
  const fwd = await RP.seek(p, 900);
  check('a forward seek returns the live game object', fwd === p.game);
  const back = await RP.seek(p, 100);
  check('a rewind returns the live game object', back === p.game);
  check('a rewind really does replace it', back !== first);
  check('the replayed game keeps its replay flag after a rewind', p.game.replay === true);
}

// ---------------------------------------------------------------- reveal map

console.log('reveal map — a drawing override, never a change to the match');
{
  // game.fog is SIMULATION state: the player's pathfinder reads it for known
  // mountains, remembered enemy settlements and known enemy wall tiles. Filling
  // it to "visible" handed the recorded player knowledge they never had, so the
  // playback re-pathed and drifted off the match it was replaying. Run it long
  // enough on a big enough map that the divergence would actually show — the
  // old 600-tick xsmall check passed straight through it.
  for (const [seed, size, ticks] of [['rev-1', 'small', 3000], ['rev-2', 'medium', 3000]]) {
    const { payload } = play(seed, size, 'normal', ticks, script(size));
    const plain = RP.createPlayer(payload);
    const lit = RP.createPlayer(payload);
    RP.setReveal(lit, true);
    RP.runTicks(plain, ticks);
    RP.runTicks(lit, ticks);
    check(`${seed}/${size}: revealing the map leaves the whole state byte-identical`,
      JSON.stringify(S.serialize(plain.game)) === JSON.stringify(S.serialize(lit.game)));
    check(`${seed}/${size}: revealing the map never trips the drift checkpoint`,
      lit.drift === false);
  }
}
{
  // …and it is inert on the sim's own fog array, so keyframes always hold the
  // real fog and turning it back off restores exactly what the player saw.
  const { payload } = play('rev-3', 'xsmall', 'normal', 900, script('xsmall'));
  const p = RP.createPlayer(payload);
  RP.runTicks(p, 300);
  const before = Array.from(p.game.fog).join(',');
  RP.setReveal(p, true);
  check('setReveal does not touch game.fog', Array.from(p.game.fog).join(',') === before);
  RP.runTicks(p, 300);
  check('stepping with reveal on still leaves unseen tiles unseen',
    Array.from(p.game.fog).some((v) => v === 0));
  check('reveal is reported back by setReveal', RP.setReveal(p, true) === true);
  await RP.seek(p, 0);   // through reset(), the deepest rewind there is
  check('reveal survives a rewind past the oldest keyframe', p.reveal === true);
  check('a rebuilt game still has real fog', Array.from(p.game.fog).some((v) => v === 0));
  RP.setReveal(p, false);
  check('reveal turns back off', p.reveal === false);
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
    { t: 200, o: 1, c: { op: 'move', blobId: 8, x: 44, y: 44 } },   // owner 1's WAR PARTY is 8, not 6
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
