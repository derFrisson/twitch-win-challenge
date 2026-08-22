// The subathon clock's Durable Object (feature prompt §2/§3/§5).
//
// A SECOND object, deliberately, not a corner of LiveRun (G.6): the clock is a separate tool with
// its own lifecycle, and its 15s GoFundMe alarm would otherwise hold the win-challenge object
// awake for something it has nothing to do with.
//
// Everything on screen is DERIVED. This object caches, it never accumulates: kill it, delete its
// storage, redeploy, and hydrate() rebuilds the clock from D1 exactly as LiveRun does.

import { DurableObject } from 'cloudflare:workers';
import {
  GoFundMeError, fetchNewestDonations, fetchTotals, reconcile,
  type Donation, type Totals,
} from './gofundme.ts';
import { computeTimer, type TimerConfig, type TimerEvent, type TimerEventType, type TimerState } from './timer.ts';

// ---------- wire types ----------

export type TimerCause =
  | 'snapshot' | 'config' | 'start' | 'pause' | 'resume' | 'end' | 'poll' | 'donation';

/** The money view. Kept beside the clock because the overlay's goal bar and the admin's
 *  "Datenquelle" banner both read it, and neither should have to do arithmetic. */
export type PoolState = {
  totalCents: number;        // every donation to every campaign on this run
  eligibleCents: number;     // §4.1, after exclusions and adjustments
  goalCents: number | null;
  currency: string;
  source: 'live' | 'manual'; // 'manual' drives the loud admin banner (§3.4)
  health: 'unknown' | 'ok' | 'degraded' | 'failed';
  lastPollAt: number | null;
  /** §3.4: currentAmount vs Σ donations. Non-zero means a pagination gap or a hidden donation —
   *  surfaced, never allowed to change the hour count. */
  reconcileDeltaCents: number;
  /** True when a poll came back LOWER than the last known total and was refused (§3.4). */
  heldBackwards: boolean;
};

export type DonationAlert = {
  id: string; name: string | null; amountCents: number; addedMs: number;
};

export type TimerStep = {
  seq: number;
  cause: TimerCause;
  at: number;                 // server epoch ms — the overlay's clock anchor (§2.4)
  timer: TimerState;
  pool: PoolState;
  alerts: DonationAlert[];    // queued by the overlay, never stomped (§6.3)
};

export type TimerMsg =
  | { t: 'timer'; steps: TimerStep[] }
  | { t: 'pong' }
  | { t: 'error'; code: 'read_only' | 'bad_message' }
  // A rehearsal, never state: the overlay plays the toast/sound/jump and then falls back to the
  // last real step. Nothing is written, no seq is consumed, old clients ignore the unknown `t`.
  | { t: 'sim'; kind: 'donation'; alert: DonationAlert };

// ---------- SQL ----------

const RUN_COLS = `id, title, status, base_ms, cents_per_hour, cap_ms, manual_exclusion_cents,
  poll_interval_ms, auto_pause, auto_pause_after, twitch_login, started_at, ended_at`;

const T_RUN_CURRENT = `SELECT ${RUN_COLS} FROM timer_runs WHERE status IN ('live','draft')
  ORDER BY (status = 'live') DESC, created_at DESC LIMIT 1;`;
const T_RUN_BY_ID = `SELECT ${RUN_COLS} FROM timer_runs WHERE id = ?1;`;
const T_EVENTS = `SELECT seq, type, created_at, undone_at FROM timer_events WHERE run_id = ?1 ORDER BY seq;`;
const T_CAMPAIGNS = `SELECT c.id, c.slug, c.fund_name, c.currency, c.last_poll_at,
  c.last_total_cents, c.health, c.consecutive_failures
  FROM campaigns c JOIN run_campaigns rc ON rc.campaign_id = c.id
  WHERE rc.run_id = ?1 ORDER BY c.id;`;

