// The admin panel (SPEC §8, DESIGN §6). Desktop, operated while playing a game.
//
// ponytail: plain ES module, no bundler, no framework, no client-side router. One page, seven
// sections, one `app` object refreshed from GET /api/admin/state and from the admin WebSocket.
// Every mutation is a fetch() that returns the new truth; the only optimistic update on the page
// is a button's own pressed styling. Ceiling: if this file ever needs a diffing renderer, the
// panel has grown past what it is for.

// All German copy lives in /strings.js (SPEC §1.1). `ADMIN` is this page's namespace; the
// fallbacks keep a strings.js refactor from blanking the panel instead of just mislabelling it.
import * as STRINGS from '../strings.js';
// DESIGN 8.6: the History accordion renders the identical recap components the /o/<token>/recap
// page uses — same markup, same injected CSS — never a second implementation.
import { renderHero, renderKpiRow, renderPerGameTable } from '../recap.js';
const T = STRINGS.ADMIN ?? STRINGS.default?.ADMIN ?? STRINGS.default ?? STRINGS;
const t = (k) => T[k] ?? k;
const fill = (k, vars) => t(k).replace(/\{(\w+)\}/g, (_, n) => String(vars[n] ?? ''));
const errCode = (code) => (T.errors && T.errors[code]) || `${t('errorGeneric')} (${code})`;
const errText = (r) => errCode(r.code);

const API_TIMEOUT_MS = 8000;  // a stalled fetch has no browser default; 8s is well past a
                              // slow 4G round trip and well short of the streamer giving up.
const HOLD_MS = 350;          // mirrors --hold-ms (DESIGN 6.3)
const HEARTBEAT_MS = 20000;   // SPEC 4.6
const PING = '{"t":"ping"}';  // byte-exact, never JSON.stringify: the DO's auto-responder
                              // matches the string and one space would wake it every 20s.

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const app = {
  state: null,          // RunState from the DO
  games: [],            // route 5
  sessions: [],         // route 11 (each with gameCount)
  sessionGames: [],     // route 13, for the session being edited
  editId: null,         // which session the builder is editing
  urls: null,           // route 31 .urls
  addOpen: false,       // the IGDB search sheet
};

// ---------------------------------------------------------------------------------------------
// tiny helpers
// ---------------------------------------------------------------------------------------------

async function api(path, opts = {}) {
  try {
    // The signal goes AFTER the spread on purpose: no caller passes one, and a request that
    // hangs forever is what latches the control bar dead (see control()).
    const res = await fetch(path, { cache: 'no-store', ...opts, signal: AbortSignal.timeout(API_TIMEOUT_MS) });
    const ct = res.headers.get('content-type') ?? '';
    let parseFailed = false;
    const read = ct.includes('json') ? res.json() : res.text();
    const data = await read.catch(() => {
      parseFailed = true;
      return null;
    });
    if (!res.ok) return { ok: false, status: res.status, code: (data && data.error) || `http_${res.status}`, definitive: true };
    // A 2xx whose body we could not read is NOT a success: every caller goes straight to
    // r.data.state, so reporting ok here turns a broken response into a silent no-op button.
    if (parseFailed) return { ok: false, status: res.status, code: 'bad_body', definitive: true };
    return { ok: true, status: res.status, data, definitive: true };
  } catch (e) {
    // A dead button mid-stream is the worst outcome: every caller renders this.
    // definitive:false — we do NOT know whether the server processed it, so the caller must
    // keep its action_id for an idempotent retry (SPEC 4.10).
    const timedOut = e && e.name === 'TimeoutError';
    return { ok: false, status: 0, code: timedOut ? 'timeout' : 'network', definitive: false };
  }
}
const send = (method, path, body) =>
  api(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });

function msg(el, text, kind) {
  el.textContent = text ?? '';
  if (kind) el.dataset.kind = kind;
  else delete el.dataset.kind;
}

let sayTimer = 0;
/** The readout's row-3 slot: 409 reasons and failed fetches, 2.5s, no modal, no toast stack. */
function say(text) {
  const el = $('rd-msg');
  el.textContent = text;
  $('live-readout').dataset.msg = '1';
  clearTimeout(sayTimer);
  sayTimer = setTimeout(() => {
    el.textContent = '';
    delete $('live-readout').dataset.msg;
  }, 2500);
}

function flash(btn) {
  if (!btn) return;
  btn.dataset.flash = '1';
  setTimeout(() => delete btn.dataset.flash, 400);
}

const debounce = (ms, fn) => {
  let h = 0;
  return (...a) => {
    clearTimeout(h);
    h = setTimeout(() => fn(...a), ms);
  };
};

/** Two taps, one target, no dialog — the confirm step for every hard-to-reverse action. */
const armTimers = new WeakMap();
function twoTap(btn, label, go) {
  // Never colour alone: a text button swaps its label, an icon button swaps its accessible name.
  const name = btn.getAttribute('aria-label') ?? btn.title;
  const reset = () => {
    delete btn.dataset.armed;
    if (label === null) setName(btn, name);
    else btn.textContent = label;
  };
  return () => {
    if (btn.dataset.armed) {
      clearTimeout(armTimers.get(btn));
      reset();
      go();
      return;
    }
    btn.dataset.armed = '1';
    if (label === null) setName(btn, t('confirmAgain'));
    else btn.textContent = t('confirmAgain');
    armTimers.set(btn, setTimeout(reset, 4000));
  };
}
function setName(btn, text) {
  btn.setAttribute('aria-label', text);
  btn.title = text;
}

