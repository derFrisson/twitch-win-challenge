// public/recap.js
//
// Fetches recap.json and renders the end-of-stream summary card (SPEC §7.7, BUILD_PROMPT §6.4,
// DESIGN §7). No chart library, no build step: every figure is hand-built inline SVG or HTML.
//
// This module is imported by recap.html, at `/o/<token>/recap` — the OBS browser-source scene.
// `main()` below runs automatically because that page has an element with id="recap-root".
//
// It also exports its render* functions per-figure (not just the one full-page `renderRecap()`)
// so a second consumer can reuse just the pieces it needs against the identical `Recap` shape.
// admin.js's History section does exactly that (DESIGN §8.6: "the same recap components as §7 —
// the KPI row and the per-game table, rendered from the identical markup and CSS. No second
// implementation") via its own authenticated `GET /api/admin/sessions/:id/recap` (route #28,
// same shape as this page's `recap.json`, both built by `loadRecap()` in src/index.ts).
//
// ponytail: the component CSS below is injected into <head> once on first import, rather than
// written into overlay.css or admin.css — neither file belongs to this agent, and SPEC §1's file
// tree has no recap.css. One canonical stylesheet, however many pages import this module, with
// zero duplication risk between three independently-built files. Every colour var() carries a
// literal fallback (the validated hex from DESIGN §1.1/§1.4) so the markup still reads correctly
// on a host page that has not linked /overlay.css — the one integration seam between the three
// agents building this app in parallel. Ceiling: if a fourth surface ever needs this, promote
// the CSS to a real public/recap.css and drop the injection.

import { STRINGS, fmtNumber, fmtDate, fmtClock, fmtHours } from './strings.js';

// ---------------------------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------------------------

