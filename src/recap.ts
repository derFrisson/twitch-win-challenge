// The recap SQL constants + JSON/CSV serialisers (SPEC §3.4, export routes §5.2). This file
// does no I/O and holds no D1 binding: callers (live-run.ts / index.ts) run these strings
// through `env.DB.batch([...])` and pass the raw `.results` rows in here to be shaped for the
// wire. Every absolute timestamp that crosses this boundary is rendered ISO-8601 via
// `new Date(ms).toISOString()` (SPEC §3.0.1); every *_ms duration stays an integer, unchanged.
//
// Batch order for `buildRecap()`: Q_OUTCOMES, Q_ATTEMPTS, Q_WORST_GAME, Q_FASTEST_WIN,
// Q_SESSION_TIME, Q_PER_LAP, Q_PER_GAME, Q_PER_ROUND — one env.DB.batch() call, in that order
// or any order, as long as the results are threaded into the matching RecapRawRows field.
// Q_EVENTS is separate: it feeds `serialiseEventsJson()` / `eventsToCsv()` for the export
// routes only (#29, #30) — it is never part of the `recap` object itself (#28, #35).

import type { Mode } from './run.ts';

// ============ the shared prelude, textually prefixed to every Q_* query below that needs it
// (SPEC §3.4). Q_EVENTS is the one exception — it is a standalone query over `events` and must
// see undone rows too, which the `live` CTE here deliberately filters out. ============
const PRELUDE = `WITH live AS (
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
)`;

// ============ Q_OUTCOMES : games played / won / lost / skipped ============
export const Q_OUTCOMES = `${PRELUDE}
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
  FROM outcome;`;

// ============ Q_ATTEMPTS : total attempts, wins, losses ============
export const Q_ATTEMPTS = `${PRELUDE}
SELECT SUM(type = 'win')  AS wins,
       SUM(type = 'loss') AS losses,
       SUM(type IN ('win','loss')) AS attempts     -- SPEC 2.5i, over the whole session
  FROM round;`;

// ============ Q_WORST_GAME : worst game by losses ============
export const Q_WORST_GAME = `${PRELUDE}
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
 LIMIT 1;`;

// ============ Q_FASTEST_WIN : fastest completed game (game_start -> game_won) ============
export const Q_FASTEST_WIN = `${PRELUDE}
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
 LIMIT 1;`;

// ============ Q_SESSION_TIME : total session time ============
// Works for a still-live session too: falls back to the newest event instead of ended_at.
export const Q_SESSION_TIME = `${PRELUDE}
SELECT s.title,
       s.loop,
       s.status,
       COALESCE(s.started_at, (SELECT MIN(created_at) FROM live))  AS started_at,
       COALESCE(s.ended_at,   (SELECT MAX(created_at) FROM live))  AS ended_at,
       COALESCE(s.ended_at,   (SELECT MAX(created_at) FROM live))
       - COALESCE(s.started_at, (SELECT MIN(created_at) FROM live)) AS total_ms
  FROM sessions s WHERE s.id = ?1;`;

// ============ Q_PER_LAP : per-lap breakdown ============
// LEFT JOIN, driven from `visit`: a visit with no rounds yet (the game currently on screen) is
// still one played game here, exactly as Q_OUTCOMES counts it. Driving this off `round` made
// the recap card show three different numbers for "Gespielt" in one graphic.
export const Q_PER_LAP = `${PRELUDE}
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
 ORDER BY v.lap;`;

// ============ Q_PER_GAME : time per game + per-game detail (the recap table + charts) ============
export const Q_PER_GAME = `${PRELUDE}
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
       -- outcome is NULL for an incomplete visit; the serialiser maps NULL -> 'incomplete'.
       -- MAX() over the three literals is safe because 'won' > 'skipped' > 'abandoned' can
       -- never co-occur inside one visit (each is terminal, followed by game_start/session_end).
       MAX(CASE r.type WHEN 'game_won' THEN 'won'
                       WHEN 'skip' THEN 'skipped'
                       WHEN 'game_abandoned' THEN 'abandoned' END) AS outcome
  FROM visit v
  LEFT JOIN round r      ON r.start_seq = v.start_seq
  JOIN session_games sg  ON sg.id = v.session_game_id
  JOIN games         g   ON g.id  = sg.game_id
 GROUP BY v.start_seq
 ORDER BY v.lap, v.started_at;`;

