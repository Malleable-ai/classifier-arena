import { describe, expect, it } from 'vitest';
import { OPTION_ORDER_RULE, orderOptions } from '../../../src/core/classifier/order.js';
import { promptConfigHash } from '../../../src/core/classifier/prompt.js';
import {
  REFUSAL_ERROR,
  type Decider,
  type Question,
  type Seat,
} from '../../../src/core/classifier/types.js';
import type { RealtimeGame, Settlement } from '../../../src/core/game.js';
import { parseMatchLog } from '../../../src/core/log/read.js';
import type { HeaderLine, MatchEndLine } from '../../../src/core/log/schema.js';
import { NO_EXCLUSIONS } from '../../../src/core/results/excluded.js';
import {
  SeatController,
  createRealtimeRunner,
  type RealtimeRunner,
} from '../../../src/core/sched/realtime.js';
import {
  BACKOFF_MAX_MS,
  BACKOFF_START_MS,
  FLOOR_MS,
  REALTIME_STALL_MS,
  TIMEOUT_MS,
  WARMUP_TIMEOUT_MS,
  WarmupError,
  isBackoffError,
  type Answer,
  type SeatMeta,
} from '../../../src/core/sched/shared.js';
import { MATCH_OVER, isValidLog } from '../../../src/core/sched/validity.js';
import { createPrng, nextBelow } from '../../../src/core/util/prng.js';
import {
  counterRealtime,
  realtimeAnswer,
  type CounterRealtimeConfig,
  type CounterRealtimeState,
  type CounterRealtimeView,
} from '../games/counter-realtime.js';
import {
  COMMON,
  SimClock,
  baselineMeta,
  decisionsOf,
  fakeDecider,
  memorySink,
  providerMeta,
  settleOnSim,
  type FakeDecider,
  type FakeStep,
} from './helpers.js';

const TICK = 1000 / 60;
type Game = RealtimeGame<CounterRealtimeState, CounterRealtimeConfig>;

const QUESTION: Question = {
  name: 'up_or_down',
  instructions: 'Answer up or down.',
  options: [
    { id: 'up', description: 'Even.' },
    { id: 'down', description: 'Odd.' },
  ],
};

/** The right answer for the view a decider was sent. */
const right = (state: unknown): string => {
  const { target } = state as CounterRealtimeView;
  if (target === null) throw new Error('no target');
  return target % 2 === 0 ? 'up' : 'down';
};
const wrong = (state: unknown): string => (right(state) === 'up' ? 'down' : 'up');
const windowOf = (state: unknown): number => (state as CounterRealtimeView).window;

