import { describe, expect, it } from 'vitest';
import { orderOptions } from '../../../src/core/classifier/order.js';
import type { Question, Seat } from '../../../src/core/classifier/types.js';
import { isRealtime, validateQuestion, type Game } from '../../../src/core/game.js';
import type { DecisionLine } from '../../../src/core/log/schema.js';
import { driveRealtime } from '../../../src/core/sched/drive.js';
import { createRealtimeRunner } from '../../../src/core/sched/realtime.js';
import { FLOOR_MS } from '../../../src/core/sched/shared.js';
import { getGame } from '../../../src/games/index.js';
import { MAX_CHARS } from '../../../src/games/inbox/data-build.js';
import { INBOX_DATA_SHA256, INBOX_MESSAGES, messageText } from '../../../src/games/inbox/data.js';
import { buildSchedule } from '../../../src/games/inbox/engine/schedule.js';
import { soonest } from '../../../src/games/inbox/engine/sim.js';
import type { InboxConfig } from '../../../src/games/inbox/engine/types.js';
import { INBOX_CONFIG, inboxConfigFromLog, inboxGame } from '../../../src/games/inbox/game.js';
import { INBOX_PROMPT_CONFIG } from '../../../src/games/inbox/prompt.js';
import { FAST, runInboxMatch } from '../../../src/games/inbox/tune.js';
import { EMPTY_LANE_VIEW, fitText, secondsToLand } from '../../../src/games/inbox/view.js';
import { createFakeClock } from '../../core/util/fake-clock.js';
import {
  COMMON,
  SimClock,
  baselineMeta,
  fakeDecider,
  memorySink,
} from '../../core/sched/helpers.js';

const g = inboxGame;
const SEED = 20261007;
const SEATS: readonly Seat[] = [0, 1];
const jsonRoundTrip = (v: unknown): unknown => JSON.parse(JSON.stringify(v));

