// The pure subathon-clock model (STREAM_TIME_FEATURE_PROMPT §2). Same contract as run.ts
// (SPEC §2.6): this file imports NOTHING and performs no I/O — no Date.now(), no crypto, no
// console, no mutation of any argument. `now` and every timestamp arrive as parameters.
//
// THE ONE RULE: the clock is DERIVED, never stored as a decrementing counter. A stored
// countdown is wrong after the first pause, crash, or redeploy. Everything here is a fold over
// the append-only event log plus config, so an OBS reload, a WS drop, a Worker redeploy and a
// full PC reboot all cost nothing.
//
// UNITS, settled: integer MILLISECONDS internally, matching SPEC §3.0.1 and every timestamp
// already in D1. Integer cents for money. Seconds and H:MM:SS exist only in the two formatters
// at the bottom. No float survives past the GoFundMe response boundary (§3.1), which is the
// only place one is allowed to exist at all.

const MS_PER_HOUR = 3_600_000;

// ---------- stored rows ----------

// Six types, not the four the prompt first named. `timer_pause`/`timer_resume` are the MANUAL
// latch and `timer_pause_auto`/`timer_resume_auto` are the Twitch-offline latch, because §5
// requires them to be independent: a manual pause is sticky and an auto-resume must never clear
// it. Encoding that in the type keeps the CHECK constraint the enforcement point and keeps
// meta_json unread by a reducer, exactly as `events` already promises for run.ts.
export type TimerEventType =
  | 'timer_start'
  | 'timer_pause'         // manual latch on  — sticky, only a human clears it
  | 'timer_resume'        // manual latch off
  | 'timer_pause_auto'    // Twitch offline debounce latch on
  | 'timer_resume_auto'   // Twitch live again
  | 'timer_end';

export type TimerEvent = {
  seq: number;            // D1 AUTOINCREMENT; the ONLY ordering authority, as for run events
  type: TimerEventType;
  created_at: number;     // epoch ms
  undone_at: number | null;  // non-null => this fold ignores the row, same as run.ts
};

// ---------- inputs that are not events ----------

/** Per-session config (§4). `capMs` is a REQUIRED feature: €5,000 at €10/h is 500 hours. */
export type TimerConfig = {
  baseMs: number;         // e.g. 12h = 43_200_000
  centsPerHour: number;   // e.g. 1000 = €10/h
  capMs: number;          // hard ceiling on earned time
};

/**
 * Money, already reduced to three integers by the caller (§4.1/§4.2), because deciding what is
 * eligible needs the donations table and the exclusion flags — I/O this file must not do.
 *   eligibleCents   = total - Σ(excluded donations) - manual_exclusion   (§4.1)
 *   adjustmentCents = signed sum of the off-platform ledger entries      (§4.2)
 *   adjustmentMs    = signed sum of the direct time entries, i.e. "+1 Stunde"
 */
export type TimerMoney = {
  eligibleCents: number;
  adjustmentCents: number;
  adjustmentMs: number;
};

// ---------- computed state ----------

export type TimerPhase = 'idle' | 'running' | 'paused' | 'ended';

export type TimerState = {
  phase: TimerPhase;
  manualPaused: boolean;      // §5: admin shows WHICH pause is active, so both are exposed
  autoPaused: boolean;
  earnedMs: number;           // base + money + adjustments, clamped by the cap
  consumedMs: number;         // Σ RUNNING intervals
  remainingMs: number;        // earned - consumed, clamped at 0
  endsAt: number | null;      // epoch ms; NULL unless running — see the note in computeTimer()
  endsAtLabel: string | null; // pre-formatted Europe/Berlin string; NULL whenever endsAt is
  capped: boolean;            // earned would have exceeded the cap
  startedAt: number | null;
  endedAt: number | null;
  pausedTotalMs: number;      // §5 recap: "geschlafen: 6h 12m"
};

// ---------- the fold ----------

export type Intervals = {
  startedAt: number | null;
  endedAt: number | null;
  manualPaused: boolean;
  autoPaused: boolean;
  consumedMs: number;
  pausedTotalMs: number;
};

/**
 * Fold the running intervals out of the log. Events must arrive in `seq` order; undone rows are
 * skipped exactly as run.ts skips them, which is what makes undo work without any compensating
 * arithmetic.
 *
 * The whole fold is one transition test — "was it running before this event, is it running
 * after" — rather than per-event-type interval bookkeeping. That is what makes a redundant
 * pause (pausing something already paused, or a Twitch blip landing on top of a manual pause)
 * a no-op for free instead of a double-count.
 */
