// Boot, menu wiring, match lifecycle, HUD + selection panel, autosave,
// multiplayer lobbies (host-authoritative snapshot sync over polling).

import * as S from './sim.js';
import { aiTick } from './ai.js';
import { createRenderer } from './render.js';
import { createInput } from './input.js';
import { dist, fertTier, FERT_TIERS } from './mapgen.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const token = params.get('token') || '';
const apiHeaders = token ? { 'x-usernode-token': token } : {};
const SAVE_KEY = 'supply-line-save-v1';
const IS_DEMO = params.get('demo') === '1';

let game = null;
let view = { cx: 48, cy: 48, scale: 14 };
let speed = 1;
let paused = false;
let ui = { selected: null, pending: null, splitCount: null, orderTarget: null, fieldCounts: {} };
let renderer = null, input = null;
let lastFrame = 0, acc = 0, lastSaveTick = 0, lastPanel = 0;
let resultPosted = false;
let panelHeld = false;
let toastTimer = null;
let lastPanelHTML = '';

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

function isGuest() { return mp && mp.role === 'guest'; }

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

function loadSaveData() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    // v1 saves predate per-unit health and are not migratable — discard.
    // v2 saves load fine (new fields default; farmer HP is clamped).
    if ((data.v !== 2 && data.v !== 3) || data.result || data.pvp) return null;
    return data;
  } catch { return null; }
}

function refreshMenu() {
  $('btn-resume').classList.toggle('hidden', !loadSaveData());
}

$('btn-new').addEventListener('click', () => {
  if (waiting) { showMenuError('Cancel your multiplayer lobby first.'); return; }
  if (loadSaveData() && !confirm('Starting a new match discards your saved match. Continue?')) return;
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
      <span class="text-xs text-zinc-500">${esc(l.size_key)} · ${lobbyAge(l.created_at)}</span>
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
      <span class="text-sm text-violet-100">⚔️ <b>${esc(c.host_username)}</b> challenges you! <span class="text-violet-300">(${esc(c.size_key)} map)</span></span>
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
    r = await api(`/api/lobbies/${waiting.id}/sync`, { commandsAfter: 0, tick: 0 });
  } catch { return; }
  if (!waiting) return;
  if (r.status === 'active') {
    const lobby = waiting.lobby;
    stopWaiting();
    startPvpHost(lobby, r.guest_username);
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
    if (st.role === 'host') {
      let g;
      if (st.snapshot) {
        g = S.deserialize(st.snapshot);
      } else {
        g = S.newGame(st.seed, st.size_key, 'normal', true);
      }
      // skip commands already applied before the reload — the snapshot
      // reflects them; replaying would double splits/builds
      beginPvp('host', st.id, st.opponent, g, st.last_command_id || 0);
    } else {
      startPvpGuest(st.id, st.opponent);
    }
  } catch (err) { toast(err.message); }
});

// ---------------------------------------------------------------- pvp session

function startPvpHost(lobby, guestName) {
  const g = S.newGame(lobby.seed, lobby.size_key, 'normal', true);
  beginPvp('host', lobby.id, guestName, g);
}

function beginPvp(role, lobbyId, opponent, g, lastCmdId) {
  stopMpTimers();
  mp = {
    lobbyId, role, opponent: opponent || '…',
    lastCmdId: lastCmdId || 0, pollN: 0, outQueue: [], guestEvents: [],
    lastSnapTick: -1, oppSeen: null, ended: false, busy: false,
    finalSnapSent: false, noSnapPolls: 0,
  };
  me = role === 'host' ? 0 : 1;
  if (g) {
    S.setViewer(g, me);
    startMatch(g);
  }
  if (role === 'host') {
    hostSync(true);
    mp.timer = setInterval(() => hostSync(false), 1000);
  } else {
    guestSync();
    mp.timer = setInterval(guestSync, 1000);
  }
}

function startPvpGuest(lobbyId, hostName) {
  beginPvp('guest', lobbyId, hostName, null);
  toast('⚔️ Joining match…');
}

function stopMpTimers() {
  if (mp && mp.timer) { clearInterval(mp.timer); mp.timer = null; }
}

function buildSnapshot() {
  const snap = S.serialize(game);
  snap.netEvents = mp.guestEvents.splice(0);
  return snap;
}

