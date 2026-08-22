// public/strings.js
//
// ALL user-facing copy for the overlay, the recap scene, the admin panel, the subathon clock
// and its admin page (SPEC §1.1) — in BOTH languages. Adding a language means completing every
// key in a new object below; nothing outside this file changes.
//
// Language pick (this module decides, consumers never do):
//   1. `?lang=de` / `?lang=en` on the page URL — how an OBS browser source pins its language,
//   2. localStorage 'lang' — the stored admin preference (set by the toggle on the admin pages),
//   3. default: 'en'.
// The pick also drives the Intl number/date formatters and sets <html lang> at runtime.
//
// Shape — five named exports, one per surface, each matching how that surface's own JS was
// actually written to read this module:
//   - `overlay` — flat, function-valued. overlay.js does `import * as STRINGS from '/strings.js'`
//     then reads `STRINGS.overlay`, so this must be a TOP-LEVEL export literally named `overlay`
//     (module namespace objects are one level flat).
//   - `ADMIN` — flat strings with `{var}` placeholders. admin.js reads `STRINGS.ADMIN` and
//     interpolates with `fill = (k, vars) => t(k).replace(/\{(\w+)\}/g, ...)`. The key list was
//     built by grepping every `t('...')`, `fill('...', ...)`, `data-s=`, `data-sp=` and
//     `data-sl=` in admin.js and admin/index.html — not guessed.
//   - `STRINGS` — recap.js's own nested, richer copy (`STRINGS.common`, `STRINGS.recap`).
//   - `timer` / `TIMER_ADMIN` — the clock overlay and its admin page, same patterns.
//
// Casing note: strings are stored in natural/sentence case wherever the consuming CSS applies
// `text-transform: uppercase` (confirmed for `.pill`/`.act`/`.chip`/`.sec-sub` in admin.css and
// `#statetag` in timer.css). Where no such rule exists, the literal uppercase is baked into the
// string instead (the overlay takeover words).
//
// NOT here (SPEC §1.1's one deliberate divergence): the four `requireAccess` 401 messages in
// src/auth.ts and the three `/c/*` plain-text bodies ("ok" / "noop" / "rate limited") in
// src/index.ts. Those are server-side, never rendered for a viewer, and pulling them into a
// browser-only ES module would need a bundler this project deliberately does not have (SPEC §1).

// ---------------------------------------------------------------------------------------------
// language pick — every browser API is guarded so plain `node` can import this module (the key
// parity check in the repo's tooling does exactly that).
// ---------------------------------------------------------------------------------------------

export const LANG = (() => {
  try {
    const p = new URLSearchParams(location.search).get('lang');
    if (p === 'de' || p === 'en') return p;
  } catch { /* no location (node) */ }
  try {
    const s = localStorage.getItem('lang');
    if (s === 'de' || s === 'en') return s;
  } catch { /* no localStorage, or it is blocked */ }
  return 'en';
})();

try { document.documentElement.lang = LANG; } catch { /* no document (node) */ }

// ---------------------------------------------------------------------------------------------
// number / date formatting (SPEC §3.0.1: storage is epoch-ms, display follows the language)
// ---------------------------------------------------------------------------------------------

const LOCALE = LANG === 'de' ? 'de-DE' : 'en-US';

const numberFmt = new Intl.NumberFormat(LOCALE);
const dateFmt = new Intl.DateTimeFormat(LOCALE, { day: '2-digit', month: '2-digit', year: 'numeric' });
const dateTimeFmt = new Intl.DateTimeFormat(LOCALE, {
  day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
});

/** 1234 -> "1.234" (de) / "1,234" (en) */
export function fmtNumber(n) {
  return numberFmt.format(n ?? 0);
}

/** epoch ms or ISO-8601 string -> "20.08.2026" / "08/20/2026" */
export function fmtDate(when) {
  return dateFmt.format(new Date(when));
}

/** epoch ms or ISO-8601 string -> "20.08.2026, 21:04" / "08/20/2026, 09:04 PM" */
export function fmtDateTime(when) {
  return dateTimeFmt.format(new Date(when));
}

