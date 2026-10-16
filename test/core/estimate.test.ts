import { describe, expect, it } from 'vitest';
import {
  MATCH_SECONDS_TYPICAL,
  MATCH_SECONDS_WORST_CASE,
  fighterEstimate,
} from '../../src/games/fighter/estimate.js';
import { PROVIDERS } from '../../src/core/classifier/providers.js';
import {
  APPROVAL_LIMIT_USD,
  estimateMatch,
  formatEstimate,
  pricedSeats,
} from '../../src/core/estimate.js';
import type { GameEstimate } from '../../src/core/game.js';
import { TICK_RATE } from '../../src/games/fighter/engine/constants.js';
import { defaultMaxTicks } from '../../src/games/fighter/engine/run.js';
import { DEFAULT_CONFIG } from '../../src/games/fighter/engine/sim.js';
import { counterRealtime } from './games/counter-realtime.js';
import { counterTurns } from './games/counter-turns.js';

const price = (inputPerMTokUsd: number) => ({ inputPerMTokUsd });

describe('estimateMatch (generic)', () => {
  it('prices a provider seat from the game: decisions + warm-up, fallback tokens', () => {
    // counter_realtime: worst 600 / typical 40 decisions, 120 tokens for anyone unmeasured.
    const est = estimateMatch(counterRealtime.estimate, [
      { player: 'openai', price: price(0.1) },
      { player: 'random', price: null },
    ]);
    const [p, r] = est.perSeat;
    expect(p).toMatchObject({
      player: 'openai',
      paid: true,
      measured: false,
      calls: 601,
      inputTokensPerCall: 120,
      inputTokens: 601 * 120,
      typicalCalls: 41,
    });
    expect(p?.costUsd).toBeCloseTo((601 * 120 * 0.1) / 1e6, 12);
    expect(p?.typicalUsd).toBeCloseTo((41 * 120 * 0.1) / 1e6, 12);
    expect(r).toMatchObject({ player: 'random', paid: false, calls: 0, costUsd: 0, typicalUsd: 0 });
    expect(est.totalUsd).toBeCloseTo(p?.costUsd ?? NaN, 12);
    expect(est.typicalUsd).toBeCloseTo(p?.typicalUsd ?? NaN, 12);
    expect(est.matches).toBe(1);
  });

  it('uses measured tokens and per-player decision counts when the game has them', () => {
    const game: GameEstimate = {
      decisionsPerSeat: { typical: 10, worst: 100 },
      decisionsPerSeatByPlayer: { fast: { typical: 20, worst: 200 } },
      inputTokens: { fast: 500 },
      fallbackInputTokens: 1000,
    };
    const est = estimateMatch(game, [
      { player: 'fast', price: price(1) },
      { player: 'slow', price: price(1) },
    ]);
    expect(est.perSeat.map((s) => [s.player, s.measured, s.calls, s.inputTokens])).toEqual([
      ['fast', true, 201, 201 * 500],
      ['slow', false, 101, 101 * 1000],
    ]);
    expect(est.totalUsd).toBeCloseTo((201 * 500 + 101 * 1000) / 1e6, 12);
    expect(est.typicalUsd).toBeCloseTo((21 * 500 + 11 * 1000) / 1e6, 12);
  });

  it('costs nothing for baselines and says so', () => {
    const est = estimateMatch(counterTurns.estimate, [
      { player: 'random', price: null },
      { player: 'random', price: null },
    ]);
    expect(est.totalUsd).toBe(0);
    expect(est.typicalUsd).toBe(0);
    expect(est.text).toBe('Cost estimate: $0 (no paid players)');
  });

  it('scales with the number of matches and guards on the worst case', () => {
    const seats = [
      { player: 'openai', price: price(0.1) },
      { player: 'random', price: null },
    ];
    const one = estimateMatch(counterRealtime.estimate, seats);
    const many = estimateMatch(counterRealtime.estimate, seats, { matches: 200 });
    expect(many.matches).toBe(200);
    expect(many.totalUsd).toBeCloseTo(one.totalUsd * 200, 10);
    expect(many.typicalUsd).toBeCloseTo(one.typicalUsd * 200, 10);
    expect(APPROVAL_LIMIT_USD).toBe(5);
    expect(() => estimateMatch(counterRealtime.estimate, seats, { matches: 0 })).toThrow(/matches/);
    expect(() => estimateMatch(counterRealtime.estimate, seats, { matches: 1.5 })).toThrow(
      /matches/,
    );
  });

  it('formats one row per paid seat, the worst case and the typical cost', () => {
    const est = estimateMatch(counterRealtime.estimate, [
      { player: 'openai', price: price(0.1) },
      { player: 'random', price: null },
    ]);
    expect(est.text).toBe(formatEstimate(est));
    expect(est.text).toBe(
      [
        'Cost estimate (worst case, 1 match(es)):',
        '  openai: 601 calls (600 decisions + warm-up), 72K input tokens, $0.0072 ' +
          '(not measured; assumed 120 tokens per decision)',
        '  total: $0.0072 worst case ($0.0005 typical)',
      ].join('\n'),
    );
  });

  it('pricedSeats looks prices up in the provider registry (baselines get null)', () => {
    const openai = PROVIDERS.find((p) => p.id === 'openai');
    expect(pricedSeats(['openai', 'random'], PROVIDERS)).toEqual([
      { player: 'openai', price: openai?.price },
      { player: 'random', price: null },
    ]);
  });
});

