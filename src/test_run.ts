// The SPEC §2.7 assertion list. Every test below is named exactly as the spec names it, so a
// failure points straight at the rule it broke.
//
//   node --experimental-strip-types --test src/test_run.ts
//
// No framework, no fixtures, no mocks (§2.7). The `./run.ts` extension is deliberate: Node's
// type stripping does not remap .js -> .ts, and tsconfig sets allowImportingTsExtensions (§9.3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plan, reduce, nextSessionGame, nextUndoTarget } from './run.ts';
import type { Action, Event, EventType, Mode, NewEvent, SessionGameRow, SessionRow } from './run.ts';

const T0 = 1_760_000_000_000;

// seq counter. Every test resets it to 0 first so a log's seq numbers are its own — test 13
// asserts `lastSeq === 3` literally.
let n = 0;

// The local event builder §2.7 asks for. `undone` stands in for the W2 UPDATE having run.
const ev = (type: EventType, sg: number | null, lap: number, action: string, undone = false): Event => {
  n += 1;
  return {
    seq: n,
    session_id: 1,
    session_game_id: sg,
    lap,
    type,
    action_id: action,
    created_at: T0 + n * 1000,
    undone_at: undone ? T0 + 900_000 : null,
    meta_json: null,
  };
};

// What D1 does to plan()'s output: hand out seq, undone_at NULL.
const commit = (append: readonly NewEvent[]): Event[] =>
  append.map((e) => { n += 1; return { ...e, seq: n, undone_at: null }; });

// What W2 does: UPDATE events SET undone_at=? WHERE action_id=? AND undone_at IS NULL.
const undo = (events: readonly Event[], action: string): Event[] =>
  events.map((e) => (e.action_id === action && e.undone_at === null ? { ...e, undone_at: T0 + 900_000 } : e));

const session = (over: Partial<SessionRow> = {}): SessionRow => ({
  id: 1, title: 'Testlauf', loop: false, stop_after_current: false,
  status: 'live', started_at: T0, ended_at: null, ...over,
});

const sg = (id: number, order_index: number, mode: Mode = 'single'): SessionGameRow => ({
  id, session_id: 1, game_id: 100 + id, order_index, mode, title: `Spiel ${id}`, cover_key: null,
});

const ZERO = { gamesPlayed: 0, gamesWon: 0, gamesSkipped: 0, gamesAbandoned: 0, wins: 0, losses: 0, attempts: 0 };

// 1
test('empty_log_is_idle', () => {
  const st = reduce([], { session: null, sessionGames: [] });
  assert.equal(st.phase, 'idle');
  assert.equal(st.current, null);
  assert.equal(st.displayMode, 'IDLE');
  assert.deepEqual(st.totals, ZERO);
  assert.equal(st.lastSeq, 0);
  assert.deepEqual(st.playlist, []);
});

// 2
test('session_start_opens_first_game', () => {
  n = 0;
  const cfg = { session: session({ status: 'draft' }), sessionGames: [sg(1, 1), sg(2, 2)] };
  const p = plan({ kind: 'start', sessionId: 1 }, [], cfg, T0, 'A1');
  const app: NewEvent[] = p.ok && 'append' in p ? p.append : [];
  assert.deepEqual(app.map((e) => e.type), ['session_start', 'game_start']);
  assert.deepEqual(app.map((e) => e.session_game_id), [null, 1]);
  assert.deepEqual(app.map((e) => e.lap), [1, 1]);
  assert.deepEqual([...new Set(app.map((e) => e.action_id))], ['A1']);

  const st = reduce(commit(app), cfg);
  assert.equal(st.phase, 'live');
  assert.equal(st.current?.sessionGameId, 1);
  assert.equal(st.current?.losses, 0);
  assert.equal(st.current?.wins, 0);
  assert.equal(st.current?.streak, 0);
  assert.equal(st.current?.attempts, 0);
  assert.equal(st.displayMode, 'LOSS_MODE');
  assert.equal(st.totals.gamesPlayed, 1);
});

