/**
 * Engine constants. All lengths are in sub-units (1 unit = SUB sub-units), all times in ticks.
 * Integer-only: every value here must be an integer.
 */

/** Bump when a rule change makes old replays produce different hashes. */
export const ENGINE_VERSION = 2;

export const TICK_RATE = 60;
export const SUB = 100;

export const STAGE_MIN = 0;
export const STAGE_MAX = 1000 * SUB;
export const START_X: readonly [number, number] = [350 * SUB, 650 * SUB];

export const WALK_SPEED = 3 * SUB;
/** Half a fighter's body width. Centers stay >= 2x this apart, and this far from each wall. */
export const PUSHBOX_HALF_WIDTH = 30 * SUB;

export const MAX_HEALTH = 100;
export const ROUND_TICKS = 60 * TICK_RATE;
export const ROUNDS_TO_WIN = 2;
export const MAX_ROUNDS = 5;
/** How long a one-shot arriving while busy waits before it is dropped. Holds never expire. */
export const BUFFER_TICKS = 6;
/** Fixed pause between rounds (part of the sim so replays include it). Used by rounds.ts (2c). */
export const ROUND_PAUSE_TICKS = 90;
/** Length of `FighterState.lastMoves` (the prompt shows the last 3 applied moves). */
export const LAST_MOVES_MAX = 3;
