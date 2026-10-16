import { describe, expect, it } from 'vitest';
import { createRandomDecider, randomDeciderSeed } from '../../../src/core/classifier/random.js';
import { driveRealtime, driveTurns } from '../../../src/core/sched/drive.js';
import { createRealtimeRunner } from '../../../src/core/sched/realtime.js';
import { createTurnRunner } from '../../../src/core/sched/turns.js';
import { realClock, type Clock } from '../../../src/core/util/clock.js';
import { createPrng } from '../../../src/core/util/prng.js';
import { counterRealtime } from '../games/counter-realtime.js';
import { counterTurns } from '../games/counter-turns.js';
import { COMMON, SimClock, baselineMeta, memorySink } from './helpers.js';

function runner(clock: Clock, windows: number, sink = memorySink()) {
  const random = (seat: 0 | 1) =>
    createRandomDecider({ prng: createPrng(randomDeciderSeed(3, seat)), clock, delayMs: 50 });
  return {
    sink,
    runner: createRealtimeRunner({
      game: counterRealtime,
      seed: 3,
      config: { windows },
      seats: [baselineMeta('random'), baselineMeta('random')],
      deciders: [random(0), random(1)],
      clock,
      sink,
      ...COMMON,
    }),
  };
}

describe('driveRealtime', () => {
  it('runs a whole match on a SimClock, jumping time tick by tick', async () => {
    const clock = new SimClock();
    const { runner: r, sink } = runner(clock, 20);
    await driveRealtime(r, clock);
    expect(r.done).toBe(true);
    expect(clock.now()).toBeCloseTo(599 * (1000 / 60), 6);
    expect(sink.lines.at(-1)).toMatchObject({ type: 'match_end', totalTicks: 600 });
  });

  it('paces a short match on the real clock', async () => {
    const { runner: r, sink } = runner(realClock, 1);
    const start = realClock.now();
    await driveRealtime(r, realClock);
    // 30 ticks at 60 Hz: the last is due 483 ms after the clock starts.
    expect(realClock.now() - start).toBeGreaterThanOrEqual(480);
    expect(sink.lines.at(-1)).toMatchObject({ type: 'match_end', totalTicks: 30 });
  });
});

describe('driveTurns', () => {
  const turnRunner = (clock: Clock, sink = memorySink()) => {
    const random = (seat: 0 | 1) =>
      createRandomDecider({ prng: createPrng(randomDeciderSeed(5, seat)), clock, delayMs: 300 });
    return {
      sink,
      runner: createTurnRunner({
        game: counterTurns,
        seed: 5,
        config: { turns: 4 },
        seats: [baselineMeta('random'), baselineMeta('random')],
        deciders: [random(0), random(1)],
        clock,
        sink,
        ...COMMON,
      }),
    };
  };

  it('runs a whole turn match on a SimClock, moving time from sleeper to sleeper', async () => {
    const clock = new SimClock();
    const { runner: r, sink } = turnRunner(clock);
    const end = await driveTurns(r, clock);
    expect(end).toMatchObject({ type: 'match_end', totalTicks: 4 });
    expect(sink.lines.at(-1)).toEqual(end);
    // Four turns of 300 ms answers, with the 100 ms floor between turns.
    expect(clock.now()).toBeCloseTo(4 * 300 + 3 * 100, 6);
  });

  it('throws when the run stalls on something other than the clock', async () => {
    const clock = new SimClock();
    const never = { run: () => new Promise<never>(() => undefined) };
    await expect(driveTurns(never, clock)).rejects.toThrow(/stalled/);
  });

  it('just awaits the run on the real clock', async () => {
    const run = { run: () => Promise.resolve('done') };
    await expect(driveTurns(run, realClock)).resolves.toBe('done');
  });
});