/**
 * Today's fighter estimate (src/games/fighter/estimate.ts), pinned before the step 6 refactor.
 * Spike stats: jev 170 ms p50 and 1,166 tokens per call, openai 184 ms and 782; one request in
 * flight, so decisions/s = 1000 / max(100 ms floor, p50).
 */
describe('fighterEstimate (pinned)', () => {
  it('takes the worst case from the engine: every round goes to time, plus pauses', () => {
    expect(MATCH_SECONDS_WORST_CASE).toBe(defaultMaxTicks(DEFAULT_CONFIG) / TICK_RATE);
    expect(MATCH_SECONDS_WORST_CASE).toBeCloseTo(307.5, 1);
    expect(MATCH_SECONDS_TYPICAL).toBe(123);
  });

  it('keeps the spike numbers: tokens per call and decisions per seat', () => {
    expect(fighterEstimate.inputTokens).toEqual({ jev: 1166, openai: 782 });
    expect(fighterEstimate.fallbackInputTokens).toBe(2000);
    expect(fighterEstimate.decisionsPerSeatByPlayer).toEqual({
      jev: {
        typical: Math.ceil((1000 / 170) * MATCH_SECONDS_TYPICAL),
        worst: Math.ceil((1000 / 170) * MATCH_SECONDS_WORST_CASE),
      },
      openai: {
        typical: Math.ceil((1000 / 184) * MATCH_SECONDS_TYPICAL),
        worst: Math.ceil((1000 / 184) * MATCH_SECONDS_WORST_CASE),
      },
    });
    // Unmeasured providers: the 100 ms floor cadence.
    expect(fighterEstimate.decisionsPerSeat).toEqual({ typical: 1230, worst: 3076 });
  });

  it('reproduces the jev vs openai estimate exactly', () => {
    const est = estimateMatch(fighterEstimate, pricedSeats(['jev', 'openai'], PROVIDERS));
    expect(est.perSeat.map((s) => [s.player, s.calls, s.inputTokens])).toEqual([
      ['jev', 1810, 2_110_460],
      ['openai', 1673, 1_308_286],
    ]);
    expect(est.perSeat[0]?.costUsd).toBeCloseTo(0.08863932, 12);
    expect(est.perSeat[1]?.costUsd).toBeCloseTo(0.1308286, 12);
    expect(est.totalUsd).toBeCloseTo(0.21946792, 12);
    expect(est.typicalUsd).toBeCloseTo(0.0878987, 12);
    expect(est.totalUsd).toBeLessThan(APPROVAL_LIMIT_USD);
    expect(est.text).toBe(
      [
        'Cost estimate (worst case, 1 match(es)):',
        '  jev: 1810 calls (1809 decisions + warm-up), 2110K input tokens, $0.0886',
        '  openai: 1673 calls (1672 decisions + warm-up), 1308K input tokens, $0.1308',
        '  total: $0.2195 worst case ($0.0879 typical)',
      ].join('\n'),
    );
  });

  it('prices an unmeasured provider at the floor cadence and 2,000 tokens, as before', () => {
    const jev = PROVIDERS.find((p) => p.id === 'jev');
    const est = estimateMatch(fighterEstimate, [
      { player: 'other', price: jev?.price ?? null },
      { player: 'random', price: null },
    ]);
    expect(est.perSeat[0]).toMatchObject({ calls: 3077, inputTokens: 6_154_000, measured: false });
    expect(est.totalUsd).toBeCloseTo(0.258468, 12);
    expect(est.typicalUsd).toBeCloseTo(0.103404, 12);
  });

  it('guards on the worst case: enough matches cross the approval limit', () => {
    const seats = pricedSeats(['jev', 'openai'], PROVIDERS);
    const one = estimateMatch(fighterEstimate, seats).totalUsd;
    const n = Math.ceil(APPROVAL_LIMIT_USD / one);
    expect(estimateMatch(fighterEstimate, seats, { matches: n }).totalUsd).toBeGreaterThan(
      APPROVAL_LIMIT_USD - 1e-9,
    );
  });
});
