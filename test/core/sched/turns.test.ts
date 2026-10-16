import { describe, expect, it } from 'vitest';
import { orderOptions, OPTION_ORDER_RULE } from '../../../src/core/classifier/order.js';
import { promptConfigHash } from '../../../src/core/classifier/prompt.js';
import { createRandomDecider, randomDeciderSeed } from '../../../src/core/classifier/random.js';
import {
  REFUSAL_ERROR,
  type Decider,
  type Question,
  type Seat,
} from '../../../src/core/classifier/types.js';
import type { TurnGame } from '../../../src/core/game.js';
import { parseMatchLog } from '../../../src/core/log/read.js';
import type { HeaderLine } from '../../../src/core/log/schema.js';
import { NO_EXCLUSIONS } from '../../../src/core/results/excluded.js';
import { TURN_STALL_SLACK_MS, WarmupError, type SeatMeta } from '../../../src/core/sched/shared.js';
import { BACKOFF_MISS, createTurnRunner } from '../../../src/core/sched/turns.js';
import { isValidLog } from '../../../src/core/sched/validity.js';
import type { Clock } from '../../../src/core/util/clock.js';
import { createPrng } from '../../../src/core/util/prng.js';
import {
  counterTurns,
  type CounterTurnsConfig,
  type CounterTurnsState,
  type CounterTurnsView,
} from '../games/counter-turns.js';
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

type Game = TurnGame<CounterTurnsState, CounterTurnsConfig>;
const IDS = ['a', 'b', 'c', 'd'] as const;

const right = (state: unknown): string => {
  const { target } = state as CounterTurnsView;
  if (target === null) throw new Error('no target');
  return IDS[target % 4] ?? 'a';
};
const wrong = (state: unknown): string => {
  const r = right(state);
  return r === 'a' ? 'b' : 'a';
};
const turnOf = (state: unknown): number => (state as CounterTurnsView).turn;

interface Opts {
  seed?: number;
  seats?: [SeatMeta, SeatMeta];
  game?: Game;
  config?: CounterTurnsConfig;
}

async function play(
  a: (clock: SimClock) => Decider,
  b: (clock: SimClock) => Decider,
  opts: Opts = {},
) {
  const clock = new SimClock();
  const sink = memorySink();
  const runner = createTurnRunner({
    game: opts.game ?? counterTurns,
    seed: opts.seed ?? 11,
    config: opts.config ?? counterTurns.defaultConfig,
    seats: opts.seats ?? [baselineMeta(), baselineMeta()],
    deciders: [a(clock), b(clock)],
    clock,
    sink,
    ...COMMON,
  });
  const end = await settleOnSim(clock, runner.run());
  return {
    clock,
    runner,
    sink,
    end,
    lines: sink.lines,
    decisions: (seat?: Seat) => decisionsOf(sink.lines, seat),
  };
}

const scripted =
  (script: (n: number) => FakeStep, keep?: (d: FakeDecider) => void) => (clock: SimClock) => {
    const d = fakeDecider(clock, script);
    keep?.(d);
    return d;
  };

