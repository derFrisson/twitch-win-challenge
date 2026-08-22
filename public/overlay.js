// ponytail: plain ES module, no bundler, no framework. The overlay never computes state —
// it renders what the DO sends. If this file ever needs a build step, the design got too big.

// SPEC §1.1: every string a viewer reads lives in /strings.js. A NAMESPACE import is used on
// purpose — a named import of a key strings.js spells differently is a module-instantiation
// error, and that is a blank box on camera. This degrades to an empty label instead.
import * as STRINGS from '/strings.js';

// The v2 compact-list overlay reads exactly these keys (defined per-language in strings.js):
//   panelTitle(sessionTitle)                          -> 'MARIO-ABEND' / 'WIN CHALLENGE'
//   wonWord                                           -> the game-won takeover word
//   endedWord                                         -> the ended takeover word
//   endedLine(title, gamesWon, gamesPlayed, losses, durationMs|null)
//                                                     -> '6/8 gewonnen · 47 Niederlagen · 3:12 h'
const COPY = STRINGS.overlay ?? STRINGS;

// ponytail: one accessor for plain strings AND formatters. A missing key paints nothing, never
// throws, and never puts an English identifier on camera.
const str = (k, ...a) => {
  const v = COPY[k];
  return typeof v === 'function' ? v(...a) : (v ?? '');
};

// ======================== query parameters (SPEC §7.5) ========================
// Read once at load. Every value is clamped or falls back — an invalid value never breaks
// the render.

const params = new URLSearchParams(location.search);

// Note the empty/absent guard: Number(null) and Number('') are both 0, which would clamp
// ?scale= to its floor for a URL that never mentioned it.
const num = (k, def, lo, hi) => {
  const s = params.get(k);
  if (s === null || s.trim() === '') return def;
  const n = Number(s);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
};

const SCALE = num('scale', 1, 0.5, 2);
const ALPHA = num('opacity', 0.85, 0.3, 1);      // the DECORATIVE fill only (DESIGN §2.3)
const VOL = num('vol', 0.5, 0, 0.8);             // hard cap 0.8
const SFX_ON = params.get('sfx') === '1';        // off by default (prompt §6.5)
const MONO = params.get('mono') === '1';
const POS = ['tl', 'tc', 'tr', 'bl', 'bc', 'br'];
const pos = POS.includes(params.get('pos') ?? '') ? params.get('pos') : 'bl';

const root = document.documentElement;
root.style.setProperty('--scale', String(SCALE));
root.style.setProperty('--card-alpha', String(ALPHA));
root.dataset.pos = pos;
if (MONO) root.dataset.mono = '1';

// ponytail: two custom properties, one source value, zero stylesheet swapping. rgba(var(--x-rgb), a)
// is the only alpha-compositing mechanism that works in every CEF build OBS 28..31 ships;
// color-mix() needs Chromium >= 111 and an unrecognised color function invalidates the WHOLE
// declaration, which on camera means a layer that silently paints nothing.
// Ceiling: if OBS's CEF floor ever passes 111, delete --accent-rgb and use color-mix(in oklab, ...).
const hex = /^#?([0-9a-f]{6})$/i.exec(params.get('accent') ?? '')?.[1]?.toLowerCase() ?? 'ff5a1f';
const [ar, ag, ab] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
root.style.setProperty('--accent', '#' + hex);
root.style.setProperty('--accent-rgb', `${ar}, ${ag}, ${ab}`);

// ?grad=RRGGBB-RRGGBB[-RRGGBB] — an optional brand gradient for the header bar only. When set,
// the header paints the gradient with white ink (dark ink assumes a single bright accent);
// ?accent= keeps colouring the rows and the flame. Any malformed stop drops the whole param.
const grad = (params.get('grad') ?? '')
  .split('-')
  .map((s) => (/^[0-9a-f]{6}$/i.test(s) ? '#' + s.toLowerCase() : null));
if (grad.length >= 2 && grad.length <= 3 && grad.every((c) => c !== null)) {
  root.style.setProperty('--head-bg', `linear-gradient(105deg, ${grad.join(', ')})`);
  root.style.setProperty('--head-ink', '#FFFFFF');
  root.style.setProperty('--head-shadow', '0 1px 0 rgba(38, 18, 58, .35)');
}

// ======================== the fixed DOM (SPEC §7.1) ========================
// The renderer never creates or removes an element. It sets textContent, toggles data-*
// attributes and writes custom properties. Zero DOM churn, zero layout invalidation.

