import { describe, expect, it } from 'vitest';
import { OPTION_ORDER_RULE, orderOptions } from '../../../src/core/classifier/order.js';
import { promptConfigHash } from '../../../src/core/classifier/prompt.js';
import type { DecisionResult } from '../../../src/core/classifier/types.js';
import { REFUSAL_ERROR, emptyResult } from '../../../src/core/classifier/types.js';
import { RANDOM_BASELINE } from '../../../src/core/classifier/players.js';
import { PROVIDERS } from '../../../src/core/classifier/providers.js';
import {
  WARMUP_TIMEOUT_MS,
  WarmupError,
  buildHeader,
  createLogBook,
  createQuestionOrder,
  decisionLine,
  logLatency,
  nextBackoffMs,
  playerMeta,
  warmUp,
  warmUpSucceeded,
  withEstimatedCost,
  type AnyGame,
  type SeatMeta,
} from '../../../src/core/sched/shared.js';
import { counterRealtime } from '../games/counter-realtime.js';
import { counterTurns } from '../games/counter-turns.js';
import {
  SimClock,
  baselineMeta,
  fakeDecider,
  memorySink,
  providerMeta,
  settleOnSim,
} from './helpers.js';

describe('warmUp', () => {
  it("asks the game's first question, ordered, for seat 0's view, and returns the record", async () => {
    const clock = new SimClock();
    const d = fakeDecider(clock, () => ({ latencyMs: 123.456, costUsd: 0.01, modelVersion: 'mv' }));
    const config = { turns: 3 };
    const w = await settleOnSim(clock, warmUp(d, counterTurns, 42, config, clock));
    expect(w).toEqual({
      record: { latencyMs: 123.5, status: 'ok', costUsd: 0.01 },
      modelVersion: 'mv',
    });
    const state = counterTurns.create(42, config);
    const asked = counterTurns.question(state, 0);
    if (!asked) throw new Error('no question');
    expect(d.calls[0]?.state).toEqual(counterTurns.view(state, 0));
    expect(d.calls[0]?.question).toEqual(orderOptions(asked.question, 42, asked.key));
    expect(d.calls[0]?.signal.aborted).toBe(true); // settled: the signal is released
    expect(d.calls[0]?.ctx).toBeUndefined(); // no seq: the warm-up is not a logged decision
  });

  it('throws WarmupError carrying the record when the answer is not ok', async () => {
    const clock = new SimClock();
    const d = fakeDecider(clock, () => ({ latencyMs: 5, error: 'http 500: down' }), 'px');
    const p = settleOnSim(clock, warmUp(d, counterRealtime, 1, { windows: 1 }, clock));
    await expect(p).rejects.toBeInstanceOf(WarmupError);
    await expect(p).rejects.toThrow('warm-up failed: px: error: http 500: down');
    const err = await p.catch((e: unknown) => e);
    expect((err as WarmupError).record).toEqual({
      latencyMs: 5,
      status: 'error',
      costUsd: 0,
      error: 'http 500: down',
    });
  });

  it('counts a refusal as a successful warm-up and returns its record and model version', async () => {
    const clock = new SimClock();
    const d = fakeDecider(
      clock,
      () => ({ latencyMs: 210, refusal: true, costUsd: 0.0000148, modelVersion: 'gpt-x' }),
      'px',
    );
    const w = await settleOnSim(clock, warmUp(d, counterRealtime, 1, { windows: 1 }, clock));
    expect(w).toEqual({
      record: { latencyMs: 210, status: 'refusal', costUsd: 0.0000148, error: REFUSAL_ERROR },
      modelVersion: 'gpt-x',
    });
    expect(warmUpSucceeded('ok')).toBe(true);
    expect(warmUpSucceeded('refusal')).toBe(true);
    expect(warmUpSucceeded('error')).toBe(false);
    expect(warmUpSucceeded('timeout')).toBe(false);
  });

  it('still fails on a network error or a malformed answer, as before', async () => {
    for (const error of ['network: fetch failed', 'invalid answer: no answers in body']) {
      const clock = new SimClock();
      const d = fakeDecider(clock, () => ({ latencyMs: 5, error }), 'px');
      const p = settleOnSim(clock, warmUp(d, counterRealtime, 1, { windows: 1 }, clock));
      await expect(p).rejects.toBeInstanceOf(WarmupError);
      await expect(p).rejects.toThrow(`warm-up failed: px: error: ${error}`);
    }
  });

  it('times out after 10 s on the injected clock and aborts the call', async () => {
    const clock = new SimClock();
    const d = fakeDecider(clock, () => ({ latencyMs: 1e9 }));
    const p = settleOnSim(clock, warmUp(d, counterRealtime, 1, { windows: 1 }, clock));
    await expect(p).rejects.toThrow(/timeout: warm-up timeout after 10000 ms/);
    expect(clock.now()).toBe(WARMUP_TIMEOUT_MS);
    expect(d.calls[0]?.signal.aborted).toBe(true);
  });

  it('turns a throwing decider into WarmupError', async () => {
    const clock = new SimClock();
    const d = fakeDecider(clock, () => ({ latencyMs: 1, throws: true }));
    const p = settleOnSim(clock, warmUp(d, counterRealtime, 1, { windows: 1 }, clock));
    await expect(p).rejects.toThrow(/error: boom/);
  });

  it('throws WarmupError when the game has no first question', async () => {
    const clock = new SimClock();
    const d = fakeDecider(clock, () => ({ latencyMs: 1 }));
    const game = { ...counterTurns, question: () => null };
    await expect(warmUp(d, game, 1, { turns: 1 }, clock)).rejects.toThrow(/no question for seat 0/);
    expect(d.calls).toHaveLength(0);
  });
});