describe('inboxGame: contract', () => {
  it('is registered as "inbox", a graded real-time game at 60 Hz', () => {
    const erased: Game = inboxGame;
    expect(getGame('inbox')).toBe(erased);
    expect(isRealtime(erased)).toBe(true);
    expect(g.id).toBe('inbox');
    expect(g.label).toBe('Inbox Invaders');
    expect(g.version).toBe(1);
    expect(g.cadence).toEqual({ kind: 'realtime', tickRate: 60 });
    expect(g.graded).toBe(true);
    expect(g.answerRetiresKey).toBe(true);
    expect(g.baselines).toEqual(['scripted']);
    expect(g.promptConfig).toBe(INBOX_PROMPT_CONFIG);
    expect(g.defaultConfig).toBe(INBOX_CONFIG);
  });

  it('estimates one decision per message typically and one per floor interval at worst', () => {
    const { typical, worst } = g.estimate.decisionsPerSeat;
    expect(typical).toBe(INBOX_CONFIG.streamLength);
    const maxMs = (g.maxTicks(INBOX_CONFIG) * 1000) / 60;
    expect(worst).toBe(Math.ceil(maxMs / FLOOR_MS));
    expect(worst).toBeGreaterThan(typical);
    expect(g.estimate.inputTokens).toEqual({ jev: 555, openai: 343 });
    expect(g.estimate.fallbackInputTokens).toBe(600);
  });

  it('logs a JSON-safe config that configFromLog turns back into the same config', () => {
    const logged = g.logConfig(INBOX_CONFIG);
    expect(jsonRoundTrip(logged)).toEqual(logged);
    expect(g.configFromLog(logged)).toEqual(INBOX_CONFIG);
    expect(g.configFromLog(jsonRoundTrip(logged) as Record<string, unknown>)).toEqual(INBOX_CONFIG);
    const other: InboxConfig = {
      ...INBOX_CONFIG,
      damage: 3,
      streamLength: 12,
      spawn: { startTicks: 9, endTicks: 2, rampTicks: 50 },
    };
    expect(g.configFromLog(g.logConfig(other))).toEqual(other);
    expect(inboxConfigFromLog(g.logConfig(other))).toEqual(other);
  });

  it("logs the messages' build hash, and refuses a log made with other messages", () => {
    const logged = g.logConfig(INBOX_CONFIG);
    expect(logged.dataSha256).toBe(INBOX_DATA_SHA256);
    expect(INBOX_DATA_SHA256).toMatch(/^[0-9a-f]{64}$/);
    expect(() => g.configFromLog({ ...logged, dataSha256: '0'.repeat(64) })).toThrow(
      /inbox: messages differ/,
    );
    expect(() => g.configFromLog({ ...logged, dataSha256: 7 })).toThrow(
      'dataSha256 must be a string',
    );
    const withoutSha = Object.fromEntries(
      Object.entries(logged).filter(([k]) => k !== 'dataSha256'),
    );
    expect(() => g.configFromLog(withoutSha)).toThrow('missing dataSha256');
  });

  it('refuses a logged config with a missing, extra, wrong-typed or invalid field', () => {
    const logged = g.logConfig(INBOX_CONFIG);
    const without = (k: string) =>
      Object.fromEntries(Object.entries(logged).filter(([x]) => x !== k));
    expect(() => g.configFromLog(without('damage'))).toThrow('missing damage');
    expect(() => g.configFromLog({ ...logged, extra: 1 })).toThrow('unknown field extra');
    expect(() => g.configFromLog({ ...logged, health: '100' })).toThrow(
      'health must be an integer',
    );
    expect(() => g.configFromLog({ ...logged, maxChars: 2.5 })).toThrow(
      'maxChars must be an integer',
    );
    expect(() => g.configFromLog({ ...logged, spawn: null })).toThrow('spawn must be an object');
    expect(() => g.configFromLog({ ...logged, fall: { startTicks: 1, endTicks: 1 } })).toThrow(
      'missing fall.rampTicks',
    );
    expect(() =>
      g.configFromLog({ ...logged, fall: { startTicks: 1, endTicks: 1, rampTicks: 1, x: 0 } }),
    ).toThrow('unknown field fall.x');
    expect(() => g.configFromLog({ ...logged, streamLength: 0 })).toThrow('streamLength');
  });

  it('creates the same state for the same seed and another for another seed', () => {
    const a = g.create(SEED, INBOX_CONFIG);
    expect(g.hash(a)).toMatch(/^[0-9a-f]{16}$/);
    expect(g.hash(g.create(SEED, INBOX_CONFIG))).toBe(g.hash(a));
    expect(g.hash(g.create(SEED + 1, INBOX_CONFIG))).not.toBe(g.hash(a));
    expect(g.tick(a)).toBe(0);
    expect(a.stream).toHaveLength(600);
    const ids = new Set(INBOX_MESSAGES.map((m) => m.id));
    for (const item of a.stream) expect(ids.has(item.id)).toBe(true);
  });

  it('keeps the hash stable across clone, and a clone is independent', () => {
    const s = g.create(SEED, INBOX_CONFIG);
    for (let i = 0; i < 40; i++) g.step(s, [null, null]);
    const before = g.hash(s);
    const c = g.clone(s);
    expect(c).not.toBe(s);
    expect(g.hash(c)).toBe(before);
    g.step(c, [null, null]);
    expect(g.hash(c)).not.toBe(before);
    expect(g.hash(s)).toBe(before);
    g.step(s, [null, null]);
    expect(g.hash(s)).toBe(g.hash(c));
  });

  it('asks both seats the same valid question under the same key, ordered per key', () => {
    const s = g.create(SEED, INBOX_CONFIG);
    const [q0, q1] = SEATS.map((seat) => g.question(s, seat));
    if (!q0 || !q1) throw new Error('no question at the start');
    expect(q0.key).toMatch(/^sms-\d+$/);
    expect(q1).toEqual(q0);
    expect(() => {
      validateQuestion(q0.question);
    }).not.toThrow();
    const ordered = orderOptions(q0.question, SEED, q0.key);
    expect(ordered.options.map((o) => o.id).sort()).toEqual(['legit', 'smishing', 'spam']);
  });

  it('runs to its end with no answers within maxTicks, then stops asking and stepping', () => {
    const s = g.create(SEED, INBOX_CONFIG);
    let steps = 0;
    while (!g.result(s).over) {
      expect(g.result(s).winner).toBeNull();
      g.step(s, [null, null]);
      steps++;
    }
    expect(steps).toBeLessThan(g.maxTicks(INBOX_CONFIG));
    // Both lanes take the same hits, so it's a draw at 0 health (nobody answered: accuracy 0).
    expect(g.result(s)).toEqual({ over: true, winner: 'draw', scores: [0, 0] });
    for (const seat of SEATS) {
      expect(g.question(s, seat)).toBeNull();
      expect(g.canAsk(s, seat)).toBe(false);
    }
    expect(() => g.step(s, [null, null])).toThrow(/over/);
  });

  it('bounds a match by the last landing', () => {
    const last = Math.max(...buildSchedule(INBOX_CONFIG).map((x) => x.landTick));
    expect(g.maxTicks(INBOX_CONFIG)).toBe(last + 1);
  });
});