// 3
test('start_rejects_empty_session', () => {
  const cfg = { session: session({ status: 'draft' }), sessionGames: [] };
  assert.deepEqual(plan({ kind: 'start', sessionId: 1 }, [], cfg, T0, 'A1'), { ok: false, reject: 'empty_session' });
});

// 4
test('single_win_completes_and_advances', () => {
  n = 0;
  const cfg = { session: session(), sessionGames: [sg(1, 1, 'single'), sg(2, 2, 'single')] };
  const base = [ev('session_start', null, 1, 'A1'), ev('game_start', 1, 1, 'A1')];
  const p = plan({ kind: 'win' }, base, cfg, T0 + 5000, 'A2');
  const app: NewEvent[] = p.ok && 'append' in p ? p.append : [];
  assert.deepEqual(app.map((e) => e.type), ['win', 'game_won', 'game_start']);
  assert.deepEqual(app.map((e) => e.session_game_id), [1, 1, 2]);
  assert.deepEqual([...new Set(app.map((e) => e.action_id))], ['A2']);

  const st = reduce([...base, ...commit(app)], cfg);
  assert.equal(st.current?.sessionGameId, 2);
  assert.equal(st.current?.losses, 0);
  assert.equal(st.current?.wins, 0);
  assert.equal(st.current?.streak, 0);
  assert.equal(st.current?.attempts, 0);
  assert.equal(st.totals.gamesWon, 1);
});

// 5
test('single_never_enters_streak_mode', () => {
  n = 0;
  const cfg = { session: session(), sessionGames: [sg(1, 1, 'single'), sg(2, 2, 'single')] };
  const base = [ev('session_start', null, 1, 'A1'), ev('game_start', 1, 1, 'A1')];
  const p = plan({ kind: 'win' }, base, cfg, T0 + 5000, 'A2');
  const log = [...base, ...commit(p.ok && 'append' in p ? p.append : [])];
  for (let i = 0; i <= log.length; i++) {
    assert.notEqual(reduce(log.slice(0, i), cfg).displayMode, 'STREAK_MODE', `prefix ${i}`);
  }
});

// 6
test('b2b_first_win_is_streak_mode', () => {
  n = 0;
  const cfg = { session: session(), sessionGames: [sg(1, 1, 'b2b'), sg(2, 2)] };
  const base = [ev('session_start', null, 1, 'A1'), ev('game_start', 1, 1, 'A1')];
  const p = plan({ kind: 'win' }, base, cfg, T0 + 5000, 'A2');
  const app: NewEvent[] = p.ok && 'append' in p ? p.append : [];
  assert.deepEqual(app.map((e) => e.type), ['win']);

  const st = reduce([...base, ...commit(app)], cfg);
  assert.equal(st.current?.streak, 1);
  assert.equal(st.current?.wins, 1);
  assert.equal(st.current?.losses, 0);
  assert.equal(st.current?.attempts, 1);
  assert.equal(st.displayMode, 'STREAK_MODE');
});

// 7
test('b2b_clean_win', () => {
  n = 0;
  const cfg = { session: session(), sessionGames: [sg(1, 1, 'b2b'), sg(2, 2)] };
  const base = [ev('session_start', null, 1, 'A1'), ev('game_start', 1, 1, 'A1')];
  const first = plan({ kind: 'win' }, base, cfg, T0 + 5000, 'A2');
  const mid = [...base, ...commit(first.ok && 'append' in first ? first.append : [])];
  const second = plan({ kind: 'win' }, mid, cfg, T0 + 9000, 'A3');
  const app: NewEvent[] = second.ok && 'append' in second ? second.append : [];
  assert.deepEqual(app.map((e) => e.type), ['win', 'game_won', 'game_start']);
  assert.deepEqual(app.map((e) => e.session_game_id), [1, 1, 2]);

  const full = [...mid, ...commit(app)];
  const atWon = reduce(full.slice(0, full.length - 1), cfg);   // the game_won prefix
  assert.equal(atWon.current?.wins, 2);
  assert.equal(atWon.current?.losses, 0);
  assert.equal(atWon.current?.attempts, 2);
  assert.equal(atWon.displayMode, 'LOSS_MODE');               // streak === required, §2.4
  assert.equal(reduce(full, cfg).totals.gamesWon, 1);
});

