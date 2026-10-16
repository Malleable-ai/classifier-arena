import { describe, expect, it } from 'vitest';
import { createRandomDecider, randomDeciderSeed } from '../../../src/core/classifier/random.js';
import type { Decider, Seat } from '../../../src/core/classifier/types.js';
import type { EventLine, HeaderLine, LogLine, MatchEndLine } from '../../../src/core/log/schema.js';
import { createTurnRunner } from '../../../src/core/sched/turns.js';
import type { Clock } from '../../../src/core/util/clock.js';
import { createPrng } from '../../../src/core/util/prng.js';
import { CLUES_BOARDS, CLUES_BOARDS_SHA256 } from '../../../src/games/clues/data.js';
import { cluesBoardOf, cluesGame } from '../../../src/games/clues/game.js';
import { turnStep, turnWord } from '../../../src/games/clues/engine/engine.js';
import type { CluesState } from '../../../src/games/clues/engine/types.js';
import type { CluesView } from '../../../src/games/clues/view.js';
import { promptConfigHash } from '../../../src/core/classifier/prompt.js';
import {
  COMMON,
  SimClock,
  baselineMeta,
  decisionsOf,
  fakeDecider,
  memorySink,
  settleOnSim,
  type FakeDecider,
} from '../../core/sched/helpers.js';

/**
 * Clue Clash through the generic turn scheduler on a SimClock: offline, no network, no keys.
 */

const SEED = 20261007;

interface Played {
  end: MatchEndLine;
  lines: LogLine[];
  state: CluesState;
}

async function play(
  seed: number,
  make: (clock: Clock) => readonly [Decider, Decider],
  players: readonly [string, string] = ['a', 'b'],
): Promise<Played> {
  const clock = new SimClock();
  const sink = memorySink();
  const runner = createTurnRunner({
    game: cluesGame,
    seed,
    config: cluesGame.defaultConfig,
    seats: [baselineMeta(players[0]), baselineMeta(players[1])],
    deciders: make(clock),
    clock,
    sink,
    ...COMMON,
  });
  const end = await settleOnSim(clock, runner.run());
  return { end, lines: sink.lines, state: runner.state };
}

const randomPair = (seed: number) => (clock: Clock) =>
  [0, 1].map((seat) =>
    createRandomDecider({ prng: createPrng(randomDeciderSeed(seed, seat as Seat)), clock }),
  ) as unknown as readonly [Decider, Decider];

/** Every word's answer, by question key (`t<word>`): the test harness reads it from a fresh state. */
function answersByKey(seed: number): Map<string, string> {
  const s = cluesGame.create(seed, cluesGame.defaultConfig);
  const board = cluesBoardOf(s);
  return new Map(
    s.order.map((index, w) => [`t${String(w)}`, board.words[index]?.lemma ?? 'missing']),
  );
}

/** The answer to turn `n` (a seat's n-th call): word `floor(n / 3)`'s. */
const answerAt = (answers: Map<string, string>, n: number): string =>
  answers.get(`t${String(turnWord(n))}`) ?? 'missing';

/**
 * A perfect player for the harness only: it answers turn n from `answersByKey`, after
 * `latencyMs`. The decider is never told the key; turn n is its n-th call.
 */
function perfect(clock: Clock, seed: number, latencyMs: number): FakeDecider {
  const answers = answersByKey(seed);
  return fakeDecider(clock, (n) => ({ latencyMs, choice: answerAt(answers, n) }));
}