const $ = (id) => document.getElementById(id);
const card = $('card');
const headText = $('head-text');
const list = $('list');
const toCover = $('to-cover');
const toWord = $('to-word');
const toTitle = $('to-title');
const toCount = $('to-count');

const coverUrl = (key) => '/covers/' + encodeURIComponent(key);

function setCover(img, key) {
  // removeAttribute, NEVER src='': an empty src re-requests the CURRENT PAGE, which on this
  // route is the overlay HTML — a guaranteed decode error and a broken-image glyph on camera.
  if (!key) {
    img.removeAttribute('src');
    img.hidden = true;
    return;
  }
  img.hidden = false;
  img.src = coverUrl(key);
}

// ======================== SFX (SPEC §7.4, prompt §6.5) ========================
// Off unless ?sfx=1. No user-gesture unlock is needed — obs-browser launches CEF with
// --autoplay-policy=no-user-gesture-required — but the .catch() is mandatory for a normal
// browser tab (the admin preview iframe) and for a missing file.

const sfx = SFX_ON
  ? { streak: $('sfx-streak'), break: $('sfx-break'), won: $('sfx-won') }
  : null;

function playSfx(name) {
  const a = sfx?.[name];
  if (!a) return;
  a.volume = VOL;
  try { a.currentTime = 0; } catch { /* readyState 0 with preload="none" */ }
  a.play().catch(() => {});
}

// ======================== the animation queue (SPEC §7.4, DESIGN §4) ========================

const DUR = { snapshot: 0, config: 0, session_start: 400, game_start: 900, win: 450, loss: 600,
              streak_in: 700, streak_break: 800, game_won: 1800, game_abandoned: 500,
              session_end: 700, undo: 250 };
const MAX_QUEUE = 8;

// cause -> data-anim value (DESIGN §4.1). '' means instant, no beat.
const BEAT = { snapshot: '', config: '', session_start: 'intro', game_start: 'intro',
               win: 'win', streak_in: 'streak-in', loss: 'loss', streak_break: 'streak-break',
               game_won: 'won', game_abandoned: 'wipe', session_end: 'end', undo: 'undo' };

// The ONLY place a cause becomes a beat. `skip` maps onto the game_abandoned key because DUR
// has no `skip` entry and both are the same 500ms neutral wipe with different copy — which
// also guarantees DUR[key(step)] is never undefined, and `undefined / speed` is NaN, and a NaN
// timeout freezes the queue forever.
function key(step) {
  const c = step.cause;
  if (c === 'win' && step.state.displayMode === 'STREAK_MODE') return 'streak_in';
  if (c === 'skip') return 'game_abandoned';   // same 500ms neutral wipe, different word
  return c;                                    // the 'loss' composite is handled in drain()
}

let queue = [];            // Step[] — never grows past MAX_QUEUE (see drain)
let playing = false;
let rendered = null;       // the RunState currently on screen; the tween's "from" side
let lastSeq = 0;
let sessionStartAt = null; // step.at of the last session_start seen; the ENDED card's duration
let snapshotSeen = false;  // per-connection: did the unprompted snapshot (SPEC §4.4) arrive?
// ponytail: one counter invalidates everything in flight when a snapshot lands. Without it the
// awaiting beat resolves later and writes its stale state into `rendered`, which then feeds the
// wrong "from" value into the NEXT loss animation. Ceiling: a plain integer, one writer.
let gen = 0;

function onStep(step) {
  if (!step || typeof step.state !== 'object' || step.state === null) return;   // never render undefined
  if (step.cause === 'session_start') sessionStartAt = step.at;
  if (step.cause === 'snapshot') {         // authoritative: nothing queued matters any more
    gen++;
    snapshotSeen = true;
    queue.length = 0; lastSeq = step.seq;
    render(step, 0, ''); rendered = step.state; playing = false;
    return;
  }
  if (step.seq <= lastSeq) return;                          // duplicate/out-of-order: drop
  if (step.seq > lastSeq + 1) { requestResync(); }          // gap: ask, but keep rendering
  lastSeq = step.seq;
  queue.push(step);
  if (!playing) drain();
}

