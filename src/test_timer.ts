// Assertions for the derived subathon clock (STREAM_TIME_FEATURE_PROMPT §2, §9.A).
//
//   node --experimental-strip-types --test src/test_timer.ts
//
// No framework, no fixtures, no mocks — same discipline as test_run.ts. Every `now` and every
// timestamp is a literal, because timer.ts is pure and there is nothing to stub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { computeTimer, earnedMs, foldIntervals, formatBerlinEnd, formatHMS } from './timer.ts';
import type { TimerConfig, TimerEvent, TimerEventType, TimerMoney } from './timer.ts';

const H = 3_600_000;
const M = 60_000;
const T0 = 1_760_000_000_000;   // an arbitrary epoch-ms anchor, as in test_run.ts

let n = 0;
const ev = (type: TimerEventType, at: number, undone = false): TimerEvent => {
  n += 1;
  return { seq: n, type, created_at: at, undone_at: undone ? at + 1 : null };
};
const log = (...events: TimerEvent[]) => { const l = events; return l; };
const reset = () => { n = 0; };

const CFG: TimerConfig = { baseMs: 12 * H, centsPerHour: 1000, capMs: 48 * H };
const NO_MONEY: TimerMoney = { eligibleCents: 0, adjustmentCents: 0, adjustmentMs: 0 };
const money = (p: Partial<TimerMoney>): TimerMoney => ({ ...NO_MONEY, ...p });

// ============================ the arithmetic ============================

test('worked_example_25_euro_at_10_per_hour_is_exactly_9_000_000_ms', () => {
  // §2.2's own worked example. Divide-first returns 7_200_000 and fails here.
  const r = earnedMs({ baseMs: 0, centsPerHour: 1000, capMs: 1000 * H }, money({ eligibleCents: 2500 }));
  assert.equal(r.earnedMs, 9_000_000);
  assert.equal(r.capped, false);
});

test('multiply_before_divide_keeps_sub_hour_donations', () => {
  // The case that makes divide-first catastrophic rather than merely wrong: 999 cents at
  // 1000 cents/h is 59m56.4s of stream, and `(999/1000)*3.6e6` is zero.
  const r = earnedMs({ baseMs: 0, centsPerHour: 1000, capMs: 1000 * H }, money({ eligibleCents: 999 }));
  assert.equal(r.earnedMs, 3_596_400);
  assert.notEqual(r.earnedMs, 0);
});

test('fractional_hours_need_no_carry_forward_ledger', () => {
  // Three €0.01 donations arriving separately must equal one €0.03 donation. They do, because
  // the pool is summed in cents and converted ONCE — there is no per-donation rounding step.
  const one = earnedMs({ baseMs: 0, centsPerHour: 1000, capMs: 1000 * H }, money({ eligibleCents: 3 }));
  assert.equal(one.earnedMs, 10_800);
});

test('cap_clamps_earned_and_reports_capped', () => {
  // €5,000 at €10/h is 500 hours; the cap is what stops that (§4).
  const r = earnedMs(CFG, money({ eligibleCents: 500_000 }));
  assert.equal(r.earnedMs, 48 * H);
  assert.equal(r.capped, true);
});

test('cap_of_zero_reads_as_unset_not_as_zero_hours', () => {
  const r = earnedMs({ baseMs: 12 * H, centsPerHour: 1000, capMs: 0 }, NO_MONEY);
  assert.equal(r.earnedMs, 12 * H);
  assert.equal(r.capped, false);
});

test('negative_pool_is_clamped_but_negative_time_correction_is_allowed', () => {
  const pool = earnedMs(CFG, money({ eligibleCents: 100, adjustmentCents: -9999 }));
  assert.equal(pool.earnedMs, 12 * H);                       // cents floor at 0, base survives
  const corr = earnedMs(CFG, money({ adjustmentMs: -2 * H }));
  assert.equal(corr.earnedMs, 10 * H);                        // §4.2 corrections may subtract
});

test('plus_one_hour_button_is_a_direct_time_adjustment', () => {
  const r = earnedMs(CFG, money({ adjustmentMs: H }));
  assert.equal(r.earnedMs, 13 * H);
});

// ============================ the fold ============================

test('idle_before_any_start', () => {
  reset();
  const s = computeTimer([], CFG, NO_MONEY, T0);
  assert.equal(s.phase, 'idle');
  assert.equal(s.consumedMs, 0);
  assert.equal(s.endsAt, null);
  assert.equal(s.endsAtLabel, null);
  assert.equal(s.pausedTotalMs, 0);
});

test('running_interval_accrues_to_now', () => {
  reset();
  const s = computeTimer(log(ev('timer_start', T0)), CFG, NO_MONEY, T0 + 3 * H);
  assert.equal(s.phase, 'running');
  assert.equal(s.consumedMs, 3 * H);
  assert.equal(s.remainingMs, 9 * H);
  assert.equal(s.endsAt, T0 + 3 * H + 9 * H);
});

