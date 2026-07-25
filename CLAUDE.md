# Supply Line RTS — notes for Claude Code

This app runs on **Usernode Social Vibecoding**. If you're Claude Code
editing this repo, read the platform conventions before making
changes:

**Platform conventions (authoritative, always current):**
https://social-vibecoding.usernodelabs.org/claude.md

Fetch that URL at the start of each session — it's the single source
of truth for platform-wide behavior (auth model, `USERNODE_ENV`,
public/private tables, "don't `git push`", etc.). The hosted copy is
updated in place when platform rules change, so fetching it gives you
today's rules, not a stale snapshot.

When running inside Usernode's dev-chat, those same conventions are
already injected into your system prompt, so the fetch is a no-op in
that path — but it's the right reflex when someone runs Claude Code
against this repo locally or from another harness.

If a rule below this line conflicts with the hosted conventions, the
hosted conventions win. This file is **app-specific** — write down
things about *this* app that belong in the repo: product intent,
data-model quirks, style preferences, opt-in policies (e.g. which
tables you've marked private), etc.

---

## About Supply Line

Single-player, slow-paced 2D top-down RTS ("Supply Line") played in the
browser vs a scripted AI, tuned for a 20–40 minute match at the sim's
native tick rate. The default 1× game speed runs at *half* that rate
(the top-bar selector offers 1×–4×, where 2× is the native rate); PvP
is fixed at 1×, so quick multiplayer games are best played on the
smaller map sizes. Core loop:
found settlements on fertile land, feed armies via pillage or supply
routes, wipe out the enemy to win (a side is only defeated at zero
settlements AND fewer than 5 units — enough units left means it can
still rebuild). The full game sim runs
client-side (ES modules under `public/js/`); the server gates auth,
records match history in the `matches` table, and pre-simulates a small
in-memory pool of AI-vs-AI mid-game snapshots (`attract-pool.js`, served
at `GET /api/attract-snapshot`) for the title screen's attract-mode
backdrop — it runs the same sim/AI modules via dynamic `import()`.

## App-specific conventions

- One unit type; role (deploy / supply / farmer) is switchable state on
  a blob, never a separate species. Keep it that way.
- All game logic runs at a fixed 100 ms tick in `public/js/sim.js`;
  save/resume is a JSON round-trip (map regenerated from its seed), so
  keep sim state JSON-serializable.
- Input is pointer-first: every action must be reachable by tap alone;
  mouse/keyboard bindings are shortcuts, never the only path.
- The AI commanders carry **fixed Elo ratings** measured offline by
  `npm run calibrate` and committed to `calibration/ai-ratings.json`,
  which is the single source of truth the server seeds from. Nothing at
  runtime ever moves an AI rating. **If you retune `DIFF` in
  `public/js/sim.js`, re-run `npm run calibrate`, bump the artifact's
  `version`, and commit it** — otherwise the published commander ratings
  describe the old AI.
- **Not every persona is measured against Normal.** Each one spars the
  strongest opponent that can still resolve it, and the fits chain in
  that order (`OPPONENT_OF` in `test/calibrate-ai.mjs`): Easy and Hard vs
  the 1000-pinned Normal, **Very Hard vs Hard**, with its fit anchored on
  Hard's rating from the same run. Very Hard is chained because the
  anchor saturates — it and Hard beat Normal on the same maps, so a
  40-match sample against Normal fitted them to an identical rating
  twice running. If you add a tier, pick its opponent the same way, list
  it in `CHALLENGERS` *after* whatever it chains onto, and expect the
  artifact to record `opponent` / `opponent_rating` per persona and per
  log row so the arithmetic stays auditable.
- No build step and no new runtime dependencies — plain ES modules
  served from `public/`.
