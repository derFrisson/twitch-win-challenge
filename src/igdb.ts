// IGDB search + cover ingest into R2 (SPEC §5.2 route 10, and the ingest half of route 6).
//
// I/O-only, stateless module. The Twitch app token is fetched and cached by
// LiveRun.igdbToken() (SPEC §4.7/§4.8) — this file never fetches or stores a token itself,
// it only takes one in as a parameter. IGDB is a convenience, never a hard dependency
// (BUILD_PROMPT §8): every failure here degrades to `null`/a thrown status, never a throw
// that takes down the admin panel.

/** One IGDB search hit, already reshaped into route 10's wire format (SPEC §5.2 #10). */
export type IgdbSearchResult = {
  igdb_id: number;
  name: string;
  cover_image_id: string | null;
  releaseYear: number | null;
  platforms: string[];
};

/** Raw shape of one element of IGDB's bare JSON array response for `POST /v4/games`. */
type IgdbApiGame = {
  id: number;
  name: string;
  cover?: { image_id: string };
  first_release_date?: number; // unix seconds, not ms
  platforms?: { abbreviation?: string }[];
};

/**
 * Thrown by searchGames() so the route-10 handler can map to the exact status SPEC §5.2 #10
 * requires: 503 when IGDB itself is rate-limiting us, 502 for every other failure
 * (unreachable, non-2xx, malformed body). Error bodies from IGDB have no documented schema,
 * so callers must branch on HTTP status only — this class carries nothing else.
 */
export class IgdbSearchError extends Error {
  // Not a constructor parameter property — see the note in gofundme.ts: that syntax is not
  // erasable, so it breaks the moment this module is imported by a `node --test` file.
  readonly status: 502 | 503;

  constructor(status: 502 | 503) {
    super(`IGDB search failed (${status})`);
    this.status = status;
  }
}

// ~200px-wide cover on a 1080p overlay: IGDB's fixed size buckets are cover_small (90x128)
// and cover_big (264x374) — cover_big is the closer match and stays sharp at stream bitrate.
const COVER_IMAGE_SIZE = 'cover_big';

/** POST one raw Apicalypse body to /v4/games. Status mapping per IgdbSearchError's doc. */
async function postGames(env: Env, token: string, body: string): Promise<IgdbApiGame[]> {
  let res: Response;
  try {
    res = await fetch('https://api.igdb.com/v4/games', {
      method: 'POST',
      headers: {
        'Client-ID': env.IGDB_CLIENT_ID,
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        // No Content-Type: the body is raw Apicalypse text, not JSON (verified API fact).
      },
      body,
    });
  } catch {
    throw new IgdbSearchError(502); // network failure — "IGDB unreachable"
  }
  if (res.status === 429) throw new IgdbSearchError(503); // IGDB's own rate limit (4 req/s)
  if (!res.ok) throw new IgdbSearchError(502); // branch on status only, never parse the body
  return (await res.json()) as IgdbApiGame[]; // bare array, never `{data: [...]}`
}

/**
 * Search IGDB for `query` using an already-fetched app token. `[]` is a valid "no results",
 * not an error. Throws IgdbSearchError on every failure — see the class doc for the mapping.
 *
 * Two parallel queries against the plain /v4/games endpoint (deliberately NOT multiquery —
 * `search` inside a multiquery broke in production, killing search outright):
 *  - "fuzzy": IGDB's own `search`. The workhorse; its failures map to the route's 502/503.
 *  - "named": an exact case-insensitive name match (`~ *"…"*`), sorted by rating count.
 *    IGDB's fuzzy search is fuzzy to a fault — "THE FINALS" ranks a page of Final Fantasy
 *    entries above the exact-name hit (observed in production) — so real name matches are
 *    ranked first. This query is an enhancement: if it fails, it degrades to nothing and
 *    the fuzzy results still answer, instead of taking the whole search down with it.
 */