describe('inboxGame: view', () => {
  it('shows only the soonest message text and seconds_to_land, for this lane only', () => {
    const s = g.create(SEED, INBOX_CONFIG);
    for (let i = 0; i < 30; i++) g.step(s, [null, null]);
    const item = soonest(s, 0);
    if (!item) throw new Error('empty lane');
    const v = g.view(s, 0);
    expect(Object.keys(v as object).sort()).toEqual(['seconds_to_land', 'text']);
    expect(v).toEqual({
      text: messageText(item.id),
      seconds_to_land: Math.round((item.landTick - s.tick) / 6) / 10,
    });
    expect(jsonRoundTrip(v)).toEqual(v);
    // Answering in lane 1 changes nothing seat 0 sees.
    g.step(s, [null, { choice: 'legit', questionKey: item.id }]);
    const after = g.view(s, 0) as { text: string };
    expect(after.text).toBe(messageText(item.id));
    expect(g.view(s, 1)).not.toEqual(g.view(s, 0));
  });

  it('is the empty placeholder for an empty lane, which is never asked', () => {
    const s = g.create(SEED, INBOX_CONFIG);
    const first = soonest(s, 1);
    if (!first) throw new Error('empty lane');
    g.step(s, [null, { choice: first.label, questionKey: first.id }]);
    expect(g.view(s, 1)).toEqual(EMPTY_LANE_VIEW);
    expect(g.canAsk(s, 1)).toBe(false);
  });

  it('rounds seconds_to_land to one decimal', () => {
    expect(secondsToLand(240)).toBe(4);
    expect(secondsToLand(239)).toBe(4);
    expect(secondsToLand(236)).toBe(3.9);
    expect(secondsToLand(3)).toBe(0.1);
    expect(secondsToLand(2)).toBe(0);
    expect(secondsToLand(1)).toBe(0);
  });

  it('shows every committed text unchanged at maxChars 240, and trims longer ones', () => {
    expect(INBOX_CONFIG.maxChars).toBe(MAX_CHARS);
    for (const m of INBOX_MESSAGES) expect(fitText(m.text, INBOX_CONFIG.maxChars)).toBe(m.text);
    expect(fitText('aaaa bbbb cccc dddd eeee', 12)).toBe('aaaa bbbb…');
    expect(fitText('short', 12)).toBe('short');
  });
});

