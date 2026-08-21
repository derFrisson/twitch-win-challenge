# Operations

The runbook: everything you reach for *while operating* the tool, as opposed to setting it up
(that's the [README](../README.md)) or changing it ([SPEC.md](SPEC.md) / [DESIGN.md](DESIGN.md)).

## Tokens

Two independent bearer tokens, 160 bits of randomness each, generated lazily and stored in the
`LiveRun` Durable Object:

| Token | Grants | Lives in |
|---|---|---|
| **Overlay** | Read-only: live state (`/o/<token>`, its WebSocket), the recap page and JSON, the clock widget | OBS browser sources |
| **Control** | Write: win / loss / skip / undo / stop-loop, and the clock's pause / resume / +1h | Stream Deck buttons |

Both are bearer-by-URL: anyone with the URL has what the token grants, with no login and no
expiry. Treat both as secrets. The split exists because the overlay URL is the one that
realistically leaks (screen shares, support requests, chat asking for your overlay link), and
it can afford to.

**Rotation** (admin panel → Overlay URLs) invalidates the old URL *immediately*, with no
cache, no TTL, and no propagation delay. Rotating the overlay token also force-closes every
open overlay WebSocket, so update the URL in OBS right away or the widget goes blank on the
next state change. Rotating the control token orphans every Stream Deck button until you
re-paste them. The clock widget shares the overlay token: one credential, one rotation, one
OBS visit.

## Session operations

- **Start** requires a draft session with at least one game. Only one session can be live.
- **Stop after this game** is a latch, not an event: it survives undo (deliberately, because
  undo walks the event log, and the latch is intent about the future, not a fact about the
  past). Switching it off is the only thing that clears it. The armed state shows as a chip
  on the Loop section even when the section is folded.
- **Stop now** ends the session immediately; the in-progress game counts as abandoned. Undo
  brings the session back live with the game's counters intact.
- **Delete** works on drafts and ended sessions; history, recap data and exports go with it.
  A live session must be ended first (the server refuses otherwise).
- **Reordering** a live session's list only changes what plays *next*; nothing already played
  is reinterpreted. Moving an already-played game below the current one makes it play again
  this lap, from zero. That is the supported "give me another crack at it" move. The one
  forbidden move (dragging the *current* game to the last slot, which would end the run on its
  completion) is blocked in the UI and refused by the server.
- **Resume session / rehydrate** rebuilds the live state from the database and re-broadcasts
  it to every connected surface. It cannot lose anything, because the event log is the truth
  and the Durable Object's cache is disposable. Reach for it whenever the display looks wrong.

## Recap and exports

`/o/<token>/recap` renders the latest session (the live one if any, else the newest ended
one); `?session=<id>` pins a specific one. The page re-fetches on a slow poll, so a recap
scene left open in OBS updates on its own. The same figures render inside the admin's History
section, with JSON and CSV export buttons per session. The recap counts *every* visit to a
game (a replayed game's first visit stays in the numbers), and it is computed from the same
event log the overlay renders. The two cannot disagree.

## The subathon clock

### The model

```
earned    = min(base + floor(eligible_cents × 1h / cents_per_hour), cap)
consumed  = Σ running intervals, folded from the pause/resume log
remaining = earned − consumed
```

All money is integer cents, all time integer milliseconds; the admin form speaks hours and
euros and converts at the form boundary only. Because the clock is derived rather than
counted down, there is no stored countdown to lose: OBS reloads, WebSocket drops, redeploys
and reboots all land on the same recomputed number. Pausing stops consumption; donations that
arrive while paused still raise earned time.

### The GoFundMe dependency: read before a real subathon

The poller reads GoFundMe's **public but undocumented** GraphQL endpoint, the same one their
own stream widgets call. No auth, no key. It worked when captured (2026-08-21, fixtures in
`test/fixtures/gofundme/`) and it can change without notice. The failure behaviour is built
around that:

| Behaviour | Why |
|---|---|
| A nonexistent slug is an explicit `not_found`, never "raised €0" | GoFundMe answers HTTP 200 with a null fundraiser for bad slugs; read naively that is a silently wrong clock on camera. |
| A poll reporting **less** than before is refused; the old value stands and the admin says so | A refund or a glitch must never silently subtract hours mid-stream. |
| The campaign total is authoritative for time; the donation list only drives alerts and exclusions | A pagination gap can never change the hour count. Any mismatch shows in the admin. |
| Failures are classified retryable / permanent | Backing off for an hour against a typo'd slug is as wrong as hammering a 503. |
| Everything degrades to manual | With the poller dead, the admin banner reads "Data source: manual" and every figure stays editable by hand. The clock keeps running. |

### Own contributions

The streamer's own donation should count for the cause but not buy their own stream time:
untick "counts for time" on that donation in the admin list. The exclusion keys on GoFundMe's
donation id, so it survives re-polls and donating again. A flat manual deduction field exists
for off-platform cases, and the corrections ledger books arbitrary ± time or ± money with a
note. Every ledger entry is undoable.

### Pause semantics

Manual pause is sticky: only a human clears it. Twitch auto-pause is a separate latch. It
pauses after N consecutive offline polls and auto-resumes when the stream returns, but it can
never clear a manual pause. Both states are visible in the admin.

### What has never been tested against live services

Honest list; "the tests pass" does not mean "this ran on a real subathon".

- **Twitch auto-pause has never made a real API call.** The debounce logic is unit-tested
  against a fake clock and fake responses; the live path is not. It is off by default.
- **No long soak.** CPU and memory over a 40-hour run have not been measured. The widget is
  built to the budget (one 1 Hz self-correcting timer, no animation loops, bounded queues),
  but built-to is not measured-at.
- **The recap does not include the clock.** Total raised, hours earned vs slept, and the
  donation timeline are not in the recap or its exports.

## What you still need to supply

- **Sound effects**: `public/sfx/*.ogg` are valid Ogg Opus files but silent 0.36-second
  placeholders. Replace them with real sounds before using `?sfx=1`; until then, sound simply
  does nothing.
- **IGDB credentials** if you want cover-art search (see the README's setup §5). Without
  them, add games manually. The empty cover cell is a designed state, not a bug.

## Troubleshooting

| Symptom | Likely cause, in order |
|---|---|
| Admin answers 401 in production | `CF_TEAM_DOMAIN` / `CF_ACCESS_AUD` unset or wrong (fail-closed by design); Access application missing one of the two path patterns. |
| Overlay blank | No live session (by design); a rotated token; OBS "shutdown source when not visible" re-creating the page at a bad moment. |
| Overlay shows stale state | Press *Resume session* in the admin; it rebuilds from the database and re-broadcasts. |
| Stream Deck press opens a browser window | The Website action's background-request option is off. |
| Stream Deck press answers `dup` | Two presses landed within 600 ms; the second is deliberately swallowed (double-tap protection). |
| Covers missing on old games | They were added while IGDB was unreachable; the admin heals them automatically on the first page load after credentials work. |
| Clock banner says "Data source: manual" | The GoFundMe poll is failing (bad slug, or the endpoint changed). The clock still runs; figures are hand-editable until polling recovers. |
| A poll "found less money" warning | Deliberate hold-back. Verify on GoFundMe itself, then adjust via the corrections ledger if the lower figure is real. |
