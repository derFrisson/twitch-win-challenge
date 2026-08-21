import { DurableObject } from 'cloudflare:workers';
import {
  plan,
  reduce,
  type Action,
  type Event,
  type NewEvent,
  type RunState,
  type SessionGameRow,
  type SessionRow,
} from './run.ts';

// The LiveRun Durable Object (SPEC §4): WebSocket hibernation, the serialised RPC control
// surface, the D1 append path, the two unauthenticated tokens, the IGDB app-token cache and the
// rate-limit bucket. It holds NO transition logic — every decision comes from run.ts (§2.0).
//
// ponytail: one promise chain serialises every control action. Awaiting D1 opens the DO's
// input gate, so a win and an undo landing together would otherwise interleave and clobber
// each other. Ceiling: ~1000 actions/sec for this single object, which is ~1000x more than a
// human with a Stream Deck. If this ever needs more, the run stops being one object.
//
// Three hard rules from §4.7, all load-bearing at 3am on stream:
//   - no setInterval / setTimeout anywhere (one timer = permanently non-hibernatable, billed
//     24/7, and the timer still dies at the 70-140s eviction);
//   - no ctx.waitUntil (documented no-op in a DO) — every write is awaited;
//   - no blockConcurrencyWhile outside the constructor guard.

// ---------- wire protocol (§4.2 / §4.4) ----------

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

export type ClientMsg =
  | { t: 'ping' }                  // heartbeat; MUST serialise byte-exactly as {"t":"ping"}
  | { t: 'resume'; seq: number };  // "my last seq was N, send me a snapshot if I missed anything"

// ---------- durable storage shapes (§4.7) ----------

type Role = 'overlay' | 'admin';
type Attachment = { role: Role; at: number };
type Cfg = { session: SessionRow | null; sessionGames: SessionGameRow[] };
type Tok = { overlay: string; control: string; rotatedAt: number };
type Bucket = { tokens: number; at: number };
type IgdbTok = { token: string; exp: number };
type LastAct = { action: string; actionId: string | null; at: number };

// ---------- SQL, transcribed from §3.2 ----------

// R1 the DO's config load, BY ID. Keyed by id and NEVER by status, because a `draft` session
// must be loadable before it is started and an `ended` one must stay loadable or the ENDED
// card, the recap and undo-past-`session_end` all lose their session (§4.7a).
//
// R1 and R1_SESSION_GAMES are EXPORTED: index.ts routes 3/13/16/17/18 read the same two rows
// and used to carry a second verbatim copy of both strings. One spelling per query, so the DO
// and the admin routes can never drift into disagreeing about what a session is.
export const R1_SESSION = `SELECT id, title, loop, stop_after_current, status, started_at, ended_at
  FROM sessions WHERE id = ?1;`;

export const R1_SESSION_GAMES = `SELECT sg.id, sg.session_id, sg.game_id, sg.order_index,
       COALESCE(sg.mode, g.default_mode) AS mode, g.name AS title, g.cover_key
  FROM session_games sg JOIN games g ON g.id = sg.game_id
 WHERE sg.session_id = ?1
 ORDER BY sg.order_index, sg.id;`;

// R1b live-session discovery + the `already_live` guard.
const R1B_LIVE = `SELECT id FROM sessions WHERE status = 'live' LIMIT 1;`;

// R2 the DO's event load, once per control action and once per cold hydrate.
const R2_EVENTS = `SELECT seq, session_id, session_game_id, lap, type, action_id, created_at, undone_at, meta_json
  FROM events WHERE session_id = ?1 ORDER BY seq;`;

// W1 append one action (one D1 batch(), one prepared statement bound N times, RETURNING seq)
const W1_APPEND = `INSERT INTO events (session_id, session_game_id, lap, type, action_id, created_at, meta_json)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) RETURNING seq;`;

// W2 undo one action
const W2_UNDO = `UPDATE events SET undone_at = ?1 WHERE action_id = ?2 AND undone_at IS NULL;`;

