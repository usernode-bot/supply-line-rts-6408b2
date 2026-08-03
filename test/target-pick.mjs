// Attack-target resolution (#243). Run manually:
//   node test/target-pick.mjs
//
// The reported bug: an armed group right-clicked onto an enemy SUPPLY unit
// standing in open field walked over and then did not attack at all. Combat
// was never the problem — a zero-deploy victim takes full damage and simply
// doesn't return fire — the ORDER was. Two halves, both checked here:
//
//   1. the pick. S.blobAt used to answer with the nearest blob of any kind and
//      the caller tested ownership afterwards, so the player's own army (the
//      biggest circle on the map, and standing right where the last failed
//      order left it) shadowed the caravan and the attack silently became a
//      plain tile move. blobAt now takes a predicate, so "nearest ENEMY" is
//      expressible.
//   2. what a plain tile move does instead — it plans around visible enemies
//      and halts an avoidance ring short with its order quietly completed.
//      That is #169 behaving as designed and is deliberately UNCHANGED here;
//      it is the reason the client must always resolve a target, so it is
//      pinned by a test rather than left as folklore.

import * as S from '../public/js/sim.js';
import { applyCommand } from '../public/js/commands.js';

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// One armed group and one pure-supply enemy caravan, both in open ground in the
// middle of the map with the fog lifted, so neither visibility nor terrain is
// the variable under test.
function field(gap) {
  const g = S.newGame('pick-243', 'small', 'normal');
  g.fog.fill(2);
  const army = g.blobs.find((b) => b.owner === 0 && b.count.deploy > 0 && b.working == null);
  const foe = g.blobs.find((b) => b.owner === 1 && S.total(b) >= 3 && b.working == null);
  for (const u of foe.units) u.role = 'supply';
  foe.count = { deploy: 0, supply: foe.units.length, farm: 0 };
  foe.food = S.foodCap(foe);
  army.food = S.foodCap(army);
  const cx = Math.floor(g.map.w / 2), cy = Math.floor(g.map.h / 2);
  foe.x = cx + 0.5; foe.y = cy + 0.5;
  foe.order = null; foe.path = null; foe.pathGoal = null;
  army.x = foe.x - (gap == null ? 5 : gap); army.y = foe.y;
  army.order = null; army.path = null; army.pathGoal = null;
  return { g, army, foe };
}

const between = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// ------------------------------------------------ the pick loses the enemy
console.log('blobAt picks the nearest ENEMY, not the nearest blob (#243)');
{
  const { g, army, foe } = field(2.83);   // where a failed order parks the army
  // a click 1.5 tiles off the caravan's centre, on the side the army is on:
  // the caravan's edge is 0.09 away, the army's own edge is 0.08 BEHIND the
  // point — so the unfiltered pick answers with the player's own group
  const click = { x: foe.x - 1.5, y: foe.y };
  const anyBlob = S.blobAt(g, click.x, click.y, 0.9);
  check('the unfiltered pick really does answer with the own group',
    anyBlob && anyBlob.id === army.id, anyBlob ? `owner ${anyBlob.owner}` : 'nothing');
  const enemyOnly = S.blobAt(g, click.x, click.y, 0.9, (b) => b.owner !== 0);
  check('the filtered pick answers with the caravan',
    enemyOnly && enemyOnly.id === foe.id, enemyOnly ? `id ${enemyOnly.id}` : 'nothing');

  // the filter also keeps field hands and unseen groups out of the answer
  const hand = g.blobs.find((b) => b.owner === 1 && b.working != null);
  if (hand) {
    hand.x = click.x; hand.y = click.y;
    const skipHands = S.blobAt(g, click.x, click.y, 0.9,
      (b) => b.owner !== 0 && b.working == null);
    check('a working field hand under the cursor never shadows the caravan',
      skipHands && skipHands.id === foe.id, skipHands ? `id ${skipHands.id}` : 'nothing');
  }
  // …and a click INSIDE the caravan's own circle is unambiguous, which is what
  // the dispatch's "landed inside an enemy ⇒ attack it" upgrade rides on
  const inside = S.blobAt(g, foe.x, foe.y, 0, (b) => b.owner !== 0 && b.working == null);
  check('a point inside the caravan resolves it with no slack at all',
    inside && inside.id === foe.id);
  check('a point in open ground resolves nothing with no slack at all',
    S.blobAt(g, foe.x + 6, foe.y + 6, 0, (b) => b.owner !== 0) === null);
}

// ------------------------------------------------ a resolved target connects
console.log('a targeted attack order on a stationary caravan connects');
{
  const { g, army, foe } = field(5);
  const before = S.total(foe);
  const r = S.opMove(g, army, foe.x, foe.y, { kind: 'blob', id: foe.id });
  check('the order is accepted', !!r.ok, r.err);
  check('and it carries the target', army.order.tkind === 'blob' && army.order.tid === foe.id);
  let killedAt = 0;
  for (let i = 0; i < 400 && !foe.dead; i++) { S.step(g); if (foe.dead) killedAt = g.tick; }
  check('the caravan is wiped out', !!foe.dead, `${S.total(foe)} of ${before} left`);
  check('and it took contact to do it', killedAt > 0 && killedAt < 400, `tick ${killedAt}`);
}

// ------------------------------------------------ …and a plain move does not
console.log('a plain tile move onto the same caravan halts short (#169, unchanged)');
{
  const { g, army, foe } = field(5);
  const before = S.total(foe);
  S.opMove(g, army, foe.x, foe.y, null);
  check('the plain order carries no target', !army.order.tkind);
  for (let i = 0; i < 400; i++) S.step(g);
  const gap = between(army, foe);
  check('the group stops outside melee range', gap > S.C.MELEE_RANGE + 0.2, gap.toFixed(2));
  check('the two circles are drawn touching anyway',
    gap < S.blobRadius(army) + S.blobRadius(foe) + 0.5,
    `${gap.toFixed(2)} vs radii ${(S.blobRadius(army) + S.blobRadius(foe)).toFixed(2)}`);
  check('not one carrier is lost', S.total(foe) === before, `${S.total(foe)} of ${before}`);
  check('and the order is gone, with nothing said', !army.order);
}

// ------------------------------------------------ the relay / replay path
console.log('a relayed or replayed attack on a caravan is stamped the same way');
{
  const { g, army, foe } = field(5);
  // exactly the command doMove relays and the replay log stores
  applyCommand(g, 0, {
    op: 'move', blobId: army.id, x: foe.x, y: foe.y,
    target: { kind: 'blob', id: foe.id },
  });
  check('applyCommand stamps the blob target', army.order
    && army.order.tkind === 'blob' && army.order.tid === foe.id,
    army.order ? JSON.stringify(army.order) : 'no order');
  for (let i = 0; i < 400 && !foe.dead; i++) S.step(g);
  check('and the relayed order connects too', !!foe.dead, `${S.total(foe)} left`);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall target-pick checks passed');
process.exit(failures ? 1 : 0);
