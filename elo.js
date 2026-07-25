// Elo math, shared by every path that touches a rating: the solo
// endpoint and the PvP finalizer in server.js / match-runner.js, the
// one-time backfill, and the offline calibration harness
// (test/calibrate-ai.mjs imports this CommonJS module directly).
//
// Two rules make this app's Elo unusual, both deliberate:
//
//   1. The three AI commanders are IMMUTABLE ANCHORS. Their ratings come
//      from calibration/ai-ratings.json and are never moved by anything
//      that happens at runtime — no human result, no K-factor, nothing.
//      `isAnchored()` is the single predicate; callers must never issue
//      an UPDATE against an anchored participant.
//   2. Human-vs-AI is ASYMMETRIC. A win/draw only pays while the player
//      is rated BELOW that commander, and the gain is clamped so it can
//      never carry them past it — each commander is a rating ceiling.
//      Losses always apply the full standard drop. PvP is untouched:
//      ordinary, symmetric, zero-sum Elo.

const START_RATING = 1000;
const RATING_FLOOR = 100;
const ANCHOR_RATING = 1000;         // ai:normal, the calibration anchor
const CALIB_CLAMP = 400;            // fitted AI ratings stay within ±400 of it
const K_PROVISIONAL = 32;           // humans, first 10 rated matches
const K_ESTABLISHED = 16;           // humans, thereafter
const PROVISIONAL_MATCHES = 10;

// 'ai:easy' | 'ai:normal' | 'ai:hard' — everything else is 'user:<id>'.
function isAnchored(participant) {
  return typeof participant === 'string' && participant.startsWith('ai:');
}

function expectedScore(ra, rb) {
  return 1 / (1 + Math.pow(10, (rb - ra) / 400));
}

// Humans only. AI personas have no K-factor — they never move.
function kFactor(ratedMatches) {
  return (ratedMatches || 0) < PROVISIONAL_MATCHES ? K_PROVISIONAL : K_ESTABLISHED;
}

function scoreFromResult(result) {
  if (result === 'win') return 1;
  if (result === 'draw') return 0.5;
  return 0; // 'loss' | 'surrender'
}

// Human vs a fixed AI anchor. Returns the HUMAN's delta; the AI's is
// always exactly 0 (see `aiDelta` on the result for callers that want it
// spelled out). `score` is 1 / 0.5 / 0.
function applyVsAi(humanRating, aiRating, score, k) {
  const raw = k * (score - expectedScore(humanRating, aiRating));
  let delta;
  let capped = false;
  if (score > 0) {
    if (humanRating >= aiRating) {
      delta = 0;                                  // at/above the ceiling: no gain
      capped = true;
    } else {
      const room = aiRating - humanRating;        // can reach it, never pass it
      delta = Math.max(0, Math.min(raw, room));
      capped = raw > room;
    }
  } else {
    delta = raw;                                  // losses always land in full
  }
  const after = Math.max(RATING_FLOOR, humanRating + delta);
  return { delta: after - humanRating, after, aiDelta: 0, capped };
}

// Human vs human: ordinary symmetric Elo, no ceiling, no clamping.
function applyPvp(ratingA, ratingB, scoreA, ka, kb) {
  const ea = expectedScore(ratingA, ratingB);
  const rawA = ka * (scoreA - ea);
  const rawB = kb * ((1 - scoreA) - (1 - ea));
  const afterA = Math.max(RATING_FLOOR, ratingA + rawA);
  const afterB = Math.max(RATING_FLOOR, ratingB + rawB);
  return {
    a: { delta: afterA - ratingA, after: afterA },
    b: { delta: afterB - ratingB, after: afterB },
  };
}

// Closed-form rating fit used by the calibration harness: given a total
// score S (wins + ½ draws) over n matches against the 1000-pinned
// anchor, fit the rating from the score rate instead of walking an
// iterative Elo. The +0.5/+1 smoothing keeps a shutout finite; the ±400
// clamp is what actually binds for a persona that never wins.
function ratingFromScoreRate(totalScore, n, anchor = ANCHOR_RATING) {
  if (!(n > 0)) return { rating: anchor, raw: anchor, scoreRate: 0.5, clamped: false };
  const s = (totalScore + 0.5) / (n + 1);
  const raw = anchor + 400 * Math.log10(s / (1 - s));
  const lo = anchor - CALIB_CLAMP, hi = anchor + CALIB_CLAMP;
  const rating = Math.min(hi, Math.max(lo, raw));
  return { rating, raw, scoreRate: s, clamped: rating !== raw };
}

module.exports = {
  START_RATING,
  RATING_FLOOR,
  ANCHOR_RATING,
  CALIB_CLAMP,
  K_PROVISIONAL,
  K_ESTABLISHED,
  PROVISIONAL_MATCHES,
  isAnchored,
  expectedScore,
  kFactor,
  scoreFromResult,
  applyVsAi,
  applyPvp,
  ratingFromScoreRate,
};
