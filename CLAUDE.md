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
routes, destroy all enemy settlements to win. The full game sim runs
client-side (ES modules under `public/js/`); the server only gates auth
and records match history in the `matches` table.

## App-specific conventions

- One unit type; role (deploy / supply / farmer) is switchable state on
  a blob, never a separate species. Keep it that way.
- All game logic runs at a fixed 100 ms tick in `public/js/sim.js`;
  save/resume is a JSON round-trip (map regenerated from its seed), so
  keep sim state JSON-serializable.
- Input is pointer-first: every action must be reachable by tap alone;
  mouse/keyboard bindings are shortcuts, never the only path.
- No build step and no new runtime dependencies — plain ES modules
  served from `public/`.
