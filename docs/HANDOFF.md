# HANDOFF — state of the build as of 2026-08-21

> **What this document is.** A snapshot written at the end of the initial build, kept as
> engineering history: it shows what was verified, what was merely claimed, and what was
> deliberately skipped, at that moment. It is not maintained: the open items it lists have
> since been resolved (see the git history), the setup steps it references now live in the
> [README](../README.md), and the original `BUILD_PROMPT.md` it points to is not part of the
> public repository. Read it to understand how the project got here, not to find out what to
> do next.

Written at the end of the initial build so a fresh session can pick this up without
re-deriving anything. Honest about what is verified, what is claimed, and what was skipped.

---

## 1. Read these, in this order

| | |
|---|---|
| `BUILD_PROMPT.md` | the original requirements. §10 is the definition of done. |
| `docs/SPEC.md` | the behavioural contract — state machine, D1 schema, WS protocol, routes, auth. Authoritative. |
| `docs/DESIGN.md` | the visual contract. **§2–§5 are SUPERSEDED** — see the banner at the top of that file. §1, §6, §7, §8 still hold. |
| `README.md` | setup, secrets, migrations, exact OBS Browser Source settings, query params, Stream Deck config. |

The shipped code is the authority for the overlay's appearance, not `DESIGN.md` §2–§5.

---

## 2. What is verified, and how

Not "it compiles". Each of these was executed.

- **`tsc --noEmit`** → exit 0, no output. No `as any`, no `@ts-ignore`, no `@ts-expect-error`
  anywhere in `src/` (grep-confirmed).
- **`node --test src/test_run.ts`** → **35/35 pass**, nothing skipped. An independent Fable
  agent broke `run.ts` in 4 places to confirm the tests actually catch regressions (removing
  `streak = 0` on loss → 2 failures; win threshold `<`→`<=` → 6; dropping the
  undo-refuses-`session_start` guard → 1; `lap+1`→`lap` → 1), then restored the file
  byte-identically (SHA-256 matched).
- **D1 migration** applies clean to a genuinely empty database — 4 STRICT tables, 8 indexes,
  `PRAGMA integrity_check` ok, and the `sessions_one_live` partial unique index really does
  reject a second live session.
- **Recap SQL agrees with `reduce()`** — proven empirically, not argued. A real SQLite DB was
  built from the actual migration, an event log generated through the actual `plan()`
  (b2b won cleanly, b2b after a broken streak, a same-lap double visit via live reorder, a
  skip, a loop wrap, an undo, a stop-now), then the shipped `Q_*` strings were run against it.
  Every number matched.
- **All 6 end-to-end checkboxes PASS**: source reload; WS drop (socket killed, a LOSS fired
  while it was down, correct re-sync on reconnect); full Worker redeploy — including deleting
  the DO storage directory outright and watching `hydrate()` rebuild live state from D1;
  recap from a seeded historical session; JSON + CSV export with RFC-4180 quoting forced by a
  comma in a game title; IDLE on a pristine instance; the animation queue under a 250ms
  WIN→LOSS; undo across a game boundary through the real HTTP+DO+D1+WS path.
- **Replay protection**: a Stream Deck double-press 200ms apart counts **one** loss (second
  answers `dup`); 800ms apart counts **two**.
- **Overlay CPU, measured** via CDP against local Chrome, 20s windows at 1920×1080:
  LOSS_MODE **0.01%**, STREAK_MODE **0.03%**, both with 0 layout and 0 style recalc.
  Budget is <3%. (Caveat below.)
