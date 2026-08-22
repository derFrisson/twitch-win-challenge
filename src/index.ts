// Worker entrypoint: the router (SPEC 5), the asset fallthrough (route 44), and the re-export
// the LIVE_RUN Durable Object binding resolves its class against.
//
// Shape is deliberate (SPEC 5.1): ONE flat prefix chain over url.pathname, no router library,
// no middleware stack. wrangler.jsonc's assets.run_worker_first lists exactly the five prefixes
// this file owns — /api/*, /o/*, /c/*, /admin/*, /covers/* — plus `/` which matches no asset.
// Every other path is served straight from the asset store with zero Worker invocation, which
// is what keeps the overlay's CSS/JS/font/sfx requests off the compute bill. Anything that
// reaches here and matches nothing is handed to env.ASSETS.fetch() (route 44) — never a 404
// invented here.
//
// ponytail: no ctx.waitUntil anywhere in this file. Every DO call, D1 write and R2 write is
// awaited before responding, because each one is part of the truth the admin panel reads back
// out of the very same request. Ceiling: route 6's cover ingest makes that one request as slow
// as IGDB's image CDN; if that ever matters it moves behind waitUntil and route 6 answers first.

import { json, logError, requireAccess, withSecurityHeaders } from './auth.ts';
import { IgdbSearchError, coverIdsForGames, ingestCover, searchGames } from './igdb.ts';
import { R1_SESSION, R1_SESSION_GAMES } from './live-run.ts';
import {
  Q_ATTEMPTS,
  Q_EVENTS,
  Q_FASTEST_WIN,
  Q_OUTCOMES,
  Q_PER_GAME,
  Q_PER_LAP,
  Q_PER_ROUND,
  Q_SESSION_TIME,
  Q_WORST_GAME,
  buildRecap,
  eventsToCsv,
  serialiseEventsJson,
} from './recap.ts';
import type {
  AttemptsRow,
  EventExportRow,
  FastestWinRow,
  OutcomesRow,
  PerGameRow,
  PerLapRow,
  PerRoundRow,
  Recap,
  SessionTimeRow,
  WorstGameRow,
} from './recap.ts';
import type { Mode, RunState, SessionGameRow, SessionRow } from './run.ts';

// The DO binding resolves `class_name: "LiveRun"` against the entrypoint's exports (SPEC 9.2).
export { LiveRun } from './live-run.ts';
// The clock's own object (feature prompt G.6) — a separate tool, not a corner of LiveRun.
export { TimerRun } from './timer-run.ts';

// ---------------------------------------------------------------------------------------------
// types and SQL this file owns
// ---------------------------------------------------------------------------------------------

/** A `games` library row, as routes 5-9 return it. Not in run.ts: the reducer never sees it. */
type Game = {
  id: number;
  name: string;
  igdb_id: number | null;
  cover_key: string | null;
  default_mode: Mode;
  created_at: number;
};

/** `sessions` as D1 stores it: loop / stop_after_current are INTEGER 0|1, not boolean. */
type SessionDbRow = Omit<SessionRow, 'loop' | 'stop_after_current'> & {
  loop: number;
  stop_after_current: number;
};

type ControlAction = 'win' | 'loss' | 'skip' | 'undo' | 'stop_now';

/** What every SPEC 4.8 control method resolves to: the new state, or a refusal code. */
type ControlResult = RunState | { error: string };

// R1 / R1_SESSION_GAMES (SPEC 3.2) are imported from live-run.ts — see the note there.

// Same projection for a single row, so routes 16/18 can echo back exactly what routes 13/17 list.
const SQL_SESSION_GAME_ONE = `SELECT sg.id, sg.session_id, sg.game_id, sg.order_index,
       COALESCE(sg.mode, g.default_mode) AS mode, g.name AS title, g.cover_key
  FROM session_games sg JOIN games g ON g.id = sg.game_id
 WHERE sg.id = ?1`;

const GAME_COLS = 'id, name, igdb_id, cover_key, default_mode, created_at';

// SPEC 5.4: every Plan.reject is a 409 no-op. Anything else coming back from the DO in the
// `{error}` arm is a failure, not a refusal, and maps to 503.
const REJECTS = [
  'no_live_session',
  'session_ended',
  'empty_session',
  'already_live',
  'not_draft',
  'nothing_to_undo',
];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_COVER_BYTES = 2 * 1024 * 1024;   // route 9
const MAX_NAME_LEN = 80;                   // routes 6/7 (SPEC 11 resolution 32)
const MAX_COVER_KEY_LEN = 128;             // route 43

// ---------------------------------------------------------------------------------------------
// small shared helpers
// ---------------------------------------------------------------------------------------------

// SPEC 9.2: the SAME call with the SAME hint everywhere. The very first get() in the object's
// life pins its data centre permanently and locationHint is honoured only on that call, so a
// second spelling anywhere in this file could pin a German stream's DO to another continent.
function stub(env: Env) {
  return env.LIVE_RUN.getByName('live', { locationHint: 'weur' });
}

// Same one-spelling rule as stub(): the first get() pins the object's data centre for life.
function timerStub(env: Env) {
  return env.TIMER_RUN.getByName('clock', { locationHint: 'weur' });
}

// ---- timer SQL (feature prompt §7; migrations/0002_timer.sql) ----
const TQ_RUNS = `SELECT id, title, status, base_ms, cents_per_hour, cap_ms, manual_exclusion_cents,
  poll_interval_ms, auto_pause, auto_pause_after, twitch_login, started_at, ended_at, created_at
  FROM timer_runs ORDER BY created_at DESC;`;
const TQ_RUN_LIVE_ID = `SELECT id FROM timer_runs WHERE status = 'live' LIMIT 1;`;
const TQ_CAMPAIGNS = `SELECT c.id, c.slug, c.fund_name, c.currency, c.last_poll_at, c.last_total_cents,
  c.health, c.consecutive_failures FROM campaigns c
  JOIN run_campaigns rc ON rc.campaign_id = c.id WHERE rc.run_id = ?1 ORDER BY c.id;`;
const TQ_DONATIONS = `SELECT d.gofundme_id, d.campaign_id, d.donor_name, d.amount_cents, d.currency,
  d.created_at, d.first_seen_at, d.excluded_from_time FROM donations d
  JOIN run_campaigns rc ON rc.campaign_id = d.campaign_id
  WHERE rc.run_id = ?1 ORDER BY d.created_at DESC;`;
const TQ_ADJUSTMENTS = `SELECT id, cents, ms, note, author, created_at, undone_at
  FROM adjustments WHERE run_id = ?1 ORDER BY created_at DESC;`;

// Every one of these is an admin form field. Nothing about the money model is hardcoded.
const TIMER_INT_FIELDS = ['base_ms', 'cents_per_hour', 'cap_ms', 'manual_exclusion_cents',
  'poll_interval_ms', 'auto_pause', 'auto_pause_after'] as const;

// The uploaded donation sound. One fixed key: uploading replaces, deleting silences.
const DONATION_SOUND_KEY = 'sfx/donation';
const MAX_SOUND_BYTES = 4 * 1024 * 1024;   // 4 MB is a generous ceiling for a one-shot alert

// SPEC 5.3's body shape. Kept local: auth.ts's export surface is fixed at four things (SPEC 6.1).
function err(status: number, error: string, detail?: string): Response {
  return json(detail === undefined ? { error } : { error, detail }, status);
}

const notFound = () => err(404, 'not_found');

// SPEC 5.2: any method not listed for a path is a 405 with an Allow header. OPTIONS is not
// implemented and no CORS header is emitted anywhere — every client here is same-origin.
function methodNotAllowed(allow: string): Response {
  const res = err(405, 'method_not_allowed');
  res.headers.set('Allow', allow);
  return res;
}

function textNoStore(body: string | null, status = 200, extra?: Record<string, string>): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...extra },
  });
}

// Routes 33/34 serve an asset response that must not be cached (the shell is fetched again on
// every OBS source refresh). withSecurityHeaders() cannot do it — it never touches Cache-Control.
function noStore(res: Response): Response {
  const out = new Response(res.body, res);
  out.headers.set('Cache-Control', 'no-store');
  return out;
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const v: unknown = await request.json();
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
  } catch {
    return null;   // malformed JSON is a 400 at the call site, never a 500
  }
}

type Body = Record<string, unknown> | null;
const strField = (b: Body, k: string): string | null => {
  const v = b?.[k];
  return typeof v === 'string' ? v : null;
};
const boolField = (b: Body, k: string): boolean | null => {
  const v = b?.[k];
  return typeof v === 'boolean' ? v : null;
};
const intField = (b: Body, k: string): number | null => {
  const v = b?.[k];
  return typeof v === 'number' && Number.isInteger(v) ? v : null;
};
const isMode = (v: unknown): v is Mode => v === 'single' || v === 'b2b';

