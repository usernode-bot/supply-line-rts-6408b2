// Solo save/resume bookkeeping (#240).
//
// Deliberately DOM-free and storage-injected, exactly like offline.js, so
// test/resume.mjs can drive it in Node. main.js owns every side effect
// (fetching, rendering, deciding what to prune); this module owns the rules:
//
//   classify  — is a payload resumable, and if not, WHY not. The menu needs
//               the reason: "nothing saved" and "saved but unreadable" are
//               different screens, and a save that silently vanishes is the
//               bug this module exists to prevent (#240).
//   pick      — which of the local and account copies wins.
//   persist   — write the save, and if the quota refuses, prune and retry
//               rather than failing silently forever.
//   session   — the breadcrumb that tells a fresh boot whether the last page
//               went away MID-MATCH (auto-resume) or was left at the menu.
//
// The version range comes from sim.js so client, server and serializer can
// never drift apart again — that drift (serialize stamping v5 while the menu
// accepted 2–4) is exactly what made every save unresumable.

import { SAVE_VERSION, MIN_SAVE_VERSION } from './sim.js';

export { SAVE_VERSION, MIN_SAVE_VERSION };

export const SAVE_KEY = 'supply-line-save-v1';
export const SESSION_KEY = 'supply-line-session-v1';

// A save this old is still resumable — the age only drives the wording on the
// menu card ("saved 20 seconds ago").
export const STALE_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------- classify

// 'none'       nothing resumable here (absent, or a finished / PvP payload)
// 'ok'         a solo save this build can load
// 'too-new'    written by a newer build of the game
// 'unreadable' corrupt, truncated, or from a version we cannot migrate
export function classifySave(data) {
  if (data == null) return 'none';
  if (typeof data !== 'object' || Array.isArray(data)) return 'unreadable';
  // A finished match or a PvP snapshot is not an in-progress solo save. It is
  // not damaged either, so the menu shows nothing rather than an error card.
  if (data.result || data.pvp) return 'none';
  const v = data.v;
  if (typeof v !== 'number' || !Number.isFinite(v)) return 'unreadable';
  if (v > SAVE_VERSION) return 'too-new';
  if (v < MIN_SAVE_VERSION) return 'unreadable';
  // Shape check: deserialize walks these unconditionally, so a payload missing
  // one is a crash waiting to happen rather than a save.
  if (typeof data.seed !== 'string' && typeof data.seed !== 'number') return 'unreadable';
  if (!data.sizeKey) return 'unreadable';
  if (!Array.isArray(data.blobs) || !Array.isArray(data.settlements)) return 'unreadable';
  if (typeof data.tick !== 'number' || !Number.isFinite(data.tick)) return 'unreadable';
  return 'ok';
}

// A raw localStorage string -> { code, data }. Corrupt JSON is 'unreadable',
// an absent value is 'none' — the caller can tell the two apart and say so.
export function parseSave(raw) {
  if (raw == null || raw === '') return { code: 'none', data: null };
  let data;
  try { data = JSON.parse(raw); } catch { return { code: 'unreadable', data: null }; }
  const code = classifySave(data);
  return { code, data: code === 'ok' ? data : null };
}

// The store wrapper swallows a JSON error and hands back the fallback, so read
// the raw string ourselves — "unreadable" has to survive to the menu.
export function readSave(store) {
  let raw = null;
  try { raw = store.raw ? store.raw(SAVE_KEY) : null; } catch { raw = null; }
  if (raw === null) {
    // Stores without a raw() accessor (the memory stub) still round-trip fine.
    const parsed = store.read(SAVE_KEY, null);
    const code = classifySave(parsed);
    return { code, data: code === 'ok' ? parsed : null };
  }
  return parseSave(raw);
}

export function clearSave(store) { store.remove(SAVE_KEY); }

// ---------------------------------------------------------------- pick

// Cross-device resume (#176): the freshest copy by the client-stamped savedAt
// wins, and the local copy wins a tie — an unload-time write that never got
// pushed is at worst the same age as the account's copy, never older.
export function pickSave(localData, remoteData) {
  const local = classifySave(localData) === 'ok' ? localData : null;
  const remote = classifySave(remoteData) === 'ok' ? remoteData : null;
  if (local && remote) {
    return (remote.savedAt || 0) > (local.savedAt || 0)
      ? { data: remote, source: 'remote' }
      : { data: local, source: 'local' };
  }
  if (local) return { data: local, source: 'local' };
  if (remote) return { data: remote, source: 'remote' };
  return { data: null, source: null };
}

// What the menu card prints. Pure data — main.js owns the wording.
export function saveSummary(data, now) {
  if (classifySave(data) !== 'ok') return null;
  const at = typeof data.savedAt === 'number' ? data.savedAt : 0;
  const t = typeof now === 'number' ? now : 0;
  return {
    difficulty: data.difficulty || 'normal',
    sizeKey: data.sizeKey || 'medium',
    tick: data.tick | 0,
    savedAt: at || null,
    ageMs: at ? Math.max(0, t - at) : null,
    stale: at ? (t - at) > STALE_MS : false,
  };
}

// ---------------------------------------------------------------- persist

// Write the save, and if the browser's quota refuses, run the prune steps in
// order and retry after each. A silently failing autosave is indistinguishable
// from no autosave at all until the page reloads and the match is gone, so the
// caller gets a definite answer either way.
//
// `steps` is [{ name, run }]; a step that throws or returns false is skipped
// without counting as a prune.
export function persistSave(store, data, steps) {
  if (store.write(SAVE_KEY, data)) return { ok: true, pruned: [] };
  const pruned = [];
  for (const step of (Array.isArray(steps) ? steps : [])) {
    let ran = false;
    try { ran = step && step.run && step.run() !== false; } catch { ran = false; }
    if (!ran) continue;
    pruned.push(step.name);
    if (store.write(SAVE_KEY, data)) return { ok: true, pruned };
  }
  return { ok: false, pruned };
}

// ---------------------------------------------------------------- session breadcrumb

// Written whenever a match is saved (and when a PvP match begins), cleared on
// every DELIBERATE exit: back to menu, match over, save discarded. So on boot
// its presence means exactly one thing — the last page went away while a match
// was live — which is the signal auto-resume needs and the only way to tell a
// reload apart from someone who simply quit to the menu.
export function readSession(store) {
  const s = store.read(SESSION_KEY, null);
  if (!s || typeof s !== 'object' || Array.isArray(s)) return null;
  if (!s.active) return null;
  return {
    active: true,
    mode: s.mode === 'pvp' ? 'pvp' : 'solo',
    lobbyId: s.lobbyId != null ? s.lobbyId : null,
    savedAt: typeof s.savedAt === 'number' ? s.savedAt : null,
  };
}

export function markSession(store, mode, extra) {
  const s = { active: true, mode: mode === 'pvp' ? 'pvp' : 'solo', ...(extra || {}) };
  return store.write(SESSION_KEY, s);
}

export function clearSession(store) { store.remove(SESSION_KEY); }

// Should a fresh boot put the player straight back into their match?
// `blocked` covers the boots that must never touch a real match: ?shot=,
// ?demo=1, and any deep link that opens its own scenario.
export function shouldAutoResume(session, saveCode, blocked) {
  if (blocked) return false;
  if (!session || !session.active) return false;
  if (session.mode === 'pvp') return !!session.lobbyId;
  return saveCode === 'ok';
}
