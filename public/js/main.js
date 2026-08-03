// Boot, menu wiring, match lifecycle, HUD + selection panel, autosave,
// multiplayer lobbies (server-authoritative sim; both clients are
// predicted input consoles syncing snapshots over polling).

import * as S from './sim.js';
import * as SUP from './supply.js';
import { applyCommand } from './commands.js';
import { aiTick } from './ai.js';
import { createRenderer } from './render.js';
import { createInput } from './input.js';
import { startAttract, stopAttract } from './attract.js';
import * as TUT from './tutorial.js';
import * as CT from './controls-tour.js';
import * as OFF from './offline.js';
import * as RP from './replay.js';
import * as ST from './stats.js';
import * as RES from './resume.js';
import { dist, fertTier, FERT_TIERS, passable } from './mapgen.js';
import { pickTol, blobOverlap, footprintDist, tileDist } from './pick.js';
import { drainCatchUp, dropBacklog } from './motion.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const token = params.get('token') || '';
const apiHeaders = token ? { 'x-usernode-token': token } : {};
const SAVE_KEY = RES.SAVE_KEY;
const IS_DEMO = params.get('demo') === '1';
const SHOT = params.get('shot') || ''; // screenshot-state deep link (#199)
// `?mpdebug=1` (#247): logs, per snapshot, how long since the last one landed,
// how many ticks the correction owed, and the biggest per-blob correction in
// tiles. "Sometimes stuttery" needs a number; off by default, and nothing on
// the normal path reads it.
const MP_DEBUG = params.get('mpdebug') === '1';

// A preview boot must not be able to touch a real player's match (#240).
// `?shot=` links are opened with a live token by the platform's "Test this
// change" button, and several of them clear the save and start a game of
// their own — which used to delete the player's match locally AND on the
// server, then autosave the screenshot over it. Everything that persists a
// match goes through this flag now, so there is one switch instead of ten
// call sites that each have to remember.
const persistenceEnabled = !SHOT && !IS_DEMO;

// ---------------------------------------------------------------- offline (#221)
// The sim, the map generator and all four AI commanders are client-side, so a
// solo match needs the server for exactly three things: recording the result,
// the ratings panel and cross-device resume. When it's unreachable we say so
// and keep playing — finished matches queue in `offStore` and flush on
// reconnect (see flushOutbox).
//
// A ?shot= boot must never write to storage, so those get a memory-only store
// (createStore(null)), mirroring how visOverride pins the onboarding flags.
function browserStorage() {
  try { return window.localStorage; } catch { return null; }
}
const offStore = OFF.createStore(SHOT ? null : browserStorage());

// The solo save, its order journal and the session breadcrumb (#240). Split
// from offStore only so `persistenceEnabled` can make a preview boot
// memory-only without also blinding the offline history panel.
const saveStore = OFF.createStore(persistenceEnabled ? browserStorage() : null);

let netDown = false;           // is the server currently unreachable?
let sessionExpired = false;    // token present but rejected — see noteAuthFailure (#240)
let expiredShot = false;       // ?shot=session-expired override
let offlineShot = null;        // ?shot=offline-menu override; see bootOfflineMenu
let replayListShot = null;     // ?shot=replay-list / replay-stale override (#223)
let installPrompt = null;      // captured beforeinstallprompt event

// Everything that reads "are we offline" goes through here so the screenshot
// deep link can force the state without faking a real network failure.
function isOffline() {
  if (offlineShot) return true;
  return netDown;
}

// Any successful request proves we're back; any network-level failure (as
// opposed to a 401/400 answer) proves we're not. `navigator.onLine === false`
// is trusted immediately — false negatives there are rare and cheap.
function noteApiSuccess() {
  if (!netDown) return;
  netDown = false;
  refreshOfflineUi();
}
function noteApiFailure() {
  if (netDown) return;
  netDown = true;
  refreshOfflineUi();
}

// A 401 is NOT the same as being offline (#240): the server is right there,
// it just won't accept this token any more — the iframe's JWT expired under a
// long match. Before this, `noteApiSuccess` counted the 401 as proof we were
// online, so the menu kept claiming everything worked while every button
// failed. Solo play, saving and resuming are entirely client-side and carry
// on regardless; only the account-backed panels go quiet, and they say why.
function isSessionExpired() { return expiredShot || sessionExpired; }
function noteAuthFailure() {
  if (!token || sessionExpired) return;
  sessionExpired = true;
  stopMenuPolling();
  refreshOfflineUi();
}
function noteAuthSuccess() {
  if (!sessionExpired) return;
  sessionExpired = false;
  refreshOfflineUi();
}

// ---------------------------------------------------------------- player state (#212)
// Onboarding progress — which controls page sets have been read, and whether
// the guided tutorial is done — lives against the signed-in account
// (/api/player-state) so it follows the player between devices, with
// localStorage as the cache/fallback for offline play and tokenless boots.
//
// Every flag is MONOTONIC ("has happened", never un-happens), so merging the
// cache and the server is a logical OR in both directions: no timestamps, no
// conflict rules, no authoritative side.

const PS_KEYS = {
  // the tutorial key is the one that shipped before this table existed, so it
  // keeps its name and migrates into the account on the first successful sync
  tutorial_done: 'supply-line-tutorial-done-v1',
  controls_touch_seen: 'supply-line-controls-seen-touch-v1',
  controls_desktop_seen: 'supply-line-controls-seen-desktop-v1',
};
const PS = { tutorial_done: false, controls_touch_seen: false, controls_desktop_seen: false };
let stateLoaded = false;   // has the account's copy answered (or been ruled out)?
let visOverride = null;    // ?shot= boots pin the machine's inputs; see bootShotState

const seenKeyFor = (set) => (set === 'desktop' ? 'controls_desktop_seen' : 'controls_touch_seen');

function loadLocalState() {
  for (const k of Object.keys(PS)) {
    try { PS[k] = localStorage.getItem(PS_KEYS[k]) === '1'; } catch { PS[k] = false; }
  }
  // No account to ask: the cache IS the truth, so render from it immediately.
  if (!token) stateLoaded = true;
}
loadLocalState();

function flag(name) {
  if (visOverride) return !!visOverride[name];
  return !!PS[name];
}

// The single write path. Monotonic, so a second call is a no-op; the cache is
// written first and the account is updated fire-and-forget, exactly like the
// solo save's PUT.
function setFlag(name) {
  if (visOverride) return;         // a screenshot boot must never write anything
  if (PS[name]) return;
  PS[name] = true;
  try { localStorage.setItem(PS_KEYS[name], '1'); } catch { }
  if (token) {
    fetch('/api/player-state', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...apiHeaders },
      body: JSON.stringify({ [name]: true }),
    }).catch(() => { });
  }
  refreshControlsVisibility();
  refreshTutorialButton();
}

// The boot read, modelled on refreshServerSave(): unawaited, never throws, and
// re-renders whatever depends on it once the answer lands.
async function refreshPlayerState() {
  if (!token || visOverride) { stateLoaded = true; return; }
  try {
    const r = await fetch('/api/player-state', { headers: apiHeaders });
    const j = r.ok ? await r.json() : null;
    const remote = (j && j.state && typeof j.state === 'object') ? j.state : {};
    const behind = [];
    for (const k of Object.keys(PS)) {
      if (remote[k] === true && !PS[k]) {
        PS[k] = true;
        try { localStorage.setItem(PS_KEYS[k], '1'); } catch { }
      } else if (PS[k] && remote[k] !== true) {
        behind.push(k); // this device knows something the account doesn't
      }
    }
    // push up anything written while offline (or before this table existed)
    if (behind.length) {
      const patch = {};
      for (const k of behind) patch[k] = true;
      fetch('/api/player-state', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...apiHeaders },
        body: JSON.stringify(patch),
      }).catch(() => { });
    }
  } catch { /* offline / 401 — the cache stands in */ }
  stateLoaded = true;
  refreshControlsVisibility();
  refreshTutorialButton();
  refreshMenu();
}

// ---------------------------------------------------------------- controls visibility (#212)
// Three states, from the two controls marks plus the tutorial mark:
//   1  tutorial not done      → no menu 🕹️; the tutorial teaches the controls
//   2  one set still unread   → menu 🕹️ names that set and boots practice on it
//   3  both sets read         → the menu 🕹️ retires
// The in-match top-bar 🕹️ was removed in #248; the menu button is the only
// controls entry point now, so this state machine drives one control.

// The first unread set, preferring the one this screen actually uses.
function unseenSet() {
  const mine = isMobile() ? 'touch' : 'desktop';
  const other = mine === 'touch' ? 'desktop' : 'touch';
  if (!flag(seenKeyFor(mine))) return mine;
  if (!flag(seenKeyFor(other))) return other;
  return null;
}

function controlsState() {
  if (!flag('tutorial_done')) return 1;
  return unseenSet() === null ? 3 : 2;
}

// The button stays in the DOM and is hidden by class. While the account's
// copy is still in flight everything is hidden: a control may APPEAR once
// progress is known, but must never vanish from under the player's finger.
function refreshControlsVisibility() {
  const state = stateLoaded ? controlsState() : 0;
  const unseen = state === 2 ? unseenSet() : null;
  const menu = $('btn-controls');
  menu.classList.toggle('hidden', !unseen);
  if (unseen) {
    menu.textContent = unseen === 'touch' ? '🕹️ Show controls for mobile' : '🕹️ Show controls for desktop';
  }
}

let game = null;
let view = { cx: 48, cy: 48, scale: 14 };
let speed = 1; // displayed speed step 1–4; the sim multiplier is speed × 0.5
let paused = false;
let ui = { selected: null, pending: null, routeSrc: null, splitCount: null, orderTarget: null, orderTargetEnt: null, fieldCounts: {}, recallCount: null, fieldRole: null, flowOpen: false, flowFor: null, modeOpen: false, ping: null, buildSite: null, wallStart: null, wallEnd: null, hover: null, touchMode: 'select' };

// Phone-sized UI (the sm breakpoint that turns the panel into a bottom
// sheet): mode toggle, contextual tap popups, stats-only panel. Desktop
// and ≥640px touch keep the classic interaction model.
const mqDesktop = window.matchMedia('(min-width: 640px)');
function isMobile() { return !mqDesktop.matches; }
mqDesktop.addEventListener('change', () => {
  lastPanelHTML = ''; // panel markup differs per breakpoint — force re-render
  if (game) { renderPanel(true); }
  // the tour keeps whichever page set is already open — rotating a phone
  // across the 640px line must not swap the content mid-read
  if (CT.active()) CT.tick(view, ui, game);
  // ...but the menu button's label names the viewport's own set first, so it
  // can change when both sets are still unread
  refreshControlsVisibility();
});
let renderer = null, input = null;
let groups = {};                      // control groups (#69): n -> {kind:'blobs', ids} | {kind:'settlement', id}
let lastGroupTap = { n: 0, t: 0 };    // for double-tap-to-center
let lastFrame = 0, acc = 0, lastSaveTick = 0, lastPanel = 0;
let resultPosted = false;
// -- replays (#223) ---------------------------------------------------
let recorder = null;    // the recording of the solo match in progress
let player = null;      // the playback cursor while a replay is open
let replaySpeed = 2;    // 2× is the sim's native rate — see the replay bar
let lastReplayUi = -1;  // tick the transport readouts were last drawn for
let endReplay = null;   // payload behind the end modal's ▶ Watch replay
let shotHover = null;      // ?shot= pins the desktop hover the mouse can't (#234)
let recordingLost = false; // resumed a save with no matching journal (#232)
// -- match statistics (#233) ------------------------------------------
// Sampled every ST.SAMPLE_TICKS by the live loop and by replay playback.
// Never part of S.serialize — journaled beside the order log instead.
let statsSeries = null;
let statsMetric = { units: true, land: true, food: true };
const JOURNAL_KEY = 'supply-line-replay-journal-v1';

// True once a write to storage has failed and pruning didn't rescue it (#240).
// Autosave silently giving up is the difference between "you lost ten seconds"
// and "your match is gone", so it gets said out loud — in the match and on the
// menu card.
let saveDegraded = false;

function readJournal() {
  if (!persistenceEnabled) return null;
  return saveStore.read(JOURNAL_KEY, null);
}
// The journal beside the autosave: the in-flight order log AND the sampled
// stats series while a recording is live, the stats series ALONE once it
// isn't (#244). The chart is a record of what the viewer watched, not
// simulation state, so it must not be lost to the replay's strict provenance
// rules — a resumed match whose log couldn't be proved still keeps its graph.
//
// Returns whether the write landed (#245): the save is the authority on tick,
// so a journal that silently failed is stale the moment the save lands and
// every later resume would reject it. The caller acts on that instead.
function writeJournal() {
  if (!persistenceEnabled || !game) return false;
  const payload = recorder
    ? RP.journalOf(recorder, game, statsSeries)
    : RP.statsJournalOf(game, statsSeries);
  if (!payload) return false;
  return saveStore.write(JOURNAL_KEY, payload);
}
function clearJournal() {
  if (!persistenceEnabled) return;
  saveStore.remove(JOURNAL_KEY);
}

let panelHeld = false;
let toastTimer = null;
let lastPanelHTML = '';
let lastStripHTML = '';

// -- multiplayer state ------------------------------------------------
let me = 0;        // which owner this client plays (0 solo/host, 1 guest)
let mp = null;     // { lobbyId, role, opponent, timer, ... } while in a PvP match
let waiting = null;   // { id, challenge, timer } while a lobby/challenge waits
let menuTimer = null;
let mineLobby = null;                 // my active lobby (for Rejoin)
let seenChallengeIds = new Set();     // for "challenge withdrawn" toasts
let actedChallengeIds = new Set();    // accepted/declined — no withdrawn toast
let dismissedDemoChallenge = false;   // hide the injected staging demo challenge
let suggestTimer = null;

// In a PvP match every order is relayed to the server-authoritative sim
// (and echoed into the local predicted one) — for both roles alike.
function inPvp() { return !!(mp && game && game.pvp); }

async function api(path, body) {
  const opts = body !== undefined
    ? { method: 'POST', headers: { 'Content-Type': 'application/json', ...apiHeaders }, body: JSON.stringify(body) }
    : { headers: apiHeaders };
  let res;
  try {
    res = await fetch(path, opts);
  } catch (e) {
    noteApiFailure();   // network-level: we're offline, not unauthorised
    throw e;
  }
  noteApiSuccess();     // the server answered — even a 401 proves reachability
  if (res.status === 401) noteAuthFailure();   // ...but not that it knows us (#240)
  else noteAuthSuccess();
  let data = {};
  try { data = await res.json(); } catch { }
  if (!res.ok) {
    const err = new Error(data.error || ('Request failed (' + res.status + ')'));
    err.status = res.status;
    throw err;
  }
  return data;
}

// ---------------------------------------------------------------- menu

// "Yours" always renders from the merge of the server's rows and this
// device's own log (#221), so a match finished offline shows up at once and
// stays visible — marked pending — until it has been recorded.
function localHistoryRows() {
  if (replayListShot) return [];   // ?shot=replay-list pins the server rows (#223)
  if (offlineShot) return offlineShot.local;
  return OFF.readHistory(offStore);
}

function renderMineRows(serverRows) {
  const mineEl = $('history-mine-rows');
  // ?shot=replay-list (#223) pins the rows so the panel renders identically in
  // every environment, the same way offlineShot pins the offline menu's.
  if (replayListShot) serverRows = replayListShot;
  lastServerHistory = Array.isArray(serverRows) ? serverRows : [];
  refreshLocalReplayIndex();   // which pending rows have a local recording (#223)
  const rows = OFF.mergeHistory(lastServerHistory, localHistoryRows());
  const tag = (m) => m.mode === 'pvp' ? `vs ${esc(m.opponent || '?')}` : esc(diffLabel(m.difficulty));
  if (!rows.length) {
    mineEl.innerHTML = '<span class="text-zinc-600">No matches yet — start one above!</span>';
    return;
  }
  mineEl.innerHTML = rows.map(m => `
      <div class="flex justify-between gap-2 items-baseline">
        <span class="${m.result === 'win' ? 'text-emerald-400' : 'text-red-400'}">${m.result === 'win' ? 'Victory' : m.result === 'surrender' ? 'Surrendered' : 'Defeat'}</span>
        <span class="text-zinc-500 truncate">${tag(m)}</span>
        ${m.pending ? '<span class="text-amber-400 text-xs shrink-0">pending</span>'
      : m.dropped ? '<span class="text-zinc-600 text-xs shrink-0">not recorded</span>'
        : `<span class="font-mono ${deltaClass(m.rating_delta)} w-10 text-right">${fmtDelta(m.rating_delta)}</span>`}
        <span class="font-mono text-zinc-500">${fmtDur(m.duration_seconds)}</span>
        ${replayBtnHTML(m)}
      </div>`).join('');
  const waiting = offlineShot ? offlineShot.pending : OFF.pendingCount(offStore);
  if (waiting > 0) {
    mineEl.innerHTML += `<div class="text-xs text-amber-500/80 pt-1">${waiting} result${waiting === 1 ? '' : 's'} waiting to sync${isOffline() ? '' : '…'}</div>`;
  }
}

async function loadHistory() {
  const recentEl = $('history-recent-rows');
  if (isOffline()) {
    renderMineRows([]);
    recentEl.textContent = '—';
    return;
  }
  try {
    const res = await fetch('/api/matches', { headers: apiHeaders });
    noteApiSuccess();
    if (res.status === 401) noteAuthFailure(); else if (res.ok) noteAuthSuccess();
    if (!res.ok) {
      // Reachable but not authorised: local rows still stand on their own, and
      // so do a ?shot= boot's pinned rows (#223) — neither needs an account.
      renderMineRows([]);
      if (!localHistoryRows().length && !replayListShot) {
        $('history-mine-rows').textContent = 'Sign in via Usernode to see your matches.';
      }
      recentEl.textContent = '—';
      return;
    }
    const { mine, recent } = await res.json();
    const tag = (m) => m.mode === 'pvp' ? `vs ${esc(m.opponent || '?')}` : esc(diffLabel(m.difficulty));
    renderMineRows(mine);
    recentEl.innerHTML = recent.length ? recent.map(m => `
      <div class="flex justify-between gap-2">
        <span class="truncate">${esc(m.username)}</span>
        <span class="text-zinc-500 truncate">${tag(m)}</span>
        <span class="font-mono text-zinc-500">${fmtDur(m.duration_seconds)}</span>
      </div>`).join('') : '<span class="text-zinc-600">No wins recorded yet.</span>';
  } catch {
    noteApiFailure();
    renderMineRows([]);
    recentEl.textContent = '—';
  }
}

// Per-row Elo change: a stored 0 (the ceiling zeroed the gain) reads
// "—", an unrated row (null) shows nothing at all.
function fmtDelta(d) {
  if (d == null) return '';
  const r = Math.round(d);
  if (r === 0) return '—';
  return (r > 0 ? '+' : '') + r;
}
function deltaClass(d) {
  if (d == null) return 'text-zinc-600';
  const r = Math.round(d);
  return r > 0 ? 'text-emerald-400' : r < 0 ? 'text-red-400' : 'text-zinc-600';
}

// Display name for a stored difficulty key. History rows store the raw
// key ('veryhard'), which is not what a human should read.
const DIFF_LABELS = { easy: 'Easy', normal: 'Normal', hard: 'Hard', veryhard: 'Very Hard' };
function diffLabel(key) { return DIFF_LABELS[key] || String(key == null ? '' : key); }

// Ratings panel + difficulty-hint Elo. The AI anchors are fixed, so
// caching them for the menu session is safe; `myRating` is refreshed
// whenever the menu reloads.
let aiRatings = null;   // { easy: {...}, normal: {...}, hard: {...}, veryhard: {...} }
let myRating = null;

// The commander anchors come from a public endpoint (committed
// constants), the player rows from the authenticated one — so the panel
// and the difficulty hint still say something useful without an account.
// The commander anchors are committed constants, so the last copy this device
// saw is still true — cache it (#221) and seed from the cache before the first
// fetch resolves, which is what keeps the difficulty hint's Elo and the
// Ratings panel alive on a cold offline boot.
function applyAiRatings(ai) {
  if (!Array.isArray(ai) || !ai.length) return false;
  aiRatings = {};
  for (const a of ai) aiRatings[a.participant.replace('ai:', '')] = a;
  return true;
}
applyAiRatings(OFF.readAiRatings(offStore));

async function loadRatings() {
  const rowsEl = $('ratings-rows'), mineEl = $('my-rating');
  const cached = (offlineShot && offlineShot.ai) || OFF.readAiRatings(offStore) || [];
  let ai = cached, me = null, top = [], signedIn = false;
  if (!isOffline()) {
    try {
      const fresh = (await (await fetch('/api/ai-ratings')).json()).ai || [];
      if (fresh.length) { ai = fresh; OFF.cacheAiRatings(offStore, fresh); }
    } catch { /* offline / 503 — the cache stands in */ }
    try {
      const res = await fetch('/api/ratings', { headers: apiHeaders });
      // The boot request that learns fastest whether our token still works (#240).
      if (res.status === 401) noteAuthFailure(); else if (res.ok) noteAuthSuccess();
      if (res.ok) {
        const data = await res.json();
        me = data.me; top = data.top || []; signedIn = true;
        if (data.ai && data.ai.length) { ai = data.ai; OFF.cacheAiRatings(offStore, data.ai); }
      }
    } catch { /* menu never blocks on ratings */ }
  }
  if (!applyAiRatings(ai)) aiRatings = null;

  myRating = me ? me.rating : null;
  if (me && me.username) currentUsername = me.username;
  mineEl.textContent = me ? `Your rating: ${me.rating}`
    : isOffline() ? 'Your rating: — (offline)'
      : signedIn ? 'Your rating: 1000 (unrated)' : 'Your rating: —';

  const rows = ai.map(a => ({
    name: a.username, rating: a.rating, ai: true,
    note: a.calib_matches ? `calibrated over ${a.calib_matches} sparring matches` : 'the anchor — pinned at 1000',
  })).concat(top.map(t => ({
    name: t.username, rating: t.rating, ai: false,
    note: `${t.rated_matches} rated match${t.rated_matches === 1 ? '' : 'es'}`,
    me: !!(me && t.username === me.username),
  })));
  rows.sort((a, b) => b.rating - a.rating);
  if (me && !rows.some(r => r.me)) {
    rows.push({ name: me.username, rating: me.rating, ai: false, me: true,
      note: `${me.rated_matches} rated match${me.rated_matches === 1 ? '' : 'es'}` });
  }
  rowsEl.innerHTML = rows.length ? rows.map(r => `
      <div class="flex items-baseline justify-between gap-2 ${r.me ? 'bg-zinc-800/60 -mx-1 px-1 rounded' : ''}">
        <span class="truncate ${r.ai ? 'text-sky-300' : r.me ? 'text-zinc-100 font-semibold' : 'text-zinc-300'}">
          ${r.ai ? '🤖 ' : ''}${esc(r.name)}${r.me ? ' (you)' : ''}
        </span>
        <span class="text-zinc-600 text-xs truncate flex-1 text-right">${esc(r.note)}</span>
        <span class="font-mono text-zinc-300 w-12 text-right">${r.rating}</span>
      </div>`).join('')
    : '<span class="text-zinc-600">Ratings unavailable.</span>';
  refreshDifficultyHint();
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtDur(sec) {
  sec = Math.max(0, sec | 0);
  return `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, '0')}s`;
}
// Display name for a stored map-size key ('xsmall' → 'Very small').
function sizeLabel(key) {
  if (key === 'xsmall') return 'Very small';
  const s = String(key || '');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// The save gate lives in resume.js now (#240) and reads its version range
// straight off sim.js, so the serializer, the menu and the server can never
// disagree about what a valid save is again. v1 saves predate per-unit health
// and are not migratable; v2–v4 load fine (new fields default; farmer HP is
// clamped; old attack-move orders are migrated by deserialize).
function loadSaveData() { return RES.readSave(saveStore); }

// Cross-device resume (#176): solo saves also live server-side under the
// player's account. The freshest of the local and server copies (by the
// savedAt stamp; older saves without one count as 0) drives Resume.
let serverSaveData = null;
let saveShot = null;    // ?shot=resume-card / resume-unreadable pin (#240)

// The menu's whole view of "is there a match to come back to":
//   { code, data, source } where code is 'none' | 'ok' | 'too-new' | 'unreadable'.
// A damaged save has to reach the menu as a REASON, not as a missing button —
// silently hiding Resume is what made #240 read as "my game is just gone".
function saveState() {
  if (saveShot) return saveShot;
  const local = loadSaveData();
  const picked = RES.pickSave(local.data, serverSaveData);
  if (picked.data) return { code: 'ok', data: picked.data, source: picked.source };
  // Nothing loadable. Prefer whichever side has an actual complaint to make.
  if (local.code !== 'none') return { code: local.code, data: null, source: 'local' };
  const remoteCode = RES.classifySave(serverSaveData);
  if (remoteCode !== 'none') return { code: remoteCode, data: null, source: 'remote' };
  return { code: 'none', data: null, source: null };
}

function bestSave() {
  const st = saveState();
  return st.code === 'ok' ? st.data : null;
}

async function refreshServerSave() {
  if (!token) return; // no account outside the platform shell — local only
  try {
    const r = await fetch('/api/save', { headers: apiHeaders });
    noteApiSuccess();
    if (r.status === 401) noteAuthFailure(); else noteAuthSuccess();
    const j = r.ok ? await r.json() : null;
    serverSaveData = j && j.save ? j.save.data : null;
  } catch { serverSaveData = null; noteApiFailure(); }
  refreshMenu();
}

// Finished/discarded matches clear the save everywhere (fire-and-forget
// on the server side, like the match-result post).
function clearSaves() {
  if (!persistenceEnabled) return;   // a preview boot owns no save (#240)
  RES.clearSave(saveStore);
  clearJournal();                    // #232: the log dies with its save
  RES.clearSession(saveStore);
  saveDegraded = false;
  serverSaveData = null;
  if (token) fetch('/api/save', { method: 'DELETE', headers: apiHeaders }).catch(() => { });
}

// How long ago, in words. Short and absolute — "saved 20 seconds ago" is the
// one fact that tells a returning player whether this is the match they were
// just playing.
function fmtAgo(ms) {
  if (ms == null) return 'just now';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 45) return `${s} second${s === 1 ? '' : 's'} ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} hour${h === 1 ? '' : 's'} ago`;
  return `${Math.round(h / 24)} days ago`;
}

// The menu's in-progress-match card. Three states, and every one of them says
// something: a resumable match describes itself, a broken one explains itself
// and offers the only clean way out, and no save at all shows nothing.
function refreshMenu() {
  const st = saveState();
  const card = $('resume-card');
  const broken = $('resume-broken');
  const ok = st.code === 'ok';
  card.classList.toggle('hidden', !ok);
  broken.classList.toggle('hidden', !(st.code === 'too-new' || st.code === 'unreadable'));
  if (ok) {
    const sum = RES.saveSummary(st.data, Date.now());
    const bits = [
      diffLabel(sum.difficulty),
      `${sizeLabel(sum.sizeKey)} map`,
      `${fmtDur(S.gameSeconds(sum.tick))} played`,
    ];
    const where = st.source === 'remote' ? ' on another device' : '';
    $('resume-detail').textContent =
      `${bits.join(' · ')} — saved${where} ${fmtAgo(sum.ageMs)}.`;
    $('resume-degraded').classList.toggle('hidden', !saveDegraded);
  } else if (!broken.classList.contains('hidden')) {
    $('resume-broken-detail').textContent = st.code === 'too-new'
      ? 'It was saved by a newer version of the game, so this one can\'t read it. Your recorded matches and your rating are unaffected.'
      : 'The saved data was damaged or incomplete, so it can\'t be loaded. Your recorded matches and your rating are unaffected.';
  }
}

// ---------------------------------------------------------------- offline UI (#221)

// The offline badge and the multiplayer stand-in. Solo play needs nothing from
// the server, so the menu's job offline is to say which panels are asleep —
// not to show three failed fetches.
function refreshOfflineUi() {
  const off = isOffline();
  const expired = isSessionExpired();
  // Two different sentences, never both: "no connection" and "the server
  // doesn't know you any more" need different things from the player (#240).
  $('offline-badge').classList.toggle('hidden', !off);
  $('expired-badge').classList.toggle('hidden', off || !expired);
  const asleep = off || expired;
  $('mp-offline').classList.toggle('hidden', !off);
  $('mp-expired').classList.toggle('hidden', off || !expired);
  $('mp-forms').classList.toggle('hidden', asleep);
  $('challenge-inbox').classList.toggle('hidden', asleep);
  if (asleep) {
    $('btn-mp-rejoin').classList.add('hidden');
    $('mp-waiting').classList.add('hidden');
    stopMenuPolling();
  }
}

// The "Play offline" card. The install button only exists once the browser has
// actually offered a prompt (Chrome/Edge/Android); everyone else gets the
// open-in-its-own-tab link, which is the path that works on iOS too. The whole
// card is pointless where service workers don't exist.
function refreshOfflineCard() {
  const supported = typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
  $('offline-card').classList.toggle('hidden', !supported);
  $('btn-install').classList.toggle('hidden', !installPrompt);
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  refreshOfflineCard();
});
window.addEventListener('appinstalled', () => {
  installPrompt = null;
  refreshOfflineCard();
  toast('📥 Installed — launch it any time, online or not');
});

$('btn-install').addEventListener('click', async () => {
  if (!installPrompt) return;
  const p = installPrompt;
  installPrompt = null;
  refreshOfflineCard();
  try { await p.prompt(); } catch { }
});

// Connectivity events. `online` is the cue to catch up on everything the menu
// skipped while it was down — including the queued results.
window.addEventListener('offline', () => { noteApiFailure(); });
window.addEventListener('online', () => {
  netDown = false;
  refreshOfflineUi();
  flushOutbox();
  if (!game) {
    refreshServerSave();
    loadHistory();
    loadRatings();
    startMenuPolling();
  }
});

// Queued solo results, oldest first — Elo is order-dependent, so a failure
// stops the flush rather than skipping ahead. No token means no account to
// credit: the records simply wait.
let flushing = false;
async function flushOutbox() {
  if (flushing || offlineShot || !token || isOffline()) return;
  flushing = true;
  try {
    while (true) {
      const queue = OFF.readOutbox(offStore);
      if (!queue.length) break;
      const rec = queue[0];
      if (OFF.syncDecision(rec, currentUsername) === 'drop') { OFF.dropRecord(offStore, rec.client_id); continue; }
      let data;
      try {
        // The recording rides along with the result (#223) — one idempotent
        // call, so an offline match and its replay reach the server together.
        // The server drops a malformed log rather than failing the result.
        const replay = RP.takeLocal(offStore, rec.client_id);
        data = await api('/api/match-result', {
          result: rec.result,
          difficulty: rec.difficulty,
          duration_seconds: rec.duration_seconds,
          map_seed: rec.map_seed,
          client_id: rec.client_id,
          replay: replay || undefined,
        });
      } catch (e) {
        // A 400 means the server will never accept this record — drop it
        // instead of wedging the queue behind it. Anything else is transient.
        if (e && e.status === 400) { OFF.dropRecord(offStore, rec.client_id); continue; }
        break;
      }
      OFF.markSynced(offStore, rec.client_id);
      // The server owns the recording now and the history row carries its id,
      // so the device copy has done its job (#223).
      RP.dropLocal(offStore, rec.client_id);
      lastFlushResult = { client_id: rec.client_id, data };
      if (data && data.rating != null) myRating = data.rating;
    }
  } finally {
    flushing = false;
  }
  if (!game) renderMineRows(lastServerHistory);
}

// Whose results these are. Learned from /api/ratings (the only endpoint that
// echoes the caller's username back), and only used to refuse crediting one
// account's offline match to another.
let currentUsername = null;
let lastServerHistory = [];   // the newest /api/matches rows, for re-renders
let lastFlushResult = null;   // { client_id, data } of the last accepted result

// Every difficulty plays by the player's economic rules — the levels
// differ only in how well the AI commander plays (see DIFF in sim.js).
const DIFF_HINTS = {
  easy: 'A careless commander.',
  normal: 'The standard opponent.',
  hard: 'Alert, well-supplied and opportunistic — raids your supply lines, breaches your walls, and reinforces its sieges.',
  veryhard: 'Relentless: weighs your armies before it commits, supplies its walls and chokepoints, hunts two caravan raids at once, and answers a siege in seconds.',
};
function refreshDifficultyHint() {
  const key = $('sel-difficulty').value;
  let text = DIFF_HINTS[key] || '';
  // Every rating embellishment is additive: with no /api/ratings data the
  // hint stays exactly what it has always been.
  const ai = aiRatings && aiRatings[key];
  if (ai) {
    text += ` · Elo ${ai.rating}`;
    if (myRating != null && myRating >= ai.rating) {
      text += " — you're rated above this commander, so a win won't raise your rating.";
    }
  }
  $('difficulty-hint').textContent = text;
}
$('sel-difficulty').addEventListener('change', refreshDifficultyHint);
refreshDifficultyHint();

function startNewMatch() {
  clearSaves();
  const seed = $('inp-seed').value.trim() || Math.random().toString(36).slice(2, 10);
  const size = $('sel-mapsize').value;
  const diff = $('sel-difficulty').value;
  try {
    me = 0;
    startMatch(S.newGame(seed, size, diff));
  } catch (e) {
    showMenuError('Could not start the match: ' + (e && e.message || e));
  }
}

$('btn-new').addEventListener('click', () => {
  if (waiting) { showMenuError('Cancel your multiplayer lobby first.'); return; }
  if (bestSave()) {
    showConfirm('Match already in progress',
      'You have a match in progress. You can resume it, or discard it and start a new one.', [
      { label: '▶ Resume that match', cls: 'bg-emerald-700 hover:bg-emerald-600 text-white', fn: () => $('btn-resume').click() },
      { label: '🗑️ Discard & start new', cls: 'bg-red-700 hover:bg-red-600 text-white', fn: startNewMatch },
    ]);
    return;
  }
  startNewMatch();
});

// The one resume path, shared by the button and by the automatic recovery a
// reload triggers (#240). Returns true if a match is now on screen.
function resumeSaved(opts) {
  const data = bestSave();
  if (!data) { refreshMenu(); return false; }
  let g;
  try {
    g = S.deserialize(data);
  } catch (e) {
    // Classified 'ok' but it still won't load — the only honest outcome is to
    // say so and clear it, rather than leave a button that always fails.
    clearSaves();
    refreshMenu();
    showMenuError('Saved match could not be loaded — it was discarded.');
    return false;
  }
  me = 0;
  startMatch(g, { view: data.view });
  // the chosen save becomes the local copy — it may have arrived from
  // another device (#176)
  saveStore.write(SAVE_KEY, data);
  if (opts && opts.paused) {
    paused = true;
    $('btn-pause').textContent = '▶';
  }
  return true;
}

$('btn-resume').addEventListener('click', () => { resumeSaved(); });

// The dead end out of a save this build can't read. Discarding is the only
// clean action, so it's the only button — but it asks first, because a save
// that is merely from a newer build may still load in the tab next door.
$('btn-resume-discard').addEventListener('click', () => {
  showConfirm('Discard the saved match?',
    'It can\'t be loaded by this version of the game. Discarding clears it so the menu stops offering it.', [
    { label: '🗑️ Discard it', cls: 'bg-red-700 hover:bg-red-600 text-white', fn: () => {
      saveShot = null;
      clearSaves();
      refreshMenu();
      toast('Saved match discarded');
    } },
  ]);
});

// ---------------------------------------------------------------- tutorial (#185)
// A scripted, ephemeral solo scenario driven by tutorial.js: never saved,
// never recorded, and it leaves any in-progress solo save untouched.

function refreshTutorialButton() {
  $('btn-tutorial').textContent = flag('tutorial_done') ? '📖 Replay tutorial' : '📖 Tutorial';
}

function beginTutorial(g) {
  TUT.begin(g, { ui, view, isMobile, onExit: confirmExitTutorial, onFinish: finishTutorial, onKeepPlaying: keepPlayingTutorial });
}

function startTutorial() {
  try {
    me = 0;
    const g = S.newTutorialGame();
    startMatch(g);
    // The controls tour runs FIRST, as step 0 of onboarding, on BOTH widths —
    // the hands-on touch steps on a phone, the mouse & keyboard pages on a
    // desktop screen. It has to come before TUT.begin because the gestures it
    // asks for (pan, pinch, tap a unit) only work while the scenario's
    // per-step input gating is still inert. So arm a handoff and defer the
    // begin into the tour's close. Skipped once this platform's set is read.
    const set = isMobile() ? 'touch' : 'desktop';
    if (!SHOT && !flag(seenKeyFor(set))) {
      pendingTutorialBegin = { game: g, persist: true };
      openControlsTour({
        mode: 'tour', set, gated: set === 'touch' && isMobile(),
        finishLabel: '✓ Start the tutorial', skipLabel: 'Skip to tutorial',
      });
    } else {
      beginTutorial(g);
    }
  } catch (e) {
    showMenuError('Could not start the tutorial: ' + (e && e.message || e));
  }
}

$('btn-tutorial').addEventListener('click', () => {
  if (waiting) { showMenuError('Cancel your multiplayer lobby first.'); return; }
  startTutorial();
});

function confirmExitTutorial() {
  showConfirm('Exit the tutorial?', 'You can restart it any time from the main menu.', [
    { label: '🚪 Exit tutorial', cls: 'bg-red-700 hover:bg-red-600 text-white', fn: () => { TUT.end(); backToMenu(); } },
  ]);
}

function finishTutorial() {
  setFlag('tutorial_done');
  TUT.end();
  backToMenu();
}

// "Keep playing" on the completion step: the guided session ends (card,
// markers, input gating, hidden top-bar controls) but the match carries on
// with the enemy commander switched on. game.sandbox keeps it a throwaway —
// never saved, never recorded, and it never clears the player's real save.
function keepPlayingTutorial() {
  if (!game || !game.tutorial) return;
  setFlag('tutorial_done');
  TUT.end();
  game.tutorial = false; // gating, AI skip and hint suppression all key off this
  game.sandbox = true;
  $('sel-speed').classList.remove('hidden');
  $('btn-surrender').classList.remove('hidden');
  renderPanel(true);
  toast('⚔️ The enemy commander wakes up — good luck!');
}