/** A path id segment. Anything that is not a positive integer names no row -> the caller 404s. */
function pathId(seg: string | undefined): number | null {
  if (seg === undefined || !/^[1-9][0-9]*$/.test(seg)) return null;
  const n = Number(seg);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * A D1 RESTRICT violation, thrown out of run()/batch(). Matched on the message because D1
 * exposes no error code — it wraps SQLite's own text ("FOREIGN KEY constraint failed"). Used by
 * routes 8 and 19, whose pre-check can lose a race with a concurrent insert (SPEC 5.2).
 */
function isFkFailure(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const cause = e.cause;
  const text = cause instanceof Error ? `${e.message} ${cause.message}` : e.message;
  return /FOREIGN KEY constraint failed/i.test(text);
}

function toSessionRow(r: SessionDbRow): SessionRow {
  return { ...r, loop: r.loop === 1, stop_after_current: r.stop_after_current === 1 };
}

const loadSession = (env: Env, id: number) =>
  env.DB.prepare(R1_SESSION).bind(id).first<SessionDbRow>();

const loadSessionGames = (env: Env, id: number) =>
  env.DB.prepare(R1_SESSION_GAMES).bind(id).all<SessionGameRow>();

async function sessionStatus(env: Env, id: number): Promise<string | null> {
  const row = await env.DB.prepare('SELECT status FROM sessions WHERE id = ?1')
    .bind(id)
    .first<{ status: string }>();
  return row?.status ?? null;
}

/**
 * A recap exists only once a session has STARTED. For a `draft` every Q_* comes back empty and
 * Q_SESSION_TIME returns all-NULL, so buildRecap() renders `1970-01-01T00:00:00.000Z` with
 * `total_ms: null` — a broken card, and a lie about the SessionTimeRow types recap.ts declares
 * (SPEC 3.4). Routes 28/29/35 refuse it with the 404 they already document ("no session"):
 * SPEC 5.4 has no reject code that means "still a draft", the recap genuinely does not exist
 * yet, and recap.js already renders its clean "Keine Session gefunden." state on a 404.
 */
async function hasRecap(env: Env, id: number): Promise<boolean> {
  const s = await sessionStatus(env, id);
  return s === 'live' || s === 'ended';
}

// Routes 7/9/14/16/17/18/19: a mutation to the live session's config must reach the DO, or
// plan() keeps advancing against the previous game list (SPEC 4.8).
async function configChangedIfLive(env: Env, status: string | null): Promise<void> {
  if (status !== 'live') return;
  try {
    await stub(env).configChanged();
  } catch (e) {
    // The D1 write already committed. Failing the request here would tell the admin the edit
    // did not happen and invite a retry that duplicates it — worse than a briefly stale DO
    // cache, which the "Resume" button (route 27) exists to clear. Log and carry on.
    logError('configChangedIfLive', e);
  }
}

// Routes 7/9 edit the games LIBRARY, not a session, so there is no session status to hand to
// configChangedIfLive. The DO caches the resolved title and cover_key per session_game, so
// renaming a game or replacing its cover while it is in the live playlist would otherwise keep
// the old one on camera until the next advance.
async function gameConfigChanged(env: Env, gameId: number): Promise<void> {
  const used = await env.DB.prepare(
    `SELECT 1 FROM session_games sg JOIN sessions s ON s.id = sg.session_id
      WHERE sg.game_id = ?1 AND s.status = 'live' LIMIT 1`,
  )
    .bind(gameId)
    .first<{ 1: number }>();
  if (used !== null) await configChangedIfLive(env, 'live');
}

/**
 * SPEC 6.3/6.4. authToken() charges the shared token bucket BEFORE the constant-time compare
 * (unless charge is false), so an exhausted bucket surfaces as 'limited' -> 429 (SPEC 9.4's
 * 30-requests-to-/c/<t>/loss check asserts exactly that). Every other non-role answer is a bad
 * token and gets a 404, never a 401 — a 401 on /o/<guess> confirms the URL shape exists.
 */
function authTokenRole(env: Env, token: string, charge: boolean) {
  return stub(env).authToken(token, charge);
}

// SPEC 6.4: one body, one Retry-After, wherever the shared bucket refuses a request. Matches
// what LiveRun.fetch() answers on /o/:t/ws so a throttled Stream Deck and a throttled overlay
// look identical in the logs.
const rateLimited = () => textNoStore('rate limited', 429, { 'Retry-After': '1' });

// SPEC 5.4 + 4.10: the DO's `{error}` arm. 'dup' is the /c/* replay-guard no-op and is a 200
// there, so it is mapped by the caller, not here.
function controlError(scope: string, code: string): Response {
  if (REJECTS.includes(code)) return err(409, code);
  logError(scope, new Error(`unexpected control error: ${code}`));
  return err(503, 'unavailable', code);
}

// SPEC 3.4: one batch, one round trip, eight result sets threaded into RecapRawRows by name.
async function loadRecap(env: Env, sessionId: number): Promise<Recap> {
  const q = (sql: string) => env.DB.prepare(sql).bind(sessionId);
  const r = await env.DB.batch<Record<string, unknown>>([
    q(Q_OUTCOMES),
    q(Q_ATTEMPTS),
    q(Q_WORST_GAME),
    q(Q_FASTEST_WIN),
    q(Q_SESSION_TIME),
    q(Q_PER_LAP),
    q(Q_PER_GAME),
    q(Q_PER_ROUND),
  ]);
  // D1 returns one D1Result per statement, in submission order. The casts are the column shapes
  // recap.ts already documents per query — D1 cannot infer them from a SQL string.
  const at = <T>(i: number): T[] => (r[i]?.results ?? []) as unknown as T[];
  return buildRecap({
    outcomes: at<OutcomesRow>(0),
    attempts: at<AttemptsRow>(1),
    worstGame: at<WorstGameRow>(2),
    fastestWin: at<FastestWinRow>(3),
    sessionTime: at<SessionTimeRow>(4),
    perLap: at<PerLapRow>(5),
    perGame: at<PerGameRow>(6),
    perRound: at<PerRoundRow>(7),
  });
}

const loadEvents = (env: Env, sessionId: number) =>
  env.DB.prepare(Q_EVENTS).bind(sessionId).all<EventExportRow>();

// ---------------------------------------------------------------------------------------------
// entrypoint
// ---------------------------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // SPEC 5.1: X-Frame-Options DENY everywhere except /o/*, which the admin live preview
    // (SPEC 8.5) embeds in an iframe.
    const frame = url.pathname.startsWith('/o/') ? 'SAMEORIGIN' : 'DENY';
    try {
      return withSecurityHeaders(await route(request, env, url), { frame });
    } catch (e) {
      logError(`${request.method} ${url.pathname}`, e);
      return withSecurityHeaders(err(500, 'internal'), { frame });
    }
  },
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env, url: URL): Promise<Response> {
  const p = url.pathname;
  const seg = p.split('/').filter((s) => s !== '');

  // 1 — GET / -> the admin panel.
  if (p === '/') {
    if (request.method !== 'GET') return methodNotAllowed('GET');
    return new Response(null, { status: 302, headers: { Location: '/admin/' } });
  }

  // 2 — the admin surface, behind Access.
  if (p === '/admin' || p.startsWith('/admin/')) {
    const auth = await requireAccess(request, env);
    if (auth instanceof Response) return auth;
    if (request.method !== 'GET') return methodNotAllowed('GET');
    // The shell for /admin and /admin/; the real file for /admin/admin.css and /admin/admin.js,
    // which live under the same Worker-owned prefix and would otherwise be served the HTML.
    //
    // Ask ASSETS for the CANONICAL path ('/admin/'), never for '/admin/index.html'.
    // env.ASSETS.fetch() applies the same html_handling as a direct request, and
    // "auto-trailing-slash" (SPEC 9.2) answers an explicit .html path with a 307 to its
    // canonical form. Passing that redirect back turned /admin/ into an infinite loop
    // (307 -> /admin/ -> 307 -> ...), i.e. the admin panel was unreachable. Verified with
    // `curl -L`: 50 redirects before the fix, 200 after.
    if (p === '/admin' || p === '/admin/') {
      return env.ASSETS.fetch(new Request(new URL('/admin/', url), request));
    }
    // The clock's own page (G.7). Same canonical-path rule as above, or html_handling's
    // auto-trailing-slash turns it into a redirect loop.
    if (p === '/admin/timer' || p === '/admin/timer/') {
      return env.ASSETS.fetch(new Request(new URL('/admin/timer/', url), request));
    }
    return env.ASSETS.fetch(request);
  }

  // 3-32 — the admin API, behind Access. One guard for the whole prefix.
  if (seg[0] === 'api' && seg[1] === 'admin') {
    const auth = await requireAccess(request, env);
    if (auth instanceof Response) return auth;
    return adminApi(request, env, url, seg);
  }

  // 33-36 — the overlay surfaces, gated by the overlay token.
  if (p.startsWith('/o/')) return overlay(request, env, url, seg);

  // 37-42 — the Stream Deck control surface, gated by the control token.
  if (p.startsWith('/c/')) return control(request, env, seg);

  // 43 — the R2 cover serve.
  if (p.startsWith('/covers/')) return cover(request, env, p);

  // 44 — everything else: the asset store, which also produces the 404.
  return env.ASSETS.fetch(request);
}

// ---------------------------------------------------------------------------------------------
// /api/admin/* — routes 3-32
// ---------------------------------------------------------------------------------------------

