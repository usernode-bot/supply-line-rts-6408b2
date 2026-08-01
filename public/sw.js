// Service worker for offline solo play (#221).
//
// The whole simulation — map generation, the 100 ms tick, all four AI
// commanders — already runs client-side, so the ONLY thing standing between
// a player and a match on a plane is asset delivery. This worker precaches
// the shell, the ES modules and the vendored Tailwind build so a cold boot
// with no network lands on the main menu.
//
// !! BUMP CACHE_VERSION WHENEVER ANYTHING UNDER public/ CHANGES !!
// Static assets are served cache-first and this worker deliberately does NOT
// call skipWaiting (see below), so a client keeps the old bundle until the
// version string changes and it does a cold load. Forgetting the bump means
// shipping code nobody receives.
const CACHE_VERSION = 'supply-line-v3';
const STATIC_CACHE = CACHE_VERSION + '-static';
const RUNTIME_CACHE = CACHE_VERSION + '-runtime';

// The shell + every module main.js pulls in. Kept explicit rather than
// globbed: there is no build step to generate a manifest from.
const PRECACHE = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/icon.svg',
  '/vendor/tailwind-play-cdn.js',
  '/js/main.js',
  '/js/sim.js',
  '/js/ai.js',
  '/js/render.js',
  '/js/input.js',
  '/js/mapgen.js',
  '/js/supply.js',
  '/js/commands.js',
  '/js/attract.js',
  '/js/offline.js',
  '/js/replay.js',
  '/js/resume.js',
  '/js/tutorial.js',
  '/js/controls-tour.js',
  // #240: pick.js and stats.js are imported by main.js and were missing here,
  // so an offline boot died at module load however good the shell was.
  '/js/pick.js',
  '/js/stats.js',
];

// The one API response worth keeping: the commander anchors are committed
// constants (calibration/ai-ratings.json), so a stale copy is still true and
// it keeps the difficulty hint's Elo alive on an offline boot. Everything
// else under /api/ is per-user or per-match state and is never touched.
const AI_RATINGS_PATH = '/api/ai-ratings';

// The shell is requested with ?token=… inside the platform iframe and with
// ?demo=1 / ?shot=… on preview boots. All of those are the same document, so
// navigations key off the pathname alone — and a cached shell is therefore
// tokenless by construction, which drops the client into its existing
// local-only path with no extra plumbing.
const SHELL_URL = '/index.html';

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(STATIC_CACHE);
    // Individually, so one 404 can't fail the whole install.
    await Promise.all(PRECACHE.map(async (path) => {
      try {
        const res = await fetch(new Request(path, { cache: 'reload' }));
        if (res && res.ok) await cache.put(path, res);
      } catch { /* offline at install time — the fetch handler backfills */ }
    }));
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter((n) => n !== STATIC_CACHE && n !== RUNTIME_CACHE)
      .map((n) => caches.delete(n)));
  })());
  // Deliberately NO skipWaiting()/clients.claim(): swapping modules under a
  // running match could pair a new sim.js with an old render.js mid-tick.
  // The new worker takes over on the next cold load.
});

// A token must never become part of a cache KEY — a cached entry under a
// tokenised URL would outlive the token and could be replayed from another
// context. Every put in this file is keyed by pathname alone, so the query
// string never survives; this guard stays on the one path (static assets)
// where a tokenised request would be surprising at all.
function hasToken(url) {
  return url.searchParams.has('token');
}

async function cacheFirst(request, url) {
  const cache = await caches.open(STATIC_CACHE);
  const key = url.pathname;
  const hit = await cache.match(key);
  if (hit) {
    // Refresh in the background; failures are expected offline.
    fetchAndPut(cache, key, request).catch(() => { });
    return hit;
  }
  const res = await fetch(request);
  if (res && res.ok && !hasToken(url)) {
    try { await cache.put(key, res.clone()); } catch { }
  }
  return res;
}

async function fetchAndPut(cache, key, request) {
  const res = await fetch(new Request(request.url, { cache: 'reload' }));
  if (res && res.ok) await cache.put(key, res.clone());
  return res;
}

// Navigations: network-first so a reachable server always wins (fresh shell,
// fresh token), with the cached shell as the fallback.
//
// #240: the shell response IS cached now even when the request URL carried a
// token, and this is the fix that makes the fallbacks below real. The old rule
// skipped it, which sounds prudent until you follow it through: inside the
// platform every navigation carries a token, and the install-time precache of
// '/index.html' fetches WITHOUT one and gets the server's 401 landing page —
// so `res.ok` was false there too and NOTHING was ever cached. Both fallbacks
// missed every time and offline play (#221) had no shell to boot.
//
// It is also safe. The token lives in the request URL, never in the response:
// the body is the same public/index.html that express.static already serves to
// unauthenticated callers, and it is stored under the token-free key
// SHELL_URL. A query string never enters a cache key here.
async function navigate(request) {
  const cache = await caches.open(STATIC_CACHE);
  try {
    const res = await fetch(request);
    if (res && res.ok) {
      try { await cache.put(SHELL_URL, res.clone()); } catch { }
      return res;
    }
    // 401 (an expired iframe token — the reload this issue is about) or a 5xx:
    // serve the real shell instead of a sign-in wall. It boots tokenless, which
    // drops the client into its local-only path, where the save still resumes.
    const hit = await cache.match(SHELL_URL);
    return hit || res;
  } catch {
    const hit = await cache.match(SHELL_URL) || await cache.match('/');
    if (hit) return hit;
    throw new Error('offline and no cached shell');
  }
}

// Commander anchors: stale-while-revalidate.
async function aiRatings(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  const hit = await cache.match(AI_RATINGS_PATH);
  const network = fetch(request).then(async (res) => {
    if (res && res.ok) { try { await cache.put(AI_RATINGS_PATH, res.clone()); } catch { } }
    return res;
  });
  if (hit) { network.catch(() => { }); return hit; }
  return network;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  let url;
  try { url = new URL(request.url); } catch { return; }
  if (url.origin !== self.location.origin) return;   // nothing cross-origin left to cache

  if (request.mode === 'navigate') {
    event.respondWith(navigate(request));
    return;
  }

  if (url.pathname === AI_RATINGS_PATH) {
    event.respondWith(aiRatings(request));
    return;
  }

  // Every other /api/ path is live state: saves, match results, lobbies,
  // snapshots, player ratings. Pass straight through, never cache.
  if (url.pathname.startsWith('/api/')) return;

  if (PRECACHE.includes(url.pathname)) {
    event.respondWith(cacheFirst(request, url));
  }
});