// A tutorial game that somehow reaches a result (the whole force lost, or
// the enemy wiped out ahead of the script) gets its own card — no match
// record, no save clearing, unlike endMatch.
function tutorialOver(result) {
  const win = result === 'win';
  showConfirm(win ? 'Tutorial: victory!' : 'Tutorial over',
    win ? 'You wiped out the enemy entirely — ahead of schedule. Ready for a real match!'
      : 'Your force was lost — it happens. Restart the tutorial or head back to the menu.',
    [
      { label: '🔁 Restart tutorial', cls: 'bg-violet-600 hover:bg-violet-500 text-white', fn: () => { TUT.end(); startTutorial(); } },
      { label: '🏠 Back to menu', cls: 'bg-zinc-700 hover:bg-zinc-600 text-zinc-100', fn: () => { TUT.end(); backToMenu(); } },
    ]);
}

// ---------------------------------------------------------------- controls tour (#212)
// A hands-on touch-controls card: every step waits for the real gesture (see
// controls-tour.js and the CT.signal call sites through this file). It gates
// nothing itself and runs over any match — a real one, the tutorial map before
// its scenario begins, or the throwaway practice sandbox behind the menu's 🕹️
// button. The in-game 🕹️ opens the same pages as a read-only reference.

let tourPausedBefore = null; // the paused value to restore when the tour closes

// { game, persist } while the tour is fronting 📖 Tutorial on a phone: the
// guided scenario to begin once the player finishes or skips the tour.
let pendingTutorialBegin = null;

// Runs on EVERY close path of a prelude tour — ✓ Start the tutorial, Skip to
// tutorial, or the 🕹️ toggle — so "the scenario started" and "the tour counts
// as delivered" stay in lockstep. Force-closes (match over, back to menu)
// clear the pending entry first and so never land here.
function runPendingTutorialBegin(set) {
  const pending = pendingTutorialBegin;
  pendingTutorialBegin = null; // clear first: a re-entrant close must not double-begin
  if (!pending) return;
  if (pending.game !== game || !game.tutorial || game.result) return;
  // credit the set that was ON SCREEN, so a mid-prelude swap marks what was
  // actually read — and do it even when the 🕹️ toggle closed with seen:false,
  // so "the scenario started" and "the pages were delivered" stay in lockstep
  if (pending.persist) setFlag(seenKeyFor(set));
  beginTutorial(pending.game);
}

function openControlsTour(opts) {
  const o = opts || {};
  if (o.mode !== 'reference' && game) {
    // hold the match still while the player reads. Set directly, not via
    // togglePause — that no-ops for pvp/result and would desync the glyph.
    tourPausedBefore = paused;
    paused = true;
    $('btn-pause').textContent = '▶';
  }
  CT.open({ ...o, onClose: onTourClose });
}

// info is { set, seen } from controls-tour.js: which page set was on screen at
// close time, and whether the player reached the end (or skipped). This is the
// ONLY place a controls set gets marked read.
function onTourClose(info) {
  const o = info || {};
  const set = o.set === 'desktop' ? 'desktop' : 'touch';
  if (tourPausedBefore !== null) {
    paused = tourPausedBefore;
    tourPausedBefore = null;
    $('btn-pause').textContent = paused ? '▶' : '⏸';
  }
  if (o.seen) setFlag(seenKeyFor(set));
  runPendingTutorialBegin(set); // after the pause restore, so the scenario starts running
  endPracticeIfPending(set);
  refreshControlsVisibility();
}

// Force-close without marking seen — a player whose match ends mid-tour
// still gets it next time. The pending handoff and the practice exit are
// dropped BEFORE the close: backToMenu() calls this while `game` is still set
// and only nulls it afterwards, so otherwise a trip to the menu would begin a
// scenario (or re-enter backToMenu) on a match about to be torn down.
function closeControlsTour() {
  pendingTutorialBegin = null;
  pendingPracticeExit = false;
  if (CT.active()) CT.close({ seen: false });
  tourPausedBefore = null;
}

// -- the practice sandbox: the menu's 🕹️ button ----------------------------
// A throwaway match to read the controls over, and — on phones — to perform
// all ten gestures on. It is never saved (S.newPracticeGame sets game.sandbox,
// which saveGame bails on), never recorded, and it leaves an in-progress solo
// save alone — note the deliberate absence of clearSaves() here.
//
// The page set is the CALLER's choice — in state 2 the menu button offers
// whichever set is still unread, which may not be the one this screen uses. The
// gates only ever run for the touch pages on a phone-sized screen (see the
// `gated` option); everywhere else the map is simply there to try right-click
// orders, WASD and the wheel on while reading. The map stays paused either way.

let pendingPracticeExit = false; // close the tour → leave the practice map

function startControlsPractice(setArg) {
  try {
    me = 0;
    const set = setArg === 'desktop' || setArg === 'touch'
      ? setArg : (isMobile() ? 'touch' : 'desktop');
    const g = S.newPracticeGame();
    startMatch(g);
    pendingPracticeExit = true;
    openControlsTour({
      mode: 'tour', set, gated: set === 'touch' && isMobile(),
      finishLabel: '✓ Done', skipLabel: 'Skip', exitLabel: 'Exit practice',
    });
  } catch (e) {
    showMenuError('Could not open the practice map: ' + (e && e.message || e));
  }
}

// Every close path of a practice tour ends the sandbox: finishing the last
// step, Skip, and Exit practice all land here. Marking seen keeps the
// invariant "the tour was delivered" true however it was closed.
function endPracticeIfPending(set) {
  if (!pendingPracticeExit) return;
  pendingPracticeExit = false; // clear first — backToMenu re-enters closeControlsTour
  if (!game || !game.practice) return;
  setFlag(seenKeyFor(set)); // however it was closed, those pages were delivered
  backToMenu();
}

// #248: the in-match 🕹️ is gone. On the practice map the card's own ▾/▴ folds
// the tour away, and CT.close covers every other exit — nothing here needed a
// top-bar shortcut to remain reachable.
$('btn-controls').addEventListener('click', () => {
  if (CT.active()) { CT.close({ seen: false }); return; }
  if (waiting) { showMenuError('Cancel your multiplayer lobby first.'); return; }
  startControlsPractice(unseenSet()); // whichever set is still unread
});

// In-app confirm dialog — native confirm() is blocked inside the sandboxed
// platform iframe (it silently returns false), so never use it.
const confirmModal = $('confirm-modal');

// `opts.okOnly` (#223) makes this an information dialog instead of a
// confirmation: a single OK and no Cancel, because there is nothing to cancel.
function showConfirm(title, text, actions, opts) {
  $('confirm-title').textContent = title;
  $('confirm-text').textContent = text;
  const box = $('confirm-actions');
  box.innerHTML = '';
  if (opts && opts.okOnly) {
    const ok = document.createElement('button');
    ok.className = 'btn w-full py-3 rounded-xl font-semibold bg-violet-600 hover:bg-violet-500';
    ok.textContent = 'OK';
    ok.addEventListener('click', hideConfirm);
    box.appendChild(ok);
    confirmModal.classList.remove('hidden');
    return;
  }
  for (const a of actions) {
    const b = document.createElement('button');
    b.className = `btn w-full py-3 rounded-xl font-semibold ${a.cls}`;
    b.textContent = a.label;
    b.addEventListener('click', () => { hideConfirm(); a.fn(); });
    box.appendChild(b);
  }
  const cancel = document.createElement('button');
  cancel.className = 'btn w-full py-3 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-300';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', hideConfirm);
  box.appendChild(cancel);
  confirmModal.classList.remove('hidden');
}
function hideConfirm() {
  confirmModal.classList.add('hidden');
}
confirmModal.addEventListener('click', (e) => { if (e.target === confirmModal) hideConfirm(); });

function showMenuError(msg) {
  const el = $('menu-error');
  el.textContent = msg;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 5000);
}

// ---------------------------------------------------------------- multiplayer menu

function startMenuPolling() {
  stopMenuPolling();
  // No point polling a server we can't reach — the `online` handler restarts
  // this the moment we're back (#221) — nor one that has stopped accepting
  // our token, which would just be a 401 every three seconds (#240).
  if (isOffline() || isSessionExpired()) { refreshOfflineUi(); return; }
  refreshLobbies();
  menuTimer = setInterval(refreshLobbies, 3000);
}
function stopMenuPolling() {
  if (menuTimer) { clearInterval(menuTimer); menuTimer = null; }
}

async function refreshLobbies() {
  if (game) return;
  if (isOffline()) { stopMenuPolling(); refreshOfflineUi(); return; }
  let data;
  try {
    data = await api('/api/lobbies' + (IS_DEMO ? '?demo=1' : ''));
  } catch (e) {
    if (isOffline()) { stopMenuPolling(); refreshOfflineUi(); return; }
    $('lobby-list').innerHTML = '<span class="text-zinc-600">Sign in via Usernode to play multiplayer.</span>';
    return;
  }
  refreshOfflineUi();   // reachable again — bring the section back
  renderLobbyList(data.open || []);
  renderChallenges(data.challenges || []);
  handleMine(data.mine || null);
}

function renderLobbyList(rows) {
  const el = $('lobby-list');
  if (!rows.length) {
    el.innerHTML = '<span class="text-zinc-600">No open lobbies right now — create one above!</span>';
    return;
  }
  el.innerHTML = rows.map(l => `
    <div class="flex items-center justify-between gap-2 bg-zinc-800/50 rounded-lg px-3 py-2">
      <span class="truncate text-zinc-200">${esc(l.host_username)}</span>
      <span class="text-xs text-zinc-500">${esc(sizeLabel(l.size_key))} · ${lobbyAge(l.created_at)}</span>
      <button data-join="${l.id}" data-host="${esc(l.host_username)}" class="btn-sm px-3 rounded bg-sky-700 hover:bg-sky-600 text-white">Join</button>
    </div>`).join('');
}

function lobbyAge(createdAt) {
  const s = Math.max(0, Math.round((Date.now() - new Date(createdAt).getTime()) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m`;
}

function renderChallenges(rows) {
  const el = $('challenge-inbox');
  const visible = rows.filter(c => !(dismissedDemoChallenge && c.host_username === 'Staging demo Warden'));
  // "challenge withdrawn" toast: a previously shown challenge vanished
  const ids = new Set(visible.map(c => c.id));
  for (const old of seenChallengeIds) {
    if (!ids.has(old) && !actedChallengeIds.has(old)) toast('⚔️ Challenge withdrawn');
  }
  seenChallengeIds = ids;
  el.innerHTML = visible.map(c => `
    <div class="bg-violet-950/60 border border-violet-700 rounded-lg px-3 py-2 flex items-center justify-between gap-2">
      <span class="text-sm text-violet-100">⚔️ <b>${esc(c.host_username)}</b> challenges you! <span class="text-violet-300">(${esc(sizeLabel(c.size_key))} map)</span></span>
      <span class="flex gap-1 shrink-0">
        <button data-accept="${c.id}" data-host="${esc(c.host_username)}" class="btn-sm px-3 rounded bg-emerald-700 hover:bg-emerald-600 text-white">Accept</button>
        <button data-decline="${c.id}" class="btn-sm px-3 rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-200">Decline</button>
      </span>
    </div>`).join('');
}

function handleMine(mine) {
  mineLobby = mine && mine.status === 'active' ? mine : null;
  $('btn-mp-rejoin').classList.toggle('hidden', !mineLobby);
  if (!mine) return;
  if (mine.status === 'declined') {
    toast(`${mine.challenge_username || 'They'} declined your challenge`);
    api(`/api/lobbies/${mine.id}/cancel`, {}).catch(() => { });
    if (waiting && waiting.id === mine.id) stopWaiting();
    return;
  }
  // page was reloaded while a lobby was waiting — resume the waiting state
  if (mine.status === 'open' && !waiting) enterWaiting(mine);
}

$('lobby-list').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-join]');
  if (!btn) return;
  joinLobby(+btn.dataset.join, btn.dataset.host);
});

$('challenge-inbox').addEventListener('click', async (e) => {
  const acc = e.target.closest('[data-accept]');
  const dec = e.target.closest('[data-decline]');
  if (acc) {
    actedChallengeIds.add(+acc.dataset.accept);
    joinLobby(+acc.dataset.accept, acc.dataset.host);
  } else if (dec) {
    const id = +dec.dataset.decline;
    actedChallengeIds.add(id);
    try {
      const r = await api(`/api/lobbies/${id}/decline`, {});
      if (r.demo) dismissedDemoChallenge = true;
    } catch (err) { toast(err.message); }
    refreshLobbies();
  }
});

async function joinLobby(id, hostName) {
  if (waiting) { toast('Cancel your own lobby first'); return; }
  try {
    await api(`/api/lobbies/${id}/join`, {});
  } catch (err) {
    toast(err.message);
    refreshLobbies();
    return;
  }
  startPvpGuest(id, hostName);
}

$('btn-mp-create').addEventListener('click', async () => {
  if (waiting) return;
  try {
    const r = await api('/api/lobbies', { sizeKey: $('mp-size').value });
    enterWaiting(r.lobby);
  } catch (err) { showMenuError(err.message); }
});

$('btn-mp-challenge').addEventListener('click', async () => {
  if (waiting) return;
  const name = $('challenge-input').value.trim();
  if (!name) { showMenuError('Type a username to challenge.'); return; }
  try {
    const r = await api('/api/lobbies', { sizeKey: $('mp-size').value, challengeUsername: name });
    $('challenge-input').value = '';
    hideSuggest();
    enterWaiting(r.lobby);
  } catch (err) { showMenuError(err.message); }
});

$('btn-mp-cancel').addEventListener('click', async () => {
  if (!waiting) return;
  const id = waiting.id;
  stopWaiting();
  try { await api(`/api/lobbies/${id}/cancel`, {}); } catch { }
  refreshLobbies();
});

function enterWaiting(lobby) {
  stopWaiting();
  waiting = { id: lobby.id, challenge: lobby.challenge_username || null, lobby };
  $('mp-waiting-text').textContent = waiting.challenge
    ? `Challenge sent to ${waiting.challenge} — they'll see it when they open Supply Line…`
    : 'Waiting for an opponent…';
  $('mp-waiting').classList.remove('hidden');
  $('mp-forms').classList.add('hidden');
  waiting.timer = setInterval(waitTick, 2000);
  waitTick();
}

function stopWaiting() {
  if (waiting && waiting.timer) clearInterval(waiting.timer);
  waiting = null;
  $('mp-waiting').classList.add('hidden');
  $('mp-forms').classList.remove('hidden');
}

async function waitTick() {
  if (!waiting) return;
  let r;
  try {
    r = await api(`/api/lobbies/${waiting.id}/sync`, {});
  } catch { return; }
  if (!waiting) return;
  if (r.status === 'active') {
    const lobby = waiting.lobby;
    stopWaiting();
    startPvpHost(lobby, r.opponent || r.guest_username);
  } else if (r.status === 'declined') {
    const name = waiting.challenge || 'They';
    const id = waiting.id;
    stopWaiting();
    toast(`${name} declined your challenge`);
    api(`/api/lobbies/${id}/cancel`, {}).catch(() => { });
  } else if (r.status === 'cancelled' || r.status === 'finished') {
    stopWaiting();
  }
}

// -- challenge autocomplete
$('challenge-input').addEventListener('input', () => {
  clearTimeout(suggestTimer);
  const q = $('challenge-input').value.trim();
  if (!q) { hideSuggest(); return; }
  suggestTimer = setTimeout(async () => {
    try {
      const r = await api(`/api/players?q=${encodeURIComponent(q)}${IS_DEMO ? '&demo=1' : ''}`);
      const names = r.players || [];
      if (!names.length) { hideSuggest(); return; }
      $('challenge-suggest').innerHTML = names.map(n =>
        `<button data-name="${esc(n)}" class="block w-full text-left px-3 py-2 text-sm text-zinc-200 hover:bg-zinc-700">${esc(n)}</button>`).join('');
      $('challenge-suggest').classList.remove('hidden');
    } catch { hideSuggest(); }
  }, 250);
});
$('challenge-suggest').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-name]');
  if (!btn) return;
  $('challenge-input').value = btn.dataset.name;
  hideSuggest();
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('#challenge-suggest') && e.target.id !== 'challenge-input') hideSuggest();
});
function hideSuggest() { $('challenge-suggest').classList.add('hidden'); }

// One rejoin path (#240), shared by the menu button and by the automatic
// recovery a reload triggers. The server owns the sim: rejoiners (either role)
// resume from its latest snapshot and keep syncing like any other client.
async function rejoinLobby(id) {
  const st = await api(`/api/lobbies/${id}/state`);
  if (st.status !== 'active') {
    if (persistenceEnabled) RES.clearSession(saveStore);
    toast('That match is already over.');
    refreshLobbies();
    loadHistory();
    return false;
  }
  beginPvp(st.role, st.id, st.opponent, st.snapshot || null);
  return true;
}

$('btn-mp-rejoin').addEventListener('click', async () => {
  if (!mineLobby) return;
  try { await rejoinLobby(mineLobby.id); } catch (err) { toast(err.message); }
});

// ---------------------------------------------------------------- pvp session

function startPvpHost(lobby, guestName) {
  // the server created the authoritative game when the guest joined;
  // the host starts from its first snapshot like any other client
  beginPvp('host', lobby.id, guestName, null);
  toast('⚔️ Opponent joined — starting…');
}

function beginPvp(role, lobbyId, opponent, snap) {
  stopMpTimers();
  mp = {
    lobbyId, role, opponent: opponent || '…',
    outQueue: [], pending: [],
    lastSnapTick: -1, lastEventId: 0, oppSeen: null,
    ended: false, busy: false, noSnapPolls: 0, failN: 0,
    kick: null,
    // #247: ticks still owed to a snapshot correction, drained a couple per
    // frame by frameBody instead of all at once
    catchUp: 0,
    lastSnapAt: 0,
  };
  me = role === 'host' ? 0 : 1;
  // #240: the server forfeits an absent player after 60 s, so a reload has to
  // rejoin fast — faster than the 3 s menu poll noticing the lobby. The
  // breadcrumb carries the lobby id straight to the next boot.
  if (persistenceEnabled) RES.markSession(saveStore, 'pvp', { lobbyId, savedAt: Date.now() });
  if (snap) applySnapshot(snap);
  mpSync();
  mp.timer = setInterval(mpSync, 1000);
}

function startPvpGuest(lobbyId, hostName) {
  beginPvp('guest', lobbyId, hostName, null);
  toast('⚔️ Joining match…');
}

function stopMpTimers() {
  if (mp && mp.timer) { clearInterval(mp.timer); mp.timer = null; }
  if (mp && mp.kick) { clearTimeout(mp.kick); mp.kick = null; }
}

// The polling loop, identical for both roles: send queued orders,
// download the authoritative snapshot when behind, learn the status.
async function mpSync() {
  if (!mp || mp.busy || mp.ended) return;
  mp.busy = true;
  const batch = mp.outQueue.splice(0, 50);
  try {
    const r = await api(`/api/lobbies/${mp.lobbyId}/sync`, { haveTick: mp.lastSnapTick, commands: batch.map(e => e.cmd) });
    if (!mp) return;
    mp.failN = 0;
    // label the sent entries with their server ids so snapshot acks can
    // retire them from the pending (replay) list
    const ids = r.command_ids || [];
    for (let i = 0; i < batch.length && i < ids.length; i++) batch[i].dbId = ids[i];
    if (r.opponent && mp.opponent === '…') { mp.opponent = r.opponent; updateOppLabel(); }
    if (r.snapshot) {
      mp.lastSnapTick = r.snapshot_tick || (r.snapshot.tick | 0);
      mp.noSnapPolls = 0;
      applySnapshot(r.snapshot);
    } else if (!game) {
      mp.noSnapPolls++;
      if (mp.noSnapPolls > 30) {
        // the server never produced a starting snapshot — bail out
        toast('The match never started — back to the menu.');
        leavePvpToMenu();
        return;
      }
    }
    mp.oppSeen = r.opponentSeenAgoMs;
    if (r.status === 'finished' && !mp.ended) finishFromServer(r);
    else if ((r.status === 'cancelled') && !mp.ended) { toast('The match was cancelled.'); leavePvpToMenu(); return; }
    updateMpBanner();
  } catch (err) {
    mp.outQueue = batch.concat(mp.outQueue); // retry unsent orders
    if (err && err.status === 404) { toast('That match no longer exists.'); leavePvpToMenu(); return; }
    if (++mp.failN > 30) { toast('Connection to the match lost.'); leavePvpToMenu(); return; }
  } finally { if (mp) mp.busy = false; }
}

// `?mpdebug=1` instrumentation (#247) — the three numbers that describe how
// bad a correction was. Never called on the normal path.
function logSnapshotDebug(oldGame, newGame, prevTick) {
  const now = performance.now();
  const gap = mp.lastSnapAt ? Math.round(now - mp.lastSnapAt) : 0;
  mp.lastSnapAt = now;
  const was = new Map();
  for (const b of oldGame.blobs) if (!b.dead) was.set(b.id, b);
  let worst = 0;
  for (const b of newGame.blobs) {
    if (b.dead) continue;
    const ob = was.get(b.id);
    if (!ob) continue;
    const d = Math.hypot(ob.x - b.x, ob.y - b.y);
    if (d > worst) worst = d;
  }
  console.log(`[mpdebug] gap ${gap}ms · catchUp ${Math.max(0, prevTick - newGame.tick)} ticks · `
    + `worst correction ${worst.toFixed(2)} tiles · blobs ${newGame.blobs.length}`);
}

function applySnapshot(snap) {
  const firstSnap = !game;
  if (!game) {
    const g = S.deserialize(snap);
    S.setViewer(g, me);
    startMatch(g);
  } else {
    const prevTick = game.tick;
    const g = S.deserialize(snap, game);
    S.setViewer(g, me);
    if (MP_DEBUG && mp) logSnapshotDebug(game, g, prevTick);
    // #247: ease the correction instead of snapping it. The renderer notes how
    // far the authoritative state moved each blob away from where it was
    // actually being DRAWN, and carries that offset back to zero over ~250 ms.
    // Called BEFORE `game` is swapped — it needs both states.
    if (renderer) { try { renderer.noteResync(game, g); } catch { } }
    game = g;
    // dead-reckon back toward where we were rendering (bounded catch-up).
    // #247: this used to step 5 ticks here and credit the rest to `acc` — but
    // the frame loop burns up to 40 ticks in ONE frame, so the credited ticks
    // were consumed immediately and the whole correction landed as a single
    // visible jump, about once a second. It's a counter now, drained a couple
    // of ticks per frame by frameBody, so the catch-up is spread over frames.
    if (mp) mp.catchUp = Math.min(25, Math.max(0, prevTick - g.tick));
  }
  if (mp) {
    // retire pending commands the server had applied before this snapshot,
    // then replay the rest so optimistic orders don't visually revert
    const ack = snap.appliedCmdId;
    mp.pending = mp.pending.filter(e => e.dbId == null || (ack != null && e.dbId > ack));
    for (const e of mp.pending) { try { applyCommand(game, me, e.cmd); } catch { } }
    // toast events by id, mine or global only; a (re)join's first snapshot
    // just advances the watermark so old history isn't replayed
    for (const ev of snap.netEvents || []) {
      if (typeof ev.id !== 'number' || ev.id <= mp.lastEventId) continue;
      mp.lastEventId = ev.id;
      if (!firstSnap && (ev.owner == null || ev.owner === me)) toast(ev.msg);
    }
    // an authoritative result in the snapshot ends the match (locally
    // predicted results never do — the server confirms within a second)
    if (snap.result && !mp.ended) {
      const winner = snap.result === 'p0-win' ? 0 : snap.result === 'p1-win' ? 1 : null;
      if (winner != null) {
        mp.ended = true;
        resultPosted = true;
        stopMpTimers();
        $('mp-banner').classList.add('hidden');
        showEndModal(winner === me, snap.resultReason || 'elimination');
        loadHistory();
      }
    }
  }
}

function updateMpBanner() {
  const el = $('mp-banner');
  if (!mp || mp.ended || !game) { el.classList.add('hidden'); return; }
  const gone = mp.oppSeen != null ? mp.oppSeen : 0;
  if (gone > 6000) {
    el.classList.remove('hidden');
    // the server auto-awards the win at 60 s — no claim button to press
    const left = Math.max(0, Math.ceil((60000 - gone) / 1000));
    $('mp-banner-text').textContent = left > 0
      ? `${mp.opponent} lost connection — victory in ${left}s if they don't return…`
      : `${mp.opponent} is gone — awarding victory…`;
  } else {
    el.classList.add('hidden');
  }
}

function finishFromServer(r) {
  // the lobby finished without a local result (opponent claimed abandonment,
  // or the result landed before our snapshot did)
  mp.ended = true;
  resultPosted = true;
  if (game) game.result = 'ended';
  stopMpTimers();
  $('mp-banner').classList.add('hidden');
  showEndModal(r.winner_owner === me, r.end_reason || 'elimination');
}

function leavePvpToMenu() {
  stopMpTimers();
  mp = null;
  me = 0;
  $('mp-banner').classList.add('hidden');
  backToMenu();
}

function updateOppLabel() {
  const el = $('stat-opp');
  if (game && game.pvp && mp) {
    el.textContent = `⚔️ vs ${mp.opponent}`;
    el.classList.remove('hidden');
  } else {
    el.classList.add('hidden');
  }
}

// -- order dispatch: direct in solo; in PvP (either role) the order is
// applied to the local predicted sim immediately (optimistic echo) AND
// queued for the server-authoritative sim. Snapshot applications retire
// acked orders and replay the rest (applySnapshot).

function sendCmd(c) {
  if (!mp) return;
  const entry = { cmd: c, dbId: null };
  mp.outQueue.push(entry);
  // surrender is never echoed/replayed locally — the result must come
  // from the server's authoritative snapshot
  if (c.op !== 'surrender') mp.pending.push(entry);
  // event-driven send: kick a sync shortly instead of waiting for the
  // 1 s heartbeat (debounced so rapid taps batch into one request)
  if (!mp.kick) mp.kick = setTimeout(() => { if (mp) { mp.kick = null; mpSync(); } }, 200);
}

// Tutorial op guard (#185): belt-and-braces under the UI-level gating —
// every mutation path funnels through these wrappers, so a step can only
// ever reach its whitelisted sim ops.
const TUT_BLOCKED = { err: 'Not yet — follow the tutorial instruction above' };
function tutBlocked(op) {
  if (!game || !game.tutorial || TUT.allowsOp(op)) return false;
  TUT.nudge();
  return true;
}

// Replay guard (#223): a replay is a recording being re-run, so no order path
// may touch it. Selection, panels, pan/zoom, the minimap and control groups all
// stay live — only mutation is refused, at the same single funnel tutBlocked
// uses, so a stray panel button can never desync the playback.
const REPLAY_BLOCKED = { err: "You're watching a replay" };
function replayBlocked() {
  return !!(game && game.replay);
}

// The one path every order takes (#223). It records the command into the live
// recording and, in PvP, relays it to the server-authoritative sim. The
// descriptor is built unconditionally now — it's the replay log's vocabulary as
// well as the wire format, and applyCommand is the only thing that reads it.
//
// PvP is NOT recorded here: the runner sees BOTH players' orders and writes the
// canonical log server-side, so `recorder` stays null for a PvP match and this
// is a no-op for it.
function relay(c) {
  RP.recordCommand(recorder, game ? game.tick : 0, c);
  if (inPvp()) sendCmd(c);
  saveSoon();   // #240: every order is worth a save; the debounce coalesces bursts
}

function doMove(b, x, y, target) {
  if (tutBlocked('move')) return TUT_BLOCKED;
  if (replayBlocked()) return REPLAY_BLOCKED;
  relay({ op: 'move', blobId: b.id, x, y, target: target || null });
  return S.opMove(game, b, x, y, target);
}
function doSetRole(b, role) {
  if (tutBlocked('setRole')) return TUT_BLOCKED;
  if (replayBlocked()) return REPLAY_BLOCKED;
  relay({ op: 'setRole', blobId: b.id, role });
  return S.opSetRole(game, b, role);
}
function doSplit(b, n) {
  if (tutBlocked('split')) return TUT_BLOCKED;
  if (replayBlocked()) return REPLAY_BLOCKED;
  relay({ op: 'split', blobId: b.id, take: n });
  return S.opSplit(game, b, n);
}
function doBuild(b) {
  if (tutBlocked('build')) return TUT_BLOCKED;
  if (replayBlocked()) return REPLAY_BLOCKED;
  relay({ op: 'build', blobId: b.id });
  return S.opBuild(game, b);
}
function doBuildAt(b, x, y) {
  if (tutBlocked('buildAt')) return TUT_BLOCKED;
  if (replayBlocked()) return REPLAY_BLOCKED;
  relay({ op: 'buildAt', blobId: b.id, x, y });
  return S.opBuildAt(game, b, x, y);
}
function doPillage(b, on) {
  if (tutBlocked('pillage')) return TUT_BLOCKED;
  if (replayBlocked()) return REPLAY_BLOCKED;
  relay({ op: 'pillage', blobId: b.id, on: !!on });
  return S.opPillage(game, b, on);
}
function doRoute(b, target, sourceId) {
  if (tutBlocked('route')) return TUT_BLOCKED;
  if (replayBlocked()) return REPLAY_BLOCKED;
  relay({ op: 'route', blobId: b.id, target, sourceId: sourceId == null ? null : sourceId });
  return S.opRoute(game, b, target, sourceId);
}
function doSetMode(st, mode) {
  if (tutBlocked('setMode')) return TUT_BLOCKED;
  if (replayBlocked()) return REPLAY_BLOCKED;
  relay({ op: 'setMode', settlementId: st.id, mode });
  return S.opSetMode(game, st, mode);
}
function doFieldGarrison(st) {
  if (tutBlocked('fieldGarrison')) return TUT_BLOCKED;
  if (replayBlocked()) return REPLAY_BLOCKED;
  relay({ op: 'fieldGarrison', settlementId: st.id });
  return S.opFieldGarrison(game, st);
}
function doFieldRole(st, role, n) {
  if (tutBlocked('fieldRole')) return TUT_BLOCKED;
  if (replayBlocked()) return REPLAY_BLOCKED;
  relay({ op: 'fieldRole', settlementId: st.id, role, n });
  return S.opFieldRole(game, st, role, n);
}
function doFieldFarmerGroup(st) {
  if (tutBlocked('fieldFarmerGroup')) return TUT_BLOCKED;
  if (replayBlocked()) return REPLAY_BLOCKED;
  relay({ op: 'fieldFarmerGroup', settlementId: st.id });
  return S.opFieldFarmerGroup(game, st);
}
function doGarrisonRole(st, role) {
  if (tutBlocked('garrisonRole')) return TUT_BLOCKED;
  if (replayBlocked()) return REPLAY_BLOCKED;
  relay({ op: 'garrisonRole', settlementId: st.id, role });
  return S.opGarrisonRole(game, st, role);
}
function doSupplyRoute(st, target) {
  if (tutBlocked('supplyRoute')) return TUT_BLOCKED;
  if (replayBlocked()) return REPLAY_BLOCKED;
  relay({ op: 'supplyRoute', settlementId: st.id, target });
  return S.opSupplyRoute(game, st, target);
}
function doSiegeRun(routeId, on) {
  if (tutBlocked('siegeRun')) return TUT_BLOCKED;
  if (replayBlocked()) return REPLAY_BLOCKED;
  relay({ op: 'siegeRun', routeId, on: !!on });
  return S.opSiegeRun(game, routeId, !!on);
}
function doBuildWalls(b, tiles) {
  if (tutBlocked('wallBuild')) return TUT_BLOCKED;
  if (replayBlocked()) return REPLAY_BLOCKED;
  relay({ op: 'wallBuild', blobId: b.id, tiles });
  return S.opBuildWalls(game, b, tiles);
}
function doFieldWall(w) {
  if (tutBlocked('fieldWall')) return TUT_BLOCKED;
  if (replayBlocked()) return REPLAY_BLOCKED;
  relay({ op: 'fieldWall', wallId: w.id });
  return S.opFieldWall(game, w.id);
}
function doWallRole(w, role) {
  if (tutBlocked('wallRole')) return TUT_BLOCKED;
  if (replayBlocked()) return REPLAY_BLOCKED;
  relay({ op: 'wallRole', wallId: w.id, role });
  return S.opWallGarrisonRole(game, w.id, role);
}

// ---------------------------------------------------------------- match lifecycle

function startMatch(g, opts) {
  stopAttract(); // the menu backdrop must cost nothing while playing
  game = g;
  resultPosted = false;
  saveDirty = false;
  frameCrashed = false;   // a fresh match gets a fresh loop
  // Record every ordinary solo match (#223). Skipped for PvP (the server
  // records it), for a replay itself, and for the tutorial / practice /
  // sandbox games — none of which are recorded as matches either.
  const recordable = !g.replay && !g.pvp && !g.tutorial && !g.practice && !g.sandbox;
  recordingLost = false;
  statsSeries = ST.createSeries();   // #233: every match keeps its own graph
  const resumed = recordable && g.tick > 0;
  const journal = resumed ? readJournal() : null;
  if (!recordable) {
    recorder = null;
  } else if (resumed) {
    // Resumed match (#232). A recorder opened here would stamp its orders
    // at tick 4000-something while playback starts from zero — the exact
    // offset that made rewound replays show a match that never happened.
    // Pick the journaled log back up instead, and if there isn't one that
    // provably belongs to this save, record nothing and say so.
    recorder = RP.recorderFromJournal(journal, g);
    recordingLost = !recorder;
  } else {
    recorder = RP.createRecorder(g);
    clearJournal();
  }
  if (resumed) {
    // #244: the chart is restored on its OWN, looser gate. It used to ride
    // the replay's strict check and then get deleted with the rejected
    // journal, which is why a resumed match's graph started mid-match with
    // the earlier half of the game simply missing.
    const back = RP.statsFromJournal(journal, g);
    if (back) statsSeries = back;
    // A journal that can't be a replay must not be left behind claiming to be
    // one — but the history it carried is re-journaled rather than dropped.
    if (!recorder) { clearJournal(); writeJournal(); }
  }
  ST.sample(statsSeries, g);   // an opening data point, before any ticks run
  endReplay = null;
  $('btn-end-replay').classList.add('hidden');
  $('btn-end-stats').classList.add('hidden');
  $('end-replay-controls').classList.add('hidden');
  ui = { selected: null, pending: null, routeSrc: null, splitCount: null, orderTarget: null, orderTargetEnt: null, fieldCounts: {}, recallCount: null, ping: null, buildSite: null, wallStart: null, wallEnd: null, hover: null, touchMode: 'select' };
  groups = {};
  hideOrderPopup();
  acc = 0; speed = 1; paused = false; lastSaveTick = g.tick;
  $('sel-speed').value = '1';
  $('btn-pause').textContent = '⏸';
  // no pause / fast-forward in multiplayer — the sim is shared, and both
  // clients run it at the 1× default (speed stays forced to 1). The
  // tutorial (#185) keeps pause but pins 1× and swaps surrender for the
  // card's own Exit link.
  // a replay has its own transport in the replay bar, so the live pair goes
  $('btn-pause').classList.toggle('hidden', !!g.pvp || !!g.replay);
  // the controls-practice sandbox (#212) has no rating and nothing to
  // surrender, and its map is held still by the tour anyway
  $('sel-speed').classList.toggle('hidden', !!g.pvp || !!g.tutorial || !!g.practice || !!g.replay);
  $('btn-surrender').classList.toggle('hidden', !!g.tutorial || !!g.practice || !!g.replay);
  updateOppLabel();
  stopMenuPolling();

  if (!renderer) {
    renderer = createRenderer($('game-canvas'), $('minimap'));
    input = createInput({
      canvas: $('game-canvas'), minimap: $('minimap'), view,
      handlers: {
        tap: onTap, box: onBox, rightClick: onRightClick, cancel: onCancel, gesture: onGesture, groupKey: onGroupKey,
        pauseKey: togglePause, // space bar (#168) — togglePause itself guards solo/result
        // phone Drag mode: a one-finger drag box-selects instead of panning
        touchBox: () => !!(game && !game.result && isMobile() && ui.touchMode === 'drag'),
        // controls tour (#212): the two gestures with no lasting state to poll
        pinch: () => CT.signal('pinch'),
        minimap: () => CT.signal('minimap'),
      },
    });
  }
  input.setMapSize(g.map.w, g.map.h);
  const start = g.map.starts[me] || g.map.starts[0];
  view.cx = start.x + 2; view.cy = start.y;
  const cssW = window.innerWidth;
  view.scale = Math.max(10, Math.min(20, cssW / (cssW < 640 ? 22 : 30)));
  // A resume that dumps you back at your home settlement isn't a resume (#240):
  // the saved camera comes back with the match. Non-sim data, so it rides in
  // the payload beside savedAt and needs no version bump.
  const savedView = opts && opts.view;
  if (savedView && Number.isFinite(savedView.cx) && Number.isFinite(savedView.cy)
    && Number.isFinite(savedView.scale) && savedView.scale > 0) {
    view.cx = savedView.cx; view.cy = savedView.cy; view.scale = savedView.scale;
  }
  if (g.tutorial) {
    // open on a close-up of the first steps' subjects — the home
    // settlement and the army camped beside it (the settlement center is
    // at start+1, the army at start+(2.5,0.5)); panning/zooming stays free
    view.cx = start.x + 1.5;
    view.cy = start.y + 0.5;
    view.scale = Math.min(48, view.scale * 1.9);
  }
  input.clampView();

  $('main-menu').classList.add('hidden');
  $('end-modal').classList.add('hidden');
  $('game-ui').classList.remove('hidden');
  renderer.resize();
  renderPanel(true);
  updateGroupsBar();
  refreshControlsVisibility(); // the menu 🕹️ retires once both sets are read

  // first-run controls tour (#212): phone widths only, and never on top of
  // the guided tutorial's own card, a PvP match (no pausing, an opponent is
  // waiting), the practice sandbox or a ?shot= screenshot boot — those last
  // two open it explicitly right after this returns.
  closeControlsTour();
  if (stateLoaded && isMobile() && !SHOT && !g.pvp && !g.tutorial && !g.practice && !g.replay
    && !flag('controls_touch_seen')) {
    openControlsTour({ mode: 'tour', set: 'touch', gated: true });
  }
  // Save NOW, not in a minute (#240). The periodic autosave used to be the
  // first write of a match, so anything that took the page away inside the
  // opening minute lost the whole thing — the exact window a platform iframe
  // remount or a phone dropping the tab lands in.
  saveGame(true);
  refreshSaveWarning();
  // #245: a resumed match that can no longer be recorded says so NOW. The end
  // card still explains it for anyone who missed this, but finding out then is
  // finding out too late to do anything about it.
  refreshReplayNotice();
  if (recordingLost) toast("⚠ This match can no longer be saved as a replay — the graph is intact.");
}

