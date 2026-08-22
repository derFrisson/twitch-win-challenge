// The subathon clock overlay (feature prompt §2.4/§6).
//
// ponytail: plain ES module, no bundler, no framework — same rule as overlay.js. This file
// renders what the DO sends and computes nothing about money or entitlement.
//
// THE ONE THING THIS FILE MUST GET RIGHT: it must not drift. Over 40 hours a counter that
// decrements locally is minutes wrong by morning. Every tick recomputes from a server-anchored
// timestamp, so the worst a missed tick can do is skip a frame.

import * as STRINGS from '/strings.js';
const COPY = STRINGS.timer ?? {};
const str = (k, ...a) => { const v = COPY[k]; return typeof v === 'function' ? v(...a) : (v ?? ''); };

// ======================== query parameters (SPEC §7.5 + ?goal) ========================
const params = new URLSearchParams(location.search);
const num = (k, def, lo, hi) => {
  const s = params.get(k);
  if (s === null || s.trim() === '') return def;
  const n = Number(s);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
};
const flag = (k) => params.get(k) === '1';

const scale = num('scale', 1, 0.5, 2);
const fillA = num('opacity', 0.85, 0.3, 1);
const vol = num('vol', 0.5, 0, 0.8);   // donation-sound volume; ?vol=0 mutes. Cap 0.8, as overlay.js
const accent = (() => {
  const v = (params.get('accent') ?? '').replace(/^#/, '');
  return /^[0-9a-fA-F]{6}$/.test(v) ? `#${v}` : null;
})();
const pos = ['tl', 'tc', 'tr', 'bl', 'bc', 'br'].includes(params.get('pos') ?? '') ? params.get('pos') : 'bl';

const clock = document.getElementById('clock');
const elHms = document.getElementById('hms');
const elEnd = document.getElementById('endline');
const elTag = document.getElementById('statetag');
const elDelta = document.getElementById('delta');
const elToast = document.getElementById('toast');
const elGoal = document.getElementById('goal');
const elDon = document.getElementById('sfx-don');   // src set in the transport section (needs the token)

clock.style.setProperty('--scale', String(scale));
clock.style.setProperty('--fill-a', String(fillA));
if (accent !== null) document.documentElement.style.setProperty('--accent', accent);
clock.dataset.pos = pos;
if (flag('goal')) elGoal.hidden = false;

// ======================== formatting ========================
// Deliberately duplicated from src/timer.ts rather than shared: public/ has no build step (SPEC
// §1), so a browser file cannot import from src/. Five lines is the cheaper of the two evils —
// the DST-sensitive end-time string is formatted ONCE on the server and arrives ready to print.
function formatHMS(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// ======================== state ========================
let timer = null;      // last TimerState from the server
let pool = null;
let skew = 0;          // serverNow - clientNow, re-derived from every frame (§2.4)
let lastEarned = null; // to detect a jump and fire the §6.2 payoff
let tickTimer = 0;
let lastText = '';

const now = () => Date.now() + skew;

// ======================== the tick ========================
// A self-correcting setTimeout aligned to the next whole second, NOT setInterval and NOT
// requestAnimationFrame. The anchor is what prevents drift; rAF would be 60x the wakeups for a
// display that changes once a second, in the widget with the tightest CPU budget in the project.
function scheduleTick() {
  clearTimeout(tickTimer);
  if (document.hidden) return;                 // SPEC §7.6: no timer while the tab is hidden
  if (timer === null || timer.phase !== 'running') return;   // a frozen clock needs no ticking
  const delay = 1000 - (now() % 1000);
  tickTimer = setTimeout(() => { paint(); scheduleTick(); }, delay);
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) clearTimeout(tickTimer);
  else { paint(); scheduleTick(); }
});

// ======================== render ========================
function remainingMs() {
  if (timer === null) return 0;
  // Running: derived from the server's ends_at against a skew-corrected clock. Paused/ended:
  // the server's own frozen number, because there is nothing to count down toward.
  if (timer.phase === 'running' && timer.endsAt !== null) return timer.endsAt - now();
  return timer.remainingMs;
}

function paint() {
  if (timer === null) return;
  const text = formatHMS(remainingMs());
  // Only touch the DOM when the visible digits actually changed (§6.5).
  if (text !== lastText) { elHms.textContent = text; lastText = text; }
}

function applyState() {
  const mode =
    timer.phase === 'idle' ? 'idle'
    : timer.phase === 'ended' ? 'ended'
    : timer.phase === 'paused' ? 'paused'
    : timer.capped ? 'capped' : 'running';
  clock.dataset.mode = mode;

  // §6.1: while paused this must read as frozen. Never a live wall-clock time — it would be
  // wrong, and it would be wrong on camera for hours.
  elEnd.textContent =
    timer.phase === 'running' && timer.endsAtLabel !== null ? str('endAt', timer.endsAtLabel, timer.endsAt) : str('endUnknown');

  elTag.textContent =
    mode === 'paused' ? str(timer.manualPaused ? 'paused' : 'pausedAuto')
    : mode === 'capped' ? str('capped')
    : mode === 'ended' ? str('ended')
    : mode === 'idle' ? str('idle')
    : '';

  if (!elGoal.hidden && pool !== null && pool.goalCents !== null && pool.goalCents > 0) {
    const frac = Math.min(1, pool.totalCents / pool.goalCents);
    document.getElementById('goal-fill').style.transform = `scaleX(${frac})`;
    document.getElementById('goal-text').textContent = str('goal', pool.totalCents, pool.goalCents);
  }

  paint();
  scheduleTick();
}