describe('SeatController', () => {
  /** Drive one controller alone on a SimClock: poll every tick for `ms`. */
  async function drive(script: (n: number) => FakeStep, ms: number) {
    const clock = new SimClock();
    const decider = fakeDecider(clock, script);
    const answers: Answer[] = [];
    const c = new SeatController({ seat: 0, decider, clock, onAnswer: (a) => answers.push(a) });
    const backoffs: number[] = [];
    for (let tick = 0; tick * TICK <= ms; tick++) {
      await clock.advanceTo(tick * TICK);
      c.takePending();
      c.maybeSend(tick, clock.now(), { tick }, { key: 'k', question: QUESTION });
      if (answers.length > backoffs.length) backoffs.push(c.backoffMs);
    }
    return { clock, decider, answers, controller: c, backoffs };
  }

  it('uses the shared timings by default', () => {
    expect([FLOOR_MS, TIMEOUT_MS, BACKOFF_START_MS, BACKOFF_MAX_MS]).toEqual([
      100, 1000, 250, 2000,
    ]);
  });

  it('sends the state and the asked question, and remembers the key with the request', async () => {
    const { decider, answers } = await drive(() => ({ latencyMs: 5, choice: 'down' }), 0);
    expect(decider.calls[0]?.state).toEqual({ tick: 0 });
    expect(decider.calls[0]?.question).toBe(QUESTION);
    expect(answers).toHaveLength(0); // still in flight at t = 0
  });

  it("passes each request its seq (the log line's, and the snapshot's name)", async () => {
    const { decider, answers } = await drive(
      (n) => (n % 3 === 1 ? { latencyMs: 0, error: 'http 429: slow' } : { latencyMs: 30 }),
      3000,
    );
    expect(answers.length).toBeGreaterThan(3);
    expect(decider.calls.slice(0, answers.length).map((c) => c.ctx?.seq)).toEqual(
      answers.map((a) => a.seq),
    );
  });

  it('enforces the 100 ms floor between sends', async () => {
    const { decider, answers } = await drive(() => ({ latencyMs: 5 }), 1000);
    const at = decider.calls.map((c) => c.at);
    expect(at.length).toBeGreaterThan(5);
    for (let i = 1; i < at.length; i++) {
      expect((at[i] ?? 0) - (at[i - 1] ?? 0)).toBeGreaterThanOrEqual(100 - 1e-6);
    }
    // First tick at or after 100 ms: tick 6 (100.0 ms).
    expect(at[1]).toBeCloseTo(100, 6);
    expect(answers[0]).toMatchObject({ seat: 0, seq: 0, sentTick: 0, questionKey: 'k' });
    expect(answers[0]?.result).toMatchObject({ status: 'ok', choice: 'up' });
  });

  it('keeps at most one request in flight', async () => {
    const { decider } = await drive(() => ({ latencyMs: 400 }), 1000);
    const at = decider.calls.map((c) => c.at);
    // Sent at 0; the answer arrives at 400, the next send is the first tick after that.
    expect(at[0]).toBe(0);
    expect(at[1]).toBeGreaterThanOrEqual(400);
    expect(at[1]).toBeLessThan(400 + TICK);
    expect(at.length).toBe(3);
  });

  it('times out at 1,000 ms, discards the late answer, and sends again', async () => {
    const { answers, decider } = await drive(
      (n) => (n === 0 ? { latencyMs: 3000, choice: 'down' } : { latencyMs: 10, choice: 'up' }),
      3500,
    );
    const first = answers[0];
    expect(first?.result.status).toBe('timeout');
    expect(first?.result.latencyMs).toBe(1000);
    expect(first?.result.choice).toBeNull();
    expect(first?.sentTick).toBe(0);
    expect(first?.questionKey).toBe('k');
    // Next request on the first tick after the timeout.
    expect(decider.calls[1]?.at).toBeGreaterThanOrEqual(1000);
    expect(decider.calls[1]?.at).toBeLessThan(1000 + TICK);
    // The late 'down' (arrives at 3000) never shows up as an answer.
    expect(answers.filter((a) => a.seq === 0)).toHaveLength(1);
    expect(answers.every((a) => a.result.choice !== 'down')).toBe(true);
    expect(decider.calls[0]?.signal.aborted).toBe(true);
  });

  it('backs off 250/500/1000/2000/2000 ms on 429 and 5xx, and resets on ok', async () => {
    const { backoffs, decider, controller } = await drive(
      (n) =>
        n < 5
          ? { latencyMs: 0, error: n % 2 ? 'http 503: down' : 'http 429: slow' }
          : { latencyMs: 0 },
      8000,
    );
    expect(backoffs.slice(0, 5)).toEqual([250, 500, 1000, 2000, 2000]);
    const at = decider.calls.map((c) => c.at);
    const gaps = at.slice(1, 6).map((t, i) => t - (at[i] ?? 0));
    [250, 500, 1000, 2000, 2000].forEach((b, i) => {
      expect(gaps[i]).toBeGreaterThanOrEqual(b - 1e-6);
      expect(gaps[i]).toBeLessThan(b + TICK);
    });
    expect(controller.backoffMs).toBe(0);
  });

  it('turns an ok answer without a choice into an error, and a throw into an error', async () => {
    const clock = new SimClock();
    const answers: Answer[] = [];
    const decider: Decider = {
      player: 'odd',
      decide: () =>
        Promise.resolve({
          choice: null,
          probabilities: null,
          confidence: null,
          latencyMs: 0,
          inputTokens: null,
          costUsd: 0,
          status: 'ok',
        }),
    };
    const c = new SeatController({ seat: 1, decider, clock, onAnswer: (a) => answers.push(a) });
    c.maybeSend(0, 0, {}, { key: 'k', question: QUESTION });
    await clock.advance(0);
    expect(answers[0]?.result).toMatchObject({
      status: 'error',
      error: 'ok answer without a choice',
    });
    expect(c.pending).toBeNull();

    const thrower = fakeDecider(clock, () => ({ latencyMs: 1, throws: true }));
    const t = new SeatController({
      seat: 0,
      decider: thrower,
      clock,
      onAnswer: (a) => answers.push(a),
    });
    t.maybeSend(0, clock.now(), {}, { key: 'k', question: QUESTION });
    await clock.advance(1);
    expect(answers[1]?.result).toMatchObject({ status: 'error', error: 'decider threw: boom' });
  });

  it('logs a decider that throws synchronously from decide() as an error, without crashing', async () => {
    const clock = new SimClock();
    const answers: Answer[] = [];
    const decider: Decider = {
      player: 'sync',
      decide: () => {
        throw new Error('sync boom');
      },
    };
    const c = new SeatController({ seat: 0, decider, clock, onAnswer: (a) => answers.push(a) });
    expect(c.maybeSend(0, 0, {}, { key: 'k', question: QUESTION })).toBe(true);
    await clock.advance(0);
    expect(answers[0]?.result).toMatchObject({
      status: 'error',
      error: 'decider threw: sync boom',
    });
    expect(c.inFlight).toBe(false);
  });

  it('abort() cancels the request in flight and returns it at the last ok cost, without onAnswer', async () => {
    const clock = new SimClock();
    const answers: Answer[] = [];
    const decider = fakeDecider(clock, () => ({ latencyMs: 500 }));
    const c = new SeatController({ seat: 0, decider, clock, onAnswer: (a) => answers.push(a) });
    expect(c.abort()).toBeNull();
    c.lastOkCostUsd = 0.002;
    c.maybeSend(3, 0, {}, { key: 'k7', question: QUESTION });
    await clock.advance(50);
    const cancelled = c.abort();
    expect(cancelled).toMatchObject({ seat: 0, seq: 0, sentTick: 3, questionKey: 'k7' });
    expect(cancelled?.result).toMatchObject({
      status: 'error',
      error: 'cancelled',
      costUsd: 0.002,
      costEstimated: true,
      latencyMs: 50,
    });
    expect(c.inFlight).toBe(false);
    expect(decider.calls[0]?.signal.aborted).toBe(true);
    await clock.advance(1000);
    expect(answers).toHaveLength(0);
  });

  it('does not back off on other errors', () => {
    const r = {
      choice: null,
      probabilities: null,
      confidence: null,
      latencyMs: 0,
      inputTokens: null,
      costUsd: 0,
    };
    expect(isBackoffError({ ...r, status: 'error', error: 'http 400: bad' })).toBe(false);
    expect(isBackoffError({ ...r, status: 'error', error: 'network: reset' })).toBe(false);
    expect(isBackoffError({ ...r, status: 'error', error: 'http 500: x' })).toBe(true);
    expect(isBackoffError({ ...r, status: 'timeout', error: 'http 500: x' })).toBe(false);
  });
});

interface HarnessOpts {
  seed?: number;
  seats?: [SeatMeta, SeatMeta];
  game?: Game;
  config?: CounterRealtimeConfig;
}