// 8
test('b2b_broken_streak_keeps_losses', () => {
  n = 0;
  const cfg = { session: session(), sessionGames: [sg(1, 1, 'b2b'), sg(2, 2)] };
  const base = [ev('session_start', null, 1, 'A1'), ev('game_start', 1, 1, 'A1')];
  const w = plan({ kind: 'win' }, base, cfg, T0 + 5000, 'A2');
  const mid = [...base, ...commit(w.ok && 'append' in w ? w.append : [])];
  const l = plan({ kind: 'loss' }, mid, cfg, T0 + 9000, 'A3');
  const st = reduce([...mid, ...commit(l.ok && 'append' in l ? l.append : [])], cfg);
  assert.equal(st.current?.streak, 0);
  assert.equal(st.current?.losses, 1);
  assert.equal(st.current?.wins, 1);
  assert.equal(st.current?.attempts, 2);
  assert.equal(st.displayMode, 'LOSS_MODE');
});

// 9
test('b2b_broken_then_won', () => {
  n = 0;
  const cfg = { session: session(), sessionGames: [sg(1, 1, 'b2b'), sg(2, 2)] };
  let log: Event[] = [ev('session_start', null, 1, 'A1'), ev('game_start', 1, 1, 'A1')];
  let last: NewEvent[] = [];
  const actions: Action[] = [{ kind: 'win' }, { kind: 'loss' }, { kind: 'win' }, { kind: 'win' }];
  actions.forEach((a, i) => {
    const p = plan(a, log, cfg, T0 + 5000 * (i + 1), `B${i}`);
    last = p.ok && 'append' in p ? p.append : [];
    log = [...log, ...commit(last)];
  });
  // the 4th event's action is the one that completes the game
  assert.deepEqual(last.map((e) => e.type), ['win', 'game_won', 'game_start']);
  const atWon = reduce(log.slice(0, log.length - 1), cfg);
  assert.equal(atWon.current?.losses, 1);
  assert.equal(atWon.current?.wins, 3);
  assert.equal(atWon.current?.attempts, 4);
  assert.equal(reduce(log, cfg).totals.gamesWon, 1);
});

// 10
test('attempts_equals_losses_plus_wins', () => {
  n = 0;
  const cfg = { session: session({ loop: true }), sessionGames: [sg(1, 1, 'b2b'), sg(2, 2, 'single')] };
  const log = [
    ev('session_start', null, 1, 'A1'), ev('game_start', 1, 1, 'A1'),
    ev('loss', 1, 1, 'A2'), ev('win', 1, 1, 'A3'), ev('loss', 1, 1, 'A4'),
    ev('win', 1, 1, 'A5'), ev('win', 1, 1, 'A6'), ev('game_won', 1, 1, 'A6'),
    ev('game_start', 2, 1, 'A6'), ev('win', 2, 1, 'A7'), ev('game_won', 2, 1, 'A7'),
    ev('game_start', 1, 2, 'A7'),
  ];
  assert.equal(log.length, 12);
  for (let i = 0; i <= log.length; i++) {
    const st = reduce(log.slice(0, i), cfg);
    if (st.current !== null) {
      assert.equal(st.current.attempts, st.current.losses + st.current.wins, `prefix ${i} current`);
    }
    assert.equal(st.totals.attempts, st.totals.losses + st.totals.wins, `prefix ${i} totals`);
  }
});

