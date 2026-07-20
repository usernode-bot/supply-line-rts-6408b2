// Attract-mode snapshot pool: pre-simulates AI-vs-AI matches to a
// developed mid-game so the title screen's background can fade in
// immediately instead of warming up client-side. In-memory only — no
// tables, no persistence; snapshots are interchangeable scenery.
//
// The sim modules under public/js are browser ES modules but DOM-free,
// so they load fine in Node via dynamic import(). Node logs a one-time
// MODULE_TYPELESS_PACKAGE_JSON reparse warning for this — harmless; do
// NOT add "type":"module" to package.json (server.js is CommonJS).

const POOL_TARGET = 3;      // ready snapshots to keep on hand (~20 KB each)
const WARMUP_TICKS = 4500;  // 15 min of 1×-speed play — a developed mid-game
const TICKS_PER_SLICE = 300; // yield to the event loop between slices
const MAX_ATTEMPTS = 3;     // degenerate maps (early elimination) get retried

let mods = null;
const pool = [];            // pre-stringified {snapshot, ai0} JSON bodies
let generating = false;

async function loadMods() {
  if (!mods) {
    const [S, ai] = await Promise.all([
      import('./public/js/sim.js'),
      import('./public/js/ai.js'),
    ]);
    mods = { S, aiTick: ai.aiTick };
  }
  return mods;
}

function freshAiState() {
  return { known: {}, lastExpand: 0, lastScout: 0, lastAttack: 0, attacking: false, armyId: null, scoutId: null, expand: null };
}

async function generateOne() {
  const { S, aiTick } = await loadMods();
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const seed = Math.random().toString(36).slice(2, 10);
    const g = S.newGame(seed, 'small', 'normal');
    const ai0 = freshAiState();
    while (g.tick < WARMUP_TICKS && !g.result) {
      const sliceEnd = Math.min(WARMUP_TICKS, g.tick + TICKS_PER_SLICE);
      while (g.tick < sliceEnd && !g.result) {
        S.step(g);
        if (g.tick % 20 === 0) aiTick(g, S, 1, g.ai);
        else if (g.tick % 20 === 10) aiTick(g, S, 0, ai0);
        // keep owner 0's pathing omniscient, matching the solo AI's
        // rules (updateVision rewrites fog every 5 ticks)
        if (g.tick % 5 === 0) g.fog.fill(2);
        g.events.length = 0;
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
    if (!g.result) return JSON.stringify({ snapshot: S.serialize(g), ai0 });
  }
  return null;
}

async function ensureFull() {
  if (generating || pool.length >= POOL_TARGET) return;
  generating = true;
  let json = null;
  try { json = await generateOne(); } catch (err) {
    console.error('attract-pool generation failed:', err.message);
  }
  if (json) pool.push(json);
  generating = false;
  if (pool.length < POOL_TARGET) setTimeout(ensureFull, json ? 0 : 30000);
}

// Pop the oldest ready snapshot (null when the pool is cold) and kick
// off a background refill so the next visitor gets a different match.
function take() {
  const json = pool.shift() || null;
  setImmediate(ensureFull);
  return json;
}

module.exports = { take, warmUp: ensureFull };