/** a duration in ms -> "m:ss". Minutes are unbounded — a round or a game can run past 59:59. */
export function fmtClock(ms) {
  const totalSeconds = Math.max(0, Math.round((ms ?? 0) / 1000));
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** a duration in ms -> "h:mm h" — the session-total figure ("3:12 h"). */
export function fmtHours(ms) {
  const totalMinutes = Math.max(0, Math.round((ms ?? 0) / 60000));
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${h}:${String(m).padStart(2, '0')} h`;
}

const plural = (n, singular, pluralForm) => `${fmtNumber(n)} ${(n ?? 0) === 1 ? singular : pluralForm}`;

const eur = (cents) =>
  new Intl.NumberFormat(LOCALE, { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 })
    .format(Math.round(cents / 100));

// =================================================================================================
// GERMAN
// =================================================================================================

const DE = {
  STRINGS: {
    common: {
      losses: (n) => plural(n, 'Niederlage', 'Niederlagen'),
      attempts: (n) => plural(n, 'Versuch', 'Versuche'),
    },

    // recap.html / recap.js — SPEC §7.7, DESIGN §7. Section titles render UPPERCASE via CSS
    // (recap.js's own injected `.r-section-title` rule); stored here in sentence case.
    recap: {
      untitled: 'Ohne Titel',
      inProgressSuffix: ' · läuft noch',

      // "6 von 8 gewonnen" (DESIGN §7.2 Figure 1 — the one hero number, never a one-bar chart)
      hero: (won, played) => `${fmtNumber(won)} von ${fmtNumber(played)} gewonnen`,

      // the six KPI tiles (DESIGN §7.3 mockup), sentence case, no trailing colon
      kpi: {
        played: 'Gespielt',
        won: 'Gewonnen',
        lost: 'Abgebrochen',
        skipped: 'Übersprungen',
        rounds: 'Runden',
        wins: 'Siege',
      },

      // the round-strip / per-lap legend words (DESIGN §7.5's two axis-end labels)
      legend: { wins: 'Siege', losses: 'Niederlagen' },

      table: {
        title: 'Zeit & Niederlagen pro Spiel', // DESIGN §7.3 mockup, literal
        lossesCol: 'Niederlagen',
        durationCol: 'Dauer',
        max: (v) => `max. ${v}`, // DESIGN §7.4: "each column's max is printed once in its header"
        empty: 'Keine Spiele in dieser Session.',
      },

      // outcome cell: icon + word, never colour alone (DESIGN §7.4/§8.5). 'unvollendet' is the
      // literal word DESIGN §7.4 specifies for an in-progress visit at session end.
      outcome: {
        won: 'gewonnen',
        skipped: 'übersprungen',
        abandoned: 'abgebrochen',
        incomplete: 'unvollendet',
      },

      roundStrip: {
        title: 'Rundenverlauf', // DESIGN §7.3 mockup, literal
        longest: 'längste Runde', // DESIGN §7.5, literal ("14:22 längste Runde")
        truncatedSuffix: (n) => ` · letzte ${fmtNumber(n)} Runden`, // DESIGN §7.5, literal
        empty: 'Keine Versuche aufgezeichnet.',
      },

      // Deliberately named "Durchlauf", not "Runde": this app already uses "Runde" for
      // RunState.lap, and reusing it here — on the SAME recap page that also has a
      // "Rundenverlauf" chart about individual win/loss rounds — would put two different
      // meanings of "Runde" on screen at once.
      perLap: {
        title: 'Pro Durchlauf',
        lapLabel: (lap) => `Durchlauf ${fmtNumber(lap)}`,
      },

      spotlight: {
        worst: 'Härtestes Spiel', // DESIGN §7.3 mockup, literal
        fastest: 'Schnellster Sieg', // DESIGN §7.3 mockup, literal
        noLosses: 'Keine Niederlagen — bisher eine perfekte Serie.',
        noWins: 'Noch kein Sieg in dieser Session.',
        overLaps: (n) => `über ${fmtNumber(n)} Durchläufe`,
      },

      errors: {
        noSession: 'Keine Session gefunden.',
        loadFailed: 'Recap konnte nicht geladen werden.',
      },
    },
  },

  // overlay.html / overlay.js — the v2 compact list (SPEC §7). Four keys, see overlay.js's
  // header for the exact contract. The takeover words are literal uppercase: #to-word has no
  // text-transform rule, the mockup text IS the on-screen text.
  overlay: {
    // The header bar. The session's own title when it has one, so a scene switch tells the
    // audience WHICH challenge this is; the generic word otherwise.
    panelTitle: (sessionTitle) => (sessionTitle ? sessionTitle.toUpperCase() : 'WIN-CHALLENGE'),

    wonWord: 'GESCHAFFT',
    endedWord: 'BEENDET',

    // The one line under BEENDET on the ended takeover. `durationMs` is null when this client
    // never observed the session_start step (RunState carries no timestamps, SPEC §4.2) — the
    // clause is omitted rather than showing a wrong or NaN figure.
    endedLine(sessionTitle, gamesWon, gamesPlayed, losses, durationMs) {
      const parts = [`${fmtNumber(gamesWon)}/${fmtNumber(gamesPlayed)} gewonnen`,
                     plural(losses, 'Niederlage', 'Niederlagen')];
      if (durationMs != null) parts.push(fmtHours(durationMs));
      return parts.join(' · ');
    },
  },

  // admin/index.html + admin.js (SPEC §8, DESIGN §6). `errors` is keyed by the exact `error`
  // code the Worker returns (SPEC §5.3/§5.4) plus one client-only code (`current_game_last`).
  // Unlisted codes still show something useful: `errCode()` in admin.js falls back to
  // `${t('errorGeneric')} (${code})`.
  ADMIN: {
    newGameMode: 'Modus für neue Spiele',
    navRun: 'Win-Challenge',
    navTimer: 'Stream-Zeit',
    // 8.1 — live control bar + readout
    win: 'Sieg',
    loss: 'Niederlage',
    skip: 'Überspringen',
    undo: 'Rückgängig',
    undoHold: 'Gedrückt halten zum Rückgängigmachen',
    lossesLabel: 'Niederlagen',
    streakLabel: 'Serie',
    attemptsLabel: 'Versuche',
    live: 'Live',
    connecting: 'Verbindet…',
    ended: 'Beendet',
    noSession: 'Keine Session',
    startSession: 'Session starten',
    resumeSession: 'Session fortsetzen',
    pickSession: 'Bitte zuerst eine Session auswählen.',
    metaGame: 'Spiel {n}/{m}',
    metaLap: 'Runde {n}',
    metaTotals: '{won} von {played} gewonnen',
    modeSingle: 'Einzel',
    modeB2b: 'B2B',
    errorGeneric: 'Fehler',
    working: 'Wird verarbeitet…',

    // confirm / two-tap (DESIGN §6.3/§6.4/§8.4 — the shared `twoTap()` confirm-label swap)
    confirmAgain: 'Wirklich? Nochmal tippen',

    // 8.7 — resume banner
    resumeFound: 'Laufende Session gefunden — {title}, Spiel {n}/{m}, Runde {lap}',
    resumed: 'Session wiederhergestellt.',

    // 8.3 — session builder
    secBuilder: 'Session-Planer',
    sessionPick: 'Session bearbeiten',
    newSession: 'Neue Session',
    loopLabel: 'Loop',
    create: 'Erstellen',
    titleRequired: 'Titel erforderlich.',
    sessionCreated: 'Session erstellt.',
    loopEditLabel: 'Loop — Session endlos wiederholen',
    noGamesYet: 'Noch keine Spiele in dieser Session — unten ein Spiel hinzufügen.',
    insertNote: 'Vor dem aktuellen Spiel eingefügte Titel kommen erst in der nächsten Runde',
    addToSession: 'Spiel auswählen',
    addGame: 'Spiel hinzufügen',
    dragHandle: 'Ziehen zum Verschieben',
    running: 'Läuft',
    moveUp: 'Nach oben',
    moveDown: 'Nach unten',
    removeEntry: 'Entfernen',
    draft: 'Entwurf',
    endSession: 'Session beenden',
    deleteSession: 'Session löschen',
    sessionDeleted: 'Session gelöscht.',

    // 8.4 — loop control
    secLoop: 'Loop-Steuerung',
    stopAfterCurrent: 'Nach diesem Spiel stoppen',
    armed: 'Scharf',
    // SPEC §2.5h, literal: the latched-indicator sentence, shown while armed. UNDO never clears
    // this flag, so the copy never implies it might.
    armedSub: 'Stoppt nach diesem Spiel',
    stopAfterHint: 'Beendet die Session nach dem aktuellen Spiel.',
    unarmed: 'Der Stopp wurde zurückgenommen.',
    stopNow: 'Jetzt stoppen',
    sessionEnded: 'Session beendet.',

    // 8.2 — game library
    secLibrary: 'Spielebibliothek',
    addLibraryGame: 'Spiel zur Bibliothek hinzufügen',
    igdbSearch: 'IGDB-Suche',
    searching: 'Suche…',
    igdbNoResults: 'Keine Treffer.',
    igdbFallback: '— bitte manuell hinzufügen.',
    manualTitle: 'Manuell hinzufügen',
    manualName: 'Name',
    modeLabel: 'Modus',
    manualCover: 'Cover (optional)',
    flipMode: 'Modus umschalten',
    deleteGame: 'Spiel löschen',
    nameRequired: 'Name erforderlich.',
    coverTooLarge: 'Cover zu groß (max. 2 MB).',
    gameAdded: 'Spiel hinzugefügt.',
    gameAddedNoCover: 'Spiel hinzugefügt, Cover-Upload fehlgeschlagen:',

    // 8.5 — overlay URLs + live preview
    secUrls: 'Overlay-URLs',
    urlOverlay: 'Overlay',
    urlRecap: 'Recap',
    urlTimer: 'Stream-Zeit',
    urlControl: 'Steuerung',
    copy: 'Kopieren',
    copied: 'Kopiert',
    copyFailed: 'Kopieren fehlgeschlagen',
    rotateWarn: 'OBS muss die neue URL bekommen',
    rotateOverlay: 'Overlay-URL rotieren',
    rotateControl: 'Steuer-URL rotieren',
    rotated: 'Rotiert.',
    streamdeckTitle: 'Stream Deck',
    previewTitle: 'Live-Vorschau',
    pScale: 'Skalierung',
    pOpacity: 'Deckkraft',
    pAccent: 'Akzentfarbe',
    pPos: 'Position',
    pGradOn: 'Farbverlauf im Kopf',
    pGradA: 'Verlauf 1',
    pGradB: 'Verlauf 2',
    pGradC: 'Verlauf 3',

    // 8.6 — history (the expanded row's recap components come from recap.js and use STRINGS.recap)
    secHistory: 'Verlauf',
    histGames: '{n} Spiele',
    histEmpty: 'Noch kein Verlauf. Beendete Sessions erscheinen hier mit Recap und JSON/CSV-Export.',
    exportJson: 'JSON exportieren',
    exportCsv: 'CSV exportieren',

    // First-run guidance: a fresh deploy has no games and no sessions; every empty section
    // says what to do NEXT, in order (library -> session -> start -> OBS URL).
    firstRunNoSessions: 'Zuerst Spiele in der Bibliothek anlegen, dann unten eine Session erstellen.',
    firstRunNoGames: 'Der Session unten Spiele hinzufügen, dann starten.',
    builderFirstRun: 'Noch keine Session. Schritt 1: Spiele in der Bibliothek anlegen. Schritt 2: Hier eine Session erstellen. Schritt 3: Spiele hinzufügen und starten.',
    libEmptyHint: 'Bibliothek ist leer — zuerst dort ein Spiel anlegen.',
    libFirstRun: 'Die Bibliothek ist leer. Hier startet alles: über + per IGDB suchen oder unten manuell anlegen. Danach im Session-Planer eine Session bauen.',
    urlsIntro: 'Overlay-URL kopieren und in OBS als Browser-Quelle einfügen — die Stream-Zeit-URL ist die Uhr.',
    previewIdleNote: 'Ohne laufende Session ist das Overlay unsichtbar — auf Stream gewollt. Session starten, um die Vorschau zu sehen.',

    simTitle: 'Simulation',
    simNote: 'Spielt das Ereignis kurz in OBS (und in der Vorschau oben) ab und springt danach von selbst auf den echten Stand zurück. Es wird nichts gespeichert — Zähler und Uhr bleiben unberührt. Win/Gewonnen/Niederlage brauchen eine laufende Session.',
    simWin: 'Win',
    simWon: 'Spiel gewonnen',
    simLoss: 'Niederlage',
    simDonation: 'Spende',
    simSent: 'Gesendet — schau in OBS.',
    tipSimWin: 'Zeigt den Win-Moment (Zähler + Flamme) für ein paar Sekunden im Overlay.',
    tipSimWon: 'Zeigt die „Gewonnen“-Einblendung für ein paar Sekunden im Overlay.',
    tipSimLoss: 'Zeigt den Niederlagen-Moment für ein paar Sekunden im Overlay.',
    tipSimDonation: 'Spielt Spenden-Toast, Sound und Zeit-Sprung kurz auf der Stream-Zeit-Uhr ab.',

    // Position names for the ?pos= picker (were raw tl/tc/… codes before).
    posTL: 'oben links',
    posTC: 'oben mittig',
    posTR: 'oben rechts',
    posBL: 'unten links',
    posBC: 'unten mittig',
    posBR: 'unten rechts',

    // Tooltips (native title, some doubled as aria-label). Operator language, consequence
    // first on anything destructive. Sourced here so every language ships them (SPEC 1.1).
    tipLang: 'Sprache der Admin-Oberfläche wechseln — Overlays steuern ihre Sprache über ?lang= in der URL.',
    tipWin: 'Zählt einen Sieg für das aktuelle Spiel — bei B2B geht es erst nach der nötigen Serie weiter.',
    tipLoss: 'Zählt eine Niederlage — die Serie fällt auf 0.',
    tipUndo: 'Gedrückt halten: nimmt den letzten Schritt zurück. Ein geplanter Stopp nach diesem Spiel bleibt bestehen.',
    tipSkip: 'Überspringt das aktuelle Spiel ohne Niederlage — das nächste startet sofort.',
    tipSessionBtn: 'Startet die im Planer gewählte Session bzw. setzt die laufende fort.',
    tipResume: 'Lädt die laufende Session frisch aus der Datenbank — nichts geht verloren; nur nötig, wenn die Anzeige falsch aussieht.',
    tipSessPick: 'Wählt die Session, auf die Starten, Beenden, Löschen und Loop wirken.',
    tipStart: 'Startet die gewählte Entwurf-Session — sie geht sofort live aufs Overlay.',
    tipEnd: 'Beendet die laufende Session sofort — das aktuelle Spiel zählt als abgebrochen. Zweimal tippen zum Bestätigen.',
    tipDelSession: 'Löscht die Session endgültig, samt Verlauf und Recap. Zweimal tippen; eine laufende Session erst beenden.',
    tipSessTitle: 'Titel der neuen Session (max. 80 Zeichen) — erscheint als Überschrift im Overlay.',
    tipLoopNew: 'Neue Session wiederholt die Spieleliste endlos, bis manuell gestoppt wird.',
    tipCreateSession: 'Legt die Session als Entwurf an — gestartet wird sie separat.',
    tipLoopEdit: 'Gilt für die ausgewählte Session, auch mitten im Lauf: aus = die Session endet nach der letzten Position der Runde.',
    tipModeChip: 'Modus dieses Eintrags umschalten: Einzel = 1 Sieg, B2B = Siegesserie nötig.',
    tipRemoveEntry: 'Aus der Session entfernen — zweimal tippen; bereits gespielte Einträge lassen sich nicht entfernen.',
    tipAddGame: 'Hängt das gewählte Spiel ans Ende der Liste an — Position danach per Ziehen oder Pfeilen ändern.',
    tipStopAfter: 'Beendet die Session, sobald das laufende Spiel vorbei ist. Ausschalten nimmt den Stopp zurück — Rückgängig tut das nicht.',
    tipStopNow: 'Beendet die Session sofort — das laufende Spiel zählt als abgebrochen. Zweimal tippen zum Bestätigen.',
    tipAddToggle: 'Spiel zur Bibliothek hinzufügen (IGDB-Suche oder manuell)',
    tipLibMode: 'Standard-Modus umschalten (Einzel ↔ B2B) — gilt für künftige Session-Einträge, bestehende behalten ihren Modus.',
    tipLibDel: 'Spiel endgültig aus der Bibliothek löschen — zweimal tippen; in Sessions verwendete Spiele sind geschützt.',
    tipNewMode: 'Gilt für IGDB-Treffer und das manuelle Formular: Einzel = 1 Sieg, B2B = 2 Siege in Folge.',
    tipIgdbQ: 'Sucht während des Tippens — einen Treffer anklicken, um das Spiel samt Cover anzulegen.',
    tipIgdbTile: 'Anklicken: legt dieses Spiel in der Bibliothek an (Cover wird übernommen).',
    tipCoverFile: 'JPEG, PNG oder WebP, max. 2 MB.',
    tipCopyUrl: 'Kopiert die URL in die Zwischenablage — Overlay und Recap inklusive der aktuellen Vorschau-Einstellungen.',
    tipCopyDeck: 'Fertige URL für diese Stream-Deck-Taste kopieren (Website-Aktion, Hintergrund-Anfrage aktivieren).',
    tipRotOverlay: 'Alte Overlay-, Recap- und Stream-Zeit-URLs werden sofort ungültig — jede OBS-Quelle braucht die neue URL. Zweimal tippen.',
    tipRotControl: 'Alle Stream-Deck-URLs werden sofort ungültig und müssen neu belegt werden. Zweimal tippen.',
    tipScale: 'Overlay-Größe als ?scale=-Parameter — ändert Vorschau und Kopier-URLs, nicht das laufende OBS-Overlay.',
    tipOpacity: 'Overlay-Deckkraft als ?opacity=-Parameter — wirkt auf Vorschau und Kopier-URLs, nicht auf das laufende OBS-Overlay.',
    tipAccent: 'Akzentfarbe des Overlays (?accent=) — gilt erst, wenn OBS die neu kopierte URL lädt.',
    tipPos: 'Position des Overlays auf dem Stream-Bild.',
    tipGradOn: 'Färbt die Overlay-Kopfzeile mit einem Verlauf aus den drei Farben darunter (?grad=); aus = Parameter entfällt.',

    errors: {
      no_live_session: 'Keine laufende Session.',
      session_ended: 'Diese Session ist bereits beendet.',
      empty_session: 'Die Session hat noch keine Spiele.',
      already_live: 'Es läuft bereits eine andere Session.',
      not_draft: 'Session ist kein Entwurf mehr.',
      session_live: 'Session läuft noch — erst beenden.',
      nothing_to_undo: 'Nichts zum Rückgängigmachen',
      current_game_last: 'Das laufende Spiel kann nicht ans Ende verschoben werden.',
      igdb_unavailable: 'IGDB nicht erreichbar.',
      igdb_rate_limited: 'IGDB ist überlastet — kurz warten.',
      igdb_id_exists: 'Dieses Spiel ist bereits in der Bibliothek.',
      in_use: 'Wird noch verwendet.',
      already_played: 'Bereits gespielt — kann nicht entfernt werden',
      cover_fetch_failed: 'Spiel angelegt, aber Cover konnte nicht geladen werden.',
      too_large: 'Datei zu groß (max. 2 MB).',
      timeout: 'Zeitüberschreitung — bitte erneut versuchen.',
      bad_body: 'Unerwartete Antwort vom Server.',
      unavailable: 'Nicht erreichbar — bitte erneut versuchen.',
    },
  },

  // the subathon clock overlay (public/timer.js). Natural case: timer.css uppercases #statetag.
  timer: {
    // German shows the SERVER-formatted Europe/Berlin label (one DST-tested formatter in the
    // whole project); the epoch is ignored. English formats the epoch client-side instead.
    endAt: (label, _epochMs) => `Ende: ${label}`,
    endUnknown: 'Ende: —',

    paused: 'Pausiert',
    pausedAuto: 'Offline',   // the Twitch auto-pause latch, distinct from a manual pause (§5)
    capped: 'Maximum',
    ended: 'Beendet',
    idle: 'Bereit',

    anon: 'Anonym',
    amount: (cents) => `+${eur(cents)}`,
    goal: (cur, goal) => `${eur(cur)} von ${eur(goal)}`,
  },

  // the clock's own admin page (/admin/timer/). Flat strings with {var} placeholders.
  TIMER_ADMIN: {
    title: 'Stream-Zeit',
    navRun: 'Win-Challenge',
    navTimer: 'Stream-Zeit',
    backToRun: '← Win-Challenge',

    secRun: 'Lauf',
    secConfig: 'Einstellungen',
    secCampaigns: 'Kampagnen',
    secDonations: 'Spenden',
    secLedger: 'Korrekturen',

    noRun: 'Kein Lauf aktiv. Leg einen an — danach: Einstellungen prüfen, Kampagne hinzufügen, Uhr starten. Die Overlay-URL der Uhr gibt es auf der Win-Challenge-Seite unter Overlay-URLs.',
    pillIdle: 'Bereit',
    pillEnded: 'Beendet',
    configWaits: 'Erscheint, sobald ein Lauf angelegt ist — Grundzeit, Rate (€/h), Maximum und Twitch-Login werden hier eingestellt.',
    campFirstRun: 'Noch keine Kampagne verknüpft. GoFundMe-Slug oder komplette URL einfügen — erst dann werden Spenden abgerufen und Stunden gutgeschrieben.',
    newRunTitle: 'Neuer Lauf',
    create: 'Anlegen',
    start: 'Uhr starten',
    pause: 'Pausieren',
    resume: 'Weiter',
    end: 'Lauf beenden',
    plusHour: '+1 Stunde',
    pollNow: 'Jetzt abfragen',
    deleteRun: 'Lauf löschen',
    confirmDeleteRun: 'Diesen Lauf endgültig löschen? Der Zeitverlauf und die Korrekturen gehen verloren; Kampagnen und Spenden bleiben erhalten.',
    resetRun: 'Zurücksetzen',
    confirmResetRun: 'Uhr zurücksetzen? Zeitverlauf und Korrekturen werden gelöscht; Einstellungen, Kampagnen und Spenden bleiben. Der Lauf wird wieder zum Entwurf.',
    save: 'Speichern',
    remove: 'Entfernen',
    undo: 'Rückgängig',

    // Config field labels. Hours and euros in the UI; the wire and the database are integer
    // milliseconds and integer cents, converted at the form boundary only.
    fTitle: 'Titel',
    fBase: 'Grundzeit (Stunden)',
    fRate: 'Rate (€ pro Stunde)',
    fCap: 'Maximum (Stunden)',
    fManual: 'Manueller Abzug (€)',
    fPoll: 'Abfrage-Intervall (Sekunden)',
    fAutoPause: 'Auto-Pause wenn Stream offline',
    fAutoAfter: 'Erst nach N Abfragen offline',
    fTwitch: 'Twitch-Login',

    campaignSlug: 'Kampagnen-Slug (aus gofundme.com/f/…)',
    slugPlaceholder: 'meine-kampagne-…',
    add: 'Hinzufügen',

    colDonor: 'Spender',
    colAmount: 'Betrag',
    colTime: 'Zeit',
    colCounts: 'Zählt für Zeit',
    noDonations: 'Noch keine Spenden abgerufen. Sie erscheinen automatisch, sobald eine Kampagne verknüpft ist — oder sofort über »Jetzt abfragen« im Lauf-Abschnitt.',

    ledgerNote: 'Notiz',
    ledgerAmount: 'Betrag (€, optional)',
    ledgerTime: 'Zeit (Minuten, optional)',
    noLedger: 'Keine Korrekturen.',

    // §3.4: the loud banner. Anything but a healthy poll means "operate this by hand".
    srcLive: 'Datenquelle: GoFundMe',
    srcManual: 'Datenquelle: manuell — die Uhr läuft weiter, Beträge bitte von Hand prüfen',
    heldBack: 'Eine Abfrage meldete WENIGER als zuvor. Der alte Wert bleibt stehen — bitte prüfen.',
    mismatch: 'Summe der Spenden weicht um {delta} von der Gesamtsumme ab.',

    statRemaining: 'Verbleibend',
    statEarned: 'Verdient',
    statConsumed: 'Verbraucht',
    statPaused: 'Pausiert',
    statPool: 'Eingegangen',
    statEligible: 'Anrechenbar',
    saved: 'Gespeichert.',
    failed: 'Fehlgeschlagen.',

    // The one run-ending action without a two-tap gets a native confirm instead.
    confirmEndRun: 'Lauf endgültig beenden? Die Uhr stoppt; weiter geht es nur über Zurücksetzen (zurück auf Entwurf).',

    // Accessible names for per-row controls that would otherwise be unnamed.
    campRemoveName: 'Kampagne {slug} entfernen',
    donCountsName: '{name}, {amount} — zählt für Zeit',

    // Tooltips — same rules as ADMIN.tip* above.
    tipLang: 'Sprache der Admin-Oberfläche wechseln — Overlays steuern ihre Sprache über ?lang= in der URL.',
    tipPause: 'Hält die Uhr an bzw. lässt sie weiterlaufen — pausierte Zeit verbraucht kein Guthaben.',
    tipPlusHour: 'Schreibt sofort +1 Stunde als Korrektur ins Protokoll — rückgängig machbar unter Korrekturen.',
    tipCreateRun: 'Legt den Lauf als Entwurf an — Startwerte: 12 h Grundzeit, 10 € pro Stunde, 72 h Maximum; alles unten änderbar.',
    tipStartRun: 'Startet die Uhr mit der Grundzeit — ab jetzt kaufen Spenden Zeit dazu und GoFundMe wird regelmäßig abgefragt.',
    tipEndRun: 'Beendet den Lauf endgültig — die Uhr stoppt; weiter geht es nur über Zurücksetzen.',
    tipPollNow: 'Fragt GoFundMe sofort ab, statt aufs Intervall zu warten.',
    tipResetRun: 'Setzt den Lauf auf Entwurf zurück: Zeitverlauf und Korrekturen werden gelöscht; Einstellungen, Kampagnen und Spenden bleiben.',
    tipDeleteRun: 'Löscht den Lauf endgültig samt Zeitverlauf und Korrekturen; Kampagnen und Spenden bleiben erhalten.',
    tipFBase: 'Startguthaben der Uhr in Stunden — Dezimalwerte erlaubt (Punkt als Trennzeichen, z. B. 12.5).',
    tipFRate: 'Wie viele Euro Spenden eine Stunde zusätzliche Zeit kaufen.',
    tipFCap: 'Obergrenze der Gesamtzeit — darüber hinaus verlängern Spenden die Uhr nicht mehr.',
    tipFManual: 'Betrag, der pauschal von der anrechenbaren Spendensumme abgezogen wird — zusätzlich zu einzeln ausgeschlossenen Spenden.',
    tipFPoll: 'Wie oft GoFundMe abgefragt wird (mindestens 5 Sekunden).',
    tipFAfter: 'Die Auto-Pause greift erst, wenn der Stream so viele Abfragen in Folge offline war — verhindert Pausen bei kurzen Aussetzern.',
    tipFTwitch: 'Kanalname wie in der Twitch-URL (ohne @) — Grundlage für die Offline-Erkennung der Auto-Pause.',
    tipSave: 'Übernimmt alle Einstellungen sofort — auch während die Uhr läuft.',
    tipCampRemove: 'Entfernt die Kampagne aus dem Lauf — ihre Spenden bleiben gespeichert und kehren beim erneuten Hinzufügen zurück.',
    tipSlug: 'Die komplette GoFundMe-URL einfach einfügen — der Slug wird automatisch herausgelöst.',
    tipDonSwitch: 'Aus = diese Spende kauft keine Zeit; der Betrag bleibt trotzdem in der Gesamtsumme sichtbar.',
    tipAdjUndo: 'Nimmt diese Korrektur zurück — die gebuchte Zeit bzw. der Betrag wird sofort von der Uhr abgezogen.',
    tipAdjEur: 'Positiv = Betrag gutschreiben, negativ = abziehen; wirkt sofort auf die anrechenbare Summe.',
    tipAdjMin: 'Positiv = Zeit gutschreiben, negativ = abziehen (in Minuten); wirkt sofort auf die Uhr.',

    secSound: 'Spendensound',
    soundNote: 'Wird auf der Stream-Zeit-Uhr abgespielt, sobald eine neue Spende erkannt wird. Lautstärke im Overlay per ?vol= (0 bis 0.8, Standard 0.5).',
    soundFile: 'Audiodatei (max. 4 MB)',
    soundUpload: 'Hochladen',
    soundTest: 'Anhören',
    soundSim: 'Spende in OBS simulieren',
    soundDelete: 'Löschen',
    soundPick: 'Zuerst eine Datei wählen.',
    soundSaved: 'Gespeichert. Das Overlay lädt den Sound beim nächsten Neuladen der OBS-Quelle.',
    soundDeleted: 'Gelöscht — es wird kein Sound mehr abgespielt.',
    soundTooBig: 'Datei zu groß (max. 4 MB).',
    simSent: 'Gesendet — schau in OBS.',
    tipSoundTest: 'Spielt den hochgeladenen Sound hier im Browser ab.',
    tipSoundSim: 'Zeigt Spenden-Toast, Sound und Zeit-Sprung kurz auf der Uhr in OBS — ohne etwas zu speichern.',
  },
};

// =================================================================================================
// ENGLISH — every key above, translated. Same structure, same function arities, same {var}
// placeholders. Streaming register: losses/wins/attempts/streak/skipped/abandoned.
// =================================================================================================

const EN = {
  STRINGS: {
    common: {
      losses: (n) => plural(n, 'loss', 'losses'),
      attempts: (n) => plural(n, 'attempt', 'attempts'),
    },

    recap: {
      untitled: 'Untitled',
      inProgressSuffix: ' · still running',

      hero: (won, played) => `${fmtNumber(won)} of ${fmtNumber(played)} won`,

      kpi: {
        played: 'Played',
        won: 'Won',
        lost: 'Abandoned',
        skipped: 'Skipped',
        rounds: 'Rounds',
        wins: 'Wins',
      },

      legend: { wins: 'Wins', losses: 'Losses' },

      table: {
        title: 'Time & losses per game',
        lossesCol: 'Losses',
        durationCol: 'Duration',
        max: (v) => `max ${v}`,
        empty: 'No games in this session.',
      },

      outcome: {
        won: 'won',
        skipped: 'skipped',
        abandoned: 'abandoned',
        incomplete: 'unfinished',
      },

      roundStrip: {
        title: 'Round history',
        longest: 'longest round',
        truncatedSuffix: (n) => ` · last ${fmtNumber(n)} rounds`,
        empty: 'No attempts recorded.',
      },

      // "Lap", never "round": the round strip on the same page is about single win/loss rounds.
      perLap: {
        title: 'Per lap',
        lapLabel: (lap) => `Lap ${fmtNumber(lap)}`,
      },

      spotlight: {
        worst: 'Toughest game',
        fastest: 'Fastest win',
        noLosses: 'No losses — a perfect run so far.',
        noWins: 'No wins in this session yet.',
        overLaps: (n) => `across ${fmtNumber(n)} laps`,
      },

      errors: {
        noSession: 'No session found.',
        loadFailed: 'Could not load the recap.',
      },
    },
  },

  overlay: {
    panelTitle: (sessionTitle) => (sessionTitle ? sessionTitle.toUpperCase() : 'WIN CHALLENGE'),

    wonWord: 'CLEARED',
    endedWord: 'FINISHED',

    endedLine(sessionTitle, gamesWon, gamesPlayed, losses, durationMs) {
      const parts = [`${fmtNumber(gamesWon)}/${fmtNumber(gamesPlayed)} won`,
                     plural(losses, 'loss', 'losses')];
      if (durationMs != null) parts.push(fmtHours(durationMs));
      return parts.join(' · ');
    },
  },

  ADMIN: {
    newGameMode: 'Mode for new games',
    navRun: 'Win challenge',
    navTimer: 'Stream time',
    win: 'Win',
    loss: 'Loss',
    skip: 'Skip',
    undo: 'Undo',
    undoHold: 'Hold to undo',
    lossesLabel: 'Losses',
    streakLabel: 'Streak',
    attemptsLabel: 'Attempts',
    live: 'Live',
    connecting: 'Connecting…',
    ended: 'Ended',
    noSession: 'No session',
    startSession: 'Start session',
    resumeSession: 'Resume session',
    pickSession: 'Pick a session first.',
    metaGame: 'Game {n}/{m}',
    metaLap: 'Lap {n}',
    metaTotals: '{won} of {played} won',
    modeSingle: 'Single',
    modeB2b: 'B2B',
    errorGeneric: 'Error',
    working: 'Working…',

    confirmAgain: 'Sure? Tap again',

    resumeFound: 'Live session found — {title}, game {n}/{m}, lap {lap}',
    resumed: 'Session restored.',

    secBuilder: 'Session builder',
    sessionPick: 'Edit session',
    newSession: 'New session',
    loopLabel: 'Loop',
    create: 'Create',
    titleRequired: 'Title required.',
    sessionCreated: 'Session created.',
    loopEditLabel: 'Loop — repeat the session forever',
    noGamesYet: 'No games in this session yet — add one below.',
    insertNote: 'Games inserted before the current one only play on the next lap',
    addToSession: 'Pick a game',
    addGame: 'Add game',
    dragHandle: 'Drag to reorder',
    running: 'Running',
    moveUp: 'Move up',
    moveDown: 'Move down',
    removeEntry: 'Remove',
    draft: 'Draft',
    endSession: 'End session',
    deleteSession: 'Delete session',
    sessionDeleted: 'Session deleted.',

    secLoop: 'Loop control',
    stopAfterCurrent: 'Stop after this game',
    armed: 'Armed',
    armedSub: 'Stops after this game',
    stopAfterHint: 'Ends the session after the current game.',
    unarmed: 'The stop was cancelled.',
    stopNow: 'Stop now',
    sessionEnded: 'Session ended.',

    secLibrary: 'Game library',
    addLibraryGame: 'Add a game to the library',
    igdbSearch: 'IGDB search',
    searching: 'Searching…',
    igdbNoResults: 'No matches.',
    igdbFallback: '— add it manually.',
    manualTitle: 'Add manually',
    manualName: 'Name',
    modeLabel: 'Mode',
    manualCover: 'Cover (optional)',
    flipMode: 'Toggle mode',
    deleteGame: 'Delete game',
    nameRequired: 'Name required.',
    coverTooLarge: 'Cover too large (max 2 MB).',
    gameAdded: 'Game added.',
    gameAddedNoCover: 'Game added, but the cover upload failed:',

    secUrls: 'Overlay URLs',
    urlOverlay: 'Overlay',
    urlRecap: 'Recap',
    urlTimer: 'Stream time',
    urlControl: 'Control',
    copy: 'Copy',
    copied: 'Copied',
    copyFailed: 'Copy failed',
    rotateWarn: 'OBS needs the new URL',
    rotateOverlay: 'Rotate overlay URL',
    rotateControl: 'Rotate control URL',
    rotated: 'Rotated.',
    streamdeckTitle: 'Stream Deck',
    previewTitle: 'Live preview',
    pScale: 'Scale',
    pOpacity: 'Opacity',
    pAccent: 'Accent color',
    pPos: 'Position',
    pGradOn: 'Header gradient',
    pGradA: 'Gradient 1',
    pGradB: 'Gradient 2',
    pGradC: 'Gradient 3',

    secHistory: 'History',
    histGames: '{n} games',
    histEmpty: 'No history yet. Ended sessions appear here with a recap and JSON/CSV export.',
    exportJson: 'Export JSON',
    exportCsv: 'Export CSV',

    firstRunNoSessions: 'First add games to the library, then create a session below.',
    firstRunNoGames: 'Add games to the session below, then start it.',
    builderFirstRun: 'No sessions yet. Step 1: add games to the library. Step 2: create a session here. Step 3: add games and start.',
    libEmptyHint: 'The library is empty — add a game there first.',
    libFirstRun: 'The library is empty. Everything starts here: search IGDB via + or add a game manually below. Then build a session in the session builder.',
    urlsIntro: 'Copy the overlay URL into OBS as a browser source — the stream-time URL is the clock.',
    previewIdleNote: 'Without a live session the overlay is invisible — deliberate on stream. Start a session to see the preview.',

    simTitle: 'Simulation',
    simNote: 'Plays the event briefly in OBS (and in the preview above), then snaps back to the real state by itself. Nothing is stored — counters and clock stay untouched. Win/Won/Loss need a live session.',
    simWin: 'Win',
    simWon: 'Game won',
    simLoss: 'Loss',
    simDonation: 'Donation',
    simSent: 'Sent — watch OBS.',
    tipSimWin: 'Shows the win moment (counter + flame) in the overlay for a few seconds.',
    tipSimWon: 'Shows the "won" takeover in the overlay for a few seconds.',
    tipSimLoss: 'Shows the loss moment in the overlay for a few seconds.',
    tipSimDonation: 'Plays the donation toast, sound and time jump briefly on the stream-time clock.',

    posTL: 'top left',
    posTC: 'top center',
    posTR: 'top right',
    posBL: 'bottom left',
    posBC: 'bottom center',
    posBR: 'bottom right',

    tipLang: 'Switch the admin language — overlays pick theirs via ?lang= in the URL.',
    tipWin: 'Counts a win for the current game — in B2B the run only advances once the required streak is reached.',
    tipLoss: 'Counts a loss — the streak resets to 0.',
    tipUndo: 'Press and hold: reverts the last step. A pending stop-after-this-game stays armed.',
    tipSkip: 'Skips the current game without counting a loss — the next one starts immediately.',
    tipSessionBtn: 'Starts the session selected in the builder, or resumes the live one.',
    tipResume: 'Reloads the live session fresh from the database — nothing is lost; only needed when the display looks wrong.',
    tipSessPick: 'Picks the session that Start, End, Delete and Loop act on.',
    tipStart: 'Starts the selected draft session — it goes live on the overlay immediately.',
    tipEnd: 'Ends the live session immediately — the current game counts as abandoned. Tap twice to confirm.',
    tipDelSession: 'Deletes the session permanently, including its history and recap. Tap twice; end a live session first.',
    tipSessTitle: 'Title of the new session (max 80 characters) — shown as the overlay header.',
    tipLoopNew: 'The new session repeats its game list endlessly until stopped manually.',
    tipCreateSession: 'Creates the session as a draft — starting it is a separate step.',
    tipLoopEdit: 'Applies to the selected session, even mid-run: off = the session ends after the last position of the lap.',
    tipModeChip: "Toggle this entry's mode: single = 1 win, B2B = a win streak is required.",
    tipRemoveEntry: 'Remove from the session — tap twice; entries already played cannot be removed.',
    tipAddGame: 'Appends the picked game at the end of the list — reposition it afterwards by dragging or with the arrows.',
    tipStopAfter: 'Ends the session once the current game finishes. Switching it off cancels the stop — Undo does not.',
    tipStopNow: 'Ends the session right now — the running game counts as abandoned. Tap twice to confirm.',
    tipAddToggle: 'Add a game to the library (IGDB search or manual form)',
    tipLibMode: 'Toggle the default mode (single ↔ B2B) — applies to future session entries; existing ones keep their mode.',
    tipLibDel: 'Delete the game from the library permanently — tap twice; games used in a session are protected.',
    tipNewMode: 'Applies to IGDB picks and the manual form alike: single = 1 win, B2B = 2 wins back to back.',
    tipIgdbQ: 'Searches as you type — click a result to create the game with its cover.',
    tipIgdbTile: 'Click to add this game to the library (the cover is ingested).',
    tipCoverFile: 'JPEG, PNG or WebP, max 2 MB.',
    tipCopyUrl: 'Copies the URL to the clipboard — overlay and recap include the current preview settings.',
    tipCopyDeck: 'Copy the ready-made URL for this Stream Deck key (Website action, enable the background-request option).',
    tipRotOverlay: 'The old overlay, recap and stream-time URLs stop working immediately — every OBS source needs the new URL. Tap twice.',
    tipRotControl: 'Every Stream Deck URL stops working immediately and must be re-pasted. Tap twice.',
    tipScale: 'Overlay size as the ?scale= parameter — changes the preview and the copy URLs, not the overlay already running in OBS.',
    tipOpacity: 'Overlay opacity as the ?opacity= parameter — affects the preview and copy URLs, not the live OBS overlay.',
    tipAccent: 'Overlay accent color (?accent=) — takes effect once OBS loads the freshly copied URL.',
    tipPos: "The overlay's position on the stream canvas.",
    tipGradOn: 'Tints the overlay header with a gradient built from the three colors below (?grad=); off drops the parameter.',

    errors: {
      no_live_session: 'No live session.',
      session_ended: 'This session has already ended.',
      empty_session: 'The session has no games yet.',
      already_live: 'Another session is already live.',
      not_draft: 'The session is no longer a draft.',
      session_live: 'The session is still live — end it first.',
      nothing_to_undo: 'Nothing to undo',
      current_game_last: 'The current game cannot be moved to the end.',
      igdb_unavailable: 'IGDB is unreachable.',
      igdb_rate_limited: 'IGDB is overloaded — wait a moment.',
      igdb_id_exists: 'This game is already in the library.',
      in_use: 'Still in use.',
      already_played: 'Already played — cannot be removed',
      cover_fetch_failed: 'Game created, but the cover could not be fetched.',
      too_large: 'File too large (max 2 MB).',
      timeout: 'Timed out — please try again.',
      bad_body: 'Unexpected response from the server.',
      unavailable: 'Unreachable — please try again.',
    },
  },

  timer: {
    // The Berlin-formatted server label is German ("Sa., 10:08"); EN formats the raw epoch in
    // the viewer's own timezone instead — for a non-German stream that is the honest end time.
    endAt: (label, epochMs) => `Ends: ${epochMs != null
      ? new Intl.DateTimeFormat('en-US', { weekday: 'short', hour: '2-digit', minute: '2-digit' }).format(epochMs)
      : label}`,
    endUnknown: 'Ends: —',

    paused: 'Paused',
    pausedAuto: 'Offline',
    capped: 'Maxed',
    ended: 'Ended',
    idle: 'Ready',

    anon: 'Anonymous',
    amount: (cents) => `+${eur(cents)}`,
    goal: (cur, goal) => `${eur(cur)} of ${eur(goal)}`,
  },

  TIMER_ADMIN: {
    title: 'Stream time',
    navRun: 'Win challenge',
    navTimer: 'Stream time',
    backToRun: '← Win challenge',

    secRun: 'Run',
    secConfig: 'Settings',
    secCampaigns: 'Campaigns',
    secDonations: 'Donations',
    secLedger: 'Adjustments',

    noRun: "No active run. Create one — then check the settings, add a campaign, and start the clock. The clock's overlay URL lives on the win-challenge page under Overlay URLs.",
    pillIdle: 'Ready',
    pillEnded: 'Ended',
    configWaits: 'Appears once a run exists — base time, rate (€/h), cap and Twitch login are set here.',
    campFirstRun: 'No campaign linked yet. Paste the GoFundMe slug or the full URL — only then are donations fetched and hours credited.',
    newRunTitle: 'New run',
    create: 'Create',
    start: 'Start the clock',
    pause: 'Pause',
    resume: 'Resume',
    end: 'End run',
    plusHour: '+1 hour',
    pollNow: 'Poll now',
    deleteRun: 'Delete run',
    confirmDeleteRun: 'Delete this run for good? Its time history and adjustments are lost; campaigns and donations are kept.',
    resetRun: 'Reset',
    confirmResetRun: 'Reset the clock? Time history and adjustments are deleted; settings, campaigns and donations are kept. The run becomes a draft again.',
    save: 'Save',
    remove: 'Remove',
    undo: 'Undo',

    fTitle: 'Title',
    fBase: 'Base time (hours)',
    fRate: 'Rate (€ per hour)',
    fCap: 'Cap (hours)',
    fManual: 'Manual deduction (€)',
    fPoll: 'Poll interval (seconds)',
    fAutoPause: 'Auto-pause when the stream is offline',
    fAutoAfter: 'Only after N offline polls',
    fTwitch: 'Twitch login',

    campaignSlug: 'Campaign slug (from gofundme.com/f/…)',
    slugPlaceholder: 'my-campaign-…',
    add: 'Add',

    colDonor: 'Donor',
    colAmount: 'Amount',
    colTime: 'Time',
    colCounts: 'Counts for time',
    noDonations: 'No donations fetched yet. They appear automatically once a campaign is linked — or immediately via "Poll now" in the Run section.',

    ledgerNote: 'Note',
    ledgerAmount: 'Amount (€, optional)',
    ledgerTime: 'Time (minutes, optional)',
    noLedger: 'No adjustments.',

    srcLive: 'Data source: GoFundMe',
    srcManual: 'Data source: manual — the clock keeps running, check the figures by hand',
    heldBack: 'A poll reported LESS than before. The old value stands — please check.',
    mismatch: 'The donation sum differs from the total by {delta}.',

    statRemaining: 'Remaining',
    statEarned: 'Earned',
    statConsumed: 'Used',
    statPaused: 'Paused',
    statPool: 'Received',
    statEligible: 'Counted',
    saved: 'Saved.',
    failed: 'Failed.',

    confirmEndRun: 'End this run for good? The clock stops; the only way onward is Reset (back to draft).',

    campRemoveName: 'Remove campaign {slug}',
    donCountsName: '{name}, {amount} — counts for time',

    tipLang: 'Switch the admin language — overlays pick theirs via ?lang= in the URL.',
    tipPause: 'Pauses or resumes the clock — paused time burns no balance.',
    tipPlusHour: 'Instantly books +1 hour as a ledger correction — undoable in the Adjustments section.',
    tipCreateRun: 'Creates the run as a draft — defaults: 12 h base time, €10 per hour, 72 h cap; everything is editable below.',
    tipStartRun: 'Starts the clock with the base time — from now on donations buy time and GoFundMe is polled regularly.',
    tipEndRun: 'Ends the run for good — the clock stops; the only way onward is Reset.',
    tipPollNow: 'Polls GoFundMe right now instead of waiting for the interval.',
    tipResetRun: 'Resets the run to draft: the time log and adjustments are wiped; settings, campaigns and donations stay.',
    tipDeleteRun: 'Deletes the run permanently including its time log and adjustments; campaigns and donations survive.',
    tipFBase: "The clock's starting balance in hours — decimals allowed (dot as separator, e.g. 12.5).",
    tipFRate: 'How many euros of donations buy one extra hour of time.',
    tipFCap: 'Hard cap on total time — beyond it donations no longer extend the clock.',
    tipFManual: 'Amount subtracted flat from the eligible donation total — on top of individually excluded donations.',
    tipFPoll: 'How often GoFundMe is polled (minimum 5 seconds).',
    tipFAfter: 'Auto-pause only kicks in after the stream has been offline for this many polls in a row — prevents pauses on brief blips.',
    tipFTwitch: "Channel name as in the Twitch URL (no @) — what auto-pause's offline detection checks.",
    tipSave: 'Applies all settings immediately — even while the clock is running.',
    tipCampRemove: 'Removes the campaign from the run — its donations stay stored and return if you re-add it.',
    tipSlug: 'Just paste the full GoFundMe URL — the slug is extracted automatically.',
    tipDonSwitch: 'Off = this donation buys no time; the amount still shows in the grand total.',
    tipAdjUndo: 'Reverses this adjustment — its booked time or amount is removed from the clock immediately.',
    tipAdjEur: 'Positive = credit the amount, negative = deduct it; applies to the eligible total immediately.',
    tipAdjMin: 'Positive = credit time, negative = deduct it (in minutes); hits the clock immediately.',

    secSound: 'Donation sound',
    soundNote: 'Played on the stream-time clock whenever a new donation is detected. Overlay volume via ?vol= (0 to 0.8, default 0.5).',
    soundFile: 'Audio file (max. 4 MB)',
    soundUpload: 'Upload',
    soundTest: 'Listen',
    soundSim: 'Simulate donation in OBS',
    soundDelete: 'Delete',
    soundPick: 'Pick a file first.',
    soundSaved: 'Saved. The overlay picks the sound up the next time the OBS source reloads.',
    soundDeleted: 'Deleted — no sound will play any more.',
    soundTooBig: 'File too large (max. 4 MB).',
    simSent: 'Sent — watch OBS.',
    tipSoundTest: 'Plays the uploaded sound here in the browser.',
    tipSoundSim: 'Briefly shows the donation toast, sound and time jump on the clock in OBS — without storing anything.',
  },
};

// ---------------------------------------------------------------------------------------------
// the pick — one line, everything above stays language-agnostic for its consumers
// ---------------------------------------------------------------------------------------------

const L = LANG === 'de' ? DE : EN;

export const STRINGS = L.STRINGS;
export const overlay = L.overlay;
export const ADMIN = L.ADMIN;
export const timer = L.timer;
export const TIMER_ADMIN = L.TIMER_ADMIN;