async function adminApi(request: Request, env: Env, url: URL, seg: string[]): Promise<Response> {
  const m = request.method;
  const a = seg[2];
  // The clock's whole admin surface lives under one prefix and one handler.
  if (a === 'timer') return timerApi(request, env, seg);

  // POST /api/admin/simulate {kind} — rehearse one overlay beat in OBS. Pure broadcast: nothing
  // is written, no seq moves, the overlays snap back to the real state by themselves.
  if (a === 'simulate' && seg.length === 3) {
    if (m !== 'POST') return methodNotAllowed('POST');
    const body = await readJson(request);
    const kind = typeof body?.kind === 'string' ? body.kind : '';
    if (kind === 'donation') { await timerStub(env).simulateDonation(); return json({ ok: true }); }
    if (kind !== 'win' && kind !== 'won' && kind !== 'loss') return err(400, 'bad_kind');
    await stub(env).simulate(kind);
    return json({ ok: true });
  }

  const b = seg[3];
  const c = seg[4];

  if (seg.length === 3) {
    // 3 — the whole admin bootstrap payload.
    if (a === 'state') {
      if (m !== 'GET') return methodNotAllowed('GET');
      const s = stub(env);
      const [state, tokens] = await Promise.all([s.snapshot(), s.tokens()]);
      if (state.sessionId === null) {
        return json({ state, session: null, sessionGames: [], tokens });
      }
      const [session, games] = await Promise.all([
        loadSession(env, state.sessionId),
        loadSessionGames(env, state.sessionId),
      ]);
      return json({
        state,
        session: session === null ? null : toSessionRow(session),
        sessionGames: games.results,
        tokens,
      });
    }

    // 4 — the admin WebSocket. A 101 cannot come out of an RPC method, so it goes through
    // stub.fetch(); role is set here and a client-supplied one is overwritten (SPEC 4.1).
    if (a === 'ws') {
      if (m !== 'GET') return methodNotAllowed('GET');
      const doUrl = new URL(url);
      doUrl.searchParams.set('role', 'admin');
      return stub(env).fetch(new Request(doUrl, request));
    }

    // 5 / 6 — the game library.
    if (a === 'games') {
      if (m === 'GET') {
        const r = await env.DB.prepare(`SELECT ${GAME_COLS} FROM games ORDER BY name`).all<Game>();
        return json(r.results);
      }
      if (m === 'POST') return createGame(request, env);
      return methodNotAllowed('GET, POST');
    }

    // 10 — IGDB search.
    if (a === 'igdb') {
      if (m !== 'GET') return methodNotAllowed('GET');
      const q = url.searchParams.get('q');
      if (q === null || q.length < 1 || q.length > MAX_NAME_LEN) return err(400, 'bad_query');
      let token: string;
      try {
        token = await stub(env).igdbToken();
      } catch (e) {
        // No app token: credentials unset, or Twitch unreachable (SPEC 5.2 #10).
        logError('GET /api/admin/igdb (token)', e);
        return err(502, 'igdb_unavailable', 'no app token');
      }
      try {
        return json({ games: await searchGames(env, token, q) });
      } catch (e) {
        if (e instanceof IgdbSearchError) {
          return err(e.status, e.status === 503 ? 'igdb_rate_limited' : 'igdb_unavailable');
        }
        throw e;
      }
    }

    // 11 / 12 — sessions.
    if (a === 'sessions') {
      if (m === 'GET') {
        const r = await env.DB.prepare(
          `SELECT s.id, s.title, s.loop, s.stop_after_current, s.status, s.started_at, s.ended_at,
                  (SELECT COUNT(*) FROM session_games sg WHERE sg.session_id = s.id) AS gameCount
             FROM sessions s ORDER BY s.created_at DESC`,
        ).all<SessionDbRow & { gameCount: number }>();
        return json(r.results.map((s) => ({ ...toSessionRow(s), gameCount: s.gameCount })));
      }
      if (m === 'POST') {
        const body = await readJson(request);
        const title = strField(body, 'title')?.trim() ?? '';
        const loop = boolField(body, 'loop');
        if (title.length < 1 || loop === null) return err(400, 'bad_body');
        const row = await env.DB.prepare(
          `INSERT INTO sessions (title, loop, created_at) VALUES (?1, ?2, ?3)
           RETURNING id, title, loop, stop_after_current, status, started_at, ended_at`,
        )
          .bind(title, loop ? 1 : 0, Date.now())
          .first<SessionDbRow>();
        if (row === null) return err(503, 'unavailable', 'insert returned no row');
        return json(toSessionRow(row));
      }
      return methodNotAllowed('GET, POST');
    }

    // 31 — the copy-ready overlay / recap / control URLs.
    if (a === 'tokens') {
      if (m !== 'GET') return methodNotAllowed('GET');
      const t = await stub(env).tokens();
      return json({ ...t, urls: tokenUrls(url, t.overlay, t.control) });
    }
  }

  if (seg.length === 4) {
    // 6b — re-ingest every missing IGDB cover in one call. Games created while ingest was
    // broken (or IGDB was down) sit with igdb_id set and cover_key NULL forever otherwise.
    if (a === 'games' && b === 'repair-covers') {
      if (m !== 'POST') return methodNotAllowed('POST');
      return repairCovers(env);
    }

    // 7 / 8 — one library game.
    if (a === 'games') {
      const id = pathId(b);
      if (id === null) return notFound();
      if (m === 'PATCH') return patchGame(request, env, id);
      if (m === 'DELETE') return deleteGame(env, id);
      return methodNotAllowed('PATCH, DELETE');
    }

    // 13 / 14 / 15 — one session.
    if (a === 'sessions') {
      const id = pathId(b);
      if (id === null) return notFound();
      if (m === 'GET') {
        const [session, games] = await Promise.all([loadSession(env, id), loadSessionGames(env, id)]);
        if (session === null) return notFound();
        return json({ session: toSessionRow(session), sessionGames: games.results });
      }
      if (m === 'PATCH') return patchSession(request, env, id);
      if (m === 'DELETE') {
        const status = await sessionStatus(env, id);
        if (status === null) return notFound();
        if (status === 'live') return err(409, 'session_live');   // end it first, never mid-run
        // Explicit child-first order in one transaction: events.session_game_id is ON DELETE
        // RESTRICT, so leaning on the sessions cascade would trip over the log's rows.
        await env.DB.batch([
          env.DB.prepare('DELETE FROM events WHERE session_id = ?1').bind(id),
          env.DB.prepare('DELETE FROM session_games WHERE session_id = ?1').bind(id),
          env.DB.prepare('DELETE FROM sessions WHERE id = ?1').bind(id),
        ]);
        // The DO's cached ENDED state survives the D1 delete — the overlay would keep naming a
        // session that no longer exists. Replay from D1 (-> idle) when it points at this one.
        try {
          const s = stub(env);
          if ((await s.snapshot()).sessionId === id) await s.rehydrate();
        } catch (e) {
          logError('DELETE /api/admin/sessions/:id (rehydrate)', e);   // D1 already committed
        }
        return json({ ok: true });
      }
      return methodNotAllowed('GET, PATCH, DELETE');
    }

    // 21-27 — the control turns.
    if (a === 'control' && b !== undefined) {
      if (m !== 'POST') return methodNotAllowed('POST');
      return adminControl(request, env, b);
    }

    // 32 — token rotation.
    if (a === 'tokens' && b === 'rotate') {
      if (m !== 'POST') return methodNotAllowed('POST');
      const which = strField(await readJson(request), 'which');
      if (which !== 'overlay' && which !== 'control' && which !== 'both') return err(400, 'bad_which');
      const t = await stub(env).rotateTokens(which);
      return json({ ...t, urls: tokenUrls(url, t.overlay, t.control) });
    }
  }

  if (seg.length === 5) {
    // 9 — a manually uploaded cover.
    if (a === 'games' && c === 'cover') {
      const id = pathId(b);
      if (id === null) return notFound();
      if (m !== 'POST') return methodNotAllowed('POST');
      return uploadCover(request, env, id);
    }

    if (a === 'sessions') {
      const id = pathId(b);
      if (id === null) return notFound();

      // 16 / 17 — the play list.
      if (c === 'games') {
        if (m === 'POST') return addSessionGame(request, env, id);
        if (m === 'PUT') return reorderSessionGames(request, env, id);
        return methodNotAllowed('POST, PUT');
      }

      // 20 — go live.
      if (c === 'start') {
        if (m !== 'POST') return methodNotAllowed('POST');
        let res: ControlResult;
        try {
          res = await stub(env).start(id);
        } catch (e) {
          logError('POST /api/admin/sessions/:id/start', e);
          return err(503, 'unavailable');
        }
        if ('error' in res) {
          // SPEC 5.2 #20 lists 404 and 409 (empty_session / already_live / not_draft) — plan()'s
          // `no_live_session` for this action means "no session with that id", i.e. the 404.
          if (res.error === 'no_live_session') return notFound();
          return controlError('POST /api/admin/sessions/:id/start', res.error);
        }
        return json({ state: res });
      }

      // 28 — the recap object.
      if (c === 'recap') {
        if (m !== 'GET') return methodNotAllowed('GET');
        if (!(await hasRecap(env, id))) return notFound();
        return json(await loadRecap(env, id));
      }

      // 29 / 30 — the exports for the YouTube edit.
      if (c === 'export.json') {
        if (m !== 'GET') return methodNotAllowed('GET');
        const [session, games] = await Promise.all([loadSession(env, id), loadSessionGames(env, id)]);
        // A draft has no recap to embed (see hasRecap) — checked on the row already in hand.
        if (session === null || session.status === 'draft') return notFound();
        const [recap, events] = await Promise.all([loadRecap(env, id), loadEvents(env, id)]);
        return attachment(
          JSON.stringify({
            session: toSessionRow(session),
            games: games.results,
            recap,
            events: serialiseEventsJson(events.results),
          }),
          'application/json',
          `session-${id}.json`,
        );
      }
      if (c === 'export.csv') {
        if (m !== 'GET') return methodNotAllowed('GET');
        if ((await sessionStatus(env, id)) === null) return notFound();
        const events = await loadEvents(env, id);
        // eventsToCsv() already emits the BOM and \r\n line endings (SPEC 3.4).
        return attachment(eventsToCsv(events.results), 'text/csv; charset=utf-8', `session-${id}.csv`);
      }
    }
  }

  // 18 / 19 — one play-list entry.
  if (seg.length === 6 && a === 'sessions' && c === 'games') {
    const id = pathId(b);
    const sgid = pathId(seg[5]);
    if (id === null || sgid === null) return notFound();
    if (m === 'PATCH') return patchSessionGame(request, env, id, sgid);
    if (m === 'DELETE') return deleteSessionGame(env, id, sgid);
    return methodNotAllowed('PATCH, DELETE');
  }

  return notFound();
}

