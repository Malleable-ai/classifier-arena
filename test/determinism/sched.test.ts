import { describe, expect, it } from 'vitest';
import { createRandomDecider, randomDeciderSeed } from '../../src/core/classifier/random.js';
import type { Decider, Seat } from '../../src/core/classifier/types.js';
import type { LogLine } from '../../src/core/log/schema.js';
import { driveRealtime } from '../../src/core/sched/drive.js';
import { createRealtimeRunner } from '../../src/core/sched/realtime.js';
import { SimClock } from '../../src/core/util/clock.js';
import { createPrng } from '../../src/core/util/prng.js';
import { counterRealtime } from '../core/games/counter-realtime.js';
import { COMMON, baselineMeta, memorySink } from '../core/sched/helpers.js';

/**
 * The real-time scheduler is deterministic on a SimClock: the same seed and seeded deciders give
 * byte-identical logs (header to match_end), so offline matches and their replays are reproducible.
 */
async function run(seed: number): Promise<LogLine[]> {
  const clock = new SimClock();
  const sink = memorySink();
  const random = (seat: Seat): Decider =>
    createRandomDecider({ prng: createPrng(randomDeciderSeed(seed, seat)), clock });
  const parity = counterRealtime.createBaseline?.('parity', { clock, delayMs: 130 });
  if (!parity) throw new Error('no parity baseline');
  const runner = createRealtimeRunner({
    game: counterRealtime,
    seed,
    config: counterRealtime.defaultConfig,
    seats: [baselineMeta('random'), baselineMeta('parity')],
    deciders: [random(0), parity],
    clock,
    sink,
    ...COMMON,
  });
  await driveRealtime(runner, clock);
  return sink.lines;
}

describe('scheduler determinism', () => {
  it('gives identical counter-realtime logs for the same seed and seeded deciders', async () => {
    const one = await run(20261007);
    const two = await run(20261007);
    expect(JSON.stringify(two)).toBe(JSON.stringify(one));
    const end = one.at(-1);
    if (end?.type !== 'match_end') throw new Error('no match_end');
    expect(end.totalTicks).toBe(600);
    expect(one.filter((l) => l.type === 'decision').length).toBeGreaterThan(50);
    const other = await run(20261008);
    expect(JSON.stringify(other)).not.toBe(JSON.stringify(one));
  });
});