function backToMenu() {
  // A deliberate exit (#240). Save first — leaving the menu is not leaving the
  // match — then drop the breadcrumb, so the next boot lands on the menu
  // instead of shoving the player back into a game they chose to step out of.
  flushSaveSoon();
  saveGame(true);
  if (persistenceEnabled) RES.clearSession(saveStore);
  frameCrashed = false;
  TUT.end(); // no-op unless a tutorial session is live
  closeControlsTour();
  player = null;                                  // replay teardown (#223)
  $('replay-bar').classList.add('hidden');
  layoutBottomStack();
  stopMpTimers();
  mp = null;
  me = 0;
  game = null;
  $('mp-banner').classList.add('hidden');
  $('stat-opp').classList.add('hidden');
  $('game-ui').classList.add('hidden');
  $('end-modal').classList.add('hidden');
  $('main-menu').classList.remove('hidden');
  refreshMenu();
  refreshTutorialButton();
  refreshControlsVisibility();
  refreshOfflineUi();
  refreshOfflineCard();
  refreshServerSave();
  loadHistory();
  loadRatings();
  startMenuPolling();
  flushOutbox();   // a result recorded during the match we just left (#221)
  startAttract();
}

// Is this game one the player expects to come back to? A replay matters here
// (#223): it IS a fresh solo game at tick 0 as far as every other clause is
// concerned, so without it watching a replay would overwrite the player's real
// autosave and their server save slot.
function savableGame(g) {
  return !!(g && !g.replay && !g.result && !g.pvp && !g.tutorial && !g.sandbox);
}

// keepalive fetches are capped at ~64 KB by the browser, and a large-map save
// can exceed that — so an unload-time push is attempted only when it fits.
// The local write has already happened either way, and the freshest savedAt
// wins at resume time.
const KEEPALIVE_MAX = 60 * 1024;

// One write of the in-progress match: this device first (that copy is what a
// reload reads), then the account (that copy is what another device reads).
function saveGame(push, opts) {
  if (!persistenceEnabled) return;   // a ?shot= / ?demo= boot owns no save (#240)
  if (!savableGame(game)) return;
  saveDirty = false;
  let data;
  try {
    data = S.serialize(game);
  } catch { return; }
  data.savedAt = Date.now();
  data.view = { cx: view.cx, cy: view.cy, scale: view.scale };

  // #232/#245: the order log lives or dies with the save it belongs to, and it
  // is written FIRST. Both writes happen in this one call at one tick, so the
  // journal's stamped tick matches the save's either way — but ordering it
  // first means a failure leaves the journal AHEAD of the save (recoverable,
  // and detected right here) rather than a stale journal behind a newer save,
  // which every later resume would silently reject.
  if (!writeJournal() && recorder) dropRecording();

  // #240: a quota-full localStorage used to make this a silent no-op forever —
  // the match kept playing and then vanished on the next reload. Free the
  // biggest expendable things first — finished matches' replay logs, ALL of
  // them if that's what it takes (the step repeats, #245), and only then this
  // match's own order log — and retry after each; only give up out loud.
  const res = RES.persistSave(saveStore, data, [
    { name: 'replays', run: () => dropOldestLocalReplay() },
    { name: 'journal', run: () => dropRecording() },
  ]);
  const wasDegraded = saveDegraded;
  saveDegraded = !res.ok;
  if (res.ok) {
    // The breadcrumb that turns a reload into a resume (#240): its presence on
    // the next boot means the page went away MID-MATCH. Every deliberate exit
    // clears it, so it can never auto-resume someone who quit to the menu.
    RES.markSession(saveStore, 'solo', { savedAt: data.savedAt });
  }
  if (saveDegraded !== wasDegraded) refreshSaveWarning();

  // cross-device resume (#176): mirror the save to the server.
  if (push && token && !isSessionExpired()) {
    const body = JSON.stringify(data);
    const unload = !!(opts && opts.unload);
    if (unload && body.length > KEEPALIVE_MAX) return;
    fetch('/api/save', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...apiHeaders },
      body,
      keepalive: unload,
    }).catch(() => { });
  }
}

// Give up recording THIS match: the last thing sacrificed when storage is
// tight, and the honest answer when the journal write itself failed.
//
// The stats series is re-journaled on its own (#244) — it is orders of
// magnitude smaller than the order log and it is what the end card's graph is
// made of, so "no replay" must never also mean "no graph". Returns false when
// there is no recording left to give up, which is how persistSave knows this
// step has nothing more to free.
function dropRecording() {
  if (!recorder) return false;
  recorder = null;
  recordingLost = true;
  clearJournal();
  writeJournal();                                  // stats-only from here on
  $('btn-end-replay').classList.add('hidden');     // #232: no journal, no replay
  refreshReplayNotice();
  return true;
}

// One expendable thing to free when the quota bites: the oldest finished
// match's replay log. Returns false when there is nothing left to drop, so
// persistSave moves on to the next step instead of looping.
function dropOldestLocalReplay() {
  const rows = RP.readLocal(offStore);
  if (!rows.length) return false;
  RP.dropLocal(offStore, rows[rows.length - 1].client_id);
  refreshLocalReplayIndex();
  return true;
}

// Orders are the moments a player would most hate to lose (#240), so every one
// of them arms a save — trailing-debounced, so a burst of clicks is one write
// and the sim never stutters mid-drag.
let saveDirty = false;
let saveSoonTimer = null;
const SAVE_DEBOUNCE_MS = 2000;
function saveSoon() {
  if (!persistenceEnabled || !savableGame(game)) return;
  saveDirty = true;
  if (saveSoonTimer) return;
  saveSoonTimer = setTimeout(() => {
    saveSoonTimer = null;
    if (saveDirty) saveGame(true);
  }, SAVE_DEBOUNCE_MS);
}
function flushSaveSoon() {
  if (saveSoonTimer) { clearTimeout(saveSoonTimer); saveSoonTimer = null; }
}

// The "⚠️ autosave isn't working" chip. Shown in the match, because that is
// where the player can still do something about it (finish up, free space) —
// finding out on the menu afterwards is finding out too late.
function refreshSaveWarning() {
  const el = $('save-warning');
  if (!el) return;
  el.classList.toggle('hidden', !(saveDegraded && game && savableGame(game)));
}

// The "⚠️ Replay off" chip (#245). Recording being lost used to surface ONLY
// in the end card, twenty minutes after the fact; said here it lands while the
// player can still understand what happened (they just resumed, or storage is
// full). The match itself keeps saving — that is what makes this a separate,
// quieter chip than the autosave warning beside it.
function refreshReplayNotice() {
  const el = $('record-warning');
  if (!el) return;
  el.classList.toggle('hidden', !(recordingLost && game && savableGame(game)));
}

function showEndModal(win, reason) {
  $('end-emoji').textContent = win ? '🏆' : '🏳️';
  $('end-title').textContent = win ? 'Victory!' : (reason === 'surrender' ? 'Surrendered' : 'Defeat');
  const opp = mp ? mp.opponent : 'your opponent';
  const dur = game ? fmtDur(S.gameSeconds(game.tick)) : '';
  $('end-detail').textContent = win
    ? (reason === 'abandoned'
      ? `${opp} abandoned the match — victory is yours.`
      : reason === 'surrender'
        ? `${opp} surrendered after ${dur}.`
        : `You wiped out ${opp}'s settlements and last forces in ${dur}.`)
    : (reason === 'abandoned'
      ? `The match was claimed while you were away.`
      : reason === 'surrender'
        ? `You surrendered to ${opp} after ${dur}.`
        : `${opp} destroyed your war effort after ${dur}.`);
  $('end-rating').classList.add('hidden');   // filled in once the post answers
  // PvP recordings are written server-side, so there is nothing in memory to
  // rewatch from here — the match's row in the history list carries it.
  $('btn-end-replay').classList.add('hidden');
  $('end-replay-controls').classList.add('hidden');   // live card, no transport
  // #246: the graph is sampled for a multiplayer match exactly as for a solo
  // one, but this card never offered it — so the only route to the chart after
  // a PvP game was watching its replay.
  $('btn-end-stats').classList.toggle('hidden', !statsSeries || !statsSeries.rows.filter(Boolean).length);
  $('end-modal').classList.remove('hidden');
}

// Solo-only: PvP results are decided by the server and surface through
// applySnapshot (authoritative snapshot result) or finishFromServer
// (sync status) — a locally predicted elimination just freezes the
// local sim until the server confirms or corrects it within a second.
function endMatch(result) {
  resultPosted = true;
  flushSaveSoon();
  // sandbox (tutorial "keep playing"): show the end modal, but the match
  // is a throwaway — never recorded, and the player's real save survives
  if (!game.sandbox) clearSaves();   // clearSaves drops the breadcrumb too (#240)
  else if (persistenceEnabled) RES.clearSession(saveStore);
  const win = result === 'win';
  $('end-emoji').textContent = win ? '🏆' : '🏳️';
  $('end-title').textContent = win ? 'Victory!' : result === 'surrender' ? 'Surrendered' : 'Defeat';
  $('end-detail').textContent = win
    ? `Enemy settlements razed and their last forces scattered in ${fmtDur(S.gameSeconds(game.tick))}.`
    : `Your war effort collapsed after ${fmtDur(S.gameSeconds(game.tick))}.`;
  $('end-rating').classList.add('hidden');   // filled in once the post answers
  $('end-replay-controls').classList.add('hidden');   // live card, no transport
  // #233: the graph of how the match actually went, whatever the outcome.
  // Holes are possible now (#244) — a resumed match can be missing the part of
  // its history that lived on another device — so it's the SAMPLES that decide
  // whether there is a chart, not the sparse array's length.
  $('btn-end-stats').classList.toggle('hidden', !statsSeries || !statsSeries.rows.filter(Boolean).length);
  if (recordingLost) {
    // #232: say it plainly rather than silently producing no replay row.
    // A log that doesn't start at tick 0 can only replay wrong, so the
    // honest outcome is no replay at all. #244: the graph survives it.
    $('end-detail').textContent += " This match's order log couldn't be carried across the resume, so no replay was recorded — the graph below still covers what was sampled.";
  }
  $('end-modal').classList.remove('hidden');
  if (game.sandbox) return;
  // The result is written to this device FIRST (#221), so a match finished
  // with no connection is never lost: it shows in "Yours" as pending and the
  // outbox flushes it on reconnect. The post below is that same flush running
  // immediately when we're online, so the modal still gets its Elo line.
  const clientId = newMatchId(game);
  OFF.recordResult(offStore, {
    client_id: clientId,
    result,
    difficulty: game.difficulty,
    duration_seconds: Math.round(S.gameSeconds(game.tick)),
    map_seed: game.seed,
    ended_at: Date.now(),
    username: currentUsername,
  });
  // The recording lands on the device first too (#223), so a match finished
  // offline is rewatchable straight away and uploads with the result. The end
  // card's rewatch button reads it from memory — it was just recorded on this
  // very engine, so it never needs the version gate.
  if (recorder) {
    RP.recordEnd(recorder, game, result);
    const payload = RP.finishRecording(recorder);
    if (payload) {
      RP.saveLocal(offStore, clientId, payload);
      endReplay = payload;
      $('btn-end-replay').classList.remove('hidden');
    }
  }
  if (!token) {
    showOfflineRatingLine('Recorded on this device — sign in via Usernode to have it rated.');
    return;
  }
  if (isOffline()) {
    showOfflineRatingLine("Recorded — your rating updates next time you're online.");
    return;
  }
  flushOutbox().then(() => {
    // Still queued after a flush attempt: the send failed, so say so rather
    // than leaving the line blank.
    if (OFF.readOutbox(offStore).some(r => r.client_id === clientId)) {
      showOfflineRatingLine("Recorded — your rating updates next time you're online.");
    } else {
      showRatingLine(lastFlushResult && lastFlushResult.client_id === clientId ? lastFlushResult.data : null);
    }
  });
}

// A stable id for this finished match, so a re-send can never double-record
// it. crypto.randomUUID where available; the sim's own seed+tick otherwise.
function newMatchId(g) {
  try {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
  } catch { }
  return OFF.newClientId(g.seed, g.tick, Math.random);
}

function showOfflineRatingLine(text) {
  const el = $('end-rating');
  el.textContent = text;
  el.classList.remove('hidden');
}

// Appends "Rating: R (+D)" to the end modal, spelling out the ceiling
// case so a zeroed gain never reads as a bug.
function showRatingLine(data) {
  if (!data || data.rating == null) return;
  const d = data.rating_delta;
  const el = $('end-rating');
  if (d > 0) el.textContent = `Rating: ${data.rating} (+${d})`;
  else if (d < 0) el.textContent = `Rating: ${data.rating} (${d})`;
  else el.textContent = `Rating: ${data.rating} (no change — you're rated above this commander)`;
  el.classList.remove('hidden');
  myRating = data.rating;
}

$('btn-end-menu').addEventListener('click', backToMenu);
// In a replay the outcome card is informational, so its backdrop dismisses back
// to the final frame (#223). A real match's card has no such escape — the result
// is already recorded and the only way on is back to the menu.
$('end-modal').addEventListener('click', (e) => {
  if (e.target === $('end-modal') && game && game.replay) $('end-modal').classList.add('hidden');
});
$('btn-surrender').addEventListener('click', () => {
  if (!game || game.result) return;
  if (replayBlocked()) return;   // hidden in a replay, but never trust CSS alone
  showConfirm('Surrender this match?', 'The match ends immediately and counts as a loss.', [
    { label: '🏳️ Surrender', cls: 'bg-red-700 hover:bg-red-600 text-white', fn: () => {
      if (!game || game.result) return;
      if (game.pvp) {
        // either role: the server-authoritative sim decides the result
        sendCmd({ op: 'surrender' }); // sendCmd kicks a sync itself
        toast('🏳️ Surrendering…');
        return;
      }
      game.result = 'surrender';
    } },
  ]);
});
// Shared by the ⏸ button and the space bar (#168). Solo only — the PvP
// sim is shared and never pauses.
function togglePause() {
  // In a replay the space bar drives the replay bar's own transport (#223).
  if (game && game.replay) {
    if (!player || RP.atEnd(player)) return;
    paused = !paused;
    $('replay-play').textContent = paused ? '▶' : '⏸';
    return;
  }
  if (!game || game.pvp || game.result) return;
  paused = !paused;
  $('btn-pause').textContent = paused ? '▶' : '⏸';
}
$('btn-pause').addEventListener('click', togglePause);
$('sel-speed').addEventListener('change', () => {
  if (game && game.pvp) { $('sel-speed').value = '1'; return; }
  speed = Math.max(1, Math.min(4, +$('sel-speed').value || 1));
  // a focused <select> counts as text entry to the key handler and would
  // swallow WASD panning — hand focus back to the map
  $('sel-speed').blur();
});
$('btn-backtowork').addEventListener('click', () => {
  if (!game || game.result) return;
  if (game.tutorial) { TUT.nudge(); return; }
  if (replayBlocked()) return;
  // relayed and recorded like every other order (#223) — this is also what
  // finally makes the button work in PvP, where it used to move only the
  // local predicted sim
  relay({ op: 'backToWork' });
  const r = S.opBackToWork(game, me);
  if (r.fielded + r.walking > 0) {
    const parts = [];
    if (r.fielded > 0) parts.push(`${r.fielded} farmer${r.fielded === 1 ? '' : 's'} back in the fields`);
    if (r.walking > 0) parts.push(`${r.walking} walking home`);
    toast('🌱 ' + parts.join(' · '));
  } else if (r.reason === 'danger') toast('⚠️ Enemies nearby — farmers stay sheltered');
  else toast('No idle farmers');
  updateHUD();
  renderPanel(true);
});
$('btn-cancel-order').addEventListener('click', onCancel);

// Every way a page can go away (#240). `beforeunload` alone is not enough:
// iOS Safari fires it unreliably and never fires it at all for a backgrounded
// tab the OS discards — which is precisely the reload this issue is about.
// `pagehide` and `freeze` cover those, `visibilitychange` covers app-switching.
// All four take the same path; the local write is synchronous, so whichever
// fires first has already done the important half.
function saveOnExit() {
  flushSaveSoon();
  saveGame(true, { unload: true });
}
document.addEventListener('visibilitychange', () => { if (document.hidden) saveOnExit(); });
window.addEventListener('pagehide', saveOnExit);
window.addEventListener('freeze', saveOnExit);
window.addEventListener('beforeunload', saveOnExit);

// ---------------------------------------------------------------- selection & orders

function selectedBlobs() {
  if (!game || !ui.selected) return [];
  if (ui.selected.kind === 'blob') {
    const b = findBlob(ui.selected.id);
    return b ? [b] : [];
  }
  if (ui.selected.kind === 'multi') {
    return ui.selected.ids.map(findBlob).filter(Boolean);
  }
  return [];
}
function findBlob(id) {
  let cur = id, hops = 0;
  while (hops++ < 10) {
    const b = game.blobs.find(x => x.id === cur && !x.dead);
    if (b) return b;
    if (game.mergeLog[cur] != null) cur = game.mergeLog[cur];
    else return null;
  }
  return null;
}
function selectedSettlement() {
  if (!game || !ui.selected || ui.selected.kind !== 'settlement') return null;
  return game.settlements.find(s => s.id === ui.selected.id) || null;
}

// Footprint-first hit test (#165): the settlement whose 2×2 footprint
// the world point lies on, via the settAt claim map — exact, so a unit
// circle visually overlapping the buildings can never steal the tap.
function settlementAtFootprint(world) {
  const tx = Math.floor(world.x), ty = Math.floor(world.y);
  if (tx < 0 || ty < 0 || tx >= game.map.w || ty >= game.map.h) return null;
  const id = game.settAt[ty * game.map.w + tx];
  return id ? game.settlements.find(s => s.id === id) || null : null;
}

// Exact per-tile wall hit test (#187), the wall analogue of the
// footprint-first settlement lookup.
function wallAtPoint(world) {
  const tx = Math.floor(world.x), ty = Math.floor(world.y);
  if (tx < 0 || ty < 0 || tx >= game.map.w || ty >= game.map.h) return null;
  const id = game.wallAt[ty * game.map.w + tx];
  return id ? game.walls.find(w => w.id === id) || null : null;
}

// -- what-you-see-is-what-you-click picking (#224) ---------------------
// The inspect/selection dispatch used to grab with `24 / view.scale`
// world units of slack, which is ~1.7 tiles at the default zoom and 6–8
// tiles zoomed right out. These three helpers anchor every pick on what
// the RENDERER draws plus one fixed 8 px band (pick.js), so the tile
// beside a keep selects the tile and a field-hand dot is the size of the
// dot. The order/route flows deliberately keep their generous reach —
// they ask before acting (see showOrderPopup).

// The blob whose DRAWN circle (plus band) the point lands on. Candidates
// are ranked by CENTRE distance, so a lone scout standing on top of a
// 2.2-tile stack wins the tap aimed at it while the stack still wins
// everywhere else inside its own circle.
function pickBlobAt(world, filter) {
  let best = null, bd = Infinity;
  const tol = pickTol(view.scale);
  for (const b of game.blobs) {
    if (b.dead) continue;
    if (filter && !filter(b)) continue;
    const ov = blobOverlap(view.scale, {
      x: b.x, y: b.y, radius: S.blobRadius(b), working: b.working != null,
    }, world.x, world.y);
    if (ov < -tol) continue;
    const d = dist(b.x, b.y, world.x, world.y);
    if (d < bd) { bd = d; best = b; }
  }
  return best;
}

// The settlement whose 2×2 footprint the point lands on, within the band.
// Rectangle distance, not centre distance — 1.9 from the centre reached
// ~0.9 tiles past the grounds onto the neighbouring land.
function settlementNearFootprint(world, tol) {
  const t = tol != null ? tol : pickTol(view.scale);
  let best = null, bd = Infinity;
  for (const s of game.settlements) {
    const d = footprintDist(s.x, s.y, world.x, world.y);
    if (d <= t && d < bd) { bd = d; best = s; }
  }
  return best;
}

// The wall whose tile the point lands on, within the band. An EXACT tile
// hit always wins (so clicking an enemy wall's tile means that wall, even
// with one of yours next door); only the band fallback takes `filter`, so
// a neighbouring enemy wall can't shadow your own garrison target.
function wallNearPoint(world, tol, filter) {
  const t = tol != null ? tol : pickTol(view.scale);
  const exact = wallAtPoint(world);
  if (exact) return exact;
  let best = null, bd = Infinity;
  for (const w of game.walls) {
    if (filter && !filter(w)) continue;
    const d = tileDist(w.x, w.y, world.x, world.y);
    if (d <= t && d < bd) { bd = d; best = w; }
  }
  return best;
}

// Whether the viewer may see/target this enemy wall: currently visible
// or remembered in the viewer's wall memory.
function wallKnown(w) {
  return w.owner === me
    || S.isVisible(game, w.x + 0.5, w.y + 0.5)
    || !!(game.wallMemo && game.wallMemo[w.id]);
}

// Tutorial gate (#185): decide whether a map tap serves the current step
// BEFORE onTap's dispatch runs — disallowed taps are swallowed + nudged,
// so nothing off-script can be selected or ordered.
function tutTapAllowed(world) {
  if (ui.pending) return TUT.allowsTarget(world); // resolving an armed order
  if (!orderPopup.classList.contains('hidden')) return true; // tap only dismisses it
  if (TUT.allowsTarget(world)) return true; // the step's world target (order/attack)
  // the SAME picks onTap's dispatch uses (#224), so the gate and the
  // dispatch can never disagree about what the tap would select
  const b = pickBlobAt(world);
  if (b && TUT.allowsSelect({ kind: 'blob', id: b.id })) return true;
  const st = settlementAtFootprint(world) || settlementNearFootprint(world);
  if (st && TUT.allowsSelect({ kind: 'settlement', id: st.id })) return true;
  return false;
}

function onTap(world, pointerType, screen) {
  if (!game || game.result) return;
  if (game.tutorial && !tutTapAllowed(world)) { TUT.nudge(); return; }
  if (ui.pending) { resolvePending(world, pointerType, screen); return; }
  // a tap while the order popup is open only dismisses it
  if (!orderPopup.classList.contains('hidden')) { hideOrderPopup(); return; }
  // the phone UI's contextual tap model (Select/Drag modes)
  const mobile = isMobile() && pointerType !== 'mouse';
  const sel = mobile ? selectedBlobs() : null;
  const fp = settlementAtFootprint(world); // footprint-first (#165)
  // Drag mode (phones) is drag-only: one-finger boxes build up the group
  // across as many drags as it takes, and every order waits for Select
  // mode. The one live tap target is an own settlement, which switches
  // the active selection to it.
  if (mobile && ui.touchMode === 'drag') {
    const dst = fp && fp.owner === me
      ? fp : settlementNearFootprint(world);
    if (dst && dst.owner === me) {
      ui.selected = { kind: 'settlement', id: dst.id };
      renderPanel(true);
    }
    return;
  }
  // a tap on an own settlement's footprint selects the settlement before
  // any unit is considered (#165); the mobile units-in-hand ambiguity
  // popup still applies
  if (fp && fp.owner === me) {
    if (mobile && sel.length > 0) { showGarrisonPopup(fp, screen); return; }
    ui.selected = { kind: 'settlement', id: fp.id };
    renderPanel(true);
    return;
  }
  // prefer own blob, then own settlement — the drawn-circle pick (#224),
  // so a unit standing NEXT to the wall/tile you aimed at no longer
  // swallows the tap and a field-hand dot is only as big as it looks
  let b = pickBlobAt(world);
  const eb = b && b.owner !== me ? b : null;
  if (b && b.owner !== me) b = null;
  if (b) {
    // tapping a blob that's already in the selection → its action popup
    if (mobile && sel.some(s => s.id === b.id)) { showUnitOptions(screen); return; }
    // Select mode with units in hand: tapping another friendly blob asks
    // Select / Move / Deselect instead of silently swapping the selection,
    // so a stray tap near a group can't lose what's already picked. With
    // nothing selected there's nothing to lose — select it directly.
    if (mobile && sel.length > 0) { showSelectPopup(b, screen, world); return; }
    ui.selected = { kind: 'blob', id: b.id };
    renderPanel(true);
    return;
  }
  // own wall (#187): exact-tile hit, like the settlement footprint. With
  // units in hand on mobile, the tap is ambiguous — the order popup's
  // Move onto the tile garrisons on arrival.
  const wl = wallAtPoint(world);
  if (wl && wl.owner === me) {
    if (mobile && sel.length > 0) { showOrderPopup(world, screen, null); return; }
    ui.selected = { kind: 'wall', id: wl.id };
    renderPanel(true);
    return;
  }
  const st = settlementNearFootprint(world);
  if (st && st.owner === me) {
    if (mobile && sel.length) {
      // with units in hand the tap is ambiguous — ask: switch to the
      // settlement, march the group into its garrison, or deselect
      showGarrisonPopup(st, screen);
      return;
    }
    ui.selected = { kind: 'settlement', id: st.id };
    renderPanel(true);
    return;
  }
  if (mobile && sel.length > 0) {
    // ask before acting — Move/Attack at the tap point, or Deselect, so a
    // stray tap can't send the group marching across the map
    showOrderPopup(world, screen, findEnemyTargetAt(world, tapHitR()));
    return;
  }
  // tap elsewhere with blobs selected → inline order popup at the tap
  // point; a tapped enemy blob/settlement becomes a direct attack target.
  // Mouse skips this (#79): on desktop left-click only selects/inspects —
  // right-click is the order button. (≥640px touch only — phones use the
  // mode-based dispatch above.)
  if (!mobile && pointerType !== 'mouse' && selectedBlobs().length > 0) { showOrderPopup(world, screen, findEnemyTargetAt(world, tapHitR())); return; }
  // nothing selected → inspect what was tapped; an enemy settlement's
  // footprint outranks any unit overlapping it (#165)
  const known = game.pvp ? game.knowns[me] : game.known;
  if (fp && fp.owner !== me && (S.settVisible(game, fp) || known[fp.id])) {
    ui.selected = { kind: 'enemy-settlement', id: fp.id };
    renderPanel(true);
    return;
  }
  if (eb && S.isVisible(game, eb.x, eb.y)) {
    ui.selected = { kind: 'enemy-blob', id: eb.id };
    renderPanel(true);
    return;
  }
  if (wl && wl.owner !== me && wallKnown(wl)) {
    ui.selected = { kind: 'enemy-wall', id: wl.id };
    renderPanel(true);
    return;
  }
  if (st && st.owner !== me && (S.settVisible(game, st) || known[st.id])) {
    ui.selected = { kind: 'enemy-settlement', id: st.id };
    renderPanel(true);
    return;
  }
  const tx = Math.floor(world.x), ty = Math.floor(world.y);
  if (tx >= 0 && ty >= 0 && tx < game.map.w && ty < game.map.h && game.fog[ty * game.map.w + tx] >= 1) {
    ui.selected = { kind: 'tile', i: ty * game.map.w + tx };
    renderPanel(true);
    return;
  }
  ui.selected = null;
  renderPanel(true);
}

function onBox(rect, additive) {
  if (!game || game.result) return;
  // controls tour (#212): this is exactly the condition that made the drag a
  // touch box (see the touchBox handler), and an empty box still counts — the
  // gesture is what's being taught
  if (isMobile() && ui.touchMode === 'drag') CT.signal('touch-box');
  if (game.tutorial) {
    // box-select is allowed only when everything it would pick is the
    // step's own selection target (an empty box just clears — harmless)
    const ids = game.blobs
      .filter(b => !b.dead && b.owner === me && b.x >= rect.x0 && b.x <= rect.x1 && b.y >= rect.y0 && b.y <= rect.y1)
      .map(b => b.id);
    if (ids.length && !TUT.allowsSelect(ids.length === 1 ? { kind: 'blob', id: ids[0] } : { kind: 'multi', ids })) {
      TUT.nudge();
      return;
    }
  }
  hideOrderPopup();
  // a box while an order is armed is clearly a selection gesture, not a
  // destination — drop the pending state (incl. build placement)
  if (ui.pending) {
    ui.pending = null;
    ui.buildSite = null;
    ui.wallStart = null;
    ui.wallEnd = null;
    ui.routeSrc = null;
    updateHint();
  }
  let ids = game.blobs
    .filter(b => !b.dead && b.owner === me && b.x >= rect.x0 && b.x <= rect.x1 && b.y >= rect.y0 && b.y <= rect.y1)
    .map(b => b.id);
  if (additive) {
    // shift-drag (#136): union the boxed blobs with the current selection;
    // an empty additive box keeps the selection instead of clearing it
    if (!ids.length) return;
    ids = [...new Set([...selectedBlobs().map(b => b.id), ...ids])];
  }
  if (ids.length === 0) { ui.selected = null; }
  else if (ids.length === 1) ui.selected = { kind: 'blob', id: ids[0] };
  else ui.selected = { kind: 'multi', ids };
  renderPanel(true);
}

// An enemy group this player could actually order an attack on: not theirs,
// not a field hand carpeting a farm, and currently in sight. Handed to
// S.blobAt as a filter (#243) rather than tested after the fact — the pick
// used to take the nearest blob of ANY kind and then check its owner, so one
// of the player's own groups standing nearer the cursor made the whole
// function answer "no enemy here" and the attack order degraded to a plain
// march. Own armies are the biggest circles on the map and they end up right
// beside whatever they were sent at, so every retry failed the same way.
function targetableEnemy(b) {
  return b.owner !== me && b.working == null && S.isVisible(game, b.x, b.y);
}

// The forgiving pick radius the tap flows already use for route endpoints —
// a finger is not a cursor. Shared so the order popup's enemy pick matches it.
function tapHitR() { return Math.max(1.5, 24 / view.scale); }

// Enemy entity under a world point that the current player may target
// directly: a visible enemy blob, or an enemy settlement that is visible
// or remembered on the map.
//
// `tol` is the slack past a blob's own circle that still counts as a hit.
// Right-clicks keep the tight #201 grab (0.9); the tap popup passes its
// generous radius, because it ASKS which order the player meant instead of
// committing to one — which is what #201's own comment always claimed.
function findEnemyTargetAt(world, tol) {
  const grab = tol != null ? tol : 0.9;
  const known = game.pvp ? game.knowns[me] : game.known;
  // footprint-first (#165): a tap on an enemy settlement's 2×2 grounds
  // targets the settlement even when an enemy blob overlaps it
  const fp = settlementAtFootprint(world);
  if (fp && fp.owner !== me && (S.settVisible(game, fp) || known[fp.id])) {
    return { kind: 'settlement', id: fp.id };
  }
  // enemy wall (#187): exact-tile target, footprint-style precedence
  const wl = wallAtPoint(world);
  if (wl && wl.owner !== me && wallKnown(wl)) {
    return { kind: 'wall', id: wl.id };
  }
  // tight grab (#201): blobAt measures EDGE distance, so the old
  // max(1.5, 24/scale) slack reached ~4 tiles past a big stack's centre
  // and quietly turned retreat / garrison clicks into fresh attacks. A
  // move only becomes an attack when the click lands on (or right at the
  // edge of) the enemy itself; the touch popup keeps its generous pick
  // because it asks the player which order they meant.
  const eb = S.blobAt(game, world.x, world.y, grab, targetableEnemy);
  if (eb) return { kind: 'blob', id: eb.id };
  const st = S.settlementAt(game, world.x, world.y, Math.max(1.9, grab));
  if (st && st.owner !== me && (S.settVisible(game, st) || known[st.id])) {
    return { kind: 'settlement', id: st.id };
  }
  return null;
}

// The order's destination lands INSIDE a visible enemy group's circle, so the
// order can only mean "attack it" (#243). Without this, a click that missed the
// grab radius became a plain tile move onto the enemy — and a plain move plans
// around visible enemies, so the group halted an avoidance ring short (~2.8
// tiles, circles touching on screen) with its order quietly completed and not a
// word said. Deliberately an ORDER-ISSUING rule here in the dispatch, not in
// the sim: opMove's #74 invariant ("a plain tile move never diverts to attack")
// stays exactly as written, and what goes over the PvP wire / into the replay
// log is an ordinary targeted order.
function attackTargetFor(world, target) {
  if (target) return target;
  const inside = S.blobAt(game, world.x, world.y, 0, targetableEnemy);
  return inside ? { kind: 'blob', id: inside.id } : null;
}

// The own wall / own settlement destination a click resolved to, UNLESS the
// click landed on an enemy group (#243). opMove already documents the rule this
// restores: cancelling a target on the player's own grounds "would forbid
// attacking an enemy standing in your own town square". An exact own WALL tile
// still wins — blockedTiles keeps enemies off it, so nothing legitimate is
// lost — and a click with no enemy under it is a garrison march as before.
function garrisonTargetUnlessEnemy(world, enemy) {
  const garr = ownGarrisonTargetAt(world);
  if (!garr) return null;
  if (garr.kind === 'wall' && wallAtPoint(world)) return garr;
  return enemy && enemy.kind === 'blob' ? null : garr;
}

// An own-entity destination under a world point (#201): one of the
// player's finished wall tiles, or their own completed settlement's
// grounds. A click here is unambiguously "march there and garrison", so
// the move dispatch must NEVER let a nearby enemy steal it — an attacker
// standing beside a wall used to outrank the wall itself. Mirrors the
// own-entity-first precedence the route flows already use (#142, #187).
//
// Returns the SNAPPED destination too (#222). The sim's garrison rules
// are tile-exact: `isOwnGarrisonSpot` decides whether a march may push
// through contact, and the arrival fold reads the tile the group ends
// up standing on. A wall is a single ~14 px tile at the default zoom, so
// handing opMove the raw click point meant a near-miss silently became
// "walk to the tile next door and stop" — the army halts a tile short
// (or, once contact holds it, several tiles short) and never enters.
// Both the tile hit and the settlement grounds now carry the same 8 px
// forgiveness band every other pick uses, and callers order the group to
// `x, y` instead of the cursor.
function ownGarrisonTargetAt(world) {
  const wl = wallNearPoint(world, null, w => w.owner === me && !w.building);
  if (wl && wl.owner === me && !wl.building) {
    return { kind: 'wall', id: wl.id, x: wl.x + 0.5, y: wl.y + 0.5 };
  }
  const fp = settlementAtFootprint(world);
  if (fp && fp.owner === me && !fp.building) {
    return { kind: 'settlement', id: fp.id, x: fp.x + 1, y: fp.y + 1 };
  }
  const st = settlementNearFootprint(world);
  if (st && st.owner === me && !st.building) {
    return { kind: 'settlement', id: st.id, x: st.x + 1, y: st.y + 1 };
  }
  return null;
}

// Blobs that are in contact right now — drives the panel's combat lines
// (same 5-tick window the renderer uses). Breaking off needs no special
// affordance: an ordinary move order given during a fight IS the
// withdrawal (opMove flags it, and tickOrder honours the flag).
function inCombat(b) { return !!b && game.tick - b.engagedT < 5; }

function onRightClick(world) {
  if (!game || game.result) return;
  // tutorial (#185): a right-click always means "act at this point" —
  // whether resolving an armed pending or issuing a move/attack — so the
  // one gate is the step's world target
  if (game.tutorial && !TUT.allowsTarget(world)) { TUT.nudge(); return; }
  hideOrderPopup();
  // armed route mode: a right-click resolves it exactly like a tap (#178)
  if (ui.pending === 'route' || ui.pending === 'route-sett') {
    resolvePending(world, 'mouse');
    return;
  }
  // armed wall placement (#187): right-clicks place the two endpoints too
  if (ui.pending === 'wall') {
    resolvePending(world, 'mouse');
    return;
  }
  const blobs = selectedBlobs();
  if (!blobs.length) return;
  // a pure-supply selection right-clicking one of the player's completed
  // settlements starts a supply route FROM that settlement (#179); the
  // next right-click or tap picks the destination
  const tot = blobs.reduce((s, b) => s + S.total(b), 0);
  const pureSupply = tot > 0 && blobs.reduce((s, b) => s + b.count.supply, 0) === tot;
  if (pureSupply && !ui.pending) {
    // footprint + band (#224): the old max(1.9, hitR) radius armed a
    // route from a couple of tiles of open ground away, swallowing plain
    // move orders for carriers walking past a town
    const fp = settlementAtFootprint(world) || settlementNearFootprint(world);
    if (fp && fp.owner === me && !fp.building) {
      ui.pending = 'route';
      ui.routeSrc = fp.id;
      pingRoute(fp.x + 1, fp.y + 1);
      updateHint();
      renderPanel(true);
      return;
    }
  }
  // own wall / own settlement under the cursor is a garrison march, never
  // an attack on whatever enemy happens to stand beside it (#201) — and
  // it marches to the entity's own tile, not the raw cursor point (#222).
  // A click ON an enemy group outranks that (#243): the garrison rule is
  // about ground nobody is standing on.
  const enemy = findEnemyTargetAt(world);
  const garr = garrisonTargetUnlessEnemy(world, enemy);
  orderMove(blobs, world, garr ? null : attackTargetFor(world, enemy), garr);
}

// Shared move dispatch: issue the order to every selected blob, ping the
// destination, and confirm field assignments (#111) so a farmland click
// visibly reads as "go work that plot", not a plain move.
//
// `garr` is the own wall / settlement the click resolved to (#222). Its
// snapped centre becomes the destination handed to the sim, so the order
// lands ON the garrison tile — the only destination the sim treats as a
// march into cover. It is applied BEFORE doMove, because doMove relays
// the same coords over PvP and both sides must resolve them identically.
function orderMove(blobs, world, target, garr) {
  const dest = garr ? { x: garr.x, y: garr.y } : world;
  let err = null, ok = 0, fielded = 0;
  for (const b of blobs) {
    const r = doMove(b, dest.x, dest.y, target);
    if (r.err) err = r.err;
    else { ok++; fielded += r.fielded || 0; }
  }
  if (ok) pingOrder(dest, target);
  if (fielded) toast(`🌱 ${fielded} farmer${fielded === 1 ? '' : 's'} heading to the fields`);
  else if (err) toast(err);
}

// Brief destination animation so a move/attack order visibly lands (#71).
function pingOrder(world, target) {
  ui.ping = { x: world.x, y: world.y, kind: target ? 'attack' : 'move', t: performance.now() };
}