describe('turn runner', () => {
  it('asks both seats each turn, applies both answers and logs correct, sent = applied = turn', async () => {
    let a: FakeDecider | undefined;
    let b: FakeDecider | undefined;
    const h = await play(
      scripted(
        () => ({ latencyMs: 30, choice: right }),
        (d) => (a = d),
      ),
      scripted(
        () => ({ latencyMs: 50, choice: wrong }),
        (d) => (b = d),
      ),
    );
    const d0 = h.decisions(0);
    const d1 = h.decisions(1);
    expect(d0).toHaveLength(10);
    expect(d1).toHaveLength(10);
    d0.forEach((l, turn) => {
      expect(l).toEqual({
        type: 'decision',
        seat: 0,
        seq: turn,
        questionKey: `t${String(turn)}`,
        sentTick: turn,
        appliedTick: turn,
        latencyMs: 30,
        choice: l.choice,
        probabilities: null,
        confidence: null,
        inputTokens: null,
        costUsd: 0,
        status: 'ok',
        correct: true,
      });
    });
    expect(d1.every((l) => l.status === 'ok' && l.correct === false)).toBe(true);
    expect(h.runner.state.scores).toEqual([10, 0]);
    // The turn resolves once both answered (50 ms), then the 100 ms floor: next turn at 150 ms.
    expect(a?.calls.map((c) => c.at).slice(0, 3)).toEqual([0, 150, 300]);
    expect(b?.calls.map((c) => c.at).slice(0, 3)).toEqual([0, 150, 300]);
    expect(a?.calls.map((c) => turnOf(c.state))).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(h.end).toEqual({
      type: 'match_end',
      winner: 0,
      scores: [10, 0],
      totalTicks: 10,
      finalStateHash: counterTurns.hash(h.runner.state),
      valid: true,
      missRates: [0, 0],
      timeoutRates: [0, 0],
      refusalRates: [0, 0],
      decisions: [10, 10],
      costUsd: 0,
    });
    expect(h.lines.at(-1)).toBe(h.end);
    expect(h.runner.result).toBe(h.end);
  });

  it('gives each seat its own view', async () => {
    let b: FakeDecider | undefined;
    const h = await play(
      scripted(() => ({ latencyMs: 10 })),
      scripted(
        () => ({ latencyMs: 10 }),
        (d) => (b = d),
      ),
      { config: { turns: 2 } },
    );
    expect(b?.calls[1]?.state).toEqual({
      seat: 1,
      turn: 1,
      turns: 2,
      target: h.runner.state.targets[1],
    });
  });

  it('writes the turn events with tick = turn, after that turn’s decision lines', async () => {
    const h = await play(
      scripted(() => ({ latencyMs: 10 })),
      scripted(() => ({ latencyMs: 10 })),
      { config: { turns: 2 } },
    );
    expect(h.lines.map((l) => l.type)).toEqual([
      'header',
      'decision',
      'decision',
      'event',
      'decision',
      'decision',
      'event',
      'match_end',
    ]);
    const events = h.lines.filter((l) => l.type === 'event');
    expect(events.map((e) => e.tick)).toEqual([0, 1]);
    expect(events[0]?.game).toMatchObject({ kind: 'turn', turn: 0 });
  });

  it('resolves a turn at the deadline when one seat times out; the miss scores nothing', async () => {
    let a: FakeDecider | undefined;
    const h = await play(
      scripted(
        () => ({ latencyMs: 20, choice: right, costUsd: 0.001 }),
        (d) => (a = d),
      ),
      scripted((n) =>
        n === 0
          ? { latencyMs: 30, choice: right, costUsd: 0.002 }
          : { latencyMs: 5000, choice: right },
      ),
      { config: { turns: 3 } },
    );
    const d1 = h.decisions(1);
    expect(d1[0]).toMatchObject({ status: 'ok', correct: true });
    expect(d1[1]).toEqual({
      type: 'decision',
      seat: 1,
      seq: 1,
      questionKey: 't1',
      sentTick: 1,
      appliedTick: 1,
      latencyMs: 1000,
      choice: null,
      probabilities: null,
      confidence: null,
      inputTokens: null,
      costUsd: 0.002,
      costEstimated: true,
      status: 'timeout',
      error: 'timeout',
    });
    // Turn 1 starts at 130 ms and resolves at its deadline, 1130 ms; turn 2 at 1230 ms.
    expect(a?.calls.map((c) => c.at)).toEqual([0, 130, 1230]);
    expect(h.runner.state.scores).toEqual([3, 1]);
    expect(h.end.missRates[1]).toBeCloseTo(2 / 3);
    expect(h.end.timeoutRates?.[1]).toBeCloseTo(2 / 3);
    // A turn-game timeout scores 0 but does not count toward validity.
    expect(h.end.valid).toBe(true);
  });

  it('resolves at the deadline when both time out, and passes null for both', async () => {
    let a: FakeDecider | undefined;
    let b: FakeDecider | undefined;
    const h = await play(
      scripted(
        () => ({ latencyMs: 1500 }),
        (d) => (a = d),
      ),
      scripted(
        () => ({ latencyMs: 2500 }),
        (d) => (b = d),
      ),
      { config: { turns: 2 } },
    );
    expect(h.decisions().map((l) => [l.seat, l.status, l.latencyMs, l.correct])).toEqual([
      [0, 'timeout', 1000, undefined],
      [1, 'timeout', 1000, undefined],
      [0, 'timeout', 1000, undefined],
      [1, 'timeout', 1000, undefined],
    ]);
    expect(a?.calls.map((c) => c.at)).toEqual([0, 1100]);
    expect(b?.calls.map((c) => c.at)).toEqual([0, 1100]);
    expect(a?.calls.every((c) => c.signal.aborted)).toBe(true);
    expect(h.runner.state.scores).toEqual([0, 0]);
    expect(h.end).toMatchObject({
      winner: 'draw',
      missRates: [1, 1],
      timeoutRates: [1, 1],
      valid: true,
    });
  });

  it('keeps a match with one timeout per seat valid, and reports the timeouts', async () => {
    const h = await play(
      scripted((n) => (n === 3 ? { latencyMs: 1500, choice: right } : { latencyMs: 20 })),
      scripted((n) => (n === 7 ? { latencyMs: 4000 } : { latencyMs: 30 })),
    );
    expect(h.decisions(0)[3]?.status).toBe('timeout');
    expect(h.decisions(1)[7]?.status).toBe('timeout');
    expect(h.end).toMatchObject({
      valid: true,
      missRates: [0.1, 0.1],
      timeoutRates: [0.1, 0.1],
      decisions: [10, 10],
    });
  });

  it('flags a match invalid when a seat’s transport errors pass 2%', async () => {
    // One HTTP 400 in 10 asks (10%): invalid, while the other seat's timeout is not counted.
    const h = await play(
      scripted((n) => (n === 2 ? { latencyMs: 5, error: 'http 400: bad' } : { latencyMs: 20 })),
      scripted((n) => (n === 4 ? { latencyMs: 3000 } : { latencyMs: 20 })),
    );
    expect(h.decisions(0)[2]).toMatchObject({ status: 'error', error: 'http 400: bad' });
    expect(h.end).toMatchObject({
      valid: false,
      missRates: [0.1, 0.1],
      timeoutRates: [0, 0.1],
    });
  });

  it('scores a refusal as nothing (null to applyTurn, no correct) and keeps the match valid', async () => {
    // Seat 0 refuses on turns 1, 4 and 7 (30% of its asks), each billed.
    const h = await play(
      scripted((n) =>
        n % 3 === 1
          ? { latencyMs: 20, refusal: true, costUsd: 0.001 }
          : { latencyMs: 20, choice: right },
      ),
      scripted(() => ({ latencyMs: 30, choice: right })),
    );
    const d0 = h.decisions(0);
    expect(d0.filter((l) => l.status === 'refusal').map((l) => l.sentTick)).toEqual([1, 4, 7]);
    expect(d0[1]).toEqual({
      type: 'decision',
      seat: 0,
      seq: 1,
      questionKey: 't1',
      sentTick: 1,
      appliedTick: 1,
      latencyMs: 20,
      choice: null,
      probabilities: null,
      confidence: null,
      inputTokens: null,
      costUsd: 0.001,
      status: 'refusal',
      error: REFUSAL_ERROR,
    });
    // As a miss always did: the refused turns score 0 for that seat.
    expect(h.runner.state.scores).toEqual([7, 10]);
    expect(h.end).toMatchObject({
      valid: true,
      missRates: [0, 0],
      timeoutRates: [0, 0],
      refusalRates: [0.3, 0],
      decisions: [10, 10],
    });
    expect(h.end.costUsd).toBeCloseTo(0.003, 12);
  });

  it('still flags a match invalid on transport errors when the other seat refuses', async () => {
    const h = await play(
      scripted((n) => (n === 5 ? { latencyMs: 5, error: 'network: reset' } : { latencyMs: 20 })),
      scripted((n) => (n % 2 === 0 ? { latencyMs: 20, refusal: true } : { latencyMs: 20 })),
    );
    expect(h.end).toMatchObject({
      valid: false,
      missRates: [0.1, 0],
      refusalRates: [0, 0.5],
    });
  });

  it('counts 429/5xx errors and backoff misses as transport failures', async () => {
    const h = await play(
      scripted((n) => ({ latencyMs: 0, error: n % 2 ? 'http 503: down' : 'http 429: slow' })),
      scripted(() => ({ latencyMs: 10, choice: right })),
      { config: { turns: 14 } },
    );
    const d0 = h.decisions(0);
    expect(d0.some((l) => l.error === BACKOFF_MISS)).toBe(true);
    expect(d0.every((l) => l.status === 'error')).toBe(true);
    expect(h.end).toMatchObject({ valid: false, missRates: [1, 0], timeoutRates: [0, 0] });
  });

  it('gives both seats the same deadline, even a seat that sent late after a backoff', async () => {
    let a: FakeDecider | undefined;
    let b: FakeDecider | undefined;
    await play(
      // Seat 0: a 429 on turn 0 (backoff until 250 ms), then hangs.
      scripted(
        (n) => (n === 0 ? { latencyMs: 0, error: 'http 429: slow' } : { latencyMs: 1e6 }),
        (d) => (a = d),
      ),
      // Seat 1: quick on turn 0, then hangs.
      scripted(
        (n) => ({ latencyMs: n === 0 ? 10 : 1e6 }),
        (d) => (b = d),
      ),
      { config: { turns: 2 } },
    );
    // Turn 1 starts at 110 ms (10 + floor), deadline 1110 ms. Seat 1 sends at 110; seat 0 waits
    // out its backoff and sends at 250. Both are cut off at 1110.
    expect(b?.calls[1]?.at).toBe(110);
    expect(a?.calls[1]?.at).toBe(250);
    expect(a?.calls[1]?.abortedAt).toBe(1110);
    expect(b?.calls[1]?.abortedAt).toBe(1110);
  });

  it('backs a seat off on 429/5xx (250, 500, 1000, 2000 ms) and misses turns it cannot ask in time', async () => {
    let a: FakeDecider | undefined;
    const h = await play(
      scripted(
        (n) => ({ latencyMs: 0, error: n % 2 ? 'http 503: down' : 'http 429: slow' }),
        (d) => (a = d),
      ),
      scripted(() => ({ latencyMs: 10, choice: right })),
      { config: { turns: 14 } },
    );
    const at = a?.calls.map((c) => c.at) ?? [];
    // Errors at 0, 250, 750, 1750: each waits out a doubling backoff from the last error.
    expect(at.slice(0, 4)).toEqual([0, 250, 750, 1750]);
    const d0 = h.decisions(0);
    expect(d0.slice(0, 4).every((l) => l.status === 'error' && l.error?.startsWith('http'))).toBe(
      true,
    );
    // After the 1750 ms error the backoff is 2000 ms (until 3750). Turn 4 starts at 1850 (deadline
    // 2850) and turn 5 at 1960 (deadline 2960): no time to ask, so a miss with no request sent.
    expect(d0[4]).toMatchObject({
      seq: 4,
      sentTick: 4,
      appliedTick: 4,
      status: 'error',
      error: BACKOFF_MISS,
      latencyMs: 0,
      costUsd: 0,
    });
    expect(d0[4]?.costEstimated).toBeUndefined();
    // Turns 4–12 miss. Turn 13 starts at 2840 (deadline 3840): seat 0 asks at 3750, the backoff's end.
    expect(d0.slice(4, 13).every((l) => l.error === BACKOFF_MISS)).toBe(true);
    expect(at.slice(4)).toEqual([3750]);
    // The other seat is unaffected: one ok answer per turn.
    expect(h.decisions(1).map((l) => l.status)).toEqual(Array(14).fill('ok'));
  });

  it('passes each request its log seq, so snapshots are named by it even after backoff misses', async () => {
    let a: FakeDecider | undefined;
    const raw = { request: 'req', response: 'res' };
    const h = await play(
      scripted(
        (n) => ({ latencyMs: 0, error: n % 2 ? 'http 503: down' : 'http 429: slow', raw }),
        (d) => (a = d),
      ),
      scripted(() => ({ latencyMs: 10, choice: right, raw })),
      { config: { turns: 14 } },
    );
    // Turns 4–12 are backoff misses: they use seqs 4–12 but send nothing.
    const sent = h
      .decisions(0)
      .filter((l) => l.error !== BACKOFF_MISS)
      .map((l) => l.seq);
    expect(sent).toEqual([0, 1, 2, 3, 13]);
    expect(a?.calls.map((c) => c.ctx?.seq)).toEqual(sent);
    expect(h.sink.snapshots.filter((x) => x.seat === 0).map((x) => x.seq)).toEqual(sent);
    expect(h.sink.snapshots.filter((x) => x.seat === 1).map((x) => x.seq)).toEqual(
      h.decisions(1).map((l) => l.seq),
    );
  });

  it('resets the backoff after an ok answer, and does not back off on other errors', async () => {
    let a: FakeDecider | undefined;
    await play(
      scripted(
        (n) =>
          n === 0
            ? { latencyMs: 0, error: 'http 429: slow' }
            : n === 2
              ? { latencyMs: 0, error: 'http 400: bad' }
              : { latencyMs: 10 },
        (d) => (a = d),
      ),
      scripted(() => ({ latencyMs: 10 })),
      { config: { turns: 4 } },
    );
    // Turn 0: 429 at 0 → backoff to 250. Turn 1 starts at 110, seat 0 waits to 250, ok at 260.
    // Turn 2 at 360: a 400 (no backoff). Turn 3 at 470 (10 ms for seat 1, then the floor).
    expect(a?.calls.map((c) => c.at)).toEqual([0, 250, 360, 470]);
  });

  it('logs a thrown decider and an ok answer without a choice as errors', async () => {
    const odd: Decider = {
      player: 'odd',
      decide: () =>
        Promise.resolve({
          choice: null,
          probabilities: null,
          confidence: null,
          latencyMs: 3,
          inputTokens: null,
          costUsd: 0,
          status: 'ok',
        }),
    };
    const h = await play(
      scripted(() => ({ latencyMs: 5, throws: true })),
      () => odd,
      { config: { turns: 1 } },
    );
    expect(h.decisions(0)[0]).toMatchObject({ status: 'error', error: 'decider threw: boom' });
    expect(h.decisions(1)[0]).toMatchObject({
      status: 'error',
      error: 'ok answer without a choice',
    });
    expect(h.runner.state.scores).toEqual([0, 0]);
  });

  it('logs a decider that throws synchronously from decide() as an error, and plays on', async () => {
    const sync: Decider = {
      player: 'sync',
      decide: () => {
        throw new Error('sync boom');
      },
    };
    const h = await play(
      () => sync,
      scripted(() => ({ latencyMs: 5, choice: right })),
      { config: { turns: 2 } },
    );
    expect(h.decisions(0)).toHaveLength(2);
    for (const d of h.decisions(0)) {
      expect(d).toMatchObject({ status: 'error', error: 'decider threw: sync boom' });
    }
    expect(h.runner.state.scores).toEqual([0, 2]);
  });

  it('stops the match when the game reuses a question key for different options', async () => {
    // A buggy game: every turn is asked as key `same`, but turn 1 drops an option.
    const reuse: Game = {
      ...counterTurns,
      question(s, seat) {
        const asked = counterTurns.question(s, seat);
        if (!asked) return null;
        const options = s.turn === 0 ? asked.question.options : asked.question.options.slice(0, 3);
        return { key: 'same', question: { ...asked.question, options } };
      },
    };
    const clock = new SimClock();
    const runner = createTurnRunner({
      game: reuse,
      seed: 3,
      config: { turns: 3 },
      seats: [baselineMeta(), baselineMeta()],
      deciders: [
        fakeDecider(clock, () => ({ latencyMs: 5 })),
        fakeDecider(clock, () => ({ latencyMs: 5 })),
      ],
      clock,
      sink: memorySink(),
      ...COMMON,
    });
    await expect(settleOnSim(clock, runner.run())).rejects.toThrow(
      /question key "same" was reused for a different question/,
    );
    expect(runner.state.turn).toBe(1);
  });

  it('hands both seats the identical ordered question object for a key', async () => {
    let a: FakeDecider | undefined;
    let b: FakeDecider | undefined;
    const seed = 4242;
    await play(
      scripted(
        () => ({ latencyMs: 10 }),
        (d) => (a = d),
      ),
      scripted(
        () => ({ latencyMs: 15 }),
        (d) => (b = d),
      ),
      { seed, config: { turns: 5 } },
    );
    const canonical = counterTurns.question(counterTurns.create(seed, { turns: 5 }), 0);
    if (!canonical) throw new Error('no question');
    const seen = new Set<Question>();
    for (let turn = 0; turn < 5; turn++) {
      const qa = a?.calls[turn]?.question;
      const qb = b?.calls[turn]?.question;
      expect(qa).toBeDefined();
      expect(qa).toBe(qb);
      expect(qa).toEqual(orderOptions(canonical.question, seed, `t${String(turn)}`));
      if (qa) seen.add(qa);
    }
    expect(seen.size).toBe(5);
  });

  it('feeds applyTurn the logged (rounded) latency, so a replay from the log matches', async () => {
    const h = await play(
      scripted(() => ({ latencyMs: 12.46, choice: right })),
      scripted(() => ({ latencyMs: 20, choice: wrong })),
      { config: { turns: 1 } },
    );
    expect(h.decisions(0)[0]?.latencyMs).toBe(12.5);
    expect(h.runner.state.correctLatencyMs[0]).toEqual([13]);
  });

  it('skips a seat the game has no question for (no request, no line, null answer)', async () => {
    let b: FakeDecider | undefined;
    const game: Game = {
      ...counterTurns,
      question: (s, seat) => (seat === 1 && s.turn === 0 ? null : counterTurns.question(s, seat)),
    };
    const h = await play(
      scripted(() => ({ latencyMs: 10 })),
      scripted(
        () => ({ latencyMs: 10 }),
        (d) => (b = d),
      ),
      { game, config: { turns: 2 } },
    );
    expect(b?.calls.map((c) => turnOf(c.state))).toEqual([1]);
    expect(h.decisions(1).map((l) => [l.seq, l.questionKey])).toEqual([[0, 't1']]);
  });

  it('stops at game.maxTurns even if the game never says it is over', async () => {
    const game: Game = {
      ...counterTurns,
      result: (s) => ({ over: false, winner: null, scores: [s.scores[0], s.scores[1]] }),
    };
    const h = await play(
      scripted(() => ({ latencyMs: 10 })),
      scripted(() => ({ latencyMs: 10 })),
      { game, config: { turns: 3 } },
    );
    expect(h.end).toMatchObject({ totalTicks: 3, winner: null });
  });

  it('exposes the latest decision line per seat', async () => {
    const clock = new SimClock();
    const runner = createTurnRunner({
      game: counterTurns,
      seed: 1,
      config: { turns: 2 },
      seats: [baselineMeta(), baselineMeta()],
      deciders: [
        fakeDecider(clock, () => ({ latencyMs: 10 })),
        fakeDecider(clock, () => ({ latencyMs: 10 })),
      ],
      clock,
      sink: memorySink(),
      ...COMMON,
    });
    expect(runner.latestDecisions).toEqual([null, null]);
    await settleOnSim(clock, runner.run());
    expect(runner.latestDecisions[0]).toMatchObject({ seat: 0, seq: 1, questionKey: 't1' });
    expect(runner.latestDecisions[1]).toMatchObject({ seat: 1, seq: 1, questionKey: 't1' });
    await expect(runner.start()).rejects.toThrow(/already started/);
  });

  it('writes a v2 header for the turn cadence', async () => {
    const h = await play(
      scripted(() => ({ latencyMs: 1 })),
      scripted(() => ({ latencyMs: 1 })),
      {
        seed: 5,
        config: { turns: 1 },
      },
    );
    const header = h.lines[0] as HeaderLine;
    expect(header).toMatchObject({
      type: 'header',
      schemaVersion: 2,
      game: 'counter_turns',
      gameVersion: 1,
      seed: 5,
      cadence: { kind: 'turns' },
      timing: { floorMs: 100, timeoutMs: 1000 },
      promptConfigHash: promptConfigHash(counterTurns.promptConfig),
      optionOrderRule: OPTION_ORDER_RULE,
      config: { turns: 1 },
    });
  });

  it('is deterministic: same seed and seeded deciders give identical logs and final hash', async () => {
    const random = (seat: Seat) => (clock: SimClock) =>
      createRandomDecider({ prng: createPrng(randomDeciderSeed(77, seat)), clock });
    const one = await play(random(0), random(1), { seed: 77 });
    const two = await play(random(0), random(1), { seed: 77 });
    expect(two.lines).toEqual(one.lines);
    expect(one.end.finalStateHash).toBe(counterTurns.hash(one.runner.state));
    const other = await play(random(0), random(1), { seed: 78 });
    expect(other.end.finalStateHash).not.toBe(one.end.finalStateHash);
  });
});