async function harness(
  a: (clock: SimClock) => Decider,
  b: (clock: SimClock) => Decider,
  opts: HarnessOpts = {},
) {
  const clock = new SimClock();
  const sink = memorySink();
  const game = opts.game ?? counterRealtime;
  const runner = createRealtimeRunner({
    game,
    seed: opts.seed ?? 7,
    config: opts.config ?? counterRealtime.defaultConfig,
    seats: opts.seats ?? [baselineMeta(), baselineMeta()],
    deciders: [a(clock), b(clock)],
    clock,
    sink,
    ...COMMON,
  });
  await settleOnSim(clock, runner.start());
  return {
    clock,
    runner,
    sink,
    lines: sink.lines,
    async runUntilTick(tick: number) {
      while (!runner.done && game.tick(runner.state) < tick) {
        await clock.advanceTo(runner.nextTickDueMs());
        runner.advance(clock.now());
      }
    },
    decisions: (seat?: Seat) => decisionsOf(sink.lines, seat),
  };
}

const idle = (clock: SimClock) => fakeDecider(clock, () => ({ latencyMs: 10, choice: 'up' }));

describe('realtime runner', () => {
  it('applies an answer on the next tick after it arrives, logging sentTick, appliedTick and key', async () => {
    const h = await harness((c) => fakeDecider(c, () => ({ latencyMs: 30, choice: right })), idle);
    await h.runUntilTick(4);
    const [first] = h.decisions(0);
    // Sent on tick 0 (t = 0), arrives at 30 ms; tick 1 is at 16.7 ms, tick 2 at 33.3 ms.
    expect(first).toEqual({
      type: 'decision',
      seat: 0,
      seq: 0,
      questionKey: 'q0',
      sentTick: 0,
      appliedTick: 2,
      latencyMs: 30,
      choice: realtimeAnswer(h.runner.state, 0),
      probabilities: null,
      confidence: null,
      inputTokens: null,
      costUsd: 0,
      status: 'ok',
      correct: true,
    });
  });

  it('logs `correct` from the settlement', async () => {
    const h = await harness(
      (c) => fakeDecider(c, () => ({ latencyMs: 20, choice: right })),
      (c) => fakeDecider(c, () => ({ latencyMs: 20, choice: wrong })),
    );
    await h.runUntilTick(200);
    expect(h.decisions(0).length).toBeGreaterThan(5);
    expect(h.decisions(0).every((l) => l.status === 'ok' && l.correct === true)).toBe(true);
    expect(h.decisions(1).every((l) => l.status === 'ok' && l.correct === false)).toBe(true);
    expect(h.runner.state.scores[1]).toBe(0);
  });

  it('logs a timeout with appliedTick null and an estimated cost', async () => {
    const h = await harness(
      (c) =>
        fakeDecider(c, (n) =>
          n === 0 ? { latencyMs: 10, choice: 'up', costUsd: 0.002 } : { latencyMs: 5000 },
        ),
      idle,
    );
    await h.runUntilTick(80);
    const timeout = h.decisions(0).find((l) => l.status === 'timeout');
    expect(timeout).toMatchObject({
      seq: 1,
      appliedTick: null,
      latencyMs: 1000,
      choice: null,
      costUsd: 0.002,
      costEstimated: true,
    });
    expect(timeout?.correct).toBeUndefined();
    expect(h.decisions(0)[0]?.costEstimated).toBeUndefined();
  });

  it('logs dropped (with the reason) when the game settles an answer as dropped', async () => {
    // Sent on tick 0 for q0; arrives at 490 ms and is fed on tick 30 (500 ms), in window q1: stale.
    const h = await harness((c) => fakeDecider(c, () => ({ latencyMs: 490, choice: 'up' })), idle);
    await h.runUntilTick(31);
    expect(h.decisions(0)[0]).toMatchObject({
      seq: 0,
      questionKey: 'q0',
      sentTick: 0,
      appliedTick: 30,
      choice: 'up',
      status: 'dropped',
      error: 'dropped: stale',
    });
    expect(h.decisions(0)[0]?.correct).toBeUndefined();
    // Its replacement is sent on tick 30 for q1.
    const d = h.runner.controllers[0];
    expect(d.sent).toBe(2);
  });

  it('matches settlements to answers FIFO per seat by choice, and drops unresolved ones at the end', async () => {
    // A wrapper that settles 'up' 12 ticks late and 'down' at once, so answers wait out of order.
    const delayed = (): Game => {
      let held: { due: number; s: Settlement }[] = [];
      return {
        ...counterRealtime,
        step(state, inputs) {
          const tick = state.tick;
          const out = counterRealtime.step(state, inputs);
          for (const s of out.settlements)
            held.push({ due: tick + (s.choice === 'up' ? 12 : 0), s });
          const ready = held.filter((h) => h.due <= tick);
          held = held.filter((h) => h.due > tick);
          return { settlements: ready.map((h) => h.s), events: out.events };
        },
      };
    };
    const h = await harness(
      (c) => fakeDecider(c, (n) => ({ latencyMs: 10, choice: n % 2 === 0 ? 'up' : 'down' })),
      idle,
      { game: delayed(), config: { windows: 1 } },
    );
    await h.runUntilTick(Number.POSITIVE_INFINITY);
    const lines = h.decisions(0);
    // Sends on ticks 0, 6, 12, 18, 24 (up, down, up, down, up), fed on ticks 1, 7, 13, 19, 25.
    // 'down' settles at once and is matched by choice past the waiting 'up'; each 'up' settlement
    // goes to the oldest waiting 'up'. Every request gets exactly one line, in settle order.
    expect(lines.map((l) => [l.seq, l.choice, l.appliedTick, l.status])).toEqual([
      [1, 'down', 7, 'ok'],
      [0, 'up', 1, 'ok'],
      [3, 'down', 19, 'ok'],
      [2, 'up', 13, 'ok'],
      [4, 'up', 25, 'dropped'],
    ]);
    // Fed on tick 25, its settlement was still held when the game ended after tick 29.
    expect(lines[4]?.error).toBe('dropped: unresolved');
  });

  it('throws on a settlement that matches no waiting answer (a game bug)', async () => {
    const game: Game = {
      ...counterRealtime,
      step(state, inputs) {
        const out = counterRealtime.step(state, inputs);
        out.settlements.push({ seat: 1, choice: 'down', outcome: 'applied' });
        return out;
      },
    };
    const h = await harness(idle, idle, { game });
    await expect(h.runUntilTick(1)).rejects.toThrow(/settlement.*seat 1.*down/);
  });

  it('alternates which seat sends first by tick parity', async () => {
    const order: [number, string][] = [];
    const tag =
      (name: string) =>
      (clock: SimClock): FakeDecider => {
        // 110 ms answers: sends land on ticks 0, 7, 14, 21, ... (both parities).
        const d = fakeDecider(clock, () => ({ latencyMs: 110 }));
        const decide = d.decide.bind(d);
        d.decide = (v, q, s) => {
          order.push([Math.round(clock.now() / TICK), name]);
          return decide(v, q, s);
        };
        return d;
      };
    const h = await harness(tag('a'), tag('b'));
    await h.runUntilTick(60);
    const byTick = new Map<number, string>();
    for (const [tick, who] of order) byTick.set(tick, (byTick.get(tick) ?? '') + who);
    expect([...byTick.entries()].slice(0, 4)).toEqual([
      [0, 'ab'],
      [7, 'ba'],
      [14, 'ab'],
      [21, 'ba'],
    ]);
  });

  it('hands both seats the identical ordered question object for a key', async () => {
    let a: FakeDecider | undefined;
    let b: FakeDecider | undefined;
    const seed = 1234;
    const h = await harness(
      (c) => (a = fakeDecider(c, () => ({ latencyMs: 20 }))),
      (c) => (b = fakeDecider(c, () => ({ latencyMs: 20 }))),
      { seed },
    );
    await h.runUntilTick(90);
    const calls = [...(a?.calls ?? []), ...(b?.calls ?? [])];
    const byKey = new Map<number, Set<Question>>();
    for (const c of calls) {
      const k = windowOf(c.state);
      byKey.set(k, (byKey.get(k) ?? new Set()).add(c.question));
    }
    expect([...byKey.keys()].sort()).toEqual([0, 1, 2]);
    const canonical = counterRealtime.question(counterRealtime.create(seed, { windows: 20 }), 0);
    if (!canonical) throw new Error('no question');
    for (const [k, qs] of byKey) {
      expect(qs.size).toBe(1);
      const [q] = qs;
      expect(q).toEqual(orderOptions(canonical.question, seed, `q${String(k)}`));
    }
    // Both seats asked for each key, and a new key gets a new object.
    expect(new Set([...byKey.values()].map((s) => [...s][0])).size).toBe(3);
    expect(a?.calls.some((c) => windowOf(c.state) === 1)).toBe(true);
    expect(b?.calls.some((c) => windowOf(c.state) === 1)).toBe(true);
  });

  it('sends each seat its own view of the state before the tick', async () => {
    let b: FakeDecider | undefined;
    const h = await harness(idle, (c) => (b = fakeDecider(c, () => ({ latencyMs: 10 }))));
    await h.runUntilTick(10);
    expect(b?.calls[1]?.state).toEqual({
      seat: 1,
      tick: 6,
      window: 0,
      target: h.runner.state.targets[0],
    });
  });

  it('sends nothing when the game says the seat cannot be asked', async () => {
    let b: FakeDecider | undefined;
    const game: Game = { ...counterRealtime, canAsk: (_s, seat) => seat === 0 };
    const h = await harness(idle, (c) => (b = fakeDecider(c, () => ({ latencyMs: 10 }))), {
      game,
    });
    await h.runUntilTick(100);
    expect(h.decisions(0).length).toBeGreaterThan(5);
    expect(b?.calls).toHaveLength(0);
    expect(h.decisions(1)).toHaveLength(0);
  });

  it('sends nothing when the game has no question for the seat', async () => {
    let b: FakeDecider | undefined;
    const game: Game = {
      ...counterRealtime,
      question: (s, seat) =>
        seat === 1 && Math.floor(s.tick / 30) % 2 === 0 ? null : counterRealtime.question(s, seat),
    };
    const h = await harness(idle, (c) => (b = fakeDecider(c, () => ({ latencyMs: 10 }))), {
      game,
    });
    await h.runUntilTick(90);
    const windows = new Set(b?.calls.map((c) => windowOf(c.state)));
    expect([...windows]).toEqual([1]);
  });

  it('with answerRetiresKey, does not re-ask a seat the key it is answering on that tick', async () => {
    // Call 0 is applied on tick 7 (sent at 0 ms, back at 110 ms), still in window q0. Call 1 is
    // applied on tick 30 (with the flag) or 29 (without), once q1 or still q0 respectively.
    const script = (n: number): FakeStep => ({ latencyMs: n === 0 ? 110 : n === 1 ? 360 : 5 });
    const sentTicks = async (game: Game) => {
      const h = await harness((c) => fakeDecider(c, script), idle, { game });
      await h.runUntilTick(40);
      return h.decisions(0).map((l) => [l.sentTick, l.appliedTick, l.questionKey]);
    };
    expect((await sentTicks(counterRealtime)).slice(0, 3)).toEqual([
      [0, 7, 'q0'],
      [7, 29, 'q0'],
      [29, 30, 'q0'],
    ]);
    // Skipped on tick 7 (q0 is being answered), asked on 8; on tick 30 the question is q1, so
    // there is nothing to skip.
    expect((await sentTicks({ ...counterRealtime, answerRetiresKey: true })).slice(0, 3)).toEqual([
      [0, 7, 'q0'],
      [8, 30, 'q0'],
      [30, 31, 'q1'],
    ]);
  });

  it('writes event lines from step(), tagged with the tick simulated', async () => {
    const h = await harness(idle, idle, { config: { windows: 3 } });
    await h.runUntilTick(Number.POSITIVE_INFINITY);
    const events = h.lines.filter((l) => l.type === 'event');
    expect(events).toEqual([
      { type: 'event', tick: 0, game: { kind: 'window', k: 0 } },
      { type: 'event', tick: 30, game: { kind: 'window', k: 1 } },
      { type: 'event', tick: 60, game: { kind: 'window', k: 2 } },
    ]);
  });

  it('writes a v2 header with the game, timing, order rule and prompt hash', async () => {
    const headerSeat = (seat: Seat) => ({
      seat,
      player: 'fake',
      label: 'fake',
      format: null,
      hosting: null,
      model: null,
      serviceTier: null,
      modelVersion: null,
      price: null,
      warmup: null,
    });
    const h = await harness(idle, idle, { seed: 99 });
    const header = h.lines[0] as HeaderLine;
    expect(header).toEqual({
      type: 'header',
      schemaVersion: 2,
      game: 'counter_realtime',
      gameVersion: 1,
      matchId: 'test-match',
      startTime: '2026-10-07T00:00:00.000Z',
      gitCommit: 'abc123',
      seed: 99,
      runLocation: 'test',
      runId: 'm-test',
      cadence: { kind: 'realtime', tickRate: 60 },
      timing: { floorMs: 100, timeoutMs: 1000 },
      promptConfigHash: promptConfigHash(counterRealtime.promptConfig),
      optionOrderRule: OPTION_ORDER_RULE,
      config: { windows: 20 },
      seats: [headerSeat(0), headerSeat(1)],
    });
  });

  it('ends at game.result over with a match_end from the game, validity and costs', async () => {
    const h = await harness(
      (c) => fakeDecider(c, () => ({ latencyMs: 40, choice: right })),
      (c) => fakeDecider(c, () => ({ latencyMs: 40, choice: wrong })),
      { seed: 5 },
    );
    await h.runUntilTick(Number.POSITIVE_INFINITY);
    expect(h.runner.done).toBe(true);
    const end = h.lines.at(-1) as MatchEndLine;
    const counted = (seat: Seat) => h.decisions(seat).filter((l) => l.error !== MATCH_OVER).length;
    expect(end).toEqual({
      type: 'match_end',
      winner: 0,
      scores: [h.runner.state.scores[0], 0],
      totalTicks: 600,
      finalStateHash: counterRealtime.hash(h.runner.state),
      valid: true,
      missRates: [0, 0],
      timeoutRates: [0, 0],
      refusalRates: [0, 0],
      decisions: [counted(0), counted(1)],
      costUsd: 0,
    });
    expect(end.scores[0]).toBeGreaterThan(15);
    expect(h.runner.result).toBe(end);
    // Nothing more happens after the end.
    const n = h.lines.length;
    await h.clock.advance(1000);
    h.runner.advance(h.clock.now());
    expect(h.lines).toHaveLength(n);
  });

  it('stops at game.maxTicks even if the game never says it is over', async () => {
    const game: Game = {
      ...counterRealtime,
      result: (s) => ({ over: false, winner: null, scores: [s.scores[0], s.scores[1]] }),
    };
    const h = await harness(idle, idle, { game, config: { windows: 2 } });
    await h.runUntilTick(Number.POSITIVE_INFINITY);
    const end = h.lines.at(-1) as MatchEndLine;
    expect(end).toMatchObject({ type: 'match_end', totalTicks: 60, winner: null });
  });

  it('keeps a match valid when a seat times out on every request: timeouts never count', async () => {
    const h = await harness((c) => fakeDecider(c, () => ({ latencyMs: 5000 })), idle);
    await h.runUntilTick(Number.POSITIVE_INFINITY);
    const end = h.lines.at(-1) as MatchEndLine;
    // A timeout is the seat's own miss (no move), never an invalid match (since 2026-10-16).
    expect(h.decisions(0).every((l) => l.status === 'timeout' || l.error === MATCH_OVER)).toBe(
      true,
    );
    // Each timeout is logged at the timeout, not the decider's 5 s: no stall from the log.
    for (const l of h.decisions(0)) expect(l.latencyMs).toBeLessThanOrEqual(1000 + 250);
    expect(end.valid).toBe(true);
    expect(end.missRates[0]).toBe(1);
    expect(end.missRates[1]).toBe(0);
    expect(end.timeoutRates).toEqual([1, 0]);
  });

  it('flags the match invalid when a seat’s transport errors pass 2%', async () => {
    const h = await harness(
      (c) =>
        fakeDecider(c, (n) =>
          n % 10 === 0 ? { latencyMs: 20, error: 'network: fetch failed' } : { latencyMs: 20 },
        ),
      idle,
    );
    await h.runUntilTick(Number.POSITIVE_INFINITY);
    const end = h.lines.at(-1) as MatchEndLine;
    expect(end.valid).toBe(false);
    expect(end.missRates[0]).toBeGreaterThan(0.02);
    expect(end.timeoutRates).toEqual([0, 0]);
  });

  it('keeps a refusal-heavy match valid: a refusal is no move, logged as refusal, not a miss', async () => {
    let fed = 0;
    const game: Game = {
      ...counterRealtime,
      step(state, inputs) {
        if (inputs[0] !== null) fed++;
        return counterRealtime.step(state, inputs);
      },
    };
    // Seat 0 refuses every other request (about half its decisions); each refusal is billed.
    let a: FakeDecider | undefined;
    const h = await harness(
      (c) =>
        (a = fakeDecider(c, (n) =>
          n % 2 === 0
            ? { latencyMs: 10, refusal: true, costUsd: 0.001 }
            : { latencyMs: 10, choice: right, costUsd: 0.001 },
        )),
      idle,
      { game },
    );
    await h.runUntilTick(Number.POSITIVE_INFINITY);
    const end = h.lines.at(-1) as MatchEndLine;
    const d0 = h.decisions(0).filter((l) => l.error !== MATCH_OVER);
    const refusals = d0.filter((l) => l.status === 'refusal');
    expect(refusals.length).toBeGreaterThan(5);
    for (const l of refusals) {
      expect(l).toMatchObject({ appliedTick: null, choice: null, error: REFUSAL_ERROR });
      expect(l.costUsd).toBe(0.001);
    }
    // Gameplay as before: no refusal reaches the game, only the fed (ok or dropped) answers.
    expect(fed).toBe(d0.filter((l) => l.appliedTick !== null).length);
    expect(fed).toBe(d0.length - refusals.length);
    // A refusal is a 200, so it never backs the seat off: sends keep the 100 ms floor.
    const gaps = (a?.calls ?? []).slice(1).map((c, i) => c.at - (a?.calls[i]?.at ?? 0));
    expect(Math.max(...gaps)).toBeLessThan(120);
    expect(end.valid).toBe(true);
    expect(end.missRates).toEqual([0, 0]);
    expect(end.refusalRates?.[0]).toBeCloseTo(refusals.length / d0.length, 12);
    expect(end.refusalRates?.[0]).toBeGreaterThan(0.4);
    expect(end.refusalRates?.[1]).toBe(0);
    expect(end.decisions[0]).toBe(d0.length);
    // The stats re-score with the same rule and agree.
    const header = h.lines[0] as HeaderLine;
    expect(isValidLog({ header, decisions: h.decisions() }, NO_EXCLUSIONS)).toBe(true);
  });

  it('still flags a match invalid when transport errors pass 2%, refusals aside', async () => {
    // Seat 1: a network error on 1 request in 10 and a refusal on another.
    const h = await harness(idle, (c) =>
      fakeDecider(c, (n) =>
        n % 10 === 3
          ? { latencyMs: 10, error: 'network: fetch failed' }
          : n % 10 === 6
            ? { latencyMs: 10, refusal: true }
            : { latencyMs: 10, choice: right },
      ),
    );
    await h.runUntilTick(Number.POSITIVE_INFINITY);
    const end = h.lines.at(-1) as MatchEndLine;
    const d1 = h.decisions(1).filter((l) => l.error !== MATCH_OVER);
    const errors = d1.filter((l) => l.status === 'error').length;
    const refusals = d1.filter((l) => l.status === 'refusal').length;
    expect(errors).toBeGreaterThan(0);
    expect(refusals).toBeGreaterThan(0);
    expect(end.valid).toBe(false);
    expect(end.missRates[1]).toBeCloseTo(errors / d1.length, 12);
    expect(end.refusalRates?.[1]).toBeCloseTo(refusals / d1.length, 12);
    expect(
      isValidLog({ header: h.lines[0] as HeaderLine, decisions: h.decisions() }, NO_EXCLUSIONS),
    ).toBe(false);
  });

  it('exposes the latest decision line per seat', async () => {
    const h = await harness(idle, (c) => fakeDecider(c, () => ({ latencyMs: 5000 })));
    expect(h.runner.latestDecisions).toEqual([null, null]);
    await h.runUntilTick(20);
    expect(h.runner.latestDecisions[0]).toEqual(h.decisions(0).at(-1));
    expect(h.runner.latestDecisions[1]).toBeNull();
    await h.runUntilTick(70);
    expect(h.runner.latestDecisions[1]).toMatchObject({ status: 'timeout' });
  });

  it('passes raw request/response bodies to the sink snapshot', async () => {
    const raw = { request: { a: 1 }, response: { b: 2 } };
    const h = await harness((c) => fakeDecider(c, () => ({ latencyMs: 10, raw })), idle);
    await h.runUntilTick(10);
    expect(h.sink.snapshots[0]).toEqual({ seat: 0, seq: 0, raw });
  });

  it('throws when advanced before start, and on a second start', async () => {
    const clock = new SimClock();
    const runner: RealtimeRunner<CounterRealtimeState> = createRealtimeRunner({
      game: counterRealtime,
      seed: 1,
      config: { windows: 1 },
      seats: [baselineMeta(), baselineMeta()],
      deciders: [idle(clock), idle(clock)],
      clock,
      sink: memorySink(),
      ...COMMON,
    });
    expect(() => {
      runner.advance(0);
    }).toThrow(/not started/);
    expect(() => runner.nextTickDueMs()).toThrow(/not started/);
    await runner.start();
    await expect(runner.start()).rejects.toThrow(/already started/);
  });
});

