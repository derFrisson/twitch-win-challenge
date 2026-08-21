# SPEC — Twitch Win-Challenge Overlay & Control Panel

> **What this document is.** The behavioural contract the tool was built against, kept as
> engineering history and as the reference for the parts that are still literally true: the
> state machine (§2), the D1 schema (§3), the WebSocket protocol (§4), the routes (§5), auth
> and tokens (§6), and the build/verify gates (§9). Two caveats for a reader arriving fresh:
> the overlay's *visual* details in §7 describe the original card where they conflict with
> the shipped v2 list ([DESIGN.md](DESIGN.md) and the code in `public/` are the visual
> authority), and references to a `BUILD_PROMPT.md` point at the original build brief, which
> is not part of the public repository. For day-to-day operation, read
> [OPERATIONS.md](OPERATIONS.md) instead.

**Status: AUTHORITATIVE for behaviour.** Where this document and the original build brief
differ, this document wins; every divergence is flagged `DIVERGENCE:` with its rationale,
and there are exactly three of them (§1.1, §2.0.1, §3.0.1).

Conventions used below:
- `DECIDED:` — the build prompt already settled this. Do not relitigate.
- `DECISION:` — the build prompt was silent. Decided here + one-line rationale.
- `ponytail:` — a deliberate simplification. Copy the comment text verbatim into the code.
- All timestamps in storage are **INTEGER epoch milliseconds** (see §3.0.1). All timestamps
  crossing an API or export boundary are **ISO-8601 UTC with milliseconds**.
- Target runtime: wrangler 4.125.0 / workerd 1.20260820.1, `compatibility_date 2026-08-20`.

---

## 1. File layout

Complete, final tree. No file exists that is not listed here. Every `src/*.ts` file is
imported by at least two others or is an entrypoint.

```
twitch-win-challenge/
├── .dev.vars.example              # dummy CF_TEAM_DOMAIN / CF_ACCESS_AUD / IGDB_* — committed
├── .gitignore                     # node_modules, dist, .wrangler, .dev.vars*, worker-configuration.d.ts
├── BUILD_PROMPT.md                # the requirements doc (already present, never edited)
├── README.md                      # setup, secrets, migrations, OBS settings, query params, Stream Deck
├── package.json                   # scripts + the 2 deps (jose, wrangler) — see §9.1
├── tsconfig.json                  # strict, noEmit, src/** only — see §9.3
├── wrangler.jsonc                 # the whole platform config — see §9.2
├── docs/
│   └── SPEC.md                    # this file
├── migrations/
│   └── 0001_init.sql              # the entire D1 schema; there is no 0002 at v1
├── src/
│   ├── index.ts                   # Worker entrypoint: the router (§5), asset fallthrough, re-export of LiveRun
│   ├── live-run.ts                # the LiveRun Durable Object: WS hibernation, RPC control, D1 append, tokens, rate limit
│   ├── run.ts                     # PURE state machine: Event/RunState types, reduce(), plan(), nextSessionGame(), nextUndoTarget()
│   ├── auth.ts                    # Access-JWT verify + __DEV__ branch + json()/logError()/withSecurityHeaders
│   ├── igdb.ts                    # IGDB search + cover ingest into R2; takes the app token as a PARAM (cached in the DO, §4.8)
│   ├── recap.ts                   # the recap SQL constants + JSON/CSV serialisers
│   ├── globals.d.ts               # declare const __DEV__: boolean  (wrangler types never generates this)
│   └── test_run.ts                # node --test assertions over run.ts — the §2.7 list, nothing else
└── public/                        # served by Workers Assets; THIS DIRECTORY IS THE FRONTEND SOURCE (no build step)
    ├── overlay.html               # OBS browser-source shell, served at /o/<token>
    ├── overlay.css                # overlay styles; also linked by recap.html
    ├── overlay.js                 # WS client + animation queue + renderer (plain ES module)
    ├── recap.html                 # end-of-stream recap shell, served at /o/<token>/recap
    ├── recap.js                    # fetches recap.json, draws the inline-SVG charts
    ├── strings.js                 # ALL German user-facing copy for all three frontends (§9 of the prompt)
    ├── admin/
    │   ├── index.html             # the single admin page (7 sections, §8)
    │   ├── admin.css              # admin styles — one-handed, phone-first
    │   └── admin.js               # admin logic: fetch() to /api/admin/*, WS to /api/admin/ws
    ├── fonts/
    │   └── inter-var-latin.woff2  # ONE self-hosted variable font, latin subset, weights 400–900
    └── sfx/
        ├── streak-start.ogg       # §6.5, off unless ?sfx=1
        ├── streak-break.ogg
        └── game-won.ogg
```

**DECISION: the frontend has no build step and no bundler.** `public/` is hand-written plain
ES modules + CSS served verbatim as Workers Assets. Rationale: the hard constraint is the OBS
CPU budget (§7.6 of the prompt), and the smallest, most predictable payload is the one with no
transform between source and wire; a bundler for three pages is an abstraction with a single
implementation. `tsc --noEmit` typechecks `src/**` only.

`ponytail:` comment to place at the top of `public/overlay.js`:
```js
// ponytail: plain ES module, no bundler, no framework. The overlay never computes state —
// it renders what the DO sends. If this file ever needs a build step, the design got too big.
```

### 1.1 DIVERGENCE — "all user-facing strings in one module"

Prompt §9 asks for every user-facing string in one module. **`public/strings.js` is that module
for all three frontends** (overlay, recap, admin) — it is the only place any string a viewer or
the streamer reads is defined. The **seven server-side German strings are exempt**: the four
`requireAccess` 401 messages in `src/auth.ts` and the three plain-text `/c/*` bodies (`ok`,
`noop`, `rate limited`) in `src/index.ts`. Rationale: a browser-targeted ES module cannot be
imported by the Worker without a bundler (§1's no-build-step decision), and adding one to share
seven strings that are never on camera would cost more than a translation pass ever saves.
Switching languages is still a one-file edit for everything the audience sees.

**DECISION: no `src/lib/` folder.** Five modules, each with ≥2 importers or an entrypoint role.
`json()` / `logError()` / `withSecurityHeaders()` live in `auth.ts` because auth is the only
thing that needs all three and splitting them into `http.ts` would create a 20-line file with
one consumer.

---

## 2. The run state machine

### 2.0 Architecture of the state machine

Three pure functions in `src/run.ts` are the whole state machine. `live-run.ts` contains no
transition logic; it only does I/O and calls these.

```
plan(action, events, cfg, now, actionId) -> Plan       // "what should be appended?"  (transition table §2.3)
reduce(events, cfg)                      -> RunState    // "what is true now?"         (fold table §2.4)
nextSessionGame(sessionGames, currentId)  -> SessionGameRow | null   // advance target (§2.5e)
nextUndoTarget(events)                    -> string | null           // action_id to undo (§2.5d)
```

#### 2.0.1 DIVERGENCE — "deltas"

Prompt §2 says the overlay "receives a full state snapshot, then receives deltas."
**This spec sends a full `RunState` on every step, tagged with the `cause` that produced it.**
Rationale: `RunState` is ~700 bytes; a real delta format would require a second reducer in the
browser, which directly contradicts the same paragraph's "it never computes what the next state
should be." The `cause` field carries exactly the information a delta would have carried (what
changed), without a client-side state machine. See §4.3.

### 2.1 Literal types (`src/run.ts`)

```ts
// ---------- stored rows ----------

export type Mode = 'single' | 'b2b';

export type EventType =
  | 'session_start'   // user-initiated: a session went live
  | 'game_start'      // DERIVED bookkeeping: the cursor moved onto a (session_game, lap)
  | 'win'             // user-initiated
  | 'loss'            // user-initiated
  | 'skip'            // user-initiated; also the terminal marker for that visit
  | 'game_won'        // DERIVED bookkeeping: the visit was completed by the preceding win
  | 'game_abandoned'  // user-initiated ("stop now"): the visit ended unfinished
  | 'session_end';    // terminal: loop off + last game done, or "stop now", or "stop after current"

export type Event = {
  seq: number;                  // D1 AUTOINCREMENT. The ONLY ordering authority.
  session_id: number;
  session_game_id: number | null; // null for session_start / session_end only
  lap: number;                  // 1-based. Carried ON the event so replay is stable (§2.5g).
  type: EventType;
  action_id: string;            // uuid v4. All events appended by ONE admin action share it (§2.5a).
  created_at: number;           // epoch ms
  undone_at: number | null;     // epoch ms; non-null => the reducer ignores this row
  meta_json: string | null;     // free-form JSON string; never read by the reducer
};

export type NewEvent = Omit<Event, 'seq' | 'undone_at'>;   // what plan() emits

export type SessionRow = {
  id: number;
  title: string;
  loop: boolean;                 // 0/1 in D1, boolean here
  stop_after_current: boolean;   // 0/1 in D1 — a REQUEST, not an event (§2.5h)
  status: 'draft' | 'live' | 'ended';
  started_at: number | null;
  ended_at: number | null;
};

export type SessionGameRow = {
  id: number;                    // == events.session_game_id
  session_id: number;
  game_id: number;
  order_index: number;           // mutable; the cursor NEVER follows it (§2.5e)
  mode: Mode;                    // already resolved: session_games.mode ?? games.default_mode
  title: string;                 // joined from games.name
  cover_key: string | null;      // joined from games.cover_key; bare R2 object name, served at /covers/<key>
};

export type ReduceContext = {
  session: SessionRow | null;
  sessionGames: readonly SessionGameRow[];  // ALL rows for the session, any order
};

// ---------- computed state ----------

export type DisplayMode = 'IDLE' | 'LOSS_MODE' | 'STREAK_MODE' | 'ENDED';

export type CurrentGame = {
  sessionGameId: number;
  gameId: number;
  title: string;
  coverKey: string | null;
  mode: Mode;
  required: 1 | 2;               // mode === 'b2b' ? 2 : 1
  losses: number;                // cumulative in this visit; NEVER reset by a broken streak
  wins: number;                  // total wins in this visit, including wins from broken streaks
  streak: number;                // 0..required-1 at rest (see §2.5k); === required ONLY on the emitted `game_won` step
  attempts: number;              // losses + wins  (§2.5i)
  startedAt: number;             // created_at of the visit's game_start event
  positionInLap: number;         // 1-based index of this game in the CURRENT order_index ordering
  lapSize: number;               // sessionGames.length
};

export type RunState = {
  phase: 'idle' | 'live' | 'ended';
  sessionId: number | null;
  sessionTitle: string | null;
  loop: boolean;
  stopAfterCurrent: boolean;
  lap: number;                   // lap of the current game; 0 when phase !== 'live'
  current: CurrentGame | null;   // null unless phase === 'live'
  displayMode: DisplayMode;
  upNext: { sessionGameId: number; title: string; coverKey: string | null }[]; // what plays next, in (order_index,id) order, max 3; crosses the lap boundary iff loop
  totals: {
    gamesPlayed: number;         // number of visits (distinct game_start events, non-undone)
    gamesWon: number;
    gamesSkipped: number;
    gamesAbandoned: number;
    wins: number;                // all non-undone win events in the session, all laps
    losses: number;
    attempts: number;            // wins + losses
  };
  lastSeq: number;               // seq of the highest non-undone event folded into this state; 0 if none
};

// ---------- planner ----------

export type Action =
  | { kind: 'start'; sessionId: number }
  | { kind: 'win' } | { kind: 'loss' } | { kind: 'skip' }
  | { kind: 'undo' }
  | { kind: 'stop_now' };

export type Plan =
  | { ok: true; append: NewEvent[] }
  | { ok: true; undoAction: string }
  | { ok: false; reject: 'no_live_session' | 'session_ended' | 'empty_session'
                       | 'nothing_to_undo' | 'already_live' | 'not_draft' };
```

`plan()` returns `{ok:true, undoAction}` for undo (an UPDATE, not an append) and
`{ok:false, reject}` for every refusal. `live-run.ts` maps `reject` to an HTTP status (§5.4).

### 2.2 What the cursor follows — the replay-stability rule

**This is the load-bearing rule of the whole design. Read it twice.**

> The cursor is `(session_game_id, lap)` taken from the **most recent non-undone `game_start`
> event**. `order_index` is **never** consulted by `reduce()`. `order_index` is consulted only
> by `nextSessionGame()`, only at the moment an advance is planned, and the result of that
> lookup is then **frozen into the log** as a `game_start` event.

Consequences, all of which the implementer gets for free:
- Reordering or inserting games mid-session cannot change the meaning of a single historical
  event, because no historical event's interpretation depends on the mutable ordering.
- Replaying the log years later against a completely reshuffled `session_games` list yields
  byte-identical counters and the identical cursor.
- The only thing that changes when the ordering changes is *what happens next*.

### 2.3 Transition table A — planner (`plan()`)

`cur` = `reduce(events, cfg)`. `sg` = `cur.current`. `next` = `nextSessionGame(cfg.sessionGames, sg.sessionGameId)`.
Every row's `append` array is ONE action: one `action_id`, one `created_at`, appended in one
D1 `batch()`.

| Action | Precondition (else reject) | Appended events, in order |
|---|---|---|
| `start` | session exists (loaded **by id** — R1 bound to `action.sessionId`, §3.2) → else `no_live_session`; `status='draft'` → else `not_draft`; `sessionGames.length >= 1` → else `empty_session`; R1b finds no *other* live session → else `already_live` | `session_start(sg=null, lap=1)`, `game_start(sg=first by order_index, lap=1)` |
| `win` | `phase='live'` → else `no_live_session` / `session_ended` | `win(sg, lap)`; **then if `sg.streak + 1 >= sg.required`:** `game_won(sg, lap)` + the advance tail (below) |
| `loss` | `phase='live'` | `loss(sg, lap)` — never advances |
| `skip` | `phase='live'` | `skip(sg, lap)` + the advance tail |
| `stop_now` | `phase='live'` | `game_abandoned(sg, lap)`, `session_end(null, lap)` |
| `undo` | `nextUndoTarget(events) !== null` → else `nothing_to_undo` | *no append* → `{undoAction}` |

**The advance tail** (appended after `game_won` or `skip`, in the same action):

| Condition, evaluated in order | Appended |
|---|---|
| `session.stop_after_current === true` | `session_end(null, lap)` |
| `next !== null` | `game_start(next.id, lap)` |
| `next === null && session.loop === true` | `game_start(first by order_index, lap + 1)` |
| `next === null && session.loop === false` | `session_end(null, lap)` |

`nextSessionGame(sessionGames, currentId)`: sort a **copy** of `sessionGames` by
`(order_index, id)`; find the entry whose `id === currentId`; return the next entry, or `null`
if it is last or `currentId` is not found. Tie-break on `id` so a duplicated `order_index`
(possible — the index is not unique, §3.1) is still deterministic.

### 2.4 Transition table B — reducer fold (`reduce()`)

`reduce` sorts a copy of `events` ascending by `seq`, drops every row with `undone_at !== null`,
then folds. `V` = the per-visit accumulator for the current `(session_game_id, lap)` key.