// ============ Q_PER_ROUND : time per round (feeds the round-duration chart) ============
export const Q_PER_ROUND = `${PRELUDE}
SELECT r.session_game_id, r.lap, r.seq, r.type,
       r.created_at - COALESCE(
         LAG(r.created_at) OVER (PARTITION BY r.start_seq ORDER BY r.seq),
         r.started_at
       ) AS round_ms
  FROM round r
 WHERE r.type IN ('win','loss')
 ORDER BY r.seq;`;

// ============ Q_EVENTS : the raw log, for the JSON/CSV export (undone rows INCLUDED) ============
export const Q_EVENTS = `SELECT e.seq, e.action_id, e.type, e.lap, e.session_game_id,
       e.created_at, e.undone_at, e.meta_json,
       g.name AS game_title, COALESCE(sg.mode, g.default_mode) AS mode
  FROM events e
  LEFT JOIN session_games sg ON sg.id = e.session_game_id
  LEFT JOIN games         g  ON g.id  = sg.game_id
 WHERE e.session_id = ?1
 ORDER BY e.seq;`;

// ---------- raw row shapes, one per Q_* above (D1 column names, epoch-ms, un-serialised) ----------

export type OutcomesRow = {
  games_played: number;
  games_won: number | null;
  games_skipped: number | null;
  games_abandoned: number | null;
  games_incomplete: number | null;
  games_lost: number | null;
};

export type AttemptsRow = {
  wins: number | null;
  losses: number | null;
  attempts: number | null;
};

export type WorstGameRow = {
  title: string;
  cover_key: string | null;
  session_game_id: number;
  losses: number;
  laps_involved: number;
};

export type FastestWinRow = {
  title: string;
  cover_key: string | null;
  lap: number;
  ms: number;
  attempts: number;
};

export type SessionTimeRow = {
  title: string;
  loop: number;          // raw D1 INTEGER 0/1, not the app-level boolean
  status: string;
  started_at: number;
  ended_at: number;
  total_ms: number;
};

export type PerLapRow = {
  lap: number;
  wins: number;
  losses: number;
  attempts: number;
  games_won: number;
  games_skipped: number;
  games_abandoned: number;
  games_played: number;
  lap_started_at: number;
  lap_ended_at: number;
  lap_ms: number;
};

export type VisitOutcome = 'won' | 'skipped' | 'abandoned' | 'incomplete';

export type PerGameRow = {
  session_game_id: number;
  lap: number;
  title: string;
  cover_key: string | null;
  mode: Mode;
  wins: number;
  losses: number;
  attempts: number;
  game_ms: number;
  started_at: number;
  outcome: 'won' | 'skipped' | 'abandoned' | null;   // NULL = incomplete; buildRecap() maps it
};

export type PerRoundRow = {
  session_game_id: number;
  lap: number;
  seq: number;
  type: 'win' | 'loss';
  round_ms: number;
};

export type EventExportRow = {
  seq: number;
  action_id: string;
  type: string;
  lap: number;
  session_game_id: number | null;
  created_at: number;
  undone_at: number | null;
  meta_json: string | null;
  game_title: string | null;
  mode: Mode | null;
};

// ---------- serialised (wire) shapes: absolute timestamps as ISO-8601, per SPEC 3.0.1 ----------

export type SessionTimeJson = Omit<SessionTimeRow, 'started_at' | 'ended_at'> & {
  started_at: string;
  ended_at: string;
};

export type PerLapJson = Omit<PerLapRow, 'lap_started_at' | 'lap_ended_at'> & {
  lap_started_at: string;
  lap_ended_at: string;
};

export type PerGameJson = Omit<PerGameRow, 'started_at' | 'outcome'> & {
  started_at: string;
  outcome: VisitOutcome;
};

export type EventExportJson = Omit<EventExportRow, 'created_at' | 'undone_at'> & {
  created_at: string;
  undone_at: string | null;
};

