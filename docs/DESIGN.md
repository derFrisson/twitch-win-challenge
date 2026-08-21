# DESIGN — the visual and motion contract

**Status: AUTHORITATIVE for everything you can see.** `docs/SPEC.md` owns behaviour, protocol,
DOM ids and file layout; this document owns colour, type, layer stacks, geometry, timing curves
and keyframes. Where they touch, SPEC wins on *what happens* and this file wins on *what it
looks like*. Two places propose a change to SPEC; both are flagged `DIVERGENCE:` with the
rationale and neither is optional-by-accident.

Conventions:
- `DECIDED:` — settled here, do not relitigate.
- `LITERAL:` — copy the value/CSS verbatim. No "roughly", no "or similar".
- `ponytail:` — a deliberate simplification; copy the comment into the code.
- Every number in this file is a real number that was computed or measured, not a vibe. The
  contrast figures in §2.3 came out of a compositing calculation over five worst-case gameplay
  backdrops; the recap palette in §7.1 passed `dataviz/scripts/validate_palette.js` and the
  run output is quoted.

Three surfaces are specified:

| Surface | Files | Mode (impeccable) | The success condition |
|---|---|---|---|
| **Overlay** | `public/overlay.html/.css/.js` | Experience | An audience reads the hero number in half a second, over unpredictable gameplay, through a 6000 kbps H.264 encode, without ever thinking about the graphic |
| **Recap** | `public/recap.html/.js` + `overlay.css` | Read | The last frame of the stream, the one most likely to be clipped and reshared, is legible as a still |
| **Admin** | `public/admin/*` | Operate | One thumb, one hand, a controller in the other, eyes mostly on the game. Zero hesitation, zero mis-taps |

**The house rules, on every surface.**
1. Animate `transform` and `opacity`. Nothing else, ever (SPEC §7.6). A colour change is a
   cross-fade of two pre-coloured stacked layers.
2. No `backdrop-filter` blur is load-bearing anywhere. It cannot see the OBS scene behind the
   browser source — CEF renders the page into an isolated RGBA texture — so the frosted read is
   built from layered rgba fills, gradients, a specular sheen, an inner hairline and one static
   grain tile (§2). SPEC §7.2's `@supports` branch stays exactly as written: a static,
   never-animated nicety for the admin preview iframe, and the design must be finished and
   beautiful *without* it.
3. Legibility is never a function of a user-tunable value. `?opacity=` moves the decorative
   fill. It cannot move the scrim behind text or the plate behind the hero number (§2.3).
4. No `requestAnimationFrame` in the overlay. Every motion is a class toggle plus a CSS
   transition or a CSS animation, because rAF is throttled to 40–50 fps inside a browser source
   and SPEC §7.6 bans the loop outright.

---

## 1. Tokens

### 1.1 The shared block

`LITERAL:` this block appears **byte-identically** in `public/overlay.css` and
`public/admin/admin.css`, between the two marker comments. `recap.html` links `/overlay.css`
(SPEC §1) and therefore inherits it for free.

```css
/* ============================== TOKENS-BEGIN ==============================
   Shared by overlay.css and admin/admin.css. Byte-identical in both files.
   ponytail: duplicated, not imported. The §1 file tree has no tokens.css, and an
   @import would add a render-blocking request in front of the overlay's first paint
   — on camera, on every OBS source refresh. 40 literal lines is the cheaper copy.
   Ceiling: if a third surface appears, add public/tokens.css and link it from all three.
   Drift check (must print nothing):
     diff <(sed -n '/TOKENS-BEGIN/,/TOKENS-END/p' public/overlay.css) \
          <(sed -n '/TOKENS-BEGIN/,/TOKENS-END/p' public/admin/admin.css)
   ========================================================================== */
:root {
  /* ---- ink ramp: one cool near-black ramp, used by all three surfaces ---- */
  --ink-1000: #05060A;   /* plate base — the deepest surface in the system */
  --ink-950:  #0A0B0F;   /* admin page plane */
  --ink-900:  #101218;   /* card fill base / recap chart surface / admin section */
  --ink-800:  #171A22;   /* raised control */
  --ink-700:  #232733;   /* pressed control, input well */
  --ink-600:  #333947;
  --ink-500:  #4B5364;   /* axis, baseline, outline-button border */
  --ink-400:  #6E7889;   /* de-emphasis data mark */
  --ink-300:  #9BA4B4;   /* muted ink — OPAQUE surfaces only, never over gameplay */
  --ink-200:  #C6CCD8;   /* secondary ink */
  --ink-100:  #E6E9EF;
  --ink-000:  #FFFFFF;   /* primary ink and every hero numeral */

  /* ---- accent: the ONE recolourable value. See §1.5. ---- */
  --accent:     #FF5A1F;
  --accent-rgb: 255, 90, 31;

  /* ---- status: lifted verbatim from dataviz/references/palette.md, unchanged ---- */
  --good:     #0CA30C;   /* LIVE, won            5.58:1 on --ink-900 */
  --warning:  #FAB219;   /* armed "stop after"  10.20:1 */
  --serious:  #EC835A;   /* skipped              7.10:1 */
  --critical: #D03B3B;   /* stop now, 409        3.90:1 */

  /* ---- data marks: fixed, validated, NEVER derived from --accent (§7.1) ---- */
  --viz-win:  #3987E5;   /* 5.14:1 on --ink-900 */
  --viz-loss: #E66767;   /* 5.80:1 */
  --viz-mute: var(--ink-400);
  --viz-grid: #3D4557;   /* 1.95:1 — recessive but survives H.264 at 2px */
  --viz-axis: var(--ink-500);

  /* ---- type scale: Inter, ratio ~1.28, every step a whole px ---- */
  --t-xs:    13px;
  --t-sm:    16px;
  --t-md:    20px;
  --t-lg:    26px;
  --t-xl:    33px;
  --t-2xl:   42px;
  --t-3xl:   54px;
  --t-4xl:   76px;
  --t-hero:  92px;

  /* ---- spacing: 4px base ---- */
  --s-1: 4px;  --s-2: 8px;  --s-3: 12px; --s-4: 16px;
  --s-5: 24px; --s-6: 32px; --s-7: 48px; --s-8: 64px;

  /* ---- radii ---- */
  --r-sm: 6px; --r-md: 12px; --r-lg: 16px; --r-xl: 22px; --r-pill: 999px;

  /* ---- easing: five curves, no sixth ---- */
  --e-out:  cubic-bezier(.16, 1, .3, 1);        /* entrances, wipes — exponential ease-out */
  --e-in:   cubic-bezier(.55, 0, 1, .45);       /* exits — accelerate away and be gone */
  --e-land: cubic-bezier(.18, 1.28, .3, 1);     /* the weighty landing: ~8% overshoot, then settle */
  --e-drop: cubic-bezier(.62, .02, .88, .24);   /* the deflate: hangs, then falls */
  --e-io:   cubic-bezier(.42, 0, .58, 1);       /* the flame's default */

  /* ---- durations: the SAME numbers as overlay.js's DUR map (SPEC §7.4). See §4.1. ---- */
  --d-undo:         250ms;
  --d-intro-fade:   400ms;   /* cause session_start */
  --d-win:          450ms;
  --d-wipe:         500ms;   /* cause skip AND game_abandoned */
  --d-loss:         600ms;
  --d-streak-in:    700ms;
  --d-end:          700ms;   /* cause session_end */
  --d-streak-break: 800ms;
  --d-intro:        900ms;   /* cause game_start */
  --d-won:         1800ms;
  --d-ui:           140ms;   /* admin only: press/hover feedback */
}
/* =============================== TOKENS-END =============================== */
```