| Event type | Precondition in the fold | State delta | Resulting `displayMode` | Notes |
|---|---|---|---|---|
| `session_start` | none | `phase='live'`, `sessionId`, `sessionTitle`, `loop`, `stopAfterCurrent` from `cfg.session`; `current=null` | `IDLE` (momentarily; the same action's `game_start` follows) | resets all `totals` to 0 |
| `game_start` | `phase='live'` | **opens a fresh visit**: `current = {sessionGameId, lap, losses:0, wins:0, streak:0, attempts:0, startedAt: created_at}` resolved against `cfg.sessionGames`; `lap = event.lap`; `totals.gamesPlayed += 1` | `LOSS_MODE` | if the id is missing from `cfg.sessionGames`, `current.title = '???'`, `mode='single'` — never throw on stream |
| `win` | `current !== null` | `V.wins += 1`, `V.streak += 1`, `V.attempts += 1`, `totals.wins += 1`, `totals.attempts += 1` | `STREAK_MODE` if `V.streak < required`, else `LOSS_MODE` (the completion follows in the same action) | for `single`, `streak` reaches 1 = `required` and `game_won` follows in the same action, so `STREAK_MODE` is never emitted (§2.5k) |
| `loss` | `current !== null` | `V.losses += 1`, `V.streak = 0`, `V.attempts += 1`, `totals.losses += 1`, `totals.attempts += 1` | `LOSS_MODE` | **DECIDED (prompt §3.3): `losses` is cumulative and is NOT reset by a broken streak.** |
| `skip` | `current !== null` | visit outcome = `skipped`; `totals.gamesSkipped += 1`; **`V.streak = 0`** (the visit is over; no streak outlives it, so a skip after a b2b first win is not a flame beat); `losses`/`wins`/`attempts` untouched | `LOSS_MODE` (the following `game_start` overwrites it) | neither win nor loss; `attempts` unchanged |
| `game_won` | `current !== null` | visit outcome = `won`; `totals.gamesWon += 1`; `current` counters left AS-IS so the celebration can render the winning numbers | `LOSS_MODE` | **the one emitted state where `streak === required`** — which is exactly why the derived `displayMode` is `LOSS_MODE` here; the *next* `game_start` in the same action zeroes them |
| `game_abandoned` | `current !== null` | visit outcome = `abandoned`; `totals.gamesAbandoned += 1`; **`V.streak = 0`** | `LOSS_MODE` | |
| `session_end` | none | `phase='ended'`, `current=null`, `lap=0` | `ENDED` | `sessionTitle`/`totals` retained for the ENDED card |

`displayMode` is **derived, not stored**:
```ts
displayMode = phase === 'idle'  ? 'IDLE'
            : phase === 'ended' ? 'ENDED'
            : (current!.streak > 0 && current!.streak < current!.required)
              ? 'STREAK_MODE' : 'LOSS_MODE';
```
`required` is part of the condition **on purpose**. A `streak` that has *reached* `required` is a
finished game, not a running streak. §4.2 emits one `RunState` per appended event, so without the
upper bound the `win` and `game_won` steps of a completing win would both report `STREAK_MODE` and
§4.3 would cross-fade the flame hero to `1/1` for 450 ms before every single-mode celebration.

**`GAME_WON` is NOT a display mode.** Prompt §6.3 lists three "display modes"; two of them
(`LOSS_MODE`, `STREAK_MODE`) are resting states and the third is a transition. `GAME_WON` is a
**cause** (§4.3) that the overlay plays as an animation and then settles out of. There is no
`RunState` in which `displayMode === 'GAME_WON'`, and the overlay must never try to *rest* in a
celebration — a frozen celebration on camera is exactly the failure prompt §3.6 forbids.

`upNext` is computed at the end of the fold from the LIVE `cfg.sessionGames` (sorted by
`order_index, id`). One rule: the next **`min(3, lapSize - 1)` distinct entries** strictly after
the current entry, wrapping to the head of the list **iff `loop === true`**, **never including
`current.sessionGameId`**, and `[]` when `lapSize <= 1` or `phase !== 'live'`. The exclusion and
the `lapSize - 1` bound are what stop a 1-game looping session from rendering "Als nächstes: <the
game on screen>" (and a 2-game one from listing the current game third). This is the one place
where mutable ordering reaches `RunState` — and it is display-only, never fed back into the fold.

### 2.5 The edge cases, answered

#### a) Is `game_won` a stored event or derived?

**STORED**, and undo operates on **actions**, not rows.

The reconciliation the prompt asks for: if `game_won` were an independently-undoable row, then
one UNDO after a game-winning win would remove `game_won` and leave the `win` — producing a
state where the game is complete-but-not-completed, requiring a second UNDO. **That is wrong**,
and it is wrong in the worst possible place: on camera, one-handed, under pressure. So:

- `events.action_id` (uuid v4) is stamped identically on **every event appended by one admin
  action**. A game-winning win writes three rows — `win`, `game_won`, `game_start` — all sharing
  one `action_id`.
- **Undo = mark `undone_at` on every event of the most recent non-undone action.** Prompt §3.5's
  "the most recent non-undone event" is honoured as "the most recent non-undone *action*", which
  is the same thing for every single-row action (loss, non-completing win) and the only correct
  thing for multi-row actions.
- Why store it at all rather than derive it: the recap SQL (§3.4) needs a terminal outcome row
  per visit. Deriving "was this visit won?" in SQL would require SQL to know each game's
  `required` and to count *consecutive* wins — a window-function fold in every recap query.
  One marker row makes six recap queries trivial. That is the trade: one column
  (`action_id`) and one extra row per completed game, in exchange for no fold in SQL and correct
  single-press undo.

`ponytail:` comment for `src/run.ts`:
```ts
// ponytail: undo is per-ACTION, not per-row. action_id groups the rows one button press
// wrote (win + game_won + game_start) so one UNDO reverses one thing the human did.
// Ceiling: an action can never span two sessions; if it ever needs to, group by a real
// transaction id instead.
```

#### b) Is `game_start` a stored event or derived?

**STORED.** It is the cursor anchor and therefore the entire answer to (e), (f) and (g). A
derived cursor would have to be `session_games` position arithmetic, which breaks the instant
`order_index` changes. `game_start` belongs to the action that caused the advance — so the
first `game_start` of a session shares the `session_start` action, and the `game_start` after a
game-winning win shares that win's action.

#### c) Undo across a game boundary — full walkthrough

Setup: `SG1` mode `b2b` (`required = 2`), `SG2` next. Session `loop=false`.

| # | seq | action | type | sg | lap |
|---|---|---|---|---|---|
| 1 | 1 | A1 | `session_start` | null | 1 |
| 2 | 2 | A1 | `game_start` | SG1 | 1 |
| 3 | 3 | A2 | `win` | SG1 | 1 |
| 4 | 4 | A3 | `win` | SG1 | 1 |
| 5 | 5 | A3 | `game_won` | SG1 | 1 |
| 6 | 6 | A3 | `game_start` | SG2 | 1 |

State after seq 6: `current = SG2`, `streak 0`, `losses 0`, `wins 0`, `attempts 0`,
`displayMode LOSS_MODE`, `totals.gamesWon 1`, `totals.gamesPlayed 2`, `totals.wins 2`.

**UNDO** → `nextUndoTarget` walks non-undone events by descending `seq`, takes `seq 6`, reads
its `action_id` = `A3`, checks A3's lowest-seq event type is not `session_start` → returns `A3`.
`UPDATE events SET undone_at=? WHERE action_id='A3' AND undone_at IS NULL` marks seq 4, 5 and 6.

`reduce()` now folds seq 1, 2, 3 only:

```
current = { sessionGameId: SG1, mode:'b2b', required:2,
            losses: 0, wins: 1, streak: 1, attempts: 1, startedAt: <seq2.created_at> }
lap = 1
displayMode = 'STREAK_MODE'
totals = { gamesPlayed: 1, gamesWon: 0, gamesSkipped: 0, gamesAbandoned: 0,
           wins: 1, losses: 0, attempts: 1 }
lastSeq = 3
```

One press, back to "1/2 on SG1, flame lit". Exactly what the streamer expects. A second UNDO
takes `A2` → `current = SG1, streak 0, attempts 0, displayMode LOSS_MODE`.

#### d) Undo with nothing to undo / undo of `session_start`

`nextUndoTarget(events)`:
```
live = events where undone_at === null, sorted by seq desc
if live is empty                                  -> null
target = live[0].action_id
if min-seq event of that action has type 'session_start' -> null   // REFUSED
return target
```

- Nothing to undo (empty log, or every action already undone) → `null` → `plan` rejects
  `nothing_to_undo` → HTTP **409**, no event written, no broadcast, no state change.
- **Undo of `session_start` is REFUSED.** Rationale: the session_start action also carries the
  first `game_start`, so undoing it would silently un-start the session and blank the overlay
  mid-stream. Ending a session is an explicit, separate act (`stop_now` / `stop after current`),
  never a side effect of an UNDO tap. The admin button shows "Nichts zum Rückgängigmachen".
- The `UPDATE ... AND undone_at IS NULL` guard prevents re-marking **one** action; it does **not**
  make a duplicated undo *request* safe. A second request re-runs `nextUndoTarget()` against the
  freshly-read log and would rewind a **second, different** action — a double-tapped Stream Deck
  button silently eating the loss before the mistake, with no redo to get it back. The replay
  guard in §4.10 is what actually closes this, and it is mandatory.
- There is **no redo.** Not requested; the log keeps the audit trail either way.

#### e) A game inserted into a live session

Exact rule:

> An insert or a reorder changes `order_index` **only**. The cursor does not move.
> On the next advance, `nextSessionGame()` returns the entry with the **smallest
> `(order_index, id)` strictly greater than the current game's `(order_index, id)`**.

Therefore:
- **Inserted after the cursor** → played this lap, at its position.
- **Inserted before the cursor** → NOT played this lap. Played on lap 2+ if `loop = true`;
  never, if `loop = false`. The cursor never walks backwards inside a lap.
- **"The session already looped past it"** is not a distinct case: laps do not remember
  anything. Every lap re-walks whatever the list looks like *at the time of each advance*.
- Replay stability: guaranteed by §2.2 — the reducer never reads `order_index`, so a mutated
  `session_games` list cannot change the interpretation of any historical event. The advance
  decision is a *non-pure* lookup performed once, by the DO, and immediately frozen into a
  `game_start` row.
- A `session_game` row that any event references **cannot be deleted**: `DELETE
  /api/admin/sessions/:id/games/:sgid` returns **409** if
  `SELECT 1 FROM events WHERE session_game_id = ?` matches. Enforced by that SELECT in the
  handler plus `ON DELETE RESTRICT` on the FK as the backstop. Removing a not-yet-played entry
  is allowed and is the supported way to drop a game from a live session.
- The overlay's "up next" list is display-only (§2.4) and updates immediately on insert.

#### f) Reordering a live session's games

Identical rule to (e) — it is the same operation on the same column. Three named consequences the
implementer must not treat as bugs:

1. **Moving an already-played game to after the cursor makes it play again this lap.** Allowed;
   it is the only way to redo a game the streamer wants another crack at.
2. That second visit **starts from zero**, because per-visit counters are folded from the events
   after the *most recent* non-undone `game_start` for that `(session_game_id, lap)` key — see
   the window rule below. The first visit's numbers stay in the log and in the recap (the recap
   SQL counts **every** visit, §3.3).
3. **Moving the currently-playing entry to the last position would silently end the run.**
   `nextSessionGame()` would return `null` on that game's completion, so the advance tail would
   append `session_end` (`loop=false`) or wrap to lap+1 (`loop=true`) with every unplayed entry
   of the lap skipped — mid-stream, recoverable only by an UNDO plus another reorder. This is
   **not** allowed to happen: §8.3 renders the current entry with its drag handle disabled, and
   route 17 returns **400** when `phase==='live'`, `order.length > 1` and the submitted array
   puts `state.current.sessionGameId` last. (The alternative — making the advance tail fall back
   to the lowest unplayed entry of the lap — would silently break case 1's deliberate replay, so
   the validation is the smaller fix.)

**The visit-window rule (single rule, no exceptions):**
> Per-game counters (`losses`, `wins`, `streak`, `attempts`, `startedAt`) are folded from
> non-undone events with the same `(session_game_id, lap)` whose `seq` is greater than the
> `seq` of the **most recent non-undone `game_start`** for that key.

The fold in §2.4 implements this for free, because it processes events in `seq` order and
`game_start` re-initialises the visit accumulator.

#### g) Loop wrap

`lap` is **a column on every event**, written by `plan()`, never a derived counter. `RunState.lap`
is simply the `lap` of the current `game_start`. Rationale: a derived lap counter would have to
count wraps, and a single undone wrap event would silently shift every later lap number.

Exact end-of-lap sequence, last game `SGn` = `b2b`, second win lands, `loop = true`:

| seq | action | type | sg | lap |
|---|---|---|---|---|
| k   | A | `win` | SGn | 3 |
| k+1 | A | `game_won` | SGn | 3 |
| k+2 | A | `game_start` | SG1 | **4** |

`loop = false` instead:

| seq | action | type | sg | lap |
|---|---|---|---|---|
| k   | A | `win` | SGn | 3 |
| k+1 | A | `game_won` | SGn | 3 |
| k+2 | A | `session_end` | null | 3 |

Terminal state with `loop = false`:
```ts
{ phase:'ended', current:null, lap:0, displayMode:'ENDED',
  sessionId:<id>, sessionTitle:<title>, loop:false, stopAfterCurrent:<unchanged>,
  upNext: [], totals:{...final}, lastSeq:k+2 }
```
`sessions.status` is set to `'ended'` and `sessions.ended_at` to the event's `created_at` in the
same D1 `batch()` as the `session_end` insert. The overlay renders an ENDED card (compact,
final numbers, no animation). The recap route reads the same session.

#### h) "Stop after current game"

**It lives in `sessions.stop_after_current` (INTEGER 0/1).** Not an event, not DO-only state.

Rationale: it is mutable *intent about the future*, not a fact about the past. An append-only
log is the wrong home for something you toggle on and off, and putting it there would make undo
ambiguous ("did that UNDO retract my stop request or my last loss?"). A `sessions` column is
also the crash story: it survives a DO reset with no reconciliation. The DO caches it inside its
`cfg` kv entry. **Every method whose D1 batch touches the `sessions` row — `setStopAfterCurrent()`,
`start()`, and any control turn that writes a W3 `UPDATE sessions` — patches the cached
`cfg.session` with the value it just wrote, in the same `serialise()` body, before step 5**
(§4.9 step 4b). Without that, `plan()`'s advance tail and the broadcast `RunState.stopAfterCurrent`
keep reading the pre-tap value: the armed indicator stays dark on camera and the session loops on
after the streamer announced the last game. `configChanged()` / `rehydrate()` drop the entry
entirely.

- **Toggled twice** → back to `0`. The endpoint is an idempotent **set**, not a toggle:
  `POST /api/admin/control/stop-after-current` with body `{"on": true|false}`. The Stream Deck
  route `GET /c/:t/stop-loop` sets it to `true` (never toggles — a hotkey that means two
  different things depending on hidden state is a live-stream bug).
- **Set it, then press UNDO** → the flag is **untouched**. UNDO walks the event log only. The
  admin UI must therefore render it as a *latched indicator* ("Stoppt nach diesem Spiel") with
  its own visible off switch, so nobody expects UNDO to clear it.
- **It is never auto-cleared.** If it fires (a `session_end` is appended instead of the next
  `game_start`) and the streamer then UNDOes that action, the flag is still `1` and the *next*
  completion will end the session again. That is the correct reading: the standing request
  persists until the human retracts it.
- Consumed only at an advance, as the first row of the advance tail in §2.3.

#### i) `attempts`

Confirmed, exactly as prompt §3.2 states: **`attempts = losses + wins`** where `wins` is
**every** win event in the current visit window — including wins that were part of a b2b streak
that was later broken — and where both counts **exclude every event with `undone_at != null`**.
`skip`, `game_won`, `game_abandoned`, `game_start` and `session_*` never touch `attempts`.
`test_run.ts` asserts the identity as a property over a mixed log (§2.7 test 10).

#### j) Last game of a non-looping session

**Win on the last game** (`required` reached), `loop=false`, `stop_after_current=false`:
```
append: win(SGn, lap) , game_won(SGn, lap) , session_end(null, lap)      // one action
final:  phase 'ended', current null, displayMode 'ENDED', totals.gamesWon += 1
```

**Skip on the last game**, same session:
```
append: skip(SGn, lap) , session_end(null, lap)                          // one action
final:  phase 'ended', current null, displayMode 'ENDED', totals.gamesSkipped += 1
```
Note there is no `game_skipped` type — `skip` is both the input and the visit's terminal marker.
One UNDO on either of these returns to the last game with its counters intact and
`sessions.status` back to `'live'` (§5.4: the undo handler recomputes `status`/`ended_at` from
the post-undo `RunState.phase` in the same batch). This works **because the DO is bound to a
session id (kv `sid`), not to `status='live'`** (§3.2 R1, §4.7a): after `session_end` there is no
live row left to rediscover, and a status-keyed config load would leave undo with no event log and
a 409 on camera.

#### k) `single`-mode games and `STREAK_MODE`

For `mode='single'`, `required = 1`. The first `win` satisfies `streak >= required` inside the
same `plan()` call, so `game_won` and the advance tail are appended in the same action and the
reducer never produces a resting state with `streak === 1` for that game.

> **`STREAK_MODE` is unreachable for `single`-mode games.** The overlay must still handle
> receiving it (defensive render), but no valid event sequence produces it.

The only resting `streak > 0` state in the entire system is `b2b` at `streak === 1`.

### 2.6 Purity contract for `run.ts`

`reduce`, `plan`, `nextSessionGame` and `nextUndoTarget` **MUST NOT**:

- call `Date.now()`, `new Date()` with no argument, `performance.now()`, `Math.random()`,
  `crypto.*`, or read any global mutable state;
- perform any I/O — no `fetch`, no `env.*`, no `ctx.storage`, no `console.*` (not even
  `console.warn`);
- mutate any argument, including nested objects and arrays — sort a **copy**
  (`[...events].sort(...)`), never `events.sort(...)`;
- throw for data reasons (an unknown `session_game_id`, a `game_start` while already live, a
  `win` with no current game): degrade and carry on. The single exception: an **unknown
  `EventType`** throws, because that can only mean the code and the schema disagree and rendering
  something plausible-but-wrong on camera is worse than a visible failure.

`plan()` takes `now: number` and `actionId: string` as **parameters**. `live-run.ts` supplies
`Date.now()` and `crypto.randomUUID()`. That is the entire impurity boundary.

`run.ts` imports nothing. Not `cloudflare:workers`, not `jose`, nothing. `test_run.ts` runs it
under plain `node --test` with no Workers runtime.

### 2.7 `src/test_run.ts` — the required assertions

Run with `node --test src/test_run.ts` after `tsc`-free execution via `node --experimental-strip-types`
(Node 24 strips TS natively — see §9.1). No framework, no fixtures, no mocks. Build the event
arrays inline with a local `ev(type, sg, lap, action)` helper and the `SessionGameRow` arrays
inline. **Every test below must exist, by this name, and assert what the "Expected" column says.**

