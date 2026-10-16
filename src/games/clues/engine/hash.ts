import { fnv1a64 } from '../../../core/util/hash.js';
import type { CluesState } from './types.js';

/**
 * State hash: FNV-1a 64 over a fixed byte encoding of every CluesState field, in the writer
 * table's key order. The table is typed so that leaving a field out is a compile error, and
 * `HASHED_KEYS` lets a test check the runtime state has no field the table misses.
 *
 * Encoding: a version byte, then per field: integers as 4 bytes little-endian of `n >>> 0`,
 * booleans as one byte, arrays as their length (an integer) then their items.
 */

/**
 * Bumped with the rules, so a state from other rules never hashes the same. 2: game version 2,
 * where a turn is one of a word's three reveal steps (48 turns a match).
 */
const ENCODING_VERSION = 2;

class ByteWriter {
  readonly bytes: number[] = [ENCODING_VERSION];

  int(n: number): void {
    if (!Number.isInteger(n) || n < -0x80000000 || n > 0xffffffff) {
      throw new RangeError(`hashCluesState: non-integer or out-of-range number ${String(n)}`);
    }
    const u = n >>> 0;
    this.bytes.push(u & 0xff, (u >>> 8) & 0xff, (u >>> 16) & 0xff, u >>> 24);
  }

  bool(b: boolean): void {
    this.bytes.push(b ? 1 : 0);
  }

  ints(items: readonly number[]): void {
    this.int(items.length);
    for (const n of items) this.int(n);
  }
}

type Writers<T> = { readonly [K in keyof T]-?: (w: ByteWriter, v: T[K]) => void };

const ints = (w: ByteWriter, v: readonly number[]): void => {
  w.ints(v);
};

const writers: Writers<CluesState> = {
  seed: (w, v) => {
    w.int(v);
  },
  boardIndex: (w, v) => {
    w.int(v);
  },
  order: ints,
  turn: (w, v) => {
    w.int(v);
  },
  scores: ints,
  correctCount: ints,
  correctLatencyMs: ints,
  over: (w, v) => {
    w.bool(v);
  },
};

/** The fields the hash covers, in encoding order (the coverage test compares them with a state). */
export const HASHED_KEYS = Object.keys(writers) as (keyof CluesState)[];

/** 16 lowercase hex chars. Throws if a number is not an integer. */
export function hashCluesState(state: CluesState): string {
  const w = new ByteWriter();
  for (const key of HASHED_KEYS) {
    (writers[key] as (w: ByteWriter, v: unknown) => void)(w, state[key]);
  }
  return fnv1a64(w.bytes);
}