// One row, four scalar subqueries: the whole §4.1/§4.2 money model in a single round trip.
const T_MONEY = `SELECT
  (SELECT COALESCE(SUM(d.amount_cents),0) FROM donations d
     JOIN run_campaigns rc ON rc.campaign_id = d.campaign_id WHERE rc.run_id = ?1) AS pool_cents,
  (SELECT COALESCE(SUM(d.amount_cents),0) FROM donations d
     JOIN run_campaigns rc ON rc.campaign_id = d.campaign_id
    WHERE rc.run_id = ?1 AND d.excluded_from_time = 0) AS eligible_cents,
  (SELECT COALESCE(SUM(a.cents),0) FROM adjustments a WHERE a.run_id = ?1 AND a.undone_at IS NULL) AS adj_cents,
  (SELECT COALESCE(SUM(a.ms),0)    FROM adjustments a WHERE a.run_id = ?1 AND a.undone_at IS NULL) AS adj_ms;`;

const T_KNOWN_IDS = `SELECT d.gofundme_id FROM donations d
  JOIN run_campaigns rc ON rc.campaign_id = d.campaign_id WHERE rc.run_id = ?1;`;
const T_APPEND = `INSERT INTO timer_events (run_id, type, action_id, created_at) VALUES (?1,?2,?3,?4);`;
const T_GO_LIVE = `UPDATE timer_runs SET status='live', started_at=?1 WHERE id=?2 AND status='draft';`;
const T_END = `UPDATE timer_runs SET status='ended', ended_at=?1 WHERE id=?2;`;
const T_DON_INSERT = `INSERT OR IGNORE INTO donations
  (gofundme_id,campaign_id,donor_name,amount_cents,currency,created_at,first_seen_at)
  VALUES (?1,?2,?3,?4,?5,?6,?7);`;
const T_CAMP_OK = `UPDATE campaigns SET last_poll_at=?1, last_total_cents=?2, health=?3,
  consecutive_failures=0, fund_name=COALESCE(?4,fund_name), currency=COALESCE(?5,currency) WHERE id=?6;`;
const T_CAMP_FAIL = `UPDATE campaigns SET last_poll_at=?1, health=?2,
  consecutive_failures=consecutive_failures+1 WHERE id=?3;`;

// ---------- rows ----------

type RunD1 = {
  id: number; title: string; status: 'draft' | 'live' | 'ended';
  base_ms: number; cents_per_hour: number; cap_ms: number; manual_exclusion_cents: number;
  poll_interval_ms: number; auto_pause: number; auto_pause_after: number;
  twitch_login: string | null; started_at: number | null; ended_at: number | null;
};
type CampaignD1 = {
  id: number; slug: string; fund_name: string | null; currency: string | null;
  last_poll_at: number | null; last_total_cents: number | null;
  health: 'unknown' | 'ok' | 'degraded' | 'failed'; consecutive_failures: number;
};
type MoneyD1 = { pool_cents: number; eligible_cents: number; adj_cents: number; adj_ms: number };

type Cfg = { run: RunD1 | null; campaigns: CampaignD1[]; money: MoneyD1; events: TimerEvent[] };
type PollMemo = { backfilled: boolean; offlinePolls: number; heldBackwards: boolean };

const IDLE_TIMER: TimerState = {
  phase: 'idle', manualPaused: false, autoPaused: false, earnedMs: 0, consumedMs: 0,
  remainingMs: 0, endsAt: null, endsAtLabel: null, capped: false,
  startedAt: null, endedAt: null, pausedTotalMs: 0,
};
const IDLE_POOL: PoolState = {
  totalCents: 0, eligibleCents: 0, goalCents: null, currency: 'EUR', source: 'manual',
  health: 'unknown', lastPollAt: null, reconcileDeltaCents: 0, heldBackwards: false,
};

// A poll that keeps failing must not hammer a third party, and must not need a human at 04:00
// either. Backoff is capped rather than stopped outright — see pollOnce().
const MAX_BACKOFF_MS = 300_000;
const FAILURES_TO_MANUAL = 5;
const NEWEST_PAGE = 25;