async function hostSync(force) {
  if (!mp || mp.busy) return;
  mp.busy = true;
  try {
    mp.pollN++;
    const body = { commandsAfter: mp.lastCmdId, tick: game ? game.tick : 0 };
    const wantSnap = force || mp.pollN % 2 === 0 || (game && game.result && !mp.finalSnapSent);
    if (wantSnap && game) {
      body.snapshot = buildSnapshot();
      if (game.result) mp.finalSnapSent = true;
    }
    const r = await api(`/api/lobbies/${mp.lobbyId}/sync`, body);
    if (!mp) return;
    if (r.guest_username && mp.opponent === '…') { mp.opponent = r.guest_username; updateOppLabel(); }
    for (const row of r.commands || []) {
      mp.lastCmdId = Math.max(mp.lastCmdId, row.id);
      try { applyGuestCommand(row.payload); } catch { }
    }
    mp.oppSeen = r.opponentSeenAgoMs;
    if (r.status === 'finished' && !mp.ended) finishFromServer(r);
    updateMpBanner();
  } catch { } finally { if (mp) mp.busy = false; }
}

async function guestSync() {
  if (!mp || mp.busy || mp.ended) return;
  mp.busy = true;
  const batch = mp.outQueue.splice(0, 50);
  try {
    const r = await api(`/api/lobbies/${mp.lobbyId}/sync`, { haveTick: mp.lastSnapTick, commands: batch });
    if (!mp) return;
    if (r.snapshot) {
      mp.lastSnapTick = r.snapshot_tick || (r.snapshot.tick | 0);
      mp.noSnapPolls = 0;
      applySnapshot(r.snapshot);
    } else if (!game) {
      mp.noSnapPolls++;
      if (mp.noSnapPolls > 30) {
        // host never produced a starting snapshot — bail out
        toast('The host never showed up — match abandoned.');
        leavePvpToMenu();
        return;
      }
    }
    mp.oppSeen = r.opponentSeenAgoMs;
    if (r.status === 'finished' && !mp.ended) finishFromServer(r);
    updateMpBanner();
  } catch {
    mp.outQueue = batch.concat(mp.outQueue); // retry unsent orders
  } finally { if (mp) mp.busy = false; }
}

function applySnapshot(snap) {
  if (!game) {
    const g = S.deserialize(snap);
    S.setViewer(g, 1);
    startMatch(g);
  } else {
    const prevTick = game.tick;
    const g = S.deserialize(snap, game);
    S.setViewer(g, 1);
    game = g;
    // dead-reckon back toward where we were rendering (bounded catch-up)
    let ahead = Math.min(25, Math.max(0, prevTick - g.tick));
    while (ahead-- > 0 && !g.result) S.step(g);
  }
  for (const ev of snap.netEvents || []) toast(ev.msg);
}

// Host-side application of the guest's relayed orders. Every entity id is
// re-resolved against authoritative state and must belong to owner 1.
function resolveBlobFor(owner, id) {
  let cur = id, hops = 0;
  while (hops++ < 10) {
    const b = game.blobs.find(x => x.id === cur && !x.dead);
    if (b) return b.owner === owner ? b : null;
    if (game.mergeLog[cur] != null) cur = game.mergeLog[cur];
    else return null;
  }
  return null;
}

function applyGuestCommand(c) {
  if (!game || game.result || !c || typeof c !== 'object') return;
  const b = c.blobId != null ? resolveBlobFor(1, c.blobId) : null;
  const st = c.settlementId != null
    ? game.settlements.find(s => s.id === c.settlementId && s.owner === 1) : null;
  switch (c.op) {
    case 'surrender':
      game.result = 'p0-win';
      game.resultReason = 'surrender';
      break;
    case 'move': if (b) S.opMove(game, b, +c.x || 0, +c.y || 0, !!c.attack); break;
    case 'setRole': if (b) S.opSetRole(game, b, c.role); break;
    case 'split': if (b) S.opSplit(game, b, c.take | 0); break;
    case 'build': if (b) S.opBuild(game, b); break;
    case 'pillage': if (b) S.opPillage(game, b, !!c.on); break;
    case 'route':
      if (b && c.target) {
        if (c.target.kind === 'blob') {
          const t = resolveBlobFor(1, c.target.id);
          if (t && t.id !== b.id) S.opRoute(game, b, { kind: 'blob', id: t.id });
        } else if (c.target.kind === 'settlement') {
          const t = game.settlements.find(s => s.id === c.target.id && s.owner === 1);
          if (t) S.opRoute(game, b, { kind: 'settlement', id: t.id });
        }
      }
      break;
    case 'setMode': if (st) S.opSetMode(game, st, c.mode); break;
    case 'fieldGarrison': if (st) S.opFieldGarrison(game, st); break;
    case 'fieldRole': if (st) S.opFieldRole(game, st, c.role, Math.max(1, c.n | 0)); break;
    case 'garrisonRole': if (st) S.opGarrisonRole(game, st, c.role); break;
  }
}