// W3 session lifecycle, always in the SAME batch as the event that caused it
const W3_LIVE = `UPDATE sessions SET status='live',  started_at=?1 WHERE id=?2 AND status='draft';`;
const W3_ENDED = `UPDATE sessions SET status='ended', ended_at=?1  WHERE id=?2;`;
const W3_RELIVE = `UPDATE sessions SET status='live',  ended_at=NULL WHERE id=?1;`;   // undo of a session_end
const W3_STOP_AFTER = `UPDATE sessions SET stop_after_current=?1 WHERE id=?2;`;

// ---------- constants ----------

// The one RunState hydrate() falls back to, and the answer for a DO no session is bound to.
// Never mutated: reduce() always builds a fresh object, and nothing here writes into a state.
const IDLE: RunState = {
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

// §4.10: 600 ms is under the fastest realistic gap between two *intended* control presses
// (rounds last seconds) and over every retry/re-issue window.
const REPLAY_WINDOW_MS = 600;

// capacity 20, refill 2/s. A human on a Stream Deck peaks around 3 presses/sec; 20 absorbs a
// double-tap flurry and a page reload storm, and 2/s starves an online guessing attempt against
// a 160-bit token into irrelevance. Fixed windows were rejected: they allow a 2x burst across
// the boundary.
const CAP = 20, REFILL_PER_SEC = 2;

// 32 chars from a 32-symbol alphabet = 160 bits of CSPRNG entropy. The alphabet is exactly 32
// symbols so `byte & 31` is uniform — a 31- or 36-symbol alphabet with `% len` would be biased.
// 'l', 'o', '0' and '1' are omitted: these strings get read aloud and retyped from a phone.
const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';   // 24 letters + 8 digits = 32
function newToken(): string {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(b, (x) => ALPHABET[x & 31]).join('');
}

// Constant-time comparison: length first, then a XOR accumulator over the whole string. The
// token IS the credential on /o/* and /c/*, so this is a security path, not a nicety.
function eq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// D1 stores loop / stop_after_current as INTEGER 0|1 (§3.1); SessionRow carries booleans (§2.1).
type SessionD1 = {
  id: number; title: string; loop: number; stop_after_current: number;
  status: 'draft' | 'live' | 'ended'; started_at: number | null; ended_at: number | null;
};
function toSessionRow(r: SessionD1): SessionRow {
  return {
    id: r.id,
    title: r.title,
    loop: r.loop === 1,
    stop_after_current: r.stop_after_current === 1,
    status: r.status,
    started_at: r.started_at,
    ended_at: r.ended_at,
  };
}

function text(body: string, status: number, headers?: Record<string, string>): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
}

export class LiveRun extends DurableObject<Env> {
  // The ONLY instance field. It has to live exactly as long as the overlapping in-flight
  // requests it serialises, and a DO cannot hibernate while a request is in flight (§4.9).
  private chain: Promise<unknown> = Promise.resolve();

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

  // ==================== fetch(): the WebSocket upgrade, nothing else ====================