- **DCE**: `npm run verify:dce` passes, and `grep -r dev@localhost dist` now genuinely returns
  nothing after `npm run build` (the build removes `dist/*.map`, which is where the literal was
  surviving via esbuild's `sourcesContent`).

## 3. What is NOT verified — do not assume these

- **Nothing has ever been deployed.** No Cloudflare auth was available in the build session, so
  `wrangler d1 create`, `r2 bucket create`, `wrangler secret put` and `wrangler deploy` have
  never run. Everything was verified against local `wrangler dev`.
- **Nothing has been seen inside OBS.** The overlay has only ever rendered in headless Chrome
  151. OBS ships an older CEF, composites off-screen, and throttles `requestAnimationFrame`
  to ~40–50fps. Headless Chrome is a directional proxy, **not** a prediction of in-OBS cost —
  the real number needs the per-process reading described in SPEC §7.6.
- **Cloudflare Access has never been exercised for real.** The fail-closed paths were verified
  by reading and by the dev-mode build; a genuine Access-fronted request needs a deployment.
- **25 minor review findings were never verified.** See §5.

## 4. What the human still has to supply

1. **Production hostname** — `wrangler.jsonc` `routes` is the placeholder `REPLACE_ME`.
   `workers_dev: false` is set deliberately (an open `*.workers.dev` URL routes around the
   Access application), so the Worker is unreachable until this is filled in.
2. **`CF_ACCESS_AUD`** — only exists once the Access application is created in the dashboard.
   The Worker fails closed (401) without it. That is intended, not a bug.
3. **Real SFX.** `public/sfx/*.ogg` are valid Ogg Opus containers but identical 0.3565s
   generated placeholders. They fail silently, so nothing breaks — they just make no sound.
   The font is genuine (real variable WOFF2 with `HVAR`/`MVAR`/`STAT`) and needs nothing.
4. **IGDB credentials** if you want cover art. Without them every game has `cover_key = null`,
   which is a handled path — the cover cell collapses — but no art appears.

## 5. Known open work

**The five findings, re-checked against the working tree on 2026-08-21.** Two of them were
wrong. Verdicts, not restatements:

1. ~~`live-run.ts` — the replay guard is recorded AFTER the D1 commit, which breaks the
   documented 503 recovery path.~~ **REFUTED.** SPEC §4.9 specifies exactly this order: step 4
   is the D1 batch, step 6 is `kv.put('lastact')`. And §4.9 spells out the recovery path the
   finding claims is broken — "if step 4 throws, nothing is committed … the request returns
   503. The streamer taps again." A retry after a failed commit *must* proceed, which requires
   `lastact` to be unwritten. Recording the guard before the commit is what would break that
   path: a genuine 503 would then be swallowed as a duplicate and the WIN would never land.
   The finding has the causality backwards. No code change.
2. ~~`live-run.ts` — `configChanged()` and `rehydrate()` are byte-identical bodies.~~ **FALSE.**
   `src/live-run.ts:481-507`: `rehydrate()` also clears `state`, calls `hydrate()`, and
   broadcasts cause `snapshot` instead of `config`. Similar in shape, materially different.
3. `index.ts` / `live-run.ts` — SQL constants duplicated verbatim between them. **REAL (two
   pairs, not four) — FIXED 2026-08-21.** `R1_SESSION` and `R1_SESSION_GAMES` are now exported
   from `live-run.ts` and imported by `index.ts`; the duplicate `SQL_SESSION` /
   `SQL_SESSION_GAMES` are deleted. `SQL_SESSION_GAME_ONE` is a different query and stays.
   `npm run check` green after the change (tsc clean, 35/35, DCE pass).
4. `admin.css` — the phone action bar reserves 186px for a bar that is never actually fixed.
   **REAL, still open.** `public/admin/admin.css:131` reserves it; `position: fixed` appears
   nowhere in that file.
5. `admin.js` — `recapMarkup()` re-implements the renderer that already exists in `recap.js`.
   **REAL, still open**, and self-documented at `public/recap.js:15`. `admin.js:886`.

**25 minor review findings have no verdict.** A loop-until-dry review surfaced 41 findings
(5 blocker / 11 major / 25 minor) across three lenses. The blockers and majors were fixed. The
minors' adversarial verification died with a session limit, and 24 of 123 verifier agents never
reported. Note the workflow flaw: findings whose three verifiers all died were counted
"refuted" rather than "unverified", so roughly 8 were dropped for the wrong reason.

**Not done at all:** a v2 visual contract to replace `DESIGN.md` §2–§5, and the final review
pass against `workers-best-practices` + `ponytail` (the deletion-tally pass BUILD_PROMPT §10
asks for).

## 6. The decision waiting for the stream-time feature

`docs/STREAM_TIME_FEATURE_PROMPT.md` (a subathon clock) was ruled **out of scope** for this
build. When it is picked up, it collides with a decision taken here:

**The overlay has no footer.** It was deliberately removed — header + list only. But a subathon
clock is exactly the kind of thing that lived in the footer of the tool we benchmarked against
(their `39:54:31`). So that feature has to choose:

- bring the footer back to host the clock, accepting a taller panel; **or**
- make the clock its own overlay route and OBS source, positioned independently.

Decide that at the start, not halfway in. Related: the timer needs no new data — `sessions.started_at`
is already in D1 — but SPEC §4.2's `RunState` carries no timestamps, which is why the ENDED
card's duration is already best-effort and goes `null` after a reconnect.

## 7. Architecture, in one breath

One Worker. One Durable Object (`LiveRun`) owning live state, broadcasting over hibernatable
WebSockets. One D1 holding an append-only event log — the DO is a cursor over it, and DO state
is reconstructible from D1 at any time, which is the crash story. One R2 for covers. Workers
Assets serving `public/` verbatim with no build step and no framework.

Undo works by setting `undone_at` and re-running a pure reducer, never by compensating
arithmetic. The cursor follows the most recent non-undone `game_start` event and **never**
reads `order_index` — that one rule is what makes mid-session reordering and insertion
replay-safe for free (SPEC §2.2). It is the load-bearing idea in the whole design; read it
before changing anything in `run.ts`.
