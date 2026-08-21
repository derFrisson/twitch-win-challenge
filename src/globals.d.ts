// Build-time constant, substituted by esbuild's `define` (SPEC 6.2): the literal `false` for
// every `wrangler deploy` / `--dry-run` build, `true` only under
// `wrangler dev --define __DEV__:true` (CLI beats config).
//
// Declared as `boolean` — NOT as `false` — on purpose: a literal type would make TypeScript
// treat the dev branch in auth.ts as unreachable code and start narrowing around it, while
// esbuild is the thing that actually removes it.
//
// Hand-written and committed. `wrangler types` has no knowledge of `define` and would drop
// this declaration if it lived in the generated (gitignored) worker-configuration.d.ts.
declare const __DEV__: boolean;

// Secrets: `.dev.vars` locally, `wrangler secret put` in production (SPEC 9.2). `wrangler types`
// only sees bindings declared in wrangler.jsonc plus whatever happens to be in an untracked
// .dev.vars, so the generated (gitignored) worker-configuration.d.ts cannot be relied on for
// these — declared here, next to __DEV__, so `npm run typecheck` is deterministic on a fresh
// clone. Interface merging: this augments the generated global `Env`.
//
// ponytail: typed `string`, not `string | undefined`. requireAccess() and the igdbToken()
// fetch already fail closed on an empty value at runtime (SPEC 6.1), so an optional type would
// only add non-null assertions at every use site for a check that is already there.
interface Env {
  CF_TEAM_DOMAIN: string;
  CF_ACCESS_AUD: string;
  IGDB_CLIENT_ID: string;
  IGDB_CLIENT_SECRET: string;
}