### 1.2 Overlay-only tokens

`LITERAL:` in `public/overlay.css`, after TOKENS-END.

```css
:root {
  --card-alpha: 0.85;   /* ?opacity=, clamped 0.30..1.00 — DECORATIVE FILL ONLY (§2.3) */
  --scale:      1;      /* ?scale=, clamped 0.50..2.00 */

  /* Fixed geometry. The card never reflows, so ?pos= is pure static inset arithmetic. */
  --card-w:   560px;
  --card-h:   200px;
  --card-pad: 12px;
  --cover-w:  132px;    /* 3:4 box art; IGDB t_cover_big is 264x352 → exactly 2x */
  --cover-h:  176px;    /* == --card-h - 2*--card-pad */
  --gutter:    20px;
  --plate-w:  196px;    /* fits three tabular digits at --t-hero + padding */
  --plate-h:  108px;
  --edge:     48px;     /* distance from the viewport edge for every ?pos= */

  /* The legibility layers. NOT tunable. This is the whole §2.3 guarantee. */
  --scrim:       rgba(5, 6, 10, .62);
  --plate-fill:  rgba(5, 6, 10, .94);
  --hairline:    rgba(255, 255, 255, .10);
  --sheen:       rgba(255, 255, 255, .085);
  --silhouette:  rgba(0, 0, 0, .55);   /* the outer dark ring — see §2.2 note 4 */

  --noise: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='140' height='140' filter='url(%23n)' opacity='.30'/%3E%3C/svg%3E");
}
```

### 1.3 Admin-only tokens

`LITERAL:` in `public/admin/admin.css`, after TOKENS-END.

```css
:root {
  --surface-0: var(--ink-950);   /* page */
  --surface-1: var(--ink-900);   /* section card */
  --surface-2: var(--ink-800);   /* raised control */
  --surface-3: var(--ink-700);   /* pressed / input well */

  /* Thumb-zone geometry (§6.2). Literal px, because a thumb is a literal size. */
  --tap-min:      44px;   /* absolute floor, every interactive element */
  --tap-primary:  96px;   /* WIN / LOSS height */
  --tap-second:   56px;   /* SKIP / UNDO height */
  --bar-pad:      12px;
  --hold-ms:     350ms;   /* UNDO press-and-hold */
}
```

### 1.4 Recap / viz tokens

`LITERAL:` in `public/overlay.css` (recap.html links it), after §1.2.

```css
:root {
  --viz-surface:  var(--ink-900);
  --viz-plate:    rgba(5, 6, 10, .96);   /* the recap card is near-opaque: it is a still, not an overlay */
  --viz-stroke:   3px;    /* SPEC §6.4 minimum. Never smaller, anywhere. */
  --viz-grid-w:   2px;    /* SPEC §6.4 minimum gridline */
  --viz-axis-w:   3px;
  --viz-bar:     20px;    /* bar thickness — under the dataviz 24px cap, air in the band */
  --viz-gap:      2px;    /* surface gap between touching marks */
  --viz-dot:     10px;    /* win marker diameter (dataviz floor is 8px; bitrate wants 10) */
}
```

### 1.5 How `?accent=` recolours the system

The param is a 6-hex string (SPEC §7.5). `overlay.js` parses it **once, at load**, and writes
**two** custom properties on `:root` derived from that single parsed value:

```js
// public/overlay.js — the entire accent mechanism.
// ponytail: two custom properties, one source value, zero stylesheet swapping. rgba(var(--x-rgb), a)
// is the only alpha-compositing mechanism that works in every CEF build OBS 28..31 ships;
// color-mix() needs Chromium >= 111 and an unrecognised color function invalidates the WHOLE
// declaration, which on camera means a layer that silently paints nothing.
// Ceiling: if OBS's CEF floor ever passes 111, delete --accent-rgb and use color-mix(in oklab, ...).
const hex = /^#?([0-9a-f]{6})$/i.exec(params.get('accent') ?? '')?.[1] ?? 'ff5a1f';
const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
root.style.setProperty('--accent', '#' + hex);
root.style.setProperty('--accent-rgb', `${r}, ${g}, ${b}`);
```

`DECIDED:` **the accent is never load-bearing.** It is measured against nothing, because a
streamer can legally send `accent=000000` (contrast 1.11:1 on the plate) or `accent=ffffff`. So:

| Accent MAY | Accent MUST NOT |
|---|---|
| tint a mark: the flame body, the streak plate's rim light | carry any text, ever |
| tint a wash: `#card::after`, the GAME_WON banner fill | be the only difference between two states |
| tint the resting radial heat in the card fill (§2.2 layer 2) | appear anywhere in the recap charts (§7.1) |
| tint the admin's `LIVE` accent rule and primary-button fill | be the sole encoding of win vs loss |

Every element the accent touches carries a white-hot or full-white component that survives any
accent value: the flame's top 40% is white (§5), the banner has white text on it, the streak
numeral is `--ink-000` on `--plate-fill`. Set `accent=000000` and the overlay still reads
perfectly — it just looks like ash. That is the test.

`?accent=` does **not** enter the recap chart palette. That palette is validated (§7.1) and a
user-supplied hue would break the validation on the one surface most likely to be screenshotted.

### 1.6 Shared vs surface-specific — the summary table

| Token group | Overlay | Recap | Admin |
|---|---|---|---|
| ink ramp, accent, status, viz marks | shared | shared | shared |
| type scale, spacing, radii, easing, durations | shared | shared | shared |
| `--card-*`, `--plate-*`, `--scrim`, `--noise`, `--scale` | own | — | — |
| `--viz-*` sizes | — | own | — |
| `--surface-*`, `--tap-*`, `--hold-ms` | — | — | own |

Recap has **no tokens of its own beyond `--viz-*`** and imports the rest through
`/overlay.css`. That is the "no second design system" rule in SPEC §7.7, made structural.

---

## 2. The panel: the v2 compact playlist

The overlay is a single panel: a header bar plus one row per game in the lap. **264px wide,
no footer.** It was rebuilt on 2026-08-21 (replacing the original 560×202 single-game card,
which lives only in git history now) after measuring the commercial tool this project was
benchmarked against, and it beats that tool's footprint by dropping the footer entirely.

Decisions that are settled (do not relitigate):

- **Losses never appear on camera.** They live in the admin panel, the recap and the exports.
- **The per-row counter is `streak/required`**, not a loss counter: `0/1`→`1/1` for single,
  `0/2`→`1/2`→`2/2` for b2b, and a loss at `1/2` returns it to `0/2`.
- **Cover art on the active row only, small** (30px). Pending and done rows carry no art.
- **The flame is finite**: three pulses on streak entry, then still and lit (§5).
- **GAME_WON is a momentary takeover** inside the same footprint (§4), never a resting state.

### 2.1 Geometry (LITERAL: these are the shipped tokens)