// Sky-blue ping snapped to a picked supply-route endpoint — route taps
// pick entities, not ground, so the snap makes a near-miss visible.
function pingRoute(x, y) {
  ui.ping = { x, y, kind: 'route', t: performance.now() };
}

// ---------------------------------------------------------------- control groups (#69, #77)
// Shift+1–9 assigns the current selection to that number; 1–9 selects the
// group; pressing the same number twice quickly also centers the camera
// on it. The groups bar (#77) shows the same groups as tappable chips, so
// everything here is reachable by tap alone. Session-local UI state —
// never serialized.

// Resolve a group to live entities, pruning dead ones (blob ids follow
// the merge log; two old ids can resolve to one survivor — dedupe).
// Shared by the digit keys and the groups-bar chips.
function resolveGroup(n) {
  const g = groups[n];
  if (!g || !game) return null;
  if (g.kind === 'settlement') {
    const st = game.settlements.find(s => s.id === g.id && s.owner === me);
    if (!st) { delete groups[n]; return null; }
    return { kind: 'settlement', st };
  }
  const resolved = g.ids.map(findBlob).filter(b => b && !b.dead && b.owner === me);
  const blobs = [...new Map(resolved.map(b => [b.id, b])).values()];
  if (!blobs.length) { delete groups[n]; return null; }
  g.ids = blobs.map(b => b.id);
  return { kind: 'blobs', blobs };
}

function assignGroup(n) {
  if (ui.selected && ui.selected.kind === 'settlement') {
    const st = selectedSettlement();
    if (!st) return false;
    groups[n] = { kind: 'settlement', id: st.id };
    toast(`Group ${n} set — ${st.name || 'settlement'}`);
    CT.signal('group-assign'); // #212
    return true;
  }
  const blobs = selectedBlobs();
  if (blobs.length) {
    groups[n] = { kind: 'blobs', ids: blobs.map(b => b.id) };
    toast(`Group ${n} set — ${blobs.length} blob${blobs.length === 1 ? '' : 's'}`);
    CT.signal('group-assign'); // #212
    return true;
  }
  return false;
}

// Select group n; a second select within 450 ms also centers the camera.
function selectGroup(n) {
  const r = resolveGroup(n);
  if (!r) return;
  CT.signal('group-select'); // #212
  const now = performance.now();
  const dbl = lastGroupTap.n === n && now - lastGroupTap.t < 450;
  lastGroupTap = { n, t: now };
  if (r.kind === 'settlement') {
    ui.selected = { kind: 'settlement', id: r.st.id };
    if (dbl) { view.cx = r.st.x + 1; view.cy = r.st.y + 1; input.clampView(); }
  } else {
    const ids = r.blobs.map(b => b.id);
    ui.selected = ids.length === 1 ? { kind: 'blob', id: ids[0] } : { kind: 'multi', ids: ids.slice() };
    if (dbl) {
      let cx = 0, cy = 0;
      for (const b of r.blobs) { cx += b.x; cy += b.y; }
      view.cx = cx / r.blobs.length; view.cy = cy / r.blobs.length;
      input.clampView();
    }
  }
  renderPanel(true);
  updateGroupsBar();
}

function onGroupKey(n, shift) {
  if (!game || game.result || game.tutorial) return;
  if (shift) {
    if (!assignGroup(n) && groups[n]) {
      delete groups[n];
      toast(`⌨️ Group ${n} cleared`);
    }
    updateGroupsBar();
    return;
  }
  selectGroup(n);
}

// -- groups bar (#77): chips on the left edge mirroring groups 1–9.
// Tap = select, tap again quickly = center, ✕ on the active chip clears
// it, ＋ assigns the current selection to the lowest free number.

let lastGroupsHTML = '';

function groupIsActive(r) {
  if (!ui.selected) return false;
  if (r.kind === 'settlement') {
    return ui.selected.kind === 'settlement' && ui.selected.id === r.st.id;
  }
  if (ui.selected.kind !== 'blob' && ui.selected.kind !== 'multi') return false;
  const selIds = selectedBlobs().map(b => b.id);
  const ids = new Set(r.blobs.map(b => b.id));
  return selIds.length === ids.size && selIds.every(id => ids.has(id));
}

function updateGroupsBar() {
  const bar = $('groups-bar');
  if (!bar) return;
  if (!game || game.result) {
    bar.classList.add('hidden');
    lastGroupsHTML = '';
    return;
  }
  const chips = [];
  for (let n = 1; n <= 9; n++) {
    const r = resolveGroup(n);
    if (!r) continue;
    const label = r.kind === 'settlement'
      ? '🏠'
      : `👥${r.blobs.reduce((sum, b) => sum + S.total(b), 0)}`;
    const active = groupIsActive(r);
    chips.push(`<button data-gsel="${n}" class="btn-sm px-2 rounded-lg border flex items-center gap-1 ${active ? 'bg-violet-700 border-violet-500 text-white' : 'bg-zinc-900/85 border-zinc-700 text-zinc-200 hover:bg-zinc-800'}">
      <b>${n}</b><span class="text-xs">${label}</span>${active ? `<span data-gdel="${n}" class="text-xs text-violet-200 pl-1">✕</span>` : ''}
    </button>`);
  }
  const canAssign = !game.tutorial && ui.selected && (ui.selected.kind === 'blob' || ui.selected.kind === 'multi' || ui.selected.kind === 'settlement');
  if (canAssign) {
    chips.push('<button data-gadd="1" class="btn-sm px-2 rounded-lg bg-zinc-900/70 border border-dashed border-zinc-600 text-zinc-400 hover:bg-zinc-800">＋</button>');
  }
  const html = chips.join('');
  bar.classList.toggle('hidden', !html);
  if (html !== lastGroupsHTML) {
    lastGroupsHTML = html;
    bar.innerHTML = html;
  }
}

$('groups-bar').addEventListener('click', (e) => {
  if (!game || game.result || game.tutorial) return;
  const del = e.target.closest('[data-gdel]');
  if (del) {
    delete groups[+del.dataset.gdel];
    toast(`Group ${del.dataset.gdel} cleared`);
    updateGroupsBar();
    return;
  }
  const sel = e.target.closest('[data-gsel]');
  if (sel) { selectGroup(+sel.dataset.gsel); return; }
  if (e.target.closest('[data-gadd]')) {
    let n = 0;
    for (let k = 1; k <= 9; k++) if (!groups[k]) { n = k; break; }
    if (!n) { toast('All groups in use'); return; }
    assignGroup(n);
    updateGroupsBar();
  }
});

// Pan/pinch/wheel dismiss the inline order popup — except the build ✓/✕
// pair, which must survive panning so the player can frame the site and
// still confirm (#94). It's screen-anchored, so it simply stays put.
function onGesture() {
  if (ui.pending === 'build' && ui.buildSite) return;
  if (ui.pending === 'wall' && ui.wallEnd) return; // wall ✓/✕ survives panning too
  hideOrderPopup();
}

function onCancel() {
  if (ui.pending) {
    ui.pending = null;
    ui.buildSite = null;
    ui.wallStart = null;
    ui.wallEnd = null;
    ui.routeSrc = null;
    hideOrderPopup(); // the build-confirm popup rides on the pending state
    updateHint();
    return;
  }
  if (!orderPopup.classList.contains('hidden')) { hideOrderPopup(); return; }
  ui.selected = null;
  renderPanel(true);
}

// ---------------------------------------------------------------- Select/Drag mode toggle (phones)

// Two icon buttons bottom-left: Select (cursor — tap-first, all orders)
// and Drag (dashed box — drag-only selection building; entering it drops
// the current unit selection). Session-local UI state — never serialized.
function updateModeToggle() {
  const el = $('mode-toggle');
  if (!el) return;
  const show = game && !game.result && isMobile();
  el.classList.toggle('hidden', !show);
  if (!show) return;
  const on = 'btn px-3 rounded-lg border flex items-center justify-center bg-violet-600 border-violet-400 text-white';
  const off = 'btn px-3 rounded-lg border flex items-center justify-center bg-zinc-900/85 border-zinc-700 text-zinc-300';
  $('btn-mode-select').className = ui.touchMode === 'drag' ? off : on;
  $('btn-mode-drag').className = ui.touchMode === 'drag' ? on : off;
  // positioning is layoutBottomStack's job (below)
}

// ------------------------------------------------- bottom-edge stacking
//
// #237: the replay bar (z-30, ~100 px tall) is anchored to the bottom of
// the viewport and paints straight over the minimap, the selection panel,
// the unit strip and the phone mode toggle — all of which live in the same
// corner. One function owns every bottom offset so the stack stays honest
// no matter which combination is on screen; each element falls back to its
// Tailwind default (style.bottom = '') when nothing is beneath it.
function replayBarHeight() {
  const bar = $('replay-bar');
  return !bar || bar.classList.contains('hidden') ? 0 : bar.offsetHeight;
}

function layoutBottomStack() {
  const wide = window.matchMedia('(min-width: 640px)').matches;
  const rb = replayBarHeight();
  const strip = $('unit-strip');
  const toggle = $('mode-toggle');
  const mm = $('minimap');

  // desktop minimap sits bottom-left (sm:bottom-2 → 8 px); on phones it is
  // parked top-right, where the bar never reaches
  if (mm) mm.style.bottom = wide && rb ? `${8 + rb}px` : '';
  // panel: desktop floats (bottom-3 → 12 px), phones are a flush sheet
  panel.style.bottom = rb ? `${(wide ? 12 : 0) + rb}px` : '';

  const panelH = panel.classList.contains('hidden') ? 0 : panel.offsetHeight;
  if (!strip.classList.contains('hidden')) {
    // desktop: strip clears the bar only; phones: it rides the sheet's top edge
    strip.style.bottom = wide
      ? (rb ? `${8 + rb}px` : '')
      : `${panelH + rb}px`;
  }
  if (toggle && !toggle.classList.contains('hidden')) {
    const stripH = strip.classList.contains('hidden') ? 0 : strip.offsetHeight;
    toggle.style.bottom = `${8 + rb + panelH + stripH}px`;
  }
}
window.addEventListener('resize', layoutBottomStack);

$('mode-toggle').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn || !game) return;
  ui.touchMode = btn.id === 'btn-mode-drag' ? 'drag' : 'select';
  CT.signal(ui.touchMode === 'drag' ? 'mode-drag' : 'mode-select'); // #212
  if (btn.id === 'btn-mode-drag') {
    // Drag always starts a fresh group: drop any selected units and any
    // armed order (every tap of the button, not just mode changes)
    if (ui.selected && (ui.selected.kind === 'blob' || ui.selected.kind === 'multi')) ui.selected = null;
    ui.pending = null;
    ui.buildSite = null;
    ui.wallStart = null;
    ui.wallEnd = null;
    ui.routeSrc = null;
    hideOrderPopup();
    updateHint();
    renderPanel(true);
  }
  updateModeToggle();
  $('game-canvas').focus({ preventScroll: true });
});

// ---------------------------------------------------------------- order popup

const orderPopup = $('order-popup');

function hideOrderPopup() {
  orderPopup.classList.add('hidden');
  ui.orderTarget = null;
  ui.orderTargetEnt = null;
}

function showOrderPopup(world, screen, target) {
  CT.signal('ask-popup'); // controls tour (#212): "a tap always asks first"
  ui.orderTarget = world;
  ui.orderTargetEnt = target || null;
  const hasDeploy = selectedBlobs().some(b => b.count.deploy > 0);
  const atkLabel = target && target.kind === 'blob' ? '⚔️ Attack blob'
    : target && target.kind === 'wall' ? '⚔️ Attack wall' : '⚔️ Attack settlement';
  orderPopup.innerHTML = `
    ${target && hasDeploy ? `<button data-act="pattack" class="btn px-3 rounded-lg text-left bg-red-900/80 hover:bg-red-800 text-red-100">${atkLabel}</button>` : ''}
    <button data-act="pmove" class="btn px-3 rounded-lg text-left bg-zinc-800 hover:bg-zinc-700">📍 Move</button>
    <button data-act="pclose" class="btn px-3 rounded-lg text-left bg-zinc-900 text-zinc-400 hover:bg-zinc-800">✕ Deselect</button>`;
  orderPopup.classList.remove('hidden');
  const px = screen ? screen.x : window.innerWidth / 2;
  const py = screen ? screen.y : window.innerHeight / 2;
  const w = orderPopup.offsetWidth, h = orderPopup.offsetHeight;
  orderPopup.style.left = Math.max(4, Math.min(window.innerWidth - w - 4, px + 10)) + 'px';
  orderPopup.style.top = Math.max(4, Math.min(window.innerHeight - h - 4, py - h / 2)) + 'px';
}

// Select popup (phone UI, Select mode): tapping a friendly blob outside
// the current selection while units are already in hand asks before
// switching — Select swaps the selection to the tapped blob, Move
// ('pmove' rides the shared orderMove dispatch) marches the selection
// to the tapped blob's spot while keeping it selected, and Deselect
// clears the current selection. With nothing selected the tap selects
// the blob directly (see onTap) and this popup never shows.
//
// When the tapped point is one of the player's OWN garrison spots (#222)
// the move button becomes an explicit Garrison aimed at that tile rather
// than at the tapped unit's feet: a wall under attack is exactly where
// friendly defenders cluster, so this used to be the only reachable
// action next to it — and it marched the group alongside the wall.
let tapBlobId = null;
function showSelectPopup(b, screen, world) {
  CT.signal('ask-popup');
  const garr = world ? ownGarrisonTargetAt(world) : null;
  ui.orderTarget = garr ? { x: garr.x, y: garr.y } : { x: b.x, y: b.y };
  ui.orderTargetEnt = null;
  tapBlobId = b.id;
  orderPopup.innerHTML = `
    <button data-act="pmove" class="btn px-3 rounded-lg text-left bg-zinc-800 hover:bg-zinc-700">${garr ? '🛡️ Garrison' : '📍 Move here'}</button>
    <button data-act="pselect" class="btn px-3 rounded-lg text-left bg-violet-700 hover:bg-violet-600 text-white">👆 Select</button>
    <button data-act="pclose" class="btn px-3 rounded-lg text-left bg-zinc-900 text-zinc-400 hover:bg-zinc-800">✕ Deselect</button>`;
  orderPopup.classList.remove('hidden');
  const px = screen ? screen.x : window.innerWidth / 2;
  const py = screen ? screen.y : window.innerHeight / 2;
  const w = orderPopup.offsetWidth, h = orderPopup.offsetHeight;
  orderPopup.style.left = Math.max(4, Math.min(window.innerWidth - w - 4, px + 10)) + 'px';
  orderPopup.style.top = Math.max(4, Math.min(window.innerHeight - h - 4, py - h / 2)) + 'px';
}

// Garrison popup (phone UI, Select mode): tapping an own settlement with
// units in hand asks — switch the selection to the settlement, march the
// group into its garrison, or clear the selection.
let tapSettId = null;
function showGarrisonPopup(st, screen) {
  CT.signal('ask-popup');
  ui.orderTarget = { x: st.x + 1, y: st.y + 1 }; // 'pgarrison' marches here
  ui.orderTargetEnt = null;
  tapSettId = st.id;
  orderPopup.innerHTML = `
    <button data-act="pselsett" class="btn px-3 rounded-lg text-left bg-violet-700 hover:bg-violet-600 text-white">🏠 Select settlement</button>
    <button data-act="pgarrison" class="btn px-3 rounded-lg text-left bg-zinc-800 hover:bg-zinc-700">🛡️ Garrison units</button>
    <button data-act="pclose" class="btn px-3 rounded-lg text-left bg-zinc-900 text-zinc-400 hover:bg-zinc-800">✕ Deselect</button>`;
  orderPopup.classList.remove('hidden');
  const px = screen ? screen.x : window.innerWidth / 2;
  const py = screen ? screen.y : window.innerHeight / 2;
  const w = orderPopup.offsetWidth, h = orderPopup.offsetHeight;
  orderPopup.style.left = Math.max(4, Math.min(window.innerWidth - w - 4, px + 10)) + 'px';
  orderPopup.style.top = Math.max(4, Math.min(window.innerHeight - h - 4, py - h / 2)) + 'px';
}

// Unit-options popup (phone UI): tapping an already-selected blob opens
// everything the desktop panel's button section offers, next to the finger.
function showUnitOptions(screen) {
  const blobs = selectedBlobs();
  if (!blobs.length) return;
  CT.signal('unit-options'); // controls tour (#212): the tap-again action list
  ui.orderTarget = null;
  ui.orderTargetEnt = null;
  splitHoldConsumed = false;
  const tot = blobs.reduce((s, b) => s + S.total(b), 0);
  const cnt = { deploy: 0, supply: 0, farm: 0 };
  for (const b of blobs) { cnt.deploy += b.count.deploy; cnt.supply += b.count.supply; cnt.farm += b.count.farm; }
  const pureSupply = cnt.supply === tot && tot > 0;
  // a MIXED group can run a line too (#239) — it goes as one blob, its
  // supply units hauling and its fighters escorting
  const hasSupply = cnt.supply > 0;
  const routeLabel = cnt.supply < tot ? '🚚 Escort a supply route…' : '🚚 Supply route…';
  const atHome = blobs.some(b => S.isAtHome(game, b));
  const pillaging = blobs.some(b => b.pillaging);
  const canSplit = blobs.length === 1 && tot >= 2;
  const canBuild = tot >= S.C.SETT_COST;
  orderPopup.innerHTML = `
    <button data-act="pmovearm" class="btn px-3 rounded-lg text-left bg-zinc-800 hover:bg-zinc-700">📍 Move…</button>
    <button data-act="ppillage" class="btn px-3 rounded-lg text-left ${pillaging ? 'bg-orange-700 text-white' : 'bg-zinc-800 hover:bg-zinc-700'}">🔥 ${pillaging ? 'Stop pillaging' : 'Pillage'}</button>
    ${canSplit ? `<button data-act="psplit" style="touch-action:none" class="btn px-3 rounded-lg text-left bg-zinc-800 hover:bg-zinc-700">✂️ Split ${Math.floor(tot / 2)} / ${tot} <span class="text-xs text-zinc-500">(hold to adjust)</span></button>` : ''}
    <button data-act="pbuildarm" ${canBuild ? '' : 'disabled'} class="btn px-3 rounded-lg text-left ${canBuild ? 'bg-zinc-800 hover:bg-zinc-700' : 'bg-zinc-800 text-zinc-500 opacity-40'}">🏠 Build (${S.C.SETT_COST})</button>
    <button data-act="pwallarm" class="btn px-3 rounded-lg text-left bg-zinc-800 hover:bg-zinc-700">🧱 Wall…</button>
    ${hasSupply ? `<button data-act="proutearm" class="btn px-3 rounded-lg text-left bg-sky-800 hover:bg-sky-700">${routeLabel}</button>` : ''}
    <div class="flex gap-1">
      ${roleBtn('deploy', '⚔️', cnt.deploy === tot, false)}${roleBtn('supply', '🚚', pureSupply, false)}${roleBtn('farm', '🌱', cnt.farm === tot, !atHome)}
    </div>
    <button data-act="pclose" class="btn px-3 rounded-lg text-left bg-zinc-900 text-zinc-400 hover:bg-zinc-800">✕ Deselect</button>`
    .replaceAll('data-act="role"', 'data-act="prole"');
  orderPopup.classList.remove('hidden');
  const px = screen ? screen.x : window.innerWidth / 2;
  const py = screen ? screen.y : window.innerHeight / 2;
  const w = orderPopup.offsetWidth, h = orderPopup.offsetHeight;
  orderPopup.style.left = Math.max(4, Math.min(window.innerWidth - w - 4, px + 10)) + 'px';
  orderPopup.style.top = Math.max(4, Math.min(window.innerHeight - h - 4, py - h / 2)) + 'px';
  const sbtn = orderPopup.querySelector('[data-act="psplit"]');
  if (sbtn) attachSplitHold(sbtn);
}

// Split gesture: a plain tap splits off half (handled by the click
// dispatcher); press-and-hold (~350 ms) reveals a slider row anchored in
// the popup — while still holding, horizontal movement picks the amount
// (clamped to 1…n−1), and release commits wherever the finger ends up
// (pointer capture keeps the stream). pointercancel / popup dismissal
// aborts without splitting.
let splitHoldConsumed = false; // eat the synthesized click after a hold

// Hold-drag count mapping (#189): the count follows the finger's absolute
// horizontal screen position — near the left edge = 1, near the right
// edge = max, linear in between. The margin keeps both extremes reachable
// without having to touch the outermost pixels.
const HOLD_EDGE_PX = 24;
function holdValueFromX(clientX, maxV) {
  const span = Math.max(1, window.innerWidth - 2 * HOLD_EDGE_PX);
  const t = Math.max(0, Math.min(1, (clientX - HOLD_EDGE_PX) / span));
  return Math.max(1, Math.min(maxV, 1 + Math.round(t * (maxV - 1))));
}

function attachSplitHold(btn) {
  let timer = null, sliding = false, lastX = 0, value = 1, maxV = 1, totNow = 2, row = null, fill = null;

  function cleanup() {
    clearTimeout(timer);
    timer = null;
    sliding = false;
    if (row) { row.remove(); row = null; fill = null; }
  }

  function update() {
    if (fill) fill.style.width = (maxV <= 1 ? 100 : Math.round(100 * (value - 1) / (maxV - 1))) + '%';
    btn.textContent = `✂️ Split ${value} / ${totNow}`;
  }

  function abort() {
    // aborted hold: keep the consumed flag so the synthesized click can't
    // fire a surprise half-split; the next popup build resets it
    cleanup();
  }

  btn.addEventListener('pointerdown', (e) => {
    const b = selectedBlobs()[0];
    if (!b || S.total(b) < 2) return;
    try { btn.setPointerCapture(e.pointerId); } catch { }
    lastX = e.clientX;
    timer = setTimeout(() => {
      timer = null;
      const b2 = selectedBlobs()[0];
      if (!b2 || S.total(b2) < 2 || orderPopup.classList.contains('hidden')) return;
      sliding = true;
      splitHoldConsumed = true;
      CT.signal('hold-arm'); // #212: the gesture is taught on arm, not commit
      totNow = S.total(b2);
      maxV = totNow - 1;
      value = holdValueFromX(lastX, maxV);
      row = document.createElement('div');
      row.className = 'px-1 pb-1';
      row.innerHTML = '<div class="h-2 rounded bg-zinc-700 overflow-hidden"><div class="h-full bg-violet-500"></div></div>';
      btn.insertAdjacentElement('afterend', row);
      fill = row.firstElementChild.firstElementChild;
      update();
    }, 350);
    e.preventDefault();
  });

  btn.addEventListener('pointermove', (e) => {
    lastX = e.clientX;
    if (!sliding) return;
    if (orderPopup.classList.contains('hidden')) { abort(); return; } // dismissed mid-hold
    value = holdValueFromX(e.clientX, maxV);
    update();
  });

  function end(e) {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!sliding) return; // plain tap — the click dispatcher does the half-split
    const commit = e.type === 'pointerup' && !orderPopup.classList.contains('hidden');
    cleanup();
    hideOrderPopup();
    if (!commit) return;
    // the sim kept ticking during the hold — re-resolve and re-clamp
    const b = selectedBlobs()[0];
    if (b && S.total(b) >= 2) {
      const r = doSplit(b, Math.max(1, Math.min(S.total(b) - 1, value)));
      if (r.err) toast(r.err);
    }
    renderPanel(true);
  }
  btn.addEventListener('pointerup', end);
  btn.addEventListener('pointercancel', end);
}

// Recall the n farthest-out farmers of a settlement (#68) — the close
// fields stay manned. n falsy means "all".
function recallFarmers(st, n) {
  const workers = game.blobs
    .filter(b => !b.dead && b.owner === me && b.working === st.id)
    .sort((a, b2) => dist(b2.x, b2.y, st.x + 1, st.y + 1) - dist(a.x, a.y, st.x + 1, st.y + 1));
  const k = Math.max(1, Math.min(workers.length, n || workers.length));
  let c = 0;
  for (const b of workers.slice(0, k)) {
    if (doMove(b, st.x + 1, st.y + 1).ok) c++;
  }
  toast(c ? `🏠 Recalling ${c} farmer${c === 1 ? '' : 's'}` : 'No farmers working the fields');
}

// Hold-drag count buttons (#189): the phone panel's Recall and Field
// buttons mirror the split button's hold UX — a plain tap acts on the
// shown count (via the click dispatcher), press-and-hold (~350 ms)
// reveals a fill bar and the count follows the finger's absolute
// horizontal screen position (holdValueFromX); release commits,
// pointercancel aborts. cfg: { max(), label(v, max), onArm(), commit(v) }.
let recallHoldConsumed = false; // eat the synthesized click after a hold
let fieldHoldConsumed = false;

function attachHoldCount(btn, cfg) {
  let timer = null, sliding = false, lastX = 0, value = 1, maxV = 1, row = null, fill = null;

  function cleanup() {
    clearTimeout(timer);
    timer = null;
    sliding = false;
    if (row) { row.remove(); row = null; fill = null; }
  }

  function update() {
    if (fill) fill.style.width = (maxV <= 1 ? 100 : Math.round(100 * (value - 1) / (maxV - 1))) + '%';
    btn.textContent = cfg.label(value, maxV);
  }

  btn.addEventListener('pointerdown', (e) => {
    if (cfg.max() < 2) return; // nothing to adjust — plain tap covers it
    try { btn.setPointerCapture(e.pointerId); } catch { }
    lastX = e.clientX;
    timer = setTimeout(() => {
      timer = null;
      maxV = cfg.max(); // the sim kept ticking — re-resolve
      if (maxV < 2) return;
      sliding = true;
      cfg.onArm();
      CT.signal('hold-arm'); // #212: releasing without sliding commits nothing
      value = holdValueFromX(lastX, maxV);
      row = document.createElement('div');
      row.className = 'mt-1';
      row.innerHTML = '<div class="h-2 rounded bg-zinc-700 overflow-hidden"><div class="h-full bg-violet-500"></div></div>';
      btn.parentElement.insertAdjacentElement('afterend', row);
      fill = row.firstElementChild.firstElementChild;
      update();
    }, 350);
    e.preventDefault();
  });

  btn.addEventListener('pointermove', (e) => {
    lastX = e.clientX;
    if (!sliding) return;
    value = holdValueFromX(e.clientX, maxV);
    update();
  });

  function end(e) {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!sliding) return; // plain tap — the click dispatcher acts
    const commit = e.type === 'pointerup';
    cleanup();
    if (commit) cfg.commit(value);
    lastPanelHTML = ''; // the hold mutated the button text — force a rebuild
    renderPanel(true);
  }
  btn.addEventListener('pointerup', end);
  btn.addEventListener('pointercancel', end);
}

function attachRecallHold(btn) {
  attachHoldCount(btn, {
    max: () => { const st = selectedSettlement(); return st ? S.workingCount(game, st) : 0; },
    label: (v, m) => `Recall ${v}/${m}`,
    onArm: () => { recallHoldConsumed = true; },
    commit: (v) => {
      ui.recallCount = v;
      const st = selectedSettlement();
      if (st) recallFarmers(st, v); // recallFarmers re-clamps
    },
  });
}

function attachFieldHold(btn) {
  attachHoldCount(btn, {
    max: () => {
      const st = selectedSettlement();
      return st && ui.fieldRole ? st.garrison[ui.fieldRole] : 0;
    },
    label: (v, m) => `Field ${v}/${m}`,
    onArm: () => { fieldHoldConsumed = true; },
    commit: (v) => {
      const st = selectedSettlement();
      const role = ui.fieldRole;
      if (!st || !role) return;
      ui.fieldCounts[role] = v;
      const r = doFieldRole(st, role, Math.max(1, Math.min(st.garrison[role], v)));
      if (r.err) toast(r.err);
    },
  });
}

// Touch build placement (#94): the armed outline sits at ui.buildSite;
// this floating ✓/✕ pair beside it commits or abandons the site. Re-taps
// on the map move the outline (resolvePending runs before the popup's
// tap-dismiss check in onTap), so the popup just follows the last tap.
function showBuildConfirm(screen) {
  CT.signal('ask-popup'); // the ✓ / ✕ pair is one of the "ask first" family
  ui.orderTarget = null;
  ui.orderTargetEnt = null;
  const ok = ui.buildSite && ui.buildSite.ok;
  orderPopup.innerHTML = `
    <button data-act="pbuild" class="btn px-3 rounded-lg text-left ${ok ? 'bg-emerald-700 hover:bg-emerald-600 text-white' : 'bg-zinc-800 text-zinc-500 opacity-40'}" ${ok ? '' : 'disabled'}>✓ Found here</button>
    <button data-act="pbuildx" class="btn px-3 rounded-lg text-left bg-zinc-900 text-zinc-400 hover:bg-zinc-800">✕ Cancel</button>`;
  orderPopup.classList.remove('hidden');
  const w = orderPopup.offsetWidth, h = orderPopup.offsetHeight;
  const vw = window.innerWidth, vh = window.innerHeight;
  // Keep the popup clear of the settlement grounds (#157): the 2×2
  // footprint plus the farm ring it will till reach ~3.2 tiles from the
  // site center, so anchor the popup just outside that circle — on
  // whichever side has screen room — instead of on top of the site.
  let cx = screen ? screen.x : vw / 2, cy = screen ? screen.y : vh / 2;
  if (ui.buildSite) {
    cx = (ui.buildSite.x + 1 - view.cx) * view.scale + vw / 2;
    cy = (ui.buildSite.y + 1 - view.cy) * view.scale + vh / 2;
  }
  const r = 3.2 * view.scale + 12;
  const clampX = (x) => Math.max(4, Math.min(vw - w - 4, x));
  const clampY = (y) => Math.max(4, Math.min(vh - h - 4, y));
  const fitsRight = cx + r + w + 4 <= vw;
  const fitsLeft = cx - r - w >= 4;
  let left, top;
  if (fitsRight || fitsLeft) {
    left = (fitsRight && (cx <= vw / 2 || !fitsLeft)) ? cx + r : cx - r - w;
    top = clampY(cy - h / 2);
  } else {
    // zoomed in tight — no room beside the grounds, go above or below
    left = clampX(cx - w / 2);
    top = cy - r - h >= 4 ? cy - r - h : clampY(cy + r);
  }
  orderPopup.style.left = left + 'px';
  orderPopup.style.top = top + 'px';
}

// Wall placement confirm (#187): after the second click sets the line's
// end, this floating ✓/✕ pair beside the line commits or abandons it —
// the same two-step confirm settlement founding uses, on mouse AND
// touch. Re-taps move the end point and the popup follows.
function showWallConfirm(screen) {
  CT.signal('ask-popup');
  ui.orderTarget = null;
  ui.orderTargetEnt = null;
  let okCount = 0, plots = 0;
  if (ui.wallStart && ui.wallEnd) {
    for (const t of S.wallLineTiles(ui.wallStart.x, ui.wallStart.y, ui.wallEnd.x, ui.wallEnd.y)) {
      const r = S.canPlaceWall(game, me, t.x, t.y);
      if (r.err) continue;
      okCount++;
      if (r.farm) plots++; // your own farmland — the wall takes the plot (#219)
    }
  }
  const ok = okCount > 0;
  // the plot cost rides on the label so it's read before committing
  const cost = plots ? ` · ${plots} plot${plots === 1 ? '' : 's'}` : '';
  orderPopup.innerHTML = `
    <button data-act="pwall" class="btn px-3 rounded-lg text-left ${ok ? 'bg-emerald-700 hover:bg-emerald-600 text-white' : 'bg-zinc-800 text-zinc-500 opacity-40'}" ${ok ? '' : 'disabled'}>✓ Build wall (${okCount})${cost}</button>
    <button data-act="pwallx" class="btn px-3 rounded-lg text-left bg-zinc-900 text-zinc-400 hover:bg-zinc-800">✕ Cancel</button>`;
  orderPopup.classList.remove('hidden');
  const w = orderPopup.offsetWidth, h = orderPopup.offsetHeight;
  const vw = window.innerWidth, vh = window.innerHeight;
  // anchor beside the line's END tile, kept clear of the tile itself
  let cx = screen ? screen.x : vw / 2, cy = screen ? screen.y : vh / 2;
  if (ui.wallEnd) {
    cx = (ui.wallEnd.x + 0.5 - view.cx) * view.scale + vw / 2;
    cy = (ui.wallEnd.y + 0.5 - view.cy) * view.scale + vh / 2;
  }
  const r = 1.4 * view.scale + 12;
  const clampX = (x) => Math.max(4, Math.min(vw - w - 4, x));
  const clampY = (y) => Math.max(4, Math.min(vh - h - 4, y));
  const fitsRight = cx + r + w + 4 <= vw;
  const fitsLeft = cx - r - w >= 4;
  let left, top;
  if (fitsRight || fitsLeft) {
    left = (fitsRight && (cx <= vw / 2 || !fitsLeft)) ? cx + r : cx - r - w;
    top = clampY(cy - h / 2);
  } else {
    left = clampX(cx - w / 2);
    top = cy - r - h >= 4 ? cy - r - h : clampY(cy + r);
  }
  orderPopup.style.left = left + 'px';
  orderPopup.style.top = top + 'px';
}

// Dispatch the confirmed wall line: rasterize start→end, drop invalid
// tiles (toasting the skipped count), and split the survivors into
// contiguous chunks among the selected blobs so crews build in parallel.
function confirmWall() {
  const start = ui.wallStart, end = ui.wallEnd;
  const blobs = selectedBlobs();
  ui.pending = null;
  ui.wallStart = null;
  ui.wallEnd = null;
  updateHint();
  if (!start || !end || !blobs.length) { renderPanel(true); return; }
  const tiles = S.wallLineTiles(start.x, start.y, end.x, end.y);
  const checked = tiles.map(t => ({ t, r: S.canPlaceWall(game, me, t.x, t.y) }));
  const valid = checked.filter(c => !c.r.err).map(c => c.t);
  const plots = checked.filter(c => !c.r.err && c.r.farm).length;
  const skipped = tiles.length - valid.length;
  if (!valid.length) { toast('🧱 No buildable tiles there'); renderPanel(true); return; }
  // deterministic founder ordering, like dispatchBuild (#130)
  const sorted = [...blobs].sort((a, b) =>
    dist(a.x, a.y, start.x + 0.5, start.y + 0.5) - dist(b.x, b.y, start.x + 0.5, start.y + 0.5)
    || S.total(b) - S.total(a) || a.id - b.id);
  const per = Math.ceil(valid.length / sorted.length);
  let ok = 0, err = null, at = 0;
  for (const b of sorted) {
    const chunk = valid.slice(at, at + per);
    at += per;
    if (!chunk.length) break;
    const r = doBuildWalls(b, chunk);
    if (r.err) err = r.err; else ok += r.queued;
  }
  if (ok) {
    pingOrder({ x: start.x + 0.5, y: start.y + 0.5 }, null);
    // plots is capped at the queued count so the toast never claims more
    // farmland than the order can actually take (#219)
    const lost = Math.min(plots, ok);
    toast(`🧱 Building ${ok} wall tile${ok === 1 ? '' : 's'}${lost ? ` — ${lost} plot${lost === 1 ? '' : 's'} ploughed under` : ''}${skipped ? ` — ${skipped} skipped` : ''}`);
  } else if (err) toast(err);
  renderPanel(true);
}

// Group build (#130): the selected blob nearest the site is the founder
// (carries the build order); every other selected blob marches to the
// site as an escort and merges into the waiting founder on arrival.
// Deterministic pick (distance, then size, then id) so PvP prediction
// and the server agree on which blob founds.
function dispatchBuild(blobs, x, y) {
  const sorted = [...blobs].sort((a, b) =>
    dist(a.x, a.y, x, y) - dist(b.x, b.y, x, y) || S.total(b) - S.total(a) || a.id - b.id);
  const founder = sorted[0];
  const r = doBuildAt(founder, x, y);
  if (r.err) return r;
  const cx = r.site.x + 1, cy = r.site.y + 1;
  for (const b of sorted.slice(1)) doMove(b, cx, cy);
  return r;
}

// Put every selected carrier on the same source→destination line (#133).
function dispatchRoutes(carriers, target, sourceId) {
  let ok = 0, err = null, escorting = 0;
  for (const c of carriers) {
    // count the escort BEFORE dispatch — a mixed group runs the line whole
    // (#239), so its non-hauling units are riding along as guards
    const guards = c.count.deploy + c.count.farm;
    const r = doRoute(c, target, sourceId);
    if (r.err) { err = r.err; continue; }
    ok++;
    escorting += guards;
  }
  if (ok) {
    // name the destination (#142) so a mis-tap is visible, not a mystery
    let dest = 'your army';
    if (target.kind === 'settlement') {
      const st = game.settlements.find(s => s.id === target.id);
      dest = (st && st.name) || 'settlement';
      if (st) pingRoute(st.x + 1, st.y + 1);
    } else if (target.kind === 'wall') {
      const w = game.walls.find(x => x.id === target.id);
      dest = 'wall garrison';
      if (w) pingRoute(w.x + 0.5, w.y + 0.5);
    } else {
      const tb = findBlob(target.id);
      if (tb) pingRoute(tb.x, tb.y);
    }
    // #239: name the escort so it's clear the fighters went along
    const escortNote = escorting > 0 ? ` — ${escorting} escorting` : '';
    toast((ok > 1 ? `🚚 ${ok} caravans on the supply line → ${dest}` : `🚚 Supply route established → ${dest}`) + escortNote);
  } else if (err) toast(err);
}

function confirmBuild() {
  const site = ui.buildSite;
  const blobs = selectedBlobs();
  ui.pending = null;
  ui.buildSite = null;
  updateHint();
  if (!site || !blobs.length) { renderPanel(true); return; }
  const r = dispatchBuild(blobs, site.x + 0.5, site.y + 0.5);
  if (r.err) toast(r.err);
  else {
    pingOrder({ x: site.x + 1, y: site.y + 1 }, null);
    toast('🏠 Founding party dispatched');
  }
  renderPanel(true);
}