describe('turn stalls (the machine paused mid-turn)', () => {
  /**
   * A SimClock whose `now()` can jump ahead, as a machine waking from sleep sees it; sleepers
   * keep their simulated due times.
   */
  function jumpingClock() {
    const sim = new SimClock();
    let offset = 0;
    const clock: Clock = {
      now: () => sim.now() + offset,
      sleep: (ms, signal) => sim.sleep(ms, signal),
    };
    return {
      sim,
      clock,
      jump: (ms: number) => {
        offset += ms;
      },
    };
  }

  async function playWithJump(jumpOnCall: number | null, jumpMs: number) {
    const { sim, clock, jump } = jumpingClock();
    const sink = memorySink();
    const decider = (seat: Seat) =>
      fakeDecider(sim, (n) => {
        if (seat === 0 && n === jumpOnCall) jump(jumpMs);
        return { latencyMs: 30, choice: right };
      });
    const runner = createTurnRunner({
      game: counterTurns,
      seed: 11,
      config: counterTurns.defaultConfig,
      seats: [baselineMeta(), baselineMeta()],
      deciders: [decider(0), decider(1)],
      clock,
      sink,
      ...COMMON,
    });
    const end = await settleOnSim(sim, runner.run());
    return { end, lines: sink.lines };
  }

  it('marks a turn that ends 3 s or more past its deadline as a stall: invalid, recorded', async () => {
    expect(TURN_STALL_SLACK_MS).toBe(3000);
    // On turn 4 the clock jumps 5 s while seat 0's request is out.
    const { end, lines } = await playWithJump(4, 5000);
    // 30 ms answer + 5,000 ms jump − the 1,000 ms deadline.
    expect(end.stalls).toEqual([{ atTick: 4, gapMs: 4030 }]);
    expect(end.valid).toBe(false);
    expect(end.missRates).toEqual([0, 0]);
    const log = parseMatchLog(lines.map((l) => JSON.stringify(l)).join('\n'));
    expect(log.matchEnd?.stalls).toEqual(end.stalls);
    expect(isValidLog(log, NO_EXCLUSIONS)).toBe(false);
  });

  it('allows a turn to run past its deadline by up to the slack', async () => {
    // A 3.5 s jump: 30 + 3,500 − 1,000 = 2,530 ms late, under 3 s.
    const { end } = await playWithJump(4, 3500);
    expect(end.valid).toBe(true);
    expect(end.stalls).toBeUndefined();
    const clean = await playWithJump(null, 0);
    expect(clean.end.valid).toBe(true);
    expect('stalls' in clean.end).toBe(false);
  });
});

