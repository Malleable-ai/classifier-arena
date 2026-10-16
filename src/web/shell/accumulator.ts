/**
 * The fixed-step accumulator every web loop shares: frame time in, whole steps out. The replay
 * player steps frames with it; the fighter sandbox steps engine ticks.
 */

/** Frames per second of every timeline (src/web/games/index.ts). */
export const FRAME_RATE = 60;
export const FRAME_MS = 1000 / FRAME_RATE;
/** Default cap on steps per call; any backlog past it is dropped (a hidden tab doesn't fast-forward). */
export const MAX_CATCH_UP = 5;

export interface AccumulatorResult {
  ticks: number;
  acc: number;
}

/** Pure accumulator step: carry `acc` ms, add `dtMs`, return whole steps to run and the rest. */
export function advanceAccumulator(
  acc: number,
  dtMs: number,
  stepMs = FRAME_MS,
  maxCatchUp = MAX_CATCH_UP,
): AccumulatorResult {
  const total = acc + Math.max(0, dtMs);
  const ticks = Math.floor(total / stepMs);
  if (ticks > maxCatchUp) return { ticks: maxCatchUp, acc: 0 };
  return { ticks, acc: total - ticks * stepMs };
}