// 11
test('skip_advances_without_counters', () => {
  n = 0;
  const cfg = { session: session(), sessionGames: [sg(1, 1), sg(2, 2)] };
  let log: Event[] = [ev('session_start', null, 1, 'A1'), ev('game_start', 1, 1, 'A1')];
  const losses: Action[] = [{ kind: 'loss' }, { kind: 'loss' }];
  losses.forEach((a, i) => {
    const p = plan(a, log, cfg, T0 + 1000 * i, `L${i}`);
    log = [...log, ...commit(p.ok && 'append' in p ? p.append : [])];
  });
  const p = plan({ kind: 'skip' }, log, cfg, T0 + 9000, 'A9');
  const app: NewEvent[] = p.ok && 'append' in p ? p.append : [];
  assert.deepEqual(app.map((e) => e.type), ['skip', 'game_start']);
  assert.deepEqual(app.map((e) => e.session_game_id), [1, 2]);
  assert.deepEqual(app.map((e) => e.lap), [1, 1]);

  const st = reduce([...log, ...commit(app)], cfg);
  assert.equal(st.totals.gamesSkipped, 1);
  assert.equal(st.totals.losses, 2);
  assert.equal(st.totals.attempts, 2);
  assert.equal(st.current?.sessionGameId, 2);
  assert.equal(st.current?.losses, 0);
  assert.equal(st.current?.wins, 0);
  assert.equal(st.current?.streak, 0);
  assert.equal(st.current?.attempts, 0);
});

// 12
test('undo_single_row_action', () => {
  n = 0;
  const cfg = { session: session(), sessionGames: [sg(1, 1), sg(2, 2)] };
  const log = [ev('session_start', null, 1, 'A1'), ev('game_start', 1, 1, 'A1'), ev('loss', 1, 1, 'A2')];
  assert.equal(nextUndoTarget(log), 'A2');
  const st = reduce(undo(log, 'A2'), cfg);
  assert.equal(st.current?.losses, 0);
  assert.equal(st.current?.attempts, 0);
  assert.equal(st.displayMode, 'LOSS_MODE');
});

// The §2.5c table, shared by tests 13, 14, 15 and 16.
const boundaryCfg = { session: session(), sessionGames: [sg(1, 1, 'b2b'), sg(2, 2, 'single')] };
const boundaryLog = (): Event[] => {
  n = 0;
  return [
    ev('session_start', null, 1, 'A1'),   // seq 1
    ev('game_start', 1, 1, 'A1'),         // seq 2
    ev('win', 1, 1, 'A2'),                // seq 3
    ev('win', 1, 1, 'A3'),                // seq 4
    ev('game_won', 1, 1, 'A3'),           // seq 5
    ev('game_start', 2, 1, 'A3'),         // seq 6
  ];
};

// 13
test('undo_across_game_boundary', () => {
  const log = boundaryLog();
  const before = reduce(log, boundaryCfg);
  assert.equal(before.current?.sessionGameId, 2);
  assert.equal(before.totals.gamesWon, 1);
  assert.equal(before.totals.gamesPlayed, 2);
  assert.equal(before.totals.wins, 2);

  assert.equal(nextUndoTarget(log), 'A3');
  const st = reduce(undo(log, 'A3'), boundaryCfg);
  assert.equal(st.current?.sessionGameId, 1);
  assert.equal(st.current?.streak, 1);
  assert.equal(st.current?.wins, 1);
  assert.equal(st.current?.losses, 0);
  assert.equal(st.current?.attempts, 1);
  assert.equal(st.lap, 1);
  assert.equal(st.displayMode, 'STREAK_MODE');
  assert.equal(st.totals.gamesWon, 0);
  assert.equal(st.totals.gamesPlayed, 1);
  assert.equal(st.lastSeq, 3);
});

// 14
test('undo_action_group_is_atomic', () => {
  const after = undo(boundaryLog(), 'A3');
  assert.equal(after.length, 6);
  for (const e of after) {
    assert.equal(e.undone_at !== null, e.seq >= 4, `seq ${e.seq}`);
  }
});