function updateMpBanner() {
  const el = $('mp-banner');
  if (!mp || mp.ended || !game || game.result) { el.classList.add('hidden'); return; }
  const gone = mp.oppSeen != null ? mp.oppSeen : 0;
  if (gone > 6000) {
    el.classList.remove('hidden');
    const canClaim = gone > 60000;
    $('mp-banner-text').textContent = canClaim
      ? `${mp.opponent} seems to be gone (${Math.round(gone / 1000)}s).`
      : `Opponent connection lost — waiting… (${Math.round(gone / 1000)}s)`;
    $('btn-claim').classList.toggle('hidden', !canClaim);
  } else {
    el.classList.add('hidden');
  }
}

$('btn-claim').addEventListener('click', async () => {
  if (!mp || mp.ended) return;
  try {
    await api(`/api/lobbies/${mp.lobbyId}/result`, { winnerOwner: me, reason: 'abandoned' });
    mp.ended = true;
    resultPosted = true;
    if (game) game.result = 'ended';
    stopMpTimers();
    $('mp-banner').classList.add('hidden');
    showEndModal(true, 'abandoned');
    loadHistory();
  } catch (err) { toast(err.message); }
});

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

// -- order dispatch: direct in solo / as host, relayed as guest --------

function sendCmd(c) { if (mp) mp.outQueue.push(c); }
const QUEUED = { ok: true, queued: true };

function doMove(b, x, y, attack) {
  if (isGuest()) { sendCmd({ op: 'move', blobId: b.id, x, y, attack: !!attack }); return QUEUED; }
  return S.opMove(game, b, x, y, attack);
}
function doSetRole(b, role) {
  if (isGuest()) { sendCmd({ op: 'setRole', blobId: b.id, role }); return QUEUED; }
  return S.opSetRole(game, b, role);
}
function doSplit(b, n) {
  if (isGuest()) { sendCmd({ op: 'split', blobId: b.id, take: n }); return QUEUED; }
  return S.opSplit(game, b, n);
}
function doBuild(b) {
  if (isGuest()) { sendCmd({ op: 'build', blobId: b.id }); return QUEUED; }
  return S.opBuild(game, b);
}
function doPillage(b, on) {
  if (isGuest()) { sendCmd({ op: 'pillage', blobId: b.id, on: !!on }); return QUEUED; }
  return S.opPillage(game, b, on);
}
function doRoute(b, target) {
  if (isGuest()) { sendCmd({ op: 'route', blobId: b.id, target }); return QUEUED; }
  return S.opRoute(game, b, target);
}
function doSetMode(st, mode) {
  if (isGuest()) { sendCmd({ op: 'setMode', settlementId: st.id, mode }); return QUEUED; }
  return S.opSetMode(game, st, mode);
}
function doFieldGarrison(st) {
  if (isGuest()) { sendCmd({ op: 'fieldGarrison', settlementId: st.id }); return QUEUED; }
  return S.opFieldGarrison(game, st);
}
function doFieldRole(st, role, n) {
  if (isGuest()) { sendCmd({ op: 'fieldRole', settlementId: st.id, role, n }); return QUEUED; }
  return S.opFieldRole(game, st, role, n);
}
function doGarrisonRole(st, role) {
  if (isGuest()) { sendCmd({ op: 'garrisonRole', settlementId: st.id, role }); return QUEUED; }
  return S.opGarrisonRole(game, st, role);
}

// ---------------------------------------------------------------- match lifecycle