describe('realtime warm-up', () => {
  it('warms up provider seats on seat 0’s first question before the clock starts; baselines skip it', async () => {
    let a: FakeDecider | undefined;
    let b: FakeDecider | undefined;
    const seed = 7;
    const h = await harness(
      (c) =>
        (a = fakeDecider(c, (n) => ({
          latencyMs: n === 0 ? 900 : 20,
          costUsd: 0.001,
          modelVersion: 'v-1',
        }))),
      (c) => (b = fakeDecider(c, () => ({ latencyMs: 20 }))),
      { seats: [providerMeta(), baselineMeta()], seed },
    );
    const header = h.lines[0] as HeaderLine;
    expect(header.seats[0].warmup).toEqual({ latencyMs: 900, status: 'ok', costUsd: 0.001 });
    expect(header.seats[0].modelVersion).toBe('v-1');
    expect(header.seats[1].warmup).toBeNull();
    expect(header.seats[1].price).toBeNull();
    expect(a?.calls).toHaveLength(1);
    expect(b?.calls).toHaveLength(0);
    const fresh = counterRealtime.create(seed, counterRealtime.defaultConfig);
    const asked = counterRealtime.question(fresh, 0);
    if (!asked) throw new Error('no question');
    expect(a?.calls[0]?.state).toEqual(counterRealtime.view(fresh, 0));
    expect(a?.calls[0]?.question).toEqual(orderOptions(asked.question, seed, asked.key));
    // The clock starts after the warm-up: tick 0 is at 900 ms; the warm-up is not a decision.
    expect(h.runner.startMs).toBe(900);
    expect(h.decisions()).toHaveLength(0);
    await h.runUntilTick(1);
    expect(a?.calls[1]?.at).toBe(900);
  });

  /** Start a runner on a SimClock, advancing simulated time until `start` settles. */
  async function startOnSim(
    scripts: [(n: number) => FakeStep, (n: number) => FakeStep],
    seats: [SeatMeta, SeatMeta],
  ) {
    const clock = new SimClock();
    const sink = memorySink();
    const deciders = [fakeDecider(clock, scripts[0]), fakeDecider(clock, scripts[1])] as const;
    const runner = createRealtimeRunner({
      game: counterRealtime,
      seed: 7,
      config: counterRealtime.defaultConfig,
      seats,
      deciders,
      clock,
      sink,
      ...COMMON,
    });
    const started = settleOnSim(clock, runner.start());
    started.catch(() => undefined);
    await started.catch(() => undefined);
    return { clock, sink, runner, deciders, started };
  }

  it('refuses to start, writing nothing, when a provider warm-up fails', async () => {
    const { sink, runner, started, clock } = await startOnSim(
      [() => ({ latencyMs: 50, error: 'http 401 unauthorized' }), () => ({ latencyMs: 20 })],
      [providerMeta('p0'), providerMeta('p1')],
    );
    await expect(started).rejects.toBeInstanceOf(WarmupError);
    await expect(started).rejects.toThrow(
      /warm-up failed.*p0 \(seat 0\): error: http 401 unauthorized/,
    );
    expect(sink.lines).toHaveLength(0);
    expect(runner.startMs).toBeNull();
    expect(clock.now()).toBe(50);
  });

  it('caps a hanging warm-up at 10 s, aborts it, and refuses to start', async () => {
    const { sink, started, clock, deciders } = await startOnSim(
      [() => ({ latencyMs: 20 }), () => ({ latencyMs: 1e9 })],
      [providerMeta('p0'), providerMeta('p1')],
    );
    expect(WARMUP_TIMEOUT_MS).toBe(10_000);
    await expect(started).rejects.toThrow(/warm-up failed.*p1 \(seat 1\): timeout/);
    expect(clock.now()).toBe(WARMUP_TIMEOUT_MS);
    expect(deciders[1].calls[0]?.signal.aborted).toBe(true);
    expect(sink.lines).toHaveLength(0);
  });

  it('starts when a provider warm-up is refused: a refusal is a well-formed answer', async () => {
    const { sink, runner, started, clock } = await startOnSim(
      [
        (n) =>
          n === 0
            ? { latencyMs: 200, refusal: true, costUsd: 0.002, modelVersion: 'v-r' }
            : { latencyMs: 20, choice: right },
        () => ({ latencyMs: 300, costUsd: 0.001 }),
      ],
      [providerMeta('p0'), providerMeta('p1')],
    );
    await expect(started).resolves.toBeUndefined();
    const header = sink.lines[0] as HeaderLine;
    expect(header.type).toBe('header');
    expect(header.seats[0]).toMatchObject({
      modelVersion: 'v-r',
      warmup: { latencyMs: 200, status: 'refusal', costUsd: 0.002, error: REFUSAL_ERROR },
    });
    expect(header.seats[1].warmup).toEqual({ latencyMs: 300, status: 'ok', costUsd: 0.001 });
    // The clock starts once both warm-ups settled, as for ok ones.
    expect(runner.startMs).toBe(300);
    // The match plays to the end, its refused warm-up's spend in the total, and reads back.
    while (!runner.done) {
      await clock.advanceTo(runner.nextTickDueMs());
      runner.advance(clock.now());
    }
    const end = sink.lines.at(-1) as MatchEndLine;
    expect(end.type).toBe('match_end');
    expect(end.valid).toBe(true);
    const decided = decisionsOf(sink.lines).reduce((s, l) => s + l.costUsd, 0);
    expect(end.costUsd).toBeCloseTo(decided + 0.003, 12);
    const log = parseMatchLog(sink.lines.map((l) => JSON.stringify(l)).join('\n'));
    expect(log.header.seats[0].warmup?.status).toBe('refusal');
  });

  it('still refuses to start on a network error in the warm-up', async () => {
    const { sink, runner, started } = await startOnSim(
      [
        () => ({ latencyMs: 40, refusal: true }),
        () => ({ latencyMs: 60, error: 'network: reset' }),
      ],
      [providerMeta('p0'), providerMeta('p1')],
    );
    await expect(started).rejects.toBeInstanceOf(WarmupError);
    await expect(started).rejects.toThrow(/warm-up failed.*p1 \(seat 1\): error: network: reset/);
    // The refused seat is not named: only the failed one.
    await expect(started).rejects.not.toThrow(/p0/);
    expect(sink.lines).toHaveLength(0);
    expect(runner.startMs).toBeNull();
  });

  it('starts when every provider warm-up is ok; baselines never block it', async () => {
    const { sink, started } = await startOnSim(
      [() => ({ latencyMs: 300 }), () => ({ latencyMs: 1e9 })],
      [providerMeta('p0'), baselineMeta()],
    );
    await expect(started).resolves.toBeUndefined();
    expect(sink.lines[0]?.type).toBe('header');
  });
});

