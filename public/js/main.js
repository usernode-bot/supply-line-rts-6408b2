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
import { dist, fertTier, FERT_TIERS } from './mapgen.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const token = params.get('token') || '';
const apiHeaders = token ? { 'x-usernode-token': token } : {};
const SAVE_KEY = 'supply-line-save-v1';
const IS_DEMO = params.get('demo') === '1';

let game = null;
let view = { cx: 48, cy: 48, scale: 14 };
let speed = 1; // displayed speed step 1–4; the sim multiplier is speed × 0.5
let paused = false;
let ui = { selected: null, pending: null, routeSrc: null, splitCount: null, orderTarget: null, orderTargetEnt: null, fieldCounts: {}, recallCount: null, ping: null, buildSite: null, hover: null, touchMode: 'select' };

// Phone-sized UI (the sm breakpoint that turns the panel into a bottom
// sheet): mode toggle, contextual tap popups, stats-only panel. Desktop
// and ≥640px touch keep the classic interaction model.
const mqDesktop = window.matchMedia('(min-width: 640px)');
function isMobile() { return !mqDesktop.matches; }
mqDesktop.addEventListener('change', () => {
  lastPanelHTML = ''; // panel markup differs per breakpoint — force re-render
  if (game) { renderPanel(true); }
});
let renderer = null, input = null;
let groups = {};                      // control groups (#69): n -> {kind:'blobs', ids} | {kind:'settlement', id}
let lastGroupTap = { n: 0, t: 0 };    // for double-tap-to-center
let lastFrame = 0, acc = 0, lastSaveTick = 0, lastPanel = 0;
let resultPosted = false;
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
  const res = await fetch(path, opts);
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

async function loadHistory() {
  const mineEl = $('history-mine-rows'), recentEl = $('history-recent-rows');
  try {
    const res = await fetch('/api/matches', { headers: apiHeaders });
    if (!res.ok) {
      mineEl.textContent = 'Sign in via Usernode to see your matches.';
      recentEl.textContent = '—';
      return;
    }
    const { mine, recent } = await res.json();
    const tag = (m) => m.mode === 'pvp' ? `vs ${esc(m.opponent || '?')}` : esc(m.difficulty);
    mineEl.innerHTML = mine.length ? mine.map(m => `
      <div class="flex justify-between gap-2">
        <span class="${m.result === 'win' ? 'text-emerald-400' : 'text-red-400'}">${m.result === 'win' ? 'Victory' : m.result === 'surrender' ? 'Surrendered' : 'Defeat'}</span>
        <span class="text-zinc-500 truncate">${tag(m)}</span>
        <span class="font-mono text-zinc-500">${fmtDur(m.duration_seconds)}</span>
      </div>`).join('') : '<span class="text-zinc-600">No matches yet — start one above!</span>';
    recentEl.innerHTML = recent.length ? recent.map(m => `
      <div class="flex justify-between gap-2">
        <span class="truncate">${esc(m.username)}</span>
        <span class="text-zinc-500 truncate">${tag(m)}</span>
        <span class="font-mono text-zinc-500">${fmtDur(m.duration_seconds)}</span>
      </div>`).join('') : '<span class="text-zinc-600">No wins recorded yet.</span>';
  } catch {
    mineEl.textContent = 'Could not load match history.';
    recentEl.textContent = '—';
  }
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

function loadSaveData() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    // v1 saves predate per-unit health and are not migratable — discard.
    // v2–v4 saves load fine (new fields default; farmer HP is clamped;
    // old attack-move orders are migrated by deserialize).
    if (!(data.v >= 2 && data.v <= 4) || data.result || data.pvp) return null;
    return data;
  } catch { return null; }
}

function refreshMenu() {
  $('btn-resume').classList.toggle('hidden', !loadSaveData());
}

// Every difficulty plays by the player's economic rules — the levels
// differ only in how well the AI commander plays (see DIFF in sim.js).
const DIFF_HINTS = {
  easy: 'A careless commander.',
  normal: 'The standard opponent.',
  hard: 'Alert, well-supplied, and opportunistic.',
};
function refreshDifficultyHint() {
  $('difficulty-hint').textContent = DIFF_HINTS[$('sel-difficulty').value] || '';
}
$('sel-difficulty').addEventListener('change', refreshDifficultyHint);
refreshDifficultyHint();

function startNewMatch() {
  localStorage.removeItem(SAVE_KEY);
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
  if (loadSaveData()) {
    showConfirm('Match already in progress',
      'You have a match in progress. You can resume it, or discard it and start a new one.', [
      { label: '▶ Resume that match', cls: 'bg-emerald-700 hover:bg-emerald-600 text-white', fn: () => $('btn-resume').click() },
      { label: '🗑️ Discard & start new', cls: 'bg-red-700 hover:bg-red-600 text-white', fn: startNewMatch },
    ]);
    return;
  }
  startNewMatch();
});

$('btn-resume').addEventListener('click', () => {
  const data = loadSaveData();
  if (!data) { refreshMenu(); return; }
  try {
    me = 0;
    startMatch(S.deserialize(data));
  } catch (e) {
    localStorage.removeItem(SAVE_KEY);
    refreshMenu();
    showMenuError('Saved match could not be loaded — it was discarded.');
  }
});