/**
 * BUILD_PROMPT 7.5's copy buttons: absolute, paste-into-OBS URLs, built from the origin the
 * request arrived on — the deployed custom domain in production.
 *
 * `wrangler dev` is the one caller that cannot be trusted to tell the truth here: with `routes`
 * configured it rewrites the incoming request's URL *and* its Host, Origin and Referer headers
 * to the route's hostname (verified: every one of them reads `replace_me.example.de` locally),
 * so no header survives to recover `localhost:8787` from inside the Worker. That is why the
 * `dev` script in package.json passes `--host localhost:8787` — it makes request.url match the
 * browser's address bar, which is the only place this can be fixed.
 */
function tokenUrls(url: URL, overlay: string, ctl: string) {
  return {
    overlay: `${url.origin}/o/${overlay}`,
    recap: `${url.origin}/o/${overlay}/recap`,
    timer: `${url.origin}/o/${overlay}/timer`,
    control: `${url.origin}/c/${ctl}`,
  };
}

function attachment(body: string, contentType: string, filename: string): Response {
  return new Response(body, {
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'no-store',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
}

// ---------------------------------------------------------------------------------------------
// routes 6-9 — the game library
// ---------------------------------------------------------------------------------------------

async function createGame(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  const name = strField(body, 'name')?.trim() ?? '';
  if (name.length < 1 || name.length > MAX_NAME_LEN) return err(400, 'bad_name');
  const mode = body?.['default_mode'];
  if (!isMode(mode)) return err(400, 'bad_default_mode');

  const rawIgdb = body?.['igdb_id'];
  const igdbId = rawIgdb === undefined || rawIgdb === null ? null : intField(body, 'igdb_id');
  if (rawIgdb !== undefined && rawIgdb !== null && igdbId === null) return err(400, 'bad_igdb_id');

  const rawImage = body?.['igdb_cover_image_id'];
  const imageId = strField(body, 'igdb_cover_image_id');
  if (rawImage !== undefined && rawImage !== null && (imageId === null || imageId.length === 0)) {
    return err(400, 'bad_igdb_cover_image_id');
  }

  // Explicit pre-check rather than catching the games_igdb_uq violation: D1 error strings are
  // not a stable contract, and route 6 owes the admin panel a deterministic 409.
  if (igdbId !== null) {
    const dup = await env.DB.prepare('SELECT id FROM games WHERE igdb_id = ?1').bind(igdbId).first();
    if (dup !== null) return err(409, 'igdb_id_exists');
  }

  const game = await env.DB.prepare(
    `INSERT INTO games (name, igdb_id, cover_key, default_mode, created_at)
     VALUES (?1, ?2, NULL, ?3, ?4) RETURNING ${GAME_COLS}`,
  )
    .bind(name, igdbId, mode, Date.now())
    .first<Game>();
  if (game === null) return err(503, 'unavailable', 'insert returned no row');

  if (imageId === null || imageId.length === 0) return json(game);

  const coverKey = await ingestCover(env, imageId);
  if (coverKey === null) {
    // SPEC 5.2 #6: the game IS created with cover_key null, and the route still reports the 502.
    return err(502, 'cover_fetch_failed', 'game created without cover');
  }
  await env.DB.prepare('UPDATE games SET cover_key = ?1 WHERE id = ?2').bind(coverKey, game.id).run();
  return json({ ...game, cover_key: coverKey });
}

async function repairCovers(env: Env): Promise<Response> {
  const rows = (
    await env.DB.prepare('SELECT id, igdb_id FROM games WHERE igdb_id IS NOT NULL AND cover_key IS NULL')
      .all<{ id: number; igdb_id: number }>()
  ).results;
  if (rows.length === 0) return json({ repaired: 0, failed: 0 });

  let token: string;
  try {
    token = await stub(env).igdbToken();
  } catch (e) {
    logError('POST /api/admin/games/repair-covers (token)', e);
    return err(502, 'igdb_unavailable', 'no app token');
  }
  let covers: Map<number, string>;
  try {
    covers = await coverIdsForGames(env, token, rows.map((r) => r.igdb_id));
  } catch (e) {
    if (e instanceof IgdbSearchError) {
      return err(e.status, e.status === 503 ? 'igdb_rate_limited' : 'igdb_unavailable');
    }
    throw e;
  }

  let repaired = 0;
  for (const row of rows) {
    const imageId = covers.get(row.igdb_id);
    if (imageId === undefined) continue;   // the IGDB entry genuinely has no cover
    const key = await ingestCover(env, imageId);
    if (key === null) continue;
    await env.DB.prepare('UPDATE games SET cover_key = ?1 WHERE id = ?2').bind(key, row.id).run();
    await gameConfigChanged(env, row.id);  // a live session showing this game repaints its cover
    repaired += 1;
  }
  return json({ repaired, failed: rows.length - repaired });
}

async function patchGame(request: Request, env: Env, id: number): Promise<Response> {
  const body = await readJson(request);
  const rawName = body?.['name'];
  const name = rawName === undefined ? null : strField(body, 'name')?.trim() ?? null;
  if (rawName !== undefined && (name === null || name.length < 1 || name.length > MAX_NAME_LEN)) {
    return err(400, 'bad_name');
  }
  const rawMode = body?.['default_mode'];
  if (rawMode !== undefined && !isMode(rawMode)) return err(400, 'bad_default_mode');
  const mode = isMode(rawMode) ? rawMode : null;   // null -> COALESCE keeps the stored value

  // One statement, no dynamic SQL: an absent field binds NULL and COALESCE keeps the old value.
  const row = await env.DB.prepare(
    `UPDATE games SET name = COALESCE(?1, name), default_mode = COALESCE(?2, default_mode)
      WHERE id = ?3 RETURNING ${GAME_COLS}`,
  )
    .bind(name, mode, id)
    .first<Game>();
  if (row === null) return notFound();
  await gameConfigChanged(env, id);
  return json(row);
}

async function deleteGame(env: Env, id: number): Promise<Response> {
  const game = await env.DB.prepare('SELECT cover_key FROM games WHERE id = ?1')
    .bind(id)
    .first<{ cover_key: string | null }>();
  if (game === null) return notFound();
  // games.id is ON DELETE RESTRICT from session_games. The SELECT answers the common case; the
  // catch covers the insert that lands between the two statements, which the FK then refuses.
  // No transaction: D1 rejects BEGIN and batch() is the wrong tool for one DELETE — integrity
  // is the FK's job either way, this is only about answering the documented 409 (SPEC 5.2 #8)
  // instead of letting the throw become a 500 `internal` in the top-level catch.
  const used = await env.DB.prepare('SELECT 1 FROM session_games WHERE game_id = ?1 LIMIT 1')
    .bind(id)
    .first();
  if (used !== null) return err(409, 'in_use');
  try {
    await env.DB.prepare('DELETE FROM games WHERE id = ?1').bind(id).run();
  } catch (e) {
    if (!isFkFailure(e)) throw e;
    return err(409, 'in_use');
  }
  if (game.cover_key !== null) await env.COVERS.delete(game.cover_key);
  return json({ ok: true });
}

async function uploadCover(request: Request, env: Env, id: number): Promise<Response> {
  const game = await env.DB.prepare('SELECT cover_key FROM games WHERE id = ?1')
    .bind(id)
    .first<{ cover_key: string | null }>();
  if (game === null) return notFound();

  const ct = (request.headers.get('Content-Type') ?? '').split(';')[0]?.trim() ?? '';
  const ext = ct === 'image/jpeg' ? 'jpg' : ct === 'image/png' ? 'png' : ct === 'image/webp' ? 'webp' : null;
  if (ext === null) return err(400, 'bad_content_type');

  // Reject on the declared length before buffering 2 MB of it.
  const declared = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > MAX_COVER_BYTES) return err(413, 'too_large');
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength === 0) return err(400, 'empty_body');
  if (bytes.byteLength > MAX_COVER_BYTES) return err(413, 'too_large');

  // A bare object name with no '/' — one spelling in games.cover_key, the R2 write, the <img
  // src> and route 43 (SPEC 11 resolution 15). Random, so a re-upload can never collide with
  // the object a browser has already cached immutably for a year.
  const coverKey = `${crypto.randomUUID()}.${ext}`;
  await env.COVERS.put(coverKey, bytes, { httpMetadata: { contentType: ct } });
  await env.DB.prepare('UPDATE games SET cover_key = ?1 WHERE id = ?2').bind(coverKey, id).run();
  // ponytail: delete the replaced object inline instead of leaving R2 to grow an orphan per
  // re-upload. Ceiling: if the DB write above failed we would already have thrown, so there is
  // no window where the row points at a deleted object.
  if (game.cover_key !== null && game.cover_key !== coverKey) await env.COVERS.delete(game.cover_key);
  await gameConfigChanged(env, id);
  return json({ cover_key: coverKey });
}

