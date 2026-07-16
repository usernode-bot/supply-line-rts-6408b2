// Boot, menu wiring, match lifecycle, HUD + selection panel, autosave.

import * as S from './sim.js';
import { aiTick } from './ai.js';
import { createRenderer } from './render.js';
import { createInput } from './input.js';
import { dist } from './mapgen.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const token = params.get('token') || '';
const apiHeaders = token ? { 'x-usernode-token': token } : {};
const SAVE_KEY = 'supply-line-save-v1';

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
    mineEl.innerHTML = mine.length ? mine.map(m => `
      <div class="flex justify-between gap-2">
        <span class="${m.result === 'win' ? 'text-emerald-400' : 'text-red-400'}">${m.result === 'win' ? 'Victory' : m.result === 'surrender' ? 'Surrendered' : 'Defeat'}</span>
        <span class="text-zinc-500">${esc(m.difficulty)}</span>
        <span class="font-mono text-zinc-500">${fmtDur(m.duration_seconds)}</span>
      </div>`).join('') : '<span class="text-zinc-600">No matches yet — start one above!</span>';
    recentEl.innerHTML = recent.length ? recent.map(m => `
      <div class="flex justify-between gap-2">
        <span class="truncate">${esc(m.username)}</span>
        <span class="text-zinc-500">${esc(m.difficulty)}</span>
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
    // v1 saves predate per-unit health and are not migratable — discard
    if (data.v !== 2 || data.result) return null;
    return data;
  } catch { return null; }
}

function refreshMenu() {
  $('btn-resume').classList.toggle('hidden', !loadSaveData());
}

$('btn-new').addEventListener('click', () => {
  if (loadSaveData() && !confirm('Starting a new match discards your saved match. Continue?')) return;
  localStorage.removeItem(SAVE_KEY);
  const seed = $('inp-seed').value.trim() || Math.random().toString(36).slice(2, 10);
  const size = $('sel-mapsize').value;
  const diff = $('sel-difficulty').value;
  try {
    startMatch(S.newGame(seed, size, diff));
  } catch (e) {
    showMenuError('Could not start the match: ' + (e && e.message || e));
  }
});

$('btn-resume').addEventListener('click', () => {
  const data = loadSaveData();
  if (!data) { refreshMenu(); return; }
  try {
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

// ---------------------------------------------------------------- match lifecycle

function startMatch(g) {
  game = g;
  resultPosted = false;
  ui = { selected: null, pending: null, splitCount: null, orderTarget: null, fieldCounts: {} };
  hideOrderPopup();
  acc = 0; speed = 1; paused = false; lastSaveTick = g.tick;
  $('btn-speed').textContent = '1×';
  $('btn-pause').textContent = '⏸';

  if (!renderer) {
    renderer = createRenderer($('game-canvas'), $('minimap'));
    input = createInput({ canvas: $('game-canvas'), minimap: $('minimap'), view, handlers: { tap: onTap, box: onBox, rightClick: onRightClick, cancel: onCancel, gesture: hideOrderPopup } });
  }
  input.setMapSize(g.map.w, g.map.h);
  const start = g.map.starts[0];
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
  game = null;
  $('game-ui').classList.add('hidden');
  $('end-modal').classList.add('hidden');
  $('main-menu').classList.remove('hidden');
  refreshMenu();
  loadHistory();
}

function saveGame() {
  if (!game || game.result) return;
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(S.serialize(game))); } catch { }
}

function endMatch(result) {
  resultPosted = true;
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
  game.result = 'surrender';
});
$('btn-pause').addEventListener('click', () => {
  paused = !paused;
  $('btn-pause').textContent = paused ? '▶' : '⏸';
});
$('btn-speed').addEventListener('click', () => {
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
  if (b && b.owner !== 0) b = null;
  if (b) { ui.selected = { kind: 'blob', id: b.id }; renderPanel(true); return; }
  const st = S.settlementAt(game, world.x, world.y, Math.max(1.4, hitR));
  if (st && st.owner === 0) { ui.selected = { kind: 'settlement', id: st.id }; renderPanel(true); return; }
  // tap elsewhere with blobs selected → inline order popup at the tap point
  if (selectedBlobs().length > 0) { showOrderPopup(world, screen); return; }
  // nothing selected → inspect what was tapped
  if (st && st.owner !== 0 && (S.isVisible(game, st.x + 0.5, st.y + 0.5) || game.known[st.id])) {
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
    .filter(b => !b.dead && b.owner === 0 && b.x >= rect.x0 && b.x <= rect.x1 && b.y >= rect.y0 && b.y <= rect.y1)
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
    const r = S.opMove(game, b, world.x, world.y, attackHeld);
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
    if (act === 'pmove') S.opPillage(game, b, false);
    else if (act === 'ppillage') S.opPillage(game, b, true);
    const r = S.opMove(game, b, world.x, world.y, act === 'pattack');
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
      const r = S.opMove(game, b, world.x, world.y, pending === 'attack');
      if (r.err) err = r.err;
    }
    if (err) toast(err);
  } else if (pending === 'route') {
    const carrier = blobs[0];
    if (!carrier) return;
    const hitR = Math.max(1.5, 24 / view.scale);
    let tgt = S.blobAt(game, world.x, world.y, hitR);
    if (tgt && (tgt.owner !== 0 || tgt.id === carrier.id)) tgt = null;
    if (tgt) {
      const r = S.opRoute(game, carrier, { kind: 'blob', id: tgt.id });
      toast(r.err ? r.err : '🚚 Supply route established');
    } else {
      const st = S.settlementAt(game, world.x, world.y, hitR);
      if (st && st.owner === 0) {
        const r = S.opRoute(game, carrier, { kind: 'settlement', id: st.id });
        toast(r.err ? r.err : '🚚 Supply route established');
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
        const res = S.opSetRole(game, b, role);
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
        r = S.opSplit(game, b, Math.max(1, Math.min(n - 1, ui.splitCount || Math.floor(n / 2))));
        if (r.err) toast(r.err);
      }
      break;
    }
    case 'build': {
      const b = blobs[0];
      if (b) {
        r = S.opBuild(game, b);
        if (r.err) toast(r.err);
        else {
          toast('🏠 Settlement founded');
          if (b.dead || S.total(b) === 0) ui.selected = { kind: 'settlement', id: r.settlement.id };
        }
      }
      break;
    }
    case 'pillage': {
      for (const b of blobs) S.opPillage(game, b, !b.pillaging);
      break;
    }
    case 'mode': if (st) S.opSetMode(game, st, btn.dataset.mode); break;
    case 'field': {
      if (st) {
        r = S.opFieldGarrison(game, st);
        if (r.err) toast(r.err);
        else ui.selected = { kind: 'blob', id: r.blob.id };
      }
      break;
    }
    case 'grole': if (st) { r = S.opGarrisonRole(game, st, btn.dataset.role); if (r.err) toast(r.err); } break;
    case 'fieldn': {
      if (st) {
        const role = btn.dataset.role;
        const n = Math.max(1, Math.min(st.garrison[role], ui.fieldCounts[role] || 1));
        r = S.opFieldRole(game, st, role, n);
        if (r.err) toast(r.err);
      }
      break;
    }
    case 'recall': {
      if (st) {
        let c = 0;
        for (const b of [...game.blobs]) {
          if (!b.dead && b.owner === 0 && b.working === st.id) {
            if (S.opMove(game, b, st.x + 0.5, st.y + 0.5, false).ok) c++;
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
      const pct = Math.round(f * 100), opct = Math.round(o * 100);
      const label = f >= 0.75 ? 'Lush' : f >= 0.5 ? 'Fertile' : f >= 0.25 ? 'Poor' : 'Barren';
      const tb = game.tilledBy[i] ? game.settlements.find(s => s.id === game.tilledBy[i]) : null;
      setPanelHTML(`
        <div class="flex items-center justify-between mb-1">
          <span class="font-semibold">🟩 ${label} land</span>
          <span class="text-xs text-zinc-400">Fertility <b class="text-emerald-300">${pct}%</b>${pct < opct ? ` <span class="text-zinc-500">of ${opct}%</span>` : ''}</span>
        </div>
        <div class="h-2 rounded bg-zinc-800 overflow-hidden mb-2"><div class="h-full bg-emerald-500" style="width:${pct}%"></div></div>
        ${tb ? `<div class="text-xs ${tb.owner === 0 ? 'text-amber-300' : 'text-red-400'} mb-1">🌾 ${tb.owner === 0 ? 'Farmland of your settlement' : 'Enemy farmland'}</div>` : ''}
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
    let prog;
    if (st.mode === 'off') {
      prog = '<div class="text-xs text-zinc-500 mt-1">⏹ Production stopped — stockpiling food.</div>';
    } else if (st.mode === 'farm') {
      const hungry = st.stockpile < S.C.FARM_GROW_FLOOR ? `<span class="text-red-400">(needs ${S.C.FARM_GROW_FLOOR} food)</span>` : '';
      prog = wc >= S.C.FARM_CAP
        ? `<div class="text-xs text-zinc-400 mt-1">Farmer cap reached — training ⚔️ deploy unit: ${pct}% ${hungry}</div>`
        : `<div class="text-xs text-zinc-400 mt-1">Growing farmer unit: ${pct}% ${hungry}</div>`;
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
  const hpPct = Math.round(100 * hpSum / Math.max(1, tot * S.C.UNIT_HP));
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
  const p = S.unitCounts(game, 0);
  $('stat-units').textContent = `👥 ${p.units}`;
  $('stat-setts').textContent = `🏠 ${p.setts}`;
  $('stat-time').textContent = fmtDur(game.tick / 10);
  for (const ev of game.events) toast(ev.msg);
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
      if (game.tick % 20 === 0) aiTick(game, S);
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
  if (game.tick - lastSaveTick >= 300) {
    lastSaveTick = game.tick;
    saveGame();
  }
  if (game.result && !resultPosted) endMatch(game.result);
}

requestAnimationFrame(frame);

// ---------------------------------------------------------------- boot

refreshMenu();
loadHistory();