// In-app confirm dialog — native confirm() is blocked inside the sandboxed
// platform iframe (it silently returns false), so never use it.
const confirmModal = $('confirm-modal');

function showConfirm(title, text, actions) {
  $('confirm-title').textContent = title;
  $('confirm-text').textContent = text;
  const box = $('confirm-actions');
  box.innerHTML = '';
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
  refreshLobbies();
  menuTimer = setInterval(refreshLobbies, 3000);
}
function stopMenuPolling() {
  if (menuTimer) { clearInterval(menuTimer); menuTimer = null; }
}

async function refreshLobbies() {
  if (game) return;
  let data;
  try {
    data = await api('/api/lobbies' + (IS_DEMO ? '?demo=1' : ''));
  } catch (e) {
    $('lobby-list').innerHTML = '<span class="text-zinc-600">Sign in via Usernode to play multiplayer.</span>';
    return;
  }
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

$('btn-mp-rejoin').addEventListener('click', async () => {
  if (!mineLobby) return;
  try {
    const st = await api(`/api/lobbies/${mineLobby.id}/state`);
    if (st.status !== 'active') { toast('That match is already over.'); refreshLobbies(); loadHistory(); return; }
    // the server owns the sim: rejoiners (either role) resume from its
    // latest snapshot and keep syncing like any other client
    beginPvp(st.role, st.id, st.opponent, st.snapshot || null);
  } catch (err) { toast(err.message); }
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
  };
  me = role === 'host' ? 0 : 1;
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
    game = g;
    // dead-reckon back toward where we were rendering (bounded catch-up):
    // a few ticks now, the rest credited to the frame accumulator so the
    // frame loop absorbs them instead of hitching here
    const ahead = Math.min(25, Math.max(0, prevTick - g.tick));
    let now = Math.min(5, ahead);
    while (now-- > 0 && !g.result) S.step(g);
    acc += Math.max(0, ahead - 5) * 100;
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

function doMove(b, x, y, target) {
  if (inPvp()) sendCmd({ op: 'move', blobId: b.id, x, y, target: target || null });
  return S.opMove(game, b, x, y, target);
}
function doSetRole(b, role) {
  if (inPvp()) sendCmd({ op: 'setRole', blobId: b.id, role });
  return S.opSetRole(game, b, role);
}
function doSplit(b, n) {
  if (inPvp()) sendCmd({ op: 'split', blobId: b.id, take: n });
  return S.opSplit(game, b, n);
}
function doBuild(b) {
  if (inPvp()) sendCmd({ op: 'build', blobId: b.id });
  return S.opBuild(game, b);
}
function doBuildAt(b, x, y) {
  if (inPvp()) sendCmd({ op: 'buildAt', blobId: b.id, x, y });
  return S.opBuildAt(game, b, x, y);
}
function doPillage(b, on) {
  if (inPvp()) sendCmd({ op: 'pillage', blobId: b.id, on: !!on });
  return S.opPillage(game, b, on);
}
function doRoute(b, target, sourceId) {
  if (inPvp()) sendCmd({ op: 'route', blobId: b.id, target, sourceId: sourceId == null ? null : sourceId });
  return S.opRoute(game, b, target, sourceId);
}
function doSetMode(st, mode) {
  if (inPvp()) sendCmd({ op: 'setMode', settlementId: st.id, mode });
  return S.opSetMode(game, st, mode);
}
function doFieldGarrison(st) {
  if (inPvp()) sendCmd({ op: 'fieldGarrison', settlementId: st.id });
  return S.opFieldGarrison(game, st);
}
function doFieldRole(st, role, n) {
  if (inPvp()) sendCmd({ op: 'fieldRole', settlementId: st.id, role, n });
  return S.opFieldRole(game, st, role, n);
}
function doGarrisonRole(st, role) {
  if (inPvp()) sendCmd({ op: 'garrisonRole', settlementId: st.id, role });
  return S.opGarrisonRole(game, st, role);
}
function doSupplyRoute(st, target) {
  if (inPvp()) sendCmd({ op: 'supplyRoute', settlementId: st.id, target });
  return S.opSupplyRoute(game, st, target);
}

// ---------------------------------------------------------------- match lifecycle

function startMatch(g) {
  stopAttract(); // the menu backdrop must cost nothing while playing
  game = g;
  resultPosted = false;
  ui = { selected: null, pending: null, routeSrc: null, splitCount: null, orderTarget: null, orderTargetEnt: null, fieldCounts: {}, recallCount: null, ping: null, buildSite: null, hover: null, touchMode: 'select' };
  groups = {};
  hideOrderPopup();
  acc = 0; speed = 1; paused = false; lastSaveTick = g.tick;
  $('sel-speed').value = '1';
  $('btn-pause').textContent = '⏸';
  // no pause / fast-forward in multiplayer — the sim is shared, and both
  // clients run it at the 1× default (speed stays forced to 1)
  $('btn-pause').classList.toggle('hidden', !!g.pvp);
  $('sel-speed').classList.toggle('hidden', !!g.pvp);
  updateOppLabel();
  stopMenuPolling();

  if (!renderer) {
    renderer = createRenderer($('game-canvas'), $('minimap'));
    input = createInput({
      canvas: $('game-canvas'), minimap: $('minimap'), view,
      handlers: {
        tap: onTap, box: onBox, rightClick: onRightClick, cancel: onCancel, gesture: onGesture, groupKey: onGroupKey,
        // phone Drag mode: a one-finger drag box-selects instead of panning
        touchBox: () => !!(game && !game.result && isMobile() && ui.touchMode === 'drag'),
      },
    });
  }
  input.setMapSize(g.map.w, g.map.h);
  const start = g.map.starts[me] || g.map.starts[0];
  view.cx = start.x + 2; view.cy = start.y;
  const cssW = window.innerWidth;
  view.scale = Math.max(10, Math.min(20, cssW / (cssW < 640 ? 22 : 30)));
  input.clampView();

  $('main-menu').classList.add('hidden');
  $('end-modal').classList.add('hidden');
  $('game-ui').classList.remove('hidden');
  renderer.resize();
  renderPanel(true);
  updateGroupsBar();
}

function backToMenu() {
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
  loadHistory();
  startMenuPolling();
  startAttract();
}

function saveGame() {
  if (!game || game.result || game.pvp) return;
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(S.serialize(game))); } catch { }
}