// §6.2 the payoff: the clock visibly jumps when hours are bought.
function flashDelta(addedMs) {
  if (addedMs <= 0) return;
  elDelta.textContent = `+${formatHMS(addedMs)}`;
  // will-change added here and removed on completion — a permanent one pins a compositor layer
  // for the whole stream to animate something that happens a handful of times.
  elDelta.style.willChange = 'transform, opacity';
  elHms.style.willChange = 'transform';
  elDelta.removeAttribute('data-run'); void elDelta.offsetWidth; elDelta.dataset.run = '1';
  elHms.removeAttribute('data-bump'); void elHms.offsetWidth; elHms.dataset.bump = '1';
}
elDelta.addEventListener('animationend', () => {
  elDelta.removeAttribute('data-run');
  elDelta.style.willChange = '';
});
elHms.addEventListener('animationend', () => {
  elHms.removeAttribute('data-bump');
  elHms.style.willChange = '';
});

// §6.3 alerts QUEUE, never stomp — same discipline as the win-challenge transitions.
const toastQ = [];
let toasting = false;
function enqueue(alerts) {
  for (const a of alerts) toastQ.push(a);
  drain();
}
function drain() {
  if (toasting || toastQ.length === 0) return;
  const a = toastQ.shift();
  toasting = true;
  document.getElementById('toast-who').textContent = a.name ?? str('anon');
  document.getElementById('toast-amt').textContent = str('amount', a.amountCents);
  document.getElementById('toast-time').textContent = `+${formatHMS(a.addedMs)}`;
  elToast.removeAttribute('data-run'); void elToast.offsetWidth; elToast.dataset.run = '1';
  playDonSound();
}

// One sound per toast, aligned with it. No upload -> the src 404s -> play() rejects -> silence.
// No user-gesture unlock needed: obs-browser runs with --autoplay-policy=no-user-gesture-required;
// the .catch() covers a normal browser tab.
function playDonSound() {
  if (vol === 0 || !elDon.src) return;
  elDon.volume = vol;
  try { elDon.currentTime = 0; } catch { /* readyState 0 before metadata */ }
  elDon.play().catch(() => {});
}

// The §6.2/§6.3 rehearsal: toast + sound + the clock visibly jumping, then back to the truth.
// Nothing here touches server state — `timer` is patched in place and restored unless a real
// step replaced it in the meantime (a new step builds a new object, so identity is the guard).
function simDonation(a) {
  enqueue([a]);
  flashDelta(a.addedMs);
  if (timer !== null && timer.phase === 'running' && timer.endsAt !== null) {
    const ref = timer;
    const realEndsAt = timer.endsAt;
    timer.endsAt += a.addedMs;
    paint();
    setTimeout(() => {
      if (timer === ref) { timer.endsAt = realEndsAt; paint(); }
    }, 5000);
  }
}
elToast.addEventListener('animationend', () => {
  elToast.removeAttribute('data-run');
  toasting = false;
  drain();
});

// ======================== transport ========================
const token = decodeURIComponent(location.pathname.split('/')[2] ?? '');
if (token !== '') elDon.src = `/o/${encodeURIComponent(token)}/timer/sound`;
const BASE_MS = 500, FACTOR = 2, MAX_MS = 15000, HEARTBEAT_MS = 20000;
const PING = JSON.stringify({ t: 'ping' });
let ws = null, attempt = 0, heartbeat = 0, lastSeq = 0;

function connect() {
  if (token === '') { clock.dataset.conn = 'down'; return; }
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  let retried = false;

  const retry = () => {
    if (retried) return;
    retried = true;
    clearInterval(heartbeat);
    clock.dataset.conn = 'down';
    const delay = Math.min(MAX_MS, BASE_MS * FACTOR ** attempt);
    attempt++;
    setTimeout(connect, delay / 2 + Math.random() * (delay / 2));   // full jitter
  };

  ws = new WebSocket(`${proto}//${location.host}/o/${encodeURIComponent(token)}/timer/ws`);

  ws.onopen = () => {
    attempt = 0;
    clock.dataset.conn = 'up';
    heartbeat = setInterval(() => {
      if (ws !== null && ws.readyState === WebSocket.OPEN) ws.send(PING);
    }, HEARTBEAT_MS);
  };

  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg === null || typeof msg !== 'object') return;
    if (msg.t === 'error') { console.error('timer: server refused the socket', msg.code); return; }
    if (msg.t === 'sim' && msg.alert && typeof msg.alert.addedMs === 'number') {
      simDonation(msg.alert);
      return;
    }
    if (msg.t !== 'timer' || !Array.isArray(msg.steps)) return;

    for (const step of msg.steps) {
      if (typeof step.at === 'number') {
        // Re-anchor on EVERY frame. One bad sample cannot accumulate, because nothing is
        // integrated — the next frame simply replaces it.
        const sample = step.at - Date.now();
        skew = Math.abs(sample) > 60_000 ? 0 : sample;   // a minute of clock error is a broken
                                                         // client clock, not a real offset
      }
      lastSeq = step.seq;
      const prevEarned = lastEarned;
      timer = step.timer;
      pool = step.pool;
      lastEarned = step.timer.earnedMs;
      applyState();
      if (prevEarned !== null && step.timer.earnedMs > prevEarned) flashDelta(step.timer.earnedMs - prevEarned);
      if (Array.isArray(step.alerts) && step.alerts.length > 0) enqueue(step.alerts);
    }
  };

  ws.onclose = retry;
  ws.onerror = retry;
}

connect();