```css
--card-w:   264px;   /* panel width; never reflows */
--head-h:    26px;   /* header bar */
--row-h:     30px;   /* one game row */
--rows-max:   9;     /* list clips after 9 rows: 9*30 + 26 ≈ 296px tall */
--card-pad:  10px;
--cover-w:   30px;   /* active row only; cell height = 4:3 of this */
--gutter:     8px;
--edge:      48px;   /* inset from the viewport edge for every ?pos= */
```

Height is content-driven but bounded by `max-height`: a long playlist clips, the panel never
grows off-canvas, and `?pos=` stays pure static inset arithmetic. `?scale=` is a `transform`
whose origin follows the `?pos=` anchor, so the panel grows into the frame, not off the edge.

### 2.2 The layer stack

`backdrop-filter` is architecturally impossible in OBS (the page renders into an isolated
RGBA texture with no scene pixels to sample), so the translucent read is a static stack:

1. a 1px hairline ring (`rgba(255,255,255,.10)`) and an outer dark silhouette shadow that
   separates the panel from bright gameplay,
2. the decorative fill `rgba(5,6,10, calc(var(--card-alpha) * .86))`, the ONLY layer
   `?opacity=` tunes,
3. a top sheen gradient (44px, `rgba(255,255,255,.085)`) that sells the glass without blur.

Text and cover art sit above all of it at full opacity. Legibility is never a function of a
user-tunable value.

### 2.3 The header bar

The session title (uppercased), or the generic product word when the session is untitled.
11px / 800 / `.14em` tracking, deliberately small and letterspaced so it reads as a label;
the game rows are the content. Fill is `var(--accent)` with **dark ink** (`#0A0B0F`), never
white-on-orange. `?grad=RRGGBB-RRGGBB[-RRGGBB]` swaps the fill for a 105° gradient with white
ink and a text shadow (set by overlay.js through `--head-bg/--head-ink/--head-shadow`); with
no parameter the var() fallbacks keep the flat-accent look byte-identical.

## 3. The list and its row states

Rows are **flex, deliberately not grid**: the collapsed cover cell is `display:none`, and grid
auto-placement removes such an item, which shifted every counter 62px off the right edge.
Flex gaps skip hidden items, so counters sit flush right on every row, art or no art.

Row anatomy: `[cover?] TITLE …………… N/M`. Titles clamp to two 13px lines; the counter column
is `tabular-nums` so 9→10 never shifts a row.

| `data-status` | colour | extra signal (never hue alone) |
|---|---|---|
| `pending` | `--ink-300` | the `0/N` fraction |
| `active` | `--ink-000`, weight 800 | 3px inset accent bar + 5% row tint (box-shadow inset, never a border, which would relayout) |
| `done` | `--good` | `✓` appended to the counter |
| `skipped` | `--serious` | `›` appended |
| `abandoned` | `--critical` | — |

`--ink-300` is the dimmest grey allowed on camera: anything dimmer survives a screenshot but
smears under H.264 at stream bitrate.

An active row that is mid-streak (`data-streak="hot"`) recolours its counter to the accent and
lights the flame (§5).

## 4. Modes and the takeover

`data-mode` on `#card` is the only switch. **IDLE is invisible** (`visibility: hidden`): a
blank scene is correct on camera, and the admin preview carries the caption explaining it.
LOSS_MODE and STREAK_MODE are the resting states: **zero animating elements** except the
flame's finite entrance.

The takeover (`#takeover`) is SPEC §6.2's "expand momentarily, then settle back": an absolute
layer over the list, near-opaque (`rgba(5,6,10,.96)`), carrying cover / word / title / count.
GAME_WON, skip, abandoned and ENDED all land here. While a takeover is up the list is
`visibility: hidden` (at .96 alpha the rows ghosted through and read as a rendering fault);
the panel takes a `min-height` floor for the duration of the beat only; a permanent floor
would pad the resting panel with dead space. Hidden state is `opacity + visibility`, never
`display:none`, which is not animatable and forces layout.

ENDED is the one takeover that rests: the ended word plus one line of final numbers
(`6/8 won · 47 losses · 3:12 h`), duration omitted when this client never saw the session
start (RunState carries no timestamps; never print a guess).

## 5. Motion and the flame

House rule, unchanged from v1: animate `transform` and `opacity`, nothing else, in every
keyframe. No `requestAnimationFrame`. `will-change` appears with the beat attribute and is
cleared with it, so no compositor layer is pinned at rest.

### 5.1 The beats

All finite, all matching overlay.js's `DUR` map:

| beat | duration | shape |
|---|---|---|
| `intro` | 400ms | springy sticker entrance: small and tilted → overshoot → settle |
| `loss` | 600ms | counter nudge: down hard, overshoot back |
| `win` / `streak-in` | 450/700ms | counter pop: up, bigger, comic tilt |
| `streak-break` | 800ms | deflate: sags below the line, settles |
| `undo` | 250ms | the list rewinds the OTHER way; the inversion is the message |
| `wipe` (skip/abandon) | 500ms | neutral takeover: in fast, hold, out. Only a win earns a celebration |
| `won` | 1800ms | the comic-sticker payoff: panel pops in springy, cover bursts (140ms delay), the word drops in tilted like a badge (300ms), the count chip-pops (450ms), two clip-path stars twinkle twice, all inside the beat |
| `end` | 700ms | quiet takeover into the resting ENDED state |

The keyframe trap, learned the expensive way: `#card`'s resting transform is
`scale(var(--scale))`, so every keyframe touching the card's transform must re-declare it.
At `?scale=1.6`, forgetting one is a 37% size pop.

### 5.2 The flame

