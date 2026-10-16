import { createPrng, nextBelow } from '../../../../core/util/prng.js';
import type { PrngState } from '../../../../core/util/prng.js';
import type { MoveId, Side } from '../../../../games/fighter/engine/types.js';
import { MOVE_IDS } from '../../../../games/fighter/engine/types.js';

/** Local random bot for the sandbox: a uniform MoveId every `intervalTicks`, seeded PRNG. */

export const RANDOM_INTERVAL_TICKS = 12;

export interface RandomBot {
  /** Called once per tick with the tick about to be simulated. */
  next(tick: number): MoveId | null;
}

/** Per-side seed so two bots on the same match seed don't mirror each other. */
export function botSeed(seed: number, side: Side): number {
  return (Math.imul(seed >>> 0, 0x9e3779b1) ^ (side === 0 ? 0x51ed270b : 0x2545f491)) >>> 0;
}

export function createRandomBot(
  seed: number,
  side: Side,
  intervalTicks = RANDOM_INTERVAL_TICKS,
): RandomBot {
  const prng: PrngState = createPrng(botSeed(seed, side));
  // Offset side 1 by half an interval so both bots don't decide on the same tick.
  const offset = side === 0 ? 0 : Math.floor(intervalTicks / 2);
  return {
    next(tick) {
      if ((tick - offset) % intervalTicks !== 0) return null;
      return MOVE_IDS[nextBelow(prng, MOVE_IDS.length)] ?? null;
    },
  };
}
