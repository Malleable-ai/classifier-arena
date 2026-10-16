import { describe, expect, it } from 'vitest';
import { createRandomDecider, randomDeciderSeed } from '../../src/core/classifier/random.js';
import type { Decider, Seat } from '../../src/core/classifier/types.js';
import type { LogLine } from '../../src/core/log/schema.js';
import { createTurnRunner } from '../../src/core/sched/turns.js';
import { SimClock } from '../../src/core/util/clock.js';
import { createPrng } from '../../src/core/util/prng.js';
import { cluesGame } from '../../src/games/clues/game.js';
import { COMMON, baselineMeta, memorySink, settleOnSim } from '../core/sched/helpers.js';

/**
 * Clue Clash is deterministic on a SimClock: the same seed and seeded deciders give byte-identical
 * logs, and replaying the logged answers through the game from `configFromLog(header.config)`
 * reaches the logged final hash.
 */
async function run(seed: number): Promise<LogLine[]> {
  const clock = new SimClock();
  const sink = memorySink();
  const random = (seat: Seat): Decider =>
    createRandomDecider({ prng: createPrng(randomDeciderSeed(seed, seat)), clock });
  const runner = createTurnRunner({
    game: cluesGame,
    seed,
    config: cluesGame.defaultConfig,
    seats: [baselineMeta('random'), baselineMeta('random')],
    deciders: [random(0), random(1)],
    clock,
    sink,
    ...COMMON,
  });
  await settleOnSim(clock, runner.run());
  return sink.lines;
}

/** Feed the logged ok answers back through the game, turn by turn; return the final hash. */
function replay(lines: readonly LogLine[]): string {
  const header = lines[0];
  if (header?.type !== 'header') throw new Error('no header');
  const state = cluesGame.create(header.seed, cluesGame.configFromLog(header.config));
  while (!cluesGame.result(state).over) {
    const turn = cluesGame.turn(state);
    const answers = ([0, 1] as const).map((seat) => {
      const d = lines.find((l) => l.type === 'decision' && l.seat === seat && l.sentTick === turn);
      return d?.type === 'decision' && d.status === 'ok' && d.choice !== null
        ? { choice: d.choice, latencyMs: d.latencyMs }
        : null;
    });
    cluesGame.applyTurn(state, [answers[0] ?? null, answers[1] ?? null]);
  }
  return cluesGame.hash(state);
}

describe('clue clash determinism', () => {
  it('gives identical logs for the same seed and replays them to the logged final hash', async () => {
    for (const seed of [1, 20261007, 0xfffffffe]) {
      const one = await run(seed);
      const two = await run(seed);
      expect(JSON.stringify(two)).toBe(JSON.stringify(one));
      const end = one.at(-1);
      if (end?.type !== 'match_end') throw new Error('no match_end');
      expect(end.totalTicks).toBe(48);
      expect(replay(one)).toBe(end.finalStateHash);
    }
    expect(JSON.stringify(await run(2))).not.toBe(JSON.stringify(await run(1)));
  });
});