// ---------------------------------------------------------------------------------------------
// routes 14-19 — sessions and their play lists
// ---------------------------------------------------------------------------------------------

async function patchSession(request: Request, env: Env, id: number): Promise<Response> {
  const body = await readJson(request);
  const rawTitle = body?.['title'];
  const title = rawTitle === undefined ? null : strField(body, 'title')?.trim() ?? null;
  if (rawTitle !== undefined && (title === null || title.length < 1)) return err(400, 'bad_title');
  const rawLoop = body?.['loop'];
  if (rawLoop !== undefined && typeof rawLoop !== 'boolean') return err(400, 'bad_loop');
  const loop = rawLoop === undefined ? null : rawLoop === true ? 1 : 0;

  const row = await env.DB.prepare(
    `UPDATE sessions SET title = COALESCE(?1, title), loop = COALESCE(?2, loop)
      WHERE id = ?3
      RETURNING id, title, loop, stop_after_current, status, started_at, ended_at`,
  )
    .bind(title, loop, id)
    .first<SessionDbRow>();
  if (row === null) return notFound();
  await configChangedIfLive(env, row.status);
  return json(toSessionRow(row));
}

async function addSessionGame(request: Request, env: Env, id: number): Promise<Response> {
  const status = await sessionStatus(env, id);
  if (status === null) return notFound();
  const body = await readJson(request);
  const gameId = intField(body, 'game_id');
  if (gameId === null) return err(400, 'bad_game_id');
  const rawMode = body?.['mode'];
  if (rawMode !== undefined && rawMode !== null && !isMode(rawMode)) return err(400, 'bad_mode');
  const mode = isMode(rawMode) ? rawMode : null;   // null = inherit games.default_mode

  // games.id is ON DELETE RESTRICT, so a bad game_id would otherwise surface as a raw FK error.
  const game = await env.DB.prepare('SELECT id FROM games WHERE id = ?1').bind(gameId).first();
  if (game === null) return err(400, 'unknown_game_id');

  const inserted = await env.DB.prepare(
    `INSERT INTO session_games (session_id, game_id, order_index, mode, created_at)
     VALUES (?1, ?2, COALESCE((SELECT MAX(order_index) + 1 FROM session_games WHERE session_id = ?1), 1), ?3, ?4)
     RETURNING id`,
  )
    .bind(id, gameId, mode, Date.now())
    .first<{ id: number }>();
  if (inserted === null) return err(503, 'unavailable', 'insert returned no row');

  const row = await env.DB.prepare(SQL_SESSION_GAME_ONE).bind(inserted.id).first<SessionGameRow>();
  await configChangedIfLive(env, status);
  return row === null ? err(503, 'unavailable', 'insert not readable') : json(row);
}

async function reorderSessionGames(request: Request, env: Env, id: number): Promise<Response> {
  const status = await sessionStatus(env, id);
  if (status === null) return notFound();

  const raw = (await readJson(request))?.['order'];
  if (!Array.isArray(raw)) return err(400, 'bad_order');
  const order = raw.filter((n): n is number => typeof n === 'number' && Number.isInteger(n));
  if (order.length === 0 || order.length !== raw.length) return err(400, 'bad_order');

  // The submitted array must be exactly this session's ids, once each: no missing, no extra,
  // no duplicate, nothing foreign.
  const have = await env.DB.prepare('SELECT id FROM session_games WHERE session_id = ?1')
    .bind(id)
    .all<{ id: number }>();
  const ids = new Set(have.results.map((r) => r.id));
  if (order.length !== ids.size || new Set(order).size !== order.length) return err(400, 'bad_order');
  if (!order.every((sgid) => ids.has(sgid))) return err(400, 'bad_order');

  // SPEC 2.5f case 3: dragging the running game to the bottom would silently end the run (or
  // skip the rest of the lap) on its next completion. The admin UI disables that handle; this
  // is the backstop.
  if (status === 'live' && order.length > 1) {
    const state = await stub(env).snapshot();
    const current = state.current;
    if (state.phase === 'live' && current !== null && order[order.length - 1] === current.sessionGameId) {
      return err(400, 'current_game_last');
    }
  }

  // W4 (SPEC 3.2): one batch, position i from the client-supplied array. session_games has no
  // unique index on (session_id, order_index) precisely so the transient collisions mid-batch
  // are legal (SPEC 3.1).
  const upd = env.DB.prepare('UPDATE session_games SET order_index = ?1 WHERE id = ?2 AND session_id = ?3');
  await env.DB.batch(order.map((sgid, i) => upd.bind(i + 1, sgid, id)));

  const rows = await loadSessionGames(env, id);
  await configChangedIfLive(env, status);
  return json(rows.results);
}

async function patchSessionGame(request: Request, env: Env, id: number, sgid: number): Promise<Response> {
  const status = await sessionStatus(env, id);
  if (status === null) return notFound();
  const body = await readJson(request);
  // `mode` must be PRESENT; its value may be null, which means "inherit games.default_mode".
  if (body === null || !('mode' in body)) return err(400, 'bad_mode');
  const raw = body['mode'];
  if (raw !== null && !isMode(raw)) return err(400, 'bad_mode');
  const mode = isMode(raw) ? raw : null;

  const res = await env.DB.prepare('UPDATE session_games SET mode = ?1 WHERE id = ?2 AND session_id = ?3')
    .bind(mode, sgid, id)
    .run();
  if (res.meta.changes === 0) return notFound();
  const row = await env.DB.prepare(SQL_SESSION_GAME_ONE).bind(sgid).first<SessionGameRow>();
  if (row === null) return notFound();
  await configChangedIfLive(env, status);
  return json(row);
}

async function deleteSessionGame(env: Env, id: number, sgid: number): Promise<Response> {
  const status = await sessionStatus(env, id);
  if (status === null) return notFound();
  // G1 (SPEC 3.2 / 2.5e): a row any event points at can never be deleted. events.session_game_id
  // is ON DELETE RESTRICT as the backstop; this SELECT is what makes it a clean 409.
  const used = await env.DB.prepare('SELECT 1 FROM events WHERE session_game_id = ?1 LIMIT 1')
    .bind(sgid)
    .first();
  if (used !== null) return err(409, 'already_played');
  let res: D1Response;
  try {
    res = await env.DB.prepare('DELETE FROM session_games WHERE id = ?1 AND session_id = ?2')
      .bind(sgid, id)
      .run();
  } catch (e) {
    // Same race as route 8: the live session can append an event referencing this row between
    // the SELECT and the DELETE, and the FK then refuses it. 409, not a 500.
    if (!isFkFailure(e)) throw e;
    return err(409, 'already_played');
  }
  if (res.meta.changes === 0) return notFound();
  await configChangedIfLive(env, status);
  return json({ ok: true });
}

// ---------------------------------------------------------------------------------------------
// routes 21-27 — the control turns
// ---------------------------------------------------------------------------------------------

const ADMIN_CONTROL: Record<string, ControlAction> = {
  win: 'win',
  loss: 'loss',
  skip: 'skip',
  undo: 'undo',
  'stop-now': 'stop_now',
};

// Routes 21-26 all end the same way: 503 if the DO could not commit, 409 if it refused,
// `{state}` otherwise.
async function runControl(scope: string, call: () => Promise<ControlResult>): Promise<Response> {
  let res: ControlResult;
  try {
    res = await call();
  } catch (e) {
    // SPEC 4.9: if the D1 batch throws, nothing is committed, the DO's cached state is untouched
    // and the request is a 503. The streamer taps again — there is no divergence to reconcile.
    logError(scope, e);
    return err(503, 'unavailable');
  }
  if ('error' in res) return controlError(scope, res.error);
  return json({ state: res });
}