A CSS-drawn shape (clip-path polygon + gradient), **not the 🔥 emoji**: animating an emoji
re-rasterises a colour-bitmap glyph every frame (measured: 3.16% CPU for one element). It is
absolutely positioned so it can never invalidate the row's line box, with a radial-gradient
halo behind it (`z-index:-1` inside the counter's own stacking context).

**Finite: `animation: flame 1.6s ease-in-out 3 both`**: three pulses on streak entry
(~4.8s, the moment the audience actually reacts), then it holds the final frame, warm and
lit. The halo breathes the same three pulses. Measured on the shipped build: LOSS_MODE at
rest **0.011% CPU**, STREAK_MODE after the flame settles **0.005%**, both with 0 layout and
0 style recalc, `document.getAnimations()` reporting only `finished` states. Any *continuous*
animation costs ~3.15% regardless of what it draws (the cost is running a compositor frame
loop at all), so finiteness is the only simplification that buys anything. §7.6's rule: the
budget wins over the design.

One more trap recorded because it cost real time: `@font-face` alone applies nothing.
Something must also set `font-family`, or the whole overlay renders in CEF's default serif,
and no test or CPU number catches it. Only rendering and looking did.

## 6. Admin panel

**Mode: Operate.** The design brief is one sentence and it is the whole brief: *a right thumb, on
a 390px phone, in a dark room, while the other hand is on a controller and the eyes are on the
game.* Every decision below is downstream of that sentence. Nothing here is styled for a
portfolio screenshot.

### 6.1 The two layouts

```
  PHONE  390 x 844                                DESKTOP  >= 720px
 ┌───────────────────────────────┐            ┌──────────────────────────────────────────────┐
 │ ▓▓▓▓▓▓▓▓ 6px status rule ▓▓▓▓ │ sticky     │ ▓▓▓▓▓▓▓▓▓▓▓▓ 6px status rule ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ │
 │ ●LIVE  [cover] Spiel 3/8      │ top:0      │ ●LIVE [cv] Titel     37  1/2  │ WIN LOSS    │
 │ Titel des Spiels              │            │            Spiel 3/8 · R2·B2B │ SKIP  |UNDO │
 │  37 Niederlagen  1/2  42 Vers │            └──────────────────────────────────────────────┘
 ├───────────────────────────────┤            two columns below: sections 8.2/8.3 left,
 │                               │            8.4/8.5/8.6/8.7 right; max-width 1180px
 │   scrolling sections 8.2-8.7  │
 │                               │
 │                               │
 ├───────────────────────────────┤ fixed
 │ [UNDO hold]        [ SKIP ]   │ bottom:0
 │ [  WIN   ] [     LOSS      ]  │
 └───────────────────────────────┘
```

`DIVERGENCE: the action buttons are pinned to the BOTTOM on phones, not the top.` SPEC §8.1 says
the live control bar is `position: sticky; top: 0`. This splits that bar in two:

- `#live-readout` — `position: sticky; top: 0`. **Always visible, exactly as specified.** It is
  read, never touched, so the top edge is the right place for it.
- `#live-actions` — `position: fixed; bottom: 0` at ≤ 719px; merged into the top bar at ≥ 720px.

Rationale, and it is not a preference: a right thumb pivoting from the lower-right corner of a
390×844 device sweeps an arc that comfortably covers roughly `y > 430px`. A 96px-tall button whose
centre sits at `y ≈ 120px` cannot be reached without re-gripping the phone — with the hand that
is also holding a controller. Pinning the primary actions to the top of a phone screen is the
single most common way a "mobile-first" control panel becomes unusable in the exact situation it
was built for. The SPEC requirement — *always visible* — is fully met; which edge it is pinned to
is a layout decision and the thumb gets to make it. On desktop the mouse has no reach constraint,
so the two halves recombine into the one bar SPEC describes.

### 6.2 Exact control sizes

**Phone (390px), `#live-actions`.** Bar padding `--bar-pad: 12px` each side, plus
`padding-bottom: max(12px, env(safe-area-inset-bottom))`.

| Control | Size | Position | Shape / fill | Why |
|---|---|---|---|---|
| **LOSS** | **226 × 96** | row A, right | filled `--critical`, `--r-lg` | The most-pressed button of the night by an order of magnitude, and the least destructive. It gets the largest target and the thumb-home corner. |
| **WIN** | **130 × 96** | row A, left | filled `--good`, `--r-lg` | 130px is still an enormous target. Separated from LOSS by a 10px gap and by hue, weight and width — three channels, so a mis-hit needs three coincidences. |
| **SKIP** | **150 × 56** | row B, right | filled `--surface-3`, 1px `--ink-600` border, `--r-md` | Advances the game: destructive. Half the height of the primaries, a different fill family, in the secondary row. |
| **UNDO** | **112 × 56** | row B, **left** | **no fill**, 1.5px `--ink-500` outline, `--r-pill`, text `--ink-200` | See §6.3. |
| dead zone | **104 × 56** | row B, centre | nothing tappable | Deliberate. The two non-primary controls never share an edge. |

Row A total: `130 + 10 + 226 = 366 = 390 − 2×12`. ✔
Bar height: `96 + 10 + 56 + 24 = 186px` + safe area. On an 844px screen that is 22% of the
viewport spent on the four controls that matter, which is the correct trade for this product.

Vertical stacking order matters: **UNDO sits above WIN, and SKIP sits above LOSS.** An upward
thumb slip from LOSS lands on SKIP (recoverable with one UNDO) and never on UNDO itself.

**Desktop (≥720px):** WIN 168×72, LOSS 220×72, SKIP 148×72, UNDO 128×56, with a **48px gap and a
1px `--ink-700` divider** between SKIP and UNDO. Same colours, same shapes, same hold behaviour.

**Every other interactive element on the page** is ≥ `--tap-min` (44×44), including drag handles,
mode chips, copy buttons and the IGDB result tiles. No exceptions, not even for an icon button.

### 6.3 UNDO — why a panicking thumb cannot hit it

Four independent protections, because one is never enough under adrenaline:

1. **Press-and-hold, `--hold-ms: 350ms`.** `pointerdown` starts a timer and a fill; `pointerup`
   or `pointercancel` before 350ms aborts with no request sent. This is **not a confirm dialog**
   — SPEC §8.1 bans those and is right to: a dialog is a second target, a second decision and a
   second chance to mis-tap. A hold is one continuous gesture with a built-in escape (lift your
   thumb), it needs no second target, and it is *physically impossible* to trigger by brushing.
   The cost is 350ms in a situation where the streamer has already made a mistake and knows it.
2. **The only outline control on the page.** Every other button is a filled rectangle. UNDO is an
   unfilled pill. Under peripheral vision — which is all it gets, because the eyes are on the
   game — fill and silhouette are the two fastest channels, and UNDO differs in both.
3. **Opposite corner from the thumb's resting position**, and the 104px dead zone means it shares
   no edge with SKIP.
4. **Not oversized.** 112×56 against LOSS's 226×96. A smaller target is a worse accident.

Feedback, in order: `pointerdown` → the fill grows via `transform: scaleX(0 → 1)` on an inner
`::before` over 350ms (`transform`, not `width`) and the border brightens to `--ink-300`; at
350ms → `navigator.vibrate?.(18)`, the button flashes to a filled state for 120ms, the request
fires. Abort → the fill collapses in 120ms `--e-in`. The user learns the mechanic on their first
accidental brush, which is the ideal time to learn it.

```css
#btn-undo { position: relative; overflow: hidden; background: none;
            border: 1.5px solid var(--ink-500); border-radius: var(--r-pill);
            width: 112px; height: var(--tap-second); color: var(--ink-200); }
#btn-undo::before { content: ''; position: absolute; inset: 0;
            background: var(--ink-600); transform: scaleX(0); transform-origin: 0 50%;
            transition: transform 120ms var(--e-in); z-index: -1; }
#btn-undo[data-holding]::before { transform: scaleX(1);
            transition: transform var(--hold-ms) linear; }
```

`nothing_to_undo` (409) → the button flashes `--critical` for 400ms and the readout shows
`"Nichts zum Rückgängigmachen"` (SPEC §2.5d). No dialog, no toast that needs dismissing.

### 6.4 The always-visible state readout — `#live-readout`

Sticky, `top: 0`, `background: var(--surface-1)`, `box-shadow: 0 1px 0 var(--ink-700)`, 
`padding: var(--s-3)`. Three rows at 390px, one row at desktop:

| Row | Content | Type |
|---|---|---|
| 0 | the 6px status rule, full bleed | see §6.5 |
| 1 | `●LIVE` pill · cover thumb 36×48 · `"Spiel 3/8 · Runde 2 · B2B"` | 13px/700 `.10em` uppercase; meta 13px/500 `--ink-300` |
| 2 | the game title, one line, `text-overflow: ellipsis` | 20px/600 `--ink-000` |
| 3 | the counters: **`37`** `Niederlagen` · **`1/2`** `Serie` · **`42`** `Versuche` | numbers `--t-xl` (33px)/800 tabular `--ink-000`; labels 13px/500 `--ink-300` |

`font-variant-numeric: tabular-nums` on row 3, because it is a **column of numbers that must not
shift** as they tick — the one place the dataviz "proportional for big standalone numbers" rule
is deliberately overridden, for the same reason as the overlay: a layout that jiggles while your
eyes are elsewhere is a layout you stop trusting.

The readout is fed by the admin WebSocket (SPEC §4.1). It never shows a stale value silently: on
`onclose` the status rule turns `--warning` and the LIVE pill becomes `●VERBINDET…`, so a dead
socket is visible in the same glance as everything else.

### 6.5 LIVE vs not-live, unmistakable at a glance

Five simultaneous signals, of which **four are not colour**:

| | live | not live |
|---|---|---|
| the 6px full-bleed status rule | `--good` | `--ink-700` (ended) / `--warning` (socket down) |
| the pill | filled `--good`, white text, **the word `LIVE`** + a filled dot | outline, `--ink-300`, **the word `BEENDET` / `KEINE SESSION`** |
| the counters | present, `--ink-000` | replaced by an em dash in `--ink-500` |
| **the bottom action bar** | **present** | **gone** — replaced by ONE full-width 366×72 primary button: `Session starten` or `Session fortsetzen` |
| the section headers | normal | 8.3's builder shows `Entwurf` chips |

The fourth row is the strongest signal in the table and the reason the others are almost
redundant: **the controls you use while live do not exist while not live.** There is no disabled
grey WIN button to press hopefully at. When the session is live but a request is in flight, the
buttons stay in place and take `opacity: .55` + `pointer-events: none` for the duration — SPEC
§8.1's in-flight disable — because *that* state is transient and moving the layout for 200ms
would be worse than dimming it.

A 409 on any control: that button's fill flashes to `--critical` for 400ms and the German reason
from `strings.js` appears in the readout's row 3 slot for 2.5s. No modal, no toast stack.

### 6.6 The seven sections

One page, `<details>`-based accordions (SPEC §8), phone-first single column, two columns from
720px. Section chrome: `background: var(--surface-1)`, `border-radius: var(--r-lg)`,
`padding: var(--s-4)`, `margin-bottom: var(--s-3)`; the `<summary>` is a 56px row with a 20px/700
label and a 24px chevron, hit target full-width.

| § | Screen | Design specifics |
|---|---|---|
| **8.1** | **Live control bar** | §6.1–§6.5 above. Not an accordion — it is the sticky readout plus the fixed action bar. Each press generates one uuid v4 `action_id`, reused verbatim on retry (SPEC §4.10); the button's pressed styling is the only optimistic update on the page (`transform: scale(.97)`, 140ms `--e-out`). |
| **8.2** | **Game library** | Cover-art grid, `grid-template-columns: repeat(auto-fill, minmax(104px, 1fr))`, gap `--s-3`; each tile is the 3:4 cover with the name in 13px/600 below on two lines, and a mode chip bottom-right: `1×` or `2× B2B`, 44×28 minimum, tappable to flip `default_mode` (route 7). Icon-forward per prompt §7.2 — the cover *is* the identifier, the name is the caption. `+` is a 104×139 dashed-outline tile in grid position 1, opening the IGDB search sheet: a 56px input, 350ms debounce, results as the same cover tiles. **The manual form is always rendered below the search, never behind a disclosure** — when route 10 returns 502/503 the search box shows the German error inline and the manual form is already on screen and already usable. That is prompt §8's "IGDB is a convenience, never a hard dependency", expressed as layout rather than as a fallback path someone has to find. |
| **8.3** | **Session builder** | Ordered list of 64px rows: 44×64 drag handle (⠿, `--ink-400`, `touch-action: none`), 36×48 cover, title 16px/600, mode chip, 44×44 delete. Drop → `PUT` the full id array (route 17). The **current** row gets a 3px `--good` left edge, the word `LÄUFT`, and its handle rendered at `opacity: .3` with `pointer-events: none` (SPEC §8.3 / §2.5f case 3). Below the list, always visible while live: the note `"Vor dem aktuellen Spiel eingefügte Titel kommen erst in der nächsten Runde"` in 13px `--ink-300`. A 409 on delete renders in-row as `"Bereits gespielt — kann nicht entfernt werden"`, not as a dialog. |
| **8.4** | **Loop control** | Two visually unrelated controls, stacked with `--s-4` between them. **`Nach diesem Spiel stoppen`** — a 56px latching row with a real 52×32 switch on the right; armed = switch on, `--warning` fill, the word `SCHARF`, and a `--warning` 3px left edge on the section. Its off switch (`Doch weiterlaufen`) is the same control in the off position, always visible, never hidden behind the armed state — because UNDO does not clear the flag (SPEC §2.5h) and the UI must not imply that it does. **`Jetzt stoppen`** — full-width 56px, `--critical` outline (not filled: it must not look like the primary action), and the **only confirm step on the page**: tap → the button becomes `Wirklich? Nochmal tippen` for 4s → second tap fires. Two taps, one target, no dialog. |
| **8.5** | **Overlay URLs** | Three copy rows (overlay / recap / control base): 13px monospace value truncated with `text-overflow: ellipsis`, 88×44 `Kopieren` button, success = the button's label swapping to `Kopiert` for 1.2s. Below: the six Stream Deck URLs as copyable rows. Two `Rotieren` buttons with the same two-tap confirm as `Jetzt stoppen`, and the warning `"OBS muss die neue URL bekommen"` rendered *before* the first tap, not after. **The live preview** is one `<iframe>` at 560×200 CSS px (`transform: scale(.7)` on phones, `transform-origin: 0 0`) on a 16px CSS checkerboard (`repeating-conic-gradient(var(--ink-800) 0% 25%, var(--ink-700) 0% 50%)`) — the checkerboard is what makes the card's transparency legible. Four sliders (`scale`, `opacity`, `accent`, `pos`): `input` updates the copy-button URLs and the preview's own CSS custom properties only; the iframe `src` is rewritten on `change`, debounced 250ms, skipped when unchanged (SPEC §8.5 — every rewrite is a document load plus a WS connect, and an undebounced drag empties the §6.4 rate bucket and 429s the next Stream Deck press). |
| **8.6** | **History** | One row per session: title 16px/600, date 13px `--ink-300`, and the numbers as a tabular right-aligned group `6/8 · 47 N · 3:12 h`. Tap expands (route 28) into the **same recap components as §7** — the KPI row and the per-game table, rendered from the identical markup and CSS. No second implementation, no simplified "admin version". Two 44px download buttons per expanded row (routes 29/30). |
| **8.7** | **Resume** | Rendered **only** when `session.status === 'live'`. A full-width `--good`-outlined banner directly under the readout: `"Laufende Session gefunden — <title>, Spiel 3/8, Runde 2"` in 16px/600 plus a 56px `Session fortsetzen` button (route 27). Because the DO rehydrates from D1 on any cold start, this banner is usually informational — so its copy says what is already true rather than implying the stream is broken, and the button reads `Session fortsetzen`, not `Reparieren`. |

### 6.7 Admin motion

`--d-ui: 140ms` and nothing above 240ms. A press is `transform: scale(.97)`. **Accordions animate
nothing** — `<details>` opens instantly. The reflex here is to transition `grid-template-rows`,
which is both on the ban list and wrong for the use case: a one-handed operator does not wait
200ms to see a list.

```css
@media (prefers-reduced-motion: reduce) {
  * { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important;
      transition-duration: 0.01ms !important; }
}
```
`LITERAL:` this block goes in `admin.css` and **not** in `overlay.css` (SPEC §8: the overlay is a
broadcast graphic, and the OBS machine has no reduced-motion preference to express).

Focus is never removed: `:focus-visible { outline: 3px solid var(--viz-win); outline-offset: 2px }`.
The panel is behind Cloudflare Access on a phone, but it is still operable by keyboard on desktop
and that costs one rule.

---

## 7. Recap charts

**Mode: Read.** This is the last graphic on camera and the frame most likely to be clipped,
screenshotted and reshared — so it is designed as a **still**, not as a dashboard. Two hard
constraints shape everything: it must survive an H.264 encode at streaming bitrate, and the
§7.6 animation ceiling still applies.

### 7.1 The palette, validated

`?accent=` does **not** reach the charts. A user-supplied hue would invalidate the CVD and
contrast work below on the one surface most likely to end up as a static image, and the accent is
already doing its job on the overlay. The chart palette is fixed at two data hues plus one
de-emphasis grey — the smallest set that encodes what the data needs.

```
$ node dataviz/scripts/validate_palette.js "#3987E5,#E66767" --mode dark --surface "#101218" --pairs all

  [PASS] Lightness band       all 2 inside L 0.48–0.67
  [PASS] Chroma floor         all 2 >= 0.1
  [PASS] CVD separation       worst all-pairs #E66767↔#3987E5 ΔE 19.2 (protan) · tritan 31.4
  [PASS] Normal-vision floor  worst all-pairs #E66767↔#3987E5 ΔE 29.0 (normal)
  [PASS] Contrast vs surface  all 2 >= 3:1
  → ALL CHECKS PASS
```

19.2 against a target of 8.0 and 29.0 against a floor of 15.0 — an enormous margin, which is
exactly what you want when the delivery channel is a lossy video encoder that eats chroma before
it eats luma.

| Role | Token | Hex | On `--ink-900` | Encodes |
|---|---|---|---|---|
| wins | `--viz-win` | `#3987E5` | 5.14:1 | `perGame.wins`, `perLap.wins`, win rounds |
| losses | `--viz-loss` | `#E66767` | 5.80:1 | `perGame.losses`, `perLap.losses`, loss rounds |
| context | `--viz-mute` | `#6E7889` | 4.20:1 | durations, "Other", de-emphasised rows |
| gridline | `--viz-grid` | `#3D4557` | 1.95:1 | 2px gridlines — recessive, and it survives H.264 |
| axis / baseline | `--viz-axis` | `#4B5364` | 2.43:1 | 3px baseline |

`DECIDED: blue↔red, not green↔red.` The intuitive win/loss pairing is green/red, and it **fails**
the validator: `#0CA30C ↔ #D03B3B` measures **ΔE 4.1 under deuteranopia** — for roughly 6% of men
in the audience the two series are the same colour. Blue↔red is also the documented diverging pair
(warm/cool poles that read as opposite), which is precisely the semantics of a win-challenge round
strip. And every use of it carries a second channel anyway (§7.6), so nothing in the recap depends
on hue at all.

`DIVERGENCE: gridlines are 2px, not the dataviz hairline.` dataviz specifies 1px solid
gridlines; BUILD_PROMPT §6.4 forbids anything under 2px. The prompt wins because it is right about
the medium: a 1px line at 1080p inside a 6000 kbps H.264 stream is dithered into noise or
disappears entirely, depending on what moved in the previous frame. Every stroke in the recap is
≥ 3px and no gridline is under 2px. This is not a taste divergence, it is a delivery-channel one.

### 7.2 The five figures, and why each form fits its data

| # | Figure | Data | Form | Why this form |
|---|---|---|---|---|
| 1 | **The headline** | `outcomes.games_won` / `games_played` | **hero figure**, 76px | One number leads the card. A one-bar bar chart of "6 of 8" is the canonical dataviz mistake — the ratio *is* the sentence. Exactly one hero per view. |
| 2 | **KPI row** | `outcomes.*`, `attempts.*`, `sessionTime.total_ms` | **six stat tiles** | A handful of headline numbers is a KPI row, never a grouped bar chart. There is no comparison to make between "games skipped" and "total attempts" — they are different units. Tiles say so; a shared axis would lie. |
| 3 | **Per-game table** | `perGame[]` — up to ~24 rows | **table with two in-row bar columns** | More than ~7 categories that all carry meaning is a table. Two measures (losses, duration) on one shared row label is the honest alternative to a dual axis: two bar columns, two independent scales, one category axis. This is the main figure of the recap. |
| 4 | **Round strip** | `perRound[]` — 20…400 rows | **diverging column chart**, wins up / losses down from a centre baseline | The data's job is polarity over time, which is the textbook diverging case. It also happens to be the most *readable* thing on the card at a glance: the shape of the night — a long red comb with three blue spikes — communicates before any number is read. |
| 5 | **Per-lap** (only if `sessionTime.loop && perLap.length > 1`) | `perLap[]` — 2…6 rows | **grouped horizontal bars**, 2 series | Two series, few categories, magnitude comparison. At 2 series colour is comfortable for everyone and both are direct-labelled anyway. |
| — | **Worst game / fastest win** | `worstGame`, `fastestWin` | **two spotlight cards** with cover art | Single items. A chart of one value is not a chart. The cover art is the identifier (same rule as the admin library). Rendered only when non-null. |

### 7.3 Layout

`recap.html` links `/overlay.css` and adds nothing to the token set beyond §1.4. One 1440px
column, centred, on a `--viz-plate` card at `--r-xl`, `padding: 60px`, sized for a 1920×1080
browser source.

```
┌─ 1440 ─────────────────────────────────────────────────────────────────┐
│  MARIO-ABEND                                       20.08.2026 · 3:12 h │  28px/600 + 20px --ink-300
│                                                                        │
│  6 von 8 gewonnen                                                      │  76px/800 hero
│                                                                        │
│  ┌ Gespielt ┐┌ Gewonnen ┐┌ Abgebroch ┐┌ Übersprg ┐┌ Runden ┐┌ Siege ┐  │  6 tiles, 42px values
│  │    8     ││    6     ││     1     ││    1     ││  147   ││  23   │  │
│  └──────────┘└──────────┘└───────────┘└──────────┘└────────┘└───────┘  │
│                                                                        │
│  ZEIT & NIEDERLAGEN PRO SPIEL                                          │  13px/700 .14em
│  ▸ Elden Ring       ✓ gewonnen  ████████████████ 31   ██████ 42:10     │  44px rows
│  ▸ Celeste          ✓ gewonnen  ████ 7            ███ 18:44            │
│  ▸ Getting Over It  → übersprg. ██████████ 19     ████ 26:02           │
│                                                                        │
│  RUNDENVERLAUF                                                         │
│      ▲ Siege                                                           │
│   ───┼┬─┬────┬──┬──────────┬───┬─────────────────────────  baseline    │
│      ┴┴ ┴┴┴┴ ┴┴ ┴┴┴┴┴┴┴┴┴┴ ┴┴┴ ┴┴┴┴┴┴┴  ▼ Niederlagen                 │
│                                                                        │
│  ┌ Härtestes Spiel ────────┐   ┌ Schnellster Sieg ───────┐             │
│  │ [cover] Elden Ring  31  │   │ [cover] Celeste  4:12   │             │
│  └─────────────────────────┘   └─────────────────────────┘             │
└────────────────────────────────────────────────────────────────────────┘
```

Stat tile contract (dataviz): `label` sentence case no colon, 13px/600 `--ink-300`; `value`
`--t-2xl` (42px)/700 `--ink-000`, **proportional** figures (a standalone display number, not a
column); no delta (there is no previous period); no sparkline. Tile:
`background: var(--ink-800); border-radius: var(--r-md); padding: var(--s-4)`.

### 7.4 Figure 3 — the per-game table, literal

```
row height        44px
cover thumb       24 x 32, --r-sm
title             20px/600 --ink-000, one line, ellipsis at 260px
outcome cell      140px: 20px authored SVG glyph + German word, 16px/500 --ink-200
losses bar        track 300px, fill --viz-loss, height --viz-bar (20px),
                  border-radius 0 4px 4px 0   (4px rounded data-end, square at the baseline)
losses label      the value, 20px/700 tabular, --ink-000, 8px past the bar tip
duration bar      track 220px, fill --viz-mute, same geometry
duration label    mm:ss, 20px/700 tabular, --ink-200, 8px past the tip
row separator     2px --viz-grid   (not 1px — §7.1)
adjacent bars     2px --viz-surface gap, never a stroke around the mark
```

Sort: **`losses` descending**, then `started_at` ascending. The question this figure answers is
"which game destroyed him", so the worst game is row 1. Both bar columns are scaled independently
(`value / max(column)`) and each column's max is printed once in its 13px header — that is the
"two charts, not two axes" rule made concrete.

If a value's label does not fit past its bar tip inside the track's remaining width, it moves
**inside** the bar end with 8px padding and switches to `--ink-000`; it is never clipped and
`overflow: hidden` is never used to "solve" it.

Rows with `outcome === 'incomplete'` (the game that was on screen when the session ended) render
at `opacity: .62` with the word `unvollendet`. They still count in the totals — SPEC §3.3 maps
`lost := abandoned + incomplete` — and hiding them would make the KPI row and the table disagree,
which is the exact failure SPEC §3.4 warns about twice.

### 7.5 Figure 4 — the round strip, literal

```
plot            1320 x 200, centre baseline at y = 100
baseline        3px --viz-axis, full width
column          width = min(14, (1320 - (n-1)*2) / n) px, computed in recap.js and written
                as a px value; gap = 2px. At n = 240 that is 3.51px; the 3px floor is not
                reached until n = 264, so the window below almost never triggers.
win column      grows UP from the baseline, fill --viz-win, radius 4px 4px 0 0
loss column     grows DOWN from the baseline, fill --viz-loss, radius 0 0 4px 4px
height          round_ms scaled to a 78px half-height, clipped at 78px
                (a 20-minute round is a full-height column, not a broken chart)
gridline        2px --viz-grid at +78 and -78 only. Two gridlines. No more.
direct labels   exactly three: the longest round ("14:22 längste Runde"), and the
                two axis ends ("Siege" / "Niederlagen", 13px/700 .14em, --ink-200)
```

`n > 240` — a very long night. The strip then plots **the last 240 rounds** and the section
header gains `· letzte 240 Runden`. `ponytail: slice, don't aggregate. Bucketing rounds would
change the measure from "one round" to "several rounds" halfway down a threshold, and two
different units in one chart across a data-volume boundary is worse than an honest, labelled
window. Ceiling: if sessions routinely exceed 240 rounds, facet the strip per lap instead.`

Encoding audit: direction (up/down) carries win/loss, hue reinforces it, and the two axis-end
labels name both. Colour is never alone (BUILD_PROMPT §6.4). A single series would need no
legend; this one has two, so the two direct axis labels *are* the legend.

### 7.6 The accessibility floor for every figure

- **Every value that matters is printed.** Table bars carry their number; the strip labels its
  extreme; the KPI tiles *are* numbers. Nothing requires reading a bar against an axis.
- **No figure relies on hue.** Table: glyph + German word. Strip: direction. Per-lap: direct
  labels on both series plus a legend. KPI/hero: no colour at all.
- **Legends:** the per-lap grouped bars get one (≥ 2 series, dataviz's rule); the round strip's
  axis-end labels serve as its legend; nothing else has ≥ 2 series.
- **Text never wears a data colour.** Values and labels are `--ink-000` / `--ink-200` /
  `--ink-300`; identity comes from the coloured mark beside them.
- No tooltips, no hover layer, no crosshair. The recap is a broadcast still on a machine with no
  pointer. dataviz's default interaction layer is correct for a web dashboard and wrong here; the
  compensation is that every value is already printed on the mark.

### 7.7 The recap's one animation

SPEC §7.7: static after a single fade-in. Four blocks, `320ms` each, staggered `120ms`, so at
most three overlap — inside the §7.6 ceiling of four:

```css
#recap > * { animation: rise 320ms var(--e-out) both; }
#recap > :nth-child(1) { animation-delay:   0ms; }
#recap > :nth-child(2) { animation-delay: 120ms; }
#recap > :nth-child(3) { animation-delay: 240ms; }
#recap > :nth-child(4) { animation-delay: 360ms; }
@keyframes rise { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: none; } }
```

**The bars do not grow.** No per-bar `scaleX(0 → 1)`. Twenty-four simultaneously animating bars
is a six-fold violation of §7.6's ceiling, it is the single most common way a "premium" recap
screen burns 12% CPU, and the recap is a still frame — the block it lives in already rose.

---

## 8. Typography

### 8.1 The one face

Inter, variable, latin subset, self-hosted at `/fonts/inter-var-latin.woff2` (SPEC §1). One file,
one request, no CDN — the streaming PC may be firewalled, and a fallback font on camera does not
look like a fallback font, it looks like a broken overlay.

`LITERAL:` in `public/overlay.css` and, byte-identically, in `public/admin/admin.css`:

```css
@font-face {
  font-family: 'Inter';
  src: url('/fonts/inter-var-latin.woff2') format('woff2');
  font-weight: 400 900;
  font-style: normal;
  font-display: block;
  /* format('woff2') — NOT format('woff2-variations'). The latter is a dead early-draft keyword
     that Chromium (and therefore OBS's CEF) does not recognise, and an unrecognised format()
     makes the UA skip that src component entirely: Inter would never even be requested, and
     font-display:block hides the swap, so the whole overlay renders in the CEF default font with
     no 404 in the log to explain it. Plain woff2 loads variable fonts everywhere.
     font-display:block, not swap: a FOUT on camera looks broken. */
}
```

**Subset:** latin only, which covers `ä ö ü ß Ä Ö Ü` — all the German copy in `strings.js` needs.
No `unicode-range`: there is exactly one file, so a range declaration could only ever *prevent*
a load. Target file size ≤ 100 KB; if the shipped variable file is larger, subset it with
`pyftsubset --unicodes=U+0000-00FF,U+2013-2014,U+2018-201A,U+201C-201E,U+2022,U+00B7`
(the last few cover the `·` separator and typographic quotes the copy uses).

**Weights used — four, no more:** `400` body/meta · `600` titles, tile labels · `800` every hero
numeral and primary button · `900` the `GEWONNEN` banner only. A variable axis makes intermediate
weights free, which is exactly why the set has to be declared: four steps are a hierarchy, nine
are mush.

`font-feature-settings` is not set. Inter's defaults are correct and every feature this design
needs is expressible through the standard `font-variant-numeric` property, which is what
Chromium optimises.

### 8.2 Numbers are the hero content

```css
/* every counter, every axis tick, every table column of numbers */
#card,
#live-readout .counters,
.viz-table,
.viz-axis { font-variant-numeric: tabular-nums; }

/* the standalone display numbers: proportional, because tabular gives '121' the width of
   '000' and it reads loose at 42px+ */
.kpi-value,
.hero-figure { font-variant-numeric: normal; }
```

The split is deliberate and it is the one place this document overrides dataviz:

| | tabular | proportional |
|---|---|---|
| **Overlay** `#loss-now`, `#streak-now` | **yes** | — |
| Overlay `#attempts`, `#meta` | yes | — |
| Admin readout counters | yes | — |
| Recap table columns, axis ticks | yes | — |
| Recap hero figure, KPI tile values | — | **yes** |

dataviz says a large standalone value should use proportional figures, and it is right about
print and dashboards. It loses on the overlay for two mechanical reasons: (1) `#loss-prev` is
stacked pixel-exactly over `#loss-now` and the §4.4 swap only reads as *one number changing* if
both glyph sets have identical advance widths; (2) a counter that shifts its own baseline
position while the streamer is looking at the game is a counter nobody trusts. Tabular figures
plus the fixed 196px plate plus centred alignment (§3.2) is what makes `9 → 10` and `99 → 100`
cost zero layout and zero visible movement other than the intended one.

`letter-spacing`: `-0.03em` on the 92px numerals (Inter's default tracking is loose at display
size), `-0.02em` at 42–76px, `0` at 16–26px, `+0.14em` on every uppercase micro-label. The
tracking floor is `-0.04em` and nothing here approaches it.

### 8.3 The complete type inventory

| Element | Size | Weight | Colour | Tracking | Notes |
|---|---|---|---|---|---|
| `#loss-now`, `#streak-now` | `--t-hero` 92 | 800 | `--ink-000` | −.03em | tabular, `line-height: 1` |
| `#streak-req` | `--t-2xl` 42 | 700 | `--ink-200` | −.02em | baseline-aligned to the hero |
| `#banner-text` line 1 (`won`) | `--t-2xl` 42 | 900 | `--ink-000` | +.06em | uppercase, `::first-line` |
| `#banner-text` line 2 | `--t-md` 20 | 600 | `--ink-000` | +.04em | tabular |
| `#title` | `--t-lg` 26 | 600 | `--ink-000` | 0 | 22ch, 2-line clamp, `line-height: 1.15` |
| `#meta` | `--t-sm` 16 | 400 | `--ink-200` | 0 | tabular |
| `#loss-label`, `#streak-label` | `--t-xs` 13 | 600 / 700 | `--ink-200` / `--ink-000` | +.14em | uppercase |
| `#attempts` | `--t-md` 20 | 500 | `--ink-200` | 0 | tabular |
| recap title | 28 | 600 | `--ink-000` | 0 | |
| recap hero | `--t-4xl` 76 | 800 | `--ink-000` | −.02em | **proportional** |
| KPI value | `--t-2xl` 42 | 700 | `--ink-000` | −.02em | **proportional** |
| KPI label | `--t-xs` 13 | 600 | `--ink-300` | 0 | sentence case, no colon |
| section label | `--t-xs` 13 | 700 | `--ink-200` | +.14em | uppercase |
| admin readout counter | `--t-xl` 33 | 800 | `--ink-000` | −.02em | tabular |
| admin button label | `--t-md` 20 | 800 | `--ink-000` | +.02em | uppercase on WIN/LOSS/SKIP only |
| admin body / row title | `--t-sm` 16 | 400 / 600 | `--ink-000` | 0 | |
| admin caption | `--t-xs` 13 | 500 | `--ink-300` | 0 | opaque surfaces only |

`--ink-300` never appears in the overlay column. See §2.3.

### 8.4 Copy

All of it German, all of it in `public/strings.js` (SPEC §1.1). Two rules for whoever writes it:

- **Overlay copy is a label, not a sentence.** `NIEDERLAGEN`, `SERIE`, `GEWONNEN`,
  `ÜBERSPRUNGEN`, `SESSION BEENDET`. Nothing on camera is longer than two words, because the type
  scale is built for two words and a third would force a size the hierarchy does not have.
- **Admin copy names the action and, on failure, the recovery.** `Nach diesem Spiel stoppen`, not
  `Loop-Stop`. `Bereits gespielt — kann nicht entfernt werden`, not `409`. `Nichts zum
  Rückgängigmachen`, not `Fehler`.

### 8.5 Icons

Six icons exist in this product. **All six are authored inline SVG**, one consistent 2.5px
stroke, `stroke-linecap: round`, `currentColor`, drawn on a 24×24 grid and rendered at 20px
(recap) or 24px (admin). No icon font, no emoji, no Unicode glyph standing in for an icon —
including the drag handle, which is six 2.5px dots on the same 24×24 grid and **not** `⠿`.

| Icon | Where | Meaning |
|---|---|---|
| check | recap table, admin | `outcome: won` |
| arrow-right | recap table | `outcome: skipped` |
| slash-circle | recap table | `outcome: abandoned` |
| dash | recap table | `outcome: incomplete` |
| grip (6 dots) | admin 8.3 | drag handle |
| copy | admin 8.5 | copy to clipboard |

Each is paired with a text label everywhere it appears. An icon never carries meaning alone,
which is also what makes the recap's outcome column colour-independent (§7.6).

---

## 9. What an implementer must verify before calling this done

Six checks, each one runnable, none of them "looks fine to me":

1. **Token drift.** `diff <(sed -n '/TOKENS-BEGIN/,/TOKENS-END/p' public/overlay.css)
   <(sed -n '/TOKENS-BEGIN/,/TOKENS-END/p' public/admin/admin.css)` prints nothing.
2. **The ban list.** `grep -nE '(transition|animation)[^;]*(width|height|top|left|right|bottom|inset|margin|padding|gap|font-size|letter-spacing|line-height|border|box-shadow|text-shadow|filter|background|clip-path)' public/*.css public/admin/*.css` prints nothing.
   Then read every `@keyframes` body and confirm only `transform` and `opacity` appear.
3. **The contrast lock.** Load the overlay over a pure-white page at `?opacity=0.30` and
   screenshot it. The hero number must be as legible as it is at `?opacity=1.00`. If it is not,
   `--scrim` or `--plate-fill` has been made tunable and §2.3 is broken.
4. **The accent extremes.** `?accent=000000` and `?accent=ffffff`, in `LOSS_MODE`, `STREAK_MODE`
   and through a `game_won`. Nothing may become unreadable and the flame must still read as a
   flame at both ends.
5. **The resting budget.** SPEC §7.6's measurement protocol, both numbers in the README. The
   `LOSS_MODE` trace must show **zero** style/layout/paint activity between heartbeats and a
   layout-shift count of 0. If it does not, something is animating that this document says is
   static — most likely a leaked `will-change` or an unscoped `@keyframes`.
6. **The thumb.** Open the admin on an actual phone, hold it in one hand, and press WIN, LOSS,
   SKIP and UNDO twenty times each without looking at the screen. Count the mis-hits. If UNDO
   fires once, §6.3 failed and the hold duration goes up before anything else changes.