async function drain() {
  playing = true;
  while (queue.length) {
    if (queue.length > MAX_QUEUE) {
      // Coalesce: the human is faster than the animation. Jump to the newest truth with no
      // animation rather than fall further behind. NEVER drop the last step.
      const last = queue[queue.length - 1];
      queue.length = 0;
      console.warn('overlay: queue overflow, snapping to newest state');
      render(last, 0, ''); rendered = last.state;
      continue;
    }
    const speed = queue.length <= 2 ? 1 : queue.length <= 4 ? 1.5 : 3;
    const step = queue.shift();
    const k = key(step);
    const g = gen;
    // The one composite in the system, keyed by the RENDERED mode and not by the cause alone:
    // first the hope drains, then the number gets worse (SPEC §7.4, DESIGN §4.7).
    if (k === 'loss' && rendered !== null && rendered.displayMode === 'STREAK_MODE') {
      await render(step, DUR.streak_break / speed, 'streak-break');
      if (g !== gen) return;
    }
    // BEAT[k] ?? '' is the guard for a cause this build has never heard of: without it
    // dataset.anim would be set to the string "undefined", which matches no beat rule and is
    // never cleared — pinning nine will-change layers for the rest of the stream. An unknown
    // cause renders its state instantly and skips the animation, which is the right degrade.
    await render(step, DUR[k] / speed, BEAT[k] ?? '');
    if (g !== gen) return;                    // a snapshot landed mid-beat and is authoritative
    rendered = step.state;
  }
  playing = false;
}

// One beat: write the new truth, flip the mode, set the beat, wait for it to finish, clear.
// Resolves on #card's own animationend OR on a timeout of duration + 120ms, whichever fires
// first. Never await an event with no timeout — OBS drops animationend under Efficiency-Mode
// throttling and a missed one would freeze the queue and the overlay forever.
function render(step, ms, beat) {
  paint(step, beat);

  // Clearing and re-setting data-anim in two microtasks of the same task is invisible to the
  // style engine, so two consecutive identical beats (loss, loss) would animate only once.
  // One forced style flush per beat fixes it; it is a read, not an animated property.
  card.dataset.anim = '';
  void card.offsetWidth;
  if (!beat) return Promise.resolve();
  card.dataset.anim = beat;

  if (beat === 'streak-in') playSfx('streak');
  else if (beat === 'streak-break') playSfx('break');
  else if (beat === 'won') playSfx('won');

  if (!(ms > 0)) return Promise.resolve();

  const g = gen;
  return new Promise((resolve) => {
    let done = false;
    const fin = (ev) => {
      // Only #card's OWN animation ends the beat. animationend bubbles, so accepting a child's
      // event would let digit-out (260ms) cut the 600ms loss beat short.
      if (done || (ev && ev.target !== card)) return;
      done = true;
      clearTimeout(t);
      card.removeEventListener('animationend', fin);
      if (g === gen) card.dataset.anim = '';   // mode rules take over; will-change drops with it
      resolve();
    };
    const t = setTimeout(fin, ms + 120);
    card.addEventListener('animationend', fin);
  });
}