describe('turn warm-up and spend', () => {
  it('warms up provider seats, seeds the estimated cost from it, and adds it to the total', async () => {
    const h = await play(
      scripted((n) =>
        n === 0 ? { latencyMs: 400, costUsd: 0.004, modelVersion: 'v9' } : { latencyMs: 5000 },
      ),
      scripted(() => ({ latencyMs: 10 })),
      { seats: [providerMeta('p0'), baselineMeta()], config: { turns: 2 } },
    );
    const header = h.lines[0] as HeaderLine;
    expect(header.seats[0]).toMatchObject({
      player: 'p0',
      modelVersion: 'v9',
      warmup: { latencyMs: 400, status: 'ok', costUsd: 0.004 },
    });
    expect(header.seats[1].warmup).toBeNull();
    expect(h.decisions(0).map((l) => [l.status, l.costUsd, l.costEstimated])).toEqual([
      ['timeout', 0.004, true],
      ['timeout', 0.004, true],
    ]);
    expect(h.end.costUsd).toBeCloseTo(0.004 * 3, 12);
  });

  it('plays the match when a provider warm-up is refused, logging the warm-up as refusal', async () => {
    const h = await play(
      scripted((n) =>
        n === 0
          ? { latencyMs: 250, refusal: true, costUsd: 0.002, modelVersion: 'v7' }
          : { latencyMs: 20, choice: right, costUsd: 0.001 },
      ),
      scripted(() => ({ latencyMs: 30, choice: right })),
      { seats: [providerMeta('p0'), baselineMeta()], config: { turns: 3 } },
    );
    const header = h.lines[0] as HeaderLine;
    expect(header.seats[0]).toMatchObject({
      modelVersion: 'v7',
      warmup: { latencyMs: 250, status: 'refusal', costUsd: 0.002, error: REFUSAL_ERROR },
    });
    expect(h.decisions(0).map((l) => l.status)).toEqual(['ok', 'ok', 'ok']);
    expect(h.end).toMatchObject({ valid: true, scores: [3, 3], refusalRates: [0, 0] });
    // The refused warm-up is billed like any warm-up.
    expect(h.end.costUsd).toBeCloseTo(0.002 + 3 * 0.001, 12);
  });

  it('still refuses to start on a network error in the warm-up', async () => {
    const clock = new SimClock();
    const sink = memorySink();
    const runner = createTurnRunner({
      game: counterTurns,
      seed: 1,
      config: { turns: 2 },
      seats: [providerMeta('p0'), providerMeta('p1')],
      deciders: [
        fakeDecider(clock, () => ({ latencyMs: 10, error: 'network: fetch failed' })),
        fakeDecider(clock, () => ({ latencyMs: 30, refusal: true })),
      ],
      clock,
      sink,
      ...COMMON,
    });
    const run = settleOnSim(clock, runner.run());
    await expect(run).rejects.toBeInstanceOf(WarmupError);
    await expect(run).rejects.toThrow(
      /warm-up failed, match not started: p0 \(seat 0\): error: network: fetch failed$/,
    );
    expect(sink.lines).toHaveLength(0);
  });

  it('refuses to start, writing nothing, when a provider warm-up fails', async () => {
    const clock = new SimClock();
    const sink = memorySink();
    const runner = createTurnRunner({
      game: counterTurns,
      seed: 1,
      config: { turns: 2 },
      seats: [providerMeta('p0'), providerMeta('p1')],
      deciders: [
        fakeDecider(clock, () => ({ latencyMs: 10 })),
        fakeDecider(clock, () => ({ latencyMs: 30, error: 'http 401: nope' })),
      ],
      clock,
      sink,
      ...COMMON,
    });
    const run = settleOnSim(clock, runner.run());
    await expect(run).rejects.toBeInstanceOf(WarmupError);
    await expect(run).rejects.toThrow(/warm-up failed.*p1 \(seat 1\): error: http 401: nope/);
    expect(sink.lines).toHaveLength(0);
  });
});