| # | Test name | Setup | Expected |
|---|---|---|---|
| 1 | `empty_log_is_idle` | `reduce([], {session:null, sessionGames:[]})` | `phase 'idle'`, `current null`, `displayMode 'IDLE'`, all `totals` 0, `lastSeq 0` |
| 2 | `session_start_opens_first_game` | `plan({kind:'start'},[],cfg)` then `reduce` | appends exactly `session_start` + `game_start(SG1,1)` sharing one `action_id`; `phase 'live'`, `current.sessionGameId===SG1`, `losses/wins/streak/attempts` all 0, `displayMode 'LOSS_MODE'`, `totals.gamesPlayed 1` |
| 3 | `start_rejects_empty_session` | `sessionGames: []` | `plan` → `{ok:false, reject:'empty_session'}`; no events |
| 4 | `single_win_completes_and_advances` | SG1 `single`, `win` | appends `win`,`game_won`,`game_start(SG2,1)`, one `action_id`; final `current.sessionGameId===SG2`, counters 0, `totals.gamesWon 1` |
| 5 | `single_never_enters_streak_mode` | fold every prefix of test 4's log | no prefix yields `displayMode==='STREAK_MODE'` |
| 6 | `b2b_first_win_is_streak_mode` | SG1 `b2b`, one `win` | `streak 1`, `wins 1`, `losses 0`, `attempts 1`, `displayMode 'STREAK_MODE'`; `plan` appended ONLY `win` (no `game_won`) |
| 7 | `b2b_clean_win` | SG1 `b2b`, `win`,`win` | second action appends `win`,`game_won`,`game_start(SG2,1)`; state at the `game_won` prefix has `wins 2, losses 0, attempts 2`; `totals.gamesWon 1` |
| 8 | `b2b_broken_streak_keeps_losses` | `win`,`loss` | `streak 0`, `losses 1`, `wins 1`, `attempts 2`, `displayMode 'LOSS_MODE'` — **losses is 1, not 0** |
| 9 | `b2b_broken_then_won` | `win`,`loss`,`win`,`win` | at `game_won`: `losses 1`, `wins 3`, `attempts 4`; game completes on the 4th event's action |
| 10 | `attempts_equals_losses_plus_wins` | a 12-event mixed log across 2 games and 2 laps | for every prefix: `current.attempts === current.losses + current.wins` AND `totals.attempts === totals.losses + totals.wins` |
| 11 | `skip_advances_without_counters` | SG1, `loss`,`loss`,`skip` | appends `skip`+`game_start(SG2,1)`; `totals.gamesSkipped 1`, `totals.losses 2`, `totals.attempts 2`; SG2 counters 0 |
| 12 | `undo_single_row_action` | `loss` then undo | `nextUndoTarget` returns the loss's `action_id`; after marking, `losses 0`, `attempts 0`, `displayMode 'LOSS_MODE'` |
| 13 | `undo_across_game_boundary` | the exact §2.5c table | `current.sessionGameId===SG1`, `streak 1`, `wins 1`, `losses 0`, `attempts 1`, `lap 1`, `displayMode 'STREAK_MODE'`, `totals.gamesWon 0`, `totals.gamesPlayed 1`, `lastSeq 3` |
| 14 | `undo_action_group_is_atomic` | same | all three of seq 4,5,6 have `undone_at !== null`; `events.length` is unchanged at 6 |
| 15 | `undo_twice_reaches_pre_win_state` | undo again after 13 | `streak 0`, `wins 0`, `attempts 0`, `current.sessionGameId===SG1`, `displayMode 'LOSS_MODE'` |
| 16 | `undo_refuses_session_start` | only the `session_start` action remains non-undone | `nextUndoTarget` → `null`; `plan({kind:'undo'})` → `{ok:false, reject:'nothing_to_undo'}` |
| 17 | `undo_on_empty_log_is_null` | `nextUndoTarget([])` | `null` |
| 18 | `undo_skips_already_undone` | log where the newest action is already undone | `nextUndoTarget` returns the *previous* action's id, not the undone one |
| 19 | `loop_wrap_increments_lap` | last game won, `loop:true` | tail is `game_start(SG1, lap+1)`; `reduce` gives `lap === 2`, SG1 counters 0, and the lap-1 SG1 events are still counted in `totals` |
| 20 | `no_loop_ends_session` | last game won, `loop:false` | tail is `session_end`; `phase 'ended'`, `current null`, `lap 0`, `displayMode 'ENDED'`, `upNext []` |
| 21 | `skip_on_last_game_ends_session` | `skip` on last game, `loop:false` | appends `skip`+`session_end`; `phase 'ended'`, `totals.gamesSkipped 1` |
| 22 | `stop_now_abandons_current` | `plan({kind:'stop_now'})` mid-game | appends `game_abandoned`+`session_end`; `phase 'ended'`, `totals.gamesAbandoned 1` |
| 23 | `stop_after_current_ends_instead_of_advancing` | `session.stop_after_current:true`, win completes a NON-last game | tail is `session_end`, **not** `game_start`; `phase 'ended'` |
| 24 | `stop_after_current_survives_undo` | test 23 then undo | `phase 'live'` on the completed game again, and `cfg.session.stop_after_current` is still `true` (the reducer never writes it) |
| 25 | `advance_skips_game_inserted_before_cursor` | current = order 3; insert at order 2 | `nextSessionGame` returns the order-4 entry, not the new one |
| 26 | `advance_takes_game_inserted_after_cursor` | current = order 3; insert at order 4, old next now order 5 | `nextSessionGame` returns the new entry |
| 27 | `reorder_does_not_move_cursor` | `reduce(log, cfg)` vs `reduce(log, {…cfg, sessionGames: shuffled})` | identical `current.sessionGameId`, `lap`, all counters and all `totals`; only `upNext` and `positionInLap` may differ |
| 28 | `revisit_same_lap_resets_counters` | `game_start(SG1,1)`,`loss`,`skip`,`game_start(SG2,1)`,`skip`,`game_start(SG1,1)` | at the tail: `current.sessionGameId===SG1`, `losses 0`, `attempts 0`; `totals.losses` still 1 |
| 29 | `mode_override_wins` | `session_games.mode='b2b'` over `games.default_mode='single'` | `required === 2`; one win yields `STREAK_MODE`, not a completion |
| 30 | `unknown_session_game_id_does_not_throw` | `game_start` naming an id absent from `cfg.sessionGames` | no throw; `current.title === '???'`, `mode 'single'`, `required 1` |
| 31 | `unknown_event_type_throws` | an event with `type:'nonsense'` | `reduce` throws |
| 32 | `reduce_is_pure` | `Object.freeze` the event array and every row (deep) | no throw; two consecutive calls `deepStrictEqual`; the input array's `.length` and element identity unchanged; no `sort` mutation observable |
| 33 | `reduce_ignores_input_order` | shuffle the events array before calling | identical `RunState` (the fold sorts by `seq` internally) |
| 34 | `up_next_never_contains_current` | a 1-game session with `loop:true`, then a 2-game one with `loop:true` | `upNext` is `[]` for the 1-game session and `[the other game]` (length 1) for the 2-game one — the current entry never appears, and the list never exceeds `lapSize - 1` (§2.4) |

These are all pure `run.ts` tests. Asserting the §3.4 recap SQL against `reduce()` would need a D1
binding and therefore a Workers test runner, which §9.1 deliberately does not have; §3.3 states the
two identities (`games_played`/`attempts`) as the contract instead, and §9.4's seeded-recap check
is where they are actually observed.

Tests 7, 9, 13, 19 and 11 are the five the prompt §3.5 explicitly demands. The rest exist
because every one of them encodes a decision from §2.5 that a future refactor could silently
break.

---

## 3. D1 schema

### 3.0.1 DIVERGENCE — timestamp storage

Prompt §4 says "Timestamps: ISO-UTC, millisecond precision."
**Storage is `INTEGER` epoch milliseconds. The ISO-UTC contract is honoured at every boundary.**

| | INTEGER epoch-ms (chosen) | TEXT ISO-8601 |
|---|---|---|
| recap deltas (time per game / per round / total) | `b.created_at - a.created_at` → exact ms, integer | `(julianday(b)-julianday(a))*86400000` → REAL, ~1e-8 relative error, needs rounding |
| ms precision | exact, native | needs `%f` in `strftime` and careful `subsec` handling |
| JS round-trip | `Date.now()` / `new Date(ms)` | parse + format on every read |
| sortable | yes | yes |
| human-readable in a raw `d1 execute` | no | yes |
| index size | 8 bytes | 24+ bytes |

The recap (prompt §6.4) is **entirely deltas** — that decides it. Every timestamp is rendered
`new Date(ms).toISOString()` (→ `2026-08-20T19:04:11.123Z`) in the JSON API, the CSV export, and
the admin UI, so the ISO-UTC-with-ms requirement is satisfied where it is actually observable.
The only readability cost is a raw `wrangler d1 execute` session; `datetime(created_at/1000.0,
'unixepoch','subsec')` covers that when needed.

### 3.1 `migrations/0001_init.sql`

