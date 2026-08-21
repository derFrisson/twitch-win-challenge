// The clock's admin page (feature prompt §4). Desktop-only, plain ES module, no bundler.
//
// EVERY value the money model uses is a field on this page. Nothing about the campaign, the
// rate, the base, the cap or the exclusions is hardcoded anywhere in the Worker.
//
// The form speaks HOURS and EUROS because a human does. The wire and the database speak integer
// milliseconds and integer cents. The conversion happens here, at the boundary, and nowhere else.

import * as STRINGS from '/strings.js';
const T = STRINGS.TIMER_ADMIN ?? {};
const t = (k) => T[k] ?? '';

const $ = (id) => document.getElementById(id);
const H = 3_600_000;

// Donor names and ledger notes are third-party / free text and go into markup, so they are
// escaped rather than trusted. (textContent where possible; this is for template strings.)
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const eur = (cents) =>
  new Intl.NumberFormat(STRINGS.LANG === 'de' ? 'de-DE' : 'en-US', { style: 'currency', currency: 'EUR' })
    .format(cents / 100);
const hms = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

let state = null;
let skew = 0;
let tick = 0;

async function api(path, opts) {
  try {
    const res = await fetch(`/api/admin/timer${path}`, {
      cache: 'no-store',
      headers: opts?.body === undefined ? undefined : { 'content-type': 'application/json' },
      ...opts,
      signal: AbortSignal.timeout(10_000),
    });
    const data = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: null };
  }
}

// ======================== the live readout ========================

function paintClock() {
  if (state?.timer == null) return;
  const tm = state.timer;
  const ms = tm.phase === 'running' && tm.endsAt !== null ? tm.endsAt - (Date.now() + skew) : tm.remainingMs;
  $('rd-title').textContent = hms(ms);
}

function scheduleTick() {
  clearTimeout(tick);
  if (state?.timer?.phase !== 'running') return;
  tick = setTimeout(() => { paintClock(); scheduleTick(); }, 1000 - ((Date.now() + skew) % 1000));
}

function renderReadout() {
  const tm = state.timer, pool = state.pool;
  const live = tm.phase === 'running';
  document.body.dataset.phase = live ? 'live' : 'idle';
  $('pill-text').textContent = tm.phase === 'running' ? 'LIVE'
    : tm.phase === 'paused' ? t('pause')
    : tm.phase === 'ended' ? t('pillEnded')
    : t('pillIdle');
  $('live-pill').className = `pill ${live ? 'chip-live' : 'chip-off'}`;

  $('stats').innerHTML = [
    [t('statRemaining'), hms(tm.remainingMs)],
    [t('statEarned'), `${(tm.earnedMs / H).toFixed(1)} h`],
    [t('statConsumed'), hms(tm.consumedMs)],
    [t('statPaused'), hms(tm.pausedTotalMs)],
    [t('statPool'), eur(pool.totalCents)],
    [t('statEligible'), eur(pool.eligibleCents)],
  ].map(([l, v]) => `<div class="ctr"><span class="ctr-v">${esc(v)}</span><span class="ctr-l">${esc(l)}</span></div>`).join('');

  const b = $('btn-pause');
  b.textContent = tm.phase === 'paused' ? t('resume') : t('pause');
  b.title = t('tipPause');
  b.className = `act ${tm.phase === 'paused' ? 'act-win' : 'act-loss'}`;
  b.hidden = tm.phase !== 'running' && tm.phase !== 'paused';
  $('btn-plus').hidden = b.hidden;

  paintClock();
  scheduleTick();
}

