import { SUB } from '../../../../src/games/fighter/engine/constants.js';
import { createMatch, step } from '../../../../src/games/fighter/engine/sim.js';
import type { MatchState, MoveId, StepEvent } from '../../../../src/games/fighter/engine/types.js';

/** A fresh match with the fighters `units` apart, centered on the stage. */
export function matchAt(units: number): MatchState {
  const s = createMatch(1);
  const x0 = 500 * SUB - (units * SUB) / 2;
  s.fighters[0].x = x0;
  s.fighters[1].x = x0 + units * SUB;
  return s;
}

export function distance(s: MatchState): number {
  return (s.fighters[1].x - s.fighters[0].x) / SUB;
}

export type Script = Record<number, readonly [MoveId | null, MoveId | null]>;

/**
 * Run `ticks` steps. `script[i]` gives the inputs of the i-th step (0-based); other steps get
 * no input. `onTick` sees the state after each step. Returns all events.
 */
export function run(
  s: MatchState,
  ticks: number,
  script: Script = {},
  onTick?: (i: number, events: StepEvent[]) => void,
): StepEvent[] {
  const all: StepEvent[] = [];
  for (let i = 0; i < ticks; i++) {
    const ev = step(s, script[i] ?? [null, null]);
    all.push(...ev);
    onTick?.(i, ev);
  }
  return all;
}

/** Collapse a list into [value, count] runs. */
export function runs<T>(xs: readonly T[]): [T, number][] {
  const out: [T, number][] = [];
  for (const x of xs) {
    const last = out[out.length - 1];
    if (last && last[0] === x) last[1] += 1;
    else out.push([x, 1]);
  }
  return out;
}

export function ofType<K extends StepEvent['type']>(
  events: StepEvent[],
  type: K,
): Extract<StepEvent, { type: K }>[] {
  return events.filter((e): e is Extract<StepEvent, { type: K }> => e.type === type);
}