test('pause_stops_accumulating_consumed', () => {
  reset();
  const l = log(ev('timer_start', T0), ev('timer_pause', T0 + 2 * H));
  // Ten hours of wall clock pass while paused; consumed must still be 2h.
  const s = computeTimer(l, CFG, NO_MONEY, T0 + 12 * H);
  assert.equal(s.phase, 'paused');
  assert.equal(s.consumedMs, 2 * H);
  assert.equal(s.remainingMs, 10 * H);
  assert.equal(s.pausedTotalMs, 10 * H);
});

test('paused_clock_has_no_end_time', () => {
  reset();
  const l = log(ev('timer_start', T0), ev('timer_pause', T0 + H));
  const s = computeTimer(l, CFG, NO_MONEY, T0 + 5 * H);
  // §6.1: a frozen clock must never render a live wall-clock end time on camera.
  assert.equal(s.endsAt, null);
  assert.equal(s.endsAtLabel, null);
});

test('DERIVED_donation_while_paused_raises_remaining_after_resume', () => {
  // The §9.A headline test: pause, money arrives while paused, resume, assert the clock.
  reset();
  const l = log(ev('timer_start', T0), ev('timer_pause', T0 + 2 * H), ev('timer_resume', T0 + 8 * H));
  const donated = money({ eligibleCents: 2500 });   // €25 at €10/h = 2.5h
  const s = computeTimer(l, CFG, donated, T0 + 9 * H);

  assert.equal(s.phase, 'running');
  assert.equal(s.consumedMs, 3 * H);                 // 2h before the pause + 1h after resume
  assert.equal(s.earnedMs, 12 * H + 9_000_000);
  assert.equal(s.remainingMs, 9 * H + 9_000_000);
  assert.equal(s.pausedTotalMs, 6 * H);
});

test('redundant_pause_does_not_double_count', () => {
  reset();
  const l = log(ev('timer_start', T0), ev('timer_pause', T0 + H), ev('timer_pause', T0 + 2 * H));
  const s = computeTimer(l, CFG, NO_MONEY, T0 + 5 * H);
  assert.equal(s.consumedMs, H);
});

test('MANUAL_PAUSE_IS_STICKY_auto_resume_does_not_clear_it', () => {
  // §5: auto-pause and manual pause are independent latches; only a human clears a manual one.
  reset();
  const l = log(
    ev('timer_start', T0),
    ev('timer_pause', T0 + H),            // human pauses
    ev('timer_pause_auto', T0 + 2 * H),   // Twitch also goes offline
    ev('timer_resume_auto', T0 + 3 * H),  // Twitch comes back — must NOT resume the clock
  );
  const s = computeTimer(l, CFG, NO_MONEY, T0 + 6 * H);
  assert.equal(s.phase, 'paused');
  assert.equal(s.manualPaused, true);
  assert.equal(s.autoPaused, false);
  assert.equal(s.consumedMs, H);
});

test('auto_pause_alone_resumes_on_auto_resume', () => {
  reset();
  const l = log(ev('timer_start', T0), ev('timer_pause_auto', T0 + H), ev('timer_resume_auto', T0 + 2 * H));
  const s = computeTimer(l, CFG, NO_MONEY, T0 + 3 * H);
  assert.equal(s.phase, 'running');
  assert.equal(s.consumedMs, 2 * H);
});

test('manual_resume_while_still_auto_paused_stays_paused', () => {
  reset();
  const l = log(
    ev('timer_start', T0),
    ev('timer_pause', T0 + H),
    ev('timer_pause_auto', T0 + H),
    ev('timer_resume', T0 + 2 * H),
  );
  const s = computeTimer(l, CFG, NO_MONEY, T0 + 4 * H);
  assert.equal(s.phase, 'paused');
  assert.equal(s.manualPaused, false);
  assert.equal(s.autoPaused, true);
  assert.equal(s.consumedMs, H);
});

test('timer_end_closes_the_open_interval_and_freezes_everything', () => {
  reset();
  const l = log(ev('timer_start', T0), ev('timer_end', T0 + 4 * H));
  const a = computeTimer(l, CFG, NO_MONEY, T0 + 4 * H);
  const b = computeTimer(l, CFG, NO_MONEY, T0 + 99 * H);   // much later — nothing may move
  assert.equal(a.phase, 'ended');
  assert.equal(a.consumedMs, 4 * H);
  assert.deepEqual(a, b);
});

test('undone_events_are_ignored_exactly_as_run_ts_ignores_them', () => {
  reset();
  const l = log(ev('timer_start', T0), ev('timer_pause', T0 + 2 * H, true));
  const s = computeTimer(l, CFG, NO_MONEY, T0 + 5 * H);
  // The undone pause never happened, so the clock ran the whole five hours.
  assert.equal(s.phase, 'running');
  assert.equal(s.consumedMs, 5 * H);
  assert.equal(s.pausedTotalMs, 0);
});

test('second_timer_start_is_a_duplicate_not_a_restart', () => {
  reset();
  const l = log(ev('timer_start', T0), ev('timer_start', T0 + 2 * H));
  const s = computeTimer(l, CFG, NO_MONEY, T0 + 3 * H);
  assert.equal(s.startedAt, T0);
  assert.equal(s.consumedMs, 3 * H);
});