function renderBanner() {
  const p = state.pool, el = $('banner'), txt = $('banner-text');
  const msgs = [];
  // Only warn about the data source once there is something to poll. A fresh page with no run
  // and no campaigns is not "degraded" — warning there trains the eye to ignore the banner,
  // which is the one place a real outage has to be visible at 04:00.
  const polling = state.run !== null && state.run.status === 'live' && state.campaigns.length > 0;
  if (polling && p.source !== 'live') msgs.push(t('srcManual'));
  if (p.heldBackwards) msgs.push(t('heldBack'));
  if (p.reconcileDeltaCents !== 0) msgs.push((t('mismatch') || '').replace('{delta}', eur(p.reconcileDeltaCents)));
  el.hidden = msgs.length === 0;
  el.className = `banner ${p.health === 'failed' ? 'banner-bad' : 'banner-warn'}`;
  txt.textContent = msgs.join('  ·  ');
}

// ======================== sections ========================

function renderRun() {
  const r = state.run;
  if (r === null) {
    $('run-body').innerHTML = `
      <p class="note">${esc(t('noRun'))}</p>
      <form id="new-run" class="row">
        <label class="fld"><span class="fld-lab">${esc(t('newRunTitle'))}</span>
          <input id="nr-title" type="text" maxlength="80" required autocomplete="off" /></label>
        <button class="btn btn-good" type="submit" title="${esc(t('tipCreateRun'))}">${esc(t('create'))}</button>
      </form>`;
    $('new-run').addEventListener('submit', async (e) => {
      e.preventDefault();
      // The defaults a new run starts with. Every one of them is editable below, mid-run.
      const r2 = await api('/runs', { method: 'POST', body: JSON.stringify({
        title: $('nr-title').value.trim(), base_ms: 12 * H, cents_per_hour: 1000, cap_ms: 72 * H,
      }) });
      if (r2.ok) await load();
    });
    return;
  }

  const canStart = r.status === 'draft';
  $('run-body').innerHTML = `
    <div class="rd-line"><strong>${esc(r.title)}</strong>
      <span class="chip ${r.status === 'live' ? 'chip-live' : 'chip-off'}">${esc(r.status)}</span></div>
    <div class="row">
      ${canStart ? `<button id="btn-start" class="btn btn-good" title="${esc(t('tipStartRun'))}">${esc(t('start'))}</button>` : ''}
      ${r.status === 'live' ? `<button id="btn-end" class="btn btn-danger-out" title="${esc(t('tipEndRun'))}">${esc(t('end'))}</button>` : ''}
      <button id="btn-poll" class="btn" title="${esc(t('tipPollNow'))}">${esc(t('pollNow'))}</button>
      ${r.status !== 'draft' ? `<button id="btn-reset-run" class="btn btn-danger-out" title="${esc(t('tipResetRun'))}">${esc(t('resetRun'))}</button>` : ''}
      ${r.status !== 'live' ? `<button id="btn-del-run" class="btn btn-danger-out" title="${esc(t('tipDeleteRun'))}">${esc(t('deleteRun'))}</button>` : ''}
    </div>`;
  $('btn-start')?.addEventListener('click', async () => { await api(`/runs/${r.id}/start`, { method: 'POST' }); await load(); });
  $('btn-end')?.addEventListener('click', async () => {
    // Same native-confirm guard as delete/reset: ending a run is final short of a reset.
    if (!confirm(t('confirmEndRun'))) return;
    await api('/control/end', { method: 'POST', body: '{}' }); await load();
  });
  $('btn-poll')?.addEventListener('click', async () => { await api('/poll', { method: 'POST' }); await load(); });
  $('btn-del-run')?.addEventListener('click', async () => {
    // Desktop-only page, rare destructive action: the native dialog is the right amount of UI.
    if (!confirm(t('confirmDeleteRun'))) return;
    await api(`/runs/${r.id}`, { method: 'DELETE' });
    await load();
  });
  $('btn-reset-run')?.addEventListener('click', async () => {
    if (!confirm(t('confirmResetRun'))) return;
    await api(`/runs/${r.id}/reset`, { method: 'POST' });
    await load();
  });
}