// 15
test('undo_twice_reaches_pre_win_state', () => {
  const once = undo(boundaryLog(), 'A3');
  assert.equal(nextUndoTarget(once), 'A2');
  const st = reduce(undo(once, 'A2'), boundaryCfg);
  assert.equal(st.current?.sessionGameId, 1);
  assert.equal(st.current?.streak, 0);
  assert.equal(st.current?.wins, 0);
  assert.equal(st.current?.attempts, 0);
  assert.equal(st.displayMode, 'LOSS_MODE');
});

// 16
test('undo_refuses_session_start', () => {
  const twice = undo(undo(boundaryLog(), 'A3'), 'A2');
  assert.equal(nextUndoTarget(twice), null);
  assert.deepEqual(plan({ kind: 'undo' }, twice, boundaryCfg, T0, 'X'), { ok: false, reject: 'nothing_to_undo' });
});

// 17
test('undo_on_empty_log_is_null', () => {
  assert.equal(nextUndoTarget([]), null);
});

// 18
test('undo_skips_already_undone', () => {
  n = 0;
  const log = [
    ev('session_start', null, 1, 'A1'), ev('game_start', 1, 1, 'A1'),
    ev('loss', 1, 1, 'A2'), ev('loss', 1, 1, 'A3', true),
  ];
  assert.equal(nextUndoTarget(log), 'A2');
});

// 19
test('loop_wrap_increments_lap', () => {
  n = 0;
  const cfg = { session: session({ loop: true }), sessionGames: [sg(1, 1), sg(2, 2)] };
  const base = [ev('session_start', null, 1, 'A1'), ev('game_start', 1, 1, 'A1')];
  const first = plan({ kind: 'win' }, base, cfg, T0 + 5000, 'A2');
  const mid = [...base, ...commit(first.ok && 'append' in first ? first.append : [])];
  const last = plan({ kind: 'win' }, mid, cfg, T0 + 9000, 'A3');
  const app: NewEvent[] = last.ok && 'append' in last ? last.append : [];
  assert.deepEqual(app.map((e) => e.type), ['win', 'game_won', 'game_start']);
  assert.deepEqual(app[2]?.session_game_id, 1);
  assert.equal(app[2]?.lap, 2);

  const st = reduce([...mid, ...commit(app)], cfg);
  assert.equal(st.lap, 2);
  assert.equal(st.current?.sessionGameId, 1);
  assert.equal(st.current?.wins, 0);
  assert.equal(st.current?.losses, 0);
  assert.equal(st.current?.attempts, 0);
  assert.equal(st.totals.wins, 2);          // lap 1's win is still counted
  assert.equal(st.totals.gamesWon, 2);
  assert.equal(st.totals.gamesPlayed, 3);
});

// 20
test('no_loop_ends_session', () => {
  n = 0;
  const cfg = { session: session({ loop: false }), sessionGames: [sg(1, 1), sg(2, 2)] };
  const base = [ev('session_start', null, 1, 'A1'), ev('game_start', 2, 1, 'A1')];   // cursor on the last entry
  const p = plan({ kind: 'win' }, base, cfg, T0 + 5000, 'A2');
  const app: NewEvent[] = p.ok && 'append' in p ? p.append : [];
  assert.deepEqual(app.map((e) => e.type), ['win', 'game_won', 'session_end']);
  assert.equal(app[2]?.session_game_id, null);

  const st = reduce([...base, ...commit(app)], cfg);
  assert.equal(st.phase, 'ended');
  assert.equal(st.current, null);
  assert.equal(st.lap, 0);
  assert.equal(st.displayMode, 'ENDED');
  // The ended list keeps every game's final outcome and marks nothing active.
  assert.equal(st.playlist.length, 2);
  assert.equal(st.playlist.some((g) => g.status === 'active'), false);
  assert.equal(st.playlist.find((g) => g.sessionGameId === 2)?.status, 'done');
});

