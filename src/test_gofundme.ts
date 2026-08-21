// Parser assertions for the GoFundMe client (§3), run against responses recorded from the live
// endpoint on 2026-08-21. See test/fixtures/gofundme/README.md.
//
//   node --experimental-strip-types --test src/test_gofundme.ts
//
// NOTHING HERE TOUCHES THE NETWORK. The campaign is live and its totals move; a test that asserts
// 475 EUR against the real API fails next week for the right reason at the wrong time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  GoFundMeError, parseDonationPage, parseTotals, reconcile, toCents,
} from './gofundme.ts';
import { earnedMs } from './timer.ts';

const fx = (name: string): unknown =>
  JSON.parse(readFileSync(`${import.meta.dirname}/../test/fixtures/gofundme/${name}.json`, 'utf8'));

const OWN_DONATION_ID = '9000000002';   // the streamer's own 200 EUR (§4.1)

// ============================ the float boundary ============================

test('toCents_rounds_binary_floating_point_correctly', () => {
  assert.equal(toCents(475), 47_500);
  assert.equal(toCents(200.0), 20_000);
  assert.equal(toCents(19.99), 1_999);    // 19.99 * 100 is 1998.9999999999998
  assert.equal(toCents(0.1), 10);
  assert.equal(toCents(0), 0);
});

test('toCents_refuses_everything_that_is_not_a_finite_number', () => {
  for (const bad of [Number.NaN, Infinity, -Infinity, '25', null, undefined, {}]) {
    assert.throws(() => toCents(bad), (e: unknown) => e instanceof GoFundMeError && e.kind === 'malformed');
  }
});

// ============================ totals ============================

test('parseTotals_against_the_recorded_response', () => {
  const t = parseTotals(fx('totals'));
  assert.equal(t.currentCents, 47_500);
  assert.equal(t.goalCents, 280_000);
  assert.equal(t.currency, 'EUR');
  assert.match(t.fundName ?? '', /^Beispiel-Spendenaktion/);
});

// ============================ donations ============================

test('parseDonationPage_returns_all_seven_edges', () => {
  const p = parseDonationPage(fx('donations'));
  assert.equal(p.donationCount, 7);
  assert.equal(p.donations.length, 7);
  assert.equal(p.hasNextPage, false);
  assert.ok(p.donations.every((d) => d.currency === 'EUR'));
  assert.ok(p.donations.every((d) => Number.isInteger(d.amountCents)));
});

test('createdAt_is_parsed_not_sliced', () => {
  // The API reports a real offset (US Central, "-05:00"), so the string cannot be trusted to be
  // UTC. 2026-08-13T14:54:28-05:00 is 19:54:28Z.
  const first = parseDonationPage(fx('donations')).donations[0];
  assert.ok(first);
  assert.equal(first.createdAt, Date.UTC(2026, 7, 13, 19, 54, 28));
});

test('RECONCILES_donation_sum_equals_currentAmount', () => {
  // §3.2's claim, checked rather than trusted: the list is complete, not truncated.
  const r = reconcile(parseTotals(fx('totals')), parseDonationPage(fx('donations')).donations);
  assert.equal(r.sumCents, 47_500);
  assert.equal(r.deltaCents, 0);
  assert.equal(r.agrees, true);
});

// ============================ the failure modes that matter ============================

test('A_MISSING_SLUG_IS_NOT_A_ZERO_TOTAL', () => {
  // The trap: a slug that does not exist answers HTTP 200 with data.fundraiser = null. Read
  // naively that is "the campaign raised nothing", which would be a silently wrong clock on
  // camera for a typo in an admin field.
  assert.throws(() => parseTotals(fx('not-found')),
    (e: unknown) => e instanceof GoFundMeError && e.kind === 'not_found' && !e.retryable);
});

test('graphql_errors_are_rejected_and_not_retried', () => {
  assert.throws(() => parseTotals(fx('validation-error')),
    (e: unknown) => e instanceof GoFundMeError && e.kind === 'rejected' && !e.retryable);
});

test('retryable_separates_a_problem_that_passes_from_one_that_never_will', () => {
  assert.equal(new GoFundMeError('unreachable').retryable, true);
  assert.equal(new GoFundMeError('rate_limited').retryable, true);
  for (const k of ['rejected', 'not_found', 'malformed'] as const) {
    assert.equal(new GoFundMeError(k).retryable, false);
  }
});

test('malformed_shapes_are_malformed_and_never_silently_zero', () => {
  const cases: unknown[] = [
    null,
    { data: { fundraiser: { currentAmount: { amount: 'lots', currencyCode: 'EUR' } } } },
    { data: { fundraiser: { currentAmount: { amount: 1 } } } },                    // no currency
    { data: { fundraiser: { currentAmount: { amount: 1, currencyCode: 'EUR' }, goalAmount: { amount: 2, currencyCode: 'USD' } } } },
  ];
  for (const c of cases) {
    assert.throws(() => parseTotals(c), (e: unknown) => e instanceof GoFundMeError && e.kind !== 'not_found');
  }
});

test('a_donation_page_without_edges_is_malformed', () => {
  assert.throws(() => parseDonationPage({ data: { fundraiser: { donations: {} } } }),
    (e: unknown) => e instanceof GoFundMeError && e.kind === 'malformed');
});

// ============================ end to end, on the real numbers ============================

test('THE_WORKED_EXAMPLE_475_minus_own_200_is_39_and_a_half_hours', () => {
  // §1's headline, proven from the recorded response all the way through the clock: 475 EUR pool
  // less the streamer's own 200 EUR is 275 EUR eligible; at 10 EUR/h on a 12h base that is 39.5h.
  const totals = parseTotals(fx('totals'));
  const all = parseDonationPage(fx('donations')).donations;

  const own = all.find((d) => d.id === OWN_DONATION_ID);
  assert.ok(own, 'the excluded donation must still be in the fixture');
  assert.equal(own.amountCents, 20_000);

  const eligibleCents = totals.currentCents - own.amountCents;
  assert.equal(eligibleCents, 27_500);

  const { earnedMs: earned, capped } = earnedMs(
    { baseMs: 12 * 3_600_000, centsPerHour: 1000, capMs: 48 * 3_600_000 },
    { eligibleCents, adjustmentCents: 0, adjustmentMs: 0 },
  );
  assert.equal(earned, 39.5 * 3_600_000);
  assert.equal(capped, false);
});

test('excluding_by_id_survives_the_streamer_donating_again', () => {
  // Why §4.1 keys on the id and not on a euro field: a second donation from him is a different
  // id, so the exclusion set grows instead of the manual figure silently going stale.
  const all = parseDonationPage(fx('donations')).donations;
  const excluded = new Set([OWN_DONATION_ID, '9000000006']);
  const eligible = all.filter((d) => !excluded.has(d.id)).reduce((a, d) => a + d.amountCents, 0);
  assert.equal(eligible, 47_500 - 20_000 - 15_000);
});