orderPopup.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn || !game) return;
  if (game.tutorial && !TUT.allowsAct(btn.dataset)) { TUT.nudge(); return; }
  const act = btn.dataset.act;
  const world = ui.orderTarget;
  const targetEnt = ui.orderTargetEnt;
  hideOrderPopup();
  if (act === 'pbuild') { confirmBuild(); return; }
  if (act === 'pbuildx') { onCancel(); renderPanel(true); return; }
  if (act === 'pwall') { confirmWall(); return; }
  if (act === 'pwallx') { onCancel(); renderPanel(true); return; }
  if (act === 'pwallarm') {
    if (selectedBlobs().length) {
      ui.pending = 'wall';
      ui.wallStart = null;
      ui.wallEnd = null;
      updateHint();
    }
    return;
  }
  if (act === 'pclose') { ui.selected = null; renderPanel(true); return; }
  // Select/Deselect popup: commit the tapped blob as the selection
  if (act === 'pselect') {
    if (tapBlobId != null && findBlob(tapBlobId)) ui.selected = { kind: 'blob', id: tapBlobId };
    tapBlobId = null;
    renderPanel(true);
    return;
  }
  // garrison popup: switch the selection to the tapped settlement
  // ('pgarrison' falls through to the orderMove dispatch below, marching
  // the group to the settlement center — the garrison order)
  if (act === 'pselsett') {
    const gst = tapSettId != null && game.settlements.find(s => s.id === tapSettId && s.owner === me);
    if (gst) ui.selected = { kind: 'settlement', id: gst.id };
    tapSettId = null;
    renderPanel(true);
    return;
  }
  // unit-options popup actions (phone UI) — mirror the panel's cases
  if (act === 'pmovearm') { ui.pending = 'move'; updateHint(); return; }
  if (act === 'proutearm') { ui.pending = 'route'; ui.routeSrc = null; updateHint(); return; }
  if (act === 'pbuildarm') {
    if (selectedBlobs().length) { ui.pending = 'build'; ui.buildSite = null; updateHint(); }
    return;
  }
  if (act === 'ppillage') {
    for (const b of selectedBlobs()) doPillage(b, !b.pillaging);
    renderPanel(true);
    return;
  }
  if (act === 'prole') {
    let err = null, okCount = 0;
    for (const b of selectedBlobs()) {
      const res = doSetRole(b, btn.dataset.role);
      if (res.err) err = res.err; else okCount++;
    }
    if (err && !okCount) toast(err);
    renderPanel(true);
    return;
  }
  if (act === 'psplit') {
    // a hold-commit already split (and the browser still synthesizes a
    // click on the captured button) — eat exactly one
    if (splitHoldConsumed) { splitHoldConsumed = false; return; }
    const b = selectedBlobs()[0];
    if (b && S.total(b) >= 2) {
      const r = doSplit(b, Math.floor(S.total(b) / 2));
      if (r.err) toast(r.err);
    }
    renderPanel(true);
    return;
  }
  if (!world) return;
  const target = act === 'pattack' ? targetEnt : null;
  // a Move/Garrison onto an own wall or settlement snaps to that tile
  // (#222); an explicit Attack keeps the raw point and its target
  const garr = target ? null : ownGarrisonTargetAt(world);
  orderMove(selectedBlobs(), world, target, garr);
  renderPanel(true);
});

function resolvePending(world, pointerType, screen) {
  // build placement (#94): mouse dispatches on the click; touch/pen goes
  // two-step — the tap places (or moves) the snapped outline and the ✓
  // confirm popup commits it, so placement stays armed between taps.
  if (ui.pending === 'build') {
    const bblobs = selectedBlobs();
    if (!bblobs.length) { ui.pending = null; ui.buildSite = null; updateHint(); return; }
    if (pointerType === 'mouse') {
      ui.pending = null;
      ui.buildSite = null;
      updateHint();
      const r = dispatchBuild(bblobs, world.x, world.y);
      if (r.err) toast(r.err);
      else {
        pingOrder({ x: r.site ? r.site.x + 1 : world.x, y: r.site ? r.site.y + 1 : world.y }, null);
        toast('🏠 Founding party dispatched');
      }
      renderPanel(true);
      return;
    }
    const tx = Math.floor(world.x), ty = Math.floor(world.y);
    if (tx < 0 || ty < 0 || tx >= game.map.w || ty >= game.map.h) return; // off-map — keep the previous site
    const a = S.buildAnchorAt(game, tx, ty);
    ui.buildSite = a.err ? { x: tx, y: ty, ok: false } : { x: a.x, y: a.y, ok: true };
    showBuildConfirm(screen);
    updateHint();
    return;
  }
  // wall placement (#187): a two-click state machine, identical on mouse
  // and touch — first click sets the line's start, second sets its end
  // (same tile ⇒ single wall) and shows the ✓/✕ confirm; further clicks
  // move the end so the line can be fine-tuned before committing.
  if (ui.pending === 'wall') {
    const wblobs = selectedBlobs();
    if (!wblobs.length) {
      ui.pending = null; ui.wallStart = null; ui.wallEnd = null;
      updateHint();
      return;
    }
    // tutorial: an accepted tap snaps to the step's suggested endpoint
    // tile, so the guided wall lands exactly on the marked tiles — a raw
    // floor of a ring-edge tap could drift a tile and skew the line
    const snap = TUT.snapTarget(world);
    const tx = snap ? snap.x : Math.floor(world.x);
    const ty = snap ? snap.y : Math.floor(world.y);
    if (tx < 0 || ty < 0 || tx >= game.map.w || ty >= game.map.h) return; // off-map — keep state
    if (!ui.wallStart) {
      ui.wallStart = { x: tx, y: ty };
    } else {
      ui.wallEnd = { x: tx, y: ty };
      showWallConfirm(screen);
    }
    updateHint();
    renderPanel(true);
    return;
  }
  const pending = ui.pending;
  ui.pending = null;
  updateHint();
  const blobs = selectedBlobs();
  if (pending === 'move') {
    if (!blobs.length) return;
    // tapping an enemy targets it; an own wall/settlement is a garrison
    // march that a neighbouring enemy can never steal (#201), aimed at
    // that entity's own tile rather than the tap point (#222). Same
    // enemy-first precedence and same "landed inside an enemy means attack
    // it" upgrade as the right-click dispatch (#243).
    const enemy = findEnemyTargetAt(world, tapHitR());
    const garr = garrisonTargetUnlessEnemy(world, enemy);
    orderMove(blobs, world, garr ? null : attackTargetFor(world, enemy), garr);
  } else if (pending === 'route') {
    // supply routes take two taps (#131): first the source settlement the
    // caravans load from, then the destination. Every selected blob holding
    // supply units joins the same line (#133) — a mixed one goes whole, its
    // fighters escorting the caravan (#239).
    const carriers = blobs.filter(b => S.total(b) > 0 && b.count.supply > 0);
    if (!carriers.length) {
      ui.routeSrc = null;
      toast('No supply units in this group');
      return;
    }
    const hitR = Math.max(1.5, 24 / view.scale);
    if (ui.routeSrc == null) {
      const src = S.settlementAt(game, world.x, world.y, Math.max(1.9, hitR));
      ui.pending = 'route'; // stay armed for the next tap either way
      if (src && src.owner === me && !src.building) {
        ui.routeSrc = src.id;
        pingRoute(src.x + 1, src.y + 1);
      } else {
        toast('Tap one of your settlements to load from');
      }
      updateHint();
      renderPanel(true);
      return;
    }
    const srcId = ui.routeSrc;
    ui.routeSrc = null;
    // settlement-first resolution (#142): a tap on/at a footprint always
    // targets the settlement — field hands carpeting the farms around it
    // can no longer steal the tap. Working farmers are never sensible
    // route targets, so they're excluded from the blob hit test too.
    let st = S.settlementAt(game, world.x, world.y, 1.9);
    if (st && st.owner !== me) st = null;
    // wall-garrison line (#187): a tap on an own finished wall tile
    // targets the wall — exact-tile, like the settlement-first rule
    let wl = null;
    if (!st) {
      const w2 = wallAtPoint(world);
      if (w2 && w2.owner === me && !w2.building) wl = w2;
    }
    let tgt = null;
    if (!st && !wl) {
      // filtered pick, not nearest-then-reject (#243): an enemy group standing
      // beside the army being supplied used to shadow it and lose the tap
      tgt = S.blobAt(game, world.x, world.y, hitR,
        (b) => b.owner === me && b.working == null && !carriers.some(c => c.id === b.id));
      if (!tgt) {
        st = S.settlementAt(game, world.x, world.y, Math.max(1.9, hitR));
        if (st && st.owner !== me) st = null;
      }
    }
    if (wl) {
      dispatchRoutes(carriers, { kind: 'wall', id: wl.id }, srcId);
    } else if (tgt) {
      dispatchRoutes(carriers, { kind: 'blob', id: tgt.id }, srcId);
    } else if (st && st.id === srcId) {
      toast('Route must lead away from its source');
    } else if (st) {
      dispatchRoutes(carriers, { kind: 'settlement', id: st.id }, srcId);
    } else {
      toast('Tap a friendly army, wall or settlement to supply');
    }
  } else if (pending === 'route-sett') {
    // settlement-to-settlement supply line (#108): source is the
    // settlement that armed the pending, target is the tapped entity
    const src = game.settlements.find(s2 => s2.id === ui.routeSrc && s2.owner === me && !s2.building);
    ui.routeSrc = null;
    if (!src) return;
    const hitR = Math.max(1.5, 24 / view.scale);
    const stT = S.settlementAt(game, world.x, world.y, Math.max(1.9, hitR));
    const wlT = wallAtPoint(world);
    if (stT && stT.owner === me && stT.id !== src.id && !stT.building) {
      const r = doSupplyRoute(src, { kind: 'settlement', id: stT.id });
      if (!r.err) pingRoute(stT.x + 1, stT.y + 1);
      toast(r.err ? r.err : '🚚 Supply route established');
    } else if (wlT && wlT.owner === me && !wlT.building) {
      // wall-garrison line (#187)
      const r = doSupplyRoute(src, { kind: 'wall', id: wlT.id });
      if (!r.err) pingRoute(wlT.x + 0.5, wlT.y + 0.5);
      toast(r.err ? r.err : '🚚 Supply route established');
    } else {
      const tgt = S.blobAt(game, world.x, world.y, hitR,
        (b) => b.owner === me && b.working == null);   // #243: never shadowed by an enemy
      if (tgt) {
        const r = doSupplyRoute(src, { kind: 'blob', id: tgt.id });
        if (!r.err) pingRoute(tgt.x, tgt.y);
        toast(r.err ? r.err : '🚚 Supply route established');
      } else {
        toast('Tap a friendly settlement, wall or army to supply');
      }
    }
  }
  renderPanel(true);
}

// Is the armed route selection a MIXED group (#239)? Drives the extra hint
// line telling the player the whole group is about to march out as an escort.
function routeArmedMixed() {
  const blobs = selectedBlobs();
  if (!blobs.length) return false;
  const tot = blobs.reduce((s, b) => s + S.total(b), 0);
  const sup = blobs.reduce((s, b) => s + b.count.supply, 0);
  return tot > 0 && sup > 0 && sup < tot;
}

function updateHint() {
  const el = $('hint');
  // the tutorial card owns the instruction slot for its whole session
  if (!ui.pending || (game && game.tutorial)) { el.classList.add('hidden'); return; }
  const text = ui.pending === 'move' ? 'Tap a destination — or an enemy to attack…'
    : ui.pending === 'wall'
      ? (ui.wallEnd ? 'Tap ✓ to build — or tap elsewhere to move the end'
        : ui.wallStart ? 'Tap where the wall ends…' : 'Tap where the wall starts…')
    : ui.pending === 'build'
      ? (ui.buildSite ? 'Tap ✓ to found here — or tap elsewhere to move the site'
        : 'Tap where to found the settlement…')
      : ui.pending === 'route-sett'
        ? `${isMobile() ? 'Tap' : 'Tap or right-click'} the destination settlement, wall or army to supply…`
        : ui.routeSrc != null
          // #239: say it out loud when the selection is mixed, so it's clear
          // the fighters are marching out with the caravan
          ? `${isMobile() ? 'Tap' : 'Tap or right-click'} the destination — a friendly settlement, wall or army…${routeArmedMixed() ? ' the whole group will escort the caravan' : ''}`
          : `${isMobile() ? 'Tap' : 'Tap or right-click'} the source settlement to load from…`;
  $('hint-text').textContent = text;
  // #234: touch has no hover, so the placement score rides the hint bar —
  // same S.previewScore numbers the desktop card shows, appended once a
  // site is actually pinned (before that there's nothing to score).
  const extra = $('hint-score');
  if (extra) {
    const sc = buildSiteScore();
    if (sc) {
      extra.textContent = `${sc.plots} plots · ${FERT_TIERS[fertTier(sc.meanFert)]}`
        + ` · 🌾 ${sc.nowPerMin.toFixed(1)}→${sc.maxPerMin.toFixed(1)}/min`;
      extra.classList.remove('hidden');
    } else {
      extra.classList.add('hidden');
    }
  }
  el.classList.remove('hidden');
}

// The score for the currently pinned build site, or null when there's no
// legal site to score (nothing pending, no site yet, or it doesn't fit).
function buildSiteScore() {
  if (!game || ui.pending !== 'build' || !ui.buildSite) return null;
  const a = S.buildAnchorAt(game, ui.buildSite.x, ui.buildSite.y);
  if (a.err) return null;
  return S.previewScoreCached(game, a.x, a.y, game.me || 0);
}

function toast(msg) {
  // the toast element lives in the (hidden) game UI — on the menu screen,
  // surface notices through the menu's message line instead
  if (!game) { showMenuError(msg); return; }
  const el = $('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2600);
}

// ---------------------------------------------------------------- panel

const panel = $('panel');
panel.addEventListener('pointerdown', () => { panelHeld = true; });
window.addEventListener('pointerup', () => {
  panelHeld = false;
  // Don't let a slider keep focus after the drag ends — a focused range
  // input would make arrow keys nudge its value instead of panning.
  const ae = document.activeElement;
  if (ae && ae.tagName === 'INPUT' && ae.type === 'range') ae.blur();
});

panel.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn || !game) return;
  if (game.tutorial && !TUT.allowsAct(btn.dataset)) { TUT.nudge(); return; }
  hideOrderPopup();
  const act = btn.dataset.act;
  const blobs = selectedBlobs();
  const st = selectedSettlement();
  let r = null;
  switch (act) {
    case 'role': {
      const role = btn.dataset.role;
      let err = null, okCount = 0;
      for (const b of blobs) {
        const res = doSetRole(b, role);
        if (res.err) err = res.err; else okCount++;
      }
      if (err && !okCount) toast(err);
      break;
    }
    case 'move': ui.pending = 'move'; updateHint(); break;
    case 'route': ui.pending = 'route'; ui.routeSrc = null; updateHint(); break;
    case 'split': {
      const b = blobs[0];
      if (b) {
        const n = S.total(b);
        r = doSplit(b, Math.max(1, Math.min(n - 1, ui.splitCount || Math.floor(n / 2))));
        if (r.err) toast(r.err);
      }
      break;
    }
    case 'build': {
      // arms map placement (#94): pick the site by tap (touch confirms
      // with ✓) or hover+click (mouse) — see resolvePending
      if (blobs[0]) { ui.pending = 'build'; ui.buildSite = null; updateHint(); }
      break;
    }
    case 'wall': {
      // arms two-click wall placement (#187) — see resolvePending
      if (blobs.length) {
        ui.pending = 'wall';
        ui.wallStart = null;
        ui.wallEnd = null;
        updateHint();
      }
      break;
    }
    case 'fieldwall': {
      const w = ui.selected && ui.selected.kind === 'wall'
        ? game.walls.find(x => x.id === ui.selected.id) : null;
      if (w) {
        r = doFieldWall(w);
        if (r.err) toast(r.err);
        else ui.selected = { kind: 'blob', id: r.blob.id };
      }
      break;
    }
    case 'wrole': {
      // wall-garrison role switch (#187) — mirrors the settlement 'grole'
      const w = ui.selected && ui.selected.kind === 'wall'
        ? game.walls.find(x => x.id === ui.selected.id) : null;
      if (w) {
        r = doWallRole(w, btn.dataset.role);
        if (r.err) toast(r.err);
      }
      break;
    }
    case 'pillage': {
      for (const b of blobs) doPillage(b, !b.pillaging);
      break;
    }
    case 'mode': if (st) { doSetMode(st, btn.dataset.mode); ui.modeOpen = false; } break;
    // compact phone panel (#189): the production mode row folds behind a
    // single dropdown button that doubles as the training progress bar
    case 'modemenu': ui.modeOpen = !ui.modeOpen; break;
    case 'settroute': {
      // settlement-to-settlement supply line (#108): arm target pick
      if (st && st.garrison.supply > 0) {
        ui.pending = 'route-sett';
        ui.routeSrc = st.id;
        updateHint();
      }
      break;
    }
    case 'siegerun': {
      // run-the-siege toggle (#181): from a besieged settlement it flips
      // every inbound route at once; from a selected carrier, its route
      if (st) {
        const inbound = game.routes.filter(r2 => r2.owner === me && r2.targetKind === 'settlement' && r2.targetId === st.id);
        const on = !(inbound.length > 0 && inbound.every(r2 => r2.runSiege));
        for (const r2 of inbound) doSiegeRun(r2.id, on);
        toast(on ? '⚔️ Caravans will run the siege' : '🚧 Caravans will wait out the siege');
      } else if (blobs.length === 1 && blobs[0].order && blobs[0].order.type === 'route') {
        const r2 = SUP.findRoute(game, blobs[0].order.routeId);
        if (r2 && r2.owner === me) {
          const on = !r2.runSiege;
          doSiegeRun(r2.id, on);
          toast(on ? '⚔️ Caravan will run the siege' : '🚧 Caravan will wait out the siege');
        }
      }
      break;
    }
    case 'field': {
      if (st) {
        r = doFieldGarrison(st);
        if (r.err) toast(r.err);
        else ui.selected = { kind: 'blob', id: r.blob.id };
      }
      break;
    }
    case 'grole': if (st) { r = doGarrisonRole(st, btn.dataset.role); if (r.err) toast(r.err); } break;
    // compact phone panel (#189): fold the food breakdown / pick the role
    // the unified field slider acts on
    case 'flowdetail': ui.flowOpen = !ui.flowOpen; break;
    case 'fieldrole': ui.fieldRole = btn.dataset.role; break;
    case 'fieldgroup': {
      // surplus farmers (#171): field the garrisoned farmers as one
      // grouped blob at the gate and hand it to the player, selected
      if (st) {
        r = doFieldFarmerGroup(st);
        if (r.err) toast(r.err);
        else {
          ui.selected = { kind: 'blob', id: r.blob.id };
          toast(`🌱 ${r.fielded} farmer${r.fielded === 1 ? '' : 's'} fielded at the gate — pick their destination`);
        }
      }
      break;
    }
    case 'fieldn': {
      // a hold-commit already fielded — eat exactly one synthesized click
      if (fieldHoldConsumed) { fieldHoldConsumed = false; break; }
      if (st) {
        const role = btn.dataset.role;
        const n = Math.max(1, Math.min(st.garrison[role], ui.fieldCounts[role] || 1));
        r = doFieldRole(st, role, n);
        if (r.err) toast(r.err);
      }
      break;
    }
    case 'recall': {
      // a hold-commit already recalled (and the browser still synthesizes
      // a click on the captured button) — eat exactly one
      if (recallHoldConsumed) { recallHoldConsumed = false; break; }
      if (st) recallFarmers(st, ui.recallCount || 0);
      break;
    }
  }
  renderPanel(true);
});

panel.addEventListener('input', (e) => {
  if (e.target.id === 'split-count') {
    ui.splitCount = Math.max(1, e.target.value | 0);
    const lbl = $('split-label');
    if (lbl) lbl.textContent = `${ui.splitCount} / ${(e.target.max | 0) + 1}`;
  } else if (e.target.id === 'recall-count') {
    ui.recallCount = Math.max(1, e.target.value | 0);
    const btn = $('recall-btn');
    if (btn) btn.textContent = `Recall ${ui.recallCount}`;
  } else if (e.target.id && e.target.id.startsWith('field-count-')) {
    const role = e.target.id.slice('field-count-'.length);
    const v = Math.max(1, e.target.value | 0);
    ui.fieldCounts[role] = v;
    const btn = $(`field-btn-${role}`);
    if (btn) btn.textContent = `Field ${v}`;
  }
});

// Ticks → seconds of real time at the current display speed (the sim runs
// at speed × 0.5 of native ticks). Shared by every countdown a panel
// shows, so they can't drift apart.
function ticksToSeconds(ticks) {
  return Math.max(0, ticks) / (10 * Math.max(0.25, speed * 0.5));
}

// Seconds until a pending arm-up (#108) completes.
function convertEta(convert) {
  return Math.max(1, Math.ceil(ticksToSeconds(convert.done - game.tick)));
}

// Coarse duration for the wall rations runway (#200). Quantised — nearest
// 5 s under 90 s, nearest half-minute above — because renderPanel diffs
// against lastPanelHTML and an exact value would rewrite the panel every
// frame (blowing away in-panel focus / hold state).
function fmtRunway(ticks) {
  if (!isFinite(ticks)) return null;
  const secs = ticksToSeconds(ticks);
  if (secs < 90) return `~${Math.max(0, Math.round(secs / 5) * 5)}s`;
  const mins = Math.round(secs / 30) / 2;
  return `~${mins % 1 === 0 ? mins : mins.toFixed(1)}m`;
}

function roleBtn(role, label, active, disabled) {
  return `<button data-act="role" data-role="${role}" ${disabled ? 'disabled' : ''}
    class="btn-sm flex-1 px-2 rounded ${active ? 'bg-violet-600 text-white' : 'bg-zinc-800 text-zinc-300'} ${disabled ? 'opacity-40' : 'hover:bg-violet-700'}">${label}</button>`;
}

function setPanelHTML(html) {
  if (html === lastPanelHTML) return;
  lastPanelHTML = html;
  panel.innerHTML = html;
}

// Strip along the bottom of the screen for the current blob selection.
// Single blob: one chip per unit (role icon + hp bar) in damage order —
// the leftmost unit is the next to take damage. Multiple blobs: the
// selection grouped by role — one chip per role present with its total
// count and an aggregate health bar (chips are display-only).
const STRIP_MAX = 100;
function updateUnitStrip() {
  const strip = $('unit-strip');
  let blobs = [];
  if (game && !game.result && ui.selected && (ui.selected.kind === 'blob' || ui.selected.kind === 'multi')) {
    blobs = selectedBlobs();
  }
  if (!blobs.length || !blobs.some(b => b.units && b.units.length)) {
    strip.classList.add('hidden');
    lastStripHTML = '';
    return;
  }
  strip.classList.remove('hidden');
  // vertical placement (above the panel sheet / replay bar) → layoutBottomStack
  const chips = [];
  if (blobs.length === 1) {
    const b = blobs[0];
    const n = Math.min(b.units.length, STRIP_MAX);
    for (let i = 0; i < n; i++) {
      const u = b.units[i];
      const pct = Math.max(0, Math.min(1, u.hp / S.unitMaxHP(u.role)));
      const col = pct >= 0.75 ? 'bg-emerald-500' : pct >= 0.4 ? 'bg-amber-500' : 'bg-red-500';
      const icon = u.role === 'deploy' ? '⚔️' : u.role === 'supply' ? '🚚' : '🌱';
      chips.push(`<div class="shrink-0 w-7 flex flex-col items-center gap-0.5 py-0.5">
        <span class="text-sm leading-none">${icon}</span>
        <div class="w-6 h-1 rounded bg-zinc-800 overflow-hidden"><div class="h-full ${col}" style="width:${Math.round(pct * 100)}%"></div></div>
      </div>`);
    }
    if (b.units.length > STRIP_MAX) {
      chips.push(`<div class="shrink-0 flex items-center text-xs text-zinc-400 px-1">+${b.units.length - STRIP_MAX} more</div>`);
    }
  } else {
    // multi-select: aggregate hp / maxHP per role across every unit
    const agg = { deploy: { n: 0, hp: 0, max: 0 }, supply: { n: 0, hp: 0, max: 0 }, farm: { n: 0, hp: 0, max: 0 } };
    let tot = 0;
    for (const b of blobs) {
      for (const u of b.units) {
        const a = agg[u.role] || (agg[u.role] = { n: 0, hp: 0, max: 0 });
        a.n++; a.hp += u.hp; a.max += S.unitMaxHP(u.role);
        tot++;
      }
    }
    chips.push(`<div class="shrink-0 flex items-center text-xs text-zinc-400 px-1 whitespace-nowrap">${blobs.length} blobs · ${tot} unit${tot === 1 ? '' : 's'}</div>`);
    for (const role of ['deploy', 'supply', 'farm']) {
      const a = agg[role];
      if (!a.n) continue;
      const pct = Math.max(0, Math.min(1, a.hp / Math.max(1, a.max)));
      const col = pct >= 0.75 ? 'bg-emerald-500' : pct >= 0.4 ? 'bg-amber-500' : 'bg-red-500';
      const icon = role === 'deploy' ? '⚔️' : role === 'supply' ? '🚚' : '🌱';
      chips.push(`<div class="shrink-0 flex flex-col items-center gap-0.5 px-2 py-0.5">
        <span class="text-sm leading-none whitespace-nowrap">${icon} <b class="text-xs align-middle">${a.n}</b></span>
        <div class="w-12 h-1 rounded bg-zinc-800 overflow-hidden"><div class="h-full ${col}" style="width:${Math.round(pct * 100)}%"></div></div>
      </div>`);
    }
  }
  const html = chips.join('');
  if (html !== lastStripHTML) {
    lastStripHTML = html;
    strip.innerHTML = html;
  }
}

function renderPanel(force) {
  renderPanelInner(force);
  updateUnitStrip(); // after the panel, so the strip can sit on its top edge
  updateModeToggle(); // after the strip, so the toggle can sit above both
  layoutBottomStack(); // last: every bottom offset in one place (#237)
}

