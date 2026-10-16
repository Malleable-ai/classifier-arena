import { describe, expect, it } from 'vitest';
import {
  HASHED_CONFIG_KEYS,
  HASHED_ITEM_KEYS,
  HASHED_LANE_KEYS,
  HASHED_RAMP_KEYS,
  HASHED_STATE_KEYS,
  hashInbox,
} from '../../../src/games/inbox/engine/hash.js';
import { cloneInbox, stepInbox } from '../../../src/games/inbox/engine/sim.js';
import { OUTCOME, type InboxState } from '../../../src/games/inbox/engine/types.js';
import { answer, itemAt, runTo, small, wrongFor } from './fixtures.js';

const sorted = (keys: readonly string[]) => [...keys].sort();

/** A mid-game state with every lane field non-trivial. */
function fixedState(): InboxState {
  const s = small({ streamLength: 8 });
  runTo(s, 20);
  stepInbox(s, [answer(itemAt(s, 1)), answer(itemAt(s, 1), wrongFor(itemAt(s, 1)))]);
  runTo(s, 31);
  return s;
}

/** Recorded once; changes only when the state layout or the engine's rules change. */
const KNOWN_FIXED_HASH = '34511f48b97f5068';

describe('hashInbox', () => {
  it('returns 16 hex chars and is stable for a fixed state', () => {
    const h = hashInbox(fixedState());
    expect(h).toMatch(/^[0-9a-f]{16}$/);
    expect(h).toBe(hashInbox(fixedState()));
    expect(h).toBe(KNOWN_FIXED_HASH);
  });

  it('is unchanged by cloneInbox, and clones are independent', () => {
    const a = fixedState();
    const b = cloneInbox(a);
    expect(hashInbox(b)).toBe(hashInbox(a));
    b.lanes[1].active.push('sms-999');
    expect(hashInbox(b)).not.toBe(hashInbox(a));
    expect(a.lanes[1].active).not.toContain('sms-999');
  });

  it('covers every field of every state object (fails when a new field is not hashed)', () => {
    const s = fixedState();
    expect(sorted(Object.keys(s))).toEqual(sorted(HASHED_STATE_KEYS));
    expect(sorted(Object.keys(s.lanes[0]))).toEqual(sorted(HASHED_LANE_KEYS));
    expect(sorted(Object.keys(itemAt(s, 0)))).toEqual(sorted(HASHED_ITEM_KEYS));
    expect(sorted(Object.keys(s.config))).toEqual(sorted(HASHED_CONFIG_KEYS));
    expect(sorted(Object.keys(s.config.spawn))).toEqual(sorted(HASHED_RAMP_KEYS));
    expect(sorted(Object.keys(s.config.fall))).toEqual(sorted(HASHED_RAMP_KEYS));
  });

  /** Mutate each leaf of the state, one at a time, and require the hash to change. */
  it('changes when any single field changes', () => {
    const base = fixedState();
    const baseHash = hashInbox(base);
    const mutations: [string, (s: InboxState) => void][] = [];
    const bump = (o: Record<string, unknown>, k: string): void => {
      const v = o[k];
      if (typeof v === 'number') o[k] = v + 1;
      else if (typeof v === 'boolean') o[k] = !v;
      else if (typeof v === 'string') o[k] = `${v}x`;
      else throw new Error(`not a leaf: ${k}`);
    };
    for (const key of HASHED_STATE_KEYS) {
      if (['config', 'stream', 'lanes'].includes(key)) continue;
      mutations.push([
        `state.${key}`,
        (s) => {
          bump(s as unknown as Record<string, unknown>, key);
        },
      ]);
    }
    for (const key of HASHED_CONFIG_KEYS) {
      if (key === 'spawn' || key === 'fall') {
        for (const rk of HASHED_RAMP_KEYS) {
          mutations.push([
            `config.${key}.${rk}`,
            (s) => {
              bump(s.config[key] as unknown as Record<string, unknown>, rk);
            },
          ]);
        }
        continue;
      }
      mutations.push([
        `config.${key}`,
        (s) => {
          bump(s.config as unknown as Record<string, unknown>, key);
        },
      ]);
    }
    for (const key of HASHED_ITEM_KEYS) {
      mutations.push([
        `stream[3].${key}`,
        (s) => {
          bump(itemAt(s, 3) as unknown as Record<string, unknown>, key);
        },
      ]);
    }
    mutations.push(['stream order', (s) => s.stream.reverse()]);
    for (const seat of [0, 1] as const) {
      for (const key of HASHED_LANE_KEYS) {
        if (key === 'active') {
          mutations.push([`lanes[${String(seat)}].active`, (s) => s.lanes[seat].active.pop()]);
          continue;
        }
        if (key === 'outcomes') {
          mutations.push([
            `lanes[${String(seat)}].outcomes`,
            (s) => (s.lanes[seat].outcomes[7] = OUTCOME.landed),
          ]);
          continue;
        }
        mutations.push([
          `lanes[${String(seat)}].${key}`,
          (s) => {
            bump(s.lanes[seat] as unknown as Record<string, unknown>, key);
          },
        ]);
      }
    }
    for (const [name, mutate] of mutations) {
      // A full deep copy: a clone shares the frozen stream.
      const s = structuredClone(base);
      mutate(s);
      expect(hashInbox(s), name).not.toBe(baseHash);
    }
    expect(mutations.length).toBeGreaterThan(30);
  });

  it('throws on a non-integer number', () => {
    const s = fixedState();
    s.lanes[0].health = 1.5;
    expect(() => hashInbox(s)).toThrow(/non-integer/);
  });
});