export async function searchGames(env: Env, token: string, query: string): Promise<IgdbSearchResult[]> {
  // ponytail: backslash-then-quote escaping is the entire Apicalypse string grammar needs;
  // a real tokenizer/escaper is not warranted for one interpolated search term.
  const escaped = query.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const FIELDS = 'fields id,name,cover.image_id,first_release_date,platforms.abbreviation;';

  const [named, fuzzy] = await Promise.all([
    postGames(env, token, `${FIELDS} where name ~ *"${escaped}"*; sort total_rating_count desc; limit 12;`)
      .catch(() => [] as IgdbApiGame[]),
    postGames(env, token, `search "${escaped}"; ${FIELDS} limit 12;`),
  ]);

  // Exact-name matches first, fuzzy fill after, deduped by id, capped at the old limit.
  const seen = new Set<number>();
  const merged: IgdbApiGame[] = [];
  for (const g of [...named, ...fuzzy]) {
    if (seen.has(g.id)) continue;
    seen.add(g.id);
    merged.push(g);
    if (merged.length === 12) break;
  }

  return merged.map((g) => ({
    igdb_id: g.id,
    name: g.name,
    cover_image_id: g.cover?.image_id ?? null,
    releaseYear:
      g.first_release_date != null ? new Date(g.first_release_date * 1000).getUTCFullYear() : null,
    platforms: (g.platforms ?? []).map((p) => p.abbreviation).filter((a): a is string => a != null),
  }));
}

/**
 * Cover image ids for a set of IGDB game ids — one query, for the repair path (route 6b):
 * games created while cover ingest was broken sit with igdb_id set and cover_key NULL.
 * The ids come from our own INTEGER column, never from user input.
 */
export async function coverIdsForGames(env: Env, token: string, ids: number[]): Promise<Map<number, string>> {
  const body = `fields id,cover.image_id; where id = (${ids.join(',')}); limit ${Math.min(ids.length, 500)};`;
  let res: Response;
  try {
    res = await fetch('https://api.igdb.com/v4/games', {
      method: 'POST',
      headers: {
        'Client-ID': env.IGDB_CLIENT_ID,
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      body,
    });
  } catch {
    throw new IgdbSearchError(502);
  }
  if (res.status === 429) throw new IgdbSearchError(503);
  if (!res.ok) throw new IgdbSearchError(502);
  const games = (await res.json()) as IgdbApiGame[];
  const out = new Map<number, string>();
  for (const g of games) if (g.cover?.image_id !== undefined) out.set(g.id, g.cover.image_id);
  return out;
}

// IGDB image ids are short alphanumeric hashes (e.g. "co1wyy"). Route 6 passes one straight
// from an admin-supplied request body, so it crosses a trust boundary on its way to becoming
// an R2 key / games.cover_key value even though the route itself sits behind Access.
const IMAGE_ID_RE = /^[a-zA-Z0-9_-]+$/;

/**
 * Download an IGDB cover once and store it in R2 under a bare object name — no `covers/`
 * prefix, matching SPEC §3.1's `games.cover_key` column and route 43's `/covers/<key>` read
 * path exactly (one spelling, no double prefix). Returns the cover_key on success, `null` on
 * any failure so the caller can still create the game with `cover_key: null` and surface the
 * SPEC §5.2 route-6 502 path — a live overlay must never hotlink `images.igdb.com` and risk a
 * third-party 404 turning into a blank box on camera.
 */
export async function ingestCover(env: Env, imageId: string): Promise<string | null> {
  if (!IMAGE_ID_RE.test(imageId)) return null;
  const coverKey = `${imageId}.jpg`; // this URL shape is always served back as JPEG by IGDB

  let res: Response;
  try {
    res = await fetch(`https://images.igdb.com/igdb/image/upload/t_${COVER_IMAGE_SIZE}/${imageId}.jpg`);
  } catch {
    return null;
  }
  if (!res.ok || res.body === null) return null;

  // Buffered, never streamed: R2 put() requires a known length and the IGDB CDN answers
  // chunked, so passing res.body throws on EVERY ingest (verified — the game was created
  // coverless each time). A cover_big is ~30 KB; buffering is nothing.
  let bytes: ArrayBuffer;
  try {
    bytes = await res.arrayBuffer();
  } catch {
    return null;
  }
  await env.COVERS.put(coverKey, bytes, { httpMetadata: { contentType: 'image/jpeg' } });
  return coverKey;
}
