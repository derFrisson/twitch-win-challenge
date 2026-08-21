import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

// Cloudflare Access protection for the owner-only admin surfaces, plus the three response
// helpers every route needs (SPEC 1.1: they live here rather than in a single-consumer http.ts).
//
// SECURITY MODEL: Cloudflare Access sits in
// front of the Worker, but that alone is NOT sufficient — an attacker who reaches the Worker
// origin directly could forge the `CF_Authorization` cookie. So we independently validate the
// signed `Cf-Access-Jwt-Assertion` header against Cloudflare's JWKS, checking both the issuer
// and the application audience (AUD), with the algorithm pinned. We deliberately do NOT read
// the cookie at all. Every failure — including an unexpected throw — is a 401, never a 500 that
// a proxy might treat as retryable. (SPEC 6.1.)

const jwksCache = new Map<string, JWTVerifyGetKey>();          // module scope: survives across
function getJwks(teamDomain: string): JWTVerifyGetKey {         // requests in the same isolate
  let jwks = jwksCache.get(teamDomain);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`));
    jwksCache.set(teamDomain, jwks);
  }
  return jwks;                                                  // jose does its own key-rotation refetch
}

function unauthorized(message: string): Response {
  return new Response(message, {
    status: 401,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

/**
 * 401 Response on failure, `{email}` on success. There is no middleware, no framework:
 *
 *   const auth = await requireAccess(request, env);
 *   if (auth instanceof Response) return auth;
 *   // ...auth.email is the verified owner
 */
export async function requireAccess(
  request: Request,
  env: Env
): Promise<{ email: string } | Response> {
  // DEV ONLY — local admin testing. Cloudflare Access cannot sit in front of `wrangler dev`,
  // so the JWT assertion can never be present locally and admin would always 401. This branch
  // grants a fake owner identity. `__DEV__` is a build-time `define` constant replaced with the
  // literal `false` by esbuild, and `wrangler deploy` runs with `minify: true`, so the whole
  // block — including the fake identity string below — is dead-code-eliminated from the
  // deployed bundle. It can NEVER bypass auth in production.
  // Verify with: npm run verify:dce   (greps the built bundle for that string -> no match)
  if (__DEV__) return { email: 'dev@localhost' };

  const teamDomain = env.CF_TEAM_DOMAIN;
  const aud = env.CF_ACCESS_AUD;
  // Fail closed on misconfiguration: an unset or empty secret must never mean "open".
  if (!teamDomain || !aud) {
    return unauthorized('Zugriff verweigert: Access ist serverseitig nicht konfiguriert.');
  }

  // Deliberately NOT the CF_Authorization cookie: an attacker reaching the Worker origin
  // directly could forge it. Only the signed assertion header is trusted.
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) return unauthorized('Zugriff verweigert: Kein Access-Token vorhanden.');

  try {
    const { payload } = await jwtVerify(token, getJwks(teamDomain), {
      issuer: `https://${teamDomain}`,
      audience: aud,
      algorithms: ['RS256'],     // pinned: a future dependency change must not relax this
    });
    const email = typeof payload.email === 'string' ? payload.email : undefined;
    if (!email) return unauthorized('Zugriff verweigert: Token enthält keine E-Mail.');
    return { email };
  } catch {
    // Total catch: a bad signature, a wrong issuer/audience, an expired token, a JWKS fetch
    // failure and anything unforeseen all land here as the same 401.
    return unauthorized('Zugriff verweigert: Token-Validierung fehlgeschlagen.');
  }
}

/**
 * Tiny JSON response helper for API routes. Always no-store: admin/API payloads must never be
 * cached by the browser or an intermediary (SPEC 5.2).
 */
export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

/**
 * Structured error log for Workers Logs (observability is enabled in wrangler.jsonc). Call this
 * in 500/503/unexpected-failure paths so production errors are searchable instead of silently
 * swallowed. `scope` identifies the route/operation, e.g. 'POST /api/admin/control/win'.
 * The client only ever gets the code (SPEC 5.3) — the stack stays here.
 */
export function logError(scope: string, error: unknown): void {
  console.error(
    JSON.stringify({
      level: 'error',
      scope,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    })
  );
}

/**
 * Baseline security headers for every Worker-generated response (SPEC 5.1). `frame` defaults to
 * 'DENY'; `/o/*` passes 'SAMEORIGIN' so the admin live preview can iframe the overlay.
 *
 * ponytail: always copies the Response instead of detecting whether its headers are mutable.
 * A Response that came out of a fetch() — every env.ASSETS.fetch() result, i.e. routes 2, 33,
 * 34 and the 44 fallthrough — has immutable headers and .set() throws on it, so the copy is
 * not optional; branching on it would just be two code paths for one behaviour. The body is
 * moved by reference, not read. Ceiling: the 101 upgrade response cannot be copied (the
 * Response constructor rejects the status and the WebSocket would be dropped), so it is
 * returned untouched — a WS handshake has nothing for these headers to protect.
 */
export function withSecurityHeaders(
  res: Response,
  opts?: { frame?: 'DENY' | 'SAMEORIGIN' }
): Response {
  if (res.status === 101) return res;
  const out = new Response(res.body, res);
  out.headers.set('X-Content-Type-Options', 'nosniff');
  out.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  out.headers.set('X-Frame-Options', opts?.frame ?? 'DENY');
  return out;
}