function startMatch(g) {
  game = g;
  resultPosted = false;
  ui = { selected: null, pending: null, splitCount: null, orderTarget: null, fieldCounts: {} };
  hideOrderPopup();
  acc = 0; speed = 1; paused = false; lastSaveTick = g.tick;
  $('btn-speed').textContent = '1×';
  $('btn-pause').textContent = '⏸';
  // no pause / fast-forward in multiplayer — the sim is shared
  $('btn-pause').classList.toggle('hidden', !!g.pvp);
  $('btn-speed').classList.toggle('hidden', !!g.pvp);
  updateOppLabel();
  stopMenuPolling();

  if (!renderer) {
    renderer = createRenderer($('game-canvas'), $('minimap'));
    input = createInput({ canvas: $('game-canvas'), minimap: $('minimap'), view, handlers: { tap: onTap, box: onBox, rightClick: onRightClick, cancel: onCancel, gesture: hideOrderPopup } });
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
        : `You destroyed every settlement ${opp} had in ${dur}.`)
    : (reason === 'abandoned'
      ? `The match was claimed while you were away.`
      : reason === 'surrender'
        ? `You surrendered to ${opp} after ${dur}.`
        : `${opp} destroyed your war effort after ${dur}.`);
  $('end-modal').classList.remove('hidden');
}

function endMatch(result) {
  resultPosted = true;
  if (game.pvp) {
    const winner = result === 'p0-win' ? 0 : 1;
    const reason = game.resultReason || 'elimination';
    showEndModal(winner === me, reason);
    if (mp && !mp.ended) {
      mp.ended = true;
      if (mp.role === 'host') {
        // push the final snapshot (so the guest sees the outcome), then record it
        api(`/api/lobbies/${mp.lobbyId}/sync`, { commandsAfter: mp.lastCmdId, tick: game.tick, snapshot: buildSnapshot() })
          .catch(() => { })
          .then(() => api(`/api/lobbies/${mp.lobbyId}/result`, { winnerOwner: winner, reason }))
          .catch(() => { });
      }
      stopMpTimers();
    }
    $('mp-banner').classList.add('hidden');
    loadHistory();
    return;
  }
  localStorage.removeItem(SAVE_KEY);
  const win = result === 'win';
  $('end-emoji').textContent = win ? '🏆' : '🏳️';
  $('end-title').textContent = win ? 'Victory!' : result === 'surrender' ? 'Surrendered' : 'Defeat';
  $('end-detail').textContent = win
    ? `All enemy settlements destroyed in ${fmtDur(game.tick / 10)}.`
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
  if (!confirm('Surrender this match?')) return;
  if (game.pvp) {
    if (isGuest()) {
      sendCmd({ op: 'surrender' });
      toast('🏳️ Surrendering…');
      guestSync();
    } else {
      game.result = 'p1-win';
      game.resultReason = 'surrender';
    }
    return;
  }
  game.result = 'surrender';
});
$('btn-pause').addEventListener('click', () => {
  if (game && game.pvp) return;
  paused = !paused;
  $('btn-pause').textContent = paused ? '▶' : '⏸';
});
$('btn-speed').addEventListener('click', () => {
  if (game && game.pvp) return;
  speed = speed === 1 ? 2 : 1;
  $('btn-speed').textContent = speed + '×';
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
  if (ui.pending) { resolvePending(world); return; }
  // a tap while the order popup is open only dismisses it
  if (!orderPopup.classList.contains('hidden')) { hideOrderPopup(); return; }
  // prefer own blob, then own settlement
  let b = S.blobAt(game, world.x, world.y, hitR);
  const eb = b && b.owner !== me ? b : null;
  if (b && b.owner !== me) b = null;
  if (b) { ui.selected = { kind: 'blob', id: b.id }; renderPanel(true); return; }
  const st = S.settlementAt(game, world.x, world.y, Math.max(1.4, hitR));
  if (st && st.owner === me) { ui.selected = { kind: 'settlement', id: st.id }; renderPanel(true); return; }
  // tap elsewhere with blobs selected → inline order popup at the tap point
  if (selectedBlobs().length > 0) { showOrderPopup(world, screen); return; }
  // nothing selected → inspect what was tapped
  if (eb && S.isVisible(game, eb.x, eb.y)) {
    ui.selected = { kind: 'enemy-blob', id: eb.id };
    renderPanel(true);
    return;
  }
  const known = game.pvp ? game.knowns[me] : game.known;
  if (st && st.owner !== me && (S.isVisible(game, st.x + 0.5, st.y + 0.5) || known[st.id])) {
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

function onBox(rect) {
  if (!game || game.result) return;
  hideOrderPopup();
  const ids = game.blobs
    .filter(b => !b.dead && b.owner === me && b.x >= rect.x0 && b.x <= rect.x1 && b.y >= rect.y0 && b.y <= rect.y1)
    .map(b => b.id);
  if (ids.length === 0) { ui.selected = null; }
  else if (ids.length === 1) ui.selected = { kind: 'blob', id: ids[0] };
  else ui.selected = { kind: 'multi', ids };
  renderPanel(true);
}

function onRightClick(world, attackHeld) {
  if (!game || game.result) return;
  hideOrderPopup();
  const blobs = selectedBlobs();
  if (!blobs.length) return;
  let err = null;
  for (const b of blobs) {
    const r = doMove(b, world.x, world.y, attackHeld);
    if (r.err) err = r.err;
  }
  if (err) toast(err);
}

function onCancel() {
  if (!orderPopup.classList.contains('hidden')) { hideOrderPopup(); return; }
  if (ui.pending) { ui.pending = null; updateHint(); return; }
  ui.selected = null;
  renderPanel(true);
}

// ---------------------------------------------------------------- order popup

const orderPopup = $('order-popup');

function hideOrderPopup() {
  orderPopup.classList.add('hidden');
  ui.orderTarget = null;
}

function showOrderPopup(world, screen) {
  ui.orderTarget = world;
  const hasDeploy = selectedBlobs().some(b => b.count.deploy > 0);
  orderPopup.innerHTML = `
    <button data-act="pmove" class="btn px-3 rounded-lg text-left bg-zinc-800 hover:bg-zinc-700">📍 Move</button>
    <button data-act="ppillage" class="btn px-3 rounded-lg text-left bg-zinc-800 hover:bg-zinc-700">🔥 Pillage-move</button>
    ${hasDeploy ? '<button data-act="pattack" class="btn px-3 rounded-lg text-left bg-zinc-800 hover:bg-zinc-700">⚔️ Attack-move</button>' : ''}
    <button data-act="pclose" class="btn px-3 rounded-lg text-left bg-zinc-900 text-zinc-400 hover:bg-zinc-800">✕ Deselect</button>`;
  orderPopup.classList.remove('hidden');
  const px = screen ? screen.x : window.innerWidth / 2;
  const py = screen ? screen.y : window.innerHeight / 2;
  const w = orderPopup.offsetWidth, h = orderPopup.offsetHeight;
  orderPopup.style.left = Math.max(4, Math.min(window.innerWidth - w - 4, px + 10)) + 'px';
  orderPopup.style.top = Math.max(4, Math.min(window.innerHeight - h - 4, py - h / 2)) + 'px';
}

orderPopup.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn || !game) return;
  const act = btn.dataset.act;
  const world = ui.orderTarget;
  hideOrderPopup();
  if (act === 'pclose') { ui.selected = null; renderPanel(true); return; }
  if (!world) return;
  let err = null;
  for (const b of selectedBlobs()) {
    if (act === 'pmove') doPillage(b, false);
    else if (act === 'ppillage') doPillage(b, true);
    const r = doMove(b, world.x, world.y, act === 'pattack');
    if (r.err) err = r.err;
  }
  if (err) toast(err);
  renderPanel(true);
});