describe('inboxGame: scripted baseline', () => {
  it('always answers legit after the core baseline delay', async () => {
    const clock = createFakeClock();
    const bot = g.createBaseline?.('scripted', { clock });
    if (!bot) throw new Error('no scripted baseline');
    expect(bot.player).toBe('scripted');
    const s = g.create(SEED, INBOX_CONFIG);
    const asked = g.question(s, 0);
    if (!asked) throw new Error('no question');
    const r = await bot.decide(g.view(s, 0), asked.question, new AbortController().signal);
    expect(r).toMatchObject({ status: 'ok', choice: 'legit', latencyMs: 200, costUsd: 0 });
    expect(clock.sleeps).toEqual([200]);
  });

  it('honours a custom delay and reports an abort as a timeout', async () => {
    const clock = createFakeClock();
    const bot = g.createBaseline?.('scripted', { clock, delayMs: 50 });
    const q = g.question(g.create(SEED, INBOX_CONFIG), 0)?.question as Question;
    const ok = await bot?.decide(null, q, new AbortController().signal);
    expect(ok).toMatchObject({ status: 'ok', latencyMs: 50 });
    const abort = new AbortController();
    abort.abort();
    expect(await bot?.decide(null, q, abort.signal)).toMatchObject({ status: 'timeout' });
  });

  it('throws on an unknown baseline', () => {
    expect(() => g.createBaseline?.('nope', { clock: createFakeClock() })).toThrow(
      'unknown baseline "nope"',
    );
  });
});

describe('inboxGame through the real-time scheduler', () => {
  it('hands both seats the identical ordered question object for the same message', async () => {
    const clock = new SimClock();
    const seen = [new Map<string, Question>(), new Map<string, Question>()];
    const recorder = (seat: Seat) =>
      fakeDecider(clock, () => ({
        latencyMs: 150,
        choice: (state, question) => {
          seen[seat]?.set((state as { text: string }).text, question);
          return 'legit';
        },
      }));
    const config: InboxConfig = { ...INBOX_CONFIG, streamLength: 40 };
    const runner = createRealtimeRunner({
      game: g,
      seed: SEED,
      config,
      seats: [baselineMeta(), baselineMeta()],
      deciders: [recorder(0), recorder(1)],
      clock,
      sink: memorySink(),
      ...COMMON,
    });
    await driveRealtime(runner, clock);
    const [a, b] = seen;
    if (!a || !b) throw new Error('unreachable');
    expect(a.size).toBeGreaterThan(20);
    let shared = 0;
    for (const [text, q] of a) {
      const other = b.get(text);
      if (!other) continue;
      shared++;
      expect(other).toBe(q);
    }
    expect(shared).toBeGreaterThan(20);
    // The order differs between messages (it is per key), but never between seats.
    const orders = new Set([...a.values()].map((q) => q.options.map((o) => o.id).join()));
    expect(orders.size).toBeGreaterThan(1);
  });

  it('never re-asks the message a seat is answering, so nothing is dropped as resolved', async () => {
    const { lines, end } = await runInboxMatch(3, [FAST, FAST]);
    const decisions = lines.filter((l): l is DecisionLine => l.type === 'decision');
    expect(decisions.length).toBeGreaterThan(300);
    expect(decisions.filter((d) => d.error === 'dropped: resolved')).toEqual([]);
    // Each message is asked at most once per seat.
    for (const seat of SEATS) {
      const keys = decisions.filter((d) => d.seat === seat).map((d) => d.questionKey);
      expect(new Set(keys).size).toBe(keys.length);
    }
    // Every applied answer is graded.
    for (const d of decisions) if (d.status === 'ok') expect(typeof d.correct).toBe('boolean');
    expect(end.valid).toBe(true);
  });

  it('logs hits and one game_over as events, and a match_end from the game', async () => {
    const { lines, end, state } = await runInboxMatch(5, [FAST, { kind: 'random' }]);
    const events = lines.flatMap((l) => (l.type === 'event' ? [l.game] : []));
    expect(events.filter((e) => e.kind === 'game_over')).toHaveLength(1);
    expect(new Set(events.map((e) => e.kind))).toEqual(new Set(['hit', 'game_over']));
    expect(end.winner).toBe(0);
    expect(end.scores).toEqual([state.lanes[0].health, 0]);
    expect(end.finalStateHash).toBe(g.hash(state));
  });
});