describe('buildHeader', () => {
  it('builds a v2 header from the game, seats and warm-ups', () => {
    const seats: [SeatMeta, SeatMeta] = [providerMeta('p0'), baselineMeta('b1')];
    const header = buildHeader({
      game: counterRealtime,
      config: { windows: 4 },
      seed: 9,
      matchId: 'm',
      startTime: 't',
      gitCommit: 'g',
      runLocation: 'here',
      runId: 'm-0123456789ab',
      floorMs: 100,
      timeoutMs: 1000,
      seats,
      warmups: [
        { record: { latencyMs: 300, status: 'ok', costUsd: 0.002 }, modelVersion: 'v1' },
        null,
      ],
    });
    expect(header).toEqual({
      type: 'header',
      schemaVersion: 2,
      game: 'counter_realtime',
      gameVersion: 1,
      matchId: 'm',
      startTime: 't',
      gitCommit: 'g',
      seed: 9,
      runLocation: 'here',
      runId: 'm-0123456789ab',
      cadence: { kind: 'realtime', tickRate: 60 },
      timing: { floorMs: 100, timeoutMs: 1000 },
      promptConfigHash: promptConfigHash(counterRealtime.promptConfig),
      optionOrderRule: OPTION_ORDER_RULE,
      config: { windows: 4 },
      seats: [
        {
          seat: 0,
          player: 'p0',
          label: 'p0',
          format: 'systemone',
          hosting: 'vendor-api',
          model: 'm',
          serviceTier: null,
          modelVersion: 'v1',
          price: { inputPerMTokUsd: 1, outputPerMTokUsd: 0, asOf: '2026-10-07' },
          warmup: { latencyMs: 300, status: 'ok', costUsd: 0.002 },
        },
        {
          seat: 1,
          player: 'b1',
          label: 'b1',
          format: null,
          hosting: null,
          model: null,
          serviceTier: null,
          modelVersion: null,
          price: null,
          warmup: null,
        },
      ],
    });
    // The cadence is a copy, not the game's own object.
    expect(header.cadence).not.toBe(counterRealtime.cadence);
  });
});