function text(body: string, status: number, headers?: Record<string, string>): Response {
  return new Response(body, {
    status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
}

export class TimerRun extends DurableObject<Env> {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}'));
    if (ctx.storage.kv.get('timer') === undefined) {
      ctx.blockConcurrencyWhile(async () => {
        try { await this.hydrate(); } catch (e) { console.error('timer hydrate failed', e); }
      });
    }
  }

  // ==================== WebSocket ====================

  // The Worker has already validated the overlay token against LiveRun before dispatching here,
  // so there is ONE token store for both overlays and no second credential to rotate.
  override async fetch(request: Request): Promise<Response> {
    if ((request.headers.get('Upgrade') ?? '').toLowerCase() !== 'websocket') {
      return text('expected websocket upgrade', 426);
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({ at: Date.now() });
    this.sendTo(pair[1], [this.step('snapshot', [])]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return this.refuse(ws, 'bad_message');
    let msg: unknown;
    try { msg = JSON.parse(message); } catch { return this.refuse(ws, 'bad_message'); }
    if (typeof msg !== 'object' || msg === null) return this.refuse(ws, 'bad_message');
    if ((msg as { t?: unknown }).t !== 'resume') return this.refuse(ws, 'read_only');
    this.sendTo(ws, [this.step('snapshot', [])]);
  }

  override async webSocketClose(_ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    console.log(JSON.stringify({ scope: 'timer ws close', code, reason, wasClean }));
  }
  override async webSocketError(_ws: WebSocket, error: unknown): Promise<void> {
    console.error('timer ws error', error);
  }

  // ==================== RPC ====================

  async snapshot(): Promise<{ timer: TimerState; pool: PoolState }> {
    return { timer: this.cachedTimer(), pool: this.cachedPool() };
  }

  /** Bind this object to a run and append `timer_start`. */
  async startRun(runId: number): Promise<TimerState | { error: string }> {
    return this.serialise(async () => {
      const now = Date.now();
      const row = await this.env.DB.prepare(T_RUN_BY_ID).bind(runId).first<RunD1>();
      if (row === null) return { error: 'no_such_run' };
      if (row.status === 'ended') return { error: 'run_ended' };

      await this.env.DB.batch([
        this.env.DB.prepare(T_APPEND).bind(runId, 'timer_start' satisfies TimerEventType, crypto.randomUUID(), now),
        this.env.DB.prepare(T_GO_LIVE).bind(now, runId),
      ]);
      this.ctx.storage.kv.put('runId', runId);
      this.ctx.storage.kv.delete('cfg');
      const state = await this.refresh('start', now);
      await this.ctx.storage.setAlarm(Date.now() + 1000);   // first poll almost immediately
      return state.timer;
    });
  }

  /** The §5 controls. `pause`/`resume` are the MANUAL latch; auto_* are the Twitch one. */
  async control(
    a: 'pause' | 'resume' | 'pause_auto' | 'resume_auto' | 'end',
    actionId?: string,
  ): Promise<TimerState | { error: string }> {
    return this.serialise(async () => {
      const now = Date.now();
      const cfg = await this.loadCfg();
      if (cfg.run === null || cfg.run.status !== 'live') return { error: 'no_live_run' };

      const type: TimerEventType =
        a === 'pause' ? 'timer_pause'
        : a === 'resume' ? 'timer_resume'
        : a === 'pause_auto' ? 'timer_pause_auto'
        : a === 'resume_auto' ? 'timer_resume_auto'
        : 'timer_end';

      const stmts = [this.env.DB.prepare(T_APPEND).bind(cfg.run.id, type, actionId ?? crypto.randomUUID(), now)];
      if (a === 'end') stmts.push(this.env.DB.prepare(T_END).bind(now, cfg.run.id));
      await this.env.DB.batch(stmts);

      this.ctx.storage.kv.delete('cfg');
      const cause: TimerCause = a === 'end' ? 'end' : a.startsWith('pause') ? 'pause' : 'resume';
      const out = await this.refresh(cause, now);
      if (a === 'end') await this.ctx.storage.deleteAlarm();   // stop polling with the run
      return out.timer;
    });
  }

  /** Called by the Worker after ANY timer_runs / campaigns / donations / adjustments mutation. */
  async configChanged(): Promise<{ timer: TimerState; pool: PoolState }> {
    return this.serialise(async () => {
      this.ctx.storage.kv.delete('cfg');
      return this.refresh('config', Date.now());
    });
  }

  /** Drop every cache and replay D1 — the timer's equivalent of route 27. */
  async rehydrate(): Promise<{ timer: TimerState; pool: PoolState }> {
    return this.serialise(async () => {
      const kv = this.ctx.storage.kv;
      // runId too: rehydrate means "forget everything and replay D1", and a stale pin is exactly
      // the kind of divergence this button exists to clear.
      kv.delete('cfg'); kv.delete('timer'); kv.delete('pool'); kv.delete('runId');
      await this.hydrate();
      const out = { timer: this.cachedTimer(), pool: this.cachedPool() };
      this.broadcast([this.step('snapshot', [])]);
      return out;
    });
  }

  /** Broadcast a fake €5 donation to every connected overlay. Reads config only to price the
   *  toast with the run's real rate; writes nothing and consumes no seq. */
  async simulateDonation(): Promise<{ ok: true }> {
    const cfg = await this.loadCfg();
    const rate = cfg.run !== null && cfg.run.cents_per_hour > 0 ? cfg.run.cents_per_hour : 1000;
    const amountCents = 500;
    const alert: DonationAlert = {
      id: `sim-${Date.now()}`, name: null, amountCents,
      addedMs: Math.floor((amountCents * 3_600_000) / rate),
    };
    this.sendAll(JSON.stringify({ t: 'sim', kind: 'donation', alert } satisfies TimerMsg));
    return { ok: true };
  }

  /**
   * Poll now, from the admin button. `force` lets a DRAFT run poll: it is the only way to check
   * a campaign slug is right before the countdown starts, and a typo found at hour 0 beats the
   * same typo found at hour 1.
   */
  async pollNow(): Promise<{ timer: TimerState; pool: PoolState }> {
    await this.pollOnce(true);
    return this.snapshot();
  }

  // ==================== the poller ====================

  override async alarm(): Promise<void> {
    const next = await this.pollOnce();
    if (next !== null) await this.ctx.storage.setAlarm(Date.now() + next);
  }

  /**
   * One poll. Returns the ms until the next one, or null to stop (the run ended).
   *
   * THE STRUCTURE IS THE POINT: every `fetch` happens OUTSIDE serialise(), and only the commit
   * runs inside it. live-run.ts:377 already documents why — an external fetch held across the
   * chain is the SPEC §4.9 input-gate hazard, and a hanging GoFundMe socket would stall a PAUSE
   * press behind it, indefinitely, on a 15s timer.
   */
  private async pollOnce(force = false): Promise<number | null> {
    const cfg = await this.loadCfg();
    if (cfg.run === null) return null;
    // The alarm only ever runs a live clock. A forced poll may also validate a draft, but never
    // schedules a follow-up — nothing should be polling on a timer before the run starts.
    if (cfg.run.status !== 'live' && !force) return null;
    const scheduleAfter = cfg.run.status === 'live';
    const interval = cfg.run.poll_interval_ms;
    if (cfg.campaigns.length === 0) return scheduleAfter ? interval : null;

    // ---- I/O, outside the chain ----
    type Fetched = { c: CampaignD1; totals: Totals | null; donations: Donation[]; err: GoFundMeError | null };
    const fetched: Fetched[] = [];
    for (const c of cfg.campaigns) {
      try {
        const totals = await fetchTotals(c.slug);
        const page = await fetchNewestDonations(c.slug, NEWEST_PAGE);
        fetched.push({ c, totals, donations: page.donations, err: null });
      } catch (e) {
        const err = e instanceof GoFundMeError ? e : new GoFundMeError('unreachable', String(e));
        fetched.push({ c, totals: null, donations: [], err });
      }
    }

    const twitchLive = await this.pollTwitch(cfg.run);   // also outside the chain

    // ---- commit, inside the chain ----
    const worstFailures = await this.serialise(async () => this.commitPoll(cfg, fetched, twitchLive));

    // Backoff on the failing case. Capped rather than stopped: an unattended 40-hour stream must
    // recover on its own when a transient outage clears. A true hard stop would need a human at
    // 04:00, which is worse than a 5-minute poll.
    // ponytail: one backoff for all campaigns, not per campaign. Upgrade to per-campaign only if
    // he ever runs two campaigns with genuinely different reliability.
    if (!scheduleAfter) return null;
    if (worstFailures === 0) return interval;
    return Math.min(interval * 2 ** Math.min(worstFailures, 8), MAX_BACKOFF_MS);
  }

  private async commitPoll(
    cfg: Cfg,
    fetched: { c: CampaignD1; totals: Totals | null; donations: Donation[]; err: GoFundMeError | null }[],
    twitchLive: boolean | null,
  ): Promise<number> {
    const now = Date.now();
    const run = cfg.run;
    if (run === null) return 0;

    const knownRows = await this.env.DB.prepare(T_KNOWN_IDS).bind(run.id).all<{ gofundme_id: string }>();
    const known = new Set(knownRows.results.map((r) => r.gofundme_id));
    const memo = this.memo();

    const stmts: D1PreparedStatement[] = [];
    const fresh: Donation[] = [];
    let failures = 0;
    let held = false;
    let sumSeen = 0, totalCents = 0, goalCents: number | null = null, currency = 'EUR';

    for (const f of fetched) {
      if (f.err !== null || f.totals === null) {
        failures = Math.max(failures, f.c.consecutive_failures + 1);
        stmts.push(this.env.DB.prepare(T_CAMP_FAIL).bind(now, f.err?.retryable === false ? 'failed' : 'degraded', f.c.id));
        // Keep serving the last good total for this campaign (§3.4 cached snapshot).
        totalCents += f.c.last_total_cents ?? 0;
        continue;
      }

      // NEVER MOVE THE CLOCK BACKWARDS (§3.4). A refund or an API glitch holds the previous
      // value and raises it in admin for a human decision — it does not silently subtract hours.
      const prev = f.c.last_total_cents;
      let accepted = f.totals.currentCents;
      if (prev !== null && accepted < prev) { accepted = prev; held = true; }

      totalCents += accepted;
      goalCents = f.totals.goalCents ?? goalCents;
      currency = f.totals.currency;
      sumSeen += reconcile(f.totals, f.donations).sumCents;

      stmts.push(this.env.DB.prepare(T_CAMP_OK)
        .bind(now, accepted, held ? 'degraded' : 'ok', f.totals.fundName, f.totals.currency, f.c.id));

      for (const d of f.donations) {
        if (known.has(d.id)) continue;
        fresh.push(d);
        stmts.push(this.env.DB.prepare(T_DON_INSERT)
          .bind(d.id, f.c.id, d.name, d.amountCents, d.currency, d.createdAt, now));
      }
    }

    if (stmts.length > 0) await this.env.DB.batch(stmts);
    this.ctx.storage.kv.delete('cfg');

    // The FIRST poll of a run adopts whatever already exists without alerting: a campaign that
    // has been running for a week must not fire a week of toasts into the stream at once.
    const alertable = memo.backfilled ? fresh : [];
    this.ctx.storage.kv.put('memo', { ...memo, backfilled: true, heldBackwards: held } satisfies PollMemo);

    if (twitchLive !== null) await this.applyAutoPause(run, twitchLive, now);

    const out = await this.refresh('poll', now, {
      alerts: alertable, totalCents, goalCents, currency,
      reconcileDeltaCents: totalCents - sumSeen, health: failures > 0 ? (failures >= FAILURES_TO_MANUAL ? 'failed' : 'degraded') : 'ok',
      lastPollAt: now, heldBackwards: held,
    });
    void out;
    return failures;
  }

  // ==================== Twitch auto-pause (§5) ====================

  /**
   * Returns true/false for live/offline, or null when auto-pause is off or unusable.
   * UNVERIFIED AGAINST THE REAL API: the Twitch app credentials this shares with IGDB have never
   * existed in this project, so this path has only ever been exercised with a fake fetch. It is
   * off by default (timer_runs.auto_pause) for exactly that reason.
   */
  private async pollTwitch(run: RunD1): Promise<boolean | null> {
    if (run.auto_pause !== 1 || run.twitch_login === null || run.twitch_login === '') return null;
    try {
      const stub = this.env.LIVE_RUN.get(this.env.LIVE_RUN.idFromName('singleton'));
      const token = await stub.igdbToken();   // same client-credentials token as IGDB; no new secret
      const res = await fetch(
        `https://api.twitch.tv/helix/streams?user_login=${encodeURIComponent(run.twitch_login)}`,
        {
          headers: { 'Client-ID': this.env.IGDB_CLIENT_ID, Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!res.ok) return null;   // an unreadable answer is not evidence of being offline
      const body = (await res.json()) as { data?: unknown[] };
      return Array.isArray(body.data) && body.data.length > 0;
    } catch {
      return null;   // never let a Twitch hiccup pause a running stream
    }
  }

  private async applyAutoPause(run: RunD1, live: boolean, now: number): Promise<void> {
    const memo = this.memo();
    const state = this.cachedTimer();

    if (live) {
      this.ctx.storage.kv.put('memo', { ...memo, offlinePolls: 0 } satisfies PollMemo);
      // Resume immediately — but ONLY the auto latch. A manual pause is sticky and only a human
      // clears it (§5); timer.ts enforces that, this just never emits the manual event.
      if (state.autoPaused) {
        await this.env.DB.prepare(T_APPEND)
          .bind(run.id, 'timer_resume_auto' satisfies TimerEventType, crypto.randomUUID(), now).run();
        this.ctx.storage.kv.delete('cfg');
      }
      return;
    }

    const offlinePolls = memo.offlinePolls + 1;
    this.ctx.storage.kv.put('memo', { ...memo, offlinePolls } satisfies PollMemo);
    // Debounced: a momentary blip must not pause the clock (§5).
    if (offlinePolls < run.auto_pause_after || state.autoPaused) return;
    await this.env.DB.prepare(T_APPEND)
      .bind(run.id, 'timer_pause_auto' satisfies TimerEventType, crypto.randomUUID(), now).run();
    this.ctx.storage.kv.delete('cfg');
  }

  // ==================== state ====================

  private async hydrate(): Promise<void> {
    await this.refresh('snapshot', Date.now(), undefined, false);
  }

  /** Recompute from D1 + config, cache, and broadcast one step. */
  private async refresh(
    cause: TimerCause,
    at: number,
    poll?: Partial<PoolState> & { alerts?: Donation[] },   // RAW donations; toAlerts() prices them
    broadcast = true,
  ): Promise<{ timer: TimerState; pool: PoolState }> {
    const cfg = await this.loadCfg();
    const kv = this.ctx.storage.kv;

    if (cfg.run === null) {
      kv.put('timer', IDLE_TIMER); kv.put('pool', IDLE_POOL);
      if (broadcast) this.broadcast([this.step(cause, [])]);
      return { timer: IDLE_TIMER, pool: IDLE_POOL };
    }

    const config: TimerConfig = {
      baseMs: cfg.run.base_ms, centsPerHour: cfg.run.cents_per_hour, capMs: cfg.run.cap_ms,
    };
    const eligibleCents = Math.max(0, cfg.money.eligible_cents - cfg.run.manual_exclusion_cents);
    const timer = computeTimer(cfg.events, config, {
      eligibleCents, adjustmentCents: cfg.money.adj_cents, adjustmentMs: cfg.money.adj_ms,
    }, at);

    const prevPool = this.cachedPool();
    const health = poll?.health ?? this.worstHealth(cfg.campaigns);
    const pool: PoolState = {
      totalCents: poll?.totalCents ?? cfg.money.pool_cents,
      eligibleCents,
      goalCents: poll?.goalCents ?? prevPool.goalCents,
      currency: poll?.currency ?? cfg.campaigns[0]?.currency ?? prevPool.currency,
      // §3.4: the loud banner. Anything but a healthy poll means "operate this by hand".
      source: health === 'ok' ? 'live' : 'manual',
      health,
      lastPollAt: poll?.lastPollAt ?? this.latestPoll(cfg.campaigns),
      reconcileDeltaCents: poll?.reconcileDeltaCents ?? prevPool.reconcileDeltaCents,
      heldBackwards: poll?.heldBackwards ?? prevPool.heldBackwards,
    };

    kv.put('timer', timer); kv.put('pool', pool);
    const alerts = poll?.alerts ?? [];
    if (broadcast) {
      this.broadcast([this.step(alerts.length > 0 ? 'donation' : cause, this.toAlerts(alerts, config, eligibleCents))]);
    }
    return { timer, pool };
  }

  /** What each new donation bought, for the §6.3 toast. Computed against the same integer
   *  arithmetic as the clock so the toast can never disagree with the number beside it. */
  private toAlerts(donations: Donation[], cfg: TimerConfig, _eligible: number): DonationAlert[] {
    return donations.map((d) => ({
      id: d.id, name: d.name, amountCents: d.amountCents,
      addedMs: Math.floor((d.amountCents * 3_600_000) / cfg.centsPerHour),
    }));
  }

  private async loadCfg(): Promise<Cfg> {
    const kv = this.ctx.storage.kv;
    const cached = kv.get<Cfg>('cfg');
    if (cached !== undefined) return cached;

    // Live run first, else the newest draft — the run being configured. Without the draft arm a
    // campaign added before the clock starts is invisible to this object, so its slug cannot be
    // checked until it is too late to fix quietly.
    const pinned = kv.get<number>('runId');
    const run = pinned !== undefined
      ? await this.env.DB.prepare(T_RUN_BY_ID).bind(pinned).first<RunD1>()
      : await this.env.DB.prepare(T_RUN_CURRENT).first<RunD1>();

    if (run === null) {
      const empty: Cfg = { run: null, campaigns: [], money: { pool_cents: 0, eligible_cents: 0, adj_cents: 0, adj_ms: 0 }, events: [] };
      kv.put('cfg', empty);
      return empty;
    }

    const [camps, money, events] = await Promise.all([
      this.env.DB.prepare(T_CAMPAIGNS).bind(run.id).all<CampaignD1>(),
      this.env.DB.prepare(T_MONEY).bind(run.id).first<MoneyD1>(),
      this.env.DB.prepare(T_EVENTS).bind(run.id).all<{ seq: number; type: TimerEventType; created_at: number; undone_at: number | null }>(),
    ]);

    const cfg: Cfg = {
      run,
      campaigns: camps.results,
      money: money ?? { pool_cents: 0, eligible_cents: 0, adj_cents: 0, adj_ms: 0 },
      events: events.results.map((e) => ({ seq: e.seq, type: e.type, created_at: e.created_at, undone_at: e.undone_at })),
    };
    // Only pin a LIVE run. Pinning a draft would strand this object on it after the human
    // deletes that draft and makes another.
    if (run.status === 'live') kv.put('runId', run.id);
    kv.put('cfg', cfg);
    return cfg;
  }

  private worstHealth(cs: CampaignD1[]): PoolState['health'] {
    if (cs.length === 0) return 'unknown';
    if (cs.some((c) => c.health === 'failed')) return 'failed';
    if (cs.some((c) => c.health === 'degraded')) return 'degraded';
    if (cs.every((c) => c.health === 'ok')) return 'ok';
    return 'unknown';
  }
  private latestPoll(cs: CampaignD1[]): number | null {
    const ts = cs.map((c) => c.last_poll_at).filter((t): t is number => t !== null);
    return ts.length > 0 ? Math.max(...ts) : null;
  }

  private memo(): PollMemo {
    return this.ctx.storage.kv.get<PollMemo>('memo') ?? { backfilled: false, offlinePolls: 0, heldBackwards: false };
  }
  private cachedTimer(): TimerState { return this.ctx.storage.kv.get<TimerState>('timer') ?? IDLE_TIMER; }
  private cachedPool(): PoolState { return this.ctx.storage.kv.get<PoolState>('pool') ?? IDLE_POOL; }

  private step(cause: TimerCause, alerts: DonationAlert[]): TimerStep {
    const kv = this.ctx.storage.kv;
    const seq = cause === 'snapshot' ? (kv.get<number>('seq') ?? 0) : (kv.get<number>('seq') ?? 0) + 1;
    if (cause !== 'snapshot') kv.put('seq', seq);
    return { seq, cause, at: Date.now(), timer: this.cachedTimer(), pool: this.cachedPool(), alerts };
  }

  private serialise<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => {});
    return run;
  }

  private broadcast(steps: TimerStep[]): void {
    this.sendAll(JSON.stringify({ t: 'timer', steps } satisfies TimerMsg));
  }
  private sendAll(body: string): void {
    for (const ws of this.ctx.getWebSockets()) {
      try { if (ws.readyState === WebSocket.OPEN) ws.send(body); } catch (e) { console.error('ws send failed', e); }
    }
  }
  private sendTo(ws: WebSocket, steps: TimerStep[]): void {
    try { ws.send(JSON.stringify({ t: 'timer', steps } satisfies TimerMsg)); } catch (e) { console.error('ws send failed', e); }
  }
  private refuse(ws: WebSocket, code: 'read_only' | 'bad_message'): void {
    try {
      ws.send(JSON.stringify({ t: 'error', code } satisfies TimerMsg));
      ws.close(1008, code === 'read_only' ? 'read-only' : 'bad message');
    } catch (e) { console.error('ws refuse failed', e); }
  }
}