// 21
test('skip_on_last_game_ends_session', () => {
  n = 0;
  const cfg = { session: session({ loop: false }), sessionGames: [sg(1, 1), sg(2, 2)] };
  const base = [ev('session_start', null, 1, 'A1'), ev('game_start', 2, 1, 'A1')];
  const p = plan({ kind: 'skip' }, base, cfg, T0 + 5000, 'A2');
  const app: NewEvent[] = p.ok && 'append' in p ? p.append : [];
  assert.deepEqual(app.map((e) => e.type), ['skip', 'session_end']);

  const st = reduce([...base, ...commit(app)], cfg);
  assert.equal(st.phase, 'ended');
  assert.equal(st.totals.gamesSkipped, 1);
});

// 22
test('stop_now_abandons_current', () => {
  n = 0;
  const cfg = { session: session(), sessionGames: [sg(1, 1), sg(2, 2)] };
  const base = [ev('session_start', null, 1, 'A1'), ev('game_start', 1, 1, 'A1'), ev('loss', 1, 1, 'A2')];
  const p = plan({ kind: 'stop_now' }, base, cfg, T0 + 5000, 'A3');
  const app: NewEvent[] = p.ok && 'append' in p ? p.append : [];
  assert.deepEqual(app.map((e) => e.type), ['game_abandoned', 'session_end']);

  const st = reduce([...base, ...commit(app)], cfg);
  assert.equal(st.phase, 'ended');
  assert.equal(st.totals.gamesAbandoned, 1);
  assert.equal(st.totals.losses, 1);
});

// 23 / 24 share the setup: the flag is armed and a NON-last game completes.
const stopAfterCfg = { session: session({ stop_after_current: true }), sessionGames: [sg(1, 1), sg(2, 2)] };

// 23
test('stop_after_current_ends_instead_of_advancing', () => {
  n = 0;
  const base = [ev('session_start', null, 1, 'A1'), ev('game_start', 1, 1, 'A1')];
  const p = plan({ kind: 'win' }, base, stopAfterCfg, T0 + 5000, 'A2');
  const app: NewEvent[] = p.ok && 'append' in p ? p.append : [];
  assert.deepEqual(app.map((e) => e.type), ['win', 'game_won', 'session_end']);
  assert.equal(reduce([...base, ...commit(app)], stopAfterCfg).phase, 'ended');
});

// 24
test('stop_after_current_survives_undo', () => {
  n = 0;
  const base = [ev('session_start', null, 1, 'A1'), ev('game_start', 1, 1, 'A1')];
  const p = plan({ kind: 'win' }, base, stopAfterCfg, T0 + 5000, 'A2');
  const log = [...base, ...commit(p.ok && 'append' in p ? p.append : [])];
  assert.equal(nextUndoTarget(log), 'A2');

  const st = reduce(undo(log, 'A2'), stopAfterCfg);
  assert.equal(st.phase, 'live');
  assert.equal(st.current?.sessionGameId, 1);
  assert.equal(st.stopAfterCurrent, true);
  assert.equal(stopAfterCfg.session.stop_after_current, true);   // the reducer never writes it
});

// 25
test('advance_skips_game_inserted_before_cursor', () => {
  const games = [sg(1, 1), sg(9, 2), sg(3, 3), sg(4, 4)];   // 9 inserted at order 2, cursor on order 3
  assert.equal(nextSessionGame(games, 3)?.id, 4);
});

// 26
test('advance_takes_game_inserted_after_cursor', () => {
  const games = [sg(1, 1), sg(3, 3), sg(9, 4), sg(4, 5)];   // 9 inserted at order 4, old next pushed to 5
  assert.equal(nextSessionGame(games, 3)?.id, 9);
});

