// GoFundMe GraphQL client (STREAM_TIME_FEATURE_PROMPT §3).
//
// Same shape as igdb.ts: an I/O-only module over a PURE parsing core, so every response shape
// below is tested against recorded fixtures and no test touches the network.
//
// THIS IS AN UNDOCUMENTED ENDPOINT. It is the one their own public Twitch overlay widgets call,
// it needs no auth, and introspection is disabled so the schema cannot be read — only probed by
// validation error. It works today (re-verified 2026-08-21, see test/fixtures/gofundme/README.md)
// and it can change without notice. Every failure here degrades to manual operation (§3.4); none
// of them may take the clock down or move it backwards.

const ENDPOINT = 'https://graphql.gofundme.com/graphql';

// Verbatim from their own widget. `client-name`/`client-version` are NOT required (verified: the
// request succeeds without them) but are sent anyway — looking like the known-good client is
// safer than looking novel to whatever sits in front of this.
const HEADERS: Record<string, string> = {
  'content-type': 'application/json',
  'client-name': 'SSR Frontend Client',
  'client-version': '1.0.0',
  accept: '*/*',
  'user-agent': 'twitch-win-challenge-subathon-timer/1.0 (self-hosted OBS overlay; polls every 15s)',
};

const Q_TOTALS = `query GetFundraiser($slug: ID!) {
  fundraiser(slug: $slug) { fundName goalAmount { amount currencyCode } currentAmount { amount currencyCode } }
}`;

// first/after walks OLDEST->newest (backfill); last walks NEWEST->oldest (the poll). Both verified
// live on 2026-08-21, together with pageInfo { hasNextPage endCursor }.
const Q_PAGE = `query Donations($slug: ID!, $first: Int, $after: String) {
  fundraiser(slug: $slug) {
    donationCount
    donations(first: $first, after: $after) {
      pageInfo { hasNextPage endCursor }
      edges { node { id name createdAt amount { amount currencyCode } } }
    }
  }
}`;

const Q_NEWEST = `query NewestDonations($slug: ID!, $last: Int!) {
  fundraiser(slug: $slug) {
    donationCount
    donations(last: $last) {
      pageInfo { hasPreviousPage }
      edges { node { id name createdAt amount { amount currencyCode } } }
    }
  }
}`;

// ---------- results ----------

export type Totals = {
  fundName: string | null;
  goalCents: number | null;   // null if the campaign has no goal
  currentCents: number;        // §3.4: AUTHORITATIVE for the clock
  currency: string;
};

export type Donation = {
  id: string;            // stable; the natural dedup key and the donations table's PRIMARY KEY
  name: string | null;   // may be absent or anonymous
  amountCents: number;
  currency: string;
  createdAt: number;     // epoch ms
};

export type DonationPage = {
  donationCount: number;
  donations: Donation[];
  hasNextPage: boolean;
  endCursor: string | null;
};

/**
 * `kind` exists so the caller can tell a problem that WILL pass from one that never will.
 * Backing off for an hour against a typo'd slug is as wrong as hammering a 503.
 */
export type FailureKind =
  | 'unreachable'   // network error or 5xx — retryable
  | 'rate_limited'  // 429 — retryable, back off harder
  | 'rejected'      // 400 / GraphQL errors — OUR query is wrong; retrying cannot fix it
  | 'not_found'     // the slug does not exist — a human must correct it in admin
  | 'malformed';    // 200, but not a shape we recognise — the schema probably moved

export class GoFundMeError extends Error {
  // Declared and assigned, NOT a constructor parameter property: `npm test` runs the suite
  // through Node's type STRIPPING, which erases annotations and cannot synthesise the field
  // assignment a parameter property implies. tsconfig's erasableSyntaxOnly enforces this.
  readonly kind: FailureKind;
  readonly detail: string;

  constructor(kind: FailureKind, detail = '') {
    super(`gofundme: ${kind}${detail ? ` (${detail})` : ''}`);
    this.kind = kind;
    this.detail = detail;
  }
  /** Only these two are worth another request. The rest need a human. */
  get retryable(): boolean {
    return this.kind === 'unreachable' || this.kind === 'rate_limited';
  }
}

// ---------- the pure core ----------

/**
 * THE float boundary, and the only one in the whole feature. The API reports major units as JSON
 * numbers — `475`, and donations came back as `200.0` — so a float exists for exactly the width
 * of this function and never reaches storage, the clock, or the overlay.
 */
export function toCents(major: unknown): number {
  if (typeof major !== 'number' || !Number.isFinite(major)) {
    throw new GoFundMeError('malformed', `amount ${JSON.stringify(major)}`);
  }
  // Round, not trunc: 19.99 * 100 is 1998.9999999999998 in binary floating point.
  return Math.round(major * 100);
}

type Money = { amount?: unknown; currencyCode?: unknown };

function money(m: unknown, what: string): { cents: number; currency: string } {
  const v = m as Money | null | undefined;
  if (v == null || typeof v.currencyCode !== 'string') {
    throw new GoFundMeError('malformed', `${what} has no currencyCode`);
  }
  return { cents: toCents(v.amount), currency: v.currencyCode };
}

/**
 * Unwrap the envelope. Two traps live here, both verified live:
 *   * GraphQL errors arrive with the data, and a validation failure is HTTP 400 — never assume
 *     `res.ok` means the query worked.
 *   * A slug that does not exist is **HTTP 200 with `data.fundraiser: null`**, not a 404. Treated
 *     as a zero total that would be a silently wrong clock, so it is an explicit failure instead.
 */