describe('cost and line helpers', () => {
  const ok: DecisionResult = { ...emptyResult('ok', 10.04, 'up'), costUsd: 0.5 };

  it('estimates an unanswered request at the last ok cost', () => {
    const r = withEstimatedCost(emptyResult('timeout', 1000), 0.003);
    expect(r).toMatchObject({ status: 'timeout', costUsd: 0.003, costEstimated: true });
  });

  it('rounds latency to 0.1 ms', () => {
    expect(logLatency(10.04)).toBe(10);
    expect(logLatency(12.46)).toBe(12.5);
  });

  it('builds decision lines with optional fields only when set', () => {
    const answer = { seat: 1 as const, seq: 2, sentTick: 3, questionKey: 'k', result: ok };
    expect(decisionLine(answer, 'ok', 4)).toEqual({
      type: 'decision',
      seat: 1,
      seq: 2,
      questionKey: 'k',
      sentTick: 3,
      appliedTick: 4,
      latencyMs: 10,
      choice: 'up',
      probabilities: null,
      confidence: null,
      inputTokens: null,
      costUsd: 0.5,
      status: 'ok',
    });
    expect(
      decisionLine(answer, 'dropped', 4, { error: 'dropped: x', correct: false }),
    ).toMatchObject({ status: 'dropped', error: 'dropped: x', correct: false });
    const est = { ...answer, result: withEstimatedCost(emptyResult('timeout', 1000), 0.1) };
    expect(decisionLine(est, 'timeout', null)).toMatchObject({ costEstimated: true });
  });

  it('flags probabilities that lack the choice as partial, keeping them as reported', () => {
    const answer = { seat: 0 as const, seq: 0, sentTick: 1, questionKey: 'k' };
    const partial = { ...ok, probabilities: { down: 0.3, left: 0.2 } };
    const line = decisionLine({ ...answer, result: partial }, 'ok', 2);
    expect(line.probabilities).toEqual({ down: 0.3, left: 0.2 });
    expect(line.probabilitiesPartial).toBe(true);
    const full = { ...ok, probabilities: { up: 0.5, down: 0.3, left: 0.2 } };
    expect(decisionLine({ ...answer, result: full }, 'ok', 2)).not.toHaveProperty(
      'probabilitiesPartial',
    );
    expect(decisionLine({ ...answer, result: ok }, 'ok', 2)).not.toHaveProperty(
      'probabilitiesPartial',
    );
  });

  it('doubles the backoff from 250 ms up to 2 s', () => {
    const steps = [0];
    for (let i = 0; i < 5; i++) steps.push(nextBackoffMs(steps.at(-1) ?? 0));
    expect(steps).toEqual([0, 250, 500, 1000, 2000, 2000]);
  });
});

