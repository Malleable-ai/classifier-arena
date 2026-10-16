import type { Clock } from '../util/clock.js';
import type { PrngState } from '../util/prng.js';
import { nextBelow } from '../util/prng.js';
import type { Decider, Seat } from './types.js';
import { emptyResult } from './types.js';

export const BASELINE_DELAY_MS = 200;

/** Per-seat seed from the match seed, so the two seats don't mirror each other. */
export function randomDeciderSeed(matchSeed: number, seat: Seat): number {
  return (Math.imul(matchSeed >>> 0, 0x9e3779b1) ^ (seat === 0 ? 0x51ed270b : 0x2545f491)) >>> 0;
}

export interface RandomDeciderOptions {
  /** Its own PRNG (e.g. createPrng(randomDeciderSeed(seed, seat))), never the game's. */
  prng: PrngState;
  delayMs?: number;
  clock: Clock;
}

/**
 * Uniform pick over the question's options (by index into its option list, so it follows the
 * question's order) after a fixed simulated delay. Ignores the state.
 */
export function createRandomDecider({
  prng,
  delayMs = BASELINE_DELAY_MS,
  clock,
}: RandomDeciderOptions): Decider {
  return {
    player: 'random',
    async decide(_state, question, signal) {
      const start = clock.now();
      try {
        await clock.sleep(delayMs, signal);
      } catch {
        return emptyResult('timeout', clock.now() - start);
      }
      const { options } = question;
      if (options.length === 0) {
        return { ...emptyResult('error', clock.now() - start), error: 'question has no options' };
      }
      const choice = options[nextBelow(prng, options.length)]?.id ?? null;
      return emptyResult('ok', clock.now() - start, choice);
    },
  };
}