function esc(value) {
  return String(value).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// A cover thumbnail with a deliberate empty state (no <img> at all, not a broken-image glyph)
// for a null cover_key or a 404'd R2 object — same principle as the overlay's
// `#card[data-cover="none"]` (SPEC §7.1), scaled down to table-row size.
function coverThumb(coverKey, w, h) {
  const img = coverKey
    ? `<img src="/covers/${encodeURIComponent(coverKey)}" alt="" loading="lazy" onerror="this.remove()">`
    : '';
  return `<span class="r-cover" style="width:${w}px;height:${h}px">${img}</span>`;
}

const OUTCOME_ICON = {
  won: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="5 13 10 18 19 7"/></svg>',
  skipped: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="12" x2="17" y2="12"/><polyline points="11 6 17 12 11 18"/></svg>',
  abandoned: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8"/><line x1="6.3" y1="17.7" x2="17.7" y2="6.3"/></svg>',
  incomplete: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="12" x2="18" y2="12"/></svg>',
};

function section(title, bodyHtml) {
  return `<section class="r-section"><h2 class="r-section-title">${esc(title)}</h2>${bodyHtml}</section>`;
}

// ---------------------------------------------------------------------------------------------
// figure renderers — each takes the `Recap` shape from src/recap.ts's buildRecap() /
// src/index.ts's loadRecap() (route #28 and #35 both return this exact object) and returns an
// HTML string. Pure functions: no fetch, no DOM reads, safe to call from either host page.
// ---------------------------------------------------------------------------------------------

export function renderHeader(recap) {
  const t = recap.sessionTime;
  const live = t.status === 'live';
  const duration = fmtHours(t.total_ms) + (live ? STRINGS.recap.inProgressSuffix : '');
  return `<div class="r-head">
    <span class="r-title">${esc(t.title || STRINGS.recap.untitled)}</span>
    <span class="r-meta">${esc(fmtDate(t.started_at))} · ${esc(duration)}</span>
  </div>`;
}

export function renderHero(recap) {
  const o = recap.outcomes;
  return `<div class="r-hero">${esc(STRINGS.recap.hero(o.games_won ?? 0, o.games_played ?? 0))}</div>`;
}

// Figure 2 — the KPI row (DESIGN §7.2/§7.3). Six stat tiles, no chart: different units, so a
// shared axis would lie.
export function renderKpiRow(recap) {
  const o = recap.outcomes;
  const a = recap.attempts;
  const tiles = [
    [STRINGS.recap.kpi.played, o.games_played ?? 0],
    [STRINGS.recap.kpi.won, o.games_won ?? 0],
    [STRINGS.recap.kpi.lost, o.games_lost ?? 0],
    [STRINGS.recap.kpi.skipped, o.games_skipped ?? 0],
    [STRINGS.recap.kpi.rounds, a.attempts ?? 0],
    [STRINGS.recap.kpi.wins, a.wins ?? 0],
  ];
  const cells = tiles
    .map(([label, value]) => `<div class="r-kpi"><div class="r-kpi-label">${esc(label)}</div><div class="r-kpi-value">${fmtNumber(value)}</div></div>`)
    .join('');
  return `<div class="r-kpis">${cells}</div>`;
}

// Figure 3 — the per-game table (DESIGN §7.4), the main figure of the recap. Sort is a display
// concern (DESIGN §7.4: "losses descending, then started_at ascending") — Q_PER_GAME itself
// orders by (lap, started_at) because that is the order the recap SQL needs for correctness, so
// the sort happens here, on a copy.
export function renderPerGameTable(recap) {
  const rows = [...(recap.perGame ?? [])].sort(
    (a, b) => b.losses - a.losses || Date.parse(a.started_at) - Date.parse(b.started_at),
  );
  if (rows.length === 0) {
    return section(STRINGS.recap.table.title, `<p class="r-empty">${esc(STRINGS.recap.table.empty)}</p>`);
  }
  const maxLosses = Math.max(1, ...rows.map((r) => r.losses));
  const maxMs = Math.max(1, ...rows.map((r) => r.game_ms));

  const head = `<div class="r-row r-row-head">
    <div class="r-cell r-cell-game"></div>
    <div class="r-cell r-cell-outcome"></div>
    <div class="r-cell r-cell-bar r-col-head">${esc(STRINGS.recap.table.lossesCol)} · ${esc(STRINGS.recap.table.max(fmtNumber(maxLosses)))}</div>
    <div class="r-cell r-cell-bar r-col-head">${esc(STRINGS.recap.table.durationCol)} · ${esc(STRINGS.recap.table.max(fmtClock(maxMs)))}</div>
  </div>`;

  const body = rows
    .map((r) => {
      const lossPct = (r.losses / maxLosses) * 100;
      const msPct = (r.game_ms / maxMs) * 100;
      const word = STRINGS.recap.outcome[r.outcome] ?? STRINGS.recap.outcome.incomplete;
      const icon = OUTCOME_ICON[r.outcome] ?? OUTCOME_ICON.incomplete;
      return `<div class="r-row${r.outcome === 'incomplete' ? ' r-row-incomplete' : ''}">
        <div class="r-cell r-cell-game">
          ${coverThumb(r.cover_key, 24, 32)}
          <span class="r-row-title" title="${esc(r.title)}">${esc(r.title)}</span>
        </div>
        <div class="r-cell r-cell-outcome"><span class="r-outcome-icon">${icon}</span>${esc(word)}</div>
        <div class="r-cell r-cell-bar">
          <div class="r-bar-track r-bar-track-loss"><div class="r-bar-fill r-bar-loss" style="width:${lossPct}%"></div></div>
          <span class="r-bar-label">${fmtNumber(r.losses)}</span>
        </div>
        <div class="r-cell r-cell-bar">
          <div class="r-bar-track r-bar-track-dur"><div class="r-bar-fill r-bar-mute" style="width:${msPct}%"></div></div>
          <span class="r-bar-label">${esc(fmtClock(r.game_ms))}</span>
        </div>
      </div>`;
    })
    .join('');

  return section(STRINGS.recap.table.title, `<div class="r-table" role="table">${head}${body}</div>`);
}

// Figure 4 — the round strip (DESIGN §7.5): a diverging column chart, wins up / losses down from
// a centre baseline. The data's job is polarity over time; the shape of the night communicates
// before any number is read.
export function renderRoundStrip(recap) {
  const all = recap.perRound ?? [];
  if (all.length === 0) {
    return section(STRINGS.recap.roundStrip.title, `<p class="r-empty">${esc(STRINGS.recap.roundStrip.empty)}</p>`);
  }

  const WINDOW = 240;
  const truncated = all.length > WINDOW;
  // ponytail: slice, don't aggregate (DESIGN §7.5). Bucketing would change the measure from "one
  // round" to "several rounds" partway down the chart; an honest, labelled window is the
  // cheaper and more truthful fix. Ceiling: if sessions routinely exceed 240 rounds, facet the
  // strip per lap instead.
  const rows = truncated ? all.slice(all.length - WINDOW) : all;

  const W = 1320;
  const BASE = 100;
  const HALF = 78;
  const GAP = 2;
  const n = rows.length;
  const colW = Math.max(3, Math.min(14, (W - (n - 1) * GAP) / n));
  const totalW = n * colW + (n - 1) * GAP;
  const startX = (W - totalW) / 2;
  const CAP_MS = 20 * 60 * 1000; // a 20-minute round is a full-height column (DESIGN §7.5)

  let longest = rows[0];
  for (const r of rows) if (r.round_ms > longest.round_ms) longest = r;

  const bars = rows
    .map((r, i) => {
      const x = startX + i * (colW + GAP);
      const h = Math.max(1, Math.min(HALF, (r.round_ms / CAP_MS) * HALF));
      const isWin = r.type === 'win';
      const y = isWin ? BASE - h : BASE;
      const rx = Math.min(4, colW / 2);
      return `<rect class="${isWin ? 'r-strip-win' : 'r-strip-loss'}" x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${colW.toFixed(2)}" height="${h.toFixed(2)}" rx="${rx.toFixed(2)}" ry="${rx.toFixed(2)}"></rect>`;
    })
    .join('');

  const svg = `<svg viewBox="0 0 ${W} 200" class="r-strip-svg" role="img" aria-label="${esc(STRINGS.recap.roundStrip.title)}">
    <line class="r-strip-grid" x1="0" y1="${BASE - HALF}" x2="${W}" y2="${BASE - HALF}"></line>
    <line class="r-strip-grid" x1="0" y1="${BASE + HALF}" x2="${W}" y2="${BASE + HALF}"></line>
    <line class="r-strip-baseline" x1="0" y1="${BASE}" x2="${W}" y2="${BASE}"></line>
    ${bars}
  </svg>`;

  const title = STRINGS.recap.roundStrip.title + (truncated ? STRINGS.recap.roundStrip.truncatedSuffix(WINDOW) : '');
  const body = `
    <div class="r-strip-row r-strip-row-top"><span class="r-strip-endlabel r-strip-endlabel-win">${esc(STRINGS.recap.legend.wins)}</span></div>
    ${svg}
    <div class="r-strip-row r-strip-row-bottom">
      <span class="r-strip-endlabel r-strip-endlabel-loss">${esc(STRINGS.recap.legend.losses)}</span>
      <span class="r-strip-note">${esc(fmtClock(longest.round_ms))} ${esc(STRINGS.recap.roundStrip.longest)}</span>
    </div>`;
  return section(title, body);
}

// Figure 5 — per-lap breakdown (DESIGN §7.2), only when the session actually looped. SPEC/DESIGN
// both call for this to be omitted entirely, not rendered empty, when there is nothing to show.
export function renderPerLap(recap) {
  const looped = !!recap.sessionTime.loop;
  const laps = recap.perLap ?? [];
  if (!looped || laps.length <= 1) return '';

  const max = Math.max(1, ...laps.flatMap((l) => [l.wins, l.losses]));
  const rows = laps
    .map((l) => {
      const winPct = (l.wins / max) * 100;
      const lossPct = (l.losses / max) * 100;
      return `<div class="r-lap-row">
        <div class="r-lap-label">${esc(STRINGS.recap.perLap.lapLabel(l.lap))}</div>
        <div class="r-lap-bars">
          <div class="r-lap-bar-track"><div class="r-lap-bar r-lap-bar-win" style="width:${winPct}%"></div></div>
          <span class="r-bar-label">${fmtNumber(l.wins)}</span>
          <div class="r-lap-bar-track"><div class="r-lap-bar r-lap-bar-loss" style="width:${lossPct}%"></div></div>
          <span class="r-bar-label">${fmtNumber(l.losses)}</span>
        </div>
      </div>`;
    })
    .join('');

  const legend = `<div class="r-legend">
    <span class="r-legend-item"><span class="r-swatch r-swatch-win"></span>${esc(STRINGS.recap.legend.wins)}</span>
    <span class="r-legend-item"><span class="r-swatch r-swatch-loss"></span>${esc(STRINGS.recap.legend.losses)}</span>
  </div>`;
  return section(STRINGS.recap.perLap.title, legend + rows);
}

// The two spotlight cards (DESIGN §7.2): single items, so a chart of one value is not a chart.
export function renderSpotlights(recap) {
  const w = recap.worstGame;
  const f = recap.fastestWin;

  const worstBody = w
    ? `${coverThumb(w.cover_key, 48, 64)}<div class="r-spot-text"><div class="r-spot-title">${esc(w.title)}</div><div class="r-spot-stat">${esc(STRINGS.common.losses(w.losses))}${w.laps_involved > 1 ? ` · ${esc(STRINGS.recap.spotlight.overLaps(w.laps_involved))}` : ''}</div></div>`
    : `<p class="r-empty">${esc(STRINGS.recap.spotlight.noLosses)}</p>`;

  const fastestBody = f
    ? `${coverThumb(f.cover_key, 48, 64)}<div class="r-spot-text"><div class="r-spot-title">${esc(f.title)}</div><div class="r-spot-stat">${esc(fmtClock(f.ms))} · ${esc(STRINGS.common.attempts(f.attempts))}</div></div>`
    : `<p class="r-empty">${esc(STRINGS.recap.spotlight.noWins)}</p>`;

  return `<div class="r-spotlights">
    <div class="r-spot">${section(STRINGS.recap.spotlight.worst, `<div class="r-spot-body">${worstBody}</div>`)}</div>
    <div class="r-spot">${section(STRINGS.recap.spotlight.fastest, `<div class="r-spot-body">${fastestBody}</div>`)}</div>
  </div>`;
}

// The full card, in DESIGN §7.3's order. Wrapped in one `.recap` element so the fade-in rule
// (§7.7) can target its direct children generically, whatever the exact section count for this
// session (a non-looped session has one fewer child than a looped one).
export function renderRecap(recap) {
  const blocks = [
    `<div class="r-block">${renderHeader(recap)}${renderHero(recap)}${renderKpiRow(recap)}</div>`,
    renderPerGameTable(recap),
    renderRoundStrip(recap),
    renderPerLap(recap),
    renderSpotlights(recap),
  ].filter(Boolean);
  return `<div class="recap">${blocks.join('')}</div>`;
}

// ---------------------------------------------------------------------------------------------
// component CSS — injected once, shared by every page that imports this module (see file header)
// ---------------------------------------------------------------------------------------------

function injectStyles() {
  if (document.getElementById('recap-styles')) return;
  const style = document.createElement('style');
  style.id = 'recap-styles';
  style.textContent = `
.recap {
  box-sizing: border-box;
  max-width: 1440px;
  width: 100%;
  margin: 0 auto;
  padding: 60px;
  border-radius: var(--r-xl, 22px);
  background: var(--viz-plate, rgba(5, 6, 10, .96));
  color: var(--ink-000, #fff);
  font: 400 var(--t-sm, 16px)/1.4 'Inter', system-ui, sans-serif;
  display: flex;
  flex-direction: column;
  gap: var(--s-6, 32px);
}
@media (max-width: 900px) {
  .recap { padding: var(--s-5, 24px); gap: var(--s-5, 24px); }
}
.recap > * { animation: r-rise 320ms var(--e-out, cubic-bezier(.16,1,.3,1)) both; }
.recap > *:nth-child(1) { animation-delay: 0ms; }
.recap > *:nth-child(2) { animation-delay: 120ms; }
.recap > *:nth-child(3) { animation-delay: 240ms; }
.recap > *:nth-child(4) { animation-delay: 360ms; }
.recap > *:nth-child(5) { animation-delay: 480ms; }
@keyframes r-rise { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: none; } }

.r-block { display: flex; flex-direction: column; gap: var(--s-5, 24px); }

.r-head { display: flex; justify-content: space-between; align-items: baseline; gap: var(--s-4, 16px); flex-wrap: wrap; }
.r-title { font-size: 28px; font-weight: 600; color: var(--ink-000, #fff); }
.r-meta { font-size: var(--t-md, 20px); color: var(--ink-300, #9BA4B4); font-variant-numeric: tabular-nums; }

.r-hero { font-size: var(--t-4xl, 76px); font-weight: 800; letter-spacing: -.02em; color: var(--ink-000, #fff); }

.r-kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: var(--s-3, 12px); }
.r-kpi { background: var(--ink-800, #171A22); border-radius: var(--r-md, 12px); padding: var(--s-4, 16px); }
.r-kpi-label { font-size: var(--t-xs, 13px); font-weight: 600; color: var(--ink-300, #9BA4B4); }
.r-kpi-value { font-size: var(--t-2xl, 42px); font-weight: 700; letter-spacing: -.02em; color: var(--ink-000, #fff); margin-top: var(--s-1, 4px); }

.r-section { display: flex; flex-direction: column; gap: var(--s-3, 12px); }
.r-section-title { font-size: var(--t-xs, 13px); font-weight: 700; letter-spacing: .14em; text-transform: uppercase; color: var(--ink-200, #C6CCD8); margin: 0; }

.r-empty { font-size: var(--t-md, 20px); color: var(--ink-300, #9BA4B4); margin: 0; padding: var(--s-4, 16px) 0; }

/* Figure 3 — per-game table */
.r-table { display: flex; flex-direction: column; overflow-x: auto; }
.r-row {
  display: grid;
  grid-template-columns: minmax(140px, 280px) minmax(96px, 140px) minmax(140px, 1fr) minmax(120px, 1fr);
  align-items: center;
  gap: var(--s-4, 16px);
  min-height: 44px;
  padding: var(--s-2, 8px) 0;
  border-bottom: 2px solid var(--viz-grid, #3D4557);
}
.r-row:last-child { border-bottom: none; }
.r-row-head { min-height: 0; padding-bottom: var(--s-2, 8px); }
.r-row-incomplete { opacity: .62; }
.r-cell-game { display: flex; align-items: center; gap: var(--s-3, 12px); min-width: 0; }
.r-row-title { font-size: var(--t-md, 20px); font-weight: 600; color: var(--ink-000, #fff); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.r-cell-outcome { display: flex; align-items: center; gap: var(--s-2, 8px); font-size: var(--t-sm, 16px); font-weight: 500; color: var(--ink-200, #C6CCD8); white-space: nowrap; }
.r-outcome-icon { display: inline-flex; color: var(--ink-300, #9BA4B4); flex: none; }
.r-col-head { font-size: var(--t-xs, 13px); font-weight: 700; color: var(--ink-300, #9BA4B4); text-transform: uppercase; letter-spacing: .06em; }
.r-cell-bar { display: flex; align-items: center; gap: var(--s-2, 8px); min-width: 0; }
.r-bar-track { height: var(--viz-bar, 20px); border-radius: 0 4px 4px 0; background: var(--ink-800, #171A22); overflow: hidden; flex: 1 1 auto; min-width: 24px; }
.r-bar-track-loss { max-width: 300px; }
.r-bar-track-dur { max-width: 220px; }
.r-bar-fill { height: 100%; border-radius: 0 4px 4px 0; }
.r-bar-loss { background: var(--viz-loss, #E66767); }
.r-bar-mute { background: var(--viz-mute, #6E7889); }
.r-bar-label { font-size: var(--t-md, 20px); font-weight: 700; font-variant-numeric: tabular-nums; color: var(--ink-000, #fff); white-space: nowrap; flex: none; }

.r-cover {
  display: inline-flex;
  flex: none;
  border-radius: var(--r-sm, 6px);
  background: linear-gradient(135deg, var(--ink-700, #232733), var(--ink-800, #171A22));
  overflow: hidden;
  position: relative;
}
.r-cover img { width: 100%; height: 100%; object-fit: cover; display: block; }

/* Figure 4 — round strip */
.r-strip-svg { display: block; width: 100%; height: 200px; }
.r-strip-win { fill: var(--viz-win, #3987E5); }
.r-strip-loss { fill: var(--viz-loss, #E66767); }
.r-strip-grid { stroke: var(--viz-grid, #3D4557); stroke-width: var(--viz-grid-w, 2px); }
.r-strip-baseline { stroke: var(--viz-axis, #4B5364); stroke-width: var(--viz-axis-w, 3px); }
.r-strip-row { display: flex; justify-content: space-between; align-items: center; }
.r-strip-endlabel { font-size: var(--t-xs, 13px); font-weight: 700; letter-spacing: .14em; text-transform: uppercase; color: var(--ink-200, #C6CCD8); }
.r-strip-note { font-size: var(--t-sm, 16px); font-weight: 600; color: var(--ink-300, #9BA4B4); font-variant-numeric: tabular-nums; }

/* Figure 5 — per-lap grouped bars */
.r-lap-row { display: grid; grid-template-columns: minmax(90px, 140px) 1fr; align-items: center; gap: var(--s-3, 12px); padding: var(--s-2, 8px) 0; }
.r-lap-label { font-size: var(--t-sm, 16px); font-weight: 600; color: var(--ink-000, #fff); }
.r-lap-bars { display: grid; grid-template-columns: 1fr auto 1fr auto; align-items: center; gap: var(--s-2, 8px); }
.r-lap-bar-track { height: var(--viz-bar, 20px); border-radius: 4px; background: var(--ink-800, #171A22); overflow: hidden; }
.r-lap-bar { height: 100%; border-radius: 4px; }
.r-lap-bar-win { background: var(--viz-win, #3987E5); }
.r-lap-bar-loss { background: var(--viz-loss, #E66767); }
.r-legend { display: flex; gap: var(--s-5, 24px); }
.r-legend-item { display: flex; align-items: center; gap: var(--s-2, 8px); font-size: var(--t-sm, 16px); color: var(--ink-200, #C6CCD8); }
.r-swatch { width: 12px; height: 12px; border-radius: 3px; display: inline-block; }
.r-swatch-win { background: var(--viz-win, #3987E5); }
.r-swatch-loss { background: var(--viz-loss, #E66767); }

/* spotlights */
.r-spotlights { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: var(--s-4, 16px); }
.r-spot-body { display: flex; align-items: center; gap: var(--s-4, 16px); }
.r-spot-text { display: flex; flex-direction: column; gap: var(--s-1, 4px); min-width: 0; }
.r-spot-title { font-size: var(--t-md, 20px); font-weight: 600; color: var(--ink-000, #fff); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.r-spot-stat { font-size: var(--t-sm, 16px); color: var(--ink-200, #C6CCD8); font-variant-numeric: tabular-nums; }

.r-error { font-size: var(--t-lg, 26px); font-weight: 600; color: var(--ink-200, #C6CCD8); padding: var(--s-7, 48px); text-align: center; }
`;
  document.head.appendChild(style);
}

injectStyles();

// ---------------------------------------------------------------------------------------------
// bootstrap — only runs on the standalone recap page (`#recap-root` present). Importing this
// module from admin.js gets the render functions and the injected CSS with no side-fetch.
// ---------------------------------------------------------------------------------------------

function renderMessage(root, message) {
  root.innerHTML = `<div class="r-error">${esc(message)}</div>`;
}

// The recap can sit open in OBS as a scene for hours (or get opened before the session even
// ends), so it re-fetches on a slow poll instead of rendering once and freezing. A body-diff
// gate means the DOM is only rebuilt when the numbers actually changed.
// ponytail: a 60s poll, not a WS. The overlay needs sub-second state (SPEC §7); the recap is
// end-of-stream numbers where a minute of staleness is invisible. Ceiling: if the recap ever
// becomes a live scoreboard, reuse the overlay's WS client instead of shortening the poll.
let lastBody = '';

async function refresh(root) {
  // Path is /o/<token>/recap (SPEC §5.2 route #34); recap.json lives one segment up under the
  // same token (route #35). ?session= passes through unchanged (SPEC §10 item 4: "?session=<id>
  // remains the explicit form"); default 'latest' resolves live-first server-side.
  const token = location.pathname.split('/')[2] ?? '';
  const want = new URLSearchParams(location.search).get('session') ?? 'latest';

  try {
    const res = await fetch(`/o/${encodeURIComponent(token)}/recap.json?session=${encodeURIComponent(want)}`, {
      cache: 'no-store',
    });
    if (res.status === 404) {
      // A definitive answer, not a blip: show it, and let the next poll pick up a new session.
      lastBody = '';
      return renderMessage(root, STRINGS.recap.errors.noSession);
    }
    if (!res.ok) {
      if (!lastBody) renderMessage(root, STRINGS.recap.errors.loadFailed);
      return; // transient failure: keep the last good render, retry on the next tick
    }
    const text = await res.text();
    if (text === lastBody) return;
    const recap = JSON.parse(text); // throws -> catch below keeps the last good render
    lastBody = text;
    root.innerHTML = renderRecap(recap);
  } catch {
    if (!lastBody) renderMessage(root, STRINGS.recap.errors.loadFailed);
  }
}

function main() {
  const root = document.getElementById('recap-root');
  if (!root) return;
  refresh(root);
  setInterval(() => {
    if (!document.hidden) refresh(root);
  }, 60_000);
}

main();
