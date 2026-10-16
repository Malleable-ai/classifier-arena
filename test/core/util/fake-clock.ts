import type { Clock } from '../../../src/core/util/clock.js';

/** A test clock: `sleep` advances virtual time instantly (or rejects if already aborted). */
export interface FakeClock extends Clock {
  /** Every `sleep` duration requested, in order. */
  readonly sleeps: number[];
}

export function createFakeClock(start = 0): FakeClock {
  let t = start;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => t,
    sleep(ms, signal) {
      if (signal?.aborted) return Promise.reject(new Error('aborted'));
      sleeps.push(ms);
      t += ms;
      return Promise.resolve();
    },
  };
}