// 27
test('reorder_does_not_move_cursor', () => {
  n = 0;
  const cfg = { session: session({ loop: true }), sessionGames: [sg(1, 1, 'b2b'), sg(2, 2), sg(3, 3)] };
  const log = [
    ev('session_start', null, 1, 'A1'), ev('game_start', 1, 1, 'A1'),
    ev('loss', 1, 1, 'A2'), ev('win', 1, 1, 'A3'), ev('win', 1, 1, 'A4'),
    ev('game_won', 1, 1, 'A4'), ev('game_start', 2, 1, 'A4'), ev('loss', 2, 1, 'A5'),
  ];
  const a = reduce(log, cfg);
  const shuffled = [sg(3, 1), sg(2, 2), sg(1, 3, 'b2b')];   // fully reversed order_index
  const b = reduce(log, { ...cfg, sessionGames: shuffled });
  assert.equal(a.current?.sessionGameId, b.current?.sessionGameId);
  assert.equal(a.lap, b.lap);
  assert.equal(a.current?.losses, b.current?.losses);
  assert.equal(a.current?.wins, b.current?.wins);
  assert.equal(a.current?.streak, b.current?.streak);
  assert.equal(a.current?.attempts, b.current?.attempts);
  assert.equal(a.current?.startedAt, b.current?.startedAt);
  assert.deepEqual(a.totals, b.totals);
  assert.equal(a.lastSeq, b.lastSeq);
});

// 28
test('revisit_same_lap_resets_counters', () => {
  n = 0;
  const cfg = { session: session(), sessionGames: [sg(1, 1), sg(2, 2)] };
  // session_start is prepended: game_start's fold precondition is phase === 'live' (§2.4).
  const log = [
    ev('session_start', null, 1, 'A0'), ev('game_start', 1, 1, 'A1'), ev('loss', 1, 1, 'A2'),
    ev('skip', 1, 1, 'A3'), ev('game_start', 2, 1, 'A3'), ev('skip', 2, 1, 'A4'),
    ev('game_start', 1, 1, 'A4'),
  ];
  const st = reduce(log, cfg);
  assert.equal(st.current?.sessionGameId, 1);
  assert.equal(st.current?.losses, 0);
  assert.equal(st.current?.attempts, 0);
  assert.equal(st.totals.losses, 1);
  assert.equal(st.totals.gamesSkipped, 2);
  assert.equal(st.totals.gamesPlayed, 3);
});

// 29
test('mode_override_wins', () => {
  n = 0;
  // R1 resolves COALESCE(session_games.mode, games.default_mode); 'b2b' here is the override
  // winning over the library's default_mode 'single'.
  const cfg = { session: session(), sessionGames: [sg(1, 1, 'b2b'), sg(2, 2)] };
  const base = [ev('session_start', null, 1, 'A1'), ev('game_start', 1, 1, 'A1')];
  assert.equal(reduce(base, cfg).current?.required, 2);

  const p = plan({ kind: 'win' }, base, cfg, T0 + 5000, 'A2');
  const app: NewEvent[] = p.ok && 'append' in p ? p.append : [];
  assert.deepEqual(app.map((e) => e.type), ['win']);
  assert.equal(reduce([...base, ...commit(app)], cfg).displayMode, 'STREAK_MODE');
});

// 30
test('unknown_session_game_id_does_not_throw', () => {
  n = 0;
  const cfg = { session: session(), sessionGames: [sg(1, 1), sg(2, 2)] };
  const log = [ev('session_start', null, 1, 'A1'), ev('game_start', 77, 1, 'A1')];
  const st = reduce(log, cfg);
  assert.equal(st.current?.title, '???');
  assert.equal(st.current?.mode, 'single');
  assert.equal(st.current?.required, 1);
  assert.equal(st.displayMode, 'LOSS_MODE');
});

// 31
test('unknown_event_type_throws', () => {
  n = 0;
  const bad = { ...ev('loss', 1, 1, 'A1'), type: 'nonsense' as unknown as EventType };
  assert.throws(() => reduce([bad], { session: session(), sessionGames: [sg(1, 1)] }));
});

// 32
test('reduce_is_pure', () => {
  n = 0;
  const events = Object.freeze([
    ev('session_start', null, 1, 'A1'), ev('game_start', 1, 1, 'A1'),
    ev('win', 1, 1, 'A2'), ev('loss', 1, 1, 'A3'),
  ].map((e) => Object.freeze(e)));
  const cfg = Object.freeze({
    session: Object.freeze(session()),
    sessionGames: Object.freeze([Object.freeze(sg(1, 1, 'b2b')), Object.freeze(sg(2, 2))]),
  });
  const identities = [...events];

  const a = reduce(events, cfg);
  const b = reduce(events, cfg);
  assert.deepEqual(a, b);
  assert.equal(events.length, identities.length);
  identities.forEach((e, i) => assert.equal(events[i], e));
  assert.equal(events[0]?.type, 'session_start');   // no in-place sort happened
});