function renderPanelInner(force) {
  if (!game) { panel.classList.add('hidden'); lastPanelHTML = ''; return; }
  if (!force && panelHeld) return;

  // read-only inspection cards
  if (ui.selected && ui.selected.kind === 'enemy-blob') {
    const eb = game.blobs.find(b => b.id === ui.selected.id && !b.dead);
    if (!eb || !S.isVisible(game, eb.x, eb.y)) {
      ui.selected = null; panel.classList.add('hidden'); lastPanelHTML = ''; return;
    }
    panel.classList.remove('hidden');
    const tot = S.total(eb);
    const c = eb.count;
    const hpPct = Math.round(100 * S.blobHealth(eb));
    const hpColor = hpPct >= 75 ? 'text-emerald-400' : hpPct >= 40 ? 'text-amber-400' : 'text-red-400';
    setPanelHTML(`
      <div class="flex items-center justify-between mb-1">
        <span class="font-semibold text-red-300">${eb.working != null ? '🌱 Enemy farmer' : '👥 Enemy blob'} — ${tot} unit${tot === 1 ? '' : 's'}</span>
        <span class="text-xs ${hpColor}">❤️ ${hpPct}%</span>
      </div>
      <div class="h-2 rounded bg-zinc-800 overflow-hidden mb-2"><div class="h-full bg-red-500" style="width:${hpPct}%"></div></div>
      <div class="text-xs text-zinc-400">⚔️ ${c.deploy} deploy · 🚚 ${c.supply} supply · 🌱 ${c.farm} farmer${eb.order && eb.order.type === 'route' ? ` · <span class="text-sky-300">on supply route · 🌾 ${Math.round(eb.order.cargo || 0)}</span>` : ''}${eb.pillaging ? ' · <span class="text-orange-400">pillaging</span>' : ''}${eb.working != null ? ' · working the fields' : ''}</div>`);
    return;
  }
  if (ui.selected && ui.selected.kind === 'enemy-settlement') {
    const est = game.settlements.find(s => s.id === ui.selected.id);
    if (!est) { ui.selected = null; panel.classList.add('hidden'); lastPanelHTML = ''; return; }
    panel.classList.remove('hidden');
    if (S.settVisible(game, est)) {
      const pct = Math.max(0, Math.min(100, Math.round(100 * est.hp / S.C.SETT_HP)));
      const barCol = est.building ? 'bg-amber-500' : pct >= 75 ? 'bg-emerald-500' : pct >= 40 ? 'bg-amber-500' : 'bg-red-500';
      setPanelHTML(`
        <div class="flex items-center justify-between mb-1">
          <span class="font-semibold text-red-300">${est.building ? '🔨' : '🏠'} ${est.name || 'Enemy settlement'}${est.name ? ` <span class="text-zinc-500 font-normal">(enemy${est.building ? ' construction site' : ''})</span>` : ''}</span>
          <span class="text-xs ${!est.building && est.hp < S.C.SETT_HP ? 'text-red-400' : 'text-zinc-400'}">HP ${Math.ceil(est.hp)}/${S.C.SETT_HP}</span>
        </div>
        <div class="h-2 rounded bg-zinc-800 overflow-hidden mb-2"><div class="h-full ${barCol}" style="width:${pct}%"></div></div>
        <div class="text-xs text-zinc-400">${est.building ? 'Under construction — raze it before it finishes.' : est.hp >= S.C.SETT_HP ? 'Walls intact.' : est.hp > S.C.SETT_HP / 2 ? 'Damaged.' : 'Heavily damaged!'} Tap it with deploy units selected to lay siege.</div>`);
    } else {
      setPanelHTML(`
        <div class="font-semibold text-red-300 mb-1">🏠 ${est.name || 'Enemy settlement'} <span class="text-zinc-500 font-normal">(last seen)</span></div>
        <div class="text-xs text-zinc-400">Hidden in the fog — condition unknown. Send a scout to see its health.</div>`);
    }
    return;
  }
  // walls (#187): own wall = control card; enemy wall = inspection card
  if (ui.selected && (ui.selected.kind === 'wall' || ui.selected.kind === 'enemy-wall')) {
    const w = game.walls.find(x => x.id === ui.selected.id);
    if (!w || (ui.selected.kind === 'enemy-wall' && !wallKnown(w))) {
      ui.selected = null; panel.classList.add('hidden'); lastPanelHTML = ''; return;
    }
    panel.classList.remove('hidden');
    const gTot = S.wallGarrisonTotal(w);
    const pct = Math.max(0, Math.min(100, Math.round(100 * w.hp / S.C.WALL_HP)));
    const barCol = w.building ? 'bg-amber-500' : pct >= 75 ? 'bg-emerald-500' : pct >= 40 ? 'bg-amber-500' : 'bg-red-500';
    const prot = S.wallProtected(game, w);
    if (w.owner === me) {
      // wall food (#200): TWO pools, each named for what it is. The
      // garrison's own hunger takes the four-tier fed word every army
      // uses (it drives the same fedMult now); the supplies stash it
      // refeeds from gets the wheat number + bar.
      const starving = S.wallStarving(w);
      const fedM = S.wallFedMeter(w);
      const fedCol = fedM >= 0.75 ? 'text-emerald-400' : fedM >= 0.5 ? 'text-lime-400' : fedM >= 0.25 ? 'text-amber-400' : 'text-red-400';
      const stockFrac = S.wallStockFrac(w);
      const runway = fmtRunway(S.wallRationTicks(w));
      const feeder = S.wallFeeder(game, w);
      const inW = game.routes.filter(r2 => r2.owner === me && r2.targetKind === 'wall' && r2.targetId === w.id);
      // compact phone sheet (#211), mirroring the settlement panel: the
      // readouts and every control stay, the long explainers shrink to one
      // short line each. The panel is a max-h-[60%] bottom sheet on phones,
      // so seven lines of prose pushed the buttons below the fold.
      // NOTE: the trimmed wording deliberately still CONTAINS every
      // substring dapp.json asserts ("refills them from these supplies",
      // "while the wall is under attack", "Supplies", "mouths", the fed
      // words) — the test harness viewport is unspecified, so both
      // templates must satisfy the assertions.
      if (isMobile()) {
        setPanelHTML(`
          <div class="flex items-center justify-between mb-1">
            <span class="font-semibold">🧱 Wall${w.building ? ' — building' : ''}</span>
            <span class="text-xs ${!w.building && w.hp < S.C.WALL_HP ? 'text-red-400' : 'text-zinc-500'}">HP ${Math.ceil(w.hp)}/${S.C.WALL_HP}</span>
          </div>
          <div class="h-1 rounded bg-zinc-800 overflow-hidden mb-1"><div class="h-full ${barCol}" style="width:${pct}%"></div></div>
          ${w.building
            ? '<div class="text-xs text-zinc-400">Builders raise it beside the tile — more hands build faster.</div>'
            : `<div class="text-xs mb-1 ${prot ? 'text-emerald-400' : 'text-amber-400'}">${prot ? '🛡️ Protected — a garrison holds within 1 tile' : '⚠️ Unprotected — falls fast under attack'}</div>
          <div class="text-xs text-zinc-500 mb-1">Garrison ${gTot}/${S.C.WALL_GARRISON_CAP}${gTot > 0
            ? ` · ⚔️${w.garrison.deploy} 🚚${w.garrison.supply} 🌱${w.garrison.farm} · <span class="${fedCol}">${S.fedLabel(fedM)}</span>` : ''}</div>
          <div class="text-xs text-zinc-400">Supplies <b class="text-amber-300">🌾 ${Math.floor(w.stock || 0)}</b> / ${S.C.WALL_FOOD_CAP}${gTot > 0
            ? `${runway && !starving ? ` · ${runway}` : ''} · ${gTot} mouth${gTot === 1 ? '' : 's'}` : ' · no mouths to feed'}</div>
          <div class="h-0.5 rounded bg-zinc-800 overflow-hidden mb-1"><div class="h-full bg-amber-300" style="width:${Math.round(stockFrac * 100)}%"></div></div>
          ${starving ? '<div class="text-xs text-red-400 mb-1">💀 Starving — the garrison is dying and fights at half strength.</div>' : ''}
          ${inW.length
            ? '<div class="text-xs text-sky-300 mb-1">🚚 Supplied by ' + (inW.length === 1 ? 'a supply route' : inW.length + ' supply routes') + '</div>'
            : feeder
              ? `<div class="text-xs text-sky-300 mb-1">🏠 Topped up from ${feeder.name || 'a settlement'}'s stores</div>`
              : gTot > 0 ? '<div class="text-xs text-amber-400 mb-1">⚠️ No supply — the stash only drains</div>' : ''}
          ${gTot > 0
            ? `<div class="flex gap-1 mb-1">
                ${roleBtn('deploy', '⚔️', false, false)}${roleBtn('supply', '🚚', false, false)}${roleBtn('farm', '🌱', false, false)}
              </div>
              ${w.convert ? `<div class="text-xs text-amber-400 mb-1">⚔️ Garrison arming… ready in ~${convertEta(w.convert)}s (fielding cancels)</div>` : ''}
              <button data-act="fieldwall" class="btn w-full rounded bg-zinc-700 hover:bg-zinc-600 mt-1">Field garrison (${gTot})</button>
              <div class="text-xs text-zinc-600 mt-1">The garrison keeps its own rations and refills them from these supplies.</div>
              <div class="text-xs text-zinc-600 mt-1">Reinforcements march in even while the wall is under attack (max ${S.C.WALL_GARRISON_CAP}).</div>`.replaceAll('data-act="role"', 'data-act="wrole"')
            : '<div class="text-xs text-zinc-600">No garrison — march units onto the tile (max ' + S.C.WALL_GARRISON_CAP + '), even while the wall is under attack.</div>'}`}`);
        return;
      }
      setPanelHTML(`
        <div class="flex items-center justify-between mb-1">
          <span class="font-semibold">🧱 Wall${w.building ? ' — under construction' : ''}</span>
          <span class="text-xs ${!w.building && w.hp < S.C.WALL_HP ? 'text-red-400' : 'text-zinc-500'}">HP ${Math.ceil(w.hp)}/${S.C.WALL_HP}</span>
        </div>
        <div class="h-2 rounded bg-zinc-800 overflow-hidden mb-2"><div class="h-full ${barCol}" style="width:${pct}%"></div></div>
        ${w.building
          ? '<div class="text-xs text-zinc-400">Builders raise it while standing beside the tile — more hands build faster. It can be attacked the whole time.</div>'
          : `<div class="text-xs mb-1 ${prot ? 'text-emerald-400' : 'text-amber-400'}">${prot ? '🛡️ Protected — a garrison holds within 1 tile' : '⚠️ Unprotected — falls fast under attack'}</div>
        <div class="text-xs text-zinc-500 mb-1">Garrison ${gTot}/${S.C.WALL_GARRISON_CAP}${gTot > 0
          ? ` · ⚔️${w.garrison.deploy} 🚚${w.garrison.supply} 🌱${w.garrison.farm} · <span class="${fedCol}">${S.fedLabel(fedM)}</span>` : ''}</div>
        <div class="text-xs text-zinc-400">Supplies <b class="text-amber-300">🌾 ${Math.floor(w.stock || 0)}</b> / ${S.C.WALL_FOOD_CAP}${gTot > 0
          ? `${runway && !starving ? ` · ${runway} of food` : ''} · ${gTot} mouth${gTot === 1 ? '' : 's'}` : ' · no mouths to feed'}</div>
        <div class="h-0.5 rounded bg-zinc-800 overflow-hidden mb-1"><div class="h-full bg-amber-300" style="width:${Math.round(stockFrac * 100)}%"></div></div>
        ${starving ? '<div class="text-xs text-red-400 mb-1">💀 Starving — rations and supplies are empty; the garrison is dying and fights at half strength.</div>' : ''}
        ${gTot > 0 ? '<div class="text-xs text-zinc-500 mb-1">The garrison keeps its own rations and refills them from these supplies automatically.</div>' : ''}
        ${inW.length
          ? '<div class="text-xs text-sky-300 mb-1">🚚 Supplied by ' + (inW.length === 1 ? 'a supply route' : inW.length + ' supply routes') + '</div>'
          : feeder
            ? `<div class="text-xs text-sky-300 mb-1">🏠 Topped up from ${feeder.name || 'a settlement'}'s stores</div>`
            : gTot > 0 ? '<div class="text-xs text-amber-400 mb-1">⚠️ No supply — the stash only drains</div>' : ''}
        ${gTot > 0
          ? `<div class="flex gap-1 mb-1">
              ${roleBtn('deploy', '⚔️', false, false)}${roleBtn('supply', '🚚', false, false)}${roleBtn('farm', '🌱', false, false)}
            </div>
            ${w.convert ? `<div class="text-xs text-amber-400 mb-1">⚔️ Garrison arming… ready in ~${convertEta(w.convert)}s (fielding cancels)</div>` : ''}
            <button data-act="fieldwall" class="btn w-full rounded bg-zinc-700 hover:bg-zinc-600 mt-1">Field garrison (${gTot})</button>
            <div class="text-xs text-zinc-600 mt-1">Fielding marches them out with their rations, topping up from the supplies; the rest stays on the wall.</div>
            <div class="text-xs text-zinc-600 mt-1">Reinforcements can march in even while the wall is under attack, up to ${S.C.WALL_GARRISON_CAP} units per tile.</div>`.replaceAll('data-act="role"', 'data-act="wrole"')
          : '<div class="text-xs text-zinc-600">No units garrisoned — move a blob onto the wall (up to ' + S.C.WALL_GARRISON_CAP + '), which works even while the wall is under attack. A garrisoned wall attacks enemies within 1 tile, and its units refeed from these supplies; a route keeps them stocked.</div>'}`}`);
    } else {
      const vis = S.isVisible(game, w.x + 0.5, w.y + 0.5);
      if (vis) {
        setPanelHTML(`
          <div class="flex items-center justify-between mb-1">
            <span class="font-semibold text-red-300">🧱 Enemy wall${w.building ? ' <span class="text-zinc-500 font-normal">(under construction)</span>' : ''}</span>
            <span class="text-xs ${!w.building && w.hp < S.C.WALL_HP ? 'text-red-400' : 'text-zinc-400'}">HP ${Math.ceil(w.hp)}/${S.C.WALL_HP}</span>
          </div>
          <div class="h-2 rounded bg-zinc-800 overflow-hidden mb-2"><div class="h-full ${w.building ? 'bg-amber-500' : 'bg-red-500'}" style="width:${pct}%"></div></div>
          <div class="text-xs text-zinc-400">${prot ? 'Manned or covered by a nearby garrison — it will hold for a while.' : 'Unprotected — a determined attack breaks through in seconds.'} Order deploy units onto it to attack.</div>`);
      } else {
        setPanelHTML(`
          <div class="font-semibold text-red-300 mb-1">🧱 Enemy wall <span class="text-zinc-500 font-normal">(last seen)</span></div>
          <div class="text-xs text-zinc-400">Hidden in the fog — condition unknown.</div>`);
      }
    }
    return;
  }
  if (ui.selected && ui.selected.kind === 'tile') {
    const i = ui.selected.i;
    panel.classList.remove('hidden');
    // fog secrecy (#182): an enemy settlement's plaza/farmland only reads
    // as built/tilled once the settlement is discovered (or the tile is
    // currently visible) — otherwise the inspector describes plain land
    const knownMap = game.pvp ? game.knowns[me] : game.known;
    const tileSeen = (sid) => {
      const s2 = game.settlements.find(x => x.id === sid);
      return !s2 || s2.owner === me || knownMap[s2.id] != null || game.fog[i] === 2;
    };
    if (game.map.mountain[i]) {
      setPanelHTML(`
        <div class="font-semibold mb-1">⛰️ Mountain</div>
        <div class="text-xs text-zinc-400">Impassable terrain. Nothing grows here.</div>`);
    } else if (game.settAt[i] && tileSeen(game.settAt[i])) {
      const so = game.settlements.find(s => s.id === game.settAt[i]);
      const mine2 = so && so.owner === me;
      setPanelHTML(`
        <div class="font-semibold mb-1 ${mine2 ? 'text-violet-300' : 'text-red-300'}">🏠 Settlement grounds</div>
        <div class="text-xs text-zinc-400">Built over — not farmland. Part of ${mine2 ? 'your settlement' : 'an enemy settlement'}${so && so.name ? `, <b>${so.name}</b>` : ''}.</div>`);
    } else {
      const f = game.map.fert[i], o = game.map.orig[i];
      const tier = fertTier(f), otier = fertTier(o);
      const label = FERT_TIERS[tier];
      const tb = game.tilledBy[i] && tileSeen(game.tilledBy[i]) ? game.settlements.find(s => s.id === game.tilledBy[i]) : null;
      // field hands standing here (#224): the tightened blob pick means a
      // tap on a worked plot now reaches the tile instead of the dot, so
      // say what's on it — otherwise reading fertility under a farmer
      // looks like the tap simply missed the farmer
      const tw = game.map.w;
      const hands = game.blobs.filter(b => !b.dead && b.working != null
        && Math.floor(b.y) * tw + Math.floor(b.x) === i
        && (b.owner === me || S.isVisible(game, b.x, b.y)));
      const mineHands = hands.filter(b => b.owner === me).length;
      setPanelHTML(`
        <div class="flex items-center justify-between mb-1">
          <span class="font-semibold">🟩 ${label} land</span>
          <span class="text-xs text-zinc-400">Fertility <b class="text-emerald-300">tier ${tier}/4</b>${tier < otier ? ` <span class="text-zinc-500">was ${otier}/4</span>` : ''}</span>
        </div>
        <div class="h-2 rounded bg-zinc-800 overflow-hidden mb-2"><div class="h-full bg-emerald-500" style="width:${tier * 25}%"></div></div>
        ${tb ? `<div class="text-xs ${tb.owner === me ? 'text-amber-300' : 'text-red-400'} mb-1">🌾 ${tb.owner === me ? 'Farmland of your settlement' : 'Enemy farmland'}</div>` : ''}
        ${hands.length ? `<div class="text-xs ${mineHands === hands.length ? 'text-emerald-300' : 'text-red-400'} mb-1">🌱 ${hands.length} ${mineHands === hands.length ? '' : 'enemy '}field hand${hands.length === 1 ? '' : 's'} working here</div>` : ''}
        ${game.pillaged.has(i) ? `<div class="text-xs text-orange-400">🔥 Scorched — ${S.workedPlots(game).has(i) ? 'a farmer is restoring it fast' : 'recovers slowly; a farmer working it restores it much faster'}</div>` : ''}`);
    }
    return;
  }

  const blobs = selectedBlobs();
  const st = selectedSettlement();
  if (!blobs.length && !st) {
    // selection died out
    if (ui.selected) ui.selected = null;
    panel.classList.add('hidden');
    lastPanelHTML = '';
    return;
  }
  panel.classList.remove('hidden');

  if (st && st.building) {
    // construction site (#95): progress only — no controls until complete
    const pct = Math.max(0, Math.min(100, Math.round(100 * st.hp / S.C.SETT_HP)));
    setPanelHTML(`
      <div class="flex items-center justify-between mb-1">
        <span class="font-semibold">🔨 ${st.name ? st.name + ' — under construction' : 'Settlement under construction'}</span>
        <span class="text-xs text-amber-300">${pct}%</span>
      </div>
      <div class="h-2 rounded bg-zinc-800 overflow-hidden mb-2"><div class="h-full bg-amber-500" style="width:${pct}%"></div></div>
      <div class="text-xs text-zinc-400">The founding party is building — no production or training until complete, and it can be attacked the whole time.</div>`);
    return;
  }

  if (st) {
    // compact phone layout (#189): the food breakdown starts collapsed on
    // each newly selected settlement
    if (ui.flowFor !== st.id) { ui.flowFor = st.id; ui.flowOpen = false; ui.modeOpen = false; }
    const mob = isMobile();
    const g = st.garrison;
    const gTot = S.garrisonTotal(st);
    const wc = S.workingCount(game, st);
    const y = S.farmYield(game, st);
    const pct = Math.round(100 * st.trainAcc / S.C.TRAIN_COST);
    const gated = S.trainGated(st);
    // food/s rates: gross farmland income and per-component breakdown
    // (rounded before signing so a hair-negative sum doesn't show "-0.0")
    const fmtRate = (v) => { const r = Math.round(v * 10) / 10; return (r >= 0 ? '+' : '') + r.toFixed(1); };
    const gross = (y.base + y.farmers) * 10;
    const farmContrib = y.farmers * 10;
    // itemised food flow (#76): live 1 s window (#92) — the sum of the
    // sim's last 10 per-tick component ledgers is food/s directly.
    // Near-zero rows hide (farmers always shows); net = the visible sum,
    // so unlike st.flow it includes training investment.
    const pe = {};
    for (const p of st.partsWin || []) {
      for (const k in p) pe[k] = (pe[k] || 0) + p[k];
    }
    const FLOW_ROWS = [
      ['base', '🌾 Land (base)'],
      ['farmers', '🌱 Farmers working plots'],
      ['routeIn', '🚚 Route deliveries in'],
      ['upkeep', '🛡️ Garrison upkeep'],
      ['fedDeploy', '⚔️ Feeding armies'],
      ['fedSupply', '🚚 Feeding supply units'],
      ['fedFarm', '🌱 Feeding farmers'],
      ['routeOut', '🚚 Routes loading out'],
      ['train', '⚒️ Growing/training unit'],
    ];
    const net = FLOW_ROWS.reduce((sum, [k]) => sum + (pe[k] || 0), 0);
    const flowRows = FLOW_ROWS.map(([k, lbl]) => {
      const v = pe[k] || 0;
      if (k !== 'farmers' && Math.abs(v) < 0.05) return '';
      return `<div class="flex justify-between text-xs text-zinc-400"><span>${lbl}</span><b class="${Math.round(v * 10) / 10 >= 0 ? 'text-emerald-400' : 'text-red-400'}">${fmtRate(v)}/s</b></div>`;
    }).join('');
    const farmHint = wc > y.worthwhileCells
      ? ' · <span class="text-red-400">no worthwhile plot free — extra farmers only eat</span>'
      : '';
    const pausedNote = '<div class="text-xs text-amber-400 mt-1">⏸ Paused — food at break-even. More farmers or fewer mouths to resume.</div>';
    let prog;
    if (st.mode === 'off') {
      prog = '<div class="text-xs text-zinc-500 mt-1">📦 Stockpiling food — no units trained.</div>';
    } else if (st.mode === 'farm') {
      prog = wc >= y.worthwhileCells
        ? `<div class="text-xs text-zinc-400 mt-1">Every worthwhile plot is manned (${y.worthwhileCells}) — stockpiling surplus food.</div>`
        : `<div class="text-xs text-zinc-400 mt-1">Growing farmer unit: ${pct}% · ${S.C.TRAIN_COST}🌾 each</div>`;
    } else if (gated && st.stockpile > 0) {
      prog = pausedNote;
    } else {
      prog = `<div class="text-xs text-zinc-400 mt-1">Training ${st.mode === 'supply' ? 'supply' : 'deploy'} unit: ${pct}% · ${S.C.TRAIN_COST}🌾 each — surplus food goes to training ${st.stockpile <= 0 ? '<span class="text-red-400">(needs food)</span>' : ''}</div>`;
    }
    // partial farmer recall (#68): same split-slider UX as blob splitting
    const rc = wc > 0 ? Math.max(1, Math.min(wc, ui.recallCount || wc)) : 0;
    ui.recallCount = rc || null;
    const fieldRows = ['deploy', 'supply', 'farm'].filter(role => g[role] >= 1).map(role => {
      const max = g[role];
      const cur = Math.max(1, Math.min(max, ui.fieldCounts[role] || Math.max(1, Math.floor(max / 2))));
      ui.fieldCounts[role] = cur;
      const icon = role === 'deploy' ? '⚔️' : role === 'supply' ? '🚚' : '🌱';
      return `<div class="flex items-center gap-2 mb-1">
        <span class="text-xs w-5 text-center">${icon}</span>
        <input id="field-count-${role}" type="range" min="1" max="${max}" step="1" value="${cur}" class="flex-1">
        <button data-act="fieldn" data-role="${role}" id="field-btn-${role}" class="btn-sm px-2 rounded bg-zinc-700 hover:bg-zinc-600 whitespace-nowrap">Field ${cur}</button>
      </div>`;
    }).join('');
    // phone (#189): role chips pick which garrisoned role the compact
    // hold-drag Field button (bottom controls row) acts on
    const fieldControls = fieldRows; // desktop only; the phone template omits it
    let fieldChips = '', fieldAr = null, fieldCur = 1;
    if (mob) {
      const present = ['deploy', 'supply', 'farm'].filter(role => g[role] >= 1);
      const ar = present.includes(ui.fieldRole) ? ui.fieldRole : present[0];
      ui.fieldRole = ar || null;
      if (ar) {
        fieldAr = ar;
        fieldCur = Math.max(1, Math.min(g[ar], ui.fieldCounts[ar] || Math.max(1, Math.floor(g[ar] / 2))));
        ui.fieldCounts[ar] = fieldCur;
        fieldChips = present.map(role => {
          const icon = role === 'deploy' ? '⚔️' : role === 'supply' ? '🚚' : '🌱';
          return `<button data-act="fieldrole" data-role="${role}" class="btn-sm px-1.5 rounded whitespace-nowrap text-xs ${role === ar ? 'bg-violet-600 text-white' : 'bg-zinc-800 text-zinc-300'}">${icon}${g[role]}</button>`;
        }).join('');
      }
    }
    // phone (#189): garrison action buttons share a two-column grid; a lone
    // odd button spans the full width
    let garrisonActions;
    if (mob) {
      const actBtns = [];
      if (g.farm > 0 && wc >= y.worthwhileCells) actBtns.push(`<button data-act="fieldgroup" class="btn rounded bg-emerald-800 hover:bg-emerald-700">🌱 Field ${g.farm} surplus</button>`);
      if (g.supply >= 1) actBtns.push('<button data-act="settroute" class="btn rounded bg-sky-800 hover:bg-sky-700">🚚 Supply route…</button>');
      actBtns.push(`<button data-act="field" class="btn rounded bg-zinc-700 hover:bg-zinc-600">Field garrison (${gTot})</button>`);
      if (actBtns.length % 2 === 1) actBtns[actBtns.length - 1] = actBtns[actBtns.length - 1].replace('class="btn', 'class="col-span-2 btn');
      garrisonActions = `<div class="grid grid-cols-2 gap-1 mt-1">${actBtns.join('')}</div>`;
    } else {
      garrisonActions = `${g.farm > 0 && wc >= y.worthwhileCells ? `<button data-act="fieldgroup" class="btn w-full rounded bg-emerald-800 hover:bg-emerald-700 mt-1">🌱 Field ${g.farm} surplus farmer${g.farm === 1 ? '' : 's'}</button>` : ''}
          ${g.supply >= 1 ? '<button data-act="settroute" class="btn w-full rounded bg-sky-800 hover:bg-sky-700 mt-1">🚚 Supply route to another settlement…</button>' : ''}
          <button data-act="field" class="btn w-full rounded bg-zinc-700 hover:bg-zinc-600 mt-1">Field garrison (${gTot})</button>`;
    }
    const hpBarPct = Math.max(0, Math.min(100, Math.round(100 * st.hp / S.C.SETT_HP)));
    const hpBarCol = hpBarPct >= 75 ? 'bg-emerald-500' : hpBarPct >= 40 ? 'bg-amber-500' : 'bg-red-500';
    // run-the-siege toggle (#181): shown while besieged if any of the
    // player's supply routes deliver here — it flips them all at once
    const sieged = S.besieged(game, st);
    const inbound = game.routes.filter(r2 => r2.owner === me && r2.targetKind === 'settlement' && r2.targetId === st.id);
    const siegeRunOn = inbound.length > 0 && inbound.every(r2 => r2.runSiege);
    const siegeBanner = sieged ? `
      <div class="text-xs text-amber-400 mb-1">⏳ <b>Besieged</b> — no farm income or deliveries; the garrison eats the stockpile, and weakens as its rations run down.</div>
      ${inbound.length ? `<button data-act="siegerun" class="btn w-full rounded mb-1 ${siegeRunOn ? 'bg-amber-600 text-white hover:bg-amber-500' : 'bg-zinc-800 hover:bg-zinc-700'}">🚚 Run the siege: ${siegeRunOn ? 'ON' : 'OFF'}</button>` : ''}` : '';
    // garrison fed state (#180): the meter fielded units emerge at, and
    // (#200) the one definition shared with the combat multiplier — so
    // this word now predicts exactly how hard the garrison hits
    const gMeter = S.settFedMeter(st);
    const gFedColor = gMeter >= 0.75 ? 'text-emerald-400' : gMeter >= 0.5 ? 'text-lime-400' : gMeter >= 0.25 ? 'text-amber-400' : 'text-red-400';
    if (mob) {
      // phone sheet (#189): garrison controls first (they're the reason to
      // open the panel), production mode as a dropdown button whose
      // background doubles as the training progress bar, and a
      // hold-to-adjust Recall button inline with the farmers line
      const MODES = [['farm', '🌾 Farm'], ['supply', '🚚 Supply'], ['deploy', '⚔️ Deploy'], ['off', '📦 Stockpile']];
      const curMode = MODES.find(([m]) => m === st.mode) || MODES[0];
      const training = st.mode === 'off' ? false
        : st.mode === 'farm' ? wc < y.worthwhileCells
          : !(gated && st.stockpile > 0);
      const fillPct = training ? Math.max(0, Math.min(100, pct)) : 0;
      const warn = (st.mode === 'supply' || st.mode === 'deploy') && gated && st.stockpile > 0
        ? '<div class="text-xs text-amber-400 mb-1">⏸ Paused — food at break-even. More farmers or fewer mouths to resume.</div>'
        : (st.mode === 'supply' || st.mode === 'deploy') && st.stockpile <= 0
          ? '<div class="text-xs text-red-400 mb-1">Training needs food — stockpile empty.</div>' : '';
      const modeOptions = ui.modeOpen ? `<div class="flex gap-1 mb-1">
        ${MODES.map(([m, lbl]) => `<button data-act="mode" data-mode="${m}"
          class="btn-sm flex-1 px-1 rounded ${st.mode === m ? (m === 'off' ? 'bg-zinc-600 text-white' : 'bg-emerald-700 text-white') : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'}">${lbl}</button>`).join('')}
      </div>` : '';
      setPanelHTML(`
        <div class="flex items-center justify-between mb-1">
          <span class="font-semibold">🏠 ${st.name || 'Settlement'}</span>
          <span class="text-xs ${st.hp < S.C.SETT_HP ? 'text-red-400' : 'text-zinc-500'}">HP ${Math.ceil(st.hp)}/${S.C.SETT_HP}</span>
        </div>
        <div class="h-1 mb-1 rounded bg-zinc-800 overflow-hidden"><div class="h-full ${hpBarCol}" style="width:${hpBarPct}%"></div></div>
        ${siegeBanner}
        <div class="text-xs text-zinc-500 mb-1">Garrison: ⚔️${g.deploy} 🚚${g.supply} 🌱${g.farm}${gTot > 0 ? ` · <span class="${gFedColor}">${S.fedLabel(gMeter)}</span>` : ''}</div>
        ${gTot > 0 ? `
          <div class="flex gap-1 mb-1">
            ${roleBtn('deploy', '⚔️', false, false)}${roleBtn('supply', '🚚', false, false)}${roleBtn('farm', '🌱', false, false)}
          </div>
          ${st.convert ? `<div class="text-xs text-amber-400 mb-1">⚔️ Garrison arming… ready in ~${convertEta(st.convert)}s (fielding cancels)</div>` : ''}
          ${garrisonActions}
        `.replaceAll('data-act="role"', 'data-act="grole"') : ''}
        <div class="mt-1 pt-1 border-t border-zinc-800">
          <button data-act="flowdetail" class="block w-full text-left text-xs text-zinc-400 mb-1">${ui.flowOpen ? '▾' : '▸'} Stockpile <b class="text-amber-300">${Math.floor(st.stockpile)}</b> / ${S.C.STOCK_CAP} 🌾 · ${fmtRate(gross)}/s · net <b class="${Math.round(net * 10) / 10 >= 0 ? 'text-emerald-400' : 'text-red-400'}">${fmtRate(net)}/s</b></button>
          ${ui.flowOpen ? `<div class="mb-1 pl-2 border-l border-zinc-800">${flowRows}</div>` : ''}
          <button data-act="modemenu" class="btn-sm w-full px-2 rounded relative overflow-hidden bg-zinc-800 text-left mb-1">
            <span class="absolute inset-y-0 left-0 bg-emerald-700/60" style="width:${fillPct}%"></span>
            <span class="relative flex items-center justify-between"><span>${curMode[1]}</span><span class="text-xs text-zinc-400">${training ? `${fillPct}% · ` : ''}mode ${ui.modeOpen ? '▴' : '▾'}</span></span>
          </button>
          ${modeOptions}
          ${warn}
        </div>
        ${fieldAr || wc >= 1 ? `
        <div class="flex items-center gap-1 mt-1 pt-1 border-t border-zinc-800">
          ${fieldChips}
          ${fieldAr ? `<button data-act="fieldn" data-role="${fieldAr}" id="field-hold" style="touch-action:none" class="btn-sm px-2 rounded bg-zinc-700 hover:bg-zinc-600 whitespace-nowrap">Field ${fieldCur}</button>` : ''}
          <span class="flex-1"></span>
          ${wc >= 1 ? `<button data-act="recall" id="recall-hold" style="touch-action:none" class="btn-sm px-2 rounded bg-zinc-700 hover:bg-zinc-600 whitespace-nowrap">Recall ${rc}</button>` : ''}
        </div>` : ''}`);
      const rb = panel.querySelector('#recall-hold');
      if (rb && !rb.dataset.holdWired) { rb.dataset.holdWired = '1'; attachRecallHold(rb); }
      const fb = panel.querySelector('#field-hold');
      if (fb && !fb.dataset.holdWired) { fb.dataset.holdWired = '1'; attachFieldHold(fb); }
      return;
    }
    setPanelHTML(`
      <div class="flex items-center justify-between mb-1">
        <span class="font-semibold">🏠 ${st.name || 'Settlement'}</span>
        <span class="text-xs ${st.hp < S.C.SETT_HP ? 'text-red-400' : 'text-zinc-500'}">HP ${Math.ceil(st.hp)}/${S.C.SETT_HP}</span>
      </div>
      <div class="h-2 mb-2 rounded bg-zinc-800 overflow-hidden"><div class="h-full ${hpBarCol}" style="width:${hpBarPct}%"></div></div>
      ${siegeBanner}
      <div class="text-xs text-zinc-400 mb-1">Stockpile <b class="text-amber-300">${Math.floor(st.stockpile)}</b> / ${S.C.STOCK_CAP} 🌾
        · ${fmtRate(gross)}/s · net <b class="${Math.round(net * 10) / 10 >= 0 ? 'text-emerald-400' : 'text-red-400'}">${fmtRate(net)}/s</b></div>
      <div class="mb-2 pl-2 border-l border-zinc-800">${flowRows}</div>
      <div class="text-xs text-zinc-500 mb-1">Production mode (sets new units' role)</div>
      <div class="flex gap-1 mb-2">
        ${[['farm', '🌾 Farm'], ['supply', '🚚 Supply'], ['deploy', '⚔️ Deploy'], ['off', '📦 Stockpile']].map(([m, lbl]) => `<button data-act="mode" data-mode="${m}"
          class="btn-sm flex-1 px-1 rounded ${st.mode === m ? (m === 'off' ? 'bg-zinc-600 text-white' : 'bg-emerald-700 text-white') : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'}">${lbl}</button>`).join('')}
      </div>
      ${prog}
      <div class="mt-2 pt-2 border-t border-zinc-800">
        <div class="text-xs text-zinc-500">🌱 ${wc} farmer${wc === 1 ? '' : 's'} · <b class="text-zinc-300">${y.workedCells} of ${st.tilled.length} plots worked</b> · <b class="${y.workedCells > 0 ? 'text-emerald-400' : 'text-zinc-400'}">${fmtRate(farmContrib)} food/s</b>${farmHint}</div>
        ${wc >= 2 ? `
        <div class="flex items-center gap-2 mt-1">
          <input id="recall-count" type="range" min="1" max="${wc}" step="1" value="${rc}" class="flex-1">
          <button data-act="recall" id="recall-btn" class="btn-sm px-2 rounded bg-zinc-700 hover:bg-zinc-600 whitespace-nowrap">Recall ${rc}</button>
        </div>` : wc === 1 ? '<div class="mt-1 text-right"><button data-act="recall" class="btn-sm px-2 rounded bg-zinc-700 hover:bg-zinc-600">Recall 1</button></div>' : ''}
      </div>
      <div class="text-xs text-zinc-500 mt-1">Farmers claim the lushest free plots — plots poorer than Sparse aren\'t worth manning.</div>
      <div class="mt-2 pt-2 border-t border-zinc-800">
        <div class="text-xs text-zinc-500 mb-1">Garrison: ⚔️${g.deploy} 🚚${g.supply} 🌱${g.farm}${gTot > 0 ? ` · <span class="${gFedColor}">${S.fedLabel(gMeter)}</span>` : ''}</div>
        ${gTot > 0 ? `
          <div class="flex gap-1 mb-2">
            ${roleBtn('deploy', '⚔️', false, false)}${roleBtn('supply', '🚚', false, false)}${roleBtn('farm', '🌱', false, false)}
          </div>
          ${st.convert ? `<div class="text-xs text-amber-400 mb-1">⚔️ Garrison arming… ready in ~${convertEta(st.convert)}s (fielding cancels)</div>` : ''}
          ${fieldControls}
          ${garrisonActions}
        `.replaceAll('data-act="role"', 'data-act="grole"') : '<div class="text-xs text-zinc-600">No units garrisoned — move a blob onto the settlement.</div>'}
      </div>`);
    return;
  }

  // blob(s)
  const multi = blobs.length > 1;
  const tot = blobs.reduce((s, b) => s + S.total(b), 0);
  const cnt = { deploy: 0, supply: 0, farm: 0 };
  for (const b of blobs) { cnt.deploy += b.count.deploy; cnt.supply += b.count.supply; cnt.farm += b.count.farm; }
  const b0 = blobs[0];
  const meter = multi
    ? blobs.reduce((s, b) => s + S.fedMeter(b) * S.total(b), 0) / Math.max(1, tot)
    : S.fedMeter(b0);
  const pureSupply = cnt.supply === tot && tot > 0;
  // #239: a merged supply/army group keeps the route action — the whole
  // group runs the line, supply units hauling and fighters escorting
  const hasSupply = cnt.supply > 0;
  const routeLabel = cnt.supply < tot ? '🚚 Escort a supply route…' : '🚚 Supply route…';
  const atHome = blobs.some(b => S.isAtHome(game, b));
  const fedColor = meter >= 0.75 ? 'text-emerald-400' : meter >= 0.5 ? 'text-lime-400' : meter >= 0.25 ? 'text-amber-400' : 'text-red-400';
  const onRoute = !multi && b0.order && b0.order.type === 'route';
  // run-the-siege toggle (#181) for a selected carrier whose destination
  // settlement is under siege (or that is already holding outside one)
  const carrierRoute = onRoute && b0.owner === me ? SUP.findRoute(game, b0.order.routeId) : null;
  const carrierSiege = !!(carrierRoute && carrierRoute.targetKind === 'settlement' && (() => {
    const tgt2 = game.settlements.find(s2 => s2.id === carrierRoute.targetId);
    return (tgt2 && S.besieged(game, tgt2)) || b0.order.holding;
  })());
  // route endpoints for the panel (#193): "Source → Dest" so the panel
  // and the map's highlighted line agree on which route this unit serves
  let routeLegend = '';
  if (carrierRoute) {
    const rs = SUP.routeSource(game, carrierRoute);
    const rt = SUP.routeTarget(game, carrierRoute);
    if (rs && rt) routeLegend = ` · ${rs.name} → ${carrierRoute.targetKind === 'blob' ? 'army' : rt.name}`;
  }
  // escorted line (#239): name the guards riding along, so the cargo figure
  // reading against a supply-only hold makes sense at a glance
  const escortLegend = onRoute && b0.count.supply < S.total(b0)
    ? ` · ⚔️ ${b0.count.deploy + b0.count.farm} escorting` : '';
  // group build (#130): an under-strength founding party holding its site
  const waitingBuild = blobs.some(b => b.order && b.order.type === 'move' && b.order.build && b.order.waiting);
  // combat state (#201): "is my army actually in a fight?" and "why is
  // its HP draining so fast?" are both answerable from the panel. rearT
  // marks the same event the map's thick orange attack link draws.
  const fighting = blobs.some(inCombat);
  const rearHit = blobs.some(b => game.tick - b.rearT < 5);
  const hpSum = blobs.reduce((s2, b) => s2 + b.units.reduce((a, u) => a + u.hp, 0), 0);
  const hpMax = blobs.reduce((s2, b) => s2 + b.units.reduce((a, u) => a + S.unitMaxHP(u.role), 0), 0);
  const hpPct = Math.round(100 * hpSum / Math.max(1, hpMax));
  const hpColor = hpPct >= 75 ? 'text-emerald-400' : hpPct >= 40 ? 'text-amber-400' : 'text-red-400';
  // nutrition trend across the selection: net food gain/loss per second
  // (eating vs pillage / territory / route intake) — live sum of the
  // sim's rolling 1 s window (#92)
  const trend = blobs.reduce((s2, b) => s2 + (b.foodWin || []).reduce((a, d) => a + d, 0), 0);
  const trendTag = trend > 0.05
    ? `<span class="text-emerald-400" title="Food trend">▲ +${trend.toFixed(1)}/s</span>`
    : trend < -0.05
      ? `<span class="text-red-400" title="Food trend">▼ ${trend.toFixed(1)}/s</span>`
      : `<span class="text-zinc-500" title="Food trend">▶ steady</span>`;
  if (!multi && tot >= 2) {
    ui.splitCount = Math.max(1, Math.min(tot - 1, ui.splitCount || Math.floor(tot / 2)));
  }

  // phone UI: stats only — all actions live in the tap popups
  const statsHTML = `
    <div class="flex items-center justify-between mb-1">
      <span class="font-semibold">${multi ? `${blobs.length} blobs` : 'Blob'} — ${tot} unit${tot === 1 ? '' : 's'}</span>
      <span class="text-xs"><span class="${hpColor}">❤️ ${hpPct}%</span> · <span class="${fedColor}">${S.fedLabel(meter)} ${Math.round(meter * 100)}%</span> ${trendTag}</span>
    </div>
    <div class="text-xs text-zinc-400 mb-2">⚔️ ${cnt.deploy} deploy · 🚚 ${cnt.supply} supply · 🌱 ${cnt.farm} farmer${onRoute ? ` · <span class="text-sky-300">on supply route${routeLegend}${escortLegend} · 🌾 ${Math.round(b0.order.cargo || 0)} / ${SUP.holdCap(b0)}</span>` : ''}${!multi && b0.eatingCargo != null && game.tick - b0.eatingCargo <= 5 ? ' · <span class="text-amber-300">🍽️ eating into its cargo</span>' : ''}${blobs.some(b => b.pillaging) ? ' · <span class="text-orange-400">pillaging</span>' : ''}${blobs.some(b => b.order && b.order.type === 'wall') ? ' · <span class="text-amber-300">🧱 building wall…</span>' : ''}${waitingBuild ? ` · <span class="text-amber-300">⏳ waiting for settlers (${tot}/${S.C.SETT_COST})</span>` : ''}${!multi && b0.working != null ? ' · <span class="text-emerald-300">working the fields</span>' : ''}</div>
    ${fighting ? `<div class="text-xs text-red-400 ${rearHit ? 'mb-1' : 'mb-2'}">⚔️ In combat</div>` : ''}
    ${rearHit ? '<div class="text-xs text-orange-400 mb-2">⚠️ Rear attack — taking extra damage from behind</div>' : ''}
    `;
  const convertLine = blobs.some(b => b.convert) ? `<div class="text-xs text-amber-400 mb-2">⚔️ Arming… ready in ~${convertEta(blobs.filter(b => b.convert).reduce((a, b) => (a.convert.done >= b.convert.done ? a : b)).convert)}s — units fight as their old role until then; picking another role cancels</div>` : '';

  if (isMobile()) {
    setPanelHTML(statsHTML + convertLine);
    return;
  }

  setPanelHTML(`${statsHTML}
    <div class="text-xs text-zinc-500 mb-1">Role ${!atHome ? '<span class="text-zinc-600">(farmers need a settlement)</span>' : ''}</div>
    <div class="flex gap-1 mb-2">
      ${roleBtn('deploy', '⚔️ Deploy', cnt.deploy === tot, false)}
      ${roleBtn('supply', '🚚 Supply', pureSupply, false)}
      ${roleBtn('farm', '🌱 Farmer', cnt.farm === tot, !atHome)}
    </div>
    ${convertLine}
    <div class="grid grid-cols-2 gap-1 mb-2">
      <button data-act="move" class="btn rounded bg-zinc-800 hover:bg-zinc-700">📍 Move</button>
      <button data-act="pillage" class="btn rounded ${blobs.some(b => b.pillaging) ? 'bg-orange-700 text-white' : 'bg-zinc-800 hover:bg-zinc-700'}">🔥 Pillage</button>
      <button data-act="build" class="btn rounded bg-zinc-800 hover:bg-zinc-700 ${tot < S.C.SETT_COST ? 'opacity-40' : ''}" ${tot < S.C.SETT_COST ? 'disabled' : ''}>🏠 Build (${S.C.SETT_COST})</button>
      <button data-act="wall" class="btn rounded bg-zinc-800 hover:bg-zinc-700">🧱 Wall…</button>
      <button data-act="route" class="btn rounded ${hasSupply ? 'bg-sky-800 hover:bg-sky-700' : 'bg-zinc-800 opacity-40'}" ${hasSupply ? '' : 'disabled'}>${routeLabel}</button>
    </div>
    ${carrierSiege ? `<button data-act="siegerun" class="btn w-full rounded mb-2 ${carrierRoute.runSiege ? 'bg-amber-600 text-white hover:bg-amber-500' : 'bg-zinc-800 hover:bg-zinc-700'}">🚚 Run the siege: ${carrierRoute.runSiege ? 'ON' : 'OFF'}</button>` : ''}
    ${!multi && tot >= 2 ? `
    <div class="flex items-center gap-2">
      <button data-act="split" class="btn px-3 rounded bg-zinc-800 hover:bg-zinc-700">✂️ Split</button>
      <input id="split-count" type="range" min="1" max="${tot - 1}" step="1" value="${ui.splitCount}" class="flex-1">
      <span id="split-label" class="text-xs text-zinc-400 w-12 text-right">${ui.splitCount} / ${tot}</span>
    </div>` : ''}`);
}

// ---------------------------------------------------------------- HUD / loop

function updateHUD() {
  const p = S.unitCounts(game, me);
  $('stat-units').textContent = `👥 ${p.units}`;
  $('stat-setts').textContent = `🏠 ${p.setts}`;
  $('stat-time').textContent = fmtDur(S.gameSeconds(game.tick));
  // #247: `me`, never a hard-coded 0 — the joining player in a PvP match was
  // shown the HOST's idle-farmer count, so their button appeared and hid on
  // the opponent's state and pressing it reported "no idle farmers" against a
  // non-zero badge. The op itself (opBackToWork(game, me)) was always correct.
  const idle = S.idleFarmers(game, me);
  const idleN = idle.field + idle.walk;
  const btw = $('btn-backtowork');
  btw.classList.toggle('hidden', idleN === 0 || !!game.result || !!game.replay);
  if (idleN > 0) btw.textContent = `🌱 Back to work (${idleN})`;
  updateGroupsBar();
  if (game.pvp) {
    // PvP toasts come from the server's snapshots (netEvents); the local
    // predicted sim's events would duplicate them
    game.events.length = 0;
    return;
  }
  for (const ev of game.events) {
    if (ev.owner == null || ev.owner === me) toast(ev.msg);
  }
  game.events.length = 0;
}

// The loop re-schedules before it runs, so a thrown exception would otherwise
// repeat sixty times a second — and the dev-console bridge posts every one of
// them to the parent window. Catch it once, pause, and save what we have:
// a frozen-but-saved match is recoverable, a crash loop is not (#240).
// #247: how many catch-up ticks one frame may absorb. Two is invisible at the
// PvP rate (one tick per 200 ms of wall clock) and drains even a 25-tick
// correction inside a quarter-second, where the old code did all 25 at once.
const CATCHUP_PER_FRAME = 2;

let frameCrashed = false;
function frame(ts) {
  requestAnimationFrame(frame);
  if (frameCrashed) return;   // hold the last frame; the DOM controls still work
  try {
    frameBody(ts);
  } catch (e) {
    frameCrashed = true;
    console.error('frame failed', e);
    paused = true;
    $('btn-pause').textContent = '▶';
    saveGame(true);
    toast('⚠️ Something went wrong — the match is paused and saved');
  }
}

function frameBody(ts) {
  const dt = Math.min(100, ts - lastFrame || 16);
  lastFrame = ts;
  if (!game) return;

  if (game.replay) {
    // A backward seek REPLACES player.game (rewindTo deserializes a keyframe,
    // reset builds a fresh one), so re-adopt it before anything reads `game`
    // this frame — otherwise we step the new object and draw the abandoned
    // one, which is what made units jitter in place forever (#228).
    if (player && game !== player.game) adoptReplayGame();
    // one source of truth for the reveal-map overlay: the player's flag, read
    // by render.js off ui.reveal (never written into the sim's fog) (#228)
    if (player) ui.reveal = player.reveal;
    // Replay playback (#223). Its own transport: the bar's 1×/2×/4×/8× mean
    // exactly what the same labels mean on the live speed selector, so 1× runs
    // the match back in the wall-clock time it originally took and the 2×
    // default is the sim's native rate. The player owns the stepping (it has to
    // apply the log's orders at the right tick), and a seek in flight holds the
    // clock still.
    if (!paused && player && !player.seeking && !RP.atEnd(player)) {
      acc += dt * replaySpeed * 0.5;
      let iter = 0;
      while (acc >= 100 && iter++ < 60) {
        if (!RP.stepPlayer(player)) break;
        // #233: a replay rebuilds its own chart as it plays. sample() is
        // idempotent per tick and truncates anything after the current one,
        // so scrubbing backwards walks the graph back with it.
        if (statsSeries) ST.sample(statsSeries, player.game);
        acc -= 100;
      }
      if (acc >= 100) acc = 0;
    }
  } else if (!paused && !game.result) {
    // displayed speed steps 1–4 map to 0.5×–2× of the sim's native tick
    // rate: 1× is the half-speed default, 2× the old normal. PvP always
    // runs at step 1, so both clients share the same 0.5 multiplier.
    acc += dt * speed * 0.5;
    let iter = 0;
    while (acc >= 100 && iter++ < 40) {
      // one shared definition of "advance a tick" (step, then the enemy
      // commander thinks) — replay.js owns it so the live loop and playback
      // can never drift apart. The tutorial (#185) and the controls-practice
      // sandbox (#212) switch the commander off; advance() knows that.
      RP.advance(game);
      if (recorder) RP.recordTick(recorder, game);
      if (statsSeries) ST.sample(statsSeries, game);  // #233
      acc -= 100;
    }
    // fell behind (background tab): drop the backlog but KEEP THE PHASE (#247).
    // Zeroing it snapped the render alpha to 0 and broke interpolation
    // continuity every time the loop overran.
    acc = dropBacklog(acc, 100);
    // #247: drain a snapshot correction a couple of ticks per frame, so the
    // catch-up is spread across frames rather than landing as one jump.
    if (mp && mp.catchUp > 0 && !game.result) {
      const d = drainCatchUp(mp.catchUp, CATCHUP_PER_FRAME);
      mp.catchUp = d.left;
      for (let i = 0; i < d.run && !game.result; i++) RP.advance(game);
    }
  }

  input.update(dt);
  if (game.tutorial) TUT.tick(game, ui); // markers/card before this frame draws
  if (CT.active()) CT.tick(view, ui, game); // gesture gates / ring / anchor (#212)
  // desktop build/wall-placement preview follows the mouse (#94, #187).
  // shotHover pins it instead: a headless screenshot never moves a mouse, so
  // the hover-only states would otherwise be unreachable from a URL (#234).
  ui.hover = shotHover
    || ((ui.pending === 'build' || ui.pending === 'wall') ? input.mouseWorld : null);
  renderer.draw(game, view, ui, Math.max(0, Math.min(1, acc / 100)));

  if (ts - lastPanel > 400) {
    lastPanel = ts;
    updateHUD();
    renderPanel(false);
  }
  if (game.replay) refreshReplayUi();   // clock + scrub position (#223)
  // #240: every 10 s of sim time, down from 30. At the 1× default that is a
  // write a minute more often, and it bounds what an unannounced reload costs.
  if (!game.pvp && !game.replay && game.tick - lastSaveTick >= 100) {
    lastSaveTick = game.tick;
    saveGame(true);
  }
  if (game.result && !resultPosted && !game.pvp) {
    closeControlsTour(); // the match is over — the card has nothing to teach
    if (game.tutorial) { resultPosted = true; tutorialOver(game.result); }
    else endMatch(game.result);
  }
}