async function adminControl(request: Request, env: Env, name: string): Promise<Response> {
  const scope = `POST /api/admin/control/${name}`;

  // 27 — the SPEC 8.7 "Resume" button: drop the DO's state+cfg cache and replay D1. No body,
  // and no action_id: it writes no event, so there is nothing for the replay guard to coalesce.
  if (name === 'rehydrate') return runControl(scope, () => stub(env).rehydrate());

  // Object.hasOwn, not a bare index: `ADMIN_CONTROL['__proto__']` and `['constructor']` return
  // inherited members rather than undefined, so a bare lookup would skip the 404 below and
  // carry Object.prototype into the control path as if it were an action name.
  const action = Object.hasOwn(ADMIN_CONTROL, name) ? ADMIN_CONTROL[name] : undefined;
  if (action === undefined && name !== 'stop-after-current') return notFound();

  // SPEC 4.10: one uuid per button press, reused verbatim on every retry of that press, so a
  // response lost on a 4G hop cannot turn one WIN into two.
  const body = await readJson(request);
  const actionId = strField(body, 'action_id');
  if (actionId === null || !UUID_RE.test(actionId)) return err(400, 'bad_action_id');

  // 26 — the idempotent SET (never a toggle, SPEC 2.5h). Also patches the DO's cached cfg.
  if (action === undefined) {
    const on = boolField(body, 'on');
    if (on === null) return err(400, 'bad_on');
    return runControl(scope, () => stub(env).setStopAfterCurrent(on, actionId));
  }

  // 21-25 — win / loss / skip / undo / stop-now.
  return runControl(scope, () => stub(env).control(action, actionId));
}

// ---------------------------------------------------------------------------------------------
// routes 33-36 — the overlay surfaces
// ---------------------------------------------------------------------------------------------

async function overlay(request: Request, env: Env, url: URL, seg: string[]): Promise<Response> {
  const token = seg[1];
  if (token === undefined) return notFound();

  // The timer widget: its own OBS source, its own DO, the SAME overlay token — one credential to
  // rotate for both graphics, because it is one OBS setup operated by one person.
  if (seg[2] === 'timer') {
    if (request.method !== 'GET') return methodNotAllowed('GET');
    if (seg.length === 3) {
      const role = await authTokenRole(env, token, false);   // shell: uncharged, as routes 33/34
      if (role !== 'overlay') return notFound();
      return noStore(await env.ASSETS.fetch(new Request(new URL('/timer', url), request)));
    }
    if (seg.length === 4 && seg[3] === 'ws') {
      // Validated HERE rather than inside the DO: TimerRun holds no tokens, so there is exactly
      // one token store (LiveRun's) and nothing to keep in sync.
      const role = await authTokenRole(env, token, true);
      if (role === 'limited') return rateLimited();
      if (role !== 'overlay') return notFound();
      return timerStub(env).fetch(new Request(url, request));
    }
    // The donation sound. Uncharged like the shell: it loads exactly when the shell does, and an
    // OBS restart must not spend the rate bucket on an <audio> preload.
    if (seg.length === 4 && seg[3] === 'sound') {
      const role = await authTokenRole(env, token, false);
      if (role !== 'overlay') return notFound();
      const obj = await env.COVERS.get(DONATION_SOUND_KEY);
      if (obj === null) return notFound();
      const headers = new Headers();
      obj.writeHttpMetadata(headers);
      headers.set('Cache-Control', 'no-store');
      return new Response(obj.body, { headers });
    }
    return notFound();
  }

  if (seg.length > 3) return notFound();
  const tail = seg[2];

  // 36 — the overlay WebSocket. The token is validated INSIDE LiveRun.fetch() (SPEC 4.1), which
  // also owns the 426 and the 429; a 101 cannot be returned from an RPC method.
  if (tail === 'ws') {
    if (request.method !== 'GET') return methodNotAllowed('GET');
    const doUrl = new URL(url);
    doUrl.searchParams.set('role', 'overlay');
    return stub(env).fetch(new Request(doUrl, request));
  }

  if (request.method !== 'GET') return methodNotAllowed('GET');

  // 33 / 34 — the two HTML shells. authToken(t, false): SPEC 6.3 deliberately does NOT charge
  // the rate bucket here, because an OBS restart with several browser sources (or one drag of
  // the SPEC 8.5 preview slider) would otherwise empty it and 429 the next Stream Deck press.
  // The shells carry no state, no token and no secret, so there is nothing for it to protect.
  if (tail === undefined || tail === 'recap') {
    const role = await authTokenRole(env, token, false);
    if (role !== 'overlay') return notFound();
    // The CANONICAL path, never '/overlay.html': html_handling "auto-trailing-slash" answers an
    // explicit .html path with a 307 to the extension-less form, and OBS would follow it to
    // /overlay — a URL with NO token in it, so overlay.js could never build its /o/<token>/ws
    // address and the browser source would stay a blank box. Same trap as route 2 above.
    const file = tail === 'recap' ? '/recap' : '/overlay';
    return noStore(await env.ASSETS.fetch(new Request(new URL(file, url), request)));
  }

  // 35 — the recap scene's data. Charged, because it is a real read behind the secret.
  if (tail === 'recap.json') {
    const role = await authTokenRole(env, token, true);
    if (role === 'limited') return rateLimited();
    if (role !== 'overlay') return notFound();
    const want = url.searchParams.get('session') ?? 'latest';
    const id = await resolveRecapSession(env, want);
    if (id === null) return notFound();
    return json(await loadRecap(env, id));
  }

  return notFound();
}

/**
 * SPEC 5.2 #35 / SPEC 10 item 4: `latest` is the live session if there is one, else the newest
 * ended one. That precedence is deliberate — a live session is always the one on camera, so the
 * ended-first reading would render last week's numbers any time the streamer switches to the
 * recap scene before pressing "Jetzt stoppen".
 */
async function resolveRecapSession(env: Env, want: string): Promise<number | null> {
  if (want !== 'latest') {
    const id = pathId(want);
    if (id === null) return null;
    // A draft is "no session" here, exactly like an id that names no row (see hasRecap).
    return (await hasRecap(env, id)) ? id : null;
  }
  // `status = 'live'` sorts 1 before 0, so the live session wins outright; among ended ones the
  // newest end time wins. One statement, so the precedence cannot depend on UNION evaluation order.
  const row = await env.DB.prepare(
    `SELECT id FROM sessions
      WHERE status IN ('live', 'ended')
      ORDER BY (status = 'live') DESC, COALESCE(ended_at, started_at, created_at) DESC
      LIMIT 1`,
  ).first<{ id: number }>();
  return row?.id ?? null;
}

// ---------------------------------------------------------------------------------------------
// routes 37-42 — the Stream Deck control surface
// ---------------------------------------------------------------------------------------------

// ponytail: GET with side effects, deliberately. Stream Deck's "Open Website" action only issues
// a GET, so win/loss/skip/undo have to be GET-able or the hotkey feature does not exist.
// Mitigation: (1) a 160-bit secret path segment, so the URL is the credential and is not
// guessable; (2) a token-bucket rate limit in DO storage (20 burst, 2/s) in front of the token
// comparison itself; (3) zero cookies and zero Authorization headers involved, so CSRF has
// nothing to ride on — a forged cross-site GET carries no ambient credential and a third party
// cannot construct the URL. Upgrade path: if Stream Deck ever learns POST, flip the method and
// delete this comment.
//
// The same tradeoff's other half (SPEC 4.10): a GET has no body to carry an action_id, so an
// identical action arriving within 600 ms of the last one is coalesced into a no-op that answers
// "dup". The cost is that the second press of a deliberate double-tap is lost — which is the
// right way round, because the alternative is a double-counted loss with no redo to undo it.
async function control(request: Request, env: Env, seg: string[]): Promise<Response> {
  const token = seg[1];
  const name = seg[2];
  if (token === undefined || name === undefined || seg.length !== 3) return notFound();
  if (request.method !== 'GET') return methodNotAllowed('GET');

  const role = await authTokenRole(env, token, true);
  if (role === 'limited') return rateLimited();
  // An overlay token must never reach a control action: pasting the overlay URL into chat can
  // then never hand out control (BUILD_PROMPT 5.1).
  if (role !== 'control') return notFound();

  // The clock's Stream Deck buttons. Flat names (`timer-pause`, not `timer/pause`) so the
  // existing three-segment shape holds.
  if (name === 'timer-pause' || name === 'timer-resume' || name === 'plus1h') {
    return timerDeck(env, name);
  }

  const scope = `GET /c/:t/${name}`;
  let res: ControlResult;
  try {
    if (name === 'stop-loop') {
      // Sets, never toggles: a hotkey that means two different things depending on hidden state
      // is a live-stream bug (SPEC 2.5h).
      res = await stub(env).setStopAfterCurrent(true);
    } else {
      // `next` is an alias of `skip`; the Stream Deck labels differ, the action does not.
      const action = name === 'next' ? 'skip' : name;
      if (action !== 'win' && action !== 'loss' && action !== 'skip' && action !== 'undo') {
        return notFound();
      }
      res = await stub(env).control(action);
    }
  } catch (e) {
    logError(scope, e);
    return textNoStore(null, 503);
  }

  if ('error' in res) {
    // SPEC 4.10: the replay-guard no-op is a 200, not a refusal.
    if (res.error === 'dup') return textNoStore('dup');
    // SPEC 5.4: a 409 on /c/* answers "noop" so a Stream Deck button visibly does nothing
    // rather than silently succeeding.
    if (REJECTS.includes(res.error)) return textNoStore('noop', 409);
    logError(scope, new Error(`unexpected control error: ${res.error}`));
    return textNoStore(null, 503);
  }
  return textNoStore('ok');
}

