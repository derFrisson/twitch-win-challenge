# Security policy

## Reporting a vulnerability

Use GitHub's private vulnerability reporting on this repository (Security tab → "Report a
vulnerability"). Please do not open a public issue for anything exploitable. This tool runs
live on camera, and a public report is a live exploit window for every streamer using it.

You can expect an acknowledgement within a few days. There is no bug bounty.

## Threat model

Three privilege levels, from weakest to strongest. The design goal: leaking a weaker
credential never compromises a stronger surface.

### Someone with the overlay URL (`/o/<token>`)

The overlay URL is the credential most likely to leak: it sits in OBS, shows up in screen
shares, and gets pasted into support chats. It is deliberately **read-only**. Its holder can:

- watch the live run state (the same numbers the stream audience already sees),
- read the recap page and its JSON for past sessions of this instance,
- see the subathon clock.

They cannot fire wins or losses, change any configuration, read tokens, or reach anything
under `/admin`. Requests against overlay routes drain a rate-limit bucket *before* the token
is compared, so the URL space cannot be usefully brute-forced either (tokens are 160 bits of
`crypto.getRandomValues` randomness; guessing is not a realistic path).

### Someone with the control URL (`/c/<token>`)

The control token is a **write** credential: its holder can fire win / loss / skip / undo /
stop-loop, which is to say vandalize the run on camera. That is why it is a *separate* token
from the overlay one: the URL that must live in OBS can leak without handing anyone the
buttons. The control token cannot: create or delete sessions or games, read or rotate tokens,
touch the clock's money model, or reach `/admin`. Recovery from a leak is one click: rotating
the token in the admin panel invalidates the old URL immediately, with no cache or propagation
delay.

### The admin surface (`/admin*`, `/api/admin/*`)

Two independent layers, both of which must pass:

1. **Cloudflare Access** in front of the routed hostname, the login wall.
2. **Independent JWT validation in the Worker** (`src/auth.ts`): every admin request must
   carry a `Cf-Access-Jwt-Assertion` header whose signature verifies against your Access
   team's JWKS, with the issuer and application AUD checked and the algorithm pinned. The
   `CF_Authorization` cookie is deliberately never read.

Consequences of that layering:

- Neither leaked bearer token grants admin: they are checked against a different store and
  never accepted on `/admin*` paths.
- A request that somehow reaches the Worker without passing Access (an origin-IP hit, a
  `*.workers.dev` route that slipped on) still gets a 401, because Access's header is signed
  and the Worker verifies the signature itself.
- **Misconfiguration fails closed.** If `CF_TEAM_DOMAIN` or `CF_ACCESS_AUD` is unset or empty
  in production, every admin request is answered 401 unconditionally. `workers_dev` and
  `preview_urls` are both off in `wrangler.jsonc`, so no unrouted hostname serves the Worker
  in the first place.
- The dev-mode auth bypass (`__DEV__`) is replaced with a literal `false` at build time and
  dead-code-eliminated; `npm run verify:dce` proves the bypass string is physically absent
  from the deployed bundle.

### Other surfaces

- `/covers/<key>` is public by design (cover art must load in OBS without credentials). Keys
  are IGDB image ids or random UUIDs; the route rejects path separators and dot segments, so
  the bucket cannot be traversed, and there is no listing endpoint to enumerate.
- The event log is append-only and every admin mutation is scoped by Access; there is no
  unauthenticated write path anywhere except the control token's five actions.
- The only runtime dependency is `jose` (JWT verification); `npm audit` is part of review.