Applied with `wrangler d1 migrations apply twitch-win-challenge-db --local|--remote`. All tables
are `STRICT` (verified working on D1's SQLite build). There is exactly one migration at v1.

```sql
-- 0001_init.sql — the complete schema. Timestamps are epoch milliseconds (see SPEC 3.0.1).

PRAGMA foreign_keys = ON;

-- Reusable game library. The same games recur across streams, so this is NOT per-session.
CREATE TABLE games (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,          -- stable id referenced by session_games
  name          TEXT    NOT NULL,                            -- display title, on camera; German or original, streamer's choice
  igdb_id       INTEGER,                                     -- IGDB game id; NULL for a manually added game
  cover_key     TEXT,                                        -- BARE R2 object name, no prefix and no '/' (e.g. '1738.jpg'); served at /covers/<key>; NULL until a cover exists
  default_mode  TEXT    NOT NULL DEFAULT 'single'            -- fallback win condition when a session does not override it
                CHECK (default_mode IN ('single','b2b')),
  created_at    INTEGER NOT NULL                             -- epoch ms; library sort order + audit
) STRICT;

-- One IGDB game may only exist once in the library, but manual entries (NULL) may repeat.
CREATE UNIQUE INDEX games_igdb_uq ON games (igdb_id) WHERE igdb_id IS NOT NULL;
-- Library list + the IGDB-search dedupe check both sort/filter by name.
CREATE INDEX games_name ON games (name);

-- One stream / one event.
CREATE TABLE sessions (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,      -- referenced by session_games and events
  title              TEXT    NOT NULL,                        -- shown in admin history and on the recap card
  loop               INTEGER NOT NULL DEFAULT 0               -- 1 = wrap to game 1 with lap+1 after the last game
                     CHECK (loop IN (0,1)),
  stop_after_current INTEGER NOT NULL DEFAULT 0               -- latched REQUEST, not an event (SPEC 2.5h)
                     CHECK (stop_after_current IN (0,1)),
  status             TEXT    NOT NULL DEFAULT 'draft'         -- draft = editable, live = the run, ended = history
                     CHECK (status IN ('draft','live','ended')),
  started_at         INTEGER,                                 -- epoch ms of the session_start event; NULL while draft
  ended_at           INTEGER,                                 -- epoch ms of the session_end event; NULL until ended
  created_at         INTEGER NOT NULL                         -- epoch ms; history ordering for drafts too
) STRICT;

-- AT MOST ONE LIVE SESSION, enforced by the database rather than by handler code.
-- A partial unique index over a constant-valued column is the standard SQLite singleton trick.
CREATE UNIQUE INDEX sessions_one_live ON sessions (status) WHERE status = 'live';
-- History screen: newest first.
CREATE INDEX sessions_created ON sessions (created_at DESC);

-- The ordered play list for one session, with a per-session mode override.
CREATE TABLE session_games (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,              -- THE identity events point at; never reused, never renumbered
  session_id  INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,   -- deleting a draft session drops its list
  game_id     INTEGER NOT NULL REFERENCES games(id)    ON DELETE RESTRICT,  -- a game in any list cannot vanish from the library
  order_index INTEGER NOT NULL,                               -- MUTABLE play order; the cursor never follows it (SPEC 2.2)
  mode        TEXT CHECK (mode IN ('single','b2b')),           -- NULL = inherit games.default_mode
  created_at  INTEGER NOT NULL                                -- epoch ms; distinguishes a mid-session insert in the audit trail
) STRICT;

-- Deliberately NOT unique on (session_id, order_index): a full reorder rewrites every row in
-- one batch, and a unique index would fail on the transient collisions mid-batch. Every read
-- sorts `ORDER BY order_index, id` so duplicates are still deterministic.
CREATE INDEX session_games_order ON session_games (session_id, order_index, id);
-- Reverse lookup for "is this library game used anywhere?" before a DELETE.
CREATE INDEX session_games_game ON session_games (game_id);

-- THE LOG. Append-only. Nothing here is ever UPDATEd except undone_at, and never DELETEd.
CREATE TABLE events (
  seq             INTEGER PRIMARY KEY AUTOINCREMENT,          -- global monotonic order; the ONLY ordering authority
  session_id      INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  session_game_id INTEGER REFERENCES session_games(id) ON DELETE RESTRICT,  -- NULL only for session_start / session_end
  lap             INTEGER NOT NULL DEFAULT 1,                  -- 1-based; stored so replay is stable (SPEC 2.5g)
  type            TEXT    NOT NULL
                  CHECK (type IN ('session_start','game_start','win','loss','skip',
                                  'game_won','game_abandoned','session_end')),
  action_id       TEXT    NOT NULL,                            -- uuid v4; one admin action = one action_id = one undo step
  created_at      INTEGER NOT NULL,                            -- epoch ms; ALL timing stats are deltas of this
  undone_at       INTEGER,                                     -- epoch ms; non-NULL => the reducer ignores this row
  meta_json       TEXT                                         -- optional JSON blob (e.g. {"src":"streamdeck"}); never read by the reducer
) STRICT;

-- The DO's hydrate/replay read and every recap CTE: one session, in seq order.
CREATE INDEX events_session_seq ON events (session_id, seq);
-- Undo: mark every row of one action.
CREATE INDEX events_action ON events (action_id);
```

Notes the implementer must not "improve":
- **No counter columns anywhere.** Prompt §4: every statistic is derived by SQL (§3.4) or by
  `reduce()` (§2.4).
- **No duration columns.** Prompt §4. Durations are `created_at` deltas.
- **No `settings` / `tokens` table.** The two unauthenticated tokens live in DO storage (§6.3).
- `session_games.mode` is nullable-with-inheritance rather than duplicated at insert time, so
  changing a game's `default_mode` in the library fixes every session that never overrode it.

### 3.2 Reads the code performs (the only queries besides §3.4)

```sql
-- R1 the DO's config load, BY ID (cached in DO kv as `cfg`, invalidated by configChanged()).
-- The id comes from kv `sid`, or from action.sessionId inside start(). Keyed by id and NEVER by
-- status, because: a `draft` session must be loadable before it is started, and an `ended` one
-- must stay loadable or the ENDED card, the recap and undo-past-`session_end` all lose their
-- session (§4.7a).
SELECT id, title, loop, stop_after_current, status, started_at, ended_at
  FROM sessions WHERE id = ?1;

SELECT sg.id, sg.session_id, sg.game_id, sg.order_index,
       COALESCE(sg.mode, g.default_mode) AS mode, g.name AS title, g.cover_key
  FROM session_games sg JOIN games g ON g.id = sg.game_id
 WHERE sg.session_id = ?1
 ORDER BY sg.order_index, sg.id;

-- R1b live-session discovery + the `already_live` guard. Used by hydrate() when kv `sid` is
-- absent (a cold boot on a fresh DO) and by start() to refuse a second live session.
SELECT id FROM sessions WHERE status = 'live' LIMIT 1;

-- R2 the DO's event load, once per control action and once per cold hydrate
SELECT seq, session_id, session_game_id, lap, type, action_id, created_at, undone_at, meta_json
  FROM events WHERE session_id = ?1 ORDER BY seq;

-- W1 append one action (one D1 batch(), one prepared statement bound N times, RETURNING seq)
INSERT INTO events (session_id, session_game_id, lap, type, action_id, created_at, meta_json)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) RETURNING seq;

-- W2 undo one action
UPDATE events SET undone_at = ?1 WHERE action_id = ?2 AND undone_at IS NULL;

-- W3 session lifecycle, always in the SAME batch as the event that caused it
UPDATE sessions SET status='live',  started_at=?1 WHERE id=?2 AND status='draft';
UPDATE sessions SET status='ended', ended_at=?1  WHERE id=?2;
UPDATE sessions SET status='live',  ended_at=NULL WHERE id=?1;   -- undo of a session_end
UPDATE sessions SET stop_after_current=?1 WHERE id=?2;

-- W4 reorder: one batch, position i from the client-supplied array
UPDATE session_games SET order_index=?1 WHERE id=?2 AND session_id=?3;

-- G1 guard before deleting a session_game (SPEC 2.5e)
SELECT 1 FROM events WHERE session_game_id = ?1 LIMIT 1;
```

D1 limits respected: `batch()` is the only atomicity primitive (never `BEGIN`); one prepared
statement per row inside the batch (never a multi-VALUES statement — the 100-bound-parameter cap);
`meta_json` is capped at 4 KB by the handler, far under the 2 MB row limit.

### 3.3 The recap outcome model

A **visit** is **one non-undone `game_start`**, bounded above by the next non-undone `game_start`
for the same `(session_game_id, lap)`. The same `(session_game_id, lap)` can therefore hold several
visits — §2.5f case 1 blesses exactly that — and the recap counts every one of them.

`reduce()`'s *per-visit* counters (`current.*`) show the **latest** visit, because the overlay only
ever renders the game in front of the streamer; `reduce()`'s `totals` count every non-undone event
in the session. The SQL below is aligned with `totals`: for any log, including a same-lap revisit,
`Q_OUTCOMES.games_played === totals.gamesPlayed` and `Q_ATTEMPTS.attempts === totals.attempts`.
Keying the visit CTE on `MAX(seq) GROUP BY (session_game_id, lap)` — the obvious-looking version —
drops the first visit's rounds from every recap query and puts two different sets of numbers on
camera in one broadcast.

Visit outcome, in priority order:

| outcome | marker present in the visit window |
|---|---|
| `won` | `game_won` |
| `skipped` | `skip` |
| `abandoned` | `game_abandoned` |
| `incomplete` | none of the above (the session ended or is still live on this game) |

Prompt §6.4 asks for "games played / won / lost / skipped". Mapping:
`played = COUNT(visits)`, `won`, `skipped`, and **`lost := abandoned + incomplete`** — a game is
never "lost" as a unit in this state machine (only rounds are), so "lost" means "started and not
finished". The recap card labels these in German as
`Gespielt / Gewonnen / Abgebrochen / Übersprungen` and shows `incomplete` merged into
`Abgebrochen`. Rounds lost are reported separately as `Niederlagen` (`totals.losses`).

### 3.4 The recap queries (`src/recap.ts`)

Every query below binds exactly one parameter, `?1 = session_id`, and every one of them starts
from the same three CTEs. Ship them as exported string constants named as in the headings, and
run them as one `env.DB.batch([...])` so the recap is a single round trip.

```sql
-- ============ the shared prelude, textually prefixed to every query below ============
WITH live AS (
  SELECT * FROM events WHERE session_id = ?1 AND undone_at IS NULL
),
visit AS (                       -- ONE ROW PER game_start: a visit is a game_start, not a
                                 -- (session_game, lap) pair. LEAD() bounds it above so a game
                                 -- visited twice in the same lap (SPEC 2.5f case 1) keeps BOTH
                                 -- visits instead of losing the first one entirely.
  SELECT seq AS start_seq, session_game_id, lap, created_at AS started_at,
         LEAD(seq) OVER (PARTITION BY session_game_id, lap ORDER BY seq) AS end_seq
    FROM live WHERE type = 'game_start'
),
round AS (                       -- every in-visit event, attributed to its visit
  SELECT v.start_seq, v.session_game_id, v.lap, v.started_at,
         e.seq, e.type, e.created_at
    FROM visit v
    JOIN live e ON e.session_game_id = v.session_game_id
               AND e.lap             = v.lap
               AND e.seq             > v.start_seq
               AND (v.end_seq IS NULL OR e.seq < v.end_seq)
   WHERE e.type IN ('win','loss','skip','game_won','game_abandoned')
)
```

```sql
-- ============ Q_OUTCOMES : games played / won / lost / skipped ============
, outcome AS (
  SELECT v.start_seq, v.session_game_id, v.lap,
         CASE
           WHEN EXISTS (SELECT 1 FROM round r WHERE r.start_seq=v.start_seq AND r.type='game_won')      THEN 'won'
           WHEN EXISTS (SELECT 1 FROM round r WHERE r.start_seq=v.start_seq AND r.type='skip')          THEN 'skipped'
           WHEN EXISTS (SELECT 1 FROM round r WHERE r.start_seq=v.start_seq AND r.type='game_abandoned')THEN 'abandoned'
           ELSE 'incomplete'
         END AS outcome
    FROM visit v
)
SELECT COUNT(*)                              AS games_played,
       SUM(outcome = 'won')                  AS games_won,
       SUM(outcome = 'skipped')              AS games_skipped,
       SUM(outcome = 'abandoned')            AS games_abandoned,
       SUM(outcome = 'incomplete')           AS games_incomplete,
       SUM(outcome IN ('abandoned','incomplete')) AS games_lost   -- SPEC 3.3 mapping
  FROM outcome;
```

```sql
-- ============ Q_ATTEMPTS : total attempts, wins, losses ============
SELECT SUM(type = 'win')  AS wins,
       SUM(type = 'loss') AS losses,
       SUM(type IN ('win','loss')) AS attempts     -- SPEC 2.5i, over the whole session
  FROM round;
```

```sql
-- ============ Q_WORST_GAME : worst game by losses ============
SELECT g.name                        AS title,
       g.cover_key                   AS cover_key,
       sg.id                         AS session_game_id,
       COUNT(*)                      AS losses,
       COUNT(DISTINCT r.lap)         AS laps_involved
  FROM round r
  JOIN session_games sg ON sg.id = r.session_game_id
  JOIN games         g  ON g.id  = sg.game_id
 WHERE r.type = 'loss'
 GROUP BY sg.id
 ORDER BY losses DESC, g.name ASC              -- name tiebreak = stable output
 LIMIT 1;
```

```sql
-- ============ Q_FASTEST_WIN : fastest completed game (game_start -> game_won) ============
SELECT g.name                          AS title,
       g.cover_key                     AS cover_key,
       r.lap                           AS lap,
       r.created_at - r.started_at     AS ms,     -- exact integer ms; SPEC 3.0.1
       (SELECT COUNT(*) FROM round r2
         WHERE r2.start_seq = r.start_seq AND r2.type IN ('win','loss')) AS attempts
  FROM round r
  JOIN session_games sg ON sg.id = r.session_game_id
  JOIN games         g  ON g.id  = sg.game_id
 WHERE r.type = 'game_won'
 ORDER BY ms ASC, r.seq ASC
 LIMIT 1;
```

```sql
-- ============ Q_SESSION_TIME : total session time ============
-- Works for a still-live session too: falls back to the newest event instead of ended_at.
SELECT s.title,
       s.loop,
       s.status,
       COALESCE(s.started_at, (SELECT MIN(created_at) FROM live))  AS started_at,
       COALESCE(s.ended_at,   (SELECT MAX(created_at) FROM live))  AS ended_at,
       COALESCE(s.ended_at,   (SELECT MAX(created_at) FROM live))
       - COALESCE(s.started_at, (SELECT MIN(created_at) FROM live)) AS total_ms
  FROM sessions s WHERE s.id = ?1;
```

```sql
-- ============ Q_PER_LAP : per-lap breakdown ============
-- LEFT JOIN, driven from `visit`: a visit with no rounds yet (the game currently on screen) is
-- still one played game here, exactly as Q_OUTCOMES counts it. Driving this off `round` made
-- the recap card show three different numbers for "Gespielt" in one graphic.
SELECT v.lap                                     AS lap,
       COALESCE(SUM(r.type = 'win'), 0)          AS wins,
       COALESCE(SUM(r.type = 'loss'), 0)         AS losses,
       COALESCE(SUM(r.type IN ('win','loss')), 0) AS attempts,
       COALESCE(SUM(r.type = 'game_won'), 0)     AS games_won,
       COALESCE(SUM(r.type = 'skip'), 0)         AS games_skipped,
       COALESCE(SUM(r.type = 'game_abandoned'), 0) AS games_abandoned,
       COUNT(DISTINCT v.start_seq)               AS games_played,
       MIN(v.started_at)                         AS lap_started_at,
       MAX(COALESCE(r.created_at, v.started_at)) AS lap_ended_at,
       MAX(COALESCE(r.created_at, v.started_at)) - MIN(v.started_at) AS lap_ms
  FROM visit v LEFT JOIN round r ON r.start_seq = v.start_seq
 GROUP BY v.lap
 ORDER BY v.lap;
```

```sql
-- ============ Q_PER_GAME : time per game + per-game detail (the recap table + charts) ============
SELECT v.session_game_id,
       v.lap,
       g.name                                  AS title,
       g.cover_key                             AS cover_key,
       COALESCE(sg.mode, g.default_mode)       AS mode,
       COALESCE(SUM(r.type = 'win'), 0)        AS wins,
       COALESCE(SUM(r.type = 'loss'), 0)       AS losses,
       COALESCE(SUM(r.type IN ('win','loss')), 0) AS attempts,
       MAX(COALESCE(r.created_at, v.started_at)) - v.started_at AS game_ms,
       v.started_at                            AS started_at,
       MAX(CASE r.type WHEN 'game_won' THEN 'won'
                       WHEN 'skip' THEN 'skipped'
                       WHEN 'game_abandoned' THEN 'abandoned' END) AS outcome
  FROM visit v
  LEFT JOIN round r      ON r.start_seq = v.start_seq
  JOIN session_games sg  ON sg.id = v.session_game_id
  JOIN games         g   ON g.id  = sg.game_id
 GROUP BY v.start_seq
 ORDER BY v.lap, v.started_at;
-- outcome is NULL for an incomplete visit; the serialiser maps NULL -> 'incomplete'.
-- MAX() over the three literals is safe because 'won' > 'skipped' > 'abandoned' can never
-- co-occur inside one visit (each is terminal and is followed by a game_start or session_end).
```

```sql
-- ============ Q_PER_ROUND : time per round (feeds the round-duration chart) ============
SELECT r.session_game_id, r.lap, r.seq, r.type,
       r.created_at - COALESCE(
         LAG(r.created_at) OVER (PARTITION BY r.start_seq ORDER BY r.seq),
         r.started_at
       ) AS round_ms
  FROM round r
 WHERE r.type IN ('win','loss')
 ORDER BY r.seq;
```

```sql
-- ============ Q_EVENTS : the raw log, for the JSON/CSV export (undone rows INCLUDED) ============
SELECT e.seq, e.action_id, e.type, e.lap, e.session_game_id,
       e.created_at, e.undone_at, e.meta_json,
       g.name AS game_title, COALESCE(sg.mode, g.default_mode) AS mode
  FROM events e
  LEFT JOIN session_games sg ON sg.id = e.session_game_id
  LEFT JOIN games         g  ON g.id  = sg.game_id
 WHERE e.session_id = ?1
 ORDER BY e.seq;
```

**Export shapes** (`src/recap.ts`):

- `GET .../export.json` → `{ session, games: SessionGameRow[], recap: <all Q_* results>, events: <Q_EVENTS with created_at/undone_at as ISO strings> }`
- `GET .../export.csv` → RFC-4180, `\r\n` line endings, UTF-8 with a BOM (Excel), header row:
  `seq,action_id,type,lap,session_game_id,game_title,mode,created_at_iso,undone_at_iso,meta_json`
  Fields containing `,` `"` or a newline are quoted with `""` doubling. One `Q_EVENTS` row per line.

---

## 4. WebSocket protocol

### 4.1 Endpoints and roles

| Endpoint | Auth | `role` in the DO | Purpose |
|---|---|---|---|
| `GET /o/:overlayToken/ws` | overlay token, validated **inside** `LiveRun.fetch()` | `overlay` | OBS browser source and the admin preview iframe |
| `GET /api/admin/ws` | Cloudflare Access JWT, validated in the Worker before forwarding | `admin` | the admin panel's live counters |

`role` is carried to the DO as the query parameter `?role=overlay|admin` on the forwarded
request. The Worker sets it; a client-supplied `role` on `/o/:t/ws` is overwritten.

There is **no `preview` role**. The admin preview iframe is a normal overlay socket — it loads
the same URL with the same token. Prompt §6.6: "do not build a second renderer."

**DECISION: no tags on `acceptWebSocket`.** Every broadcast goes to every socket (both roles
render the same `RunState`), so `getWebSockets()` with no filter is the whole broadcast. Tags
would be an unused index.

### 4.2 Server → client messages

```ts
export type Cause =
  | 'snapshot'        // a full state push: on connect, after a resume, after configChanged
  | 'session_start' | 'game_start' | 'win' | 'loss' | 'skip'
  | 'game_won' | 'game_abandoned' | 'session_end'   // one per appended event
  | 'undo'            // the log was rewound; the state jumped
  | 'config';         // session/session_games/stop_after_current changed; no event was written

export type Step = {
  seq: number;        // monotonic per DO, +1 per BROADCAST step; a unicast snapshot reuses the
                      // current value (§4.5). NOT the D1 event seq.
  cause: Cause;
  at: number;         // epoch ms: the event's created_at, or Date.now() for snapshot/config
  state: RunState;    // the COMPLETE state as of immediately after this step
};

export type ServerMsg =
  | { t: 'state'; steps: Step[] }                      // the only state carrier
  | { t: 'pong' }                                      // sent by the runtime auto-responder, never by our code
  | { t: 'error'; code: 'read_only' | 'bad_message' };  // sent immediately before a 1008 close
```

`{ t: 'state', steps }` is the **only** message that carries state. One WS frame per action:

| Action | `steps` |
|---|---|
| connect / resume | `[{cause:'snapshot', state}]` — **unicast** to that one socket, and it reuses the current `seq` (§4.5) |
| config change | `[{cause:'config', state}]` — broadcast, increments `seq` |
| `loss` | `[{cause:'loss', state}]` |
| non-completing `win` (b2b, streak 0→1) | `[{cause:'win', state}]` |
| completing `win`, advances | `[{cause:'win'}, {cause:'game_won'}, {cause:'game_start'}]` |
| completing `win`, ends the session | `[{cause:'win'}, {cause:'game_won'}, {cause:'session_end'}]` |
| `skip` | `[{cause:'skip'}, {cause:'game_start'|'session_end'}]` |
| `stop_now` | `[{cause:'game_abandoned'}, {cause:'session_end'}]` |
| `undo` | `[{cause:'undo', state}]` — one step, whatever the log rewound past |
| `start` | `[{cause:'session_start'}, {cause:'game_start'}]` |

**Each step carries its own post-event `RunState`.** That is why the DO calls `reduce()` once per
prefix of the appended events rather than once at the end: the overlay needs the *intermediate*
numbers. Without them, a completing win would animate the loss counter toward the next game's
zero. This is a total of ≤3 `reduce()` calls per action over a few hundred events — free.

Batching into one frame is deliberate (Cloudflare's own guidance: each `send()` is a JS↔system
context switch). Three steps per action is the maximum.

### 4.3 What the overlay needs, and why `cause` exists

The animation queue (§7.4) needs to know **which transition** happened, not just the new numbers:
`losses 3 → 4` and an undo from `losses 4 → 3` are both "a number changed", but one is a weighty
increment and the other is a rewind. A pure-state protocol cannot distinguish them without the
overlay reimplementing the state machine. `cause` is the whole delta payload:

| `cause` | overlay behaviour |
|---|---|
| `snapshot` | render `state` instantly, **no animation**, flush the queue |
| `config` | re-render chrome (title, up-next, lap size) instantly; no animation |
| `session_start` | fade the card in |
| `game_start` | next-game intro: cover slides in, counters snap to 0 |
| `win` | win-lands beat; if the resulting `displayMode` is `STREAK_MODE`, cross-fade into it |
| `loss` | weighty loss-counter increment; if it came from `STREAK_MODE`, play the deflating streak-break first |
| `skip` | short neutral wipe |
| `game_won` | the celebration (the longest beat, 1800 ms) |
| `game_abandoned` | short desaturating wipe |
| `session_end` | settle into the ENDED card |
| `undo` | reverse-direction counter tween, 250 ms, no SFX, no celebration |

The overlay diffs `step.state` against **its own currently rendered state** to know the from- and
to-values of every tween. It keeps that; the server does not resend it.

### 4.4 Client → server messages

```ts
export type ClientMsg =
  | { t: 'ping' }                  // heartbeat; MUST serialise byte-exactly as {"t":"ping"}
  | { t: 'resume'; seq: number };  // "my last seq was N, send me a snapshot if I missed anything"
```

That is the complete client vocabulary. **There are no control messages over the WebSocket.**
Every mutation is HTTP (§5), so auth and rate limiting have exactly one code path.

- **On connect the client sends nothing.** The server pushes
  `{t:'state', steps:[{cause:'snapshot', ...}]}` unprompted, inside `fetch()`, before returning
  the 101. Rationale: it removes a round trip and one class of "connected but blank overlay" bug.
- The client sends `{t:'resume', seq}` **only** when it detects a gap (`step.seq !== lastSeq + 1`).
  The server replies with a single `snapshot` step. It does **not** replay individual steps —
  a snapshot is strictly more correct and the state is 700 bytes.
- **Heartbeat:** `ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"ping"}',
  '{"t":"pong"}'))` is registered in the DO constructor. The client sends the literal string
  `'{"t":"ping"}'` every **20 000 ms** — as a hardcoded string constant, never
  `JSON.stringify({t:'ping'})`, because the auto-responder matches byte-exactly and one space
  would wake the DO on every beat for the whole stream.
- **Read-only enforcement:** any inbound message that is not exactly `{t:'resume'}` (ping never
  reaches `webSocketMessage`) causes the server to send `{t:'error',code:'read_only'}` and then
  `ws.close(1008, 'read-only')`. Unparseable JSON or a non-string frame →
  `{t:'error',code:'bad_message'}` + `close(1008)`. One rule, no offence counter, no allowlist to
  keep in sync. Applies to `admin` sockets too — the admin panel uses `fetch()`, so a control
  frame arriving on any socket means either a bug or an attacker.

### 4.5 `seq`, gaps, and resume

- `seq` is a DO-owned monotonic integer in `ctx.storage.kv` under key `seq`. It increments by 1
  for **every step that is broadcast to all sockets**. A **unicast snapshot** — the one pushed
  inside `fetch()` on connect, and the one answering `resume` — carries the **current** value and
  does **not** increment it. Only broadcast steps advance `seq`, which is what makes two clients
  agree on ordering: if a snapshot consumed a number, every *other* socket would see the next real
  step as a gap, call `requestResync()`, and the resulting snapshot would flush a running
  animation (§7.4) — so one client reconnecting would kill the celebration on the broadcast
  overlay, on every win, for the rest of the stream. Snapshots are idempotent, so a repeated `seq`
  on one is harmless: §7.4 handles `cause==='snapshot'` before the dedupe check.
- The client stores `lastSeq` (init `0`). On each received step: if `step.seq <= lastSeq`, discard;
  if `step.seq > lastSeq + 1`, it missed something → keep the newest step, send
  `{t:'resume', seq:lastSeq}`, and treat the incoming snapshot as authoritative; else accept.
- `seq` survives hibernation (it is in storage) but **not** a DO reset from a redeploy of the
  class... it does, because `ctx.storage.kv` is durable. It resets only if the DO is deleted.
  A client that reconnects and sees `step.seq < lastSeq` treats the snapshot as authoritative and
  sets `lastSeq = step.seq`.

### 4.6 Reconnect — exact parameters (`public/overlay.js`, same code in `admin.js`)

```
BASE_MS      = 500
FACTOR       = 2
MAX_MS       = 15000
attempt      = 0          // reset to 0 on a successful 'open'
delay        = min(MAX_MS, BASE_MS * FACTOR ** attempt)      // 500,1000,2000,4000,8000,15000,15000...
wait         = delay/2 + Math.random() * delay/2              // full-jitter: 50%..100% of delay
HEARTBEAT_MS = 20000
```
- `onclose` and `onerror` both: `clearInterval(heartbeat)`, `attempt++`, `setTimeout(connect, wait)`.
- No cap on attempts. An overlay that gives up is a blank box on camera.
- `onopen`: `attempt = 0`, start the heartbeat interval, send nothing (the server pushes the
  snapshot). Send `{t:'resume', seq:lastSeq}` **only** if `lastSeq > 0` and no snapshot has
  arrived within 2000 ms — a belt-and-braces path for a server that changed behaviour.
- A redeploy closes every socket (documented Cloudflare behaviour). That is a normal `onclose`
  and the backoff handles it; the first retry lands 250–500 ms later.

### 4.7 Hibernation contract

| Where | What |
|---|---|
| `ws.serializeAttachment()` | `{ role: 'overlay' \| 'admin', at: <epoch ms of accept> }` — ~40 bytes, far under the 16 KB cap. Written **once**, at accept time, and never mutated (a mutation without a re-`serializeAttachment()` call is silently lost). |
| `ctx.storage.kv` (durable) | `state` (last `RunState`), `seq`, `sid` (`number` — the session this DO is bound to; written when `session_start` is appended, **never** cleared by `session_end`, overwritten by the next `start()`), `cfg` (`{session, sessionGames}` cache **for `sid`**), `tok` (`{overlay, control, rotatedAt}`), `rl` (`{tokens, at}` rate-limit bucket), `igdb` (`{token, exp}` Twitch app-token cache, §4.8), `lastact` (`{action, actionId, at}` replay guard, §4.10) |
| recomputed on every wake | nothing that matters — the constructor only runs `setWebSocketAutoResponse` and a **guarded** hydrate |
| **never** used | instance fields for state, module-scope caches, `setInterval`, `setTimeout` |

The DO constructor, verbatim shape:

```ts
constructor(ctx: DurableObjectState, env: Env) {
  super(ctx, env);
  // Byte-exact match or the runtime will not answer and every heartbeat wakes us.
  ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}'));

  // Guarded: without the guard this D1 round trip runs on EVERY wake from hibernation and
  // adds latency to every overlay reconnect. A throw in here resets the whole DO and cannot
  // be caught by application code, hence the try/catch.
  if (ctx.storage.kv.get('state') === undefined) {
    ctx.blockConcurrencyWhile(async () => {
      try { await this.hydrate(); }
      catch (e) { console.error('hydrate failed', e); }
    });
  }
}
```

#### 4.7a `hydrate()` — the whole crash story, specified

`hydrate()` is the only thing standing between a D1 blip during a redeploy and a permanently blank
overlay, so it is specified exactly. It runs inside `serialise()` (or the constructor guard) and
performs, in order:

1. **Resolve the session:** `sid = kv.get('sid')`. If absent, run R1b (`status='live'`) and adopt
   that id, writing it to `sid`. There is no third fallback.
2. **No session at all** → `kv.put('state', IDLE)` and return, where `IDLE` is the constant
   `{phase:'idle', sessionId:null, sessionTitle:null, loop:false, stopAfterCurrent:false, lap:0,
   current:null, displayMode:'IDLE', upNext:[], totals:{all zero}, lastSeq:0}`.
3. R1 (`WHERE id = ?1`) + the `session_games` query → `kv.put('cfg', {session, sessionGames})`.
4. R2 (events for that session) → `reduce()` → `kv.put('state', …)`.
5. `kv.put('seq', 0)` **only if** `seq` is absent.

Two invariants, both mandatory:
- **`hydrate()` never leaves `state` undefined.** On *any* D1 failure it writes the same constant
  `IDLE` `RunState` and rethrows for the log. `fetch()` and `snapshot()` can therefore never push
  `state: undefined` at a connecting overlay — which would throw inside the client's `onStep` and
  leave a blank box on camera with no button anywhere that reaches this DO.
- **`snapshot()` retries.** If `kv.get('state')` is absent *or* its `phase` is `'idle'` while `sid`
  names a non-`draft` session, `snapshot()` re-runs `hydrate()` once before answering. That is the
  self-healing path after a D1 blip: the next overlay reconnect fixes it with no human involved.

Hard rules for `live-run.ts`:
- **No `setInterval` / `setTimeout` anywhere.** One timer makes the DO permanently
  non-hibernatable: billed 24/7 and the timer is still lost at the 70–140 s eviction. The
  overlay's clocks are client-side, driven from `state.current.startedAt`.
- **No `ctx.waitUntil`** — it is a documented no-op in a DO. Every write is awaited.
- **No `blockConcurrencyWhile` outside the constructor guard above.**
- Broadcast is a loop with a per-socket `try/catch`, so one dead OBS tab cannot starve the admin
  panel:
  ```ts
  private broadcast(steps: Step[]) {
    const body = JSON.stringify({ t: 'state', steps });
    for (const ws of this.ctx.getWebSockets()) {
      try { if (ws.readyState === WebSocket.OPEN) ws.send(body); }
      catch (e) { console.error('ws send failed', e); }
    }
  }
  ```
- `webSocketClose` / `webSocketError`: log only. There is no in-memory client registry to clean up,
  and `compatibility_date >= 2026-04-07` completes the close handshake for us — do not call
  `ws.close()` in the handler.

### 4.8 `LiveRun` RPC surface (the complete public method list)

`fetch()` exists **only** for the WebSocket upgrade — a `WebSocket` cannot be returned from an
RPC method, so the 101 must go through `stub.fetch(request)`. Everything else is RPC on
`DurableObjectStub<LiveRun>`, typed, with no URL parsing and no hand-rolled request envelopes.

```ts
// --- fetch(): WS upgrade only. 426 if there is no `Upgrade: websocket` header. ---
fetch(request: Request): Promise<Response>

// --- control (each one runs inside serialise(), see 4.9) ---
start(sessionId: number):        Promise<RunState | { error: string }>
control(a: 'win'|'loss'|'skip'|'undo'|'stop_now'): Promise<RunState | { error: string }>
setStopAfterCurrent(on: boolean): Promise<RunState | { error: string }>   // ALSO patches kv `cfg`

// --- IGDB app-token cache (BUILD_PROMPT §8: "cache the token in DO storage until expiry") ---
// Returns kv `igdb`.token while `exp - Date.now() > 60_000`, else fetches a fresh
// client_credentials token from Twitch, stores `{token, exp}` and returns it. Runs inside
// serialise() so two debounced searches cannot both refetch. `igdb.ts` stays I/O-only and takes
// the token as a parameter — this is the only place the cache lives.
igdbToken():                      Promise<string>

// --- reads / admin ---
snapshot():                       Promise<RunState>          // from kv, hydrating if cold
tokens():                         Promise<{ overlay: string; control: string; rotatedAt: number }>
authToken(token: string, charge?: boolean): Promise<'overlay' | 'control' | null>  // charge defaults to true
rotateTokens(which: 'overlay'|'control'|'both'): Promise<{ overlay: string; control: string; rotatedAt: number }>

// --- cache invalidation, called by the Worker after ANY sessions / session_games mutation ---
configChanged():                  Promise<RunState>          // drops kv `cfg`, reloads, broadcasts cause:'config'
rehydrate():                      Promise<RunState>          // drops kv `cfg` AND `state`, replays D1, broadcasts cause:'snapshot'
```

There are no other public methods. `plan`/`reduce` are imported from `run.ts`, not re-exported.

**cfg-mutating methods** are `configChanged()` and `rehydrate()` (which drop the entry outright),
plus every method whose D1 batch writes the `sessions` row — `start()`, `setStopAfterCurrent()`,
and any `control()` turn appending `session_start` / `session_end` or undoing one. Those **patch**
the cached `cfg.session` in place (§4.9 step 4b) rather than dropping it, so no extra D1 read is
needed for a value the DO just wrote. `start()` is the one exception that **deletes** kv `cfg` and
rewrites kv `sid` *before* step 1, so it can never plan against the previous session's game list
or loop flag.

### 4.9 Concurrency: the one race that can corrupt a run

Two control requests (a `win` and an `undo`) can arrive at the same DO milliseconds apart. Every
control action must therefore run inside a **serialising promise chain** held on the instance:

```ts
private chain: Promise<unknown> = Promise.resolve();
private serialise<T>(fn: () => Promise<T>): Promise<T> {
  const run = this.chain.then(fn, fn);
  this.chain = run.catch(() => {});          // a failure must not poison the chain
  return run;
}
```
An instance field is correct here and only here: the chain only has to live for the duration of
overlapping in-flight requests, and a DO cannot hibernate while a request is in flight.

Order inside `serialise`, and it is not negotiable (`start`, `control`, `setStopAfterCurrent`,
`rotateTokens`, `configChanged` and `rehydrate` all go through it):

```
0. replay guard  (kv `lastact`, §4.10)   <-- a duplicate returns the current state, no I/O at all
1. read cfg      (kv, or D1 on a miss)   <-- ALL foreign I/O first
                 (start(): delete kv `cfg` first, then load cfg for `action.sessionId` via
                  R1 + R1b — never for the previous session; kv `sid` is written in 4b, after
                  the batch commits, so a failed start cannot rebind the DO)
2. read events   (D1)                    <-- ALL foreign I/O first
3. plan()        (pure, no await)
4. D1 batch: the appended events (or the undo UPDATE) + the sessions row update   <-- awaited
4b. patch cfg: whatever the batch just changed in the `sessions` row
                 (`status`, `started_at`, `ended_at`, `stop_after_current`) is written into the
                 cached `cfg.session` and `kv.put('cfg', cfg)` — sync, no D1 re-read
5. reduce() per prefix -> steps          (pure, no await)
6. kv.put('state'), kv.put('seq'), kv.put('lastact')   (sync, no await between them -> one commit)
7. broadcast(steps)
8. return the final RunState
```

**D1 is the log of record: if step 4 throws, nothing is committed, the DO's cached state is
untouched, and the request returns 503.** The streamer taps again. There is no divergence to
reconcile and no retry queue — the correct failure mode for a system whose whole crash story is
"replay D1".

`ponytail:` comment for `live-run.ts`:
```ts
// ponytail: one promise chain serialises every control action. Awaiting D1 opens the DO's
// input gate, so a win and an undo landing together would otherwise interleave and clobber
// each other. Ceiling: ~1000 actions/sec for this single object, which is ~1000x more than a
// human with a Stream Deck. If this ever needs more, the run stops being one object.
```

### 4.10 Replay protection — the one guard that keeps a lost response from double-counting

There is no idempotency anywhere in the write path, and §4.9's own failure story ("the request
returns 503, the streamer taps again") is a double-count by design: a batch that committed and then
lost its response on a 4G hop looks identical to one that never ran. Two routine paths break a run
on camera — an admin retry on a phone (the documented deployment) turning one WIN into two, and a
Stream Deck double-press turning `Niederlagen 6` into `8`. Undo is worse: a duplicated undo
*request* rewinds a **second, different** action, and there is no redo (§2.5d).

**One kv key closes both.** `lastact: { action: string, actionId: string | null, at: number }`,
written in §4.9 step 6 of every successful control turn. Step 0 of `serialise()` applies two rules
before any I/O:

| arriving request | rule | result |
|---|---|---|
| admin `POST /api/admin/control/*` with `{action_id}` | `action_id === lastact.actionId` | no-op: return the current `RunState`, no plan, no append, no broadcast, no `seq` bump |
| `GET /c/:t/*` (no body to carry an id) | same `action` **and** `Date.now() - lastact.at < 600` | no-op: `text/plain` `"dup"`, status 200 |

- `admin.js` generates one uuid **per button press** and reuses it **verbatim** on every retry of
  that press. It goes straight into `plan(action, events, cfg, now, actionId)` — which already
  takes `actionId` — so the appended rows carry it and `run.ts` does not change.
- The kv key, not a `SELECT 1 FROM events WHERE action_id = ?`, because it costs no query **and**
  it covers `undo`, which appends no row at all and is therefore invisible to that query.
- 600 ms is under the fastest realistic gap between two *intended* control presses (rounds last
  seconds) and over every retry/re-issue window. It is a coalescing window, not a lock: the second
  press of a deliberate double-tap is lost, and that is the trade — document it next to the §6.5
  `ponytail:` comment as part of the GET-with-side-effects tradeoff.
- Ceiling: only the immediately-previous action is remembered, which is exactly what a retry is.
  Verify with one DO-level check: replay the same `action_id` twice and assert
  `SELECT COUNT(*) FROM events` is unchanged.

---

## 5. HTTP routes

### 5.1 Routing mechanics

`wrangler.jsonc` sets
`assets.run_worker_first: ["/api/*", "/o/*", "/c/*", "/admin/*", "/covers/*"]`.
Those five prefixes always invoke the Worker. **Every other path is served straight from the
asset store with zero Worker invocation** — that is how `/overlay.css`, `/overlay.js`,
`/strings.js`, `/fonts/*.woff2` and `/sfx/*.ogg` reach OBS with no compute cost.

Consequences the implementer must honour:
- **Every asset reference in `public/*.html` is absolute** (`/overlay.css`, not `overlay.css`),
  because the page is served at `/o/<token>` where a relative path would resolve to `/o/`.
- `public/overlay.html`, `public/recap.html` and `public/admin/index.html` are also reachable
  directly at `/overlay.html`, `/recap.html` and `/admin/index.html`. **This is accepted, not a
  leak:** the shells contain no state, no token and no secret; the token gate is on the WS, on
  `recap.json`, and on `/api/admin/*`. Do not add cloaking.
- Router shape in `src/index.ts`: a flat `switch`/`if` chain over `url.pathname`, matched with
  `URLPattern` or plain `split('/')`. **No router library.** ~40 branches, one file.
- Unmatched path → `env.ASSETS.fetch(request)` as the final fallthrough (gives assets a second
  chance and a proper 404).
- `withSecurityHeaders()` wraps every Worker-generated response:
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, and
  `X-Frame-Options: DENY` **except** on `/o/*` (the admin preview embeds the overlay in an
  iframe, so overlay responses get `X-Frame-Options: SAMEORIGIN` instead).

### 5.2 The complete route table

Auth column: `access` = verified `Cf-Access-Jwt-Assertion` (§6.1) · `overlay` = valid overlay
token in the path · `control` = valid control token in the path · `none` = public.
All `/api/*` responses are `application/json` with `Cache-Control: no-store`.

| # | Method | Path | Auth | Request body | Response (200) | Other statuses |
|---|---|---|---|---|---|---|
| 1 | GET | `/` | none | — | `302` → `/admin/` | — |
| 2 | GET | `/admin` , `/admin/*` | access | — | `public/admin/index.html` via `ASSETS` | 401 |
| 3 | GET | `/api/admin/state` | access | — | `{state: RunState, session: SessionRow\|null, sessionGames: SessionGameRow[], tokens:{overlay,control,rotatedAt}}` | 401 |
| 4 | GET | `/api/admin/ws` | access | — | `101` (WS upgrade, `role=admin`) | 401, 426 (no `Upgrade` header) |
| 5 | GET | `/api/admin/games` | access | — | `Game[]` ordered by `name` | 401 |
| 6 | POST | `/api/admin/games` | access | `{name:string (1..80 chars), default_mode:'single'\|'b2b', igdb_id?:number, igdb_cover_image_id?:string}` | the created `Game` (cover already ingested into R2 if `igdb_cover_image_id` was given) | 400 (bad body, or `name` > 80 chars — §7.1 clamps the render, this bounds the input), 401, 409 (`igdb_id` already in the library), 502 (cover fetch failed — the game IS created, `cover_key` null) |
| 7 | PATCH | `/api/admin/games/:id` | access | `{name?: string (1..80 chars), default_mode?}` | the updated `Game` | 400 (incl. `name` > 80 chars), 401, 404 |
| 8 | DELETE | `/api/admin/games/:id` | access | — | `{ok:true}`; also deletes the R2 cover | 401, 404, 409 (used by any `session_games` row) |
| 9 | POST | `/api/admin/games/:id/cover` | access | raw image bytes; `Content-Type` must be `image/jpeg\|image/png\|image/webp`; ≤ 2 MB | `{cover_key:string}` | 400 (type/size), 401, 404, 413 |
| 10 | GET | `/api/admin/igdb?q=<1..80 chars>` | access | — | `{games:[{igdb_id,name,cover_image_id\|null,releaseYear\|null,platforms:string[]}]}`; `[]` on no match. **The handler calls `stub.igdbToken()` first and passes the token into `igdb.ts`** — never one Twitch OAuth call per keystroke-debounced search (§4.8) | 400 (missing `q`), 401, 503 (IGDB rate-limited), 502 (IGDB unreachable / credentials unset) |
| 11 | GET | `/api/admin/sessions` | access | — | `SessionRow[]` newest first, each with `{gameCount:number}` | 401 |
| 12 | POST | `/api/admin/sessions` | access | `{title:string, loop:boolean}` | the created `SessionRow` (`status:'draft'`) | 400, 401 |
| 13 | GET | `/api/admin/sessions/:id` | access | — | `{session, sessionGames}` | 401, 404 |
| 14 | PATCH | `/api/admin/sessions/:id` | access | `{title?, loop?}` | the updated `SessionRow`; if it is the live session, triggers `configChanged()` | 400, 401, 404 |
| 15 | DELETE | `/api/admin/sessions/:id` | access | — | `{ok:true}` | 401, 404, 409 (`status != 'draft'` — history is never deleted) |
| 16 | POST | `/api/admin/sessions/:id/games` | access | `{game_id:number, mode?:'single'\|'b2b'}` | the created `SessionGameRow` (appended at `MAX(order_index)+1`); `configChanged()` if live | 400, 401, 404 |
| 17 | PUT | `/api/admin/sessions/:id/games` | access | `{order:number[]}` — the complete list of that session's `session_games.id` in the desired order | `SessionGameRow[]` in the new order; `configChanged()` if live | 400 (ids missing/extra/foreign, **or `phase==='live'` && `order.length > 1` && `order` puts `state.current.sessionGameId` last** — §2.5f case 3), 401, 404 |
| 18 | PATCH | `/api/admin/sessions/:id/games/:sgid` | access | `{mode:'single'\|'b2b'\|null}` (`null` = inherit) | the updated `SessionGameRow`; `configChanged()` if live | 400, 401, 404 |
| 19 | DELETE | `/api/admin/sessions/:id/games/:sgid` | access | — | `{ok:true}`; `configChanged()` if live | 401, 404, **409 (any event references it — §2.5e)** |
| 20 | POST | `/api/admin/sessions/:id/start` | access | — | `{state: RunState}` | 401, 404, 409 (`empty_session` / `already_live` / `not_draft`) |
| 21 | POST | `/api/admin/control/win` | access | `{action_id:string}` (uuid v4, one per button press, reused verbatim on retry — §4.10) | `{state: RunState}` | 400 (missing/malformed `action_id`), 401, 409 (see §5.4), 503 (D1 write failed) |
| 22 | POST | `/api/admin/control/loss` | access | `{action_id}` | `{state}` | 400, 401, 409, 503 |
| 23 | POST | `/api/admin/control/skip` | access | `{action_id}` | `{state}` | 400, 401, 409, 503 |
| 24 | POST | `/api/admin/control/undo` | access | `{action_id}` | `{state}` | 400, 401, **409 `nothing_to_undo`**, 503 |
| 25 | POST | `/api/admin/control/stop-now` | access | `{action_id}` | `{state}` (`phase:'ended'`) | 400, 401, 409, 503 |
| 26 | POST | `/api/admin/control/stop-after-current` | access | `{on:boolean, action_id}` — idempotent SET, never a toggle; also patches the DO's cached `cfg` (§2.5h) | `{state}` | 400, 401, 409 (`no_live_session`), 503 |
| 27 | POST | `/api/admin/control/rehydrate` | access | — | `{state}`; drops the DO's `state`+`cfg` cache, reloads from D1, broadcasts a `snapshot`. **This is the prompt-§7-item-7 "Resume" button.** | 401, 503 |
| 28 | GET | `/api/admin/sessions/:id/recap` | access | — | the full recap object (§3.4, all `Q_*`) | 401, 404 |
| 29 | GET | `/api/admin/sessions/:id/export.json` | access | — | `application/json`, `Content-Disposition: attachment` | 401, 404 |
| 30 | GET | `/api/admin/sessions/:id/export.csv` | access | — | `text/csv; charset=utf-8`, BOM, `Content-Disposition: attachment` | 401, 404 |
| 31 | GET | `/api/admin/tokens` | access | — | `{overlay:string, control:string, rotatedAt:number, urls:{overlay,recap,control}}` (copy-ready absolute URLs) | 401 |
| 32 | POST | `/api/admin/tokens/rotate` | access | `{which:'overlay'\|'control'\|'both'}` | the new `{overlay,control,rotatedAt,urls}`; every open `overlay`-role socket is closed with `1008` in the same call | 400, 401 |
| 33 | GET | `/o/:token` | overlay | — | `public/overlay.html` via `ASSETS`, `Cache-Control: no-store`, `X-Frame-Options: SAMEORIGIN`. **Validates the token with `authToken(t, false)` — the HTML shell does NOT charge the rate bucket** (§6.4) | 404 (bad token — never 401, do not confirm the path shape) |
| 34 | GET | `/o/:token/recap` | overlay | — | `public/recap.html` via `ASSETS`; `authToken(t, false)`, uncharged | 404 |
| 35 | GET | `/o/:token/recap.json?session=latest\|<id>` | overlay | — | the same recap object as #28. **`latest` = the `status='live'` session if one exists, else the newest `status='ended'`** — a live session is always the one on camera, so the recap scene must never render last week's numbers because tonight's session has not been stopped yet | 404 (bad token or no session), 429 |
| 36 | GET | `/o/:token/ws` | overlay (checked inside `LiveRun.fetch`) | — | `101`, `role=overlay` | 404 (bad token), 426 (no `Upgrade`), 429 |
| 37 | GET | `/c/:token/win` | control | — | `text/plain` `"ok"` + `Cache-Control: no-store`; `"dup"` (200) if the identical action arrived < 600 ms ago (§4.10) | 404 (bad token), 409, 429, 503 |
| 38 | GET | `/c/:token/loss` | control | — | `"ok"` | as #37 |
| 39 | GET | `/c/:token/skip` | control | — | `"ok"` | as #37 |
| 40 | GET | `/c/:token/next` | control | — | `"ok"` — **alias of `skip`**; Stream Deck labels differ, the action does not | as #37 |
| 41 | GET | `/c/:token/undo` | control | — | `"ok"` | as #37 |
| 42 | GET | `/c/:token/stop-loop` | control | — | `"ok"`; sets `stop_after_current = 1` (never toggles) | as #37 |
| 43 | GET | `/covers/:key` | none | — | the R2 object under the **bare** key, `ETag` from `obj.httpEtag`, `Cache-Control: public, max-age=31536000, immutable`. `key = decodeURIComponent(url.pathname.slice('/covers/'.length))`; **reject with 404 any key containing `/` or `..`, or longer than 128 chars**. The ingest writes `COVERS.put(cover_key, …)` with no prefix, and `games.cover_key` stores that same bare name — one spelling in the schema, the R2 write, the `<img src>` and this route | 404 |
| 44 | * | anything else | none | — | `env.ASSETS.fetch(request)` | 404 from the asset pipeline |

Any method not listed for a path → **405** with an `Allow` header. `OPTIONS` is not implemented:
there is no cross-origin client (the admin panel is same-origin, the overlay is same-origin, and
Stream Deck does not preflight a GET). **No CORS headers are emitted anywhere.**

### 5.3 Error body shape

```ts
{ error: string, detail?: string }     // e.g. { error: 'nothing_to_undo' }
```
`detail` is present only for 400/502/503 and never contains a secret, a token, or a stack.
`logError(scope, err)` writes the structured line to Workers Logs; the client gets the code.

### 5.4 `Plan.reject` → HTTP status

| reject | status | body |
|---|---|---|
| `no_live_session` | 409 | `{error:'no_live_session'}` |
| `session_ended` | 409 | `{error:'session_ended'}` |
| `empty_session` | 409 | `{error:'empty_session'}` |
| `already_live` | 409 | `{error:'already_live'}` |
| `not_draft` | 409 | `{error:'not_draft'}` |
| `nothing_to_undo` | 409 | `{error:'nothing_to_undo'}` |

Every 409 is a **no-op**: no event written, no `sessions` update, no broadcast, no `seq`
increment. On the `/c/*` routes a 409 returns `text/plain` `"noop"` with status 409 so a Stream
Deck button visibly does nothing rather than silently succeeding.

Undo that rewinds past a `session_end` additionally runs
`UPDATE sessions SET status='live', ended_at=NULL WHERE id=?` in the same batch; undo that
rewinds past a `session_start` cannot happen (§2.5d).

---

## 6. Auth & tokens

### 6.1 Cloudflare Access — defense in depth

Access in front, independent JWT assertion validation inside the Worker. `src/auth.ts` exports
exactly four things:

```ts
declare const __DEV__: boolean;   // declared in src/globals.d.ts, replaced at build time

/** 401 Response on failure, {email} on success. There is no middleware, no framework. */
export async function requireAccess(request: Request, env: Env): Promise<{ email: string } | Response>;
export function json(data: unknown, status?: number): Response;
export function logError(scope: string, error: unknown): void;
export function withSecurityHeaders(res: Response, opts?: { frame?: 'DENY' | 'SAMEORIGIN' }): Response;
```

`requireAccess` returns a union rather than throwing or wrapping, so every protected handler is:

```ts
const auth = await requireAccess(request, env);
if (auth instanceof Response) return auth;
// ...auth.email is the verified owner
```

Implementation, in this exact order:

```ts
const jwksCache = new Map<string, JWTVerifyGetKey>();          // module scope: survives across
function getJwks(teamDomain: string): JWTVerifyGetKey {         // requests in the same isolate
  let jwks = jwksCache.get(teamDomain);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`));
    jwksCache.set(teamDomain, jwks);
  }
  return jwks;                                                  // jose does its own key-rotation refetch
}

