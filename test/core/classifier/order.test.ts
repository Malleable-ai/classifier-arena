import { describe, expect, it } from 'vitest';
import { OPTION_ORDER_RULE, orderOptions } from '../../../src/core/classifier/order.js';
import type { Question } from '../../../src/core/classifier/types.js';
import { fnv1a64, utf8Bytes } from '../../../src/core/util/hash.js';
import { createPrng, nextBelow } from '../../../src/core/util/prng.js';

/** A canonical question with `n` options `o0…o(n-1)`. */
function question(n: number): Question {
  return {
    name: 'pick',
    instructions: 'Pick one.',
    options: Array.from({ length: n }, (_, i) => ({
      id: `o${String(i)}`,
      description: `d${String(i)}`,
    })),
  };
}

const ids = (q: Question): string[] => q.options.map((o) => o.id);

/** The rule as documented, written out independently of order.ts. */
function byTheRule(q: Question, matchSeed: number, key: string): string[] {
  const low32 = parseInt(fnv1a64(utf8Bytes(key)).slice(8), 16);
  const prng = createPrng((matchSeed ^ 0x6f70746e ^ low32) >>> 0);
  const out = ids(q);
  for (let i = out.length - 1; i > 0; i--) {
    const j = nextBelow(prng, i + 1);
    [out[i], out[j]] = [out[j] ?? '', out[i] ?? ''];
  }
  return out;
}

describe('orderOptions', () => {
  const q = question(11);

  it('returns a permutation of the canonical options, each with its own description', () => {
    const ordered = orderOptions(q, 7, 'next_move');
    expect([...ids(ordered)].sort()).toEqual([...ids(q)].sort());
    for (const o of ordered.options) expect(o.description).toBe(`d${o.id.slice(1)}`);
    expect(ordered.name).toBe(q.name);
    expect(ordered.instructions).toBe(q.instructions);
  });

  it('follows OPTION_ORDER_RULE exactly', () => {
    expect(OPTION_ORDER_RULE).toBe(
      'sfc32((matchSeed ^ 0x6f70746e ^ low32(fnv1a64(utf8(questionKey)))) >>> 0) fisher-yates ' +
        "over the game's canonical options; same order for both seats",
    );
    for (const [seed, key] of [
      [1, 'next_move'],
      [20261007, 'next_move'],
      [0xffffffff, 'turn-3'],
      [0, ''],
      [42, 'clue:é✓'],
    ] as const) {
      expect(ids(orderOptions(q, seed, key)), `${String(seed)} ${key}`).toEqual(
        byTheRule(q, seed, key),
      );
    }
  });

  it('pins one order, so a change to the rule cannot go unnoticed', () => {
    expect(ids(orderOptions(q, 20261007, 'next_move'))).toMatchInlineSnapshot(`
      [
        "o0",
        "o9",
        "o1",
        "o6",
        "o5",
        "o4",
        "o8",
        "o7",
        "o10",
        "o3",
        "o2",
      ]
    `);
  });

  it('gives the same order for the same key and seed', () => {
    expect(orderOptions(q, 99, 'turn-1')).toEqual(orderOptions(q, 99, 'turn-1'));
  });

  it('gives different orders for different keys (20 keys, same seed)', () => {
    const orders = new Set(
      Array.from({ length: 20 }, (_, i) => ids(orderOptions(q, 5, `turn-${String(i)}`)).join()),
    );
    expect(orders.size).toBeGreaterThanOrEqual(18);
  });

  it('gives different orders for different seeds (same key)', () => {
    const orders = new Set(
      Array.from({ length: 20 }, (_, seed) => ids(orderOptions(q, seed, 'next_move')).join()),
    );
    expect(orders.size).toBeGreaterThanOrEqual(18);
  });

  it('has no seat input: both seats asking the same key get the same order', () => {
    expect(orderOptions).toHaveLength(3);
    const seat0 = orderOptions(q, 123, 'next_move');
    const seat1 = orderOptions(q, 123, 'next_move');
    expect(seat1).toEqual(seat0);
  });

  it('does not mutate its input', () => {
    const input = question(16);
    const before = structuredClone(input);
    Object.freeze(input.options);
    const out = orderOptions(input, 3, 'k');
    expect(input).toEqual(before);
    expect(out).not.toBe(input);
    expect(out.options).not.toBe(input.options);
  });

  it('rejects questions with fewer than two options (validateQuestion) and orders two', () => {
    expect(() => orderOptions(question(0), 1, 'k')).toThrow(/at least 2 options/);
    expect(() => orderOptions(question(1), 1, 'k')).toThrow(/at least 2 options/);
    expect([...ids(orderOptions(question(2), 1, 'k'))].sort()).toEqual(['o0', 'o1']);
  });

  it('rejects option ids that JS would reorder as object keys', () => {
    const q2: Question = {
      name: 'pick',
      instructions: 'Pick one.',
      options: [
        { id: 'b', description: 'B' },
        { id: '2', description: 'Two' },
      ],
    };
    expect(() => orderOptions(q2, 1, 'k')).toThrow(/option id "2"/);
  });
});