function fundraiser(body: unknown): Record<string, unknown> {
  const b = body as { data?: { fundraiser?: unknown }; errors?: unknown[] } | null;
  if (b == null || typeof b !== 'object') throw new GoFundMeError('malformed', 'body is not an object');
  if (Array.isArray(b.errors) && b.errors.length > 0) {
    const first = b.errors[0] as { message?: unknown };
    throw new GoFundMeError('rejected', typeof first?.message === 'string' ? first.message : 'graphql error');
  }
  const f = b.data?.fundraiser;
  if (f === null || f === undefined) throw new GoFundMeError('not_found', 'no fundraiser for that slug');
  if (typeof f !== 'object') throw new GoFundMeError('malformed', 'fundraiser is not an object');
  return f as Record<string, unknown>;
}

export function parseTotals(body: unknown): Totals {
  const f = fundraiser(body);
  const current = money(f.currentAmount, 'currentAmount');
  const goal = f.goalAmount == null ? null : money(f.goalAmount, 'goalAmount');
  if (goal !== null && goal.currency !== current.currency) {
    throw new GoFundMeError('malformed', `goal ${goal.currency} != current ${current.currency}`);
  }
  return {
    fundName: typeof f.fundName === 'string' ? f.fundName : null,
    goalCents: goal?.cents ?? null,
    currentCents: current.cents,
    currency: current.currency,
  };
}

export function parseDonationPage(body: unknown): DonationPage {
  const f = fundraiser(body);
  const conn = f.donations as
    | { pageInfo?: { hasNextPage?: unknown; endCursor?: unknown }; edges?: unknown[] }
    | null | undefined;
  if (conn == null || !Array.isArray(conn.edges)) {
    throw new GoFundMeError('malformed', 'donations.edges missing');
  }

  const donations = conn.edges.map((e) => {
    const n = (e as { node?: Record<string, unknown> } | null)?.node;
    if (n == null || typeof n.id !== 'string') throw new GoFundMeError('malformed', 'donation without an id');
    const { cents, currency } = money(n.amount, `donation ${n.id}`);
    // createdAt carries a real offset ("2026-08-13T14:54:28.000-05:00" — GoFundMe reports US
    // Central, not UTC and not Berlin), so it must be parsed, never sliced.
    const at = typeof n.createdAt === 'string' ? Date.parse(n.createdAt) : Number.NaN;
    if (!Number.isFinite(at)) throw new GoFundMeError('malformed', `donation ${n.id} createdAt`);
    return {
      id: n.id,
      name: typeof n.name === 'string' && n.name !== '' ? n.name : null,
      amountCents: cents,
      currency,
      createdAt: at,
    };
  });

  return {
    donationCount: typeof f.donationCount === 'number' ? f.donationCount : donations.length,
    donations,
    hasNextPage: conn.pageInfo?.hasNextPage === true,
    endCursor: typeof conn.pageInfo?.endCursor === 'string' ? conn.pageInfo.endCursor : null,
  };
}

/**
 * §3.4 reconciliation. `currentCents` is authoritative for the clock; the list only drives alerts.
 * A mismatch means a pagination gap or a hidden donation, and it is surfaced to admin rather than
 * being allowed to change the hour count.
 */
export function reconcile(totals: Totals, donations: readonly Donation[]): { agrees: boolean; sumCents: number; deltaCents: number } {
  const sumCents = donations.reduce((a, d) => a + d.amountCents, 0);
  return { agrees: sumCents === totals.currentCents, sumCents, deltaCents: totals.currentCents - sumCents };
}

// ---------- I/O ----------

async function post(query: string, variables: Record<string, unknown>): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({ query, variables }),
      // Without this a stalled socket hangs the alarm until the platform kills it — and this runs
      // on a 15s timer, so a hang would pile up.
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new GoFundMeError('unreachable', 'fetch failed');
  }

  if (res.status === 429) throw new GoFundMeError('rate_limited', '429');
  if (res.status >= 500) throw new GoFundMeError('unreachable', String(res.status));

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new GoFundMeError('malformed', `non-JSON body (http ${res.status})`);
  }
  // 400 still carries a GraphQL error array; let the parser surface the actual message.
  return body;
}

export const fetchTotals = async (slug: string): Promise<Totals> => parseTotals(await post(Q_TOTALS, { slug }));

/** The poll (§3.4): newest first, so the walk stops as soon as it reaches a donation we know. */
export async function fetchNewestDonations(slug: string, last: number): Promise<DonationPage> {
  const page = parseDonationPage(await post(Q_NEWEST, { slug, last }));
  return page;
}

/**
 * The one-time backfill. Bounded by `maxPages` — an unbounded cursor walk against a third party
 * on a timer is how a polite client becomes an abusive one. Returns what it got plus whether it
 * stopped early, so the caller can report a partial list rather than pretend it is complete.
 */
export async function fetchAllDonations(
  slug: string,
  { pageSize = 100, maxPages = 20 }: { pageSize?: number; maxPages?: number } = {},
): Promise<{ donations: Donation[]; complete: boolean; donationCount: number }> {
  const all: Donation[] = [];
  let after: string | null = null;
  let count = 0;

  for (let i = 0; i < maxPages; i++) {
    const page: DonationPage = parseDonationPage(await post(Q_PAGE, { slug, first: pageSize, after }));
    all.push(...page.donations);
    count = page.donationCount;
    if (!page.hasNextPage) return { donations: all, complete: true, donationCount: count };
    after = page.endCursor;
    if (after === null) break; // hasNextPage with no cursor: cannot advance, do not spin
  }
  return { donations: all, complete: false, donationCount: count };
}