function resolvePending(world) {
  const pending = ui.pending;
  ui.pending = null;
  updateHint();
  const blobs = selectedBlobs();
  if (pending === 'move' || pending === 'attack') {
    if (!blobs.length) return;
    let err = null;
    for (const b of blobs) {
      const r = doMove(b, world.x, world.y, pending === 'attack');
      if (r.err) err = r.err;
    }
    if (err) toast(err);
  } else if (pending === 'route') {
    const carrier = blobs[0];
    if (!carrier) return;
    const hitR = Math.max(1.5, 24 / view.scale);
    let tgt = S.blobAt(game, world.x, world.y, hitR);
    if (tgt && (tgt.owner !== me || tgt.id === carrier.id)) tgt = null;
    if (tgt) {
      const r = doRoute(carrier, { kind: 'blob', id: tgt.id });
      toast(r.err ? r.err : r.queued ? '🚚 Supply order sent' : '🚚 Supply route established');
    } else {
      const st = S.settlementAt(game, world.x, world.y, hitR);
      if (st && st.owner === me) {
        const r = doRoute(carrier, { kind: 'settlement', id: st.id });
        toast(r.err ? r.err : r.queued ? '🚚 Supply order sent' : '🚚 Supply route established');
      } else {
        toast('Tap a friendly army or settlement to supply');
      }
    }
  }
  renderPanel(true);
}