// ---------------------------------------------------------------------------------------------
// route 43 — the R2 cover serve
// ---------------------------------------------------------------------------------------------

async function cover(request: Request, env: Env, pathname: string): Promise<Response> {
  if (request.method !== 'GET') return methodNotAllowed('GET');

  let key: string;
  try {
    key = decodeURIComponent(pathname.slice('/covers/'.length));
  } catch {
    return notFound();   // a malformed escape is not a key
  }
  // SPEC 11 resolution 15: the key is a BARE object name. Anything with a separator or a dot
  // segment is a traversal attempt against the bucket, not a cover.
  if (key.length === 0 || key.length > MAX_COVER_KEY_LEN || key.includes('/') || key.includes('..')) {
    return notFound();
  }

  const obj = await env.COVERS.get(key);
  if (obj === null) return notFound();

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('ETag', obj.httpEtag);
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  return new Response(obj.body, { headers });
}

// ---------------------------------------------------------------------------------------------
// the clock's admin API (feature prompt §4)
//
// EVERY value the money model uses is a field here: campaign slugs, base hours, rate, cap,
// exclusions, poll interval, auto-pause and its threshold. Nothing campaign- or money-related is
// hardcoded in the Worker — the only constants in the whole feature are the GraphQL endpoint and
// its headers, in gofundme.ts.
// ---------------------------------------------------------------------------------------------

async function liveRunId(env: Env): Promise<number | null> {
  const row = await env.DB.prepare(TQ_RUN_LIVE_ID).first<{ id: number }>();
  return row?.id ?? null;
}

/**
 * The run being CONFIGURED: the live one if there is one, otherwise the newest draft.
 *
 * Not the same question as liveRunId(). Campaigns, exclusions and ledger entries are set up
 * BEFORE the clock starts — requiring a live run to add a campaign means you have to start the
 * countdown before you can say which campaign funds it, which is backwards. Only actions that
 * genuinely need a running clock (the Stream Deck's +1 Stunde) still demand `live`.
 */
async function currentRunId(env: Env): Promise<number | null> {
  const row = await env.DB.prepare(
    `SELECT id FROM timer_runs WHERE status IN ('live','draft')
      ORDER BY (status = 'live') DESC, created_at DESC LIMIT 1;`,
  ).first<{ id: number }>();
  return row?.id ?? null;
}

/** An integer or a refusal. The D1 CHECKs are the real boundary; this turns a violation into a
 *  400 with a useful message instead of a 503 from a constraint failure. */
function tInt(v: unknown, min: number): number | null {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min) return null;
  return v;
}