function showEndModal(win, reason) {
  $('end-emoji').textContent = win ? '🏆' : '🏳️';
  $('end-title').textContent = win ? 'Victory!' : (reason === 'surrender' ? 'Surrendered' : 'Defeat');
  const opp = mp ? mp.opponent : 'your opponent';
  const dur = game ? fmtDur(game.tick / 10) : '';
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
  $('end-modal').classList.remove('hidden');
}

// Solo-only: PvP results are decided by the server and surface through
// applySnapshot (authoritative snapshot result) or finishFromServer
// (sync status) — a locally predicted elimination just freezes the
// local sim until the server confirms or corrects it within a second.
function endMatch(result) {
  resultPosted = true;
  localStorage.removeItem(SAVE_KEY);
  const win = result === 'win';
  $('end-emoji').textContent = win ? '🏆' : '🏳️';
  $('end-title').textContent = win ? 'Victory!' : result === 'surrender' ? 'Surrendered' : 'Defeat';
  $('end-detail').textContent = win
    ? `Enemy settlements razed and their last forces scattered in ${fmtDur(game.tick / 10)}.`
    : `Your war effort collapsed after ${fmtDur(game.tick / 10)}.`;
  $('end-modal').classList.remove('hidden');
  // fire-and-forget record
  fetch('/api/match-result', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...apiHeaders },
    body: JSON.stringify({
      result,
      difficulty: game.difficulty,
      duration_seconds: Math.round(game.tick / 10),
      map_seed: game.seed,
    }),
  }).catch(() => { });
}

