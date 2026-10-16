import type { InboxConfig, Ramp } from './types.js';

/**
 * The stream's timing: when each message spawns and when it lands. It depends on the config only
 * (the seed picks which message goes in each slot, never when), so both lanes share it and
 * `maxTicks` is known before a match starts. Integer math only.
 */

/** `ramp` at tick `t`: linear from start (t = 0) to end (t ≥ rampTicks), the drop rounded down. */
export function rampAt(ramp: Ramp, t: number): number {
  const { startTicks, endTicks, rampTicks } = ramp;
  if (t >= rampTicks) return endTicks;
  return startTicks - Math.floor(((startTicks - endTicks) * t) / rampTicks);
}

export interface Slot {
  spawnTick: number;
  landTick: number;
}

/**
 * One slot per stream message: the first spawns at tick 0, each next one `rampAt(spawn, previous
 * spawn tick)` later; each lands `rampAt(fall, its spawn tick)` after it spawns.
 */
export function buildSchedule(config: InboxConfig): Slot[] {
  const slots: Slot[] = [];
  let spawnTick = 0;
  for (let i = 0; i < config.streamLength; i++) {
    slots.push({ spawnTick, landTick: spawnTick + rampAt(config.fall, spawnTick) });
    spawnTick += rampAt(config.spawn, spawnTick);
  }
  return slots;
}

/** Upper bound on a match in ticks: the last landing + 1 (a match ends by then at the latest). */
export function inboxMaxTicks(config: InboxConfig): number {
  let last = 0;
  for (const { landTick } of buildSchedule(config)) last = Math.max(last, landTick);
  return last + 1;
}

const isPosInt = (n: number): boolean => Number.isSafeInteger(n) && n >= 1;

/** Throws (naming the field) unless every number is a positive integer. */
export function validateConfig(config: InboxConfig): void {
  const check = (name: string, n: number): void => {
    if (!isPosInt(n)) {
      throw new RangeError(`inbox config: ${name} must be a positive integer, got ${String(n)}`);
    }
  };
  check('health', config.health);
  check('damage', config.damage);
  check('smishingMultiplier', config.smishingMultiplier);
  check('maxChars', config.maxChars);
  check('streamLength', config.streamLength);
  for (const key of ['spawn', 'fall'] as const) {
    const r = config[key];
    check(`${key}.startTicks`, r.startTicks);
    check(`${key}.endTicks`, r.endTicks);
    check(`${key}.rampTicks`, r.rampTicks);
  }
}