export async function requireAccess(request: Request, env: Env) {
  // DEV ONLY — local admin testing. Cloudflare Access cannot sit in front of `wrangler dev`,
  // so the JWT assertion can never be present locally and admin would always 401. This branch
  // grants a fake owner identity. `__DEV__` is a build-time `define` constant replaced with the
  // literal `false` by esbuild, and `wrangler deploy` runs with `minify: true`, so the whole
  // block — including the string 'dev@localhost' — is dead-code-eliminated from the deployed
  // bundle. It can NEVER bypass auth in production.
  // Verify with: npm run verify:dce   (grep -r dev@localhost dist  ->  no match)
  if (__DEV__) return { email: 'dev@localhost' };

  const teamDomain = env.CF_TEAM_DOMAIN;
  const aud = env.CF_ACCESS_AUD;
  if (!teamDomain || !aud) return unauthorized('Zugriff verweigert: Access ist serverseitig nicht konfiguriert.');

  // Deliberately NOT the CF_Authorization cookie: an attacker reaching the Worker origin
  // directly could forge it. Only the signed assertion header is trusted.
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) return unauthorized('Zugriff verweigert: Kein Access-Token vorhanden.');

  try {
    const { payload } = await jwtVerify(token, getJwks(teamDomain), {
      issuer: `https://${teamDomain}`,
      audience: aud,
      algorithms: ['RS256'],     // pinned: a future dependency change must not relax this
    });
    const email = typeof payload.email === 'string' ? payload.email : undefined;
    if (!email) return unauthorized('Zugriff verweigert: Token enthält keine E-Mail.');
    return { email };
  } catch {
    return unauthorized('Zugriff verweigert: Token-Validierung fehlgeschlagen.');
  }
}
```

`unauthorized()` is a local helper returning `401`, `content-type: text/plain; charset=utf-8`,
`cache-control: no-store`. Fail-closed rules, all of them mandatory:

| condition | result |
|---|---|
| `CF_TEAM_DOMAIN` unset or empty | 401 |
| `CF_ACCESS_AUD` unset or empty | 401 |
| header absent | 401 |
| signature invalid / wrong issuer / wrong audience / expired / alg ≠ RS256 | 401 |
| JWKS fetch fails (`jose` throws) | 401 |
| payload has no `email` | 401 |
| **any unexpected throw** | 401 (the `catch` is total — never a 500 that a proxy might treat as retryable) |

`workers_dev: false` in `wrangler.jsonc`, because an open `*.workers.dev` hostname routes around
the Access application entirely.

### 6.2 The `__DEV__` build-time define

`import.meta.env.DEV` does not exist in a plain Worker. The equivalent is an esbuild `define`,
passed through unmodified by wrangler.

`src/globals.d.ts` — `wrangler types` never generates this and would overwrite it if it lived in
`worker-configuration.d.ts`:
```ts
declare const __DEV__: boolean;
```

`wrangler.jsonc`:
```jsonc
"define": { "__DEV__": "false" },     // the VALUE is raw source text, not an implicit string
"minify": true                        // required: define alone leaves `if (false) {...}` in the bundle
```

`package.json`:
```json
"dev": "wrangler dev --define __DEV__:true",
```
CLI `--define` beats config `define`, so `wrangler dev` gets `true` and every build/deploy gets
`false`. **Never** write `"__DEV__": "\"false\""` — that produces the truthy string `"false"`.

**The verification, exactly:**
```bash
npm run build           # wrangler deploy --dry-run --outdir dist --minify
grep -r dev@localhost dist        # MUST print nothing and exit 1
```
`--minify` is not optional. Verified empirically: `--dry-run --outdir dist` **without** `--minify`
leaves the whole dead branch, string literal included, physically present in `dist/index.js`.
The `verify:dce` script (§9.1) fails the build if the grep finds anything.

### 6.3 The two unauthenticated tokens

**Generation** (`src/live-run.ts`):
```ts
// 32 chars from a 32-symbol alphabet = 160 bits of CSPRNG entropy. The alphabet is exactly 32
// symbols so `byte & 31` is uniform — a 31- or 36-symbol alphabet with `% len` would be biased.
// 'l', 'o', '0' and '1' are omitted: these strings get read aloud and retyped from a phone.
const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';   // 24 letters + 8 digits = 32
function newToken(): string {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(b, (x) => ALPHABET[x & 31]).join('');
}
```

**Storage: `ctx.storage.kv` in the LiveRun DO, under the single key `tok`:**
```ts
{ overlay: string, control: string, rotatedAt: number }
```
Generated lazily on first read (so a fresh deploy needs no seeding step) and returned by the
`tokens()` RPC.

**DECISION: no D1 `settings` table for the tokens.** Rationale: every request that needs a token
check (`/o/*`, `/c/*`) is already going to the DO, so a D1 mirror would add a table, a write path
and a cache-invalidation problem to save nothing. DO SQLite storage is durable and has 30-day
PITR; a lost token is a rotate button away.

**Validation** — one RPC, used by every unauthenticated route:
```ts
authToken(token: string, charge = true): 'overlay' | 'control' | null
```
- Length-checked then compared byte-by-byte with a constant-time XOR accumulator (`eq(a,b)`);
  cheap, and this is a security path.
- Consumes one rate-limit token **before** comparing (§6.4) when `charge` is true, so the bucket
  also throttles guessing. **Routes 33 and 34 pass `charge: false`.** Those two responses are
  static HTML shells that contain no token and no state (§5.1), so there is nothing for the bucket
  to protect — and charging them lets an OBS restart with several browser sources, or one drag of
  the §8.5 preview slider, empty the bucket and 429 the next real Stream Deck press.
- A failure returns **404**, never 401 — a 401 on `/o/<guess>` confirms the URL shape exists.

**Rotation** (`POST /api/admin/tokens/rotate`): overwrite the named field(s) in `tok`, set
`rotatedAt = Date.now()`, then **immediately** `close(1008, 'token rotated')` every socket whose
attachment says `role === 'overlay'` (if the overlay token rotated). Because the token is only
ever checked at connect/request time and there is no cache anywhere, the old URL is dead on the
next request — no TTL, no propagation delay. The admin UI must warn that OBS needs the new URL
pasted in.

### 6.4 Rate limit on the control endpoints

**Token bucket in DO storage. One bucket, key `rl`, shared by every unauthenticated request that
carries or acts on a secret: `/o/:t/ws`, `/o/:t/recap.json` and all of `/c/*`.** The two HTML
shells (routes 33/34) are deliberately **not** charged — see §6.3.

```ts
// capacity 20, refill 2/s. A human on a Stream Deck peaks around 3 presses/sec; 20 absorbs a
// double-tap flurry and a page reload storm, and 2/s starves an online guessing attempt against
// a 160-bit token into irrelevance. Fixed windows were rejected: they allow a 2x burst across
// the boundary.
const CAP = 20, REFILL_PER_SEC = 2;
private take(): boolean {
  const now = Date.now();
  const b = this.ctx.storage.kv.get<{ tokens: number; at: number }>('rl') ?? { tokens: CAP, at: now };
  const tokens = Math.min(CAP, b.tokens + ((now - b.at) / 1000) * REFILL_PER_SEC);
  if (tokens < 1) { this.ctx.storage.kv.put('rl', { tokens, at: now }); return false; }
  this.ctx.storage.kv.put('rl', { tokens: tokens - 1, at: now });   // sync: no await, no yield point
  return true;
}
```

Exceeded → **429** with `Retry-After: 1` and body `"rate limited"`. Synchronous `kv` means the
read-modify-write has no yield point at all, so two simultaneous presses cannot both take the
last token.

**DECISION: one bucket, not per-token or per-IP.** There is exactly one streamer and exactly two
tokens; a second bucket would be an index with one entry.
`ponytail:` comment to place above `take()`:
```ts
// ponytail: one global bucket in DO storage for all unauthenticated traffic. No KV, no counters
// table, no per-IP map. Ceiling: one abusive client can starve the real Stream Deck. Acceptable
// for a single-streamer tool; if this ever serves more than one channel, key the bucket by token.
```

Authenticated `/api/admin/*` routes are **not** rate-limited — they are already behind Access.

### 6.5 GET with side effects — the required `ponytail:` comment

Place this verbatim above the `/c/:token/:action` branch in `src/index.ts`:

```ts
// ponytail: GET with side effects, deliberately. Stream Deck's "Open Website" action only issues
// a GET, so win/loss/skip/undo have to be GET-able or the hotkey feature does not exist.
// Mitigation: (1) a 160-bit secret path segment, so the URL is the credential and is not
// guessable; (2) a token-bucket rate limit in DO storage (20 burst, 2/s) in front of the token
// comparison itself; (3) zero cookies and zero Authorization headers involved, so CSRF has
// nothing to ride on — a forged cross-site GET carries no ambient credential and a third party
// cannot construct the URL. Upgrade path: if Stream Deck ever learns POST, flip the method and
// delete this comment.
```

Additional hardening on `/c/*`, all mandatory:
- **The §4.10 replay guard**: an identical `/c/*` action arriving within **600 ms** of the previous
  one is coalesced into a no-op returning `"dup"`. A GET has no body to carry an `action_id`, and a
  Stream Deck double-press or an OS re-issue of the GET is otherwise indistinguishable from two
  intended presses. Document the window here: the second press of a deliberate double-tap is lost.
- `Cache-Control: no-store` (a caching proxy replaying a win is unacceptable).
- The response is `text/plain`, never HTML — nothing to render, nothing to prefetch-trigger.
- **DECISION: no `Sec-Fetch-*` or User-Agent checks.** Stream Deck's embedded browser is not a
  documented, stable UA; a heuristic that fails silently mid-stream is worse than the risk it
  addresses.

---

## 7. Overlay contract

### 7.1 DOM skeleton (`public/overlay.html`)

Fixed structure. **The renderer never creates or removes elements** — it only sets
`textContent`, toggles classes, and sets CSS custom properties. Zero DOM churn means zero layout
invalidation from state updates.

```html
<head>
  <meta charset="utf-8" />
  <!-- IN THE HEAD, not at the end of the body: Chromium blocks rendering of what FOLLOWS an
       in-body stylesheet, so a body-end <link> paints the raw DOM — title, "0", "0", "1", "/2" —
       as default black text over live gameplay for a frame or more on every OBS source refresh
       and every scene activation. recap.html and admin/index.html get the same treatment. -->
  <link rel="stylesheet" href="/overlay.css" />
</head>
<body>
  <!-- data-mode drives EVERYTHING via CSS: idle | loss | streak | ended -->
  <!-- data-anim is set for the duration of one transition: win|loss|streak-in|streak-break|won|intro|undo -->
  <div id="card" data-mode="idle" data-anim="">
    <div id="cover-wrap">
      <img id="cover" alt="" />          <!-- src=/covers/<bare cover_key>, full opacity, never blurred -->
      <div id="cover-flash"></div>       <!-- one transform/opacity element for the win flash -->
    </div>

    <div id="info">
      <div id="title"></div>             <!-- game title -->
      <div id="meta"></div>              <!-- "Spiel 3/8 · Lap 2 · B2B"  (strings.js) -->
    </div>

    <!-- LOSS_MODE hero -->
    <div id="loss-block">
      <div id="loss-label"></div>        <!-- "Niederlagen" -->
      <div id="loss-value">
        <span class="digits" id="loss-now">0</span>
        <span class="digits" id="loss-prev">0</span>  <!-- the outgoing number, transform-only -->
      </div>
      <div id="attempts"></div>          <!-- "12 Versuche" -->
    </div>

    <!-- STREAK_MODE hero -->
    <div id="streak-block">
      <div id="flame" aria-hidden="true"></div>   <!-- THE only looping animation in the app -->
      <div id="streak-value"><span id="streak-now">1</span><span id="streak-req">/2</span></div>
      <div id="streak-label"></div>      <!-- "Serie" -->
    </div>

    <!-- GAME_WON celebration + ENDED card share this layer -->
    <div id="banner"><span id="banner-text"></span></div>
  </div>

  <audio id="sfx-streak" preload="none" src="/sfx/streak-start.ogg"></audio>
  <audio id="sfx-break"  preload="none" src="/sfx/streak-break.ogg"></audio>
  <audio id="sfx-won"    preload="none" src="/sfx/game-won.ogg"></audio>

  <script type="module" src="/overlay.js"></script>
</body>
```

**`#cover` when there is no cover.** `cover_key` is nullable by design (route 6's 502 path creates
the game with `cover_key` null; §8.2's manual form makes the cover optional), and route 43 404s a
missing object — so the dominant element of the card must have a defined empty state instead of a
grey broken-image glyph on camera:

- `coverKey === null` → `cover.removeAttribute('src')` — **never** `cover.src = ''`, which Chromium
  resolves to the document URL and renders as a broken image — and set `#card[data-cover="none"]`.
- `#cover.onerror` sets the exact same attribute, so a 404 or a dead R2 object lands in the same
  place as a null key.
- `#title` becomes the dominant element via one CSS rule (§7.2). No new element, no JS layout work.

**`#title` is bounded by construction.** Real IGDB titles run to 70 characters
("The Legend of Zelda: Breath of the Wild — Master Mode Trial of the Sword"), and the renderer only
sets `textContent`, so the clamp has to be CSS: a fixed `max-width` in `ch` plus a two-line clamp
(§7.2). Routes 6/7 cap the stored name at 80 characters. Card height is therefore fixed whatever
the title is — no JS measurement, nothing on the §7.6 banned list.

### 7.2 CSS approach (`public/overlay.css`)

```css
html, body {
  background: transparent !important;   /* !important: OBS's Custom CSS field gets cleared by
                                          streamers, and some hosts force a background */
  margin: 0; overflow: hidden;
  /* zero opaque paint anywhere outside #card */
}
@font-face {
  font-family: 'Inter'; src: url('/fonts/inter-var-latin.woff2') format('woff2');
  font-weight: 400 900; font-display: block;   /* block, not swap: a FOUT on camera looks broken */
  /* format('woff2'), NOT format('woff2-variations'): the latter is a dead early-draft keyword
     that Chromium (and therefore OBS's CEF) does not recognise, and an unrecognised format()
     makes the UA skip that src component entirely — Inter would never even be requested, and
     font-display:block hides the fallback swap, so the whole overlay renders in the CEF default
     font with no 404 in the log to explain it. Plain woff2 loads variable fonts everywhere. */
}
:root {
  --accent: #ff5a1f;          /* overwritten from ?accent= */
  --card-alpha: 0.85;         /* overwritten from ?opacity= */
  --scale: 1;                 /* overwritten from ?scale= */
}
#card {
  transform: scale(var(--scale));   /* scale via transform, NEVER via width/height/font-size */
  transform-origin: <derived from ?pos=>;
  background: rgba(12, 12, 16, var(--card-alpha));
  color: #fff;                       /* text and cover art at FULL opacity, always */
  font-variant-numeric: tabular-nums; /* counters must not reflow as digits change */
}
@supports (backdrop-filter: blur(18px)) {
  #card { backdrop-filter: blur(18px) saturate(1.2); background: rgba(12,12,16, calc(var(--card-alpha) * 0.72)); }
}
```

- `backdrop-filter` is applied **only** inside `@supports`, and the non-supporting branch is a
  higher-alpha solid rgba fill. It is set **once, statically** — never animated, never
  transitioned. (It cannot blur the OBS scene behind the source; that is architectural, by
  design, and not a bug to chase. Within the page it may render with artifacts against a
  transparent backdrop — which is why the solid fallback must look good on its own.)
- Positioning uses `position: fixed` with static `inset` values chosen by `?pos=`; nothing is
  animated with `inset`.
- Mode switching is pure CSS: `#card[data-mode="loss"] #streak-block { opacity: 0; transform: translateY(8px) scale(.96) }` etc. **No `display: none` toggles on animating elements** —
  they force layout. Use `opacity` + `transform` + `pointer-events: none` and keep both hero
  blocks in the layout at all times (grid-stacked in the same cell).