const fmtDur = (ms) => {
  // Number(null) is 0, and "0:00" for a missing duration is a lie that reads as data.
  if (ms === null || ms === undefined || ms === '') return '—';
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return '—';
  const s = Math.round(n / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}:${String(m).padStart(2, '0')} h` : `${m}:${String(s % 60).padStart(2, '0')}`;
};
const fmtDate = STRINGS.fmtDate; // locale follows the strings.js language pick
const coverSrc = (key) => (key ? `/covers/${encodeURIComponent(key)}` : '');
const modeLabel = (mode) => (mode === 'b2b' ? t('modeB2b') : t('modeSingle'));

// DESIGN 8.5: authored inline SVG, one 2.5px stroke, 24x24 grid, currentColor. No icon font, no
// emoji, no Unicode glyph standing in for an icon. up/down/remove are the same language as the
// six in the inventory — the touch-reliable reorder path (not in DESIGN 8.5) needs them.
const svg = (body, cls = 'icons') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
const ICON = {
  grip: svg(
    [[9, 6], [15, 6], [9, 12], [15, 12], [9, 18], [15, 18]]
      .map(([x, y]) => `<circle cx="${x}" cy="${y}" r="1.4"/>`)
      .join(''),
    'icons icons-dot',
  ),
  copy: svg('<path d="M9 9h10v10H9z"/><path d="M5 15V5h10"/>'),
  check: svg('<path d="M5 13l4 4 10-10"/>'),
  arrowRight: svg('<path d="M4 12h14"/><path d="M13 7l5 5-5 5"/>'),
  slash: svg('<circle cx="12" cy="12" r="8"/><path d="M7 17L17 7"/>'),
  dash: svg('<path d="M6 12h12"/>'),
  chevron: svg('<path d="M6 9l6 6 6-6"/>'),
  chevronUp: svg('<path d="M6 15l6-6 6 6"/>'),
  x: svg('<path d="M6 6l12 12"/><path d="M18 6L6 18"/>'),
};

// ---------------------------------------------------------------------------------------------
// static copy
// ---------------------------------------------------------------------------------------------

function applyStrings(root = document) {
  for (const el of root.querySelectorAll('[data-s]')) el.textContent = t(el.dataset.s);
  for (const el of root.querySelectorAll('[data-sp]')) el.placeholder = t(el.dataset.sp);
  for (const el of root.querySelectorAll('[data-sl]')) el.setAttribute('aria-label', t(el.dataset.sl));
  for (const el of root.querySelectorAll('[data-st]')) el.title = t(el.dataset.st);
  $('btn-undo').textContent = t('undo');
  $('btn-undo').setAttribute('aria-label', t('undoHold'));
  $('preview').title = t('previewTitle');
}

// ---------------------------------------------------------------------------------------------
// 8.1 — the live control bar
// ---------------------------------------------------------------------------------------------

// SPEC 4.10: one uuid per button PRESS, reused verbatim on every retry of that press, so a
// response lost on a 4G hop cannot turn one WIN into two. The id is cleared only on success —
// pressing the same button again after a failure is a retry, not a second press.
const pending = new Map();
function actionId(name) {
  let id = pending.get(name);
  if (id === undefined) {
    id = crypto.randomUUID();
    pending.set(name, id);
  }
  return id;
}

let busy = false;
async function control(name, btn, extra) {
  if (busy) return false;
  busy = true;
  document.body.dataset.busy = '1';
  let r;
  try {
    r = await send('POST', `/api/admin/control/${name}`, { action_id: actionId(name), ...extra });
  } finally {
    // finally, not a trailing assignment: anything that throws in here would otherwise leave
    // busy latched and every WIN/LOSS/SKIP silently ignored for the rest of the stream.
    busy = false;
    delete document.body.dataset.busy;
  }
  if (r.ok) {
    pending.delete(name);
    // The WS broadcasts the same state, so a missing body self-heals on the next step rather
    // than throwing here and killing the handler.
    if (r.data && r.data.state) applyState(r.data.state);
    return true;
  }
  // The server ANSWERED, so this press's outcome is settled either way and the id is spent.
  // Keeping it would let a later, genuinely-new press reuse it and be deduped away as a
  // "retry" — a loss the streamer took that never reaches the counter. Only an inconclusive
  // failure (timeout / network, definitive:false) keeps the id for an idempotent retry.
  if (r.definitive) pending.delete(name);
  flash(btn);
  say(errText(r));
  return false;
}

function wireControls() {
  const guard = (name, btn, extra) => () => {
    if (app.state?.phase !== 'live') return say(errCode('no_live_session'));
    control(name, btn, extra);
  };
  $('btn-win').addEventListener('click', guard('win', $('btn-win')));
  $('btn-loss').addEventListener('click', guard('loss', $('btn-loss')));
  $('btn-skip').addEventListener('click', guard('skip', $('btn-skip')));

  // DESIGN 6.3: press-and-hold, 350ms. Not a confirm dialog — a dialog is a second target and a
  // second chance to mis-click. A hold has a built-in escape: release before it fires.
  const undo = $('btn-undo');
  let holdTimer = 0;
  const stop = () => {
    clearTimeout(holdTimer);
    delete undo.dataset.holding;
  };
  const start = () => {
    if (undo.dataset.holding) return;
    undo.dataset.holding = '1';
    holdTimer = setTimeout(() => {
      stop();
      navigator.vibrate?.(18);
      undo.dataset.fired = '1';
      setTimeout(() => delete undo.dataset.fired, 120);
      if (app.state?.phase === 'idle') return say(errCode('no_live_session'));
      control('undo', undo);
    }, HOLD_MS);
  };
  undo.addEventListener('pointerdown', (e) => {
    e.preventDefault();   // also suppresses the synthetic click, so a tap can never fire undo
    start();
  });
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) undo.addEventListener(ev, stop);
  undo.addEventListener('keydown', (e) => {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      start();
    }
  });
  undo.addEventListener('keyup', stop);
  undo.addEventListener('blur', stop);

  // Not live: the four controls do not exist and this one full-width button takes their place.
  $('btn-session').addEventListener('click', () => {
    if (liveSession() !== null) return resume($('resume-msg'));
    const s = editSession();
    if (s === null || s.status !== 'draft') {
      // First-run guidance beats a generic "pick a session" on a fresh deploy.
      const firstRun = app.sessions.length === 0;
      if (firstRun) $('sec-library').open = true;
      $('sec-builder').open = true;
      $('sec-builder').scrollIntoView({ block: 'start' });
      return say(firstRun ? t('firstRunNoSessions') : t('pickSession'));
    }
    if (app.sessionGames.length === 0) {
      $('sec-builder').open = true;
      $('sec-builder').scrollIntoView({ block: 'start' });
      return say(t('firstRunNoGames'));
    }
    startSession();
  });
}

function renderReadout() {
  const st = app.state;
  const live = st?.phase === 'live';
  const cur = st?.current ?? null;
  const conn = document.body.dataset.conn === 'down';

  $('live-pill-text').textContent = conn
    ? t('connecting')
    : live
      ? t('live')
      : st?.phase === 'ended'
        ? t('ended')
        : t('noSession');

  const cover = $('rd-cover');
  if (cur?.coverKey) {
    cover.src = coverSrc(cur.coverKey);
    cover.hidden = false;
  } else {
    cover.removeAttribute('src');
    cover.hidden = true;
  }

  const parts = [];
  if (live && cur) {
    parts.push(fill('metaGame', { n: cur.positionInLap, m: cur.lapSize }));
    parts.push(fill('metaLap', { n: st.lap }));
    parts.push(modeLabel(cur.mode));
  } else if (st?.sessionTitle) {
    parts.push(fill('metaTotals', { won: st.totals.gamesWon, played: st.totals.gamesPlayed }));
  }
  $('rd-meta').textContent = parts.join(' · ');
  $('rd-title').textContent = (live ? cur?.title : st?.sessionTitle) ?? '';

  $('ctr-losses').textContent = live && cur ? String(cur.losses) : '—';
  $('ctr-streak').textContent = live && cur ? `${cur.streak}/${cur.required}` : '—';
  $('ctr-attempts').textContent = live && cur ? String(cur.attempts) : '—';

  $('btn-session').textContent = liveSession() !== null ? t('resumeSession') : t('startSession');
}

function setConn(up) {
  document.body.dataset.conn = up ? 'up' : 'down';
  renderReadout();
}

// ---------------------------------------------------------------------------------------------
// 8.4 — loop control
// ---------------------------------------------------------------------------------------------

function renderLoop() {
  const armed = app.state?.stopAfterCurrent === true;
  const sw = $('sw-stop-after');
  sw.checked = armed;
  $('latch-sub').textContent = armed ? t('armedSub') : t('stopAfterHint');
  $('loop-chip').hidden = !armed;
  $('sec-loop').toggleAttribute('data-armed', armed);
  document.querySelector('.latch-arm').toggleAttribute('data-armed', armed);
}

function wireLoop() {
  // Idempotent SET, never a toggle (SPEC 2.5h). UNDO does not clear it, which is why the switch
  // keeps its own always-visible off position.
  $('sw-stop-after').addEventListener('change', async (e) => {
    const on = e.target.checked;
    const ok = await control('stop-after-current', null, { on });
    if (!ok) renderLoop();   // put the switch back where the server says it is
    else msg($('loop-msg'), on ? t('armedSub') : t('unarmed'), 'ok');
  });

  const stopNow = $('btn-stop-now');
  stopNow.addEventListener(
    'click',
    twoTap(stopNow, t('stopNow'), async () => {
      if (app.state?.phase !== 'live') return msg($('loop-msg'), errCode('no_live_session'), 'err');
      const ok = await control('stop-now', stopNow);
      if (ok) {
        msg($('loop-msg'), t('sessionEnded'), 'ok');
        loadSessions();
      } else msg($('loop-msg'), t('errorGeneric'), 'err');
    }),
  );
}

// ---------------------------------------------------------------------------------------------
// 8.7 — resume
// ---------------------------------------------------------------------------------------------

const liveSession = () => app.sessions.find((s) => s.status === 'live') ?? null;
const editSession = () => app.sessions.find((s) => s.id === app.editId) ?? null;

function renderResume() {
  const s = liveSession();
  const banner = $('resume');
  banner.hidden = s === null;
  if (s === null) return;
  const cur = app.state?.current ?? null;
  $('resume-text').textContent = fill('resumeFound', {
    title: s.title,
    n: cur?.positionInLap ?? '?',
    m: cur?.lapSize ?? s.gameCount ?? '?',
    lap: app.state?.lap ?? 1,
  });
}

async function resume(msgEl) {
  msg(msgEl, t('working'));
  const r = await send('POST', '/api/admin/control/rehydrate');
  if (!r.ok) return msg(msgEl, errText(r), 'err');
  applyState(r.data.state);
  await loadSessions();
  msg(msgEl, t('resumed'), 'ok');
}

// ---------------------------------------------------------------------------------------------
// 8.2 — game library
// ---------------------------------------------------------------------------------------------

function renderLibrary() {
  const add = `<button class="tile tile-add" id="btn-add-toggle" type="button"
      aria-expanded="${app.addOpen}" aria-controls="add-panel" aria-label="${esc(t('addLibraryGame'))}"
      title="${esc(t('tipAddToggle'))}">+</button>`;
  const tiles = app.games
    .map(
      (g) => `<div class="tile" data-id="${g.id}">
      ${g.cover_key
        ? `<img class="tile-img" src="${esc(coverSrc(g.cover_key))}" alt="" loading="lazy" />`
        : '<span class="tile-img"></span>'}
      <span class="tile-name">${esc(g.name)}</span>
      <button class="tile-chip" type="button" data-act="mode"
        title="${esc(t('tipLibMode'))}">${esc(modeLabel(g.default_mode))}</button>
      <button class="tile-del" type="button" data-act="del"
        title="${esc(t('tipLibDel'))}" aria-label="${esc(t('deleteGame'))}">×</button>
    </div>`,
    )
    .join('');
  $('lib-grid').innerHTML = add + tiles
    + (app.games.length === 0 ? `<p class="note lib-note">${esc(t('libFirstRun'))}</p>` : '');
  $('add-panel').hidden = !app.addOpen;
}

function wireLibrary() {
  $('lib-grid').addEventListener('click', async (e) => {
    const toggle = e.target.closest('#btn-add-toggle');
    if (toggle) {
      app.addOpen = !app.addOpen;
      renderLibrary();
      if (app.addOpen) $('igdb-q').focus();
      return;
    }
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const id = Number(btn.closest('.tile').dataset.id);
    const game = app.games.find((g) => g.id === id);
    if (!game) return;

    if (btn.dataset.act === 'mode') {
      const next = game.default_mode === 'single' ? 'b2b' : 'single';
      const r = await send('PATCH', `/api/admin/games/${id}`, { default_mode: next });
      if (!r.ok) return msg($('manual-msg'), errText(r), 'err');
      game.default_mode = r.data.default_mode;
      btn.textContent = modeLabel(game.default_mode);
      return;
    }
    if (btn.dataset.act === 'del') {
      // A cover-art tile with one destructive corner: two taps, and the armed state is visible.
      twoTap(btn, null, async () => {
        const r = await api(`/api/admin/games/${id}`, { method: 'DELETE' });
        if (!r.ok) return msg($('manual-msg'), errText(r), 'err');
        msg($('manual-msg'), '');
        await loadGames();
      })();
    }
  });

  // IGDB is a convenience, never a hard dependency: a failure here shows inline and the manual
  // form below is already on screen and already usable (BUILD_PROMPT §8).
  $('igdb-q').addEventListener('input', debounce(350, igdbSearch));
  $('igdb-results').addEventListener('click', igdbPick);
  $('manual-form').addEventListener('submit', manualCreate);
}

async function igdbSearch() {
  const q = $('igdb-q').value.trim().slice(0, 80);
  const out = $('igdb-results');
  if (q.length < 1) {
    out.innerHTML = '';
    return msg($('igdb-msg'), '');
  }
  msg($('igdb-msg'), t('searching'));
  const r = await api(`/api/admin/igdb?q=${encodeURIComponent(q)}`);
  if (!r.ok) {
    out.innerHTML = '';
    return msg($('igdb-msg'), `${errText(r)} ${t('igdbFallback')}`, 'err');
  }
  const games = r.data?.games ?? [];
  msg($('igdb-msg'), games.length === 0 ? t('igdbNoResults') : '');
  // Hotlinking images.igdb.com is fine HERE — the admin panel is not on camera. The overlay
  // never does it: route 6 ingests the cover into R2 first (BUILD_PROMPT §8).
  out.innerHTML = games
    .map(
      (g) => `<button class="tile" type="button" data-igdb="${g.igdb_id}"
        data-image="${esc(g.cover_image_id ?? '')}" data-name="${esc(g.name)}" title="${esc(t('tipIgdbTile'))}">
      ${g.cover_image_id
        ? `<img class="tile-img" src="https://images.igdb.com/igdb/image/upload/t_cover_small/${esc(g.cover_image_id)}.jpg" alt="" loading="lazy" />`
        : '<span class="tile-img"></span>'}
      <span class="tile-name">${esc(g.name)}</span>
      <span class="tile-sub">${esc([g.releaseYear ?? '', g.platforms.slice(0, 2).join(' ')].filter(Boolean).join(' · '))}</span>
    </button>`,
    )
    .join('');
}

async function igdbPick(e) {
  const tile = e.target.closest('button[data-igdb]');
  if (!tile) return;
  msg($('igdb-msg'), t('working'));
  const body = {
    name: tile.dataset.name.slice(0, 80),
    default_mode: $('new-mode').value,
    igdb_id: Number(tile.dataset.igdb),
  };
  if (tile.dataset.image) body.igdb_cover_image_id = tile.dataset.image;
  const r = await send('POST', '/api/admin/games', body);
  await loadGames();
  // 502 cover_fetch_failed: the game IS created, without a cover (SPEC 5.2 #6).
  msg($('igdb-msg'), r.ok ? t('gameAdded') : errText(r), r.ok ? 'ok' : 'err');
}

async function manualCreate(e) {
  e.preventDefault();
  const name = $('man-name').value.trim().slice(0, 80);
  if (name.length < 1) return msg($('manual-msg'), t('nameRequired'), 'err');
  const file = $('man-cover').files?.[0] ?? null;
  if (file && file.size > 2 * 1024 * 1024) return msg($('manual-msg'), t('coverTooLarge'), 'err');

  msg($('manual-msg'), t('working'));
  const r = await send('POST', '/api/admin/games', { name, default_mode: $('new-mode').value });
  if (!r.ok) return msg($('manual-msg'), errText(r), 'err');

  if (file) {
    const up = await api(`/api/admin/games/${r.data.id}/cover`, {
      method: 'POST',
      headers: { 'Content-Type': file.type },
      body: file,
    });
    if (!up.ok) {
      await loadGames();
      return msg($('manual-msg'), `${t('gameAddedNoCover')} ${errText(up)}`, 'err');
    }
  }
  $('manual-form').reset();
  await loadGames();
  msg($('manual-msg'), t('gameAdded'), 'ok');
}

// ---------------------------------------------------------------------------------------------
// 8.3 — session builder
// ---------------------------------------------------------------------------------------------

/** SPEC 2.5f case 3: the running game must never end up last. Route 17 rejects it with 400; this
 *  is what keeps the streamer from discovering that mid-stream. */
function putsCurrentLast(order) {
  const st = app.state;
  return (
    st?.phase === 'live' &&
    st.current !== null &&
    st.sessionId === app.editId &&
    order.length > 1 &&
    order[order.length - 1] === st.current.sessionGameId
  );
}

function renderBuilder() {
  const sel = $('sess-pick');
  sel.innerHTML = app.sessions
    .map((s) => `<option value="${s.id}">${esc(s.title)} · ${esc(statusWord(s.status))} · ${s.gameCount}</option>`)
    .join('');
  if (app.editId !== null) sel.value = String(app.editId);

  const s = editSession();
  const chip = $('builder-chip');
  chip.textContent = s === null ? '' : statusWord(s.status);
  chip.classList.toggle('chip-live', s?.status === 'live');

  $('sw-loop').checked = s?.loop === true;
  $('btn-start').disabled = s === null || s.status !== 'draft' || app.sessionGames.length < 1;
  $('btn-end').hidden = app.state?.phase !== 'live';
  // Delete works on drafts AND ended history; a live session has to be ended first (409).
  $('btn-del-session').disabled = s === null || s.status === 'live';

  const st = app.state;
  const curId = st?.phase === 'live' && st.sessionId === app.editId ? st.current?.sessionGameId : undefined;
  $('sg-note').hidden = curId === undefined;
  // Fresh deploy: no sessions at all -> the three-step golden path; a selected session with no
  // games -> the existing noGamesYet note; an empty library -> point at it instead of a dead
  // disabled button.
  const empty = $('sg-empty');
  if (app.sessions.length === 0) {
    empty.textContent = t('builderFirstRun');
    empty.hidden = false;
  } else if (app.games.length === 0 && s !== null && app.sessionGames.length === 0) {
    empty.textContent = t('libEmptyHint');
    empty.hidden = false;
  } else {
    empty.textContent = t('noGamesYet');
    empty.hidden = s === null || app.sessionGames.length > 0;
  }

  $('sg-list').innerHTML = app.sessionGames
    .map((g, i, arr) => {
      const isCur = g.id === curId;
      const ids = arr.map((x) => x.id);
      const upOrder = move(ids, i, i - 1);
      const downOrder = move(ids, i, i + 1);
      return `<li class="sg-row" data-id="${g.id}"${isCur ? ' data-current' : ''} draggable="${!isCur}">
        <button class="grip" type="button" title="${esc(t('dragHandle'))}" aria-label="${esc(t('dragHandle'))}"
          ${isCur ? 'disabled' : ''}>${ICON.grip}</button>
        ${g.cover_key
          ? `<img class="sg-cover" src="${esc(coverSrc(g.cover_key))}" alt="" loading="lazy" />`
          : '<span class="sg-cover"></span>'}
        <span class="sg-title">${esc(g.title)}</span>
        ${isCur ? `<span class="sg-flag">${esc(t('running'))}</span>` : ''}
        <span class="sg-actions">
          <button class="mode-chip" type="button" data-act="mode" title="${esc(t('tipModeChip'))}">${esc(modeLabel(g.mode))}</button>
          <button class="icon-btn" type="button" data-act="up" aria-label="${esc(t('moveUp'))}"
            title="${esc(t('moveUp'))}" ${i === 0 || putsCurrentLast(upOrder) ? 'disabled' : ''}>${ICON.chevronUp}</button>
          <button class="icon-btn" type="button" data-act="down" aria-label="${esc(t('moveDown'))}"
            title="${esc(t('moveDown'))}" ${i === arr.length - 1 || putsCurrentLast(downOrder) ? 'disabled' : ''}>${ICON.chevron}</button>
          <button class="icon-btn" type="button" data-act="del" aria-label="${esc(t('removeEntry'))}"
            title="${esc(t('tipRemoveEntry'))}">${ICON.x}</button>
        </span>
        <span class="sg-msg"></span>
      </li>`;
    })
    .join('');

  // renderBuilder() runs on every WS step, so the operator's pick has to survive the rewrite.
  const addPick = $('sg-add-pick');
  const keep = addPick.value;
  addPick.innerHTML = app.games
    .map((g) => `<option value="${g.id}">${esc(g.name)} · ${esc(modeLabel(g.default_mode))}</option>`)
    .join('');
  if (keep !== '') addPick.value = keep;
  $('sg-add').disabled = app.games.length === 0 || app.editId === null;
}

const statusWord = (s) => (s === 'live' ? t('live') : s === 'ended' ? t('ended') : t('draft'));

function move(ids, from, to) {
  const out = ids.slice();
  if (to < 0 || to >= out.length) return out;
  out.splice(to, 0, out.splice(from, 1)[0]);
  return out;
}

async function submitOrder(order, msgEl) {
  if (putsCurrentLast(order)) return msg(msgEl, errCode('current_game_last'), 'err');
  const r = await send('PUT', `/api/admin/sessions/${app.editId}/games`, { order });
  if (!r.ok) return msg(msgEl, errText(r), 'err');
  app.sessionGames = r.data;
  msg(msgEl, '');
  renderBuilder();
}

function wireBuilder() {
  $('sess-pick').addEventListener('change', (e) => {
    const id = Number(e.target.value);
    app.editId = Number.isInteger(id) && id > 0 ? id : null;   // '' on an empty library
    loadSessionGames();
  });

  $('sess-new').addEventListener('submit', async (e) => {
    e.preventDefault();
    const title = $('sess-title').value.trim();
    if (title.length < 1) return msg($('builder-msg'), t('titleRequired'), 'err');
    const r = await send('POST', '/api/admin/sessions', { title, loop: $('sess-loop-new').checked });
    if (!r.ok) return msg($('builder-msg'), errText(r), 'err');
    $('sess-new').reset();
    app.editId = r.data.id;
    await loadSessions();
    await loadSessionGames();
    msg($('builder-msg'), t('sessionCreated'), 'ok');
  });

  $('sw-loop').addEventListener('change', async (e) => {
    const r = await send('PATCH', `/api/admin/sessions/${app.editId}`, { loop: e.target.checked });
    if (!r.ok) {
      msg($('builder-msg'), errText(r), 'err');
      return renderBuilder();
    }
    const s = editSession();
    if (s) s.loop = r.data.loop;
    msg($('builder-msg'), '');
  });

  $('btn-start').addEventListener('click', startSession);

  // The same stop-now the loop section has, but where the operator actually looks for it.
  const endBtn = $('btn-end');
  endBtn.addEventListener(
    'click',
    twoTap(endBtn, t('endSession'), async () => {
      const ok = await control('stop-now', endBtn);
      if (!ok) return;
      msg($('builder-msg'), t('sessionEnded'), 'ok');
      loadSessions();
    }),
  );

  const delBtn = $('btn-del-session');
  delBtn.addEventListener(
    'click',
    twoTap(delBtn, t('deleteSession'), async () => {
      if (app.editId === null) return;
      const r = await api(`/api/admin/sessions/${app.editId}`, { method: 'DELETE' });
      if (!r.ok) return msg($('builder-msg'), errText(r), 'err');
      app.editId = null;
      msg($('builder-msg'), t('sessionDeleted'), 'ok');
      await loadSessions();       // re-picks the newest remaining session
      await loadSessionGames();
    }),
  );

  $('sg-add').addEventListener('click', async () => {
    const gameId = Number($('sg-add-pick').value);
    if (!Number.isInteger(gameId)) return;
    const r = await send('POST', `/api/admin/sessions/${app.editId}/games`, { game_id: gameId });
    if (!r.ok) return msg($('builder-msg'), errText(r), 'err');
    app.sessionGames.push(r.data);
    msg($('builder-msg'), '');
    renderBuilder();
  });

  $('sg-list').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const row = btn.closest('.sg-row');
    const id = Number(row.dataset.id);
    const rowMsg = row.querySelector('.sg-msg');
    const ids = app.sessionGames.map((g) => g.id);
    const i = ids.indexOf(id);

    if (btn.dataset.act === 'up') return submitOrder(move(ids, i, i - 1), rowMsg);
    if (btn.dataset.act === 'down') return submitOrder(move(ids, i, i + 1), rowMsg);
    if (btn.dataset.act === 'mode') {
      const g = app.sessionGames[i];
      const r = await send('PATCH', `/api/admin/sessions/${app.editId}/games/${id}`, {
        mode: g.mode === 'single' ? 'b2b' : 'single',
      });
      if (!r.ok) return msg(rowMsg, errText(r), 'err');
      app.sessionGames[i] = r.data;
      return renderBuilder();
    }
    if (btn.dataset.act === 'del') {
      twoTap(btn, null, async () => {
        const r = await api(`/api/admin/sessions/${app.editId}/games/${id}`, { method: 'DELETE' });
        if (!r.ok) return msg(rowMsg, errText(r), 'err');   // 409 -> "Bereits gespielt", in-row
        app.sessionGames = app.sessionGames.filter((g) => g.id !== id);
        renderBuilder();
      })();
    }
  });

  // Native HTML5 drag-and-drop for the desktop mouse. It is unreliable on mobile Safari, which
  // is why the up/down buttons above are the primary touch path, not a fallback.
  // ponytail: no drag library. Ceiling: no auto-scroll while dragging a long list.
  let dragId = null;
  const list = $('sg-list');
  list.addEventListener('dragstart', (e) => {
    const li = e.target.closest('.sg-row');
    if (!li || li.hasAttribute('data-current')) return e.preventDefault();
    dragId = Number(li.dataset.id);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', li.dataset.id);
  });
  list.addEventListener('dragover', (e) => {
    const li = e.target.closest('.sg-row');
    if (!li || dragId === null) return;
    e.preventDefault();
    li.dataset.drop = '1';
  });
  list.addEventListener('dragleave', (e) => {
    const li = e.target.closest('.sg-row');
    if (li) delete li.dataset.drop;
  });
  list.addEventListener('drop', (e) => {
    e.preventDefault();
    const li = e.target.closest('.sg-row');
    if (!li || dragId === null) return;
    const ids = app.sessionGames.map((g) => g.id);
    const order = move(ids, ids.indexOf(dragId), ids.indexOf(Number(li.dataset.id)));
    dragId = null;
    submitOrder(order, li.querySelector('.sg-msg'));
  });
  list.addEventListener('dragend', () => {
    dragId = null;
    for (const li of list.querySelectorAll('[data-drop]')) delete li.dataset.drop;
  });
}

async function startSession() {
  const r = await send('POST', `/api/admin/sessions/${app.editId}/start`);
  if (!r.ok) {
    say(errText(r));
    return msg($('builder-msg'), errText(r), 'err');
  }
  applyState(r.data.state);
  msg($('builder-msg'), '');
  await loadSessions();
  await loadSessionGames();
}

// ---------------------------------------------------------------------------------------------
// 8.5 — overlay URLs + the live preview
// ---------------------------------------------------------------------------------------------

const SD_ACTIONS = ['win', 'loss', 'skip', 'next', 'undo', 'stop-loop'];
const PREV_DEFAULTS = { scale: '1', opacity: '0.85', accent: 'ff5a1f', pos: 'bl', grad: '' };
const prev = { ...PREV_DEFAULTS };

function overlayQuery() {
  const p = new URLSearchParams();
  for (const k of Object.keys(PREV_DEFAULTS)) if (prev[k] !== PREV_DEFAULTS[k]) p.set(k, prev[k]);
  // The copied URLs render in the admin's language: an operator running the panel in German
  // wants a German overlay in OBS. English is the default, so only 'de' is ever written.
  if (STRINGS.LANG === 'de') p.set('lang', 'de');
  const s = p.toString();
  return s === '' ? '' : `?${s}`;
}

const copyRow = (label, value, tip) => `<div class="copy-row">
    <span class="copy-lab">${esc(label)}</span>
    <span class="copy-val">${esc(value)}</span>
    <button class="btn copy-btn" type="button" data-copy="${esc(value)}" title="${esc(tip ?? t('tipCopyUrl'))}">${ICON.copy}<span>${esc(t('copy'))}</span></button>
  </div>`;

function renderUrls() {
  if (app.urls === null) return;
  const q = overlayQuery();
  $('url-rows').innerHTML =
    copyRow(t('urlOverlay'), app.urls.overlay + q) +
    copyRow(t('urlRecap'), app.urls.recap + q) +
    copyRow(t('urlTimer'), app.urls.timer + (STRINGS.LANG === 'de' ? '?lang=de' : '')) +   // the clock ignores the preview params, but not the language
    copyRow(t('urlControl'), app.urls.control);
  $('sd-rows').innerHTML = SD_ACTIONS.map((a) => copyRow(a, `${app.urls.control}/${a}`, t('tipCopyDeck'))).join('');
  $('out-scale').textContent = `${prev.scale}×`;
  $('out-opacity').textContent = prev.opacity;
}

let lastPreviewSrc = '';
function applyPreview() {
  if (app.urls === null) return;
  const src = app.urls.overlay + overlayQuery();
  // Every src rewrite is a document load PLUS a WebSocket connect, and an undebounced drag would
  // empty the DO's rate bucket and 429 the next Stream Deck press (SPEC 8.5 / 6.4).
  if (src === lastPreviewSrc) return;
  lastPreviewSrc = src;
  $('preview').src = src;
}
const schedulePreview = debounce(250, applyPreview);

function wireUrls() {
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-copy]');
    if (!btn) return;
    const label = btn.querySelector('span');
    try {
      await navigator.clipboard.writeText(btn.dataset.copy);
      label.textContent = t('copied');
    } catch {
      label.textContent = t('copyFailed');
    }
    setTimeout(() => (label.textContent = t('copy')), 1200);
  });

  for (const [id, key] of [['p-scale', 'scale'], ['p-opacity', 'opacity'], ['p-accent', 'accent'], ['p-pos', 'pos']]) {
    const el = $(id);
    const read = () => {
      prev[key] = key === 'accent' ? el.value.replace(/^#/, '') : el.value;
      renderUrls();
    };
    el.addEventListener('input', read);          // copy URLs + the printed values only
    el.addEventListener('change', () => {        // the iframe reloads here, debounced
      read();
      schedulePreview();
    });
  }

  // ?grad= — the header gradient. Three stops, defaulting to the channel-banner colours;
  // off produces no param at all, so existing pasted URLs stay byte-identical.
  const gradRead = () => {
    prev.grad = $('p-grad-on').checked
      ? ['p-grad-a', 'p-grad-b', 'p-grad-c'].map((id) => $(id).value.replace(/^#/, '').toLowerCase()).join('-')
      : '';
    renderUrls();
    schedulePreview();
  };
  for (const id of ['p-grad-on', 'p-grad-a', 'p-grad-b', 'p-grad-c']) $(id).addEventListener('change', gradRead);

  for (const [id, which] of [['rot-overlay', 'overlay'], ['rot-control', 'control']]) {
    const btn = $(id);
    const label = btn.textContent;
    btn.addEventListener(
      'click',
      twoTap(btn, label, async () => {
        const r = await send('POST', '/api/admin/tokens/rotate', { which });
        if (!r.ok) return msg($('urls-msg'), errText(r), 'err');
        app.urls = r.data.urls;
        lastPreviewSrc = '';
        renderUrls();
        applyPreview();
        msg($('urls-msg'), t('rotated'), 'ok');
      }),
    );
  }
}

// ---------------------------------------------------------------------------------------------
// 8.6 — history, and the recap components it shares with the recap card
// ---------------------------------------------------------------------------------------------

function renderHistory() {
  if (app.sessions.length === 0) {
    $('hist-list').innerHTML = `<p class="note">${esc(t('histEmpty'))}</p>`;
    return;
  }
  $('hist-list').innerHTML = app.sessions
    .map(
      (s) => `<details class="hist-row" data-id="${s.id}">
      <summary class="hist-head">
        <span class="hist-title">${esc(s.title)}</span>
        <span class="hist-date">${esc(s.started_at === null ? '—' : fmtDate(s.started_at))}</span>
        <span class="hist-nums">${esc(fill('histGames', { n: s.gameCount }))} · ${esc(
          s.started_at && s.ended_at ? fmtDur(s.ended_at - s.started_at) : statusWord(s.status),
        )}</span>
      </summary>
      <div class="hist-body"><p class="msg"></p></div>
    </details>`,
    )
    .join('');
}

function wireHistory() {
  // `toggle` does not bubble, so this listens in the capture phase.
  $('hist-list').addEventListener(
    'toggle',
    async (e) => {
      const row = e.target;
      if (!row.classList?.contains('hist-row') || !row.open) return;
      const body = row.querySelector('.hist-body');
      const m = body.querySelector('.msg');
      if (body.dataset.loaded) return;
      msg(m, t('working'));
      const id = Number(row.dataset.id);
      const r = await api(`/api/admin/sessions/${id}/recap`);
      if (!r.ok) return msg(m, errText(r), 'err');
      body.dataset.loaded = '1';
      body.innerHTML = recapMarkup(r.data, id);
    },
    true,
  );
}

/** DESIGN 8.6: the identical hero, KPI row and per-game table the recap page renders, imported
 *  from recap.js. Admin adds only the export buttons underneath. */
function recapMarkup(recap, sessionId) {
  return `${renderHero(recap)}${renderKpiRow(recap)}${renderPerGameTable(recap)}
    <div class="hist-dl">
      <a class="btn" href="/api/admin/sessions/${sessionId}/export.json" download>${esc(t('exportJson'))}</a>
      <a class="btn" href="/api/admin/sessions/${sessionId}/export.csv" download>${esc(t('exportCsv'))}</a>
    </div>`;
}

// ---------------------------------------------------------------------------------------------
// loading
// ---------------------------------------------------------------------------------------------

function applyState(state) {
  app.state = state;
  document.body.dataset.phase = state.phase;
  // The idle overlay is deliberately invisible; the caption says so under the blank preview.
  const pi = $('preview-idle');
  if (pi) pi.hidden = state.phase === 'live';
  // A live run always wins the builder: it is the list the streamer is actually playing.
  if (state.phase === 'live' && state.sessionId !== null && app.editId !== state.sessionId) {
    app.editId = state.sessionId;
    loadSessionGames();
  }
  renderReadout();
  renderLoop();
  renderResume();
  renderBuilder();
}

let coverRepairTried = false;
async function loadGames() {
  const r = await api('/api/admin/games');
  if (!r.ok) return msg($('manual-msg'), errText(r), 'err');
  app.games = r.data;
  renderLibrary();
  renderBuilder();
  // Games created while cover ingest was broken (or IGDB was down) sit coverless forever —
  // heal them once per page load, silently. A failure just means the next load tries again.
  if (!coverRepairTried && app.games.some((g) => g.igdb_id !== null && g.cover_key === null)) {
    coverRepairTried = true;
    const rep = await send('POST', '/api/admin/games/repair-covers');
    if (rep.ok && rep.data.repaired > 0) {
      const r2 = await api('/api/admin/games');
      if (r2.ok) {
        app.games = r2.data;
        renderLibrary();
      }
      await loadSessionGames();   // the session rows show the same covers
    }
  }
}

async function loadSessions() {
  const r = await api('/api/admin/sessions');
  if (!r.ok) return msg($('builder-msg'), errText(r), 'err');
  app.sessions = r.data;
  if (app.editId === null || !app.sessions.some((s) => s.id === app.editId)) {
    app.editId = (liveSession() ?? app.sessions[0])?.id ?? null;
  }
  renderBuilder();
  renderResume();
  renderHistory();
  renderReadout();
}

async function loadSessionGames() {
  if (app.editId === null) {
    app.sessionGames = [];
    return renderBuilder();
  }
  const r = await api(`/api/admin/sessions/${app.editId}`);
  if (!r.ok) return msg($('builder-msg'), errText(r), 'err');
  app.sessionGames = r.data.sessionGames;
  renderBuilder();
}

function wireLang() {
  const btn = $('btn-lang');
  const other = (STRINGS.LANG ?? 'en') === 'de' ? 'en' : 'de';
  btn.textContent = other === 'de' ? 'Deutsch' : 'English'; // the target language's own name
  btn.addEventListener('click', () => {
    try { localStorage.setItem('lang', other); } catch { /* blocked storage: ?lang= still works */ }
    location.reload();
  });
}

async function boot() {
  applyStrings();
  wireLang();
  wireControls();
  wireLoop();
  wireLibrary();
  wireBuilder();
  wireUrls();
  wireHistory();
  $('btn-resume').addEventListener('click', () => resume($('resume-msg')));

  const [state, tokens] = await Promise.all([api('/api/admin/state'), api('/api/admin/tokens')]);
  if (state.ok) applyState(state.data.state);
  else say(errText(state));
  if (tokens.ok) {
    app.urls = tokens.data.urls;
    renderUrls();
    applyPreview();
  } else msg($('urls-msg'), errText(tokens), 'err');

  await loadSessions();
  await loadGames();
  await loadSessionGames();

  // Fresh deploy: nothing exists yet, so open the section that is actually step 1.
  if (app.games.length === 0 && app.sessions.length === 0) $('sec-library').open = true;

  connect();
}

// ---------------------------------------------------------------------------------------------
// the admin WebSocket (SPEC 4.1 / 4.5 / 4.6) — same reconnect parameters as the overlay
// ---------------------------------------------------------------------------------------------

let attempt = 0;
let lastSeq = 0;

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/api/admin/ws`);
  let dead = false;
  let hb = 0;
  let resumeTimer = 0;

  const down = () => {
    if (dead) return;
    dead = true;
    clearInterval(hb);
    clearTimeout(resumeTimer);
    setConn(false);
    const delay = Math.min(15000, 500 * 2 ** attempt);
    attempt += 1;   // no cap on attempts: a panel that gives up is worse than a slow one
    setTimeout(connect, delay / 2 + Math.random() * (delay / 2));
  };

  ws.onopen = () => {
    attempt = 0;
    setConn(true);
    hb = setInterval(() => {
      try {
        ws.send(PING);
      } catch {
        down();
      }
    }, HEARTBEAT_MS);
    // The server pushes the snapshot unprompted; this is the belt-and-braces path (SPEC 4.6).
    if (lastSeq > 0) resumeTimer = setTimeout(() => requestResume(ws), 2000);
  };

  ws.onmessage = (e) => {
    clearTimeout(resumeTimer);
    let m;
    try {
      m = JSON.parse(e.data);
    } catch {
      return;
    }
    if (m.t !== 'state' || !Array.isArray(m.steps)) return;

    let latest = null;
    let config = false;
    for (const s of m.steps) {
      if (!s || typeof s.state !== 'object' || s.state === null) continue;
      if (s.cause === 'snapshot') {
        lastSeq = s.seq;   // a snapshot is authoritative and reuses the current seq (SPEC 4.5)
        latest = s;
        config = true;
        continue;
      }
      if (s.seq <= lastSeq) continue;
      if (s.seq > lastSeq + 1) requestResume(ws);
      lastSeq = s.seq;
      latest = s;
      if (s.cause === 'config' || s.cause === 'session_start' || s.cause === 'session_end') config = true;
    }
    // The admin renders the newest truth; it has no animation queue to feed (that is the
    // overlay's job), so the intermediate steps of one action need no separate paint.
    if (latest !== null) applyState(latest.state);
    if (config) refreshConfig();
  };

  ws.onclose = down;
  ws.onerror = down;
}

function requestResume(ws) {
  try {
    ws.send(JSON.stringify({ t: 'resume', seq: lastSeq }));
  } catch {
    /* the close handler owns the reconnect */
  }
}

const refreshConfig = debounce(250, async () => {
  await loadSessions();
  await loadSessionGames();
});

boot();