  // A WebSocket cannot be returned from an RPC method, so the 101 must go through here (§4.8).
  override async fetch(request: Request): Promise<Response> {
    if ((request.headers.get('Upgrade') ?? '').toLowerCase() !== 'websocket') {
      return text('expected websocket upgrade', 426);
    }

    const url = new URL(request.url);
    const seg = url.pathname.split('/');
    // The Worker sets ?role= (§4.1). A client-supplied role on /o/* is overwritten here as
    // well, so a forged `?role=admin` can never route around the overlay-token check below.
    const onOverlayPath = seg[1] === 'o';
    const role: Role = !onOverlayPath && url.searchParams.get('role') === 'admin' ? 'admin' : 'overlay';

    if (role === 'overlay') {
      // The overlay token is validated INSIDE the DO (§4.1) — it lives in the path segment
      // the Worker forwarded: /o/<token>/ws.
      const kind = await this.authToken(seg[2] ?? '');
      if (kind === 'limited') return text('rate limited', 429, { 'Retry-After': '1' });
      // 404, never 401: a 401 on /o/<guess> confirms the URL shape exists (§6.3).
      if (kind !== 'overlay') return text('not found', 404);
    }

    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    // Written ONCE, at accept time, and never mutated — serializeAttachment does not track
    // mutations, so a mutated object read after the next wake would be stale (§4.7).
    pair[1].serializeAttachment({ role, at: Date.now() } satisfies Attachment);

    // On connect the client sends nothing: the snapshot is pushed unprompted, before the 101
    // (§4.4). Unicast, so it reuses the current seq and does NOT advance it (§4.5).
    this.sendTo(pair[1], [await this.snapshotStep()]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  // ==================== WebSocket handlers ====================

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    // `{"t":"ping"}` never reaches here — the runtime auto-responder answers it (§4.4).
    if (typeof message !== 'string') return this.refuse(ws, 'bad_message');
    let msg: unknown;
    try { msg = JSON.parse(message); }
    catch { return this.refuse(ws, 'bad_message'); }
    if (typeof msg !== 'object' || msg === null) return this.refuse(ws, 'bad_message');
    // One rule, no offence counter, no allowlist: every mutation is HTTP, so a control frame
    // on ANY socket (admin included) means either a bug or an attacker.
    if ((msg as { t?: unknown }).t !== 'resume') return this.refuse(ws, 'read_only');

    // A single snapshot, never a step replay: a snapshot is strictly more correct and the
    // state is ~700 bytes. Unicast, so the seq is reused, not advanced (§4.5).
    this.sendTo(ws, [await this.snapshotStep()]);
  }

  override async webSocketClose(_ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    // Log only. There is no in-memory client registry to clean up, and compatibility_date
    // >= 2026-04-07 completes the close handshake for us — do NOT call ws.close() here (§4.7).
    console.log(JSON.stringify({ scope: 'ws close', code, reason, wasClean }));
  }

  override async webSocketError(_ws: WebSocket, error: unknown): Promise<void> {
    console.error('ws error', error);
  }

  // ==================== control (each one runs inside serialise(), §4.9) ====================

  async start(sessionId: number): Promise<RunState | { error: string }> {
    return this.serialise(async () => {
      const kv = this.ctx.storage.kv;
      const now = Date.now();
      // 0. NO replay guard here, deliberately. §4.10's table defines a rule for exactly two
      // request shapes: an admin `/api/admin/control/*` POST carrying `{action_id}` (identity
      // rule) and a `/c/:t/*` GET (same-action-within-600ms). Route 20 is neither — its request
      // body is `—`, so there is no id to match on, and applying the 600 ms same-action rule
      // here turns a genuine `already_live` refusal into a 200 carrying the OTHER session's
      // state: starting session B right after session A answered "200, live, Session A" while
      // D1 still had B as a draft. A duplicate start needs no guard anyway, because it is
      // already a no-op by precondition — the first one leaves the row `status='live'`, so the
      // retry rejects `not_draft` (§2.3) with nothing appended. Consistent with the other
      // serialised non-control methods (rotateTokens / configChanged / rehydrate), which carry
      // no guard either.
      //
      // 1. ALL foreign I/O first. start() is the one method that must never plan against the
      // previously bound session's game list, so the cache is dropped before the load. kv `sid`
      // is only written in 4b, after the batch commits — a failed start cannot rebind the DO.
      kv.delete('cfg');
      const cfg = await this.loadCfgFor(sessionId);
      const other = await this.env.DB.prepare(R1B_LIVE).first<{ id: number }>();
      if (other !== null && other.id !== sessionId) return { error: 'already_live' };
      // 2. read events
      const events = await this.loadEvents(sessionId);

      // 3. plan() — pure, no await. R1b above is §2.3's fourth start precondition; plan() owns
      // the other three (no_live_session / not_draft / empty_session).
      const p = plan({ kind: 'start', sessionId }, events, cfg, now, crypto.randomUUID());
      if (!p.ok) return { error: p.reject };
      // Only `undo` yields an undoAction; this narrows the union, it is not a real branch.
      if ('undoAction' in p) return { error: 'no_live_session' };

      const out = await this.commitAppend(sessionId, cfg, events, p.append, now);
      kv.put('sid', sessionId);
      kv.put('lastact', { action: 'start', actionId: null, at: now } satisfies LastAct);
      this.broadcast(out.steps);
      return out.state;
    });
  }

  // `actionId` is the uuid admin.js generates per button press and reuses verbatim on every
  // retry of that press (§4.10). The /c/* Stream Deck routes have no body to carry one and
  // pass nothing — they are covered by the 600 ms coalescing window instead.
  async control(
    a: 'win' | 'loss' | 'skip' | 'undo' | 'stop_now',
    actionId?: string,
  ): Promise<RunState | { error: string }> {
    return this.serialise(async () => {
      const kv = this.ctx.storage.kv;
      const now = Date.now();
      // 0. replay guard. With an action_id the admin retry gets the current state back; without
      // one (a /c/* GET) the caller gets 'dup' so route 37 can answer 200 "dup" (§4.10).
      if (this.isReplay(a, actionId ?? null, now)) {
        return actionId !== undefined ? this.cachedState() : { error: 'dup' };
      }

      // 1. + 2. ALL foreign I/O first.
      const cfg = await this.loadCfg();
      const s = cfg.session;
      const events = s !== null ? await this.loadEvents(s.id) : [];

      // 3. plan() — pure. Built as literals rather than `{kind: a}`: the discriminant of a
      // union-typed property does not distribute over Action's members.
      const action: Action =
        a === 'win' ? { kind: 'win' }
        : a === 'loss' ? { kind: 'loss' }
        : a === 'skip' ? { kind: 'skip' }
        : a === 'undo' ? { kind: 'undo' }
        : { kind: 'stop_now' };
      const p = plan(action, events, cfg, now, actionId ?? crypto.randomUUID());
      if (!p.ok) return { error: p.reject };
      // Unreachable: with no session bound, `events` is empty and plan() has already rejected
      // (nothing_to_undo for undo, no_live_session for the rest). The check narrows `s` so
      // step 4 can bind a real session id.
      if (s === null) return { error: 'no_live_session' };

      const out = 'undoAction' in p
        ? await this.commitUndo(s, cfg, events, p.undoAction, now)
        : await this.commitAppend(s.id, cfg, events, p.append, now);

      kv.put('lastact', { action: a, actionId: actionId ?? null, at: now } satisfies LastAct);
      this.broadcast(out.steps);
      return out.state;
    });
  }

  // Idempotent SET, never a toggle (§2.5h). Patches the cached `cfg` in the same serialised
  // body, or plan()'s advance tail and the broadcast state keep reading the pre-tap value.
  async setStopAfterCurrent(on: boolean, actionId?: string): Promise<RunState | { error: string }> {
    return this.serialise(async () => {
      const kv = this.ctx.storage.kv;
      const now = Date.now();
      if (this.isReplay('stop_after_current', actionId ?? null, now)) {
        return actionId !== undefined ? this.cachedState() : { error: 'dup' };
      }

      const cfg = await this.loadCfg();
      const s = cfg.session;
      if (s === null || s.status !== 'live') return { error: 'no_live_session' };
      const events = await this.loadEvents(s.id);

      // 4. the sessions row write, awaited.
      await this.env.DB.prepare(W3_STOP_AFTER).bind(on ? 1 : 0, s.id).run();
      // 4b. patch what the write just changed — sync, no D1 re-read.
      s.stop_after_current = on;
      kv.put('cfg', cfg);

      // 5. + 6. + 7. No event was written, so this is a `config` step: broadcast, advances seq.
      const state = reduce(events, cfg);
      const step: Step = { seq: this.nextSeq(), cause: 'config', at: now, state };
      kv.put('state', state);
      kv.put('lastact', { action: 'stop_after_current', actionId: actionId ?? null, at: now } satisfies LastAct);
      this.broadcast([step]);
      return state;
    });
  }

  // ==================== IGDB app-token cache (§4.8) ====================

  // Inside serialise() so two debounced admin searches cannot both refetch. igdb.ts stays
  // I/O-only and takes the token as a parameter — this is the only place the cache lives.
  async igdbToken(): Promise<string> {
    // ponytail: deliberately NOT inside serialise(). An external fetch held across the chain
    // is the exact input-gate hazard SPEC 4.9 exists to prevent — an IGDB search in the admin
    // panel would stall every WIN/LOSS behind a Twitch OAuth round trip, and behind a HANGING
    // one indefinitely. Nothing here is a read-modify-write of run state: the cache read is a
    // synchronous kv.get and the write is a synchronous kv.put on a single-threaded object.
    // Two racing searches may each mint a token; harmless, IGDB allows 25 active per client.
    const kv = this.ctx.storage.kv;
    const cached = kv.get<IgdbTok>('igdb');
    if (cached !== undefined && cached.exp - Date.now() > 60_000) return cached.token;

    const res = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.env.IGDB_CLIENT_ID,
        client_secret: this.env.IGDB_CLIENT_SECRET,
        grant_type: 'client_credentials',
      }),
      // Without this a stalled Twitch socket hangs the request until the platform kills it.
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`twitch oauth ${res.status}`);
    const body = (await res.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== 'string') throw new Error('twitch oauth: no access_token');
    const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 3600;
    const tok: IgdbTok = { token: body.access_token, exp: Date.now() + expiresIn * 1000 };
    kv.put('igdb', tok);
    return tok.token;
  }

  // ==================== reads / admin ====================

  // The FAST path is deliberately NOT serialised: it performs no write the chain has to order,
  // and blocking every snapshot behind an in-flight control action would delay the reconnect it
  // exists for. Only the recovery hydrate goes through the chain.
  async snapshot(): Promise<RunState> {
    const st = this.ctx.storage.kv.get<RunState>('state');
    // Self-healing after a D1 blip: the next overlay reconnect fixes it with no human
    // involved (§4.7a). hydrate() rethrows for the log but always leaves `state` defined.
    if (st === undefined || this.isStaleIdle(st)) {
      // §4.7a: hydrate runs INSIDE serialise(), never beside it. Outside the chain it can
      // interleave with an in-flight control turn and write its pre-commit state into kv
      // `state` after commitAppend() has already written the post-commit one, leaving every
      // later snapshot one action stale until the next control action.
      //
      // No re-entrancy hazard: serialise() awaits this.chain, so calling it from inside a
      // serialised body would await itself and deadlock — nothing does. snapshot() has exactly
      // three callers (route 3, and snapshotStep() from fetch() and webSocketMessage()), none
      // of which runs in the chain, and hydrate()'s other two callers (the constructor guard
      // and rehydrate()) do not go through here.
      await this.serialise(async () => {
        // Re-read inside the chain: the turn we queued behind may have just fixed `state`, in
        // which case the D1 round trip is not needed at all.
        const cur = this.ctx.storage.kv.get<RunState>('state');
        if (cur !== undefined && !this.isStaleIdle(cur)) return;
        try { await this.hydrate(); }
        catch (e) { console.error('snapshot: hydrate failed', e); }
      });
    }
    return this.cachedState();
  }

  // Generated lazily on first read, so a fresh deploy needs no seeding step (§6.3).
  async tokens(): Promise<Tok> {
    return this.ensureTokens();
  }

  // Consumes one rate-limit token BEFORE comparing, so the bucket also throttles guessing.
  // Routes 33/34 (the static HTML shells) pass charge:false — see §6.3.
  async authToken(token: string, charge = true): Promise<'overlay' | 'control' | 'limited' | null> {
    if (charge && !this.take()) return 'limited';
    const t = this.ensureTokens();
    if (eq(token, t.overlay)) return 'overlay';
    if (eq(token, t.control)) return 'control';
    return null;
  }

  async rotateTokens(which: 'overlay' | 'control' | 'both'): Promise<Tok> {
    return this.serialise(async () => {
      const cur = this.ensureTokens();
      const next: Tok = {
        overlay: which === 'control' ? cur.overlay : newToken(),
        control: which === 'overlay' ? cur.control : newToken(),
        rotatedAt: Date.now(),
      };
      this.ctx.storage.kv.put('tok', next);
      // The token is only ever checked at connect time and there is no cache anywhere, so the
      // old URL is dead on the next request. Open overlay sockets must be cut immediately.
      if (which !== 'control') {
        for (const ws of this.ctx.getWebSockets()) {
          try {
            const att = ws.deserializeAttachment() as Attachment | null;
            if (att?.role === 'overlay') ws.close(1008, 'token rotated');
          } catch (e) { console.error('ws close failed', e); }
        }
      }
      return next;
    });
  }

  // ==================== cache invalidation ====================

  // Called by the Worker after ANY sessions / session_games mutation.
  async configChanged(): Promise<RunState> {
    return this.serialise(async () => {
      const kv = this.ctx.storage.kv;
      kv.delete('cfg');
      const cfg = await this.loadCfg();
      const events = cfg.session !== null ? await this.loadEvents(cfg.session.id) : [];
      const state = reduce(events, cfg);
      const step: Step = { seq: this.nextSeq(), cause: 'config', at: Date.now(), state };
      kv.put('state', state);
      this.broadcast([step]);
      return state;
    });
  }

  // Route 27, the "Resume" button: drop everything cached and replay D1.
  async rehydrate(): Promise<RunState> {
    return this.serialise(async () => {
      const kv = this.ctx.storage.kv;
      kv.delete('cfg');
      kv.delete('state');
      await this.hydrate();          // throws on a D1 failure -> the route answers 503
      const state = this.cachedState();
      const step: Step = { seq: this.nextSeq(), cause: 'snapshot', at: Date.now(), state };
      this.broadcast([step]);
      return state;
    });
  }

  // ==================== private: serialisation ====================

  private serialise<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => {});          // a failure must not poison the chain
    return run;
  }

  // §4.10 step 0. With an action_id the rule is exact identity (an admin retry of one press);
  // without one the rule is same-action-within-600ms (a Stream Deck GET has no body to carry
  // an id). Ceiling: only the immediately-previous action is remembered, which is exactly what
  // a retry is — and the second press of a deliberate double-tap within 600 ms is lost.
  private isReplay(action: string, actionId: string | null, now: number): boolean {
    const last = this.ctx.storage.kv.get<LastAct>('lastact');
    if (last === undefined) return false;
    if (actionId !== null) return last.actionId === actionId;
    return last.action === action && now - last.at < REPLAY_WINDOW_MS;
  }

  // ==================== private: D1 reads (§3.2) ====================

  private async loadCfgFor(sessionId: number): Promise<Cfg> {
    const db = this.env.DB;
    const [s, sg] = await Promise.all([
      db.prepare(R1_SESSION).bind(sessionId).first<SessionD1>(),
      db.prepare(R1_SESSION_GAMES).bind(sessionId).all<SessionGameRow>(),
    ]);
    return { session: s === null ? null : toSessionRow(s), sessionGames: sg.results };
  }

  // kv `sid` is the binding, written when session_start is appended and NEVER cleared by
  // session_end — that is what keeps undo-past-session_end and the ENDED card working (§2.5j).
  private async resolveSid(): Promise<number | null> {
    const kv = this.ctx.storage.kv;
    const sid = kv.get<number>('sid');
    if (sid !== undefined) return sid;
    const row = await this.env.DB.prepare(R1B_LIVE).first<{ id: number }>();
    if (row === null) return null;
    kv.put('sid', row.id);
    return row.id;
  }

  private async loadCfg(): Promise<Cfg> {
    const kv = this.ctx.storage.kv;
    const cached = kv.get<Cfg>('cfg');
    if (cached !== undefined) return cached;
    const sid = await this.resolveSid();
    if (sid === null) return { session: null, sessionGames: [] };
    const cfg = await this.loadCfgFor(sid);
    if (cfg.session !== null) kv.put('cfg', cfg);
    return cfg;
  }

  // The D1 columns are exactly Event's fields with exactly Event's types (§3.1), so the row
  // needs no mapping — unlike sessions, which stores its two booleans as INTEGER.
  private async loadEvents(sessionId: number): Promise<Event[]> {
    const r = await this.env.DB.prepare(R2_EVENTS).bind(sessionId).all<Event>();
    return r.results;
  }

  // ==================== private: hydrate (§4.7a) ====================

  // The only thing standing between a D1 blip during a redeploy and a permanently blank
  // overlay. Never leaves `state` undefined: on ANY D1 failure it writes the IDLE constant and
  // rethrows for the log, so fetch()/snapshot() can never push `state: undefined` at a
  // connecting overlay. Every path that calls it has already dropped or never had a state, so
  // the IDLE write cannot clobber a good live one.
  private async hydrate(): Promise<void> {
    const kv = this.ctx.storage.kv;
    try {
      const sid = await this.resolveSid();
      if (sid === null) { kv.put('state', IDLE); return; }
      const cfg = await this.loadCfgFor(sid);
      kv.put('cfg', cfg);
      const events = await this.loadEvents(sid);
      kv.put('state', reduce(events, cfg));
      if (kv.get('seq') === undefined) kv.put('seq', 0);
    } catch (e) {
      kv.put('state', IDLE);
      throw e;
    }
  }

  // §4.7a's retry condition: `state` says idle while kv `sid` names a non-draft session. A
  // missing cfg counts, because that is the same D1 blip seen from the other side.
  private isStaleIdle(st: RunState): boolean {
    // A deploy that CHANGES RunState's shape leaves the previous shape sitting in kv `state`.
    // The DO restarts but its storage does not, so without this the overlay would render a
    // missing field (a blank playlist) until someone happened to press a control button —
    // mid-stream, with no error anywhere. Treat an unreadable cache as no cache and replay D1.
    if (!Array.isArray(st.playlist)) return true;
    if (st.phase !== 'idle') return false;
    const kv = this.ctx.storage.kv;
    if (kv.get<number>('sid') === undefined) return false;
    const cfg = kv.get<Cfg>('cfg');
    return cfg === undefined || (cfg.session !== null && cfg.session.status !== 'draft');
  }

  // ==================== private: the commit paths (§4.9 steps 4-6) ====================

  // Binds ONE prepared W1 statement per element of `append`, in exactly plan()'s order, plus
  // the sessions-row update the action implies. Every element already carries the same
  // action_id and created_at (§2.5a).
  private async commitAppend(
    sessionId: number,
    cfg: Cfg,
    events: readonly Event[],
    append: NewEvent[],
    now: number,
  ): Promise<{ state: RunState; steps: Step[] }> {
    const db = this.env.DB;
    const w1 = db.prepare(W1_APPEND);
    const stmts = append.map((e) =>
      w1.bind(e.session_id, e.session_game_id, e.lap, e.type, e.action_id, e.created_at, e.meta_json),
    );
    const goesLive = append.some((e) => e.type === 'session_start');
    const goesEnded = append.some((e) => e.type === 'session_end');
    if (goesLive) stmts.push(db.prepare(W3_LIVE).bind(now, sessionId));
    if (goesEnded) stmts.push(db.prepare(W3_ENDED).bind(now, sessionId));

    // 4. D1 is the log of record: if this throws, nothing is committed, the DO's cached state
    // is untouched and the request answers 503. The streamer taps again.
    const res = await db.batch<{ seq: number }>(stmts);

    // 4b. Patch whatever the batch just changed in the sessions row into the cached cfg —
    // sync, no D1 re-read. Without this, plan()'s advance tail and the broadcast state keep
    // reading pre-write values.
    const s = cfg.session;
    if (s !== null && (goesLive || goesEnded)) {
      if (goesLive) { s.status = 'live'; s.started_at = now; }
      if (goesEnded) { s.status = 'ended'; s.ended_at = now; }
      this.ctx.storage.kv.put('cfg', cfg);
    }

    let base = 0;
    for (const e of events) if (e.seq > base) base = e.seq;
    const committed: Event[] = append.map((e, i) => ({
      ...e,
      // RETURNING seq is the whole reason W1 has it: seq is the only ordering authority.
      seq: res[i]?.results[0]?.seq ?? base + i + 1,
      undone_at: null,
    }));

    // 5. One RunState per appended event, folded over the growing prefix — the overlay needs
    // the INTERMEDIATE numbers or a completing win animates the loss counter toward the next
    // game's zero (§4.2). At most three reduce() calls over a few hundred events.
    const steps: Step[] = committed.map((ev, i) => ({
      seq: this.nextSeq(),
      cause: ev.type,
      at: ev.created_at,
      state: reduce([...events, ...committed.slice(0, i + 1)], cfg),
    }));
    const last = steps[steps.length - 1];
    const state = last !== undefined ? last.state : reduce(events, cfg);
    this.ctx.storage.kv.put('state', state);
    return { state, steps };
  }

  // Undo is an UPDATE, not an append: mark undone_at on every non-undone row of one action.
  private async commitUndo(
    session: SessionRow,
    cfg: Cfg,
    events: readonly Event[],
    target: string,
    now: number,
  ): Promise<{ state: RunState; steps: Step[] }> {
    const db = this.env.DB;
    const rewindsEnd = events.some(
      (e) => e.action_id === target && e.undone_at === null && e.type === 'session_end',
    );
    const stmts = [db.prepare(W2_UNDO).bind(now, target)];
    // §5.4: an undo that rewinds past a session_end additionally puts the session back live,
    // in the same batch. An undo of session_start cannot happen (§2.5d), so there is no
    // mirror case for started_at.
    if (rewindsEnd) stmts.push(db.prepare(W3_RELIVE).bind(session.id));
    await db.batch(stmts);

    if (rewindsEnd) {
      session.status = 'live';
      session.ended_at = null;
      this.ctx.storage.kv.put('cfg', cfg);
    }

    // The W2 above set undone_at on exactly these rows, so patching the already-loaded log is
    // equivalent to re-reading it — and costs no round trip.
    const post = reduce(
      events.map((e) => (e.action_id === target && e.undone_at === null ? { ...e, undone_at: now } : e)),
      cfg,
    );
    const step: Step = { seq: this.nextSeq(), cause: 'undo', at: now, state: post };
    this.ctx.storage.kv.put('state', post);
    return { state: post, steps: [step] };
  }

  // ==================== private: kv helpers ====================

  private cachedState(): RunState {
    return this.ctx.storage.kv.get<RunState>('state') ?? IDLE;
  }

  // Only BROADCAST steps advance seq. If a unicast snapshot consumed a number, every other
  // socket would see the next real step as a gap, resync, and flush a running animation — so
  // one client reconnecting would kill the celebration on the broadcast overlay (§4.5).
  private nextSeq(): number {
    const kv = this.ctx.storage.kv;
    const n = (kv.get<number>('seq') ?? 0) + 1;
    kv.put('seq', n);
    return n;
  }

  private async snapshotStep(): Promise<Step> {
    const state = await this.snapshot();
    return { seq: this.ctx.storage.kv.get<number>('seq') ?? 0, cause: 'snapshot', at: Date.now(), state };
  }

  private ensureTokens(): Tok {
    const kv = this.ctx.storage.kv;
    const existing = kv.get<Tok>('tok');
    if (existing !== undefined) return existing;
    // Sync kv read-then-write with no yield point between them, so two simultaneous first
    // reads cannot generate two different pairs.
    const fresh: Tok = { overlay: newToken(), control: newToken(), rotatedAt: Date.now() };
    kv.put('tok', fresh);
    return fresh;
  }

  // ponytail: one global bucket in DO storage for all unauthenticated traffic. No KV, no counters
  // table, no per-IP map. Ceiling: one abusive client can starve the real Stream Deck. Acceptable
  // for a single-streamer tool; if this ever serves more than one channel, key the bucket by token.
  private take(): boolean {
    const now = Date.now();
    const b = this.ctx.storage.kv.get<Bucket>('rl') ?? { tokens: CAP, at: now };
    const tokens = Math.min(CAP, b.tokens + ((now - b.at) / 1000) * REFILL_PER_SEC);
    if (tokens < 1) { this.ctx.storage.kv.put('rl', { tokens, at: now }); return false; }
    this.ctx.storage.kv.put('rl', { tokens: tokens - 1, at: now });   // sync: no await, no yield point
    return true;
  }

  // ==================== private: sending ====================

  private broadcast(steps: Step[]): void {
    const body = JSON.stringify({ t: 'state', steps } satisfies ServerMsg);
    for (const ws of this.ctx.getWebSockets()) {
      try { if (ws.readyState === WebSocket.OPEN) ws.send(body); }
      catch (e) { console.error('ws send failed', e); }
    }
  }

  // Per-socket try/catch: getWebSockets() can hand back a CLOSING socket and send() on a dead
  // one throws, so one stale OBS tab must not starve the admin panel.
  private sendTo(ws: WebSocket, steps: Step[]): void {
    try { ws.send(JSON.stringify({ t: 'state', steps } satisfies ServerMsg)); }
    catch (e) { console.error('ws send failed', e); }
  }

  private refuse(ws: WebSocket, code: 'read_only' | 'bad_message'): void {
    try {
      ws.send(JSON.stringify({ t: 'error', code } satisfies ServerMsg));
      ws.close(1008, code === 'read_only' ? 'read-only' : 'bad message');
    } catch (e) { console.error('ws refuse failed', e); }
  }
}