describe('realtime spend accounting for unanswered requests', () => {
  it('seeds the estimate from the warm-up cost', async () => {
    const h = await harness(
      (c) =>
        fakeDecider(c, (n) => (n === 0 ? { latencyMs: 10, costUsd: 0.003 } : { latencyMs: 5000 })),
      idle,
      { seats: [providerMeta(), baselineMeta()] },
    );
    await h.runUntilTick(80);
    expect(h.decisions(0)[0]).toMatchObject({
      status: 'timeout',
      costUsd: 0.003,
      costEstimated: true,
    });
  });

  it('logs every request still in flight at match end, with an estimated cost, outside the miss rate', async () => {
    const step = (): FakeStep => ({ latencyMs: 170, costUsd: 0.0001 });
    const h = await harness(
      (c) => fakeDecider(c, step),
      (c) => fakeDecider(c, step),
      { seed: 3, seats: [providerMeta('p0'), providerMeta('p1')] },
    );
    await h.runUntilTick(Number.POSITIVE_INFINITY);
    const { runner, lines } = h;
    const decisions = h.decisions();
    expect(decisions).toHaveLength(runner.controllers[0].sent + runner.controllers[1].sent);
    const atEnd = decisions.filter((l) => l.error === MATCH_OVER && l.choice === null);
    expect(atEnd.length).toBeGreaterThan(0);
    for (const l of atEnd) {
      expect(l).toMatchObject({ status: 'dropped', costUsd: 0.0001, costEstimated: true });
    }
    const end = lines.at(-1);
    if (end?.type !== 'match_end') throw new Error('no match_end');
    const total = decisions.reduce((sum, l) => sum + l.costUsd, 0) + 2 * 0.0001;
    expect(end.costUsd).toBeCloseTo(total, 12);
    expect(end.missRates).toEqual([0, 0]);
  });
});

