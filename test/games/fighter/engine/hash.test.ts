import { describe, expect, it } from 'vitest';
import {
  HASHED_CONFIG_KEYS,
  HASHED_FIGHTER_KEYS,
  HASHED_MATCH_KEYS,
  HASHED_PRNG_KEYS,
  HASHED_PROJECTILE_KEYS,
  hashState,
} from '../../../../src/games/fighter/engine/hash.js';
import { cloneState, createMatch, step } from '../../../../src/games/fighter/engine/sim.js';
import type { MatchState } from '../../../../src/games/fighter/engine/types.js';

/** First element, or throw (keeps tests free of non-null assertions). */
function at<T>(items: readonly T[]): T {
  const v = items[0];
  if (v === undefined) throw new Error('empty');
  return v;
}
const sorted = (keys: readonly string[]) => [...keys].sort();

function fixedState(): MatchState {
  const state = createMatch(1234);
  step(state, ['walk_forward', 'block_low']);
  for (let i = 0; i < 9; i++) step(state, [null, null]);
  state.projectiles.push({ owner: 0, x: 40_000, vx: 600, active: true });
  state.roundResults.push({
    round: 1,
    winner: 'draw',
    reason: 'timeout',
    endTick: 3600,
    health: [50, 50],
  });
  return state;
}

describe('hashState', () => {
  it('returns 16 hex chars and is stable for a fixed state', () => {
    const h = hashState(fixedState());
    expect(h).toMatch(/^[0-9a-f]{16}$/);
    expect(h).toBe(hashState(fixedState()));
    expect(h).toBe(KNOWN_FIXED_HASH);
  });

  it('is unchanged by cloneState and clones are independent', () => {
    const a = fixedState();
    const b = cloneState(a);
    expect(hashState(b)).toBe(hashState(a));
    b.fighters[0].lastMoves.push('jab');
    at(b.projectiles).x += 1;
    expect(hashState(b)).not.toBe(hashState(a));
    expect(a.fighters[0].lastMoves).not.toContain('jab');
  });

  it('covers every field of every state object (fails when a new field is not hashed)', () => {
    const s = fixedState();
    s.fighters[1].buffered = { move: 'jab', ticksLeft: 3 };
    expect(sorted(Object.keys(s))).toEqual(sorted(HASHED_MATCH_KEYS));
    expect(sorted(Object.keys(s.fighters[0]))).toEqual(sorted(HASHED_FIGHTER_KEYS));
    expect(sorted(Object.keys(at(s.projectiles)))).toEqual(sorted(HASHED_PROJECTILE_KEYS));
    expect(sorted(Object.keys(s.prng))).toEqual(sorted(HASHED_PRNG_KEYS));
    expect(sorted(Object.keys(s.config))).toEqual(sorted(HASHED_CONFIG_KEYS));
    expect(sorted(Object.keys(s.fighters[1].buffered))).toEqual(['move', 'ticksLeft']);
    expect(sorted(Object.keys(at(s.roundResults)))).toEqual(
      sorted(['round', 'winner', 'reason', 'endTick', 'health']),
    );
  });

  /** Mutate each leaf of the state, one at a time, and require the hash to change. */
  it('changes when any single field changes', () => {
    const base = fixedState();
    const baseHash = hashState(base);
    const mutations: [string, (s: MatchState) => void][] = [];

    for (const key of HASHED_MATCH_KEYS) {
      mutations.push([
        `match.${key}`,
        (s) => {
          mutateMatchField(s, key);
        },
      ]);
    }
    for (const side of [0, 1] as const) {
      for (const key of HASHED_FIGHTER_KEYS) {
        mutations.push([
          `fighters[${String(side)}].${key}`,
          (s) => {
            mutateObjectField(s.fighters[side] as unknown as Record<string, unknown>, key);
          },
        ]);
      }
    }
    for (const key of HASHED_PROJECTILE_KEYS) {
      mutations.push([
        `projectiles[0].${key}`,
        (s) => {
          mutateObjectField(s.projectiles[0] as unknown as Record<string, unknown>, key);
        },
      ]);
    }
    for (const key of HASHED_PRNG_KEYS) {
      mutations.push([`prng.${key}`, (s) => (s.prng[key] = (s.prng[key] + 1) >>> 0)]);
    }
    for (const key of HASHED_CONFIG_KEYS) {
      mutations.push([`config.${key}`, (s) => (s.config[key] += 1)]);
    }
    for (const key of ['round', 'winner', 'reason', 'endTick', 'health'] as const) {
      mutations.push([
        `roundResults[0].${key}`,
        (s) => {
          const r = at(s.roundResults);
          if (key === 'winner') r.winner = 0;
          else if (key === 'reason') r.reason = 'ko';
          else if (key === 'health') r.health[1] += 1;
          else r[key] += 1;
        },
      ]);
    }
    mutations.push([
      'buffered.move',
      (s) => (s.fighters[0].buffered = { move: 'jab', ticksLeft: 1 }),
    ]);

    for (const [name, mutate] of mutations) {
      const s = cloneState(base);
      mutate(s);
      expect(hashState(s), name).not.toBe(baseHash);
    }

    // Nested buffered fields, and order within arrays.
    const withBuf = cloneState(base);
    withBuf.fighters[0].buffered = { move: 'jab', ticksLeft: 1 };
    const h1 = hashState(withBuf);
    withBuf.fighters[0].buffered.ticksLeft = 2;
    expect(hashState(withBuf)).not.toBe(h1);
    withBuf.fighters[0].buffered.move = 'throw';
    expect(hashState(withBuf)).not.toBe(h1);

    const ordered = cloneState(base);
    ordered.fighters[0].lastMoves = ['jab', 'throw'];
    const reordered = cloneState(base);
    reordered.fighters[0].lastMoves = ['throw', 'jab'];
    expect(hashState(ordered)).not.toBe(hashState(reordered));
  });

  it('rejects non-integer numbers so floats cannot sneak into the state', () => {
    const s = fixedState();
    s.fighters[0].x = 1.5;
    expect(() => hashState(s)).toThrow();
  });
});

function mutateMatchField(s: MatchState, key: (typeof HASHED_MATCH_KEYS)[number]): void {
  switch (key) {
    case 'fighters':
      s.fighters[0].health -= 1;
      return;
    case 'projectiles':
      s.projectiles.push({ owner: 1, x: 1, vx: -600, active: true });
      return;
    case 'prng':
      s.prng.a = (s.prng.a + 1) >>> 0;
      return;
    case 'config':
      s.config.roundTicks += 1;
      return;
    case 'status':
      s.status = 'roundOver';
      return;
    case 'winner':
      s.winner = 1;
      return;
    case 'roundResults':
      s.roundResults.pop();
      return;
    default:
      s[key] += 1;
  }
}

function mutateObjectField(obj: Record<string, unknown>, key: string): void {
  const v = obj[key];
  if (typeof v === 'number') obj[key] = v + 1;
  else if (typeof v === 'boolean') obj[key] = !v;
  else if (Array.isArray(v)) v.push('jab');
  else if (key === 'pendingHold') obj[key] = v === 'block_low' ? 'block_high' : 'block_low';
  else if (v === null) obj[key] = { move: 'jab', ticksLeft: 1 };
  else if (key === 'action') obj[key] = v === 'jab' ? 'throw' : 'jab';
  else if (key === 'phase') obj[key] = v === 'hitstun' ? 'blockstun' : 'hitstun';
  else throw new Error(`no mutation for ${key}`);
}

const KNOWN_FIXED_HASH = 'ab21d7fe19b9bc87';