test('remaining_clamps_at_zero_and_never_goes_negative', () => {
  reset();
  const s = computeTimer(log(ev('timer_start', T0)), CFG, NO_MONEY, T0 + 20 * H);
  assert.equal(s.remainingMs, 0);
  assert.equal(s.consumedMs, 20 * H);
});

test('NOT_A_STORED_COUNTDOWN_recompute_from_the_log_is_identical', () => {
  // The crash story: a redeploy loses every cached value, replays D1, and must land on the
  // same number. Folding the same log twice from a cold start is exactly that.
  reset();
  const l = log(ev('timer_start', T0), ev('timer_pause', T0 + H), ev('timer_resume', T0 + 4 * H));
  const before = computeTimer(l, CFG, money({ eligibleCents: 4200 }), T0 + 7 * H);
  const after = computeTimer([...l], CFG, money({ eligibleCents: 4200 }), T0 + 7 * H);
  assert.deepEqual(before, after);
});

test('paused_total_covers_a_pause_that_precedes_the_start', () => {
  reset();
  const l = log(ev('timer_pause', T0 - H), ev('timer_start', T0));
  const s = computeTimer(l, CFG, NO_MONEY, T0 + 3 * H);
  assert.equal(s.phase, 'paused');
  assert.equal(s.consumedMs, 0);
  assert.equal(s.pausedTotalMs, 3 * H);   // measured from startedAt, not from the stray pause
});

test('foldIntervals_does_not_mutate_its_input', () => {
  reset();
  const l = log(ev('timer_start', T0), ev('timer_pause', T0 + H));
  const snapshot = JSON.stringify(l);
  foldIntervals(l, T0 + 5 * H);
  assert.equal(JSON.stringify(l), snapshot);
});

// ============================ formatting ============================

test('formatHMS_does_not_wrap_at_24_hours', () => {
  assert.equal(formatHMS(39 * H + 30 * M), '39:30:00');
  assert.equal(formatHMS(0), '0:00:00');
  assert.equal(formatHMS(-5000), '0:00:00');
  assert.equal(formatHMS(9_000_000), '2:30:00');
  assert.equal(formatHMS(3_596_400), '0:59:56');
});

test('DST_a_running_clock_across_the_Berlin_October_transition', () => {
  // Europe/Berlin leaves CEST at 2026-10-25T01:00Z (03:00 CEST -> 02:00 CET).
  // Start 2026-10-24T23:00Z = 01:00 CEST. Four REAL hours later is 2026-10-25T03:00Z,
  // which is 04:00 CET — not the 05:00 that naive local-time arithmetic produces.
  reset();
  const start = Date.UTC(2026, 9, 24, 23, 0);
  assert.equal(formatBerlinEnd(start), 'So., 01:00');

  const cfg: TimerConfig = { baseMs: 4 * H, centsPerHour: 1000, capMs: 100 * H };
  const s = computeTimer(log(ev('timer_start', start)), cfg, NO_MONEY, start);

  assert.equal(s.endsAt, Date.UTC(2026, 9, 25, 3, 0));
  assert.equal(s.endsAtLabel, 'So., 04:00');
  assert.notEqual(s.endsAtLabel, 'So., 05:00');
});

test('DST_the_repeated_hour_is_ambiguous_in_local_time_but_not_in_epoch_ms', () => {
  // Two distinct instants an hour apart both render 02:30 on that night. This is why the
  // model stores epoch ms and formats only at the edge.
  const first = Date.UTC(2026, 9, 25, 0, 30);   // 02:30 CEST
  const second = Date.UTC(2026, 9, 25, 1, 30);  // 02:30 CET
  assert.equal(formatBerlinEnd(first), 'So., 02:30');
  assert.equal(formatBerlinEnd(second), 'So., 02:30');
  assert.notEqual(first, second);
});

// ============================ schema drift ============================

test('timer_events_CHECK_matches_TimerEventType', () => {
  // The event-type list lives twice — once as a TS union, once as a SQL CHECK in another file —
  // and nothing else makes them agree. Add a seventh type to one and this fails, which is the
  // point: the CHECK is the enforcement point (0002_timer.sql), so a type the database rejects
  // must not be constructible in TypeScript.
  // import.meta.dirname, not `new URL()`: the Workers runtime types declare their own global
  // URL, which is not the one node:url's fileURLToPath accepts.
  const read = (rel: string) => readFileSync(`${import.meta.dirname}/${rel}`, 'utf8');

  const quoted = (text: string, around: RegExp): string[] => {
    const m = around.exec(text);
    assert.ok(m !== null, `pattern not found: ${around.source}`);
    return [...(m[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((x) => x[1] ?? '').sort();
  };

  const inSql = quoted(read('../migrations/0002_timer.sql'), /CHECK \(type IN \(([^)]+)\)\)/s);
  const inTs = quoted(read('./timer.ts'), /export type TimerEventType =([\s\S]*?);/);

  assert.equal(inSql.length, 6);
  assert.deepEqual(inSql, inTs);
});