export type Recap = {
  outcomes: OutcomesRow;
  attempts: AttemptsRow;
  worstGame: WorstGameRow | null;
  fastestWin: FastestWinRow | null;
  sessionTime: SessionTimeJson;
  perLap: PerLapJson[];
  perGame: PerGameJson[];
  perRound: PerRoundRow[];
};

// The 8 raw `.results` arrays from one `env.DB.batch([...])` run of Q_OUTCOMES..Q_PER_ROUND
// (SPEC 3.4: "run them as one env.DB.batch([...]) so the recap is a single round trip").
export type RecapRawRows = {
  outcomes: readonly OutcomesRow[];
  attempts: readonly AttemptsRow[];
  worstGame: readonly WorstGameRow[];
  fastestWin: readonly FastestWinRow[];
  sessionTime: readonly SessionTimeRow[];
  perLap: readonly PerLapRow[];
  perGame: readonly PerGameRow[];
  perRound: readonly PerRoundRow[];
};

// Assembles route #28 / #35's "full recap object" from the 8 raw result sets, converting every
// absolute timestamp to ISO-8601 and mapping Q_PER_GAME's NULL outcome to 'incomplete' (both per
// SPEC 3.4's inline notes). Durations (*_ms) are passed through unchanged — they are deltas, not
// timestamps (SPEC 3.0.1).
export function buildRecap(rows: RecapRawRows): Recap {
  const outcomes = rows.outcomes[0];
  const attempts = rows.attempts[0];
  const sessionTime = rows.sessionTime[0];
  if (!outcomes || !attempts || !sessionTime) {
    // ponytail: Q_OUTCOMES/Q_ATTEMPTS/Q_SESSION_TIME are plain aggregates (no GROUP BY) plus a
    // WHERE id=?1 lookup — they always return exactly one row once a session has been started
    // (SPEC 2.3: `start` appends session_start+game_start before any recap route is reachable).
    // This guards `noUncheckedIndexedAccess`, not a real runtime path.
    throw new Error('recap query returned no row for a session that should have one');
  }
  return {
    outcomes,
    attempts,
    worstGame: rows.worstGame[0] ?? null,
    fastestWin: rows.fastestWin[0] ?? null,
    sessionTime: {
      ...sessionTime,
      started_at: new Date(sessionTime.started_at).toISOString(),
      ended_at: new Date(sessionTime.ended_at).toISOString(),
    },
    perLap: rows.perLap.map((l) => ({
      ...l,
      lap_started_at: new Date(l.lap_started_at).toISOString(),
      lap_ended_at: new Date(l.lap_ended_at).toISOString(),
    })),
    perGame: rows.perGame.map((g) => ({
      ...g,
      started_at: new Date(g.started_at).toISOString(),
      outcome: g.outcome ?? 'incomplete',
    })),
    perRound: [...rows.perRound],
  };
}

// Q_EVENTS rows for export.json's `events` field: same keys, created_at/undone_at as ISO strings.
export function serialiseEventsJson(rows: readonly EventExportRow[]): EventExportJson[] {
  return rows.map((r) => ({
    ...r,
    created_at: new Date(r.created_at).toISOString(),
    undone_at: r.undone_at === null ? null : new Date(r.undone_at).toISOString(),
  }));
}

const EVENTS_CSV_HEADER =
  'seq,action_id,type,lap,session_game_id,game_title,mode,created_at_iso,undone_at_iso,meta_json';

// RFC-4180 field quoting: wrap in double quotes and double any internal quote if the field
// contains a comma, a quote, or a newline.
function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

// export.csv body (route #30): UTF-8 BOM (Excel), \r\n line endings, header row per SPEC 3.4,
// one Q_EVENTS row per line, timestamps as new Date(ms).toISOString().
export function eventsToCsv(rows: readonly EventExportRow[]): string {
  const lines = rows.map((r) =>
    [
      String(r.seq),
      r.action_id,
      r.type,
      String(r.lap),
      r.session_game_id === null ? '' : String(r.session_game_id),
      r.game_title ?? '',
      r.mode ?? '',
      new Date(r.created_at).toISOString(),
      r.undone_at === null ? '' : new Date(r.undone_at).toISOString(),
      r.meta_json ?? '',
    ]
      .map(csvField)
      .join(','),
  );
  return '\uFEFF' + [EVENTS_CSV_HEADER, ...lines].join('\r\n');
}
