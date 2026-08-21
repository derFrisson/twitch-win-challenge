// The pure run state machine (SPEC §2). This file imports NOTHING and performs no I/O:
// no Date.now(), no crypto, no console, no mutation of any argument. Every timestamp and
// every uuid arrives as a parameter, supplied by live-run.ts (SPEC §2.6).
//
// ponytail: undo is per-ACTION, not per-row. action_id groups the rows one button press
// wrote (win + game_won + game_start) so one UNDO reverses one thing the human did.
// Ceiling: an action can never span two sessions; if it ever needs to, group by a real
// transaction id instead.

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

// One row of the compact overlay list: the whole lap, not just the active game. Ordered by
// (order_index, id). This is DISPLAY data derived from cfg.sessionGames — §2.2 still holds,
// because no counter and no cursor is read from order_index, only "what is on screen next".
export type PlaylistEntry = {
  sessionGameId: number;
  title: string;
  coverKey: string | null;
  required: 1 | 2;
  streak: number;                // wins toward `required` in THIS lap's visit; 0 if unvisited
  losses: number;                // losses in this lap's visit; 0 if unvisited
  status: 'pending' | 'active' | 'done' | 'skipped' | 'abandoned';
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
  playlist: PlaylistEntry[];     // the WHOLE lap in (order_index, id) order — the compact
                                 // overlay renders this list, so it needs every game's state,
                                 // not just the next few titles.
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

// ---------- helpers ----------

// The ONLY place order_index is read. Sorts a COPY; ties break on id because order_index is
// deliberately not unique (§3.1).
function byOrder(sessionGames: readonly SessionGameRow[]): SessionGameRow[] {
  return [...sessionGames].sort((a, b) => a.order_index - b.order_index || a.id - b.id);
}

function mk(
  session_id: number,
  session_game_id: number | null,
  lap: number,
  type: EventType,
  action_id: string,
  created_at: number,
): NewEvent {
  // ponytail: plan() never writes meta_json. The DO patches it onto the rows it appends when
  // it has something to say (e.g. {"src":"streamdeck"}); the reducer never reads it anyway.
  return { session_id, session_game_id, lap, type, action_id, created_at, meta_json: null };
}

// The advance tail (§2.3), evaluated in order. Appended after `game_won` or `skip`.
function advanceTail(
  cfg: ReduceContext,
  sessionId: number,
  currentId: number,
  lap: number,
  actionId: string,
  now: number,
): NewEvent[] {
  if (cfg.session?.stop_after_current === true) {
    return [mk(sessionId, null, lap, 'session_end', actionId, now)];
  }
  const next = nextSessionGame(cfg.sessionGames, currentId);
  if (next !== null) {
    return [mk(sessionId, next.id, lap, 'game_start', actionId, now)];
  }
  const first = cfg.session?.loop === true ? byOrder(cfg.sessionGames)[0] : undefined;
  if (first !== undefined) {
    return [mk(sessionId, first.id, lap + 1, 'game_start', actionId, now)];
  }
  return [mk(sessionId, null, lap, 'session_end', actionId, now)];
}

// ---------- the three functions ----------

// §2.3: sort a copy by (order_index, id), return the entry after `currentId`, or null if it is
// last or unknown. The result is frozen into the log as a game_start, never recomputed (§2.2).
export function nextSessionGame(
  sessionGames: readonly SessionGameRow[],
  currentId: number,
): SessionGameRow | null {
  const sorted = byOrder(sessionGames);
  const i = sorted.findIndex((g) => g.id === currentId);
  if (i < 0) return null;
  return sorted[i + 1] ?? null;
}

// §2.5d: the action_id of the most recent non-undone action, unless that action is the
// session_start action — undoing that would blank the overlay mid-stream, so it is REFUSED.
export function nextUndoTarget(events: readonly Event[]): string | null {
  const live = [...events].filter((e) => e.undone_at === null).sort((a, b) => b.seq - a.seq);
  const newest = live[0];
  if (newest === undefined) return null;
  const target = newest.action_id;
  let lowest = newest;
  for (const e of live) if (e.action_id === target && e.seq < lowest.seq) lowest = e;
  return lowest.type === 'session_start' ? null : target;
}

// §2.4: fold the log into the state on camera. Sorts a copy by seq, drops undone rows, and
// never reads order_index for anything but the display-only upNext / positionInLap (§2.2).
export function reduce(events: readonly Event[], cfg: ReduceContext): RunState {
  const sorted = byOrder(cfg.sessionGames);
  const state: RunState = {
    phase: 'idle',
    sessionId: null,
    sessionTitle: null,
    loop: false,
    stopAfterCurrent: false,
    lap: 0,
    current: null,
    displayMode: 'IDLE',
    playlist: [],
    totals: { gamesPlayed: 0, gamesWon: 0, gamesSkipped: 0, gamesAbandoned: 0, wins: 0, losses: 0, attempts: 0 },
    lastSeq: 0,
  };

  const live = [...events].filter((e) => e.undone_at === null).sort((a, b) => a.seq - b.seq);

  // Per-game outcomes for the CURRENT lap. Cleared on a lap change, so a looping session shows
  // a fresh list every lap; a same-lap revisit (§2.5f) resets that game's entry, matching
  // `current`'s per-visit semantics exactly so the list and the hero can never disagree.
  type Visit = { streak: number; losses: number; outcome: 'playing' | 'done' | 'skipped' | 'abandoned' };
  const visits = new Map<number, Visit>();
  let visitLap = -1;
  const sync = (c: CurrentGame, outcome?: Visit['outcome']): void => {
    const v = visits.get(c.sessionGameId);
    if (v === undefined) return;
    v.streak = c.streak;
    v.losses = c.losses;
    if (outcome !== undefined) v.outcome = outcome;
  };

  for (const ev of live) {
    state.lastSeq = ev.seq;
    switch (ev.type) {
      case 'session_start': {
        const s = cfg.session;
        state.phase = 'live';
        state.sessionId = s !== null ? s.id : ev.session_id;
        state.sessionTitle = s !== null ? s.title : null;
        state.loop = s !== null ? s.loop : false;
        state.stopAfterCurrent = s !== null ? s.stop_after_current : false;
        state.current = null;
        state.lap = 0;
        state.totals = { gamesPlayed: 0, gamesWon: 0, gamesSkipped: 0, gamesAbandoned: 0, wins: 0, losses: 0, attempts: 0 };
        break;
      }
      case 'game_start': {
        if (state.phase !== 'live') break;   // degrade, never throw on stream (§2.6)
        const id = ev.session_game_id ?? 0;
        const pos = sorted.findIndex((g) => g.id === id);
        const row = pos < 0 ? undefined : sorted[pos];
        const mode: Mode = row !== undefined ? row.mode : 'single';
        state.current = {
          sessionGameId: id,
          gameId: row !== undefined ? row.game_id : 0,
          title: row !== undefined ? row.title : '???',
          coverKey: row !== undefined ? row.cover_key : null,
          mode,
          required: mode === 'b2b' ? 2 : 1,
          losses: 0,
          wins: 0,
          streak: 0,
          attempts: 0,
          startedAt: ev.created_at,
          positionInLap: pos + 1,
          lapSize: sorted.length,
        };
        state.lap = ev.lap;
        state.totals.gamesPlayed += 1;
        if (ev.lap !== visitLap) {
          visits.clear();
          visitLap = ev.lap;
        }
        visits.set(id, { streak: 0, losses: 0, outcome: 'playing' });
        break;
      }
      case 'win': {
        const c = state.current;
        if (c === null) break;
        c.wins += 1;
        c.streak += 1;
        c.attempts += 1;
        state.totals.wins += 1;
        state.totals.attempts += 1;
        sync(c);
        break;
      }
      case 'loss': {
        const c = state.current;
        if (c === null) break;
        // DECIDED (prompt §3.3): losses is cumulative and is NOT reset by a broken streak.
        c.losses += 1;
        c.streak = 0;
        c.attempts += 1;
        state.totals.losses += 1;
        state.totals.attempts += 1;
        sync(c);
        break;
      }
      case 'skip': {
        const c = state.current;
        if (c === null) break;
        c.streak = 0;   // the visit is over; no streak outlives it
        state.totals.gamesSkipped += 1;
        sync(c, 'skipped');
        break;
      }
      case 'game_won': {
        if (state.current === null) break;
        // Counters stay AS-IS so the celebration renders the winning numbers. This is the one
        // emitted state where streak === required, which is why displayMode is LOSS_MODE here.
        state.totals.gamesWon += 1;
        sync(state.current, 'done');
        break;
      }
      case 'game_abandoned': {
        const c = state.current;
        if (c === null) break;
        c.streak = 0;
        state.totals.gamesAbandoned += 1;
        sync(c, 'abandoned');
        break;
      }
      case 'session_end': {
        state.phase = 'ended';
        state.current = null;
        state.lap = 0;
        break;
      }
      default: {
        // The code and the schema disagree. Failing loudly beats rendering a plausible wrong
        // number on camera — the single exception to "never throw for data reasons" (§2.6).
        const bad: never = ev.type;
        throw new Error(`run.reduce: unknown event type ${String(bad)}`);
      }
    }
  }

  const cur = state.current;
  // The whole lap, every phase. In 'idle' every row is pending (the overlay renders the coming
  // playlist before the session starts); in 'ended' `cur` is null so every row keeps its final
  // outcome, which is exactly the end-of-stream list.
  state.playlist = sorted.map((g): PlaylistEntry => {
    const v = visits.get(g.id);
    const active = cur !== null && g.id === cur.sessionGameId;
    // 'playing' on a NON-active game means the cursor left without a terminal event — treat it
    // as pending rather than inventing an outcome the log does not support.
    const status: PlaylistEntry['status'] =
      active ? 'active'
      : v === undefined || v.outcome === 'playing' ? 'pending'
      : v.outcome;
    return {
      sessionGameId: g.id,
      title: g.title,
      coverKey: g.cover_key,
      required: g.mode === 'b2b' ? 2 : 1,
      streak: active ? cur.streak : v !== undefined ? v.streak : 0,
      losses: active ? cur.losses : v !== undefined ? v.losses : 0,
      status,
    };
  });

  // Derived, never stored. `required` is part of the condition on purpose (§2.4): a streak that
  // has REACHED required is a finished game, not a running streak.
  state.displayMode =
    state.phase === 'idle' ? 'IDLE'
    : state.phase === 'ended' ? 'ENDED'
    : cur === null ? 'IDLE'                                  // between session_start and game_start
    : cur.streak > 0 && cur.streak < cur.required ? 'STREAK_MODE'
    : 'LOSS_MODE';

  return state;
}

// §2.3: what should be appended for this admin action. `now` and `actionId` are parameters —
// that is the entire impurity boundary.
export function plan(
  action: Action,
  events: readonly Event[],
  cfg: ReduceContext,
  now: number,
  actionId: string,
): Plan {
  if (action.kind === 'undo') {
    const target = nextUndoTarget(events);
    return target === null ? { ok: false, reject: 'nothing_to_undo' } : { ok: true, undoAction: target };
  }

  if (action.kind === 'start') {
    const s = cfg.session;
    if (s === null) return { ok: false, reject: 'no_live_session' };
    if (s.status !== 'draft') return { ok: false, reject: 'not_draft' };
    const first = byOrder(cfg.sessionGames)[0];
    if (first === undefined) return { ok: false, reject: 'empty_session' };
    // `already_live` is the fourth precondition in §2.3's start row. It needs R1b, a D1 read,
    // so live-run.ts raises it before calling plan(); the code lives in Plan.reject so both
    // paths map through the same §5.4 table.
    return {
      ok: true,
      append: [
        mk(s.id, null, 1, 'session_start', actionId, now),
        mk(s.id, first.id, 1, 'game_start', actionId, now),
      ],
    };
  }

  const cur = reduce(events, cfg);
  if (cur.phase === 'ended') return { ok: false, reject: 'session_ended' };
  const sg = cur.current;
  if (cur.phase !== 'live' || sg === null) return { ok: false, reject: 'no_live_session' };
  // cur.sessionId is non-null whenever phase === 'live'; the fallback only satisfies the type.
  const sid = cur.sessionId ?? (cfg.session !== null ? cfg.session.id : 0);
  const lap = cur.lap;

  if (action.kind === 'loss') {
    return { ok: true, append: [mk(sid, sg.sessionGameId, lap, 'loss', actionId, now)] };
  }

  if (action.kind === 'stop_now') {
    return {
      ok: true,
      append: [
        mk(sid, sg.sessionGameId, lap, 'game_abandoned', actionId, now),
        mk(sid, null, lap, 'session_end', actionId, now),
      ],
    };
  }

  if (action.kind === 'skip') {
    return {
      ok: true,
      append: [
        mk(sid, sg.sessionGameId, lap, 'skip', actionId, now),
        ...advanceTail(cfg, sid, sg.sessionGameId, lap, actionId, now),
      ],
    };
  }

  // win
  const win = mk(sid, sg.sessionGameId, lap, 'win', actionId, now);
  if (sg.streak + 1 < sg.required) return { ok: true, append: [win] };
  return {
    ok: true,
    append: [
      win,
      mk(sid, sg.sessionGameId, lap, 'game_won', actionId, now),
      ...advanceTail(cfg, sid, sg.sessionGameId, lap, actionId, now),
    ],
  };
}