requestAnimationFrame(frame);

// ---------------------------------------------------------------- replays (#223)

// The playable/unavailable button for one history row.
//
// The gate is strict on purpose: a recording is an order log re-run through the
// CURRENT sim, so it only reproduces the match while the engine is unchanged.
// A mismatch (older, or newer than this bundle) renders a muted button that
// explains itself instead of silently playing a match that never happened.
//
// It stays clickable — a real `disabled` attribute would swallow the tap and the
// player would get no explanation at all — and is marked aria-disabled.
function replayBtnHTML(m) {
  const localVer = m.client_id ? localReplayIndex[m.client_id] : undefined;
  const id = m.replay_id != null ? m.replay_id : null;
  const ver = id != null ? m.replay_sim_version : localVer;
  if (id == null && localVer === undefined) return '';         // no recording at all
  const key = id != null ? `id:${id}` : `local:${m.client_id}`;
  if ((ver | 0) !== S.SIM_VERSION) {
    return `<button data-replay="${esc(key)}" data-replay-stale="1" aria-disabled="true"
      class="btn-sm px-2 rounded bg-zinc-800/60 text-zinc-600 text-xs shrink-0 whitespace-nowrap"
      title="The game engine has changed since this match was recorded">▶ Replay · unavailable</button>`;
  }
  return `<button data-replay="${esc(key)}"
    class="btn-sm px-2 rounded bg-sky-800 hover:bg-sky-700 text-sky-100 text-xs shrink-0 whitespace-nowrap"
    title="Watch this match back">▶ Replay</button>`;
}

// client_id -> sim_version for the logs this device is holding. Refreshed
// whenever the list renders so a pending row gets its button too.
let localReplayIndex = {};
function refreshLocalReplayIndex() {
  try { localReplayIndex = RP.localIndex(offStore); } catch { localReplayIndex = {}; }
}
refreshLocalReplayIndex();

// The engine-changed notice. Informational, so it gets a single OK.
function showEngineChangedDialog() {
  showConfirm('Replay unavailable',
    'The game engine has changed since this match was recorded, so the replay can no longer be shown. The match itself, its result and its rating are unaffected.',
    [], { okOnly: true });
}

$('history-mine-rows').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-replay]');
  if (!btn) return;
  if (btn.hasAttribute('data-replay-stale')) { showEngineChangedDialog(); return; }
  const key = btn.getAttribute('data-replay') || '';
  if (key.startsWith('local:')) openLocalReplay(key.slice(6));
  else openServerReplay(parseInt(key.slice(3), 10));
});

$('btn-end-replay').addEventListener('click', () => {
  if (endReplay) openReplay(endReplay);
});

function openLocalReplay(clientId) {
  const payload = RP.takeLocal(offStore, clientId);
  if (!payload) {
    refreshLocalReplayIndex();
    renderMineRows(lastServerHistory);
    showEngineChangedDialog();
    return;
  }
  openReplay(payload);
}

async function openServerReplay(id) {
  if (!Number.isInteger(id)) return;
  // a ?shot= boot serves its own logs — no network, works in every environment
  if (shotReplayLogs[id]) { openReplay(shotReplayLogs[id]); return; }
  try {
    const data = await api('/api/replays/' + id);
    if (!data || !data.replay) throw new Error('Replay not found');
    openReplay(data.replay);
  } catch (err) {
    showMenuError(err.message || 'Could not load that replay');
  }
}

// Boot the viewer. The second version check is belt-and-braces for the paths
// that don't come through the list (the end card, a ?shot= boot).
function openReplay(payload) {
  if (!RP.playable(payload)) { showEngineChangedDialog(); return; }
  const p = RP.createPlayer(payload);
  if (!p) { showEngineChangedDialog(); return; }
  player = p;
  me = payload.mode === 'pvp' ? (payload.viewer_owner | 0) : 0;
  ui.selected = null;
  replaySpeed = 2;             // the sim's native rate — see the replay bar
  $('replay-speed').value = '2';
  paused = false;
  acc = 0;
  lastReplayUi = -1;
  ui.reveal = false;           // render-only fog override, off on every open (#228)
  $('replay-play').textContent = '⏸';
  $('replay-fog').classList.remove('bg-sky-800', 'text-sky-100');
  $('replay-seek').max = String(Math.max(1, p.endTick));
  $('replay-seek').value = '0';
  $('replay-notice').classList.add('hidden');
  replayEndShown = false;
  startMatch(p.game);
  // startMatch centres on the viewer's own start, which is exactly right here.
  resultPosted = true;         // a replay must never post a result or clear saves
  $('replay-bar').classList.remove('hidden');
  layoutBottomStack();         // #237: lift the corner HUD clear of the bar
  refreshReplayUi();
}

function closeReplay() {
  paused = false;
  backToMenu();   // owns the teardown, including the bar and the player
}

// Re-point every module-level read at the player's CURRENT game (#228).
// replay.js hands out a new object on any backward seek — rewindTo deserializes
// a keyframe, reset regenerates from the seed — and main.js used to keep the
// one startMatch was handed. The stale object was then drawn while the player
// stepped the live one: the clock advanced, nothing moved, and because the
// renderer keeps interpolating `lerp(prevX, x, acc/100)` on a frozen world,
// every unit slid a step forward and snapped back once per tick, forever.
// The reveal-map toggle died the same way — it wrote the live game's fog while
// the renderer read the abandoned one's.
//
// Selection and control groups hold ids, not references, so they survive the
// swap (a blob that doesn't exist yet at the seeked-to tick simply deselects).
// `acc` restarts so the first frame after a seek isn't drawn at a stale
// interpolation fraction.
function adoptReplayGame() {
  if (!player) return;
  game = player.game;
  acc = 0;
  lastReplayUi = -1;
  ui.reveal = player.reveal;
  updateHUD();
  renderPanel(true);
}

// The outcome card at the end of a playback: the same Victory / Defeat /
// Surrendered wording the player saw the first time, minus the rating line
// (nothing is being rated) and minus the rewatch button (they're already here).
// Tapping the backdrop dismisses it back to the paused final frame, so ⏮ and the
// scrub bar are still reachable after the replay has run out.
let replayEndShown = false;
function showReplayEndCard() {
  if (replayEndShown || !player) return;
  replayEndShown = true;
  // The log's terminal {t, end} entry is what actually decides the outcome, and
  // it lands on the game before atEnd goes true — so read it there first (#228).
  // finishRecording() never emitted a `result` field, so meta.result is
  // undefined for the end card's ▶ Watch replay and for any log still sitting on
  // the device, and every such rewatch used to claim "Defeat". Only the server's
  // replay row carries meta.result, which stays the fallback.
  const r = player.game.result || player.meta.result || null;
  const me0 = (player.meta.viewer_owner | 0) === 0;
  const win = r === 'win' || (r === 'p0-win' && me0) || (r === 'p1-win' && !me0);
  const lost = r === 'loss' || (r === 'p0-win' && !me0) || (r === 'p1-win' && me0);
  $('end-emoji').textContent = !r ? '🎬' : win ? '🏆' : '🏳️';
  $('end-title').textContent = !r ? 'Replay complete'
    : win ? 'Victory!' : r === 'surrender' ? 'Surrendered' : lost ? 'Defeat' : 'Replay complete';
  $('end-detail').textContent = `Replay complete — ${fmtDur(S.gameSeconds(player.game.tick))} of play.`;
  $('end-rating').classList.add('hidden');
  $('btn-end-replay').classList.add('hidden');
  // #232: the transport is still live behind this card, so offer the ways
  // back into it instead of leaving "Back to menu" as the only exit.
  $('end-replay-controls').classList.remove('hidden');
  $('btn-end-stats').classList.toggle('hidden', !statsSeries || !statsSeries.rows.length);
  $('end-modal').classList.remove('hidden');
}

function dismissReplayEndCard() {
  replayEndShown = true;   // stays dismissed until a seek re-arms it
  $('end-modal').classList.add('hidden');
}

$('btn-end-keep').addEventListener('click', dismissReplayEndCard);
$('btn-end-restart').addEventListener('click', () => {
  dismissReplayEndCard();
  paused = false;
  $('replay-play').textContent = '⏸';
  doReplaySeek(0);
});
$('btn-end-back30').addEventListener('click', () => {
  if (!player) return;
  dismissReplayEndCard();
  paused = false;
  $('replay-play').textContent = '⏸';
  // 30 s of GAME time — gameSeconds is tick/5, so 30 s is 150 ticks
  doReplaySeek(Math.max(0, player.game.tick - 150));
});

// Clock, scrub position and the drift notice. Cheap enough to call per frame,
// but keyed on the tick so it only touches the DOM when something moved.
function refreshReplayUi() {
  if (!player) return;
  const t = player.game.tick;
  if (t === lastReplayUi && !player.seeking) return;
  lastReplayUi = t;
  const el = $('replay-time');
  el.textContent = player.seeking
    ? 'Rewinding…'
    : `${fmtDur(S.gameSeconds(t))} / ${fmtDur(S.gameSeconds(player.endTick))}`;
  const seek = $('replay-seek');
  if (document.activeElement !== seek) seek.value = String(t);
  // #232: the banner tracks the CURRENT playback, not the session. It used to
  // latch on forever after one mismatched checkpoint, so a single hiccup made
  // every later scrub look untrustworthy; reset() and rewindTo() now clear the
  // flag, and this follows it in both directions.
  const notice = $('replay-notice');
  if (player.drift) {
    if (notice.classList.contains('hidden')) {
      notice.textContent = '⚠ This playback has drifted from the recording — it may not match exactly what happened.';
      notice.classList.remove('hidden');
      layoutBottomStack();   // the bar just got taller
    }
  } else if (!notice.classList.contains('hidden')) {
    notice.classList.add('hidden');
    layoutBottomStack();
  }
  if (RP.atEnd(player)) {
    if ($('replay-play').textContent !== '▶') $('replay-play').textContent = '▶';
    if (!player.seeking) showReplayEndCard();
  }
}

$('replay-play').addEventListener('click', () => {
  if (!player) return;
  if (RP.atEnd(player)) { doReplaySeek(0); return; }   // finished: ⏯ restarts
  paused = !paused;
  $('replay-play').textContent = paused ? '▶' : '⏸';
});
$('replay-restart').addEventListener('click', () => doReplaySeek(0));
$('replay-exit').addEventListener('click', closeReplay);
$('replay-speed').addEventListener('change', () => {
  replaySpeed = Math.max(1, Math.min(8, +$('replay-speed').value || 2));
  $('replay-speed').blur();
});
$('replay-fog').addEventListener('click', () => {
  if (!player) return;
  RP.setReveal(player, !player.reveal);
  ui.reveal = player.reveal;   // the frame loop re-asserts this; this makes it immediate
  $('replay-fog').classList.toggle('bg-sky-800', player.reveal);
  $('replay-fog').classList.toggle('text-sky-100', player.reveal);
});
for (const ev of ['input', 'change']) {
  $('replay-seek').addEventListener(ev, () => {
    if (!player) return;
    doReplaySeek(parseInt($('replay-seek').value, 10) || 0);
  });
}

// One seek at a time: a drag fires a stream of input events, so a request that
// lands mid-seek is remembered and run once the current one lands.
let seekPending = null;
async function doReplaySeek(tick) {
  if (!player) return;
  if (player.seeking) { seekPending = tick; return; }
  const target = tick;
  if (target < player.endTick) {
    // scrubbing away from the end re-arms the outcome card
    replayEndShown = false;
    if (game && game.replay) $('end-modal').classList.add('hidden');
  }
  await RP.seek(player, target, () => {
    // yield to the frame loop between slices so a long rewind stays responsive.
    // A rewind has already swapped in a new game object by the time the first
    // slice yields, so adopt it here too — otherwise the frames drawn DURING a
    // long rewind still show the abandoned scene (#228).
    if (game !== player.game) adoptReplayGame();
    refreshReplayUi();
    return new Promise((r) => requestAnimationFrame(() => r()));
  });
  if (player) {
    // and once more on completion: renderPanel/refreshReplayUi below run outside
    // the frame loop, so they'd otherwise read the pre-seek game once
    if (game !== player.game) adoptReplayGame();
    if (player.game.tick <= 0 || !RP.atEnd(player)) $('replay-play').textContent = paused ? '▶' : '⏸';
    lastReplayUi = -1;
    refreshReplayUi();
    renderPanel(true);
  }
  if (seekPending != null) {
    const next = seekPending;
    seekPending = null;
    doReplaySeek(next);
  }
}

// ---------------------------------------------------------------- match stats (#233)
//
// A canvas line chart of the sampled series: three metrics, both sides, one
// shared time axis. Each metric is normalised to its OWN peak and drawn in
// its own horizontal band, because units (tens), territory (hundreds of
// tiles) and food rate (a fraction) share no scale — stacking them in bands
// keeps all three legible at once instead of flattening two into the floor.
// No fog: the match is over, and a post-mortem that hid the enemy's curve
// would be a worse story, not a fairer one.

// Labels and colours are VIEWER-RELATIVE (#246), exactly like every colour on
// the map (render.js's ownerColor). The chart used to index PLAYER_NAMES and
// METRICS[].color by the raw owner number, which is only "you" for the player
// who HOSTED: a PvP guest — and anyone watching a PvP replay from the guest's
// seat — read their own army under "Enemy", in the opponent's colour.
const PLAYER_NAMES = ['You', 'Enemy'];

function statsViewer() {
  if (player && player.meta) return player.meta.viewer_owner | 0;   // a replay's recorded seat
  return game ? (game.me | 0) : 0;
}
// Which owner fills a viewer-relative slot (0 = you, 1 = them), so the legend
// and the lines are drawn in the same order for both seats.
function statsOwnerForSlot(s) {
  const v = statsViewer();
  return s === 0 ? v : 1 - v;
}

function openStats() {
  if (!statsSeries) return;
  const rows = statsSeries.rows.filter(Boolean);
  $('stats-empty').classList.toggle('hidden', rows.length > 0);
  const sum = ST.summary(statsSeries);
  const cov = ST.coverage(statsSeries);
  $('stats-sub').textContent = sum
    ? `${fmtDur(sum.seconds)} of play · ${rows.length} samples · both sides shown`
      // #244: a resumed match whose earlier history didn't come back with it.
      // Say so — drawing the lines flush to the axis would claim the match
      // started at the resume point.
      + (cov.gap ? ` · no history before ${fmtDur(S.gameSeconds(cov.fromTick))} (recorded on another device, or lost)` : '')
    : 'Nothing sampled yet.';
  // toggles
  const tg = $('stats-toggles');
  tg.innerHTML = ST.METRICS.map(m => `
    <label class="flex items-center gap-2 cursor-pointer select-none">
      <input type="checkbox" data-metric="${m.key}" ${statsMetric[m.key] ? 'checked' : ''}
        class="accent-violet-500 w-4 h-4">
      <span class="inline-block w-3 h-1 rounded" style="background:${m.color[0]}"></span>
      <span class="inline-block w-3 h-1 rounded" style="background:${m.color[1]}"></span>
      <span>${m.label}</span>
    </label>`).join('');
  for (const cb of tg.querySelectorAll('input[data-metric]')) {
    cb.addEventListener('change', () => {
      statsMetric[cb.dataset.metric] = cb.checked;
      drawStats();
    });
  }
  $('stats-legend').innerHTML = sum ? ST.METRICS.map(m => [0, 1].map(s => {
    const o = statsOwnerForSlot(s);   // #246: slot 0 is whoever is looking
    return `<div><span class="inline-block w-3 h-1 rounded align-middle" style="background:${m.color[s]}"></span>
      ${PLAYER_NAMES[s]} ${m.label}: <span class="text-zinc-200 tabular-nums">${m.fmt(sum.last[m.key][o])}</span>
      ${m.key === 'units' ? `<span class="text-zinc-500">(peak ${sum.peakUnits[o]} at ${fmtDur(S.gameSeconds(sum.peakAt[o]))})</span>` : ''}</div>`;
  }).join('')).join('') : '';
  $('stats-modal').classList.remove('hidden');
  drawStats();
}

function drawStats() {
  const cv = $('stats-chart');
  if (!cv || !statsSeries) return;
  const rows = statsSeries.rows.filter(Boolean);
  const dpr = window.devicePixelRatio || 1;
  const cw = cv.clientWidth || 640, chh = 300;
  cv.width = Math.round(cw * dpr); cv.height = Math.round(chh * dpr);
  const c = cv.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, cw, chh);
  const shown = ST.METRICS.filter(m => statsMetric[m.key]);
  if (!rows.length || !shown.length) return;

  const padL = 8, padR = 8, padT = 10, padB = 22;
  const plotW = cw - padL - padR;
  const bandH = (chh - padT - padB) / shown.length;
  const tMax = Math.max(1, rows[rows.length - 1].t);
  const xAt = (t) => padL + (t / tMax) * plotW;

  // time axis
  c.strokeStyle = '#27272a'; c.lineWidth = 1;
  c.fillStyle = '#52525b'; c.font = '10px system-ui'; c.textAlign = 'center';
  const endS = S.gameSeconds(tMax);
  const stepS = endS > 1800 ? 600 : endS > 600 ? 300 : 120;   // game seconds
  for (let gs = 0; gs <= endS; gs += stepS) {
    const x = Math.round(xAt(gs * 5)) + 0.5;
    c.beginPath(); c.moveTo(x, padT); c.lineTo(x, chh - padB); c.stroke();
    // the first and last gridlines sit on the plot edge — nudge their labels
    // inward rather than letting the text clip off the canvas
    c.textAlign = gs === 0 ? 'left' : x > cw - 40 ? 'right' : 'center';
    c.fillText(fmtDur(gs), x, chh - padB + 13);
  }
  c.textAlign = 'center';

  // #244: shade the stretch of the match this series has no samples for, so
  // the curves visibly START somewhere rather than pretending to cover it.
  const cov = ST.coverage(statsSeries);
  if (cov.gap) {
    const gx = Math.min(cw - padR, xAt(cov.fromTick));
    c.fillStyle = 'rgba(63,63,70,0.35)';
    c.fillRect(padL, padT, Math.max(0, gx - padL), chh - padT - padB);
    c.fillStyle = '#a1a1aa'; c.font = '10px system-ui'; c.textAlign = 'center';
    if (gx - padL > 46) c.fillText('no history', (padL + gx) / 2, (padT + chh - padB) / 2);
  }

  shown.forEach((m, bi) => {
    const top = padT + bi * bandH, bot = top + bandH - 8;
    const peak = Math.max(ST.peak(statsSeries, m.key), 1e-6);
    // band frame + label
    c.strokeStyle = '#3f3f46';
    c.beginPath(); c.moveTo(padL, Math.round(bot) + 0.5); c.lineTo(cw - padR, Math.round(bot) + 0.5); c.stroke();
    c.fillStyle = '#71717a'; c.textAlign = 'left'; c.font = '10px system-ui';
    c.fillText(`${m.label} — peak ${m.fmt(peak)}`, padL + 2, top + 9);
    for (const s of [0, 1]) {
      const o = statsOwnerForSlot(s);   // #246
      c.strokeStyle = m.color[s];
      c.lineWidth = 1.75;
      c.beginPath();
      rows.forEach((r, i) => {
        const x = xAt(r.t);
        const y = bot - (r[m.key][o] / peak) * (bandH - 20);
        if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
      });
      c.stroke();
    }
  });
}

$('btn-end-stats').addEventListener('click', openStats);
$('btn-stats-close').addEventListener('click', () => $('stats-modal').classList.add('hidden'));
$('stats-modal').addEventListener('click', (e) => {
  if (e.target === $('stats-modal')) $('stats-modal').classList.add('hidden');
});
window.addEventListener('resize', () => {
  if (!$('stats-modal').classList.contains('hidden')) drawStats();
});

// ---------------------------------------------------------------- replay shots (#223)

// The replay viewer only exists once a recorded match is open, and the history
// list's ▶ Replay buttons only exist once there are recordings — so plain
// navigation reaches neither, and before/after screenshots (plus the dapp.json
// tests) would only ever see the main menu. These boots build fixed payloads IN
// CODE and never touch the network or storage, so they render identically in
// every environment.

// A short, valid solo log on a fixed seed.
//
// newGame assigns ids in ONE fixed order per side: the settlement, then its two
// working farmers, then the war party. So owner 0 is settlement 1, farmhands
// 2/3, WAR PARTY 4 — and owner 1 is settlement 5, farmhands 6/7, war party 8.
// (The old comment here said "the war party is blobs 2/3/4" and this log
// accordingly marched two farmhands around while the army never moved a tile,
// which is exactly what "the replay is broken, units just jitter" looks like.)
//
// xsmall is 36×36 with fixed starts at (9,9) and (27,27) for every seed, so the
// destinations below are literal and still land in enemy country.
function shotReplayPayload(version) {
  return {
    mode: 'solo',
    seed: 'shot223',
    size_key: 'xsmall',
    difficulty: 'normal',
    viewer_owner: 0,
    result: 'win',
    duration_seconds: 360,
    end_tick: 1800,
    sim_version: version == null ? S.SIM_VERSION : version,
    log: [
      { t: 20, c: { op: 'setMode', settlementId: 1, mode: 'farm' } },
      { t: 60, c: { op: 'move', blobId: 4, x: 23, y: 23 } },
      { t: 500, c: { op: 'pillage', blobId: 4, on: true } },
      { t: 760, c: { op: 'setMode', settlementId: 1, mode: 'deploy' } },
      { t: 900, c: { op: 'move', blobId: 4, x: 28, y: 28, target: { kind: 'settlement', id: 5 } } },
      { t: 1300, c: { op: 'backToWork' } },
      { t: 1800, end: 'win' },
    ],
  };
}

// `?shot=replay` — open the viewer on that log, run it to a fixed tick and
// pause, so the whole transport (clock, scrub position, speed, fog toggle)
// renders from a URL alone. The seek target sits mid-march, so the shot shows
// the war party out in the field rather than a still home camp.
async function shotReplay() {
  openReplay(shotReplayPayload());
  await doReplaySeek(600);
  paused = true;
  $('replay-play').textContent = '▶';
  lastReplayUi = -1;
  refreshReplayUi();
  renderPanel(true);
}

// `?shot=replay-rewound` (#228) — the state no URL could reach before: a replay
// that has been played forward and then SEEKED BACK, with Reveal map on.
// That is the exact path that used to strand main.js on the game object
// replay.js had already thrown away — units vibrating on the spot forever and a
// dead reveal toggle. Both the screenshots and the dapp.json checks now cover
// it: the clock reads 0m 00s, the map is drawn, and the fog toggle is lit.
async function shotReplayRewound() {
  openReplay(shotReplayPayload());
  RP.setReveal(player, true);
  ui.reveal = true;
  $('replay-fog').classList.add('bg-sky-800', 'text-sky-100');
  await doReplaySeek(900);   // forward past a keyframe…
  await doReplaySeek(0);     // …then all the way back, through reset()
  paused = true;
  $('replay-play').textContent = '▶';
  lastReplayUi = -1;
  refreshReplayUi();
  renderPanel(true);
}

// The stand-in "Yours" list for the two list shots: two rows on this engine
// (live ▶ Replay buttons) and one recorded on an older one (the muted
// unavailable state), so both states are on screen at once. In-memory only —
// modelled directly on initOfflineShot().
const SHOT_REPLAY_ROWS = [
  { client_id: 'shot223-a', result: 'win', difficulty: 'normal', duration_seconds: 1622, rating_delta: 12 },
  { client_id: 'shot223-b', result: 'loss', difficulty: 'veryhard', duration_seconds: 2480, rating_delta: -16 },
  { client_id: 'shot223-old', result: 'win', difficulty: 'hard', duration_seconds: 1385, rating_delta: 9, stale: true },
];

function initReplayListShot() {
  const now = Date.now();
  // A dedicated override rather than reusing offlineShot: this shot is about the
  // replay buttons, not about being offline, so the rest of the menu must look
  // completely normal — recorded, rated rows, no "pending" badges.
  replayListShot = SHOT_REPLAY_ROWS.map((r, i) => ({
    client_id: r.client_id,
    result: r.result,
    difficulty: r.difficulty,
    duration_seconds: r.duration_seconds,
    map_seed: r.client_id,
    created_at: new Date(now - (i + 1) * 3600_000).toISOString(),
    mode: 'solo',
    opponent: null,
    rating_delta: r.rating_delta,
    // the row's own recording: one of them on an older engine
    replay_id: 223000 + i,
    replay_sim_version: r.stale ? 0 : S.SIM_VERSION,
  }));
  // The logs go into the (memory-only) replay store keyed by the SAME ids the
  // rows advertise, so the buttons are real: tapping a playable one opens the
  // viewer for real, with no network.
  replayListShot.forEach((row, i) => {
    shotReplayLogs[row.replay_id] = shotReplayPayload(SHOT_REPLAY_ROWS[i].stale ? 0 : undefined);
  });
  refreshLocalReplayIndex();
}

// Logs behind the list shot's rows, so openServerReplay never has to fetch.
const shotReplayLogs = {};

// ---------------------------------------------------------------- screenshot-state deep links

// The wall garrison panel only exists mid-match, so plain navigation
// can't reach it — before/after screenshots and dapp.json tests would
// only ever see the main menu. `?shot=wall-garrison` boots a solo match
// on a FIXED seed, drops a finished wall beside the player's start with
// a full 8-unit garrison, selects it and pauses, so the panel (and the
// new cap) renders from a URL alone. Pure local UI state — no DB writes,
// so it works in every environment.
function shotWallGarrison() {
  me = 0;
  const g = S.newGame('shot199', 'small', 'normal');
  const start = g.map.starts[0];
  let spot = null;
  for (let r = 2; r <= 6 && !spot; r++) {
    for (let dy = -r; dy <= r && !spot; dy++) {
      for (let dx = -r; dx <= r && !spot; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = start.x + 1 + dx, y = start.y + 1 + dy;
        // never on own farmland (#219): legal now, but untilling the
        // plot would shift the screenshot's pixels
        const res = S.canPlaceWall(g, 0, x, y);
        if (res.ok && !res.farm) spot = { x, y };
      }
    }
  }
  if (!spot) return;
  // a full garrison with all three roles represented — the widest the
  // readout ever gets, which is exactly what the shot should prove
  const w = S.spawnFinishedWall(g, 0, spot.x, spot.y, { deploy: 5, supply: 2, farm: 1 });
  startMatch(g);
  paused = true;
  $('btn-pause').textContent = '▶';
  ui.selected = { kind: 'wall', id: w.id };
  view.cx = w.x + 0.5;
  view.cy = w.y + 0.5;
  view.scale = Math.min(48, view.scale * 1.8);
  input.clampView();
  renderPanel(true);
}

// The armed wall-placement state (#214) is two taps deep and its "after the
// FIRST tap" moment is exactly the bug: on touch there was no hover, so the
// pinned start tile rendered nothing at all. `?shot=wall-start` boots a solo
// match on a FIXED seed, selects the player's opening war party, arms wall
// placement, pins ui.wallStart on a wall-legal tile beside it and leaves
// ui.hover null — reproducing the touch-only state a mouse can't. The sim is
// paused so the marker holds still. Pure local UI state, no DB writes.
function shotWallStart() {
  clearSaves();
  me = 0;
  const g = S.newGame('shot214', 'small', 'normal');
  const mine = g.blobs.find(b => b.owner === 0 && b.count.deploy > 0);
  if (!mine) return;
  // nearest wall-legal tile to the army, scanned in a fixed order so the
  // same seed always pins the same tile. Starts a few tiles out so the
  // marker isn't hidden under the army's own sprite in the screenshot.
  let spot = null;
  for (let r = 3; r <= 7 && !spot; r++) {
    for (let dy = -r; dy <= r && !spot; dy++) {
      for (let dx = -r; dx <= r && !spot; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = Math.floor(mine.x) + dx, y = Math.floor(mine.y) + dy;
        if (x < 0 || y < 0 || x >= g.map.w || y >= g.map.h) continue;
        const res = S.canPlaceWall(g, 0, x, y); // farmland skipped (#219): pixel-stable shot
        if (res.ok && !res.farm) spot = { x, y };
      }
    }
  }
  if (!spot) return;
  startMatch(g);
  paused = true;
  $('btn-pause').textContent = '▶';
  ui.selected = { kind: 'blob', id: mine.id };
  ui.pending = 'wall';
  ui.wallStart = { x: spot.x, y: spot.y };
  ui.wallEnd = null;
  ui.hover = null; // the whole point: touch devices never have one
  view.cx = spot.x + 0.5;
  view.cy = spot.y + 0.5;
  view.scale = 26;
  input.clampView();
  updateHint();
  renderPanel(true);
}

// Scorched reclaimed farmland (#219) only exists after a wall standing on
// your own plot is razed mid-match, so no plain URL reaches it.
// `?shot=wall-razed` boots a solo match on a FIXED seed, drops a finished
// wall on the home settlement's outermost plot (which ploughs it under),
// then razes it off honest sim output — a hair of structure left and the
// enemy's opening war party moved in beside it — so the reclaimed tile is
// selected with the real burnt-earth paint and the inspector's Barren +
// 🔥 Scorched lines. Pure local UI state, no DB writes: works everywhere.
function shotWallRazed() {
  clearSaves();
  me = 0;
  const g = S.newGame('shot219', 'xsmall', 'normal');
  const home = g.settlements.find(s => s.owner === 0 && !s.building);
  if (!home) return;
  // the fertile own plot furthest from the keep, scanned in a fixed order
  // so the same seed always burns the same tile
  let spot = null, bd = -1;
  for (const i of [...home.tilled].sort((a, b) => a - b)) {
    const x = i % g.map.w, y = (i / g.map.w) | 0;
    if (!g.map.fert[i]) continue;
    const res = S.canPlaceWall(g, 0, x, y);
    if (!res.ok || !res.farm) continue;
    const d = Math.hypot(x + 0.5 - (home.x + 1), y + 0.5 - (home.y + 1));
    if (d > bd) { bd = d; spot = { x, y, i }; }
  }
  if (!spot) return;
  const w = S.spawnFinishedWall(g, 0, spot.x, spot.y, { deploy: 0, supply: 0, farm: 0 });
  if (!w) return;
  startMatch(g);
  const foe = g.blobs.find(b => b.owner === 1 && b.count.deploy > 0);
  if (foe) {
    foe.x = spot.x + 1.5; foe.y = spot.y + 0.5;
    foe.prevX = foe.x; foe.prevY = foe.y;
    foe.order = null; foe.path = null; foe.pathGoal = null;
    // foraging off: otherwise the raiders strip the tiles they stand on
    // and the shot has scorch marks that aren't the wall's
    foe.pillaging = false;
    w.hp = 0.5; // an unmanned wall on its last legs: one contact ends it
    for (let i = 0; i < 20 && g.walls.some(x => x.id === w.id); i++) S.step(g);
    // the raiders pull back off the rubble so the burnt tile — the whole
    // subject of the shot — isn't hidden under their sprite
    foe.x = spot.x + 4.5; foe.y = spot.y + 0.5;
    foe.prevX = foe.x; foe.prevY = foe.y;
    foe.order = null; foe.path = null; foe.pathGoal = null;
  }
  ui.selected = { kind: 'tile', i: spot.i };
  view.cx = spot.x + 0.5;
  view.cy = spot.y + 0.5;
  view.scale = 34;
  paused = true;
  $('btn-pause').textContent = '▶';
  input.clampView();
  renderPanel(true);
  updateHUD();
}

// The tightened blob pick (#224) is only visible in a state no plain URL
// reaches: a farmland tile with a field hand STANDING ON IT, selected as
// a TILE. Before the fix the hand's ~2-tile invisible halo won that tap
// and the fertility inspector was unreachable. `?shot=tile-under-farmer`
// boots a solo match on a FIXED seed, fields the home garrison's farm
// hands onto their plots, selects the tile the nearest hand is working,
// and pauses — so the fertility readout and the new "field hands working
// here" line render from a URL alone. Pure local UI state, no DB writes.
function shotTileUnderFarmer() {
  clearSaves();
  me = 0;
  const g = S.newGame('shot224', 'small', 'normal');
  const home = g.settlements.find(s => s.owner === 0 && !s.building);
  if (!home) return;
  // the opening garrison holds farm hands: field them so they disperse
  // onto real plots the same way the Field button does
  if (home.garrison.farm > 0) S.opFieldRole(g, home, 'farm', home.garrison.farm);
  startMatch(g);
  // let them walk out and settle on their plots, then freeze
  for (let i = 0; i < 120; i++) S.step(g);
  // the hand nearest the keep whose tile is plain farmland (not the 2×2
  // grounds), scanned in a fixed order so the seed always picks the same
  let pick = null, bd = Infinity;
  for (const b of g.blobs) {
    if (b.dead || b.owner !== 0 || b.working == null) continue;
    const tx = Math.floor(b.x), ty = Math.floor(b.y);
    const i = ty * g.map.w + tx;
    if (g.map.mountain[i] || g.settAt[i] || !g.map.fert[i]) continue;
    const d = Math.hypot(tx + 0.5 - (home.x + 1), ty + 0.5 - (home.y + 1));
    if (d < bd || (d === bd && i < pick.i)) { bd = d; pick = { x: tx, y: ty, i }; }
  }
  if (!pick) return;
  ui.selected = { kind: 'tile', i: pick.i };
  view.cx = pick.x + 0.5;
  view.cy = pick.y + 0.5;
  view.scale = 40; // close enough that the dot and the tile read apart
  paused = true;
  $('btn-pause').textContent = '▶';
  input.clampView();
  renderPanel(true);
  updateHUD();
}

// The #222 case only exists mid-siege: an own finished wall being
// battered, with reinforcements in hand. `?shot=wall-under-siege` boots a
// solo match on a FIXED seed, drops a manned wall beside the player's
// start, parks the enemy's opening war party adjacent and steps a few
// ticks so `lastHitT` is live (the wall reads as under attack), then
// selects the wall — so the panel's "reinforcements can march in even
// while the wall is under attack" line renders against a wall that
// actually is. A player war party waits a few tiles off, the group a
// tester would order in. Pure local UI state, no DB writes.
function shotWallUnderSiege() {
  clearSaves();
  me = 0;
  const g = S.newGame('shot222', 'small', 'normal');
  const start = g.map.starts[0];
  let spot = null;
  for (let r = 3; r <= 7 && !spot; r++) {
    for (let dy = -r; dy <= r && !spot; dy++) {
      for (let dx = -r; dx <= r && !spot; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = start.x + 1 + dx, y = start.y + 1 + dy;
        // off own farmland (#219): untilling the plot would shift pixels
        const res = S.canPlaceWall(g, 0, x, y);
        if (res.ok && !res.farm) spot = { x, y };
      }
    }
  }
  if (!spot) return;
  const w = S.spawnFinishedWall(g, 0, spot.x, spot.y, { deploy: 2, supply: 0, farm: 0 });
  if (!w) return;
  startMatch(g);
  const foe = g.blobs.find(b => b.owner === 1 && b.count.deploy > 0);
  if (foe) {
    foe.x = spot.x + 1.5; foe.y = spot.y + 0.5;
    foe.prevX = foe.x; foe.prevY = foe.y;
    foe.order = null; foe.path = null; foe.pathGoal = null;
    foe.pillaging = false; // no scorch marks that aren't the siege's
  }
  // the player's own war party, parked where a tester would find it
  const mine = g.blobs.find(b => b.owner === 0 && b.count.deploy > 0);
  if (mine) {
    mine.x = spot.x - 2.5; mine.y = spot.y + 0.5;
    mine.prevX = mine.x; mine.prevY = mine.y;
    mine.order = null; mine.path = null; mine.pathGoal = null;
  }
  // a few ticks of real contact: w.lastHitT goes live off honest sim
  // output, so the panel's under-attack framing isn't staged
  for (let i = 0; i < 6; i++) {
    if (foe) { foe.order = null; foe.path = null; foe.x = spot.x + 1.5; foe.y = spot.y + 0.5; }
    S.step(g);
  }
  ui.selected = { kind: 'wall', id: w.id };
  view.cx = spot.x + 0.5;
  view.cy = spot.y + 0.5;
  view.scale = 34;
  paused = true;
  $('btn-pause').textContent = '▶';
  input.clampView();
  renderPanel(true);
  updateHUD();
}