// Step 1 of DESIGN §4.1: text and attributes for the NEW state, then the destination mode.
// textContent and data-* only — no style writes, no measurement, nothing on the §7.6 ban list.
function paint(step, beat) {
  const st = step.state;
  const cur = st.current;

  // phase 'live' with current === null (the instant between session_start and its game_start)
  // resolves to 'loss' on purpose: the panel must fade IN on session_start, and data-mode="idle"
  // would hold it at visibility:hidden while card-in ran.
  const mode = st.phase === 'idle' ? 'idle'
             : st.phase === 'ended' ? 'ended'
             : st.displayMode === 'STREAK_MODE' ? 'streak' : 'loss';

  headText.textContent = str('panelTitle', st.sessionTitle);

  const rows = st.playlist ?? [];

  // Reuse the <li> elements. Rebuilding the list on every loss would relayout every row and
  // restart the flame animation mid-cycle; instead only the rows that changed are written, and
  // the element count only changes when the playlist itself does (a game added/removed live).
  while (list.children.length > rows.length) list.removeChild(list.lastChild);
  while (list.children.length < rows.length) {
    const li = document.createElement('li');
    li.innerHTML = '<span class="rc"><img alt=""></span><span class="rt"></span><span class="rn"></span>';
    list.appendChild(li);
  }

  rows.forEach((g, i) => {
    const li = list.children[i];
    const active = g.status === 'active';
    if (li.dataset.status !== g.status) li.dataset.status = g.status;

    // The flame is scoped to data-streak="hot", which is ONLY set on an active row that is
    // mid-streak (0 < streak < required). Every other row and every other state has no
    // animation attached at all — that is what makes the resting budget genuinely zero.
    const hot = active && g.streak > 0 && g.streak < g.required ? 'hot' : 'cold';
    if (li.dataset.streak !== hot) li.dataset.streak = hot;

    const t = li.querySelector('.rt');
    if (t.textContent !== g.title) t.textContent = g.title;

    // The counter the user specified: streak/required. 0/1 -> 1/1 for single; for b2b
    // 0/2 -> 1/2 (flame) -> 2/2, and a loss at 1/2 returns to 0/2.
    const n = g.streak + '/' + g.required;
    const nEl = li.querySelector('.rn');
    if (nEl.textContent !== n) nEl.textContent = n;

    // Cover art on the active row only (user decision), and data-cover collapses the cell
    // entirely when there is none — otherwise every row shows an empty box, which is the
    // common case when no IGDB credentials are configured.
    const showCover = active && !!g.coverKey;
    if (li.dataset.cover !== (showCover ? 'yes' : 'no')) li.dataset.cover = showCover ? 'yes' : 'no';
    setCover(li.querySelector('.rc img'), showCover ? g.coverKey : null);
  });

  // Keep the active row visible when the list is clipped. Instant, never smooth: a smooth
  // scroll is an animation, and this fires on game_start only.
  const activeLi = list.querySelector('li[data-status="active"]');
  if (activeLi && (step.cause === 'game_start' || step.cause === 'snapshot')) {
    activeLi.scrollIntoView({ block: 'nearest' });
  }

  // Warm the next cover into the HTTP cache. The Image is never appended, so it is not DOM
  // churn, and covers are immutable/max-age=31536000 — the difference between the next
  // takeover showing a picture and showing an empty box.
  if (step.cause === 'game_start' || step.cause === 'snapshot') {
    const at = rows.findIndex((g) => g.status === 'active');
    const nextKey = rows.slice(at + 1).find((g) => g.status === 'pending')?.coverKey
      ?? rows.find((g) => g.status === 'pending')?.coverKey;   // wrap, for a looping session
    if (nextKey) new Image().src = coverUrl(nextKey);
  }

  // ---- the takeover, SPEC §6.2's momentary expansion ----
  if (beat === 'won' && cur !== null) {
    setCover(toCover, cur.coverKey);
    toWord.textContent = str('wonWord');
    toTitle.textContent = cur.title;
    toCount.textContent = cur.streak + '/' + cur.required;
  } else if (beat === 'wipe') {
    setCover(toCover, cur !== null ? cur.coverKey : null);
    toWord.textContent = str(step.cause === 'skip' ? 'skipped' : 'abandoned');
    toTitle.textContent = cur !== null ? cur.title : '';
    toCount.textContent = '';
  } else if (mode === 'ended' || beat === 'end') {
    // The session's own duration is not part of RunState, so it is only known when this client
    // watched the session_start go by. null after a reconnect; strings.js drops the segment.
    const ms = sessionStartAt === null ? null : step.at - sessionStartAt;
    setCover(toCover, null);
    toWord.textContent = str('endedWord');
    toTitle.textContent = str('endedLine', st.sessionTitle, st.totals.gamesWon,
                              st.totals.gamesPlayed, st.totals.losses, ms);
    toCount.textContent = '';
  }

  card.dataset.mode = mode;
}

// ======================== simulation (rehearsal, never state) ========================
// The admin's "Simulieren" buttons. A sim rides the normal animation queue as a locally
// synthesised step built from the state on screen, holds a moment, then a second, instant step
// restores the truth. lastSeq is reused, not advanced, so the real stream is untouched — and if
// a REAL step lands during the hold, `rendered` moves past our fake state and the restore is
// skipped, because the real step already painted newer truth.

const SIM_HOLD_MS = 3000;