function updateHint() {
  const el = $('hint');
  if (!ui.pending) { el.classList.add('hidden'); return; }
  const text = ui.pending === 'move' ? 'Tap a destination…'
    : ui.pending === 'attack' ? 'Tap where to attack-move…'
      : 'Tap the army or settlement to supply…';
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
window.addEventListener('pointerup', () => { panelHeld = false; });

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
      let err = null, okCount = 0, partial = false;
      for (const b of blobs) {
        const res = doSetRole(b, role);
        if (res.err) err = res.err; else { okCount++; if (res.partial) partial = true; }
      }
      if (err && !okCount) toast(err);
      else if (partial) toast(`Farm at capacity (${S.C.FARM_CAP}) — some units stayed behind`);
      break;
    }
    case 'move': ui.pending = 'move'; updateHint(); break;
    case 'attack': ui.pending = 'attack'; updateHint(); break;
    case 'route': ui.pending = 'route'; updateHint(); break;
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
      const b = blobs[0];
      if (b) {
        r = doBuild(b);
        if (r.err) toast(r.err);
        else if (r.queued) toast('🏠 Build ordered');
        else {
          toast('🏠 Settlement founded');
          if (b.dead || S.total(b) === 0) ui.selected = { kind: 'settlement', id: r.settlement.id };
        }
      }
      break;
    }
    case 'pillage': {
      for (const b of blobs) doPillage(b, !b.pillaging);
      break;
    }
    case 'mode': if (st) doSetMode(st, btn.dataset.mode); break;
    case 'field': {
      if (st) {
        r = doFieldGarrison(st);
        if (r.err) toast(r.err);
        else if (!r.queued) ui.selected = { kind: 'blob', id: r.blob.id };
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
        let c = 0;
        for (const b of [...game.blobs]) {
          if (!b.dead && b.owner === me && b.working === st.id) {
            if (doMove(b, st.x + 0.5, st.y + 0.5, false).ok) c++;
          }
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
  } else if (e.target.id && e.target.id.startsWith('field-count-')) {
    const role = e.target.id.slice('field-count-'.length);
    const v = Math.max(1, e.target.value | 0);
    ui.fieldCounts[role] = v;
    const btn = $(`field-btn-${role}`);
    if (btn) btn.textContent = `Field ${v}`;
  }
});

function roleBtn(role, label, active, disabled) {
  return `<button data-act="role" data-role="${role}" ${disabled ? 'disabled' : ''}
    class="btn-sm flex-1 px-2 rounded ${active ? 'bg-violet-600 text-white' : 'bg-zinc-800 text-zinc-300'} ${disabled ? 'opacity-40' : 'hover:bg-violet-700'}">${label}</button>`;
}

function setPanelHTML(html) {
  if (html === lastPanelHTML) return;
  lastPanelHTML = html;
  panel.innerHTML = html;
}