// The in-combat / rear-attack panel lines (#201) exist only while a
// selected group is actually under fire, which no plain URL can reach —
// so `?shot=in-combat` boots a solo match on a FIXED seed and stages a
// pursuit: the enemy's opening war party is placed 1 tile from the
// player's, the melee registers, then the player's group is ordered away
// (a plain move — opMove flags it as a disengagement because contact is
// live) while the enemy holds an attack order on it. A few more ticks and
// the pursuer is landing REAR_MULT hits from directly behind, so BOTH
// status lines render off honest sim output. The group is selected and
// the sim paused, freezing the < 5-tick windows. Pure local UI state —
// no DB writes — so it works in every environment.
function shotInCombat() {
  clearSaves();
  me = 0;
  const g = S.newGame('shot201', 'xsmall', 'normal');
  const mine = g.blobs.find(b => b.owner === 0 && b.count.deploy > 0);
  const foe = g.blobs.find(b => b.owner === 1 && b.count.deploy > 0);
  if (!mine || !foe) return;
  // one tile to the player's right — outside the home settlement's siege
  // ring, so the shot reads as a clean field engagement
  foe.x = mine.x + 1; foe.y = mine.y;
  foe.prevX = foe.x; foe.prevY = foe.y;
  foe.order = null; foe.path = null; foe.pathGoal = null;
  startMatch(g);
  for (let i = 0; i < 3; i++) S.step(g); // registers the melee (meleeT / engagedT)
  ui.selected = { kind: 'blob', id: mine.id };
  // the pursuit: enemy locks onto the player's group (direct sim call —
  // it's the AI's side), the player's group breaks off with a plain move
  // exactly like a right-click; running with its back turned puts the
  // pursuer in its rear arc, and pass 2 refreshes rearT every tick
  S.opMove(g, foe, mine.x, mine.y, { kind: 'blob', id: mine.id });
  const home = g.settlements.find(s => s.owner === 0);
  if (home) doMove(mine, home.x + 1, home.y + 1, null);
  for (let i = 0; i < 5; i++) S.step(g);
  view.cx = mine.x; view.cy = mine.y; view.scale = 26;
  paused = true;
  $('btn-pause').textContent = '▶';
  input.clampView();
  renderPanel(true);
  updateHUD();
}

// The controls tour (#212) only exists over a live match on a phone-sized
// screen, so no plain URL reaches it — before/after screenshots and the
// dapp.json tests would only ever see the main menu. `?shot=controls-tour…`
// boots a solo match on a FIXED seed, pauses it, and opens the tour at a
// given step with the touch page set forced (so a desktop-width screenshot
// harness still renders the phone content). The boot itself never marks the
// tour seen — only a visitor who pages all the way through it does.
// Pure local UI state — no DB writes, so it works in every environment.
// The `tutorial: true` entries boot the guided scenario's own map with the
// prelude armed, so the phone tutorial's opening step is URL-reachable too —
// with persist:false, so a screenshot boot never writes the seen flag (a
// tester can still page to the end and watch the scenario card take over).
const TOUR_SHOTS = {
  'controls-practice': { step: 0 },       // the menu 🕹️ button's practice map
  'controls-practice-desktop': { step: 0, desk: true }, // ditto at desktop width
  'controls-tour': { step: 0 },           // step 1 — one-finger pan
  'controls-tour-actions': { step: 4 },   // step 5 — the tap-again action list
  'controls-tour-modes': { step: 6 },     // step 7 — Select vs Drag
  'tutorial-prelude': { step: 0, tutorial: true },      // 📖 Tutorial, step 1 of the tour
  'tutorial-prelude-end': { step: 9, tutorial: true },  // its hand-over step
  'tutorial-prelude-desktop': { step: 0, tutorial: true, desk: true }, // its desktop form
  'tutorial-prelude-desktop-end': { step: 3, tutorial: true, desk: true }, // ...and its hand-over page
};

// ---------------------------------------------------------------- shots for this change

// `?shot=walls-far` (#236) — a long garrisoned wall zoomed OUT past the
// per-tile chip threshold. That is the state the aggregate labels exist for:
// below ~12 px/tile every tile chip was suppressed, so a 12-tile wall holding
// eight units rendered as an anonymous grey line. One label per CHAIN now
// carries the whole garrison. Fixed seed, sim paused, pure local UI state.
function shotWallsFar() {
  clearSaves();
  me = 0;
  const g = S.newGame('shot236', 'small', 'normal');
  const start = g.map.starts[0];
  // one straight run of wall-legal tiles across the keep's own row band,
  // scanned nearest-row-first so the same seed always builds the same line
  // AND the line lands inside the opening vision circle — a chain out in the
  // fog would screenshot as black nothing.
  const rows = [];
  for (let d = 0; d <= 6; d++) { rows.push(d); if (d) rows.push(-d); }
  let best = null;
  for (const dy of rows) {
    if (best) break;
    const y0 = start.y + dy;
    const run = [];
    for (let k = -6; k <= 5; k++) {
      const res = S.canPlaceWall(g, 0, start.x + k, y0);
      if (!res.ok || res.farm) { if (run.length >= 10) break; run.length = 0; continue; }
      run.push({ x: start.x + k, y: y0 });
    }
    if (run.length >= 10) best = run;
  }
  if (!best) return;
  // garrison spread along the chain: the point of the aggregate is that no
  // single tile's count is the interesting number, the chain's total is
  const per = [2, 0, 1, 0, 0, 3, 0, 0, 1, 0, 0, 1];
  best.forEach((t, i) => {
    const n = per[i] || 0;
    S.spawnFinishedWall(g, 0, t.x, t.y, n ? { deploy: n } : {});
  });
  for (let i = 0; i < 3; i++) S.step(g);   // let the garrisons' own vision open the fog
  startMatch(g);
  paused = true;
  $('btn-pause').textContent = '▶';
  view.cx = best[0].x + best.length / 2;
  view.cy = best[0].y + 0.5;
  view.scale = 9;             // below drawWall's CHIP_MIN_S, on purpose
  input.clampView();
  renderPanel(true);
}

// `?shot=place-preview` (#234) — settlement placement armed with a site under
// the cursor, so the floating score card (plots / land / food per minute now
// and at full farms) renders from a URL. `place-preview-touch` pins the same
// site through ui.buildSite instead, which is the touch path: no hover, so the
// numbers ride the hint bar as a chip.
function shotPlacePreview(touch) {
  clearSaves();
  me = 0;
  const g = S.newGame('shot234', 'small', 'normal');
  const mine = g.blobs.find(b => b.owner === 0 && b.count.deploy > 0);
  if (!mine) return;
  // the legal site with the most plots within a short march, scanned in a
  // fixed order so the same seed always scores the same ground. Visible
  // tiles only: a site out in the fog would score fine and screenshot black.
  let spot = null, bestPlots = -1;
  for (let dy = -9; dy <= 9; dy++) {
    for (let dx = -9; dx <= 9; dx++) {
      const x = Math.floor(mine.x) + dx, y = Math.floor(mine.y) + dy;
      if (x < 0 || y < 0 || x >= g.map.w || y >= g.map.h) continue;
      if (g.fog[y * g.map.w + x] !== 2) continue;
      const a = S.buildAnchorAt(g, x, y);
      if (a.err) continue;
      const sc = S.previewScore(g, a.x, a.y, 0);
      if (sc.plots > bestPlots) { bestPlots = sc.plots; spot = { x, y }; }
    }
  }
  if (!spot) return;
  startMatch(g);
  paused = true;
  $('btn-pause').textContent = '▶';
  ui.selected = { kind: 'blob', id: mine.id };
  ui.pending = 'build';
  if (touch) { ui.buildSite = { x: spot.x, y: spot.y }; ui.hover = shotHover = null; }
  else { ui.buildSite = null; ui.hover = shotHover = { x: spot.x + 0.5, y: spot.y + 0.5 }; }
  view.cx = spot.x + 0.5;
  view.cy = spot.y + 0.5;
  view.scale = 26;
  input.clampView();
  updateHint();
  renderPanel(true);
}

// `?shot=stats` (#233) — the end-of-match graph. It reads a sampled series,
// not the DB, so the shot simulates a real short match and samples it exactly
// the way the frame loop does: honest curves, deterministic seed, no fixture.
// `stats-one` shows the same screen with a single metric left ticked, which is
// what the toggles are for.
function shotStats(only) {
  clearSaves();
  me = 0;
  const g = S.newGame('shot233', 'xsmall', 'normal');
  startMatch(g);
  paused = true;
  $('btn-pause').textContent = '▶';
  for (let k = 0; k < 1500 && !g.result; k++) {
    RP.advance(g);
    ST.sample(statsSeries, g);
  }
  renderPanel(true);
  if (only) statsMetric = { units: only === 'units', land: only === 'land', food: only === 'food' };
  openStats();
}

// `?shot=stats-pvp-guest` (#246) — the graph as the player who JOINED the match
// sees it. That seat is unreachable by URL (it needs a live lobby and a second
// human), and it is the whole bug: the chart indexed its labels and colours by
// the raw owner number, so the guest read their own army under "Enemy". A real
// PvP game viewed from owner 1, sampled the way the frame loop samples, so the
// legend is honest output rather than a fixture.
function shotStatsPvpGuest() {
  clearSaves();
  me = 1;
  const g = S.newGame('shot246', 'xsmall', 'normal', true);
  S.setViewer(g, 1);
  startMatch(g);
  paused = true;
  $('btn-pause').textContent = '▶';
  // both towns put their hands in the fields, so the curves actually move
  // without either side needing a commander
  for (const s of g.settlements) applyCommand(g, s.owner, { op: 'setMode', settlementId: s.id, mode: 'farm' });
  for (let k = 0; k < 1500 && !g.result; k++) {
    RP.advance(g);
    ST.sample(statsSeries, g);
  }
  renderPanel(true);
  openStats();
}

// `?shot=stats-gap` (#244) — the graph of a match whose earlier history didn't
// come back with the save (the other device kept it). Staged the only honest
// way: the series simply has no samples before the resume point, exactly as a
// resumed session's does, so the shaded stretch and the "no history before…"
// line come from the real coverage check.
function shotStatsGap() {
  clearSaves();
  me = 0;
  const g = S.newGame('shot244', 'xsmall', 'normal');
  startMatch(g);
  paused = true;
  $('btn-pause').textContent = '▶';
  statsSeries = ST.createSeries();      // nothing sampled for the first stretch
  for (let k = 0; k < 1500 && !g.result; k++) {
    RP.advance(g);
    if (g.tick >= 600) ST.sample(statsSeries, g);
  }
  renderPanel(true);
  openStats();
}

// `?shot=attack-caravan` (#243) — the reported state, one tap from the fix.
// An armed group is standing right on top of an enemy CARAVAN in open field
// (deploy 0, so it can't fight back) — which is where a failed attack order
// used to leave it, halted an avoidance ring short with nothing said. The
// action list is opened on the caravan, so the ⚔️ Attack row that the pick used
// to lose is on screen from a URL alone. Fixed seed, sim paused, no writes.
function shotAttackCaravan() {
  clearSaves();
  me = 0;
  const g = S.newGame('shot243', 'small', 'normal');
  const army = g.blobs.find(b => b.owner === 0 && b.count.deploy > 0 && b.working == null);
  const foe = g.blobs.find(b => b.owner === 1 && S.total(b) >= 3 && b.working == null);
  if (!army || !foe) return;
  // the enemy's opening party re-rolled as pure carriers: no fighters is what
  // makes this the reported case, and it is why nothing ever happened
  for (const u of foe.units) u.role = 'supply';
  foe.count = { deploy: 0, supply: foe.units.length, farm: 0 };
  foe.food = S.foodCap(foe);
  foe.order = null; foe.path = null; foe.pathGoal = null;
  // open ground out past the player's farmland, scanned in a fixed order so the
  // same seed always stages the identical field
  const start = g.map.starts[0];
  let spot = null;
  for (let r = 5; r <= 9 && !spot; r++) {
    for (let dy = -r; dy <= r && !spot; dy++) {
      for (let dx = -r; dx <= r && !spot; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = start.x + 1 + dx, y = start.y + 1 + dy;
        if (!passable(g.map, x, y) || !passable(g.map, x - 2, y)) continue;
        if (g.settAt && g.settAt[y * g.map.w + x]) continue;
        spot = { x: x + 0.5, y: y + 0.5 };
      }
    }
  }
  if (!spot) return;
  foe.x = spot.x; foe.y = spot.y;
  foe.prevX = foe.x; foe.prevY = foe.y;
  // …and the army parked where the old plain-move order left it: two tiles out,
  // circles touching, doing nothing
  army.x = spot.x - 2; army.y = spot.y;
  army.prevX = army.x; army.prevY = army.y;
  army.order = null; army.path = null; army.pathGoal = null;
  startMatch(g);
  for (let i = 0; i < 3; i++) S.step(g);   // refreshes fog so the caravan is in sight
  paused = true;
  $('btn-pause').textContent = '▶';
  ui.selected = { kind: 'blob', id: army.id };
  view.cx = foe.x; view.cy = foe.y; view.scale = 34;
  input.clampView();
  renderPanel(true);
  updateHUD();
  // the tap-again action list, opened on the caravan with the same generous
  // pick a finger gets — the ⚔️ Attack row is the point of the shot
  showOrderPopup({ x: foe.x, y: foe.y }, null, findEnemyTargetAt({ x: foe.x, y: foe.y }, tapHitR()));
}

// `?shot=merged-supply` (#239) — a MERGED supply/army group selected, which is
// the state the bug lives in: idle carriers fold into an idle army and the
// group's "🚚 Supply route…" button used to go dead, with no way to un-mix it
// in the field. No URL reached it (it needs a mid-match merge), so the panel
// was invisible to screenshots and tests. Fixed seed, real merge through the
// sim's own tickMerge, sim paused. Pure local UI state — no DB writes — so it
// works in every environment.
//   `merged-supply-armed`   — the route flow armed with its source picked,
//                             where the hint bar names the escort.
//   `merged-supply-running` — the same group already ON a line, which is the
//                             only way to reach the panel's escort readout.
function shotMergedSupply(mode) {
  clearSaves();
  me = 0;
  const g = S.newGame('shot239', 'xsmall', 'normal');
  const army = g.blobs.find(b => b.owner === 0 && b.count.deploy > 0 && b.working == null);
  const home = g.settlements.find(s => s.owner === 0 && !s.building);
  if (!army || !home) return;
  // field a caravan out of the army itself: split a few units off, turn them
  // into supply units, and stand them on the army's own tile. Both halves are
  // idle, so tickMerge's deep-overlap rule folds them into ONE mixed group —
  // the merge the player hits by accident, reproduced honestly.
  const sp = S.opSplit(g, army, 3);
  if (sp.err) return;
  const carriers = sp.blob;
  S.opSetRole(g, carriers, 'supply');
  // stand the pair out on open ground, clear of the home footprint: the bug
  // bites an army in the field, and a group parked ON its town would hand
  // every route tap to the settlement instead (settlement-first, #142)
  // canPlaceWall is the handy "open, buildable, not settlement ground" test
  // the other shots scan with; take the nearest such tile 4+ tiles out so the
  // camp is clear of the footprint band but still inside opening vision
  let camp = null;
  for (let rad = 4; rad <= 8 && !camp; rad++) {
    for (let dy = -rad; dy <= rad && !camp; dy++) {
      for (let dx = -rad; dx <= rad && !camp; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== rad) continue;
        const tx = home.x + 1 + dx, ty = home.y + 1 + dy;
        const res = S.canPlaceWall(g, 0, tx, ty);
        if (res.ok && !res.farm) camp = { x: tx + 0.5, y: ty + 0.5 };
      }
    }
  }
  if (!camp) camp = { x: army.x, y: army.y };
  army.x = camp.x; army.y = camp.y;
  army.prevX = army.x; army.prevY = army.y;
  carriers.x = army.x; carriers.y = army.y;
  carriers.prevX = carriers.x; carriers.prevY = carriers.y;
  // opSplit suppresses auto-merge on both halves until one completes a move;
  // clear it so the deliberate re-stack folds, which is what a real idle
  // caravan walking into an idle army does
  army.noMerge = false; carriers.noMerge = false;
  startMatch(g);
  for (let i = 0; i < 20 && !carriers.dead; i++) S.step(g);
  const merged = g.blobs.find(b => !b.dead && b.owner === 0
    && b.count.supply > 0 && b.count.deploy > 0);
  if (!merged) return;
  ui.selected = { kind: 'blob', id: merged.id };
  if (mode === 'armed') { ui.pending = 'route'; ui.routeSrc = home.id; }
  if (mode === 'running') {
    // put the whole group on a line to the outpost — or, on a map with only
    // one town, back to a friendly army — so the panel shows the escort row
    const dest = g.settlements.find(s => s.owner === 0 && !s.building && s.id !== home.id);
    S.opRoute(g, merged, dest
      ? { kind: 'settlement', id: dest.id }
      : { kind: 'blob', id: army.id === merged.id ? carriers.id : army.id }, home.id);
    for (let i = 0; i < 30 && !merged.dead; i++) S.step(g); // let it load some cargo
  }
  view.cx = merged.x; view.cy = merged.y; view.scale = 26;
  paused = true;
  $('btn-pause').textContent = '▶';
  input.clampView();
  updateHint();
  renderPanel(true);
  updateHUD();
}

// `?shot=replay-end` (#232) — the outcome card at the end of a playback, with
// the transport controls that used to be missing: the only way out of this card
// was Back to menu, even though the scrub bar was still live behind it.
async function shotReplayEnd() {
  openReplay(shotReplayPayload());
  await doReplaySeek(1800);
  paused = true;
  $('replay-play').textContent = '▶';
  lastReplayUi = -1;
  refreshReplayUi();
  renderPanel(true);
  replayEndShown = false;
  showReplayEndCard();
}

// The visibility machine's states (#212) are per-account, so no URL can reach
// state 2 or 3 by itself — and a signed-in reviewer may already be in state 3,
// where there is nothing to screenshot. These links pin the machine's inputs in
// memory instead: no fetch, no write, no localStorage, identical in staging and
// production, and immune to whose account is looking.
const BTN_SHOTS = {
  'controls-btn-mobile': { tutorial_done: true, controls_touch_seen: false, controls_desktop_seen: true },
  'controls-btn-desktop': { tutorial_done: true, controls_touch_seen: true, controls_desktop_seen: false },
};
function shotControlsButton(state) {
  visOverride = state;
  stateLoaded = true;
  refreshTutorialButton();
  refreshControlsVisibility();
}
function shotControlsTour(desc) {
  clearSaves();
  me = 0;
  // the non-tutorial shots boot the same practice sandbox the menu 🕹️ button
  // uses, so the links exercise the real path
  const g = desc.tutorial ? S.newTutorialGame() : S.newPracticeGame();
  startMatch(g);
  paused = true;
  $('btn-pause').textContent = '▶';
  input.clampView();
  renderPanel(true);
  updateHUD();
  // `desk` renders the mouse & keyboard pages the practice map shows at
  // desktop widths; every other link forces the touch set so a desktop-width
  // screenshot harness still captures the phone content — gated, so the "Try
  // it" line and the stage checklist are in both capture frames.
  const opts = {
    mode: 'tour', set: desc.desk ? 'desktop' : 'touch', gated: !desc.desk,
    step: desc.step, force: true, onClose: onTourClose,
  };
  if (desc.tutorial) {
    pendingTutorialBegin = { game: g, persist: false };
    tourPausedBefore = false; // paging to the end hands over to a running scenario
    opts.finishLabel = '✓ Start the tutorial';
    opts.skipLabel = 'Skip to tutorial';
  } else {
    // the practice map's own labels, so the link shows what a player sees.
    // pendingPracticeExit is deliberately NOT armed: a screenshot boot must
    // never navigate itself back to the menu.
    opts.finishLabel = '✓ Done';
    opts.skipLabel = 'Skip';
    opts.exitLabel = 'Exit practice';
  }
  CT.open(opts);
}

// ---------------------------------------------------------------- formation shots (#251)

// A group of exactly the requested composition, parked in open ground next to
// the player's starting town and selected — the one thing no plain URL can
// reach, because a mixed army is the product of mid-match merges. Roles are
// rewritten on real units drawn from the sim's own seeded stream (newGame made
// them), so nothing here forges state the sim couldn't produce itself.
function stageFormationGroup(seed, comp, scale) {
  clearSaves();
  me = 0;
  const g = S.newGame(seed, 'small', 'normal');
  const army = g.blobs.find(b => b.owner === 0 && b.working == null && S.total(b) > 0);
  if (!army) return null;
  const want = comp.deploy + comp.supply + comp.farm;
  // grow the group to the size the shot needs by cloning its own units, each
  // carrying a distinct seed off the sim's stream so the formation's
  // (role, seed) ordering has something deterministic to sort by
  while (army.units.length < want) {
    const src = army.units[army.units.length % Math.max(1, army.units.length)];
    army.units.push({ role: src.role, hp: src.hp, seed: S.simRand(g) });
  }
  army.units.length = want;
  let i = 0;
  for (const role of ['deploy', 'supply', 'farm']) {
    for (let k = 0; k < comp[role]; k++) { army.units[i].role = role; army.units[i].hp = S.unitMaxHP(role); i++; }
  }
  army.count = { deploy: comp.deploy, supply: comp.supply, farm: comp.farm };
  army.food = S.foodCap(army);
  army.order = null; army.path = null; army.pathGoal = null;
  // open ground a few tiles out from the keep, scanned in a fixed order so the
  // same seed always stages the identical field
  const start = g.map.starts[0];
  let spot = null;
  for (let r = 4; r <= 8 && !spot; r++) {
    for (let dy = -r; dy <= r && !spot; dy++) {
      for (let dx = -r; dx <= r && !spot; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = start.x + 1 + dx, y = start.y + 1 + dy;
        if (!passable(g.map, x, y)) continue;
        if (g.settAt && g.settAt[y * g.map.w + x]) continue;
        spot = { x: x + 0.5, y: y + 0.5 };
      }
    }
  }
  if (spot) { army.x = spot.x; army.y = spot.y; army.prevX = army.x; army.prevY = army.y; }
  army.facing = 0;   // ranks across the screen, front rank to the right
  startMatch(g);
  for (let i2 = 0; i2 < 3; i2++) S.step(g);   // settles fog so the group is lit
  paused = true;
  $('btn-pause').textContent = '▶';
  ui.selected = { kind: 'blob', id: army.id };
  view.cx = army.x; view.cy = army.y; view.scale = scale;
  input.clampView();
  renderPanel(true);
  updateHUD();
  return { g, army };
}

// `?shot=formation-mixed` (#251) — a mixed army: attackers bracketing the
// suppliers and farmhands in their own blocks of rows. The composition is the
// whole point of the issue and is unreachable by URL otherwise.
function shotFormationMixed() {
  stageFormationGroup('shot251', { deploy: 9, supply: 6, farm: 4 }, 34);
}

// `?shot=formation-large` (#251) — a big pure-attack army, which is the only
// size that actually reaches the 10-per-row ceiling, at a zoom where the rear
// rows' dimming reads.
function shotFormationLarge() {
  stageFormationGroup('shot251b', { deploy: 34, supply: 0, farm: 0 }, 40);
}

// `?shot=formation-convert` (#251) — a mixed army RE-FORMING: the whole group
// arms up, so the suppliers and farmhands walk out of their own blocks and into
// the attackers' ranks instead of teleporting there.
//
// The role change is fired a beat AFTER the boot on purpose. The walk is a
// half-second animation from wherever the figures already stood, so issuing it
// before the first frame would leave nothing to walk from — the group would
// simply appear in its new shape. This way the still shows the re-formed group
// and the animated capture shows it re-forming. The op and its countdown are
// the real ones; the sim stays paused throughout.
function shotFormationConvert() {
  const staged = stageFormationGroup('shot251c', { deploy: 6, supply: 8, farm: 4 }, 40);
  if (!staged) return;
  const { g, army } = staged;
  setTimeout(() => {
    if (game !== g || army.dead) return;
    applyCommand(g, 0, { op: 'setRole', blobId: army.id, role: 'deploy' });
    // run the arm-up countdown out: finishConvert rewrites every role, which is
    // what moves the formation's targets and starts the walk
    const until = (army.convert ? army.convert.done : g.tick) + 1;
    while (g.tick < until && !g.result) S.step(g);
    renderPanel(true);
    updateHUD();
  }, 1200);
}

// `?shot=backtowork-guest` (#247) — the reported bug's seat. The "Back to work"
// badge read owner 0 whoever was looking, so the JOINING player saw the host's
// idle-farmhand count: the button appeared on the opponent's state and pressing
// it said "no idle farmers" over a non-zero number. That seat needs a live lobby
// and a second human, so it was unreachable by URL and invisible to tests. Here
// owner 1 (the joiner, whose view this is) has idle garrisoned farmhands and
// owner 0 has none — so a correct badge shows a count, and the old bug would
// hide the button entirely. Pure local UI state, no writes.
function shotBackToWorkGuest() {
  clearSaves();
  me = 1;
  const g = S.newGame('shot247', 'xsmall', 'normal', true);
  S.setViewer(g, 1);
  const mine = g.settlements.find(s => s.owner === 1 && !s.building);
  const theirs = g.settlements.find(s => s.owner === 0 && !s.building);
  if (!mine || !theirs) return;
  // my farmhands come off the fields and sit in the keep; the opponent's stay
  // out working, which is exactly the asymmetry the bug inverted
  applyCommand(g, 1, { op: 'garrisonRole', settlementId: mine.id, role: 'farm' });
  mine.garrison = { deploy: 0, supply: 0, farm: Math.max(4, mine.garrison.farm) };
  theirs.garrison = { deploy: 0, supply: 0, farm: 0 };
  startMatch(g);
  for (let i = 0; i < 3; i++) S.step(g);
  paused = true;
  $('btn-pause').textContent = '▶';
  view.cx = mine.x + 1; view.cy = mine.y + 1; view.scale = 26;
  input.clampView();
  renderPanel(true);
  updateHUD();
}

// ---------------------------------------------------------------- offline boot (#221)

// `?shot=offline-menu` renders the menu exactly as it looks with no
// connection: the badge, the multiplayer stand-in, the cached commander
// anchors and a "Yours" list with two pending results and one already
// recorded. In-memory only — like every ?shot= boot it writes nothing, so it
// is safe (and identical) in every environment.
// Set BEFORE the boot block below, so the offline shot never fires the very
// requests it is meant to depict.
function initOfflineShot() {
  const now = Date.now();
  offlineShot = {
    pending: 2,
    // stands in for the anchors this device would have cached from an earlier
    // online visit — the endpoint is public committed constants
    ai: [],
    local: [
      { client_id: 'staging-demo-off-1', result: 'win', difficulty: 'normal',
        duration_seconds: 1632, map_seed: 'staging-demo-off-1', ended_at: now - 60_000, synced: false },
      { client_id: 'staging-demo-off-2', result: 'loss', difficulty: 'veryhard',
        duration_seconds: 2480, map_seed: 'staging-demo-off-2', ended_at: now - 3_600_000, synced: false },
      { client_id: 'staging-demo-off-3', result: 'surrender', difficulty: 'hard',
        duration_seconds: 940, map_seed: 'staging-demo-off-3', ended_at: now - 7_200_000, synced: false, dropped: true },
    ],
  };
}

// The anchors come from the one public endpoint, then the panel re-renders —
// standing in for the copy a real device would have cached on an earlier
// online visit.
async function bootOfflineMenu() {
  try {
    const r = await fetch('/api/ai-ratings');
    if (r.ok) offlineShot.ai = (await r.json()).ai || [];
  } catch { /* the panel reads "unavailable", same as a real cold boot */ }
  await loadRatings();
}

// The service worker is what makes an offline boot possible at all. Skipped on
// ?shot= / ?demo=1 boots so the platform's screenshot states and previews
// behave exactly as they did before this landed.
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (SHOT || IS_DEMO) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => { });
  });
}

// ---------------------------------------------------------------- resume shots (#240)

// The menu's in-progress-match card renders from the signed-in player's OWN
// save row, so no seeded database state can reach it and no plain URL can
// reach it either — a reviewer with no match in progress sees nothing. These
// links pin the classifier's answer in memory instead: no fetch, no write, no
// localStorage, identical in staging and production, and immune to whose
// account is looking. Same discipline as the offline-menu and controls shots.
function initResumeShot(kind) {
  if (kind === 'resume-unreadable') {
    // one version past what this build can read — the "we couldn't restore it"
    // card, reachable without having to forge a save by hand
    saveShot = { code: 'too-new', data: null, source: 'local' };
    return;
  }
  const g = S.newGame('staging-demo-resume', 'small', 'normal');
  g.tick = 9000;
  const data = S.serialize(g);
  data.savedAt = Date.now() - 40_000;
  saveShot = { code: 'ok', data, source: 'local' };
}

if (typeof navigator !== 'undefined' && navigator.onLine === false) netDown = true;
if (SHOT === 'offline-menu') initOfflineShot();
// the two list shots seed their stand-in rows BEFORE the boot block below, so
// the first loadHistory() render already has them (#223)
if (SHOT === 'replay-list' || SHOT === 'replay-stale') {
  try { initReplayListShot(); } catch (e) { console.warn('shot link failed', e); }
}
if (SHOT === 'resume-card' || SHOT === 'resume-unreadable') {
  try { initResumeShot(SHOT); } catch (e) { console.warn('shot link failed', e); }
}
if (SHOT === 'session-expired') expiredShot = true;
refreshOfflineUi();
refreshOfflineCard();
registerServiceWorker();

// ---------------------------------------------------------------- auto-resume (#240)

// The page reloading is not something this app can prevent — the platform
// remounts its iframe, a phone drops a backgrounded tab, someone pulls to
// refresh. What it CAN do is make a reload cost nothing: if the breadcrumb
// says the last page went away mid-match, put the player straight back in.
//
// Deliberately local-only for solo: it must not wait on /api/save, because the
// whole point is to be back on screen before the player wonders where their
// match went. If the account's copy turns out to be fresher it is still one
// tap away on the menu after they exit.
//
// PvP goes first and goes fast — the server forfeits an absent player after
// 60 s, so this is the difference between a reload and a loss.
function autoResume() {
  if (!persistenceEnabled) return;   // preview boots never touch a real match
  if (game) return;                  // a deep link already opened something
  const session = RES.readSession(saveStore);
  const local = loadSaveData();
  if (!RES.shouldAutoResume(session, local.code, false)) return;

  if (session.mode === 'pvp') {
    // PvP is server-authoritative, so with no reachable account there is
    // nothing to rejoin — say that rather than firing a request that can only
    // fail. The breadcrumb stays, so the next boot tries again.
    if (!token || isOffline()) {
      showMenuError('You were in a multiplayer match — reconnect and use ⚔️ Rejoin match to get back in.');
      return;
    }
    rejoinLobby(session.lobbyId).then((ok) => {
      if (ok) toast('⚔️ Reconnected — you were away for a moment');
    }).catch(() => {
      // Couldn't reach it: leave the breadcrumb alone (the next boot, or the
      // menu's own Rejoin button, can still get them back in) and say so.
      showMenuError('Could not rejoin your multiplayer match automatically — try ⚔️ Rejoin match below.');
    });
    return;
  }

  // Resume PAUSED. The player has just been dropped back into a match they
  // didn't choose to leave; ambushing them with a running sim is worse than
  // making them press play.
  const at = fmtDur(S.gameSeconds(local.data.tick | 0));
  if (resumeSaved({ paused: true })) {
    toast(`↩️ Welcome back — resumed at ${at}. Press ▶ to continue.`);
  }
}

// ---------------------------------------------------------------- boot

refreshMenu();
refreshTutorialButton();
refreshControlsVisibility();
refreshServerSave();
refreshPlayerState(); // account-backed onboarding flags; re-renders when it lands
loadHistory();
loadRatings();
startMenuPolling();
flushOutbox();        // anything played offline since the last visit
autoResume();         // #240: the page went away mid-match — put it back
if (SHOT === 'offline-menu') {
  try { bootOfflineMenu(); } catch (e) { console.warn('shot link failed', e); }
}
// a `?shot=` boot goes straight into a match — the menu backdrop would
// only fetch a snapshot for a screen nobody sees
if (!params.get('shot')) startAttract();
if (SHOT === 'wall-garrison') {
  try { shotWallGarrison(); } catch (e) { console.warn('shot link failed', e); }
}
if (SHOT === 'in-combat') {
  try { shotInCombat(); } catch (e) { console.warn('shot link failed', e); }
}
if (SHOT === 'wall-start') {
  try { shotWallStart(); } catch (e) { console.warn('shot link failed', e); }
}
if (SHOT === 'wall-razed') {
  try { shotWallRazed(); } catch (e) { console.warn('shot link failed', e); }
}
if (SHOT === 'tile-under-farmer') {
  try { shotTileUnderFarmer(); } catch (e) { console.warn('shot link failed', e); }
}
if (SHOT === 'wall-under-siege') {
  try { shotWallUnderSiege(); } catch (e) { console.warn('shot link failed', e); }
}
if (BTN_SHOTS[SHOT]) {
  try { shotControlsButton(BTN_SHOTS[SHOT]); } catch (e) { console.warn('shot link failed', e); }
}
if (TOUR_SHOTS[SHOT]) {
  try { shotControlsTour(TOUR_SHOTS[SHOT]); } catch (e) { console.warn('shot link failed', e); }
}
if (SHOT === 'replay') {
  try { shotReplay().catch((e) => console.warn('shot link failed', e)); }
  catch (e) { console.warn('shot link failed', e); }
}
if (SHOT === 'replay-rewound') {
  try { shotReplayRewound().catch((e) => console.warn('shot link failed', e)); }
  catch (e) { console.warn('shot link failed', e); }
}
if (SHOT === 'walls-far') {
  try { shotWallsFar(); } catch (e) { console.warn('shot link failed', e); }
}
if (SHOT === 'place-preview' || SHOT === 'place-preview-touch') {
  try { shotPlacePreview(SHOT === 'place-preview-touch'); } catch (e) { console.warn('shot link failed', e); }
}
if (SHOT === 'stats' || SHOT === 'stats-one') {
  try { shotStats(SHOT === 'stats-one' ? 'units' : null); } catch (e) { console.warn('shot link failed', e); }
}
if (SHOT === 'stats-pvp-guest') {
  try { shotStatsPvpGuest(); } catch (e) { console.warn('shot link failed', e); }
}
if (SHOT === 'stats-gap') {
  try { shotStatsGap(); } catch (e) { console.warn('shot link failed', e); }
}
if (SHOT === 'attack-caravan') {
  try { shotAttackCaravan(); } catch (e) { console.warn('shot link failed', e); }
}
if (SHOT === 'merged-supply' || SHOT === 'merged-supply-armed' || SHOT === 'merged-supply-running') {
  try { shotMergedSupply(SHOT.slice('merged-supply-'.length) || null); }
  catch (e) { console.warn('shot link failed', e); }
}
if (SHOT === 'replay-end') {
  try { shotReplayEnd().catch((e) => console.warn('shot link failed', e)); }
  catch (e) { console.warn('shot link failed', e); }
}
if (SHOT === 'formation-mixed') {
  try { shotFormationMixed(); } catch (e) { console.warn('shot link failed', e); }
}
if (SHOT === 'formation-large') {
  try { shotFormationLarge(); } catch (e) { console.warn('shot link failed', e); }
}
if (SHOT === 'formation-convert') {
  try { shotFormationConvert(); } catch (e) { console.warn('shot link failed', e); }
}
if (SHOT === 'backtowork-guest') {
  try { shotBackToWorkGuest(); } catch (e) { console.warn('shot link failed', e); }
}
if (SHOT === 'replay-stale') {
  // the list, then its engine-changed dialog — so the message itself is
  // reachable from a URL for screenshots and tests
  try { renderMineRows([]); showEngineChangedDialog(); }
  catch (e) { console.warn('shot link failed', e); }
}

// Screenshot-state deep links (#200): the wall-garrison panel only exists
// mid-match on a selected wall, so no plain URL can reach it — screenshots
// and the "Test this change" button would land on the main menu. `?shot=`
// boots straight into a deterministic state: fixed seed, one finished
// garrisoned wall in home territory, that wall selected, sim paused so the
// readouts hold still. Pure UI state — nothing persists (the save is
// cleared, not written), so it works in every environment.
// `food` is TOTAL provisions: bellies fill first (garrison × 10), the rest
// becomes the supplies stash — so 79 with 4 units reads Well-fed on 40
// rations plus 🌾39 of supplies, showing both pools at once.
const SHOTS = {
  // a fed wall garrison: the fed word, a part-full stash, the runway, the
  // topped-up supply line and the role/field controls, all on screen
  'wall-panel': { food: 79, garrison: { deploy: 3, supply: 1, farm: 0 } },
  // both pools empty: Famished + the starving half-strength note
  'wall-panel-starving': { food: 0, garrison: { deploy: 3, supply: 1, farm: 0 } },
};
function bootShot(name) {
  const cfg = SHOTS[name];
  if (!cfg) return;
  try {
    clearSaves();
    me = 0;
    const g = S.newGame('shot-wall-panel', 'xsmall', 'normal');
    const home = g.settlements.find(s => s.owner === 0);
    if (!home) return;
    // nearest wall-legal tile inside the home territory, scanned in a
    // fixed order so the same seed always picks the same tile — starting
    // past the farmland ring so the tile's own 🌾 chip and rations bar
    // aren't crowded by the settlement's chips
    let spot = null;
    for (let r = 4; r <= S.C.TERRITORY && !spot; r++) {
      for (let dy = -r; dy <= r && !spot; dy++) {
        for (let dx = -r; dx <= r && !spot; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = home.x + 1 + dx, y = home.y + 1 + dy;
          if (x < 0 || y < 0 || x >= g.map.w || y >= g.map.h) continue;
          const res = S.canPlaceWall(g, 0, x, y);
          if (res.err || res.farm) continue; // farmland skipped (#219)
          if (S.inTerritory(g, home, x + 0.5, y + 0.5)) spot = { x, y };
        }
      }
    }
    if (!spot) return;
    const w = S.placeFinishedWall(g, 0, spot.x, spot.y, cfg.garrison, cfg.food);
    if (!w) return;
    startMatch(g);
    ui.selected = { kind: 'wall', id: w.id };
    view.cx = spot.x + 0.5; view.cy = spot.y + 0.5; view.scale = 26;
    paused = true;
    $('btn-pause').textContent = '▶';
    renderPanel(true);
    updateHUD();
  } catch (e) {
    console.error('shot boot failed', e);
  }
}
const shot = params.get('shot');
if (shot) bootShot(shot);