function renderConfig() {
  const r = state.run;
  if (r === null) { $('config-body').innerHTML = `<p class="note">${esc(t('configWaits'))}</p>`; return; }
  const f = (id, label, value, attrs = 'type="number" step="any" min="0"', tip = '') =>
    `<label class="fld"${tip ? ` title="${esc(tip)}"` : ''}><span class="fld-lab">${esc(label)}</span>
       <input id="${id}" ${attrs} value="${esc(value)}" /></label>`;

  $('config-body').innerHTML = `
    <div class="grid2">
      ${f('c-title', t('fTitle'), r.title, 'type="text" maxlength="80"')}
      ${f('c-base', t('fBase'), r.base_ms / H, undefined, t('tipFBase'))}
      ${f('c-rate', t('fRate'), r.cents_per_hour / 100, undefined, t('tipFRate'))}
      ${f('c-cap', t('fCap'), r.cap_ms / H, undefined, t('tipFCap'))}
      ${f('c-manual', t('fManual'), r.manual_exclusion_cents / 100, undefined, t('tipFManual'))}
      ${f('c-poll', t('fPoll'), r.poll_interval_ms / 1000, 'type="number" min="5" step="1"', t('tipFPoll'))}
      ${f('c-after', t('fAutoAfter'), r.auto_pause_after, 'type="number" min="1" step="1"', t('tipFAfter'))}
      ${f('c-twitch', t('fTwitch'), r.twitch_login ?? '', 'type="text" maxlength="40"', t('tipFTwitch'))}
    </div>
    <label class="latch"><span class="latch-lab">${esc(t('fAutoPause'))}</span>
      <input id="c-auto" type="checkbox" class="sw" role="switch" ${r.auto_pause ? 'checked' : ''} /></label>
    <div class="row"><button id="c-save" class="btn btn-good" title="${esc(t('tipSave'))}">${esc(t('save'))}</button>
      <span id="c-msg" class="msg"></span></div>`;

  $('c-save').addEventListener('click', async () => {
    const numOf = (id) => Number($(id).value);
    // Hours/euros in, integer ms/cents out. Math.round, not trunc: 0.1h typed by a human must
    // not silently become 359999ms.
    const body = {
      title: $('c-title').value.trim(),
      base_ms: Math.round(numOf('c-base') * H),
      cents_per_hour: Math.round(numOf('c-rate') * 100),
      cap_ms: Math.round(numOf('c-cap') * H),
      manual_exclusion_cents: Math.round(numOf('c-manual') * 100),
      poll_interval_ms: Math.round(numOf('c-poll') * 1000),
      auto_pause: $('c-auto').checked ? 1 : 0,
      auto_pause_after: Math.round(numOf('c-after')),
      twitch_login: $('c-twitch').value.trim(),
    };
    const res = await api(`/runs/${state.run.id}`, { method: 'PATCH', body: JSON.stringify(body) });
    $('c-msg').textContent = res.ok ? t('saved') : (res.data?.detail ?? t('failed'));
    if (res.ok) await load();
  });
}