function renderPanel(force) {
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
      <div class="text-xs text-zinc-400">⚔️ ${c.deploy} deploy · 🚚 ${c.supply} supply · 🌱 ${c.farm} farmer${eb.pillaging ? ' · <span class="text-orange-400">pillaging</span>' : ''}${eb.working != null ? ' · working the fields' : ''}</div>`);
    return;
  }
  if (ui.selected && ui.selected.kind === 'enemy-settlement') {
    const est = game.settlements.find(s => s.id === ui.selected.id);
    if (!est) { ui.selected = null; panel.classList.add('hidden'); lastPanelHTML = ''; return; }
    panel.classList.remove('hidden');
    if (S.isVisible(game, est.x + 0.5, est.y + 0.5)) {
      const pct = Math.max(0, Math.min(100, Math.round(100 * est.hp / S.C.SETT_HP)));
      setPanelHTML(`
        <div class="flex items-center justify-between mb-1">
          <span class="font-semibold text-red-300">🏠 Enemy settlement</span>
          <span class="text-xs ${est.hp < S.C.SETT_HP ? 'text-red-400' : 'text-zinc-400'}">HP ${Math.ceil(est.hp)}/${S.C.SETT_HP}</span>
        </div>
        <div class="h-2 rounded bg-zinc-800 overflow-hidden mb-2"><div class="h-full bg-red-500" style="width:${pct}%"></div></div>
        <div class="text-xs text-zinc-400">${est.hp >= S.C.SETT_HP ? 'Walls intact.' : est.hp > S.C.SETT_HP / 2 ? 'Damaged.' : 'Heavily damaged!'} Attack-move deploy units onto it to lay siege.</div>`);
    } else {
      setPanelHTML(`
        <div class="font-semibold text-red-300 mb-1">🏠 Enemy settlement <span class="text-zinc-500 font-normal">(last seen)</span></div>
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
        ${game.pillaged.has(i) ? '<div class="text-xs text-orange-400">🔥 Scorched — recovering very slowly</div>' : ''}`);
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

  if (st) {
    const g = st.garrison;
    const gTot = S.garrisonTotal(st);
    const wc = S.workingCount(game, st);
    const pct = Math.round(100 * st.trainTicks / S.C.TRAIN_TICKS);
    const gated = S.trainGated(st);
    const pausedNote = '<div class="text-xs text-amber-400 mt-1">⏸ Paused — food at break-even. More farmers or fewer mouths to resume.</div>';
    let prog;
    if (st.mode === 'off') {
      prog = '<div class="text-xs text-zinc-500 mt-1">⏹ Production stopped — stockpiling food.</div>';
    } else if (st.mode === 'farm') {
      const hungry = st.stockpile < S.C.FARM_GROW_FLOOR ? `<span class="text-red-400">(needs ${S.C.FARM_GROW_FLOOR} food)</span>` : '';
      prog = wc >= S.C.FARM_CAP
        ? (gated ? pausedNote
          : `<div class="text-xs text-zinc-400 mt-1">Farmer cap reached — training ⚔️ deploy unit: ${pct}% ${hungry}</div>`)
        : `<div class="text-xs text-zinc-400 mt-1">Growing farmer unit: ${pct}% ${hungry}</div>`;
    } else if (gated && st.stockpile >= S.C.TRAIN_COST) {
      prog = pausedNote;
    } else {
      prog = `<div class="text-xs text-zinc-400 mt-1">Training ${st.mode === 'supply' ? 'supply' : 'deploy'} unit: ${pct}% ${st.stockpile < S.C.TRAIN_COST ? '<span class="text-red-400">(needs food)</span>' : ''}</div>`;
    }
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
    setPanelHTML(`
      <div class="flex items-center justify-between mb-1">
        <span class="font-semibold">🏠 Settlement</span>
        <span class="text-xs ${st.hp < S.C.SETT_HP ? 'text-red-400' : 'text-zinc-500'}">HP ${Math.ceil(st.hp)}/${S.C.SETT_HP}</span>
      </div>
      <div class="text-xs text-zinc-400 mb-2">Stockpile <b class="text-amber-300">${Math.floor(st.stockpile)}</b> / ${S.C.STOCK_CAP} 🌾</div>
      <div class="text-xs text-zinc-500 mb-1">Production mode (sets new units' role)</div>
      <div class="flex gap-1 mb-2">
        ${[['farm', '🌾 Farm'], ['supply', '🚚 Supply'], ['deploy', '⚔️ Deploy'], ['off', '⏹ Stop']].map(([m, lbl]) => `<button data-act="mode" data-mode="${m}"
          class="btn-sm flex-1 px-1 rounded ${st.mode === m ? (m === 'off' ? 'bg-zinc-600 text-white' : 'bg-emerald-700 text-white') : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'}">${lbl}</button>`).join('')}
      </div>
      ${prog}
      <div class="mt-2 pt-2 border-t border-zinc-800 flex items-center justify-between">
        <span class="text-xs text-zinc-500">🌱 ${wc}/${S.C.FARM_CAP} farmers working the fields</span>
        ${wc > 0 ? '<button data-act="recall" class="btn-sm px-2 rounded bg-zinc-700 hover:bg-zinc-600">Recall farmers</button>' : ''}
      </div>
      <div class="mt-2 pt-2 border-t border-zinc-800">
        <div class="text-xs text-zinc-500 mb-1">Garrison: ⚔️${g.deploy} 🚚${g.supply} 🌱${g.farm}</div>
        ${gTot > 0 ? `
          <div class="flex gap-1 mb-2">
            ${roleBtn('deploy', '⚔️', false, false)}${roleBtn('supply', '🚚', false, false)}${roleBtn('farm', '🌱', false, false)}
          </div>
          ${fieldRows}
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
  const hpSum = blobs.reduce((s2, b) => s2 + b.units.reduce((a, u) => a + u.hp, 0), 0);
  const hpMax = blobs.reduce((s2, b) => s2 + b.units.reduce((a, u) => a + S.unitMaxHP(u.role), 0), 0);
  const hpPct = Math.round(100 * hpSum / Math.max(1, hpMax));
  const hpColor = hpPct >= 75 ? 'text-emerald-400' : hpPct >= 40 ? 'text-amber-400' : 'text-red-400';
  if (!multi && tot >= 2) {
    ui.splitCount = Math.max(1, Math.min(tot - 1, ui.splitCount || Math.floor(tot / 2)));
  }

  setPanelHTML(`
    <div class="flex items-center justify-between mb-1">
      <span class="font-semibold">${multi ? `${blobs.length} blobs` : 'Blob'} — ${tot} unit${tot === 1 ? '' : 's'}</span>
      <span class="text-xs"><span class="${hpColor}">❤️ ${hpPct}%</span> · <span class="${fedColor}">${S.fedLabel(meter)} ${Math.round(meter * 100)}%</span></span>
    </div>
    <div class="text-xs text-zinc-400 mb-2">⚔️ ${cnt.deploy} deploy · 🚚 ${cnt.supply} supply · 🌱 ${cnt.farm} farmer${onRoute ? ' · <span class="text-sky-300">on supply route</span>' : ''}${blobs.some(b => b.pillaging) ? ' · <span class="text-orange-400">pillaging</span>' : ''}${!multi && b0.working != null ? ' · <span class="text-emerald-300">working the fields</span>' : ''}</div>
    <div class="text-xs text-zinc-500 mb-1">Role ${!atHome ? '<span class="text-zinc-600">(farmers need a settlement)</span>' : ''}</div>
    <div class="flex gap-1 mb-2">
      ${roleBtn('deploy', '⚔️ Deploy', cnt.deploy === tot, false)}
      ${roleBtn('supply', '🚚 Supply', pureSupply, false)}
      ${roleBtn('farm', '🌱 Farmer', cnt.farm === tot, !atHome)}
    </div>
    <div class="grid grid-cols-2 gap-1 mb-2">
      <button data-act="move" class="btn rounded bg-zinc-800 hover:bg-zinc-700">📍 Move</button>
      <button data-act="attack" class="btn rounded bg-zinc-800 hover:bg-zinc-700" ${cnt.deploy === 0 ? 'disabled' : ''}>⚔️ Attack-move</button>
      <button data-act="build" class="btn rounded bg-zinc-800 hover:bg-zinc-700 ${multi || tot < S.C.SETT_COST ? 'opacity-40' : ''}" ${multi || tot < S.C.SETT_COST ? 'disabled' : ''}>🏠 Build (${S.C.SETT_COST})</button>
      <button data-act="pillage" class="btn rounded ${blobs.some(b => b.pillaging) ? 'bg-orange-700 text-white' : 'bg-zinc-800 hover:bg-zinc-700'}">🔥 Pillage</button>
      <button data-act="route" class="btn rounded col-span-2 ${pureSupply && !multi ? 'bg-sky-800 hover:bg-sky-700' : 'bg-zinc-800 opacity-40'}" ${pureSupply && !multi ? '' : 'disabled'}>🚚 Supply route…</button>
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
  if (isGuest()) {
    // guest toasts come from host snapshots (netEvents); the local
    // dead-reckoning sim's events would duplicate them
    game.events.length = 0;
    return;
  }
  for (const ev of game.events) {
    if (ev.owner == null || ev.owner === me) toast(ev.msg);
    else if (mp && mp.role === 'host') mp.guestEvents.push(ev);
  }
  game.events.length = 0;
}

function frame(ts) {
  requestAnimationFrame(frame);
  const dt = Math.min(100, ts - lastFrame || 16);
  lastFrame = ts;
  if (!game) return;

  if (!paused && !game.result) {
    acc += dt * speed;
    let iter = 0;
    while (acc >= 100 && iter++ < 40) {
      S.step(game);
      if (!game.pvp && game.tick % 20 === 0) aiTick(game, S);
      acc -= 100;
    }
    if (acc >= 100) acc = 0; // fell behind (background tab); drop the backlog
  }

  input.update(dt);
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
  if (game.result && !resultPosted) endMatch(game.result);
}

requestAnimationFrame(frame);

// ---------------------------------------------------------------- boot

refreshMenu();
loadHistory();
startMenuPolling();
