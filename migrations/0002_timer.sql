-- 0002_timer.sql — the subathon clock. Timestamps are epoch milliseconds (SPEC 3.0.1), money is
-- integer cents, durations are integer milliseconds. No float is storable anywhere in here.
--
-- This migration is PURELY ADDITIVE. It does not touch `events`, `sessions`, `session_games` or
-- `games`, and it deliberately does not extend `events.type`: the clock is a SEPARATE TOOL from
-- the win-challenge, so it gets its own log rather than a rebuild of the log every other part of
-- the app reads. Two consequences that are features, not compromises:
--   * the clock outlives a playlist finishing — `timer_end` is independent of `session_end`
--   * UNDO stays unambiguous. The live UNDO button rewinds a mis-clicked WIN/LOSS and nothing
--     else; clock entries are undone per-row from the adjustments ledger.

PRAGMA foreign_keys = ON;

-- One subathon. Config lives HERE and not in a global settings row, so changing the rate for the
-- next stream never rewrites the arithmetic of the last one.
CREATE TABLE timer_runs (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  title                  TEXT    NOT NULL,                       -- admin + recap label
  status                 TEXT    NOT NULL DEFAULT 'draft'
                         CHECK (status IN ('draft','live','ended')),

  -- §2 config. Every one of these is editable mid-run from /admin/timer/ (§4); nothing here is
  -- ever hardcoded in the Worker.
  base_ms                INTEGER NOT NULL CHECK (base_ms >= 0),  -- e.g. 12h = 43200000
  cents_per_hour         INTEGER NOT NULL CHECK (cents_per_hour > 0),   -- e.g. 1000 = 10 EUR/h
  -- Required (§4): 5000 EUR at 10 EUR/h is 500 hours, and the cap is what stops that. Enforced
  -- > 0 here so the boundary owns the rule; timer.ts's "<= 0 means unset" branch is defence in
  -- depth for a value that can never reach it from this table.
  cap_ms                 INTEGER NOT NULL CHECK (cap_ms > 0),
  manual_exclusion_cents INTEGER NOT NULL DEFAULT 0 CHECK (manual_exclusion_cents >= 0),
  poll_interval_ms       INTEGER NOT NULL DEFAULT 15000 CHECK (poll_interval_ms >= 5000),

  -- §5 auto-pause. OFF by default: the Twitch credentials it shares with IGDB do not exist yet,
  -- so this path ships unverified and must be switched on deliberately.
  auto_pause             INTEGER NOT NULL DEFAULT 0 CHECK (auto_pause IN (0,1)),
  auto_pause_after       INTEGER NOT NULL DEFAULT 3 CHECK (auto_pause_after >= 1), -- consecutive offline polls
  twitch_login           TEXT,                                   -- NULL until auto-pause is configured

  started_at             INTEGER,                                 -- epoch ms of timer_start; NULL while draft
  ended_at               INTEGER,                                 -- epoch ms of timer_end; NULL until ended
  created_at             INTEGER NOT NULL
) STRICT;

-- AT MOST ONE LIVE RUN, enforced by the database — the same partial-unique-index singleton trick
-- `sessions_one_live` uses, for the same reason.
CREATE UNIQUE INDEX timer_runs_one_live ON timer_runs (status) WHERE status = 'live';
CREATE INDEX timer_runs_created ON timer_runs (created_at DESC);

-- THE CLOCK'S LOG. Append-only. Only `undone_at` is ever UPDATEd, nothing is ever DELETEd —
-- identical discipline to `events`, scoped to the clock. consumed_ms is a fold over these rows
-- (src/timer.ts), never a stored counter.
CREATE TABLE timer_events (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,                  -- the ONLY ordering authority
  run_id     INTEGER NOT NULL REFERENCES timer_runs(id) ON DELETE CASCADE,
  -- Six types, not four. The manual and the auto pause are INDEPENDENT latches so that a manual
  -- pause is sticky and an auto-resume can never clear it (§5). Encoding that here rather than
  -- in meta_json makes this CHECK the enforcement point and keeps meta_json unread by the fold.
  -- This list must stay byte-identical to TimerEventType in src/timer.ts.
  type       TEXT    NOT NULL
             CHECK (type IN ('timer_start','timer_pause','timer_resume',
                             'timer_pause_auto','timer_resume_auto','timer_end')),
  action_id  TEXT    NOT NULL,                                    -- uuid v4; one action = one undo step
  created_at INTEGER NOT NULL,                                    -- epoch ms; the fold's only time input
  undone_at  INTEGER,                                             -- non-NULL => the fold ignores this row
  meta_json  TEXT                                                 -- never read by the fold
) STRICT;