- **The flame's animation is attached to the mode, not to the element.** `#flame` carries **no**
  `animation` and **no** `will-change` by default; both live only under
  `#card[data-mode="streak"] #flame { animation: flame 1.6s infinite; will-change: transform }`.
  `opacity: 0` does **not** suppress a compositor animation — only `display: none` does, and that
  is banned above — so an unscoped `@keyframes` on `#flame` would tick every frame and pin a
  compositor layer for the whole stream, right through the `LOSS_MODE` that §7.6 requires to be
  completely static. Scoping is what lets both rules hold at once.
- `#title { max-width: 22ch; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient:
  vertical; overflow: hidden }` — bounds the card height for any title (§7.1). Static properties
  only; nothing here is ever animated or transitioned.
- `#card[data-cover="none"] #cover-wrap { opacity: 0 }` — the grid-stacked layout already collapses
  the cell, so `#title` takes over as the dominant element (§7.1).

### 7.3 The three display modes and their driving fields

| mode | condition | hero | fields read |
|---|---|---|---|
| `IDLE` | `phase === 'idle'` | nothing visible (card at `opacity: 0`) | `phase` |
| `LOSS_MODE` | `phase==='live' && (current.streak === 0 \|\| current.streak >= current.required)` | `#loss-block`, cover dominant | `current.coverKey`, `current.title`, `current.losses` (hero), `current.attempts`, `current.positionInLap`, `current.lapSize`, `lap`, `current.mode` |
| `STREAK_MODE` | `phase==='live' && 0 < current.streak < current.required` (only reachable for `b2b`, §2.5k) | `#streak-block` + `#flame` | `current.streak`, `current.required`, `current.title`, `current.coverKey` |
| `ENDED` | `phase === 'ended'` | `#banner` with the final numbers | `sessionTitle`, `totals.*` |