describe('clues through createTurnRunner', () => {
  it('writes a v2 header naming the game, its prompt hash and the board data', async () => {
    const { lines } = await play(SEED, randomPair(SEED));
    const header = lines[0] as HeaderLine;
    expect(header).toMatchObject({
      type: 'header',
      game: 'clues',
      gameVersion: 2,
      seed: SEED,
      cadence: { kind: 'turns' },
      promptConfigHash: promptConfigHash(cluesGame.promptConfig),
      config: { boardsSha256: CLUES_BOARDS_SHA256, boardCount: CLUES_BOARDS.length },
    });
  });

  it('plays 48 turns: 48 decisions per seat, a clue event per turn, 16 reveals, then match_end', async () => {
    const { end, lines } = await play(SEED, randomPair(SEED));
    expect(decisionsOf(lines, 0)).toHaveLength(48);
    expect(decisionsOf(lines, 1)).toHaveLength(48);
    const events = lines.filter((l): l is EventLine => l.type === 'event');
    const clues = events.filter((e) => e.game.kind === 'clue');
    const reveals = events.filter((e) => e.game.kind === 'reveal');
    expect(clues.map((e) => e.tick)).toEqual(Array.from({ length: 48 }, (_, t) => t));
    expect(reveals.map((e) => e.tick)).toEqual(Array.from({ length: 16 }, (_, w) => 3 * w + 2));
    expect(end).toMatchObject({
      totalTicks: 48,
      valid: true,
      decisions: [48, 48],
      costUsd: 0,
      missRates: [0, 0],
      timeoutRates: [0, 0],
    });
    for (const d of decisionsOf(lines)) {
      expect(d.status).toBe('ok');
      expect(typeof d.correct).toBe('boolean');
    }
  });

  it('logs each decision so a replay recovers (word, step): key t<word>, turn 3 × word + step − 1', async () => {
    const seats: FakeDecider[] = [];
    const { lines } = await play(SEED, (clock) => {
      seats.push(perfect(clock, SEED, 120), perfect(clock, SEED, 180));
      return [seats[0], seats[1]] as [FakeDecider, FakeDecider];
    });
    for (const d of decisionsOf(lines)) {
      const word = turnWord(d.sentTick);
      const step = turnStep(d.sentTick);
      expect(d.questionKey).toBe(`t${String(word)}`);
      expect(d.sentTick).toBe(3 * word + step - 1);
      expect(d.appliedTick).toBe(d.sentTick);
      // The state that seat was sent names the same step.
      const sent = seats[d.seat]?.calls[d.seq]?.state as CluesView | undefined;
      expect(sent?.reveal_step).toBe(`${String(step)}/3`);
    }
  });

  it('scores random vs random near 1/16 per seat per ask over 200 seeds', async () => {
    const totals: [number, number] = [0, 0];
    const matches = 200;
    for (let seed = 1; seed <= matches; seed++) {
      const { end } = await play(seed, randomPair(seed));
      totals[0] += end.scores[0];
      totals[1] += end.scores[1];
    }
    const perAsk = totals.map((t) => t / (matches * 48));
    // 9,600 asks per seat: the standard error of a 1/16 rate is about 0.0025.
    for (const rate of perAsk) expect(Math.abs(rate - 1 / 16)).toBeLessThan(0.01);
  });

  it('gives a perfect player 48 (3 per word) and the win', async () => {
    const { end, lines, state } = await play(SEED, (clock) => [
      perfect(clock, SEED, 150),
      createRandomDecider({ prng: createPrng(randomDeciderSeed(SEED, 1)), clock }),
    ]);
    expect(end.scores[0]).toBe(48);
    expect(end.winner).toBe(0);
    expect(decisionsOf(lines, 0).every((d) => d.correct === true)).toBe(true);
    expect(state.correctLatencyMs[0]).toBe(48 * 150);
  });

  it('asks both seats the identical question object for each key, the same for a word’s three steps', async () => {
    const seats: FakeDecider[] = [];
    const { lines } = await play(SEED, (clock) => {
      seats.push(perfect(clock, SEED, 120), perfect(clock, SEED, 180));
      return [seats[0], seats[1]] as [FakeDecider, FakeDecider];
    });
    const [a, b] = seats;
    if (!a || !b) throw new Error('no deciders');
    expect(a.calls).toHaveLength(48);
    expect(b.calls).toHaveLength(48);
    const orders = new Set<string>();
    for (let t = 0; t < 48; t++) {
      const qa = a.calls[t]?.question;
      expect(qa).toBe(b.calls[t]?.question);
      expect(a.calls[t]?.state).toEqual(b.calls[t]?.state);
      // One option order per word: its three steps get the same Question object.
      expect(qa).toBe(a.calls[3 * turnWord(t)]?.question);
      orders.add(qa?.options.map((o) => o.id).join(',') ?? '');
    }
    // Shuffled per key by the core order rule: the 16 words don't share one order.
    expect(orders.size).toBeGreaterThan(1);
    const keys = decisionsOf(lines, 0).map((d) => d.questionKey);
    expect(decisionsOf(lines, 1).map((d) => d.questionKey)).toEqual(keys);
  });

  it('scores nothing for a timeout, even with the right answer, and stays valid', async () => {
    const answers = answersByKey(SEED);
    const { end, lines } = await play(SEED, (clock) => [
      fakeDecider(clock, (n) => ({
        // Right every turn, but turns 0-3 arrive after the 1,000 ms deadline.
        latencyMs: n < 4 ? 1500 : 200,
        choice: answerAt(answers, n),
      })),
      fakeDecider(clock, () => ({ latencyMs: 200, choice: 'zzz' })),
    ]);
    const seat0 = decisionsOf(lines, 0);
    expect(seat0.slice(0, 4).map((d) => d.status)).toEqual([
      'timeout',
      'timeout',
      'timeout',
      'timeout',
    ]);
    for (const d of seat0.slice(0, 4)) expect(d.correct).toBeUndefined();
    expect(end.scores).toEqual([44, 0]);
    const clues = lines.filter((l): l is EventLine => l.type === 'event');
    expect(clues[0]?.game).toMatchObject({ kind: 'clue', correct: [false, false] });
    // A turn game's timeouts score 0 but don't count toward validity; they are still reported.
    expect(end.valid).toBe(true);
    expect(end.missRates[0]).toBeCloseTo(4 / 48);
    expect(end.timeoutRates?.[0]).toBeCloseTo(4 / 48);
  });

  it('flags the match invalid on a transport error (one in 48 is over 2%)', async () => {
    const answers = answersByKey(SEED);
    const { end, lines } = await play(SEED, (clock) => [
      fakeDecider(clock, (n) => ({ latencyMs: 200, choice: answerAt(answers, n) })),
      fakeDecider(clock, (n) =>
        n === 10
          ? { latencyMs: 50, error: 'http 500: oops' }
          : { latencyMs: 200, choice: answerAt(answers, n) },
      ),
    ]);
    expect(decisionsOf(lines, 1)[10]).toMatchObject({ status: 'error' });
    expect(end.scores).toEqual([48, 47]);
    expect(end.valid).toBe(false);
    expect(end.timeoutRates).toEqual([0, 0]);
  });

  it('breaks a tie on mean correct latency through the scheduler', async () => {
    const faster = await play(SEED, (clock) => [
      perfect(clock, SEED, 300),
      perfect(clock, SEED, 250),
    ]);
    expect(faster.end.scores).toEqual([48, 48]);
    expect(faster.end.winner).toBe(1);
    const same = await play(SEED, (clock) => [
      perfect(clock, SEED, 250),
      perfect(clock, SEED, 250),
    ]);
    expect(same.end.winner).toBe('draw');
  });

  it('reaches the same final hash and the same log on a second run', async () => {
    const one = await play(SEED, randomPair(SEED));
    const two = await play(SEED, randomPair(SEED));
    expect(two.end.finalStateHash).toBe(one.end.finalStateHash);
    expect(cluesGame.hash(two.state)).toBe(one.end.finalStateHash);
    expect(JSON.stringify(two.lines)).toBe(JSON.stringify(one.lines));
    const other = await play(SEED + 1, randomPair(SEED + 1));
    expect(other.end.finalStateHash).not.toBe(one.end.finalStateHash);
  });
});