function renderCampaigns() {
  const rows = state.campaigns.map((c) => `
    <tr><td>${esc(c.fund_name ?? c.slug)}<br><span class="fld-lab">${esc(c.slug)}</span></td>
        <td class="num">${c.last_total_cents === null ? '—' : esc(eur(c.last_total_cents))}</td>
        <td><span class="chip ${c.health === 'ok' ? 'chip-live' : 'chip-off'}">${esc(c.health)}</span></td>
        <td><button class="btn btn-danger-out" data-camp="${c.id}" title="${esc(t('tipCampRemove'))}"
              aria-label="${esc(fillT('campRemoveName', { slug: c.slug }))}">${esc(t('remove'))}</button></td></tr>`).join('');

  $('camp-body').innerHTML = `
    ${rows === '' ? `<p class="note">${esc(t('campFirstRun'))}</p>` : `<table class="tbl"><tbody>${rows}</tbody></table>`}
    <form id="add-camp" class="row">
      <label class="fld"><span class="fld-lab">${esc(t('campaignSlug'))}</span>
        <input id="camp-slug" type="text" required autocomplete="off" placeholder="${esc(t('slugPlaceholder'))}"
          title="${esc(t('tipSlug'))}" /></label>
      <button class="btn" type="submit">${esc(t('add'))}</button>
    </form>`;

  $('add-camp').addEventListener('submit', async (e) => {
    e.preventDefault();
    // Accept a pasted full URL too — the API wants only the path segment, and a human will paste
    // whatever is in the address bar.
    const raw = $('camp-slug').value.trim();
    const slug = raw.replace(/^https?:\/\/[^/]*\/f\//i, '').replace(/[/?#].*$/, '');
    const res = await api('/campaigns', { method: 'POST', body: JSON.stringify({ slug }) });
    if (res.ok) { $('camp-slug').value = ''; await api('/poll', { method: 'POST' }); await load(); }
  });
  for (const b of $('camp-body').querySelectorAll('[data-camp]')) {
    b.addEventListener('click', async () => { await api(`/campaigns/${b.dataset.camp}`, { method: 'DELETE' }); await load(); });
  }
}

function renderDonations() {
  const ds = state.donations;
  if (ds.length === 0) { $('don-body').innerHTML = `<p class="note">${esc(t('noDonations'))}</p>`; return; }
  const rate = state.run?.cents_per_hour ?? 1000;
  $('don-body').innerHTML = `
    <table class="tbl">
      <thead><tr><th>${esc(t('colDonor'))}</th><th>${esc(t('colAmount'))}</th>
        <th>${esc(t('colTime'))}</th><th>${esc(t('colCounts'))}</th></tr></thead>
      <tbody>${ds.map((d) => `
        <tr data-excluded="${d.excluded_from_time}">
          <td>${esc(d.donor_name ?? '—')}</td>
          <td class="num">${esc(eur(d.amount_cents))}</td>
          <td class="num">${d.excluded_from_time ? '—' : esc(hms(Math.floor((d.amount_cents * H) / rate)))}</td>
          <td><input type="checkbox" class="sw" role="switch" data-don="${esc(d.gofundme_id)}"
               title="${esc(t('tipDonSwitch'))}"
               aria-label="${esc(fillT('donCountsName', { name: d.donor_name ?? t('colDonor'), amount: eur(d.amount_cents) }))}"
               ${d.excluded_from_time ? '' : 'checked'} /></td>
        </tr>`).join('')}</tbody></table>`;

  for (const cb of $('don-body').querySelectorAll('[data-don]')) {
    cb.addEventListener('change', async () => {
      // Checked means "counts for time", so the stored flag is the inverse.
      await api(`/donations/${encodeURIComponent(cb.dataset.don)}`, {
        method: 'PATCH', body: JSON.stringify({ excluded_from_time: !cb.checked }),
      });
      await load();
    });
  }
}

function renderLedger() {
  const as = state.adjustments;
  $('ledger-body').innerHTML = `
    ${as.length === 0 ? `<p class="note">${esc(t('noLedger'))}</p>` : `
      <table class="tbl"><tbody>${as.map((a) => `
        <tr data-excluded="${a.undone_at === null ? 0 : 1}">
          <td>${esc(a.note)}<br><span class="fld-lab">${esc(a.author)}</span></td>
          <td class="num">${a.cents ? esc(eur(a.cents)) : ''}${a.ms ? ` ${esc(hms(Math.abs(a.ms)))}` : ''}</td>
          <td>${a.undone_at === null ? `<button class="btn btn-danger-out" data-adj="${a.id}" title="${esc(t('tipAdjUndo'))}">${esc(t('undo'))}</button>` : ''}</td>
        </tr>`).join('')}</tbody></table>`}
    <form id="add-adj" class="row">
      <label class="fld"><span class="fld-lab">${esc(t('ledgerNote'))}</span>
        <input id="adj-note" type="text" maxlength="200" required autocomplete="off" /></label>
      <label class="fld" title="${esc(t('tipAdjEur'))}"><span class="fld-lab">${esc(t('ledgerAmount'))}</span>
        <input id="adj-eur" type="number" step="any" /></label>
      <label class="fld" title="${esc(t('tipAdjMin'))}"><span class="fld-lab">${esc(t('ledgerTime'))}</span>
        <input id="adj-min" type="number" step="1" /></label>
      <button class="btn" type="submit">${esc(t('add'))}</button>
    </form>`;

  $('add-adj').addEventListener('submit', async (e) => {
    e.preventDefault();
    const cents = Math.round(Number($('adj-eur').value || 0) * 100);
    const ms = Math.round(Number($('adj-min').value || 0) * 60_000);
    const res = await api('/adjustments', { method: 'POST', body: JSON.stringify({ cents, ms, note: $('adj-note').value.trim() }) });
    if (res.ok) await load();
  });
  for (const b of $('ledger-body').querySelectorAll('[data-adj]')) {
    b.addEventListener('click', async () => { await api(`/adjustments/${b.dataset.adj}`, { method: 'DELETE' }); await load(); });
  }
}

// ======================== boot ========================

// A section whose field the user is typing in is NEVER rewritten — innerHTML replacement mid-keystroke
// is exactly the "form resets while I type" bug. The skipped section catches up on the next push.
function render(bodyId, fn) {
  const el = $(bodyId);
  if (el.contains(document.activeElement)) return;
  fn();
}

async function load() {
  const res = await api('/state');
  if (!res.ok || res.data === null) return;
  state = res.data;
  renderBanner(); renderReadout();   // no inputs up here — always safe to repaint
  render('run-body', renderRun);
  render('config-body', renderConfig);
  render('camp-body', renderCampaigns);
  render('don-body', renderDonations);
  render('ledger-body', renderLedger);
}

function applyStrings() {
  for (const el of document.querySelectorAll('[data-s]')) el.textContent = t(el.dataset.s);
  for (const el of document.querySelectorAll('[data-st]')) el.title = t(el.dataset.st);
  document.title = t('title');
}

const fillT = (k, vars) => t(k).replace(/\{(\w+)\}/g, (_, n) => String(vars[n] ?? ''));

{
  const btn = $('btn-lang');
  const other = (STRINGS.LANG ?? 'en') === 'de' ? 'en' : 'de';
  btn.textContent = other === 'de' ? 'Deutsch' : 'English'; // the target language's own name
  btn.addEventListener('click', () => {
    try { localStorage.setItem('lang', other); } catch { /* blocked storage: ?lang= still works */ }
    location.reload();
  });
}

$('btn-pause').addEventListener('click', async () => {
  const paused = state?.timer?.phase === 'paused';
  await api(`/control/${paused ? 'resume' : 'pause'}`, { method: 'POST', body: '{}' });
  await load();
});
$('btn-plus').addEventListener('click', async () => {
  await api('/adjustments', { method: 'POST', body: JSON.stringify({ ms: H, note: t('plusHour') }) });
  await load();
});

// ---- push channel: the DO broadcasts on every poll / control / config change. The WS payload
// carries only timer+pool, so a push is treated as a "something changed" signal and the full
// page payload is re-fetched — one code path for every kind of update. ----
let loadTimer = 0;
const scheduleLoad = () => { clearTimeout(loadTimer); loadTimer = setTimeout(load, 200); };

let attempt = 0;
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/api/admin/timer/ws`);
  let dead = false;
  let hb = 0;
  const down = () => {
    if (dead) return;
    dead = true;
    clearInterval(hb);
    const delay = Math.min(15000, 500 * 2 ** attempt);
    attempt += 1;
    setTimeout(connect, delay / 2 + Math.random() * (delay / 2));
  };
  ws.onopen = () => {
    attempt = 0;
    // Byte-exact ping for the DO's auto-responder (same contract as the overlay socket).
    hb = setInterval(() => { try { ws.send('{"t":"ping"}'); } catch { down(); } }, 20_000);
  };
  ws.onmessage = (e) => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m?.t === 'timer') scheduleLoad();   // never the pong replies — they arrive here too
  };
  ws.onclose = down;
  ws.onerror = down;
}

applyStrings();
await load();
connect();   // the clock ticks locally from ends_at; everything else arrives by push