`GAME_WON` is not in this table — it is `data-anim="won"` for 1800 ms, driven by
`cause === 'game_won'` (§4.3), after which `data-mode` becomes whatever the next step says.

### 7.4 The animation queue — exact algorithm (`public/overlay.js`)

```js
const DUR = { snapshot:0, config:0, session_start:400, game_start:900, win:450, loss:600,
              streak_in:700, streak_break:800, game_won:1800, game_abandoned:500,
              session_end:700, undo:250 };
const MAX_QUEUE = 8;

let queue = [];            // Step[]  — never grows past MAX_QUEUE (see drain)
let playing = false;
let rendered = null;       // the RunState currently on screen; the tween's "from" side
let lastSeq = 0;

function onStep(step) {
  if (!step || typeof step.state !== 'object' || step.state === null) return;   // never render undefined
  if (step.cause === 'snapshot') {         // authoritative: nothing queued matters any more
    queue.length = 0; lastSeq = step.seq;
    render(step, 0); rendered = step.state; playing = false;
    return;
  }
  if (step.seq <= lastSeq) return;                          // duplicate/out-of-order: drop
  if (step.seq > lastSeq + 1) { requestResync(); }          // gap: ask, but keep rendering
  lastSeq = step.seq;
  queue.push(step);
  if (!playing) drain();
}

async function drain() {
  playing = true;
  while (queue.length) {
    if (queue.length > MAX_QUEUE) {
      // Coalesce: the human is faster than the animation. Jump to the newest truth with no
      // animation rather than fall further behind. NEVER drop the last step.
      const last = queue[queue.length - 1];
      queue.length = 0;
      console.warn('overlay: queue overflow, snapping to newest state');
      render(last, 0); rendered = last.state;
      continue;
    }
    const speed = queue.length <= 2 ? 1 : queue.length <= 4 ? 1.5 : 3;
    const step = queue.shift();
    await render(step, DUR[key(step)] / speed);   // resolves on animationend OR the timeout below
    rendered = step.state;
  }
  playing = false;
}
```

Hard rules:
- **A transition always plays to completion.** `render()` returns a promise resolved by the
  `animationend`/`transitionend` event **or** by a `setTimeout` of `duration + 120 ms`, whichever
  fires first. Never `await` an event with no timeout — a missed `animationend` (OBS drops these
  under Efficiency-Mode throttling) would freeze the queue and the overlay forever.
- **State is coalesced only above `MAX_QUEUE = 8`,** and even then the newest step is rendered.
  Below that depth every step is played, compressed by `speed`. Rationale: prompt §3.6 — "a
  dropped frame is fine; a half-played flame animation frozen on screen is not."
- `snapshot` always wins and always flushes. That is what makes reconnect and redeploy safe.
- `cause: 'loss'` arriving while `rendered.displayMode === 'STREAK_MODE'` plays `streak_break`
  **then** `loss` as one 800+600 ms beat (the "audience feels the drop" requirement) — that is the
  one composite in the table, keyed by the *rendered* mode, not by the cause alone.
- SFX (`?sfx=1` only): `streak-start` on entering `STREAK_MODE`, `streak-break` on leaving it via
  a loss, `game-won` on `cause==='game_won'`. `audio.volume = clamp(vol, 0, 0.8)`, `audio.currentTime = 0` then `play()`. No user-gesture unlock is needed — OBS launches CEF with
  `--autoplay-policy=no-user-gesture-required`, so `play()` from a WS handler works. A `.catch(()=>{})` on `play()` is still mandatory for a normal browser tab (the admin preview).

### 7.5 Query parameters

Read once at load from `location.search`. **Every value is clamped or falls back — an invalid
value never breaks the render.** Parse with `Number()`/regex, reject `NaN`.

| param | type | default | valid range / pattern | out-of-range behaviour |
|---|---|---|---|---|
| `scale` | number | `1` | `0.5 … 2.0` | clamp |
| `opacity` | number | `0.85` | `0.30 … 1.00` | clamp — this is the **card fill alpha only**; text and cover art are always opaque |
| `accent` | string | `ff5a1f` | `^#?[0-9a-fA-F]{6}$` (leading `#` optional and stripped) | fall back to the default |
| `sfx` | `0` \| `1` | `0` | exactly `0` or `1` | anything else → `0` (off by default, prompt §6.5) |
| `vol` | number | `0.5` | `0.0 … 0.8` | clamp (hard cap 0.8) |
| `pos` | enum | `bl` | `tl,tc,tr,bl,bc,br` | fall back to `bl` |
| `mono` | `0` \| `1` | `0` | `0`/`1` | `1` forces the no-`backdrop-filter` solid-fill branch — the escape hatch if a given OBS build composites the blur badly |

`?scale=` is applied as `transform: scale()` on `#card`, **not** as a font-size or width change.
Admin's Overlay-URLs screen (§8.5) generates copy-ready URLs with these params pre-filled.

### 7.6 CPU budget rules

Target: **< 3 % CPU at 1080p60 on a mid-range machine, at rest.** Enforced by rules, then measured.

**Animate ONLY `transform` and `opacity`.** Banned outright — never in a `@keyframes`, a
`transition`, or a JS-set style:

```
width, height, min/max-width, min/max-height
top, right, bottom, left, inset
margin*, padding*, gap
font-size, letter-spacing, line-height
border-width, border-radius
box-shadow, text-shadow
filter, backdrop-filter
background-position, background-size, background-color
clip-path, offset-path
```
Colour changes are done by cross-fading two stacked, pre-coloured layers with `opacity`, never by
transitioning `background-color`.

**At rest:**

| resting mode | simultaneously animating elements |
|---|---|
| `IDLE` | **0** |
| `LOSS_MODE` | **0** — no CSS animation, no `requestAnimationFrame` loop, no timer other than the 20 s WS heartbeat |
| `STREAK_MODE` | **exactly 1** — `#flame`, a single element, one `@keyframes` on `transform` + `opacity`, `will-change: transform`, 1.6 s loop. Both the `@keyframes` and the `will-change` are attached **only** under the `#card[data-mode="streak"]` selector (§7.2), which is what makes the other three rows genuinely 0 without any `display` toggle |
| `ENDED` | **0** |

`LOSS_MODE` is where the overlay spends most of the stream, and it must be **completely static**.
There is no rAF loop in `overlay.js` at all; counters are tweened with CSS transitions on
`transform`/`opacity` and a class toggle, and the elapsed-time text (if shown) updates from a
`setInterval` of **1000 ms** that is **cleared whenever `document.hidden`** is true.

**During a transition:** at most **4** simultaneously animating elements, for at most **1800 ms**.
`will-change` is added at transition start and **removed on completion** (a permanent
`will-change` pins a compositor layer per element and costs GPU memory for nothing).

Measurement protocol (`web-perf`, report real numbers, not "should be fine"):
1. Chrome DevTools Performance trace, 30 s at rest in `LOSS_MODE`, then 30 s in `STREAK_MODE`.
   Record: scripting / rendering / painting ms, and layout-shift count (must be 0).
2. In OBS: a 1920×1080 browser source (native size — a blur or filter costs per source pixel,
   not per on-canvas pixel), 60 fps, `Shutdown source when not visible` **off**, `Refresh browser
   when scene becomes active` **off**. Read the `obs-browser-page` renderer process CPU in Task
   Manager (Windows) / Activity Monitor (macOS) with the source toggled off, then on; the
   delta is the number to report. OBS's own Stats dock reports process-wide CPU only and is not
   a per-source measurement.
3. Report both numbers in the README. If `STREAK_MODE` misses the budget, the flame is
   simplified — the budget wins over the design.

### 7.7 Recap surface (`public/recap.html`, `public/recap.js`)

The recap card is the last graphic on camera and the frame most likely to be clipped and reshared,
so the inline SVG gets the same treatment as the overlay — and the defaults an SVG gives you (1 px
axes, hairline gridlines, series told apart by hue) are unreadable at stream bitrate. Four rules,
no chart library:

- **Minimum stroke 3 px** at rendered size; no gridline thinner than 2 px; no 1 px anything.
- **Never hue alone**: every series also carries a shape or a direct label, and every bar/point
  carries its **value printed next to it** — direct labels instead of a legend.
- `recap.html` links `/overlay.css` (§1) and reuses its palette, type scale, `font-variant-numeric`
  and full-opacity-text rules. No second design system.
- The §7.6 animation rules apply: the recap is static after its one fade-in.

---

## 8. Admin contract

One page (`public/admin/index.html`), seven sections, `<details>`/tab-switched — **not** seven
routes and **not** a client-side router. `admin.js` holds one object,
`app = { state, session, sessionGames, games, sessions, tokens }`, refreshed from
`GET /api/admin/state` on load and from the admin WebSocket (§4.1) thereafter. Every mutation is a
`fetch()` that returns the new truth; nothing is optimistically applied except the button's own
pressed styling.

Exactly the 7 items from prompt §7, no eighth.

| # | Screen | Reads | Writes | Notes |
|---|---|---|---|---|
| 8.1 | **Live control bar** — always visible, sticky, top of the page | `state.current.{coverKey,title,losses,streak,required,attempts,positionInLap,lapSize}`, `state.lap`, `state.displayMode`, `state.phase` | routes 21–24 | WIN / LOSS / SKIP as three oversized buttons (min 88 px tall, ≥ 33 % viewport width each on a phone). **UNDO is physically separated** (its own row, different colour family, `outline` style not filled) and requires no confirmation — a confirm dialog defeats one-handed use. Buttons are `disabled` while `phase !== 'live'` and while a request is in flight. A 409 flashes the button red for 400 ms with the German reason. Each press generates **one** `action_id` (uuid v4) and reuses it verbatim on any retry of that press, so a lost response cannot double-count (§4.10). |
| 8.2 | **Game library** | `app.games` (route 5) | routes 6–9, 10 | Cover-art grid, name below, mode chip (`1×` / `2× B2B`) tappable to flip `default_mode`. "+" opens IGDB search: debounced 350 ms `GET /api/admin/igdb?q=`, results as cover tiles, tap = create. Below it, always visible and never hidden behind a failure: a manual form (name + mode + optional cover file → route 9). If route 10 returns 502/503 the search box shows the German error and the manual form stays fully usable. |
| 8.3 | **Session builder** | `app.sessions` (route 11), `app.sessionGames` (route 13) | routes 12–20 | Ordered list with drag handles; drop → `PUT` the full id array (route 17). `loop` toggle → route 14. "Spiel hinzufügen" → route 16 (appends at the end; move it with a drag). Works while `status === 'live'`: the list stays editable, and the UI shows a marker on the current game plus the note "Vor dem aktuellen Spiel eingefügte Titel kommen erst in der nächsten Runde" (§2.5e). **The current entry's drag handle is disabled** while `phase === 'live'` — dragging the running game to the bottom would end the session (or skip the rest of the lap) on its next completion, §2.5f case 3; route 17 rejects it with 400 as the backstop. Deleting a played entry shows the 409 as "Bereits gespielt — kann nicht entfernt werden". |
| 8.4 | **Loop control** | `state.stopAfterCurrent`, `state.loop`, `state.phase` | routes 25, 26 | Two clearly different buttons: **"Nach diesem Spiel stoppen"** (latching, shows an active/armed state read from `state.stopAfterCurrent`, with its own visible "Doch weiterlaufen" off switch) and **"Jetzt stoppen"** (destructive styling, **the only button on the page with a confirm step** — it abandons the running game). The armed indicator must be visibly independent of UNDO, because UNDO does not clear it (§2.5h). |
| 8.5 | **Overlay URLs** | route 31 | route 32 | Three copy buttons (overlay / recap / control base) built from `tokens.urls`, each with the current §7.5 query params appended from the live-preview controls, plus a **rotate** button per token with a confirm ("OBS muss die neue URL bekommen"). Also renders the exact Stream Deck URLs for all six control actions as copyable rows. **The live preview (prompt §6.6) lives here:** one `<iframe src="/o/<token>?...">` on a CSS checkerboard, with sliders for `scale`/`opacity`/`accent`/`pos`. **`input` only updates the CSS-var preview and the copy-button URLs; the iframe `src` is rewritten on `change`, debounced 250 ms, and skipped when the URL is unchanged** — every `src` rewrite is a document load plus a WebSocket connect, and one undebounced drag would empty the §6.4 bucket and 429 the next Stream Deck press. One iframe, no second renderer. |
| 8.6 | **History** | route 11, route 28 | routes 29, 30 | Table of past sessions (title, date, games won/played, attempts, duration). Expanding a row fetches route 28 and shows the same recap numbers the overlay recap scene renders. Two download buttons per row → routes 29/30. |
| 8.7 | **Resume** | `state.phase`, `app.session.status` | route 27 | Rendered **only** when `session.status === 'live'`: a banner "Laufende Session gefunden — <title>, Spiel X/Y, Runde Z" with a **"Session fortsetzen"** button hitting route 27 (rehydrate from D1) and a direct link to 8.1. Because the DO hydrates from D1 on any cold start, a crashed stream is already resumed by the time this banner renders; the button exists for the case where the cached state looks wrong and the operator wants a forced reload from the log. |

