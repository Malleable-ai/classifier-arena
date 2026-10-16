import { describe, expect, it } from 'vitest';
import { hashState } from '../../src/games/fighter/engine/hash.js';
import { createPrng, nextBelow } from '../../src/core/util/prng.js';
import { runScripted, scheduleDecisions } from '../../src/games/fighter/engine/run.js';
import { cloneState, createMatch, step } from '../../src/games/fighter/engine/sim.js';
import type { AppliedDecision, MatchState } from '../../src/games/fighter/engine/types.js';
import { MOVE_IDS } from '../../src/games/fighter/engine/types.js';

/**
 * Recorded hash of the 10,000-tick soak below. It changes whenever a rule, frame-data value or
 * the hash layout changes. To regenerate:
 *
 *   UPDATE_SOAK=1 pnpm vitest run test/determinism --silent=false
 *
 * which prints the new hash (and skips the assertion); paste it here and say why in the PR.
 */
const EXPECTED_SOAK_HASH = '0eee3a0df44909e2';

const SOAK_SEED = 20261007;
const SOAK_TICKS = 10_000;
/** Each fighter gets a new random decision every SOAK_EVERY ticks (offset by side). */
const SOAK_EVERY = 7;

/** Random decisions for both fighters, drawn from the engine PRNG with a fixed seed. */
function soakDecisions(seed: number, ticks: number): AppliedDecision[] {
  const prng = createPrng(seed);
  const decisions: AppliedDecision[] = [];
  for (let tick = 0; tick < ticks; tick++) {
    for (const fighter of [0, 1] as const) {
      if ((tick + fighter * 3) % SOAK_EVERY !== 0) continue;
      const move = MOVE_IDS[nextBelow(prng, MOVE_IDS.length)];
      if (move === undefined) throw new Error('nextBelow out of range');
      decisions.push({ fighter, appliedTick: tick, move });
    }
  }
  return decisions;
}

/** Step `state` from its current tick until `endTick`, feeding the scheduled decisions. */
function continueTo(state: MatchState, decisions: readonly AppliedDecision[], endTick: number) {
  const byTick = scheduleDecisions(decisions);
  while (state.tick < endTick && state.status !== 'matchOver') {
    step(state, byTick.get(state.tick) ?? [null, null]);
  }
}

const decisions = soakDecisions(SOAK_SEED, SOAK_TICKS);

describe('determinism', () => {
  it('same seed and decisions give the same hash and events across two runs', () => {
    const a = runScripted(SOAK_SEED, decisions, { maxTicks: 3_000 });
    const b = runScripted(SOAK_SEED, decisions, { maxTicks: 3_000 });
    expect(a.hash).toBe(b.hash);
    expect(a.events).toEqual(b.events);
    expect(a.state).toEqual(b.state);
  });

  it('a different seed gives a different hash', () => {
    const a = runScripted(1, [], { maxTicks: 10 });
    const b = runScripted(2, [], { maxTicks: 10 });
    expect(a.hash).not.toBe(b.hash);
  });

  it('cloneState mid-match, then continuing both, gives the same hash', () => {
    const original = createMatch(SOAK_SEED);
    continueTo(original, decisions, 1_234);
    const copy = cloneState(original);
    expect(hashState(copy)).toBe(hashState(original));
    continueTo(original, decisions, 5_000);
    continueTo(copy, decisions, 5_000);
    expect(hashState(copy)).toBe(hashState(original));
    expect(hashState(original)).toBe(runScripted(SOAK_SEED, decisions, { maxTicks: 5_000 }).hash);
  });

  it('cloneState across a round boundary (with a short round) stays in sync', () => {
    const config = { roundTicks: 200, roundPauseTicks: 30 };
    const original = createMatch(SOAK_SEED, config);
    continueTo(original, decisions, 210);
    expect(original.status).toBe('roundOver');
    const copy = cloneState(original);
    continueTo(original, decisions, 900);
    continueTo(copy, decisions, 900);
    expect(hashState(copy)).toBe(hashState(original));
    expect(hashState(original)).toBe(
      runScripted(SOAK_SEED, decisions, { config, maxTicks: 900 }).hash,
    );
  });

  it(`${String(SOAK_TICKS)}-tick random-input soak matches the recorded hash`, () => {
    const { state, hash } = runScripted(SOAK_SEED, decisions, { maxTicks: SOAK_TICKS });
    expect(state.tick).toBeLessThanOrEqual(SOAK_TICKS);
    expect(runScripted(SOAK_SEED, decisions, { maxTicks: SOAK_TICKS }).hash).toBe(hash);
    if (process.env.UPDATE_SOAK === '1') {
      console.log(`EXPECTED_SOAK_HASH = '${hash}'`);
      return;
    }
    expect(hash).toBe(EXPECTED_SOAK_HASH);
  });
});
