import { hashState } from './hash.js';
import { createMatch, step } from './sim.js';
import type { AppliedDecision, EngineConfig, MatchState, MoveId, StepEvent } from './types.js';

/**
 * Scripted runner. Replays a decision log against a fresh match; the tests reuse it.
 */

export interface RunScriptedOptions {
  config?: Partial<EngineConfig>;
  /** Stop once `state.tick` reaches this. Default: enough ticks for the longest possible match. */
  maxTicks?: number;
}

export interface RunScriptedResult {
  state: MatchState;
  events: StepEvent[];
  hash: string;
}

/**
 * Group decisions into per-tick inputs. Decisions are stably sorted by `appliedTick` first, so
 * input order only matters within a tick: if one fighter has several decisions on the same tick,
 * the LAST one (in the given order) wins and the earlier ones are discarded.
 */
export function scheduleDecisions(
  decisions: readonly AppliedDecision[],
): Map<number, [MoveId | null, MoveId | null]> {
  const sorted = [...decisions].sort((x, y) => x.appliedTick - y.appliedTick);
  const byTick = new Map<number, [MoveId | null, MoveId | null]>();
  for (const d of sorted) {
    if (!Number.isInteger(d.appliedTick) || d.appliedTick < 0) {
      throw new Error(`appliedTick must be a non-negative integer, got ${String(d.appliedTick)}`);
    }
    let inputs = byTick.get(d.appliedTick);
    if (!inputs) {
      inputs = [null, null];
      byTick.set(d.appliedTick, inputs);
    }
    inputs[d.fighter] = d.move;
  }
  return byTick;
}

/** Upper bound on match length: every round runs to time, followed by a pause. */
export function defaultMaxTicks(config: EngineConfig): number {
  return config.maxRounds * (config.roundTicks + config.roundPauseTicks) + 1;
}

/**
 * Run a match from `seed`, feeding each decision on its `appliedTick`, until the match is over
 * or `maxTicks` ticks have been simulated. Decisions after the end are ignored.
 */
export function runScripted(
  seed: number,
  decisions: readonly AppliedDecision[],
  opts: RunScriptedOptions = {},
): RunScriptedResult {
  const state = createMatch(seed, opts.config ?? {});
  const maxTicks = opts.maxTicks ?? defaultMaxTicks(state.config);
  const byTick = scheduleDecisions(decisions);
  const events: StepEvent[] = [];
  while (state.status !== 'matchOver' && state.tick < maxTicks) {
    const inputs = byTick.get(state.tick) ?? [null, null];
    for (const e of step(state, inputs)) events.push(e);
  }
  return { state, events, hash: hashState(state) };
}