export function foldIntervals(events: readonly TimerEvent[], now: number): Intervals {
  let startedAt: number | null = null;
  let endedAt: number | null = null;
  let manualPaused = false;
  let autoPaused = false;
  let consumedMs = 0;
  let runningSince: number | null = null;

  const running = () => startedAt !== null && endedAt === null && !manualPaused && !autoPaused;

  for (const e of events) {
    if (e.undone_at !== null) continue;
    const before = running();

    switch (e.type) {
      // Guarded: one timer per session. A second start is not a restart, it is a duplicate.
      case 'timer_start': if (startedAt === null) startedAt = e.created_at; break;
      case 'timer_end': if (endedAt === null) endedAt = e.created_at; break;
      case 'timer_pause': manualPaused = true; break;
      case 'timer_resume': manualPaused = false; break;
      case 'timer_pause_auto': autoPaused = true; break;
      case 'timer_resume_auto': autoPaused = false; break;
    }

    const after = running();
    if (before && !after) {
      consumedMs += e.created_at - (runningSince as number);
      runningSince = null;
    } else if (!before && after) {
      runningSince = e.created_at;
    }
  }

  // Still running: the open interval runs to `now`. This is the line that makes the clock
  // derived rather than stored — nothing ticked, the answer is just recomputed.
  if (runningSince !== null) consumedMs += now - runningSince;

  // ponytail: paused time is elapsed-minus-consumed, not its own accumulator. Exact by
  // construction, and it cannot drift out of agreement with consumedMs the way a second
  // running total would. Covers "paused before the clock ever started" for free.
  const pausedTotalMs =
    startedAt === null ? 0 : Math.max(0, (endedAt ?? now) - startedAt - consumedMs);

  return { startedAt, endedAt, manualPaused, autoPaused, consumedMs, pausedTotalMs };
}

// ---------- the arithmetic ----------

/**
 * earned = min( base + money + adjustments , cap )
 *
 * MULTIPLY BEFORE YOU DIVIDE. In integer arithmetic `(cents / centsPerHour) * MS_PER_HOUR`
 * truncates the quotient first and throws away every fractional hour: 999 cents at 1000/h
 * would earn 0 instead of 59m56.4s, and the §2 worked example of €25 at €10/h would give
 * 7_200_000 ms instead of 9_000_000. test_timer.ts pins both.
 *
 * Range: a €50,000 campaign is 5e6 cents; 5e6 * 3.6e6 = 1.8e13, three orders of magnitude
 * under Number.MAX_SAFE_INTEGER. No BigInt needed.
 */
export function earnedMs(cfg: TimerConfig, money: TimerMoney): { earnedMs: number; capped: boolean } {
  // A negative pool is not a thing; a negative TIME correction is (§4.2), so only the cents
  // side is clamped here and adjustmentMs stays signed.
  const cents = Math.max(0, money.eligibleCents + money.adjustmentCents);
  const fromMoney = cfg.centsPerHour > 0 ? Math.floor((cents * MS_PER_HOUR) / cfg.centsPerHour) : 0;

  const uncapped = cfg.baseMs + fromMoney + money.adjustmentMs;
  // ponytail: a cap of <= 0 reads as "unset", never as "zero hours of stream". Getting that
  // backwards would silently end the stream from an empty admin field. Real validation belongs
  // at the admin trust boundary; this is the fail-safe direction to pick here.
  const cap = cfg.capMs > 0 ? cfg.capMs : Number.MAX_SAFE_INTEGER;

  return { earnedMs: Math.max(0, Math.min(uncapped, cap)), capped: uncapped > cap };
}

/** The whole model, composed. Everything in TimerState is derived from these four arguments. */
export function computeTimer(
  events: readonly TimerEvent[],
  cfg: TimerConfig,
  money: TimerMoney,
  now: number,
): TimerState {
  const iv = foldIntervals(events, now);
  const { earnedMs: earned, capped } = earnedMs(cfg, money);
  const remainingMs = Math.max(0, earned - iv.consumedMs);

  const phase: TimerPhase =
    iv.startedAt === null ? 'idle'
    : iv.endedAt !== null ? 'ended'
    : iv.manualPaused || iv.autoPaused ? 'paused'
    : 'running';

  // NULL unless running, deliberately. §6.1: while paused the overlay must read as frozen and
  // never as a live wall-clock time — a paused clock has no end time, and shipping a stale one
  // puts a wrong number on camera for hours. While running it is stable (it only moves when
  // earned or the pause state changes), so the label can be formatted once here on the server
  // instead of being recomputed by the overlay every second.
  const endsAt = phase === 'running' ? now + remainingMs : null;

  return {
    phase,
    manualPaused: iv.manualPaused,
    autoPaused: iv.autoPaused,
    earnedMs: earned,
    consumedMs: iv.consumedMs,
    remainingMs,
    endsAt,
    endsAtLabel: endsAt === null ? null : formatBerlinEnd(endsAt),
    capped,
    startedAt: iv.startedAt,
    endedAt: iv.endedAt,
    pausedTotalMs: iv.pausedTotalMs,
  };
}

// ---------- formatting (the ONLY place seconds and local time exist) ----------

/** H:MM:SS. Hours are not zero-padded and are not capped at 24 — a 39-hour clock reads "39:30:00". */
export function formatHMS(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// Module scope so the ICU lookup happens once, not once per broadcast. Constructing this is the
// expensive half of Intl; formatting is cheap.
const BERLIN_END = new Intl.DateTimeFormat('de-DE', {
  timeZone: 'Europe/Berlin',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/**
 * "Do., 14:32" in Europe/Berlin.
 *
 * THIS is the DST hazard, and it is the only one. Epoch-ms arithmetic is DST-free by
 * construction, so a test asserting that integers add up across the October transition tests
 * nothing — the bug can only appear here, when an instant becomes a local wall-clock string.
 * A 39-hour clock crosses the transition, and a naive local-time calculation ("started 01:00, +4h, so
 * 05:00") is wrong by exactly one hour on that night. test_timer.ts pins the rendered string.
 */
export function formatBerlinEnd(epochMs: number): string {
  return BERLIN_END.format(new Date(epochMs));
}
