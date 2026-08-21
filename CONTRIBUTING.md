# Contributing

## Run it locally

You need Node 24+ and a free Cloudflare account (only for `wrangler dev`'s local runtime; no
resources are created).

```bash
npm install
cp .dev.vars.example .dev.vars   # dummy values are fine for local dev
npm run migrate:local            # applies the D1 schema to the local replica
npm run dev                      # http://localhost:8787
```

`npm run dev` builds with `__DEV__: true`, which lets `/admin` work locally without Cloudflare
Access. The admin is at `/admin/`, the timer admin at `/admin/timer/`.

## Before you open a PR

```bash
npm run check
```

That runs the typecheck (`tsc --noEmit`, strict), the tests (`node --test`, no framework), and
`verify:dce`, which builds a production bundle and proves the dev-mode auth bypass has been
dead-code-eliminated out of it. All three must pass. If you touched the overlay
(`public/overlay.*`), re-measure its CPU cost per `docs/SPEC.md` §7.6 and put the numbers in
the PR. The budget is ≤3% with zero layout and zero style recalc, and it is a hard gate.

## What PRs are welcome

- Bug fixes, with a test when the bug was in `src/`.
- Translations: add a language to `public/strings.js`. It is the only place user-facing copy
  lives, and adding a language means completing every key.
- Documentation fixes.

## What will be declined

These are deliberate constraints, not oversights (`docs/SPEC.md` §1 has the reasoning):

- Frontend frameworks, bundlers, or a TypeScript migration of `public/`. The frontend is
  hand-written ES modules served verbatim; the OBS CPU budget depends on that staying true.
- New runtime dependencies. The backend has exactly one (`jose`) and the frontend has none.
- Widening `run_worker_first` in `wrangler.jsonc`. The cost model depends on assets being
  served without invoking the Worker.
- Changes to the event-log state machine in `src/run.ts` without a very good reason. It is
  pure, append-only, and fully tested; the replay-stability rule in SPEC §2.2 is load-bearing.