function simulate(kind) {
  if (rendered === null || rendered.phase !== 'live') return;   // nothing on camera to rehearse on
  const real = rendered;
  const st = JSON.parse(JSON.stringify(real));   // plain JSON by construction (it crossed the wire)
  const g = (st.playlist ?? []).find((r) => r.status === 'active');
  if (!g) return;

  let cause;
  if (kind === 'win') {
    cause = 'win';
    g.streak = Math.min(g.streak + 1, g.required);
    st.displayMode = g.streak < g.required ? 'STREAK_MODE' : 'LOSS_MODE';
    if (st.current !== null) st.current.streak = g.streak;
  } else if (kind === 'won') {
    cause = 'game_won';
    g.streak = g.required;
    g.status = 'done';
    if (st.current !== null) { st.current.streak = g.required; } else { st.current = g; }
    st.totals.gamesWon += 1;
  } else if (kind === 'loss') {
    cause = 'loss';
    g.streak = 0;
    g.losses += 1;
    st.displayMode = 'LOSS_MODE';
    st.totals.losses += 1;
    if (st.current !== null) st.current.streak = 0;
  } else {
    return;   // a kind this build has never heard of: ignore, exactly like an unknown cause
  }

  queue.push({ seq: lastSeq, cause, at: Date.now(), state: st });
  if (!playing) drain();
  setTimeout(() => {
    if (rendered !== st) return;                 // real state moved on; it is the newer truth
    queue.push({ seq: lastSeq, cause: 'config', at: Date.now(), state: real });
    if (!playing) drain();
  }, SIM_HOLD_MS);
}

// ======================== the WS client (SPEC §4.4–§4.6) ========================

// BYTE-EXACT. The DO registers setWebSocketAutoResponse(new WebSocketRequestResponsePair(
// '{"t":"ping"}', '{"t":"pong"}')), which matches the frame as a literal string — never
// JSON.stringify({t:'ping'}), because one space would wake the DO on every beat for the whole
// stream and bill duration all night.
const PING = '{"t":"ping"}';

const BASE_MS = 500;
const FACTOR = 2;
const MAX_MS = 15000;
const HEARTBEAT_MS = 20000;

// The page is served at /o/<token> (SPEC route 33) and the socket is /o/<token>/ws.
const token = /^\/o\/([^/]+)/.exec(location.pathname)?.[1] ?? '';

let ws = null;
let attempt = 0;
let heartbeat = 0;
let resumeTimer = 0;
let lastResync = 0;

function requestResync() {
  const now = Date.now();
  if (now - lastResync < 500) return;      // one gap, one ask; a burst of steps must not spam
  lastResync = now;
  if (ws !== null && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ t: 'resume', seq: lastSeq }));
  }
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  let retried = false;   // onerror and onclose both fire; only one retry per socket

  const retry = () => {
    if (retried) return;
    retried = true;
    clearInterval(heartbeat);
    clearTimeout(resumeTimer);
    // delay is computed from the CURRENT attempt and only then incremented, so the first retry
    // lands 250–500 ms later: 500, 1000, 2000, 4000, 8000, 15000, 15000…
    const delay = Math.min(MAX_MS, BASE_MS * FACTOR ** attempt);
    attempt++;
    const wait = delay / 2 + Math.random() * (delay / 2);   // full jitter: 50%..100% of delay
    setTimeout(connect, wait);
  };

  ws = new WebSocket(`${proto}//${location.host}/o/${encodeURIComponent(token)}/ws`);

  ws.onopen = () => {
    attempt = 0;
    snapshotSeen = false;
    heartbeat = setInterval(() => {
      if (ws !== null && ws.readyState === WebSocket.OPEN) ws.send(PING);
    }, HEARTBEAT_MS);
    // The server pushes the snapshot unprompted, inside fetch(), before the 101 — so send
    // nothing here. The resume below is belt-and-braces for a server that changed behaviour.
    if (lastSeq > 0) {
      resumeTimer = setTimeout(() => { if (!snapshotSeen) requestResync(); }, 2000);
    }
  };

  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg === null || typeof msg !== 'object') return;
    if (msg.t === 'error') { console.error('overlay: server refused the socket', msg.code); return; }
    if (msg.t === 'sim' && typeof msg.kind === 'string') { simulate(msg.kind); return; }
    if (msg.t !== 'state' || !Array.isArray(msg.steps)) return;   // 'pong' lands here and is a no-op
    for (const step of msg.steps) onStep(step);
  };

  // No cap on attempts. An overlay that gives up is a blank box on camera. A redeploy closes
  // every socket, which is a normal onclose, and the backoff handles it.
  ws.onclose = retry;
  ws.onerror = retry;
}

if (token === '') {
  // /overlay.html is reachable directly (SPEC §5.1) and carries no token, so there is no run
  // to render: stay IDLE rather than reconnect-loop against a 404 for the whole stream.
  console.warn('overlay: no token in the path — open /o/<overlayToken> to render a run');
} else {
  connect();
}
