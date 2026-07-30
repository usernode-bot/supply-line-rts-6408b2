// Offline solo play (#221): the local match log and the result outbox.
//
// Deliberately DOM-free and storage-injected so test/offline.mjs can drive it
// in Node the way the sim tests drive sim.js. main.js owns every side effect
// (fetching, rendering); this module owns the bookkeeping:
//
//   history  — the last finished solo matches on this device, newest first,
//              so "Recent matches → Yours" has rows with no server.
//   outbox   — the subset not yet accepted by /api/match-result, oldest
//              first, flushed in play order because Elo is order-dependent.
//
// Both live in localStorage. Every read tolerates a missing/corrupt value the
// same way loadSaveData() does — a mangled key costs you a history list, never
// a boot.

export const HISTORY_KEY = 'supply-line-history-v1';
export const OUTBOX_KEY = 'supply-line-outbox-v1';
export const AI_RATINGS_KEY = 'supply-line-ai-ratings-v1';

export const OUTBOX_MAX = 20;    // unsent results kept before the oldest is dropped
// Strictly larger than OUTBOX_MAX: a result dropped by the outbox cap is
// flagged in the history log rather than deleted, so the log has to have room
// for a full outbox plus the record that just overflowed it.
export const HISTORY_MAX = 30;   // rows kept on the device
export const DISPLAY_MAX = 10;   // rows the menu panel shows (matches the server's LIMIT 10)

// A localStorage-shaped wrapper. `storage` needs getItem/setItem/removeItem;
// pass window.localStorage in the app, a stub in the tests, or nothing at all
// (a memory-only store, which is what a ?shot= boot gets).
export function createStore(storage) {
  const mem = new Map();
  const backing = storage || {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, v); },
    removeItem: (k) => { mem.delete(k); },
  };
  return {
    read(key, fallback) {
      try {
        const raw = backing.getItem(key);
        if (raw == null) return fallback;
        const parsed = JSON.parse(raw);
        return parsed == null ? fallback : parsed;
      } catch { return fallback; }
    },
    write(key, value) {
      try { backing.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
    },
    remove(key) {
      try { backing.removeItem(key); } catch { }
    },
  };
}

const asList = (v) => (Array.isArray(v) ? v : []);

export function readHistory(store) { return asList(store.read(HISTORY_KEY, [])); }
export function readOutbox(store) { return asList(store.read(OUTBOX_KEY, [])); }

// Stable per-match id. `rand` is injected so the tests (and a deterministic
// ?shot= boot) get the same id twice; main.js prefers crypto.randomUUID().
export function newClientId(seed, tick, rand) {
  const r = typeof rand === 'function' ? rand() : 0;
  const noise = Math.floor(Math.abs(r) * 1e9).toString(36);
  return `${String(seed || 'x').slice(0, 24)}-${tick | 0}-${noise}`;
}

// FIFO cap. Returns the trimmed list plus whichever records fell off, so the
// caller can mark them in the history log — a silently vanished result reads
// as a bug, a row that says "not recorded" reads as the truth.
export function capOutbox(list, max = OUTBOX_MAX) {
  const items = asList(list);
  const limit = Math.max(0, max);
  if (items.length <= limit) return { list: items.slice(), dropped: [] };
  const overflow = items.length - limit;
  return { list: items.slice(overflow), dropped: items.slice(0, overflow) };
}

// One finished solo match: newest-first into the history log, oldest-first
// into the outbox. Idempotent on client_id, so a double call (a retry, a
// re-render) can't duplicate a match.
export function recordResult(store, record) {
  if (!record || !record.client_id) return { dropped: [] };
  const entry = {
    client_id: String(record.client_id).slice(0, 64),
    result: record.result,
    difficulty: record.difficulty,
    duration_seconds: Math.max(0, record.duration_seconds | 0),
    map_seed: record.map_seed == null ? null : String(record.map_seed).slice(0, 64),
    ended_at: record.ended_at || null,
    username: record.username || null,
    synced: false,
    dropped: false,
  };

  const history = readHistory(store).filter((r) => r && r.client_id !== entry.client_id);
  history.unshift(entry);
  const outbox = readOutbox(store).filter((r) => r && r.client_id !== entry.client_id);
  outbox.push(entry);

  const capped = capOutbox(outbox, OUTBOX_MAX);
  const droppedIds = new Set(capped.dropped.map((r) => r.client_id));
  const marked = history.map((r) => (droppedIds.has(r.client_id) ? { ...r, dropped: true } : r));

  store.write(HISTORY_KEY, marked.slice(0, HISTORY_MAX));
  store.write(OUTBOX_KEY, capped.list);
  return { dropped: capped.dropped, entry };
}