$('btn-end-menu').addEventListener('click', backToMenu);
$('btn-surrender').addEventListener('click', () => {
  if (!game || game.result) return;
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
$('btn-pause').addEventListener('click', () => {
  if (game && game.pvp) return;
  paused = !paused;
  $('btn-pause').textContent = paused ? '▶' : '⏸';
});
$('sel-speed').addEventListener('change', () => {
  if (game && game.pvp) { $('sel-speed').value = '1'; return; }
  speed = Math.max(1, Math.min(4, +$('sel-speed').value || 1));
  // a focused <select> counts as text entry to the key handler and would
  // swallow WASD panning — hand focus back to the map
  $('sel-speed').blur();
});
$('btn-backtowork').addEventListener('click', () => {
  if (!game || game.result) return;
  const r = S.opBackToWork(game, 0);
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

document.addEventListener('visibilitychange', () => { if (document.hidden) saveGame(); });
window.addEventListener('beforeunload', saveGame);

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

function onTap(world, pointerType, screen) {
  if (!game || game.result) return;
  const hitR = 24 / view.scale;
  if (ui.pending) { resolvePending(world, pointerType, screen); return; }
  // a tap while the order popup is open only dismisses it
  if (!orderPopup.classList.contains('hidden')) { hideOrderPopup(); return; }
  // the phone UI's contextual tap model (Select/Drag modes)
  const mobile = isMobile() && pointerType !== 'mouse';
  const sel = mobile ? selectedBlobs() : null;
  // Drag mode (phones) is drag-only: one-finger boxes build up the group
  // across as many drags as it takes, and every order waits for Select
  // mode. The one live tap target is an own settlement, which switches
  // the active selection to it.
  if (mobile && ui.touchMode === 'drag') {
    const dst = S.settlementAt(game, world.x, world.y, Math.max(1.9, hitR));
    if (dst && dst.owner === me) {
      ui.selected = { kind: 'settlement', id: dst.id };
      renderPanel(true);
    }
    return;
  }
  // prefer own blob, then own settlement
  let b = S.blobAt(game, world.x, world.y, hitR);
  const eb = b && b.owner !== me ? b : null;
  if (b && b.owner !== me) b = null;
  if (b) {
    // tapping a blob that's already in the selection → its action popup
    if (mobile && sel.some(s => s.id === b.id)) { showUnitOptions(screen); return; }
    // Select mode with units in hand: tapping another friendly blob asks
    // Select / Move / Deselect instead of silently swapping the selection,
    // so a stray tap near a group can't lose what's already picked. With
    // nothing selected there's nothing to lose — select it directly.
    if (mobile && sel.length > 0) { showSelectPopup(b, screen); return; }
    ui.selected = { kind: 'blob', id: b.id };
    renderPanel(true);
    return;
  }
  const st = S.settlementAt(game, world.x, world.y, Math.max(1.9, hitR));
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
    showOrderPopup(world, screen, findEnemyTargetAt(world));
    return;
  }
  // tap elsewhere with blobs selected → inline order popup at the tap
  // point; a tapped enemy blob/settlement becomes a direct attack target.
  // Mouse skips this (#79): on desktop left-click only selects/inspects —
  // right-click is the order button. (≥640px touch only — phones use the
  // mode-based dispatch above.)
  if (!mobile && pointerType !== 'mouse' && selectedBlobs().length > 0) { showOrderPopup(world, screen, findEnemyTargetAt(world)); return; }
  // nothing selected → inspect what was tapped
  if (eb && S.isVisible(game, eb.x, eb.y)) {
    ui.selected = { kind: 'enemy-blob', id: eb.id };
    renderPanel(true);
    return;
  }
  const known = game.pvp ? game.knowns[me] : game.known;
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
  hideOrderPopup();
  // a box while an order is armed is clearly a selection gesture, not a
  // destination — drop the pending state (incl. build placement)
  if (ui.pending) {
    ui.pending = null;
    ui.buildSite = null;
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

// Enemy entity under a world point that the current player may target
// directly: a visible enemy blob, or an enemy settlement that is visible
// or remembered on the map.
function findEnemyTargetAt(world) {
  const hitR = Math.max(1.5, 24 / view.scale);
  const eb = S.blobAt(game, world.x, world.y, hitR);
  if (eb && eb.owner !== me && S.isVisible(game, eb.x, eb.y)) return { kind: 'blob', id: eb.id };
  const st = S.settlementAt(game, world.x, world.y, Math.max(1.9, hitR));
  const known = game.pvp ? game.knowns[me] : game.known;
  if (st && st.owner !== me && (S.settVisible(game, st) || known[st.id])) {
    return { kind: 'settlement', id: st.id };
  }
  return null;
}

function onRightClick(world) {
  if (!game || game.result) return;
  hideOrderPopup();
  const blobs = selectedBlobs();
  if (!blobs.length) return;
  orderMove(blobs, world, findEnemyTargetAt(world));
}

// Shared move dispatch: issue the order to every selected blob, ping the
// destination, and confirm field assignments (#111) so a farmland click
// visibly reads as "go work that plot", not a plain move.
function orderMove(blobs, world, target) {
  let err = null, ok = 0, fielded = 0;
  for (const b of blobs) {
    const r = doMove(b, world.x, world.y, target);
    if (r.err) err = r.err;
    else { ok++; fielded += r.fielded || 0; }
  }
  if (ok) pingOrder(world, target);
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
    return true;
  }
  const blobs = selectedBlobs();
  if (blobs.length) {
    groups[n] = { kind: 'blobs', ids: blobs.map(b => b.id) };
    toast(`Group ${n} set — ${blobs.length} blob${blobs.length === 1 ? '' : 's'}`);
    return true;
  }
  return false;
}

// Select group n; a second select within 450 ms also centers the camera.
function selectGroup(n) {
  const r = resolveGroup(n);
  if (!r) return;
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
  if (!game || game.result) return;
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
  const canAssign = ui.selected && (ui.selected.kind === 'blob' || ui.selected.kind === 'multi' || ui.selected.kind === 'settlement');
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
  if (!game || game.result) return;
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
  hideOrderPopup();
}

function onCancel() {
  if (ui.pending) {
    ui.pending = null;
    ui.buildSite = null;
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
  // float above the bottom-sheet panel + unit strip
  let bottom = 8;
  if (!panel.classList.contains('hidden')) bottom += panel.offsetHeight;
  const strip = $('unit-strip');
  if (!strip.classList.contains('hidden')) bottom += strip.offsetHeight;
  el.style.bottom = bottom + 'px';
}

$('mode-toggle').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn || !game) return;
  ui.touchMode = btn.id === 'btn-mode-drag' ? 'drag' : 'select';
  if (btn.id === 'btn-mode-drag') {
    // Drag always starts a fresh group: drop any selected units and any
    // armed order (every tap of the button, not just mode changes)
    if (ui.selected && (ui.selected.kind === 'blob' || ui.selected.kind === 'multi')) ui.selected = null;
    ui.pending = null;
    ui.buildSite = null;
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
  ui.orderTarget = world;
  ui.orderTargetEnt = target || null;
  const hasDeploy = selectedBlobs().some(b => b.count.deploy > 0);
  const atkLabel = target && target.kind === 'blob' ? '⚔️ Attack blob' : '⚔️ Attack settlement';
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
let tapBlobId = null;
function showSelectPopup(b, screen) {
  ui.orderTarget = { x: b.x, y: b.y };
  ui.orderTargetEnt = null;
  tapBlobId = b.id;
  orderPopup.innerHTML = `
    <button data-act="pmove" class="btn px-3 rounded-lg text-left bg-zinc-800 hover:bg-zinc-700">📍 Move here</button>
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
  ui.orderTarget = null;
  ui.orderTargetEnt = null;
  splitHoldConsumed = false;
  const tot = blobs.reduce((s, b) => s + S.total(b), 0);
  const cnt = { deploy: 0, supply: 0, farm: 0 };
  for (const b of blobs) { cnt.deploy += b.count.deploy; cnt.supply += b.count.supply; cnt.farm += b.count.farm; }
  const pureSupply = cnt.supply === tot && tot > 0;
  const atHome = blobs.some(b => S.isAtHome(game, b));
  const pillaging = blobs.some(b => b.pillaging);
  const canSplit = blobs.length === 1 && tot >= 2;
  const canBuild = tot >= S.C.SETT_COST;
  orderPopup.innerHTML = `
    <button data-act="pmovearm" class="btn px-3 rounded-lg text-left bg-zinc-800 hover:bg-zinc-700">📍 Move…</button>
    <button data-act="ppillage" class="btn px-3 rounded-lg text-left ${pillaging ? 'bg-orange-700 text-white' : 'bg-zinc-800 hover:bg-zinc-700'}">🔥 ${pillaging ? 'Stop pillaging' : 'Pillage'}</button>
    ${canSplit ? `<button data-act="psplit" style="touch-action:none" class="btn px-3 rounded-lg text-left bg-zinc-800 hover:bg-zinc-700">✂️ Split ${Math.floor(tot / 2)} / ${tot} <span class="text-xs text-zinc-500">(hold to adjust)</span></button>` : ''}
    <button data-act="pbuildarm" ${canBuild ? '' : 'disabled'} class="btn px-3 rounded-lg text-left ${canBuild ? 'bg-zinc-800 hover:bg-zinc-700' : 'bg-zinc-800 text-zinc-500 opacity-40'}">🏠 Build (${S.C.SETT_COST})</button>
    ${pureSupply ? '<button data-act="proutearm" class="btn px-3 rounded-lg text-left bg-sky-800 hover:bg-sky-700">🚚 Supply route…</button>' : ''}
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

function attachSplitHold(btn) {
  let timer = null, sliding = false, holdX = 0, lastX = 0, value = 1, maxV = 1, totNow = 2, row = null, fill = null, pxPerUnit = 4;

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
      holdX = lastX;
      totNow = S.total(b2);
      maxV = totNow - 1;
      value = Math.max(1, Math.min(maxV, Math.floor(totNow / 2)));
      row = document.createElement('div');
      row.className = 'px-1 pb-1';
      row.innerHTML = '<div class="h-2 rounded bg-zinc-700 overflow-hidden"><div class="h-full bg-violet-500"></div></div>';
      btn.insertAdjacentElement('afterend', row);
      fill = row.firstElementChild.firstElementChild;
      // px per unit from the track width, floored so huge groups stay controllable
      pxPerUnit = Math.max(3, (orderPopup.offsetWidth - 12) / Math.max(1, maxV - 1));
      update();
    }, 350);
    e.preventDefault();
  });

  btn.addEventListener('pointermove', (e) => {
    lastX = e.clientX;
    if (!sliding) return;
    if (orderPopup.classList.contains('hidden')) { abort(); return; } // dismissed mid-hold
    const start = Math.max(1, Math.min(maxV, Math.floor(totNow / 2)));
    value = Math.max(1, Math.min(maxV, start + Math.round((e.clientX - holdX) / pxPerUnit)));
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

// Touch build placement (#94): the armed outline sits at ui.buildSite;
// this floating ✓/✕ pair beside it commits or abandons the site. Re-taps
// on the map move the outline (resolvePending runs before the popup's
// tap-dismiss check in onTap), so the popup just follows the last tap.
function showBuildConfirm(screen) {
  ui.orderTarget = null;
  ui.orderTargetEnt = null;
  const ok = ui.buildSite && ui.buildSite.ok;
  orderPopup.innerHTML = `
    <button data-act="pbuild" class="btn px-3 rounded-lg text-left ${ok ? 'bg-emerald-700 hover:bg-emerald-600 text-white' : 'bg-zinc-800 text-zinc-500 opacity-40'}" ${ok ? '' : 'disabled'}>✓ Found here</button>
    <button data-act="pbuildx" class="btn px-3 rounded-lg text-left bg-zinc-900 text-zinc-400 hover:bg-zinc-800">✕ Cancel</button>`;
  orderPopup.classList.remove('hidden');
  const px = screen ? screen.x : window.innerWidth / 2;
  const py = screen ? screen.y : window.innerHeight / 2;
  const w = orderPopup.offsetWidth, h = orderPopup.offsetHeight;
  orderPopup.style.left = Math.max(4, Math.min(window.innerWidth - w - 4, px + 10)) + 'px';
  orderPopup.style.top = Math.max(4, Math.min(window.innerHeight - h - 4, py - h / 2)) + 'px';
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
  let ok = 0, err = null;
  for (const c of carriers) {
    const r = doRoute(c, target, sourceId);
    if (r.err) err = r.err; else ok++;
  }
  if (ok) {
    // name the destination (#142) so a mis-tap is visible, not a mystery
    let dest = 'your army';
    if (target.kind === 'settlement') {
      const st = game.settlements.find(s => s.id === target.id);
      dest = (st && st.name) || 'settlement';
      if (st) pingRoute(st.x + 1, st.y + 1);
    } else {
      const tb = findBlob(target.id);
      if (tb) pingRoute(tb.x, tb.y);
    }
    toast(ok > 1 ? `🚚 ${ok} caravans on the supply line → ${dest}` : `🚚 Supply route established → ${dest}`);
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
  const act = btn.dataset.act;
  const world = ui.orderTarget;
  const targetEnt = ui.orderTargetEnt;
  hideOrderPopup();
  if (act === 'pbuild') { confirmBuild(); return; }
  if (act === 'pbuildx') { onCancel(); renderPanel(true); return; }
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
  orderMove(selectedBlobs(), world, target);
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
  const pending = ui.pending;
  ui.pending = null;
  updateHint();
  const blobs = selectedBlobs();
  if (pending === 'move') {
    if (!blobs.length) return;
    orderMove(blobs, world, findEnemyTargetAt(world)); // tapping an enemy targets it
  } else if (pending === 'route') {
    // supply routes take two taps (#131): first the source settlement the
    // caravans load from, then the destination. All selected pure-supply
    // blobs join the same line (#133).
    const carriers = blobs.filter(b => S.total(b) > 0 && b.count.supply === S.total(b));
    if (!carriers.length) { ui.routeSrc = null; return; }
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
    let tgt = null;
    if (!st) {
      tgt = S.blobAt(game, world.x, world.y, hitR);
      if (tgt && (tgt.owner !== me || tgt.working != null || carriers.some(c => c.id === tgt.id))) tgt = null;
      if (!tgt) {
        st = S.settlementAt(game, world.x, world.y, Math.max(1.9, hitR));
        if (st && st.owner !== me) st = null;
      }
    }
    if (tgt) {
      dispatchRoutes(carriers, { kind: 'blob', id: tgt.id }, srcId);
    } else if (st && st.id === srcId) {
      toast('Route must lead away from its source');
    } else if (st) {
      dispatchRoutes(carriers, { kind: 'settlement', id: st.id }, srcId);
    } else {
      toast('Tap a friendly army or settlement to supply');
    }
  } else if (pending === 'route-sett') {
    // settlement-to-settlement supply line (#108): source is the
    // settlement that armed the pending, target is the tapped entity
    const src = game.settlements.find(s2 => s2.id === ui.routeSrc && s2.owner === me && !s2.building);
    ui.routeSrc = null;
    if (!src) return;
    const hitR = Math.max(1.5, 24 / view.scale);
    const stT = S.settlementAt(game, world.x, world.y, Math.max(1.9, hitR));
    if (stT && stT.owner === me && stT.id !== src.id && !stT.building) {
      const r = doSupplyRoute(src, { kind: 'settlement', id: stT.id });
      if (!r.err) pingRoute(stT.x + 1, stT.y + 1);
      toast(r.err ? r.err : '🚚 Supply route established');
    } else {
      const tgt = S.blobAt(game, world.x, world.y, hitR);
      if (tgt && tgt.owner === me && tgt.working == null) {
        const r = doSupplyRoute(src, { kind: 'blob', id: tgt.id });
        if (!r.err) pingRoute(tgt.x, tgt.y);
        toast(r.err ? r.err : '🚚 Supply route established');
      } else {
        toast('Tap a friendly settlement or army to supply');
      }
    }
  }
  renderPanel(true);
}

function updateHint() {
  const el = $('hint');
  if (!ui.pending) { el.classList.add('hidden'); return; }
  const text = ui.pending === 'move' ? 'Tap a destination — or an enemy to attack…'
    : ui.pending === 'build'
      ? (ui.buildSite ? 'Tap ✓ to found here — or tap elsewhere to move the site'
        : 'Tap where to found the settlement…')
      : ui.pending === 'route-sett'
        ? 'Tap the destination settlement (or army) to supply…'
        : ui.routeSrc != null
          ? 'Tap the destination — a friendly settlement or army…'
          : 'Tap the source settlement to load from…';
  $('hint-text').textContent = text;
  el.classList.remove('hidden');
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
    case 'pillage': {
      for (const b of blobs) doPillage(b, !b.pillaging);
      break;
    }
    case 'mode': if (st) doSetMode(st, btn.dataset.mode); break;
    case 'settroute': {
      // settlement-to-settlement supply line (#108): arm target pick
      if (st && st.garrison.supply > 0) {
        ui.pending = 'route-sett';
        ui.routeSrc = st.id;
        updateHint();
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
    case 'fieldn': {
      if (st) {
        const role = btn.dataset.role;
        const n = Math.max(1, Math.min(st.garrison[role], ui.fieldCounts[role] || 1));
        r = doFieldRole(st, role, n);
        if (r.err) toast(r.err);
      }
      break;
    }
    case 'recall': {
      if (st) {
        // partial recall (#68): the slider picks how many field hands come
        // home; the farthest-out farmers return first so the close fields
        // stay manned
        const workers = game.blobs
          .filter(b => !b.dead && b.owner === me && b.working === st.id)
          .sort((a, b2) => dist(b2.x, b2.y, st.x + 1, st.y + 1) - dist(a.x, a.y, st.x + 1, st.y + 1));
        const n = Math.max(1, Math.min(workers.length, ui.recallCount || workers.length));
        let c = 0;
        for (const b of workers.slice(0, n)) {
          if (doMove(b, st.x + 1, st.y + 1).ok) c++;
        }
        toast(c ? `🏠 Recalling ${c} farmer${c === 1 ? '' : 's'}` : 'No farmers working the fields');
      }
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

// Seconds of real time until a pending arm-up (#108) completes, at the
// current display speed (sim runs at speed × 0.5 of native ticks).
function convertEta(convert) {
  const ticks = Math.max(0, convert.done - game.tick);
  return Math.max(1, Math.ceil(ticks / (10 * Math.max(0.25, speed * 0.5))));
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
  // phones: the panel is a bottom sheet, so the strip sits directly above it
  strip.style.bottom = window.matchMedia('(min-width: 640px)').matches
    ? '' : (panel.classList.contains('hidden') ? 0 : panel.offsetHeight) + 'px';
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
  if (ui.selected && ui.selected.kind === 'tile') {
    const i = ui.selected.i;
    panel.classList.remove('hidden');
    if (game.map.mountain[i]) {
      setPanelHTML(`
        <div class="font-semibold mb-1">⛰️ Mountain</div>
        <div class="text-xs text-zinc-400">Impassable terrain. Nothing grows here.</div>`);
    } else if (game.settAt[i]) {
      const so = game.settlements.find(s => s.id === game.settAt[i]);
      const mine2 = so && so.owner === me;
      setPanelHTML(`
        <div class="font-semibold mb-1 ${mine2 ? 'text-violet-300' : 'text-red-300'}">🏠 Settlement grounds</div>
        <div class="text-xs text-zinc-400">Built over — not farmland. Part of ${mine2 ? 'your settlement' : 'an enemy settlement'}${so && so.name ? `, <b>${so.name}</b>` : ''}.</div>`);
    } else {
      const f = game.map.fert[i], o = game.map.orig[i];
      const tier = fertTier(f), otier = fertTier(o);
      const label = FERT_TIERS[tier];
      const tb = game.tilledBy[i] ? game.settlements.find(s => s.id === game.tilledBy[i]) : null;
      setPanelHTML(`
        <div class="flex items-center justify-between mb-1">
          <span class="font-semibold">🟩 ${label} land</span>
          <span class="text-xs text-zinc-400">Fertility <b class="text-emerald-300">tier ${tier}/4</b>${tier < otier ? ` <span class="text-zinc-500">was ${otier}/4</span>` : ''}</span>
        </div>
        <div class="h-2 rounded bg-zinc-800 overflow-hidden mb-2"><div class="h-full bg-emerald-500" style="width:${tier * 25}%"></div></div>
        ${tb ? `<div class="text-xs ${tb.owner === me ? 'text-amber-300' : 'text-red-400'} mb-1">🌾 ${tb.owner === me ? 'Farmland of your settlement' : 'Enemy farmland'}</div>` : ''}
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
      <div class="text-xs text-zinc-400">The founding party is building. It produces nothing, feeds no one and trains no units until the bar is full — and enemies can attack it the whole time. Construction health climbs to ${S.C.SETT_HP}; damage taken now sets it back.</div>`);
    return;
  }

  if (st) {
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
    const hpBarPct = Math.max(0, Math.min(100, Math.round(100 * st.hp / S.C.SETT_HP)));
    const hpBarCol = hpBarPct >= 75 ? 'bg-emerald-500' : hpBarPct >= 40 ? 'bg-amber-500' : 'bg-red-500';
    setPanelHTML(`
      <div class="flex items-center justify-between mb-1">
        <span class="font-semibold">🏠 ${st.name || 'Settlement'}</span>
        <span class="text-xs ${st.hp < S.C.SETT_HP ? 'text-red-400' : 'text-zinc-500'}">HP ${Math.ceil(st.hp)}/${S.C.SETT_HP}</span>
      </div>
      <div class="h-2 rounded bg-zinc-800 overflow-hidden mb-2"><div class="h-full ${hpBarCol}" style="width:${hpBarPct}%"></div></div>
      ${S.besieged(game, st) ? '<div class="text-xs text-amber-400 mb-1">⏳ <b>Besieged</b> — no farm income, supply deliveries blocked. The garrison eats from the stockpile: break the siege or watch the clock.</div>' : ''}
      <div class="text-xs text-zinc-400 mb-1">Stockpile <b class="text-amber-300">${Math.floor(st.stockpile)}</b> / ${S.C.STOCK_CAP} 🌾
        · ${fmtRate(gross)}/s · net <b class="${Math.round(net * 10) / 10 >= 0 ? 'text-emerald-400' : 'text-red-400'}">${fmtRate(net)}/s</b></div>
      <div class="mb-2 pl-2 border-l border-zinc-800">${flowRows}</div>
      <div class="text-xs text-zinc-500 mb-1">Production mode${isMobile() ? '' : " (sets new units' role)"}</div>
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
      ${isMobile() ? '' : `<div class="text-xs text-zinc-500 mt-1">Each worked plot pays its own fertility — farmers claim the lushest free plot first, and two farmers on one plot don't double it. Unworked farmland only yields a small built-in base worth ${S.C.FARM_BASE_FARMERS} farmers. Plots poorer than Sparse aren't worth manning; farm growth stops once every worthwhile plot is worked. Sheltered, garrisoned or still-walking farmers earn nothing yet. Worked plots also heal scorched land fast — about one fertility level per 45 s.</div>`}
      <div class="mt-2 pt-2 border-t border-zinc-800">
        <div class="text-xs text-zinc-500 mb-1">Garrison: ⚔️${g.deploy} 🚚${g.supply} 🌱${g.farm}</div>
        ${gTot > 0 ? `
          <div class="flex gap-1 mb-2">
            ${roleBtn('deploy', '⚔️', false, false)}${roleBtn('supply', '🚚', false, false)}${roleBtn('farm', '🌱', false, false)}
          </div>
          ${st.convert ? `<div class="text-xs text-amber-400 mb-1">⚔️ Garrison arming… ready in ~${convertEta(st.convert)}s (fielding cancels)</div>` : ''}
          ${fieldRows}
          ${g.supply >= 1 ? '<button data-act="settroute" class="btn w-full rounded bg-sky-800 hover:bg-sky-700 mt-1">🚚 Supply route to another settlement…</button>' : ''}
          <button data-act="field" class="btn w-full rounded bg-zinc-700 hover:bg-zinc-600 mt-1">Field garrison (${gTot})</button>
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
  const atHome = blobs.some(b => S.isAtHome(game, b));
  const fedColor = meter >= 0.75 ? 'text-emerald-400' : meter >= 0.5 ? 'text-lime-400' : meter >= 0.25 ? 'text-amber-400' : 'text-red-400';
  const onRoute = !multi && b0.order && b0.order.type === 'route';
  // group build (#130): an under-strength founding party holding its site
  const waitingBuild = blobs.some(b => b.order && b.order.type === 'move' && b.order.build && b.order.waiting);
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
    <div class="text-xs text-zinc-400 mb-2">⚔️ ${cnt.deploy} deploy · 🚚 ${cnt.supply} supply · 🌱 ${cnt.farm} farmer${onRoute ? ` · <span class="text-sky-300">on supply route · 🌾 ${Math.round(b0.order.cargo || 0)} / ${S.total(b0) * SUP.CARRY_PER_UNIT}</span>` : ''}${blobs.some(b => b.pillaging) ? ' · <span class="text-orange-400">pillaging</span>' : ''}${waitingBuild ? ` · <span class="text-amber-300">⏳ waiting for settlers (${tot}/${S.C.SETT_COST})</span>` : ''}${!multi && b0.working != null ? ' · <span class="text-emerald-300">working the fields</span>' : ''}</div>
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
      <button data-act="route" class="btn rounded ${pureSupply ? 'bg-sky-800 hover:bg-sky-700' : 'bg-zinc-800 opacity-40'}" ${pureSupply ? '' : 'disabled'}>🚚 Supply route…</button>
    </div>
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
  $('stat-time').textContent = fmtDur(game.tick / 10);
  const idle = S.idleFarmers(game, 0);
  const idleN = idle.field + idle.walk;
  const btw = $('btn-backtowork');
  btw.classList.toggle('hidden', idleN === 0 || !!game.result);
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

function frame(ts) {
  requestAnimationFrame(frame);
  const dt = Math.min(100, ts - lastFrame || 16);
  lastFrame = ts;
  if (!game) return;

  if (!paused && !game.result) {
    // displayed speed steps 1–4 map to 0.5×–2× of the sim's native tick
    // rate: 1× is the half-speed default, 2× the old normal. PvP always
    // runs at step 1, so both clients share the same 0.5 multiplier.
    acc += dt * speed * 0.5;
    let iter = 0;
    while (acc >= 100 && iter++ < 40) {
      S.step(game);
      if (!game.pvp && game.tick % 20 === 0) aiTick(game, S);
      acc -= 100;
    }
    if (acc >= 100) acc = 0; // fell behind (background tab); drop the backlog
  }

  input.update(dt);
  // desktop build-placement preview follows the mouse (#94)
  ui.hover = ui.pending === 'build' ? input.mouseWorld : null;
  renderer.draw(game, view, ui, Math.max(0, Math.min(1, acc / 100)));

  if (ts - lastPanel > 400) {
    lastPanel = ts;
    updateHUD();
    renderPanel(false);
  }
  if (!game.pvp && game.tick - lastSaveTick >= 300) {
    lastSaveTick = game.tick;
    saveGame();
  }
  if (game.result && !resultPosted && !game.pvp) endMatch(game.result);
}

requestAnimationFrame(frame);

// ---------------------------------------------------------------- boot

refreshMenu();
loadHistory();
startMenuPolling();
startAttract();
