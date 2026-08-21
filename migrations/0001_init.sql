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
