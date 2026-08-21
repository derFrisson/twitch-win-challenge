# Product

## Register

product

## Users

- **The operator**: a Twitch streamer running a win-challenge live, controlling it from a phone
  with one hand mid-game, or from a Stream Deck without alt-tabbing. Under pressure, on camera,
  no time to read docs. German-speaking today; the public release adds English.
- **The audience**: stream viewers who see the overlay composited over gameplay. They never
  interact with it; it must read at a glance and never distract from the game.
- **A stranger with a Cloudflare account**: post-release, anyone cloning the repo must reach a
  working deploy in under an hour with only the README.

## Product Purpose

Run Twitch win-challenges (beat every game in a list, in order) and donation-driven subathon
clocks live: an OBS overlay renders the state, a phone admin controls it, Stream Deck hotkeys
fire win/loss/undo, and an append-only event log makes every number auditable and every action
undoable. Success = a whole stream runs without the operator ever thinking about the tool.

## Brand Personality

Broadcast-calm, precise, warm at the payoff. The overlay is quiet until a streak or a win;
then a short comic-sticker celebration (the operator's alert brand) plays and settles back to
calm. The admin is a cockpit, not a marketing surface.

## Anti-references

- SaaS dashboard clichés: hero metrics, gradient accents, card grids for their own sake.
- Framework-shaped admin panels (heavy shells, spinners everywhere, optimistic UI that lies).
- Busy stream overlays that fight the gameplay for attention or animate continuously.
- win-challenge.com's widget is the benchmarked reference for the overlay's information
  design: match its legibility, beat its footprint, and never copy its footer (losses stay
  off camera here, deliberately).

## Design Principles

1. **The camera never lies.** Losses never appear on the overlay; celebrations are transient
   beats, never resting states; a wrong-but-plausible render is worse than a visible failure.
2. **The budget wins.** Overlay ≤3% CPU at 1080p60, zero layout, zero style recalc. Finite
   animation only; nothing ticks at rest. Any overlay change re-measures.
3. **One-handed, under pressure.** The admin is phone-first: big targets, two-tap arming for
   destructive acts, visible latches for standing requests, no control that means two things.
4. **Degrade, never throw.** Unknown data renders as a placeholder, empty states say what to do
   next, and every failure path has designed copy.
5. **One copy source.** Every user-facing string lives in `public/strings.js`: labels,
   tooltips, errors, both languages. No string hides in markup or JS.

## Accessibility & Inclusion

- Admin pages: full keyboard operability, visible focus states, WCAG AA contrast (≥4.5:1 body
  text; the token ramp in `admin.css` documents its ratios), `prefers-reduced-motion` honored.
- The overlay is a broadcast graphic rendered inside OBS: no user input, and no reduced-motion
  preference exists in that environment (DESIGN §6.7). Legibility over gameplay is its
  accessibility bar (opaque text, shadowed ink, no thin weights over video).
- Tooltips: every interactive admin control carries `title` + `aria-label` where not
  self-labelling, sourced from `strings.js` in every shipped language.