CREATE INDEX timer_events_run_seq ON timer_events (run_id, seq);  -- the fold's read
CREATE INDEX timer_events_action ON timer_events (action_id);     -- undo one action

-- A GoFundMe campaign. GLOBAL, not per run: the same campaign can feed a second subathon, and
-- the donor exclusions (§4.1) must not have to be re-set every time it does.
CREATE TABLE campaigns (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  slug                 TEXT    NOT NULL,                          -- from gofundme.com/f/<slug>; never hardcoded
  fund_name            TEXT,                                      -- cached from the API, display only
  currency             TEXT,                                      -- ISO code as reported; mixing is refused in code
  last_poll_at         INTEGER,                                   -- epoch ms
  last_total_cents     INTEGER,                                   -- §3.4: never allowed to move the clock backwards
  health               TEXT    NOT NULL DEFAULT 'unknown'
                       CHECK (health IN ('unknown','ok','degraded','failed')),
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  created_at           INTEGER NOT NULL
) STRICT;

CREATE UNIQUE INDEX campaigns_slug ON campaigns (slug);

-- Which campaigns feed which run (§4: "Multiple campaigns allowed; totals sum").
CREATE TABLE run_campaigns (
  run_id      INTEGER NOT NULL REFERENCES timer_runs(id) ON DELETE CASCADE,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE RESTRICT,  -- a campaign in use cannot vanish
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (run_id, campaign_id)
) STRICT;

CREATE INDEX run_campaigns_campaign ON run_campaigns (campaign_id);  -- "is this campaign used anywhere?"

-- Individual donations. The GoFundMe id is the PRIMARY KEY, which makes dedup (§3.4) a property
-- of the schema rather than of poller bookkeeping: INSERT OR IGNORE cannot double-count.
CREATE TABLE donations (
  gofundme_id        TEXT    PRIMARY KEY,                         -- stable id from the API; TEXT, not INTEGER,
                                                                  -- because it is an opaque foreign identifier
  campaign_id        INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  donor_name         TEXT,                                        -- may be absent/anonymous
  amount_cents       INTEGER NOT NULL CHECK (amount_cents >= 0),  -- converted at the API boundary (§3.1)
  currency           TEXT    NOT NULL,
  created_at         INTEGER NOT NULL,                            -- GoFundMe's own createdAt, epoch ms
  first_seen_at      INTEGER NOT NULL,                            -- when OUR poller first saw it; drives alerts
  -- §4.1: the streamer's own money counts for the cause but buys him no stream time. Keyed by
  -- donation id, so it is auditable and survives him donating again.
  excluded_from_time INTEGER NOT NULL DEFAULT 0 CHECK (excluded_from_time IN (0,1))
) STRICT;

CREATE INDEX donations_campaign_created ON donations (campaign_id, created_at);  -- timeline + eligible sum
CREATE INDEX donations_first_seen ON donations (first_seen_at);                  -- "what is new since?"

-- §4.2. Everything that is not a GoFundMe donation: the "+1 Stunde" button, bank transfers, cash,
-- subs/bits if counted, and corrections. Signed money OR signed time, never a rewrite of history.
CREATE TABLE adjustments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id     INTEGER NOT NULL REFERENCES timer_runs(id) ON DELETE CASCADE,
  cents      INTEGER NOT NULL DEFAULT 0,                          -- signed; off-platform money
  ms         INTEGER NOT NULL DEFAULT 0,                          -- signed; direct time ("+1 Stunde" = 3600000)
  note       TEXT    NOT NULL,                                    -- why; shown in the ledger and the recap
  author     TEXT    NOT NULL,                                    -- the Access identity that added it
  created_at INTEGER NOT NULL,
  undone_at  INTEGER,                                             -- undoable per row, like every other log here
  -- An entry that moves neither money nor time is a bug, not a note.
  CHECK (cents <> 0 OR ms <> 0)
) STRICT;

CREATE INDEX adjustments_run ON adjustments (run_id, created_at);