describe('realtime stalls (the machine paused mid-match)', () => {
  /** Every log line as JSONL, read back through the log reader. */
  const reread = (lines: readonly unknown[]) =>
    parseMatchLog(lines.map((l) => JSON.stringify(l)).join('\n'));

  it('marks a match with a 5 s clock jump invalid and records the stall', async () => {
    const h = await harness(
      (c) => fakeDecider(c, () => ({ latencyMs: 40, choice: right })),
      (c) => fakeDecider(c, () => ({ latencyMs: 40, choice: right })),
      { seats: [providerMeta('p0'), providerMeta('p1')] },
    );
    await h.runUntilTick(120);
    // The machine sleeps: nothing calls advance for 5 s, then one call catches up.
    const due = h.runner.nextTickDueMs();
    await h.clock.advanceTo(h.clock.now() + 5000);
    const lateMs = h.clock.now() - due;
    h.runner.advance(h.clock.now());
    await h.runUntilTick(Number.POSITIVE_INFINITY);
    const end = h.lines.at(-1) as MatchEndLine;
    expect(lateMs).toBeGreaterThan(4900);
    expect(end.stalls).toEqual([{ atTick: 120, gapMs: Math.round(lateMs) }]);
    expect(end.valid).toBe(false);
    // Without the stall the decisions alone would pass: no misses, both seats answered.
    expect(end.missRates).toEqual([0, 0]);
    expect(end.decisions[0]).toBeGreaterThan(20);
    // The reader keeps the field, and the stats re-score the log the same way.
    const log = reread(h.lines);
    expect(log.matchEnd?.stalls).toEqual(end.stalls);
    expect(isValidLog(log, NO_EXCLUSIONS)).toBe(false);
  });

  it('keeps a match valid through normal jitter under the threshold (no stalls field)', async () => {
    const h = await harness(idle, (c) => fakeDecider(c, () => ({ latencyMs: 30, choice: right })));
    const prng = createPrng(99);
    let worst = 0;
    while (!h.runner.done) {
      const due = h.runner.nextTickDueMs();
      // Up to 240 ms late: a busy event loop or a GC pause, never a stall.
      await h.clock.advanceTo(due + nextBelow(prng, 241));
      worst = Math.max(worst, h.clock.now() - due);
      h.runner.advance(h.clock.now());
    }
    const end = h.lines.at(-1) as MatchEndLine;
    expect(worst).toBeGreaterThan(200);
    expect(worst).toBeLessThanOrEqual(REALTIME_STALL_MS);
    expect(end.valid).toBe(true);
    expect('stalls' in end).toBe(false);
  });

  it('counts a call more than 250 ms late as a stall, and exactly 250 ms as jitter', async () => {
    expect(REALTIME_STALL_MS).toBe(250);
    const at = async (lateMs: number) => {
      const h = await harness(idle, idle);
      await h.runUntilTick(60);
      await h.clock.advanceTo(h.runner.nextTickDueMs() + lateMs);
      h.runner.advance(h.clock.now());
      await h.runUntilTick(Number.POSITIVE_INFINITY);
      return h.lines.at(-1) as MatchEndLine;
    };
    expect((await at(250)).stalls).toBeUndefined();
    expect((await at(251)).stalls).toEqual([{ atTick: 60, gapMs: 251 }]);
  });

  it('does not call a slow tick rate a stall: it measures lateness, not the time between calls', async () => {
    // 2 Hz: the driver calls advance every 500 ms, on time.
    const slow: Game = { ...counterRealtime, cadence: { kind: 'realtime', tickRate: 2 } };
    const h = await harness(idle, idle, { game: slow, config: { windows: 1 } });
    await h.runUntilTick(Number.POSITIVE_INFINITY);
    const end = h.lines.at(-1) as MatchEndLine;
    expect(end.totalTicks).toBe(30);
    expect(end.valid).toBe(true);
    expect(end.stalls).toBeUndefined();
  });

  it('marks a match invalid when a provider seat made no decisions (0 misses of 0)', async () => {
    // Seat 0's warm-up answers; its first request is still out when the 0.5 s match ends.
    const slowFirst = (c: SimClock) =>
      fakeDecider(c, (n) => (n === 0 ? { latencyMs: 10 } : { latencyMs: 900 }));
    const h = await harness(slowFirst, idle, {
      config: { windows: 1 },
      seats: [providerMeta(), baselineMeta()],
    });
    await h.runUntilTick(Number.POSITIVE_INFINITY);
    const end = h.lines.at(-1) as MatchEndLine;
    expect(h.decisions(0).every((l) => l.error === MATCH_OVER)).toBe(true);
    expect(end.decisions[0]).toBe(0);
    expect(end.missRates).toEqual([0, 0]);
    expect(end.valid).toBe(false);
    expect(end.stalls).toBeUndefined();
    expect(isValidLog(reread(h.lines), NO_EXCLUSIONS)).toBe(false);
    // A baseline seat with no decisions: the defensive check is for provider seats only.
    const b = await harness((c) => fakeDecider(c, () => ({ latencyMs: 900 })), idle, {
      config: { windows: 1 },
    });
    await b.runUntilTick(Number.POSITIVE_INFINITY);
    const bEnd = b.lines.at(-1) as MatchEndLine;
    expect(bEnd.decisions[0]).toBe(0);
    expect(bEnd.valid).toBe(true);
  });
});