// Accepted by the server (or found to be already recorded): out of the
// outbox, still in the history log but no longer pending.
export function markSynced(store, clientId) {
  const id = String(clientId);
  store.write(OUTBOX_KEY, readOutbox(store).filter((r) => r && r.client_id !== id));
  store.write(HISTORY_KEY, readHistory(store).map(
    (r) => (r && r.client_id === id ? { ...r, synced: true, dropped: false } : r)));
}

// Abandoned without being recorded (the account mismatch below). Off the
// outbox, flagged in the history log so its row can say so.
export function dropRecord(store, clientId) {
  const id = String(clientId);
  store.write(OUTBOX_KEY, readOutbox(store).filter((r) => r && r.client_id !== id));
  store.write(HISTORY_KEY, readHistory(store).map(
    (r) => (r && r.client_id === id ? { ...r, dropped: true } : r)));
}

// Flush order is play order: 'send' the next one, or 'drop' a result that was
// played while signed in as somebody else. A record with no username was
// played signed out and belongs to whoever is signed in now.
export function syncDecision(record, currentUsername) {
  if (!record || !record.client_id) return 'drop';
  if (!record.username) return 'send';
  if (!currentUsername) return 'send';
  return String(record.username).toLowerCase() === String(currentUsername).toLowerCase()
    ? 'send' : 'drop';
}

// Timestamp a row sorts by: server rows carry created_at, local rows ended_at.
function rowTime(row) {
  const raw = row && (row.created_at || row.ended_at);
  if (raw == null) return 0;
  const t = typeof raw === 'number' ? raw : Date.parse(raw);
  return Number.isFinite(t) ? t : 0;
}

// The menu's "Yours" list: the server's rows plus whatever this device knows
// that the server doesn't yet. A local row is shown only while it is still
// unsent (pending) or was dropped — once the server has it, the server's row
// is the better one (it carries the Elo delta).
export function mergeHistory(serverRows, localRows, limit = DISPLAY_MAX) {
  const server = asList(serverRows).map((r) => ({ ...r, pending: false, dropped: false }));
  const known = new Set(server.map((r) => r.client_id).filter(Boolean));
  const local = asList(localRows)
    .filter((r) => r && !r.synced && !known.has(r.client_id))
    .map((r) => ({
      client_id: r.client_id,
      result: r.result,
      difficulty: r.difficulty,
      duration_seconds: r.duration_seconds,
      map_seed: r.map_seed || null,
      ended_at: r.ended_at || null,
      mode: 'solo',
      opponent: null,
      rating_delta: null,
      pending: !r.dropped,
      dropped: !!r.dropped,
    }));
  return server.concat(local)
    .sort((a, b) => rowTime(b) - rowTime(a))
    .slice(0, Math.max(0, limit));
}

// How many results are still waiting to be sent.
export function pendingCount(store) {
  return readOutbox(store).length;
}

// The commander anchors, cached so the difficulty hint and the Ratings panel
// still say something on a cold offline boot. Committed constants server-side,
// so a stale copy is never wrong — only possibly old.
export function cacheAiRatings(store, ai) {
  if (!Array.isArray(ai) || !ai.length) return;
  store.write(AI_RATINGS_KEY, ai);
}
export function readAiRatings(store) {
  const ai = store.read(AI_RATINGS_KEY, null);
  return Array.isArray(ai) && ai.length ? ai : null;
}