// 33
test('reduce_ignores_input_order', () => {
  n = 0;
  const cfg = { session: session(), sessionGames: [sg(1, 1, 'b2b'), sg(2, 2)] };
  const log = [
    ev('session_start', null, 1, 'A1'), ev('game_start', 1, 1, 'A1'),
    ev('win', 1, 1, 'A2'), ev('loss', 1, 1, 'A3'), ev('win', 1, 1, 'A4'),
  ];
  const shuffled = [log[3], log[0], log[4], log[2], log[1]].filter((e): e is Event => e !== undefined);
  assert.deepEqual(reduce(shuffled, cfg), reduce(log, cfg));
});

// 34
test('playlist_covers_the_lap_and_marks_one_active', () => {
  n = 0;
  const one = { session: session({ loop: true }), sessionGames: [sg(1, 1)] };
  const base = [ev('session_start', null, 1, 'A1'), ev('game_start', 1, 1, 'A1')];
  const p1 = reduce(base, one).playlist;
  assert.equal(p1.length, 1);
  assert.equal(p1[0]?.status, 'active');
  assert.equal(p1[0]?.required, 1);

  const two = { session: session({ loop: true }), sessionGames: [sg(1, 1), sg(2, 2)] };
  const p2 = reduce(base, two).playlist;
  assert.equal(p2.length, 2);                                        // the WHOLE lap, not a window
  assert.equal(p2.filter((g) => g.status === 'active').length, 1);   // exactly one active row
  assert.equal(p2[0]?.status, 'active');
  assert.equal(p2[1]?.status, 'pending');
  assert.equal(p2[1]?.sessionGameId, 2);
});

// 35 — the counter the overlay actually renders: 0/2 -> 1/2 -> loss -> 0/2 -> win,win -> done.
test('playlist_b2b_counter_progression', () => {
  n = 0;
  const cfg = { session: session({ loop: false }), sessionGames: [sg(1, 1, 'b2b'), sg(2, 2)] };
  const log = [ev('session_start', null, 1, 'A1'), ev('game_start', 1, 1, 'A1')];
  const row = (st: ReturnType<typeof reduce>) => st.playlist[0];

  assert.equal(row(reduce(log, cfg))?.streak, 0);                    // 0/2
  assert.equal(row(reduce(log, cfg))?.required, 2);

  log.push(ev('win', 1, 1, 'A2'));
  assert.equal(row(reduce(log, cfg))?.streak, 1);                    // 1/2 — the flame row
  assert.equal(reduce(log, cfg).displayMode, 'STREAK_MODE');

  log.push(ev('loss', 1, 1, 'A3'));
  assert.equal(row(reduce(log, cfg))?.streak, 0);                    // back to 0/2
  assert.equal(row(reduce(log, cfg))?.losses, 1);                    // the loss is kept
  assert.equal(reduce(log, cfg).displayMode, 'LOSS_MODE');

  log.push(ev('win', 1, 1, 'A4'), ev('win', 1, 1, 'A5'), ev('game_won', 1, 1, 'A5'));
  const done = reduce(log, cfg).playlist[0];
  assert.equal(done?.streak, 2);                                     // 2/2
  assert.equal(done?.status, 'active');                              // still active on the game_won step
  assert.equal(done?.losses, 1);                                     // losses survive the win

  log.push(ev('game_start', 2, 1, 'A5'));
  const after = reduce(log, cfg).playlist;
  assert.equal(after[0]?.status, 'done');                            // row goes green
  assert.equal(after[0]?.streak, 2);
  assert.equal(after[1]?.status, 'active');                          // next row takes over
});