async function timerApi(request: Request, env: Env, seg: string[]): Promise<Response> {
  const m = request.method;
  const a = seg[3];
  const b = seg[4];
  const c = seg[5];

  // ---- GET /api/admin/timer/state : the whole page payload in one round trip ----
  if (a === 'state' && seg.length === 4) {
    if (m !== 'GET') return methodNotAllowed('GET');
    const runs = await env.DB.prepare(TQ_RUNS).all<Record<string, unknown>>();
    // Show the live run, else the newest draft, else the newest ENDED one — an ended run must
    // stay on the page so "Zurücksetzen" and "Lauf löschen" remain reachable. (currentRunId()
    // keeps the stricter live-or-draft rule for mutations.)
    const live = runs.results.find((r) => r.status === 'live')
      ?? runs.results.find((r) => r.status === 'draft')
      ?? runs.results[0] ?? null;
    const id = typeof live?.id === 'number' ? live.id : null;
    const [campaigns, donations, adjustments, snap, soundHead] = await Promise.all([
      id === null ? Promise.resolve({ results: [] }) : env.DB.prepare(TQ_CAMPAIGNS).bind(id).all<Record<string, unknown>>(),
      id === null ? Promise.resolve({ results: [] }) : env.DB.prepare(TQ_DONATIONS).bind(id).all<Record<string, unknown>>(),
      id === null ? Promise.resolve({ results: [] }) : env.DB.prepare(TQ_ADJUSTMENTS).bind(id).all<Record<string, unknown>>(),
      timerStub(env).snapshot(),
      env.COVERS.head(DONATION_SOUND_KEY),
    ]);
    return json({
      runs: runs.results, run: live,
      campaigns: campaigns.results, donations: donations.results, adjustments: adjustments.results,
      timer: snap.timer, pool: snap.pool, sound: soundHead !== null,
    });
  }

  // ---- the donation sound: one R2 object, uploaded here, played by the timer overlay ----
  // The key contains a '/' on purpose: route 43 rejects keys with a separator, so this object
  // is unreachable through /covers/* and cannot collide with any cover.
  if (a === 'sound' && seg.length === 4) {
    if (m === 'GET') {
      const obj = await env.COVERS.get(DONATION_SOUND_KEY);
      if (obj === null) return notFound();
      const headers = new Headers();
      obj.writeHttpMetadata(headers);
      headers.set('Cache-Control', 'no-store');   // replaceable, unlike the immutable covers
      return new Response(obj.body, { headers });
    }
    if (m === 'PUT') {
      const ct = (request.headers.get('Content-Type') ?? '').split(';')[0]?.trim() ?? '';
      if (!ct.startsWith('audio/')) return err(400, 'bad_content_type');
      const declared = Number(request.headers.get('Content-Length'));
      if (Number.isFinite(declared) && declared > MAX_SOUND_BYTES) return err(413, 'too_large');
      const bytes = await request.arrayBuffer();
      if (bytes.byteLength === 0) return err(400, 'empty_body');
      if (bytes.byteLength > MAX_SOUND_BYTES) return err(413, 'too_large');
      await env.COVERS.put(DONATION_SOUND_KEY, bytes, { httpMetadata: { contentType: ct } });
      return json({ ok: true });
    }
    if (m === 'DELETE') {
      await env.COVERS.delete(DONATION_SOUND_KEY);
      return json({ ok: true });
    }
    return methodNotAllowed('GET, PUT, DELETE');
  }

  // ---- GET /api/admin/timer/ws : the admin page's push channel. Same DO socket the overlay
  // uses (the DO broadcasts on every poll / control / config change), behind the same Access
  // guard as the rest of /api/admin. ----
  if (a === 'ws' && seg.length === 4) {
    if (m !== 'GET') return methodNotAllowed('GET');
    return timerStub(env).fetch(request);
  }

  // ---- runs ----
  if (a === 'runs') {
    if (seg.length === 4 && m === 'POST') {
      const body = await readJson(request);
      if (body === null) return err(400, 'bad_body');
      const title = typeof body.title === 'string' ? body.title.trim() : '';
      const base = tInt(body.base_ms, 0);
      const rate = tInt(body.cents_per_hour, 1);
      const cap = tInt(body.cap_ms, 1);
      if (title === '' || title.length > 80 || base === null || rate === null || cap === null) {
        return err(400, 'bad_body', 'title (1..80), base_ms >= 0, cents_per_hour >= 1, cap_ms >= 1');
      }
      const row = await env.DB.prepare(
        `INSERT INTO timer_runs (title, base_ms, cents_per_hour, cap_ms, created_at)
         VALUES (?1,?2,?3,?4,?5) RETURNING *;`,
      ).bind(title, base, rate, cap, Date.now()).first<Record<string, unknown>>();
      return json(row, 201);
    }

    const id = Number(b);
    if (!Number.isInteger(id)) return notFound();

    // PATCH: live-editable mid-run (§4). Only listed fields; anything else is ignored, not an error.
    if (seg.length === 5 && m === 'PATCH') {
      const body = await readJson(request);
      if (body === null) return err(400, 'bad_body');
      const sets: string[] = [];
      const vals: (string | number | null)[] = [];
      if (typeof body.title === 'string' && body.title.trim() !== '' && body.title.length <= 80) {
        sets.push(`title = ?${sets.length + 1}`); vals.push(body.title.trim());
      }
      for (const f of TIMER_INT_FIELDS) {
        if (!(f in body)) continue;
        const min = f === 'cents_per_hour' || f === 'cap_ms' ? 1 : f === 'poll_interval_ms' ? 5000 : 0;
        const v = tInt(body[f], min);
        if (v === null) return err(400, 'bad_body', `${f} must be an integer >= ${min}`);
        sets.push(`${f} = ?${sets.length + 1}`); vals.push(v);
      }
      if ('twitch_login' in body) {
        const t = body.twitch_login;
        if (t !== null && typeof t !== 'string') return err(400, 'bad_body', 'twitch_login');
        sets.push(`twitch_login = ?${sets.length + 1}`); vals.push(t === null || t === '' ? null : t.trim());
      }
      if (sets.length === 0) return err(400, 'bad_body', 'nothing to update');
      const row = await env.DB.prepare(
        `UPDATE timer_runs SET ${sets.join(', ')} WHERE id = ?${sets.length + 1} RETURNING *;`,
      ).bind(...vals, id).first<Record<string, unknown>>();
      if (row === null) return notFound();
      await timerStub(env).configChanged();
      return json(row);
    }

    if (seg.length === 6 && c === 'start' && m === 'POST') {
      const out = await timerStub(env).startRun(id);
      if ('error' in out) return err(409, String(out.error));
      return json({ timer: out });
    }

    // Reset: back to draft as if never started. The time log and its corrections go; the
    // config, campaigns and donations (with their exclusion flags) stay. Works on a live
    // run too — that IS the "start over" move mid-test. The DO's poll alarm self-stops:
    // pollOnce() returns null once no run is live.
    if (seg.length === 6 && c === 'reset' && m === 'POST') {
      const exists = await env.DB.prepare('SELECT id FROM timer_runs WHERE id = ?1').bind(id).first();
      if (exists === null) return notFound();
      await env.DB.batch([
        env.DB.prepare('DELETE FROM timer_events WHERE run_id = ?1').bind(id),
        env.DB.prepare('DELETE FROM adjustments WHERE run_id = ?1').bind(id),
        env.DB.prepare(`UPDATE timer_runs SET status = 'draft', started_at = NULL, ended_at = NULL WHERE id = ?1`).bind(id),
      ]);
      return json(await timerStub(env).rehydrate());
    }

    if (seg.length === 5 && m === 'DELETE') {
      const row = await env.DB.prepare('SELECT status FROM timer_runs WHERE id = ?1')
        .bind(id).first<{ status: string }>();
      if (row === null) return notFound();
      if (row.status === 'live') return err(409, 'run_live');   // end it first, never mid-run
      // timer_events, run_campaigns and adjustments all CASCADE from timer_runs; campaigns and
      // their donations survive on purpose (re-adding a campaign keeps every exclusion flag).
      await env.DB.prepare('DELETE FROM timer_runs WHERE id = ?1').bind(id).run();
      // The DO may hold this run's id and derived state in its cache — replay from D1.
      await timerStub(env).rehydrate();
      return json({ ok: true });
    }
    return methodNotAllowed('POST, PATCH, DELETE');
  }

  // ---- control: pause / resume / end (§5) ----
  if (a === 'control' && seg.length === 5) {
    if (m !== 'POST') return methodNotAllowed('POST');
    if (b !== 'pause' && b !== 'resume' && b !== 'end') return notFound();
    const body = await readJson(request);
    const actionId = typeof body?.action_id === 'string' ? body.action_id : undefined;
    const out = await timerStub(env).control(b, actionId);
    if ('error' in out) return err(409, String(out.error));
    return json({ timer: out });
  }

  // ---- campaigns: add a slug to the live run, or unlink one ----
  if (a === 'campaigns') {
    const runId = await currentRunId(env);
    if (runId === null) return err(409, 'no_run', 'Leg zuerst einen Lauf an.');

    if (seg.length === 4 && m === 'POST') {
      const body = await readJson(request);
      const slug = typeof body?.slug === 'string' ? body.slug.trim() : '';
      // The slug is the campaign path segment from gofundme.com/f/<slug> — never a full URL.
      if (!/^[a-z0-9-]{3,120}$/i.test(slug)) return err(400, 'bad_body', 'slug');
      const now = Date.now();
      await env.DB.prepare(`INSERT OR IGNORE INTO campaigns (slug, created_at) VALUES (?1, ?2);`)
        .bind(slug, now).run();
      const camp = await env.DB.prepare(`SELECT id FROM campaigns WHERE slug = ?1;`)
        .bind(slug).first<{ id: number }>();
      if (camp === null) return err(503, 'campaign_insert_failed');
      await env.DB.prepare(`INSERT OR IGNORE INTO run_campaigns (run_id, campaign_id, created_at) VALUES (?1,?2,?3);`)
        .bind(runId, camp.id, now).run();
      await timerStub(env).configChanged();
      return json({ id: camp.id, slug }, 201);
    }

    if (seg.length === 5 && m === 'DELETE') {
      const cid = Number(b);
      if (!Number.isInteger(cid)) return notFound();
      // Unlink from the run; the campaign row and its donations survive, so re-adding it later
      // keeps every exclusion flag the streamer already set.
      await env.DB.prepare(`DELETE FROM run_campaigns WHERE run_id = ?1 AND campaign_id = ?2;`)
        .bind(runId, cid).run();
      await timerStub(env).configChanged();
      return json({ ok: true });
    }
    return methodNotAllowed('POST, DELETE');
  }

  // ---- donations: the §4.1 "zählt nicht für Zeit" toggle, keyed by donation id ----
  if (a === 'donations' && seg.length === 5) {
    if (m !== 'PATCH') return methodNotAllowed('PATCH');
    const body = await readJson(request);
    const on = body?.excluded_from_time;
    if (typeof on !== 'boolean') return err(400, 'bad_body', 'excluded_from_time must be a boolean');
    const row = await env.DB.prepare(
      `UPDATE donations SET excluded_from_time = ?1 WHERE gofundme_id = ?2 RETURNING gofundme_id;`,
    ).bind(on ? 1 : 0, String(b)).first<{ gofundme_id: string }>();
    if (row === null) return notFound();
    await timerStub(env).configChanged();
    return json({ ok: true });
  }

  // ---- adjustments: the §4.2 ledger, including the "+1 Stunde" button ----
  if (a === 'adjustments') {
    const runId = await currentRunId(env);
    if (runId === null) return err(409, 'no_run', 'Leg zuerst einen Lauf an.');

    if (seg.length === 4 && m === 'POST') {
      const body = await readJson(request);
      if (body === null) return err(400, 'bad_body');
      const cents = typeof body.cents === 'number' && Number.isInteger(body.cents) ? body.cents : 0;
      const ms = typeof body.ms === 'number' && Number.isInteger(body.ms) ? body.ms : 0;
      const note = typeof body.note === 'string' ? body.note.trim() : '';
      // Mirrors the table's CHECK: an entry that moves neither money nor time is a bug, not a note.
      if (cents === 0 && ms === 0) return err(400, 'bad_body', 'cents or ms must be non-zero');
      if (note === '' || note.length > 200) return err(400, 'bad_body', 'note (1..200)');
      const who = await requireAccess(request, env);
      const author = who instanceof Response ? 'unknown' : who.email;
      const row = await env.DB.prepare(
        `INSERT INTO adjustments (run_id, cents, ms, note, author, created_at)
         VALUES (?1,?2,?3,?4,?5,?6) RETURNING *;`,
      ).bind(runId, cents, ms, note, author, Date.now()).first<Record<string, unknown>>();
      await timerStub(env).configChanged();
      return json(row, 201);
    }

    if (seg.length === 5 && m === 'DELETE') {
      const aid = Number(b);
      if (!Number.isInteger(aid)) return notFound();
      // Undo is `undone_at`, never a DELETE and never a compensating entry — the same rule the
      // win-challenge log follows, so the ledger stays a true audit trail.
      await env.DB.prepare(`UPDATE adjustments SET undone_at = ?1 WHERE id = ?2 AND undone_at IS NULL;`)
        .bind(Date.now(), aid).run();
      await timerStub(env).configChanged();
      return json({ ok: true });
    }
    return methodNotAllowed('POST, DELETE');
  }

  // ---- rehydrate: drop every DO cache and replay D1. The clock's equivalent of route 27,
  // for when the object's cached state and the database have diverged. ----
  if (a === 'rehydrate' && seg.length === 4) {
    if (m !== 'POST') return methodNotAllowed('POST');
    return json(await timerStub(env).rehydrate());
  }

  // ---- poll now: the admin "retry" button for the §3.4 manual path ----
  if (a === 'poll' && seg.length === 4) {
    if (m !== 'POST') return methodNotAllowed('POST');
    const snap = await timerStub(env).pollNow();
    return json(snap);
  }

  return notFound();
}

/** The clock's Stream Deck buttons. Same `"ok"` / plain-text contract as routes 37-42. */
async function timerDeck(env: Env, name: 'timer-pause' | 'timer-resume' | 'plus1h'): Promise<Response> {
  try {
    if (name === 'plus1h') {
      const runId = await liveRunId(env);
      if (runId === null) return textNoStore('no live run', 409);
      await env.DB.prepare(
        `INSERT INTO adjustments (run_id, cents, ms, note, author, created_at) VALUES (?1,0,?2,?3,?4,?5);`,
      ).bind(runId, 3_600_000, '+1 Stunde (Stream Deck)', 'streamdeck', Date.now()).run();
      await timerStub(env).configChanged();
      return textNoStore('ok');
    }
    const out = await timerStub(env).control(name === 'timer-pause' ? 'pause' : 'resume');
    if ('error' in out) return textNoStore(String(out.error), 409);
    return textNoStore('ok');
  } catch (e) {
    logError(`GET /c/:t/${name}`, e);
    return textNoStore('error', 503);
  }
}