Admin design constraints (from `impeccable`, non-negotiable):
- Phone-first single column; the live control bar is `position: sticky; top: 0` and never scrolls
  away.
- Minimum touch target 44×44 px; the three primary buttons are 88 px tall.
- Every state is unambiguous **without colour alone**: an armed "stop after current" also shows a
  text label, a live session also shows the word "LIVE".
- `prefers-reduced-motion: reduce` disables every admin transition (the overlay is exempt — it is
  a broadcast graphic, not a UI).
- No confirm dialogs anywhere except "Jetzt stoppen" and the two token rotations.

---

## 9. Build & verify

### 9.1 `package.json`

```json
{
  "name": "twitch-win-challenge",
  "private": true,
  "type": "module",
  "engines": { "node": ">=24" },
  "scripts": {
    "dev": "wrangler dev --define __DEV__:true",
    "typecheck": "tsc --noEmit",
    "types": "wrangler types",
    "test": "node --experimental-strip-types --test src/test_run.ts",
    "build": "wrangler deploy --dry-run --outdir dist --minify",
    "verify:dce": "npm run build && ! grep -r dev@localhost dist",
    "migrate:local": "wrangler d1 migrations apply twitch-win-challenge-db --local",
    "migrate:remote": "wrangler d1 migrations apply twitch-win-challenge-db --remote",
    "check": "npm run typecheck && npm run test && npm run verify:dce",
    "deploy": "npm run check && wrangler deploy"
  },
  "dependencies": { "jose": "^6" },
  "devDependencies": { "wrangler": "^4.125.0", "typescript": "^5", "@types/node": "^24" }
}
```

**One runtime dependency: `jose`** (JWT verification against a remote JWKS — hand-rolling RS256
verification is exactly the kind of security code you do not write). Three dev dependencies:
`wrangler`, `typescript`, and `@types/node` — the last one is not optional, because `test_run.ts`
imports `node:test` and `node:assert/strict` and `tsc` cannot resolve either without it (see §9.3).
No test framework: Node 24 runs TypeScript directly with `--experimental-strip-types` and ships
`node:test` + `node:assert`. No bundler for the frontend (§1). No CSS tooling.

`jose` needs **no** `compatibility_flags` — it runs on WebCrypto, which Workers expose natively.

### 9.2 `wrangler.jsonc` — complete

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "twitch-win-challenge",
  "main": "src/index.ts",

  // The newest date this installed wrangler/workerd accepts (it tracks the real clock and
  // rejects any future date). Must stay >= 2026-04-07 so web_socket_auto_reply_to_close is on
  // by default — that is why webSocketClose() does not call ws.close() itself.
  // nodejs_compat is implied for dates >= 2026-08-04, and jose does not need it anyway,
  // so there are deliberately NO compatibility_flags.
  "compatibility_date": "2026-08-20",

  // FILL IN before the first deploy. workers_dev is off (below), so without a route the Worker
  // is unreachable — that is intentional: an open *.workers.dev hostname routes around the
  // Cloudflare Access application in front of /admin.
  "routes": [{ "pattern": "REPLACE_ME.example.de", "custom_domain": true }],
  "workers_dev": false,

  // Required: `define` alone leaves `if (false) { ...'dev@localhost'... }` physically in the
  // bundle. minify is what actually eliminates it. See SPEC 6.2.
  "minify": true,
  // The VALUE is raw source text handed to esbuild, not an implicitly quoted string.
  // `wrangler dev` overrides this with --define __DEV__:true (CLI beats config).
  "define": { "__DEV__": "false" },

  "assets": {
    "directory": "./public",
    "binding": "ASSETS",
    "not_found_handling": "none",
    "html_handling": "auto-trailing-slash",
    // Only these five prefixes invoke the Worker. Everything else (js/css/woff2/ogg) is served
    // straight from the asset store with zero Worker invocation — the overlay's CPU budget and
    // the cost model both depend on this. Patterns MUST start with '/' or '!/'.
    "run_worker_first": ["/api/*", "/o/*", "/c/*", "/admin/*", "/covers/*"]
  },

  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "twitch-win-challenge-db",
      "database_id": "REPLACE_ME",          // from `wrangler d1 create twitch-win-challenge-db`
      "migrations_dir": "migrations"
    }
  ],

  "r2_buckets": [{ "binding": "COVERS", "bucket_name": "twitch-win-challenge-covers" }],

  "durable_objects": {
    "bindings": [{ "name": "LIVE_RUN", "class_name": "LiveRun" }]
  },

  // Declarative lifecycle (2026-06-30+). "sqlite" is the only valid storage for a new
  // namespace and the backend is IMMUTABLE once provisioned — getting this wrong means
  // delete-and-reprovision with full data loss.
  // `exports` and `migrations` are mutually exclusive; a config with both is rejected.
  // Fallback if this wrangler build rejects `exports`, use ONLY this instead:
  //   "migrations": [{ "tag": "v1", "new_sqlite_classes": ["LiveRun"] }]
  "exports": {
    "LiveRun": { "type": "durable-object", "storage": "sqlite" }
  },

  "observability": { "enabled": true, "head_sampling_rate": 1 }
}
```

Environment (`.dev.vars` locally, `wrangler secret put` in production — never both files;
`.dev.vars` suppresses `.env` entirely):

```
# .dev.vars.example  (committed; .dev.vars* is gitignored)
CF_TEAM_DOMAIN=example.cloudflareaccess.com
CF_ACCESS_AUD=0000000000000000000000000000000000000000000000000000000000000000
IGDB_CLIENT_ID=dummy-client-id
IGDB_CLIENT_SECRET=dummy-client-secret
```

`env.LIVE_RUN.getByName('live', { locationHint: 'weur' })` — the **same call, with the same hint,
everywhere**. The very first `get()` in the object's life permanently pins its data centre, and
`locationHint` is honoured only on that call. **Do not touch the DO from CI, a seed script, or an
uptime check before the first real request** — a US runner would pin a German stream's DO to
North America forever. Never add `.jurisdiction(...)` later: the same name inside a jurisdiction
is a *different, empty* object.

### 9.3 `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "es2022",
    "module": "es2022",
    "moduleResolution": "bundler",
    "lib": ["es2022"],
    "types": ["./worker-configuration.d.ts", "node"],
    "allowImportingTsExtensions": true,
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src/**/*.ts"]
}
```
`types` lists **both** entries: pinning it to the workers file alone makes `tsc` fail on
`test_run.ts`'s `import { test } from 'node:test'`, which fails `npm run check`, which is a
prerequisite of `npm run deploy`. `allowImportingTsExtensions` (legal because `noEmit` is already
true) is what lets `test_run.ts` write `import { … } from './run.ts'` **with the extension** —
Node's type stripping does not remap `.js` → `.ts`, and `tsc` rejects a `.ts` specifier without
this flag, so either spelling fails one of the two commands in `check` unless both are set.

`noUncheckedIndexedAccess` is on deliberately: `run.ts` is full of array indexing and this is the
one file where an `undefined` slipping through shows up as a wrong number on camera.
`worker-configuration.d.ts` is generated by `npm run types` and **gitignored** (regenerate in CI;
it is derived from `wrangler.jsonc`). `src/globals.d.ts` is hand-written and committed, because
`wrangler types` has no knowledge of `define` and would drop the `__DEV__` declaration.

### 9.4 Verification — one command per §10 checkbox

| Prompt §10 checkbox | Exact verification |
|---|---|
| `wrangler dev` runs; overlay renders at `/o/<token>` with a transparent background | `npm run migrate:local && npm run dev`, then `curl -s localhost:8787/api/admin/state` (dev fake identity) to read the token, open `http://localhost:8787/o/<token>` in Chrome, DevTools → Rendering → **Show layout shift regions** off / screenshot with a magenta page background behind it: no opaque box outside `#card`. `curl -I localhost:8787/overlay.css` must show `content-type: text/css` served without a Worker log line. |
| admin auth fails closed without Access config | `wrangler dev` **without** `--define __DEV__:true` and with `CF_TEAM_DOMAIN` removed from `.dev.vars` → `curl -s -o /dev/null -w '%{http_code}' localhost:8787/api/admin/state` must print `401`. Repeat with a garbage `Cf-Access-Jwt-Assertion` header → `401`. |
| State-machine self-check passes, incl. undo across a game boundary | `npm test` — all 34 assertions in §2.7 pass; test 13 is the boundary case. |
| Overlay survives source reload, WS drop, Worker redeploy with no state loss | (a) OBS → right-click source → Refresh; the counters return within 1 s. (b) `wrangler dev`, kill the process, restart: the overlay reconnects on the backoff schedule and shows the same numbers. (c) `wrangler deploy` while a socket is open: every socket closes, all reconnect, the snapshot matches. **This row is manual on purpose.** The automated equivalent (`evictDurableObject(stub)` from `cloudflare:test`) exists only inside `@cloudflare/vitest-pool-workers`, which means vitest, a `vitest.config.ts` and two more dev dependencies for one assertion — §9.1 has no test framework and §1's tree has no config for one. Step (b) already forces a cold start from D1, which is the behaviour at risk. |
| Measured overlay CPU reported against the §7.6 budget | The two-step protocol in §7.6. Put the actual percentages in `README.md`; "should be fine" is not an answer. |
| `grep -r dev@localhost dist` returns nothing | `npm run verify:dce` (fails the build on any match). |
| Control endpoints rate-limited; both tokens rotatable | `for i in $(seq 1 30); do curl -s -o /dev/null -w '%{http_code} ' "localhost:8787/c/<t>/loss"; done` → the tail must be `429`. Rotate via route 32, then re-request the **old** overlay URL → `404`, and confirm the open overlay socket was closed with `1008`. |
| Recap renders from a seeded historical session; JSON + CSV export work | Seed with a handful of `wrangler d1 execute --local --command "INSERT INTO events ..."` statements (or drive the control routes and then `stop-now`), open `/o/<token>/recap`, then `curl -s .../export.json \| head` and `curl -s .../export.csv \| head`. |
| README covers setup, secrets, migrations, OBS settings, query params, Stream Deck | Manual read-through. The OBS section must state: *Shutdown source when not visible* **off**, *Refresh browser when scene becomes active* **off**, *Control audio via OBS* **on** (only needed if `?sfx=1`), browser source sized to its **native** pixel dimensions (never 1920×1080 scaled down — filter cost is per source pixel). The **Stream Deck** section must specify: the "Website" action with the **background-request option enabled** (without it every press opens a browser window over the fullscreen game — focus stolen, input dropped, on camera), one button per URL for all six control actions, and a note that `next` is an alias of `skip` so the two must not be treated as different actions. §8.5 renders those six URLs as copyable rows and labels them with the same button names. |
| Final review pass against `workers-best-practices` + `ponytail` | Report deletions, not additions. |

Pre-deploy gate: `npm run check` (typecheck + tests + DCE grep) is a prerequisite of
`npm run deploy`. `wrangler versions upload` **must not** be used: it cannot apply Durable Object
lifecycle changes and fails fast when `exports` is present.

---

## 10. Open questions for the human

Four items. Everything else in this document is decided.

1. **The production hostname.** `wrangler.jsonc` has `routes: [{ pattern: "REPLACE_ME.example.de",
   custom_domain: true }]` and `workers_dev: false`, so the Worker is unreachable until this is
   filled in. **Recommended default:** a subdomain of a zone you already have, e.g.
   `win.your-domain.example`, and the Cloudflare Access application bound to
   `win.your-domain.example/admin*` **and** `win.your-domain.example/api/admin*`.
2. **`CF_ACCESS_AUD`.** Needs the Access application's AUD tag, which only exists after the
   application is created in the dashboard. **Recommended default:** reuse an existing Access
   application/policy if the hostname lives in a zone that has one — one policy, one login.
3. **Overlay accent colour default.** Spec'd as `#ff5a1f` (warm orange, reads well over most
   gameplay and matches the flame motif). **Recommended default: keep it**, and tune live via
   `?accent=` in the admin preview — no code change needed either way.
4. **Whether the recap scene should auto-select the session.** Spec'd as
   `/o/<token>/recap?session=latest` resolving to the **live** session if there is one, else the
   newest `ended` one. The precedence is deliberately that way round: a live session is always the
   one on camera, so the ended-first reading would render last week's numbers — fully plausible and
   completely wrong, with nothing on screen saying so — any time the streamer switches to the recap
   scene before pressing "Jetzt stoppen". **Recommended default: keep it** — one URL that never
   needs editing between streams is worth more than explicitness for a scene the streamer switches
   to once per stream. `?session=<id>` remains the explicit form.

---

## 11. Review resolutions

Three adversarial reviews, 32 findings. Applied unless stated. Section numbers are post-fix.

| # | Resolution |
|---|---|
| 1 | **Applied.** §2.4 `displayMode` now bounds on `required`; `skip`/`game_abandoned` set `V.streak = 0`; §2.1 and §7.3 updated. Test 5 is satisfiable. |
| 2 | **Applied.** §3.4 `visit` CTE rebuilt on `LEAD(seq)` with an upper bound in `round`; `visit_t` dropped; §3.3 restated. Sub-item "add a SQL-vs-`reduce()` test to §2.7" **rejected**: `test_run.ts` is pure `node --test` with no D1 binding; §3.3 states the identity and §9.4's seeded recap observes it. |
| 3 | **Applied.** §3.2 R1 keyed by id + new R1b discovery/`already_live` query; kv `sid`; `start()` drops `cfg` and rewrites `sid` before step 1; `not_draft` added to `Plan.reject`, route 20 and §5.4. |
| 4 | **Applied.** §4.9 step 4b + §2.5h + §4.8: any turn writing the `sessions` row patches the cached `cfg.session` in the same `serialise()` body. Patch, not delete, so no extra D1 read for a value the DO just wrote. |
| 5 | **Applied.** §2.5f case 3 (named), route 17 → 400, §8.3 disables the current entry's drag handle. Advance-tail fallback **rejected** as the larger fix (it would break case 1's deliberate replay). |
| 6 | **Applied.** Q_PER_LAP and Q_PER_GAME now drive off `visit LEFT JOIN round`, with `COALESCE` so a round-less visit reads 0 instead of NULL. |
| 7 | **Applied** — same fix as 1. |
| 8 | **Applied** — same fix as 2. |
| 9 | **Applied.** §4.5: only broadcast steps advance `seq`; a unicast snapshot reuses the current value. Sub-item "deep-equal guard in `onStep`" **rejected**: with the counter fix the spurious resync is gone, and "snapshot always wins and always flushes" (§7.4) is the rule that makes reconnect safe. |
| 10 | **Applied** — same fix as 3. |
| 11 | **Applied.** §7.2 `format('woff2')`, with the reason inline. |
| 12 | **Applied.** §7.2/§7.6: `#flame`'s `@keyframes` and `will-change` live only under `#card[data-mode="streak"]`. |
| 13 | **Applied.** §9.1 adds `@types/node`; §9.3 adds `"node"` to `types` and `allowImportingTsExtensions`; the dependency-count claim corrected. |
| 14 | **Applied.** kv `igdb` + one RPC `igdbToken()` (§4.7/§4.8); `igdb.ts` takes the token as a parameter; route 10 calls the stub first. |
| 15 | **Applied.** `cover_key` is the bare object name everywhere (§3.1, §2.1, §7.1); route 43 resolves the rest of the path and 404s any key with `/` or `..`. |
| 16 | **Applied.** §7.1 gets a real `<head>` with `<meta charset>` and the stylesheet; recap/admin same. |
| 17 | **Applied as "drop item (d)".** The eviction check is manual (§9.4); vitest + pool-workers for one assertion contradicts §9.1 and §1. |
| 18 | **Applied** — same fix as 2. |
| 19 | **Applied** — same fix as 3, plus §2.5j and §4.7a. The "newest ended" third fallback in `hydrate()` was **not** added: kv `sid` survives `session_end`, so it is unreachable. |
| 20 | **Applied.** Route 35 `latest` = live first, then newest ended; §10 item 4 records why. |
| 21 | **Applied, smaller.** §4.10: one kv key `lastact` + step 0 of `serialise()`. Admin sends `action_id` per press; `/c/*` coalesces an identical action within 600 ms. The reviewer's `SELECT 1 FROM events WHERE action_id=?` was **replaced** by the kv key — no query, and it also covers `undo`, which appends no row and is invisible to that query. |
| 22 | **Applied.** §2.5d's false safety claim corrected; the guard is §4.10. The separate `{expect: action_id}` protocol was **rejected** as redundant once every press carries its own `action_id`. |
| 23 | **Applied** — same fix as 9. |
| 24 | **Applied** — same fix as 4. |
| 25 | **Applied.** §4.7a specifies `hydrate()` step by step, the IDLE fallback on any D1 failure, `snapshot()`'s retry, and §7.4's `onStep` guard against a non-object `state`. |
| 26 | **Applied.** §7.1/§7.2: `removeAttribute('src')`, `#card[data-cover="none"]`, `onerror` to the same state, one CSS rule. |
| 27 | **Applied.** §2.4 states the one rule (`min(3, lapSize - 1)`, current excluded); §2.1 comment fixed; new test 34. |
| 28 | **Applied.** `authToken(token, charge)`; routes 33/34 uncharged; §8.5 sliders rewrite the iframe on `change`, debounced 250 ms; 429 added to route 35 (route 34 no longer reaches it). |
| 29 | **Applied** — same fix as 14. |
| 30 | **Applied.** §9.4 README row now pins the Stream Deck section, including the background-request option. |
| 31 | **Applied.** New §7.7: stroke floor, no hue-only encoding, direct value labels, shared `overlay.css`. |
| 32 | **Applied.** Routes 6/7 cap `name` at 80 chars; §7.1/§7.2 clamp `#title` to 2 lines at a fixed `max-width`. |