describe('createLogBook: match_end validity', () => {
  /** A finished counter match through the log book: one decision per seat, seat 0's at `ms`. */
  const finish = <S, C>(game: AnyGame<S, C>, ms: number, status: 'ok' | 'timeout') => {
    const sink = memorySink();
    const book = createLogBook(sink, game.cadence.kind);
    const seats: [SeatMeta, SeatMeta] = [providerMeta('p0'), providerMeta('p1')];
    book.write(
      buildHeader({
        game,
        config: game.defaultConfig,
        seed: 1,
        matchId: 'm',
        startTime: 't',
        gitCommit: 'g',
        runLocation: 'here',
        runId: 'sim',
        floorMs: 100,
        timeoutMs: 1000,
        seats,
        warmups: [null, null],
      }),
    );
    const result = status === 'ok' ? emptyResult('ok', ms, 'up') : emptyResult('timeout', ms);
    book.write(
      decisionLine({ seat: 0, seq: 0, sentTick: 5, questionKey: 'k', result }, status, null),
    );
    const other = emptyResult('ok', 20, 'up');
    book.write(
      decisionLine({ seat: 1, seq: 0, sentTick: 5, questionKey: 'k', result: other }, 'ok', 6),
    );
    return book.end({ over: true, winner: 0, scores: [1, 0] }, 10, 'h');
  };

  it('keeps a timeout valid, and flags a line past the timeout plus the stall slack', () => {
    // Real time: a timeout is the seat's own miss; 1,250 ms is within the slack, 1,251 ms is not.
    expect(finish(counterRealtime, 1000, 'timeout').valid).toBe(true);
    expect(finish(counterRealtime, 1250, 'timeout').valid).toBe(true);
    const slept = finish(counterRealtime, 1251, 'timeout');
    expect(slept.valid).toBe(false);
    // Only stalls the scheduler measured are written; this one is the log's to show.
    expect(slept.stalls).toBeUndefined();
    // Turns: the turn rule's 3 s slack.
    expect(finish(counterTurns, 4000, 'ok').valid).toBe(true);
    expect(finish(counterTurns, 4001, 'ok').valid).toBe(false);
  });
});

describe('createQuestionOrder', () => {
  const question = {
    name: 'pick',
    instructions: 'Pick one.',
    options: [
      { id: 'a', description: 'A' },
      { id: 'b', description: 'B' },
      { id: 'c', description: 'C' },
    ],
  };

  it('orders a key once and hands back the same object for the same content', () => {
    const order = createQuestionOrder(5);
    const first = order({ key: 'k', question });
    expect(first.question).toEqual(orderOptions(question, 5, 'k'));
    // Equal content in a new object, options in another order: still the cached question.
    const copy = { ...question, options: [...question.options].reverse() };
    expect(order({ key: 'k', question: copy })).toBe(first);
  });

  it.each([
    ['name', { ...question, name: 'other' }, /name/],
    ['instructions', { ...question, instructions: 'Pick two.' }, /instructions/],
    [
      'option id',
      { ...question, options: [...question.options.slice(0, 2), { id: 'd', description: 'C' }] },
      /options/,
    ],
    [
      'option description',
      { ...question, options: [...question.options.slice(0, 2), { id: 'c', description: 'See' }] },
      /options/,
    ],
    ['option count', { ...question, options: question.options.slice(0, 2) }, /options/],
  ])('throws when a key is reused with a different %s', (_what, changed, field) => {
    const order = createQuestionOrder(5);
    order({ key: 'k', question });
    expect(() => order({ key: 'k', question: changed })).toThrow(
      /question key "k" was reused for a different question/,
    );
    expect(() => order({ key: 'k', question: changed })).toThrow(field);
  });
});

describe('playerMeta', () => {
  const baselines = [RANDOM_BASELINE, { id: 'parity', label: 'parity' }];

  it('gives a baseline null provider fields', () => {
    expect(playerMeta('parity', PROVIDERS, baselines)).toEqual({
      kind: 'baseline',
      player: 'parity',
      label: 'parity',
      format: null,
      hosting: null,
      model: null,
      serviceTier: null,
      price: null,
    });
  });

  it("fills a provider's fields from the registry, price without its source", () => {
    const openai = PROVIDERS.find((p) => p.id === 'openai');
    const meta = playerMeta('openai', PROVIDERS, baselines);
    expect(meta).toMatchObject({
      kind: 'provider',
      player: 'openai',
      label: openai?.label,
      format: openai?.format,
      hosting: openai?.hosting,
      model: openai?.model,
    });
    expect(meta.price).toEqual({
      inputPerMTokUsd: openai?.price.inputPerMTokUsd,
      outputPerMTokUsd: openai?.price.outputPerMTokUsd,
      asOf: openai?.price.asOf,
    });
  });

  it('throws on an id that is neither', () => {
    expect(() => playerMeta('nope', PROVIDERS, baselines)).toThrow(/unknown player nope/);
  });
});
