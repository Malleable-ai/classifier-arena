import { describe, expect, it } from 'vitest';
import { createPrng, nextBelow } from '../../../src/core/util/prng.js';
import { canonicalJson, fnv1a64, utf8Bytes } from '../../../src/core/util/hash.js';

const ascii = (s: string) => Array.from(s, (ch) => ch.charCodeAt(0));

/** Independent BigInt FNV-1a 64 to cross-check the two-u32-halves version. */
function referenceFnv1a64(bytes: readonly number[]): string {
  const mask = (1n << 64n) - 1n;
  let h = 0xcbf29ce484222325n;
  for (const b of bytes) h = ((h ^ BigInt(b & 0xff)) * 0x100000001b3n) & mask;
  return h.toString(16).padStart(16, '0');
}

describe('fnv1a64', () => {
  it('matches the published FNV-1a 64 test vectors', () => {
    expect(fnv1a64([])).toBe('cbf29ce484222325');
    expect(fnv1a64(ascii('a'))).toBe('af63dc4c8601ec8c');
    expect(fnv1a64(ascii('foobar'))).toBe('85944171f73967e8');
  });

  it('agrees with a BigInt reference on random byte strings', () => {
    const prng = createPrng(99);
    for (let n = 0; n < 200; n++) {
      const bytes = Array.from({ length: nextBelow(prng, 64) }, () => nextBelow(prng, 256));
      expect(fnv1a64(bytes)).toBe(referenceFnv1a64(bytes));
    }
  });

  it('uses only the low 8 bits of each element', () => {
    expect(fnv1a64([0x161, 0x6f])).toBe(fnv1a64([0x61, 0x6f]));
  });
});

describe('utf8Bytes', () => {
  it('encodes ASCII, 2-byte, 3-byte and 4-byte code points', () => {
    expect(utf8Bytes('')).toEqual([]);
    expect(utf8Bytes('a')).toEqual([0x61]);
    expect(utf8Bytes('é')).toEqual([0xc3, 0xa9]);
    expect(utf8Bytes('€')).toEqual([0xe2, 0x82, 0xac]);
    expect(utf8Bytes('🥊')).toEqual([0xf0, 0x9f, 0xa5, 0x8a]);
  });

  it('feeds fnv1a64 the same bytes as ASCII for ASCII text', () => {
    expect(fnv1a64(utf8Bytes('foobar'))).toBe('85944171f73967e8');
  });
});

describe('canonicalJson', () => {
  it('sorts object keys, independent of insertion order', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson({ a: 2, b: 1 })).toBe(canonicalJson({ b: 1, a: 2 }));
  });

  it('sorts by UTF-16 code unit, not locale (uppercase before lowercase)', () => {
    expect(canonicalJson({ a: 1, B: 2, _: 3 })).toBe('{"B":2,"_":3,"a":1}');
  });

  it('keeps array order', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
    expect(canonicalJson([3, 1, 2])).not.toBe(canonicalJson([1, 2, 3]));
    expect(canonicalJson([])).toBe('[]');
  });

  it('sorts nested objects, including objects inside arrays', () => {
    const value = { z: { y: [{ b: 1, a: [2, { d: 4, c: 3 }] }] }, a: null, m: {} };
    expect(canonicalJson(value)).toBe(
      '{"a":null,"m":{},"z":{"y":[{"a":[2,{"c":3,"d":4}],"b":1}]}}',
    );
  });

  it('writes primitives as JSON.stringify does', () => {
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson(true)).toBe('true');
    expect(canonicalJson(false)).toBe('false');
    expect(canonicalJson(0)).toBe('0');
    expect(canonicalJson(-1.5)).toBe('-1.5');
    expect(canonicalJson('0')).toBe('"0"');
  });

  it('escapes strings like JSON.stringify and keeps non-ASCII text as is', () => {
    const value = { é: 'naïve 🥊', a: 'line\nbreak "quoted" \\ tab\t' };
    expect(canonicalJson(value)).toBe(
      '{"a":"line\\nbreak \\"quoted\\" \\\\ tab\\t","é":"naïve 🥊"}',
    );
    expect(JSON.parse(canonicalJson(value))).toEqual(value);
  });

  it('matches JSON.stringify for an object whose keys are already sorted', () => {
    const value = { a: [1, 'two', { b: false, c: null }], d: 'x' };
    expect(canonicalJson(value)).toBe(JSON.stringify(value));
  });
});
