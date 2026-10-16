import { fnv1a64 } from '../../../core/util/hash.js';
import type { InboxConfig, InboxState, Lane, Ramp, StreamItem } from './types.js';

/**
 * State hash: a hand-written canonical serialization of every InboxState field, folded through
 * FNV-1a 64 (core `fnv1a64`, integer-only so Node and browsers agree). 16 lowercase hex chars.
 *
 * Each object type has a writer table typed `Writers<T>`, so leaving a field of T out is a
 * compile error; the serialization order is the table's key order. hash.test.ts also checks the
 * runtime objects have no extra keys. Same scheme as the fighter's src/engine/hash.ts.
 */

/** Byte sink. Integers are 4 bytes little-endian of `n >>> 0`; strings are length + UTF-16 units. */
class ByteWriter {
  readonly bytes: number[] = [];

  int(n: number): void {
    if (!Number.isInteger(n) || n < -0x80000000 || n > 0xffffffff) {
      throw new RangeError(`hashInbox: non-integer or out-of-range number ${String(n)}`);
    }
    const u = n >>> 0;
    this.bytes.push(u & 0xff, (u >>> 8) & 0xff, (u >>> 16) & 0xff, u >>> 24);
  }

  bool(b: boolean): void {
    this.bytes.push(b ? 1 : 0);
  }

  str(s: string): void {
    this.int(s.length);
    for (let i = 0; i < s.length; i++) {
      const code = s.charCodeAt(i);
      this.bytes.push(code & 0xff, code >>> 8);
    }
  }
}

type Writers<T> = { readonly [K in keyof T]-?: (w: ByteWriter, v: T[K]) => void };

function writeFields<T extends object>(w: ByteWriter, obj: T, writers: Writers<T>): void {
  for (const key of Object.keys(writers) as (keyof T)[]) {
    (writers[key] as (w: ByteWriter, v: unknown) => void)(w, obj[key]);
  }
}

function writeArray<T>(w: ByteWriter, items: readonly T[], item: (w: ByteWriter, v: T) => void) {
  w.int(items.length);
  for (const v of items) item(w, v);
}

const int = (w: ByteWriter, v: number) => {
  w.int(v);
};
const str = (w: ByteWriter, v: string) => {
  w.str(v);
};
const bool = (w: ByteWriter, v: boolean) => {
  w.bool(v);
};

const rampWriters: Writers<Ramp> = { startTicks: int, endTicks: int, rampTicks: int };

const configWriters: Writers<InboxConfig> = {
  health: int,
  damage: int,
  smishingMultiplier: int,
  maxChars: int,
  streamLength: int,
  spawn: (w, v) => {
    writeFields(w, v, rampWriters);
  },
  fall: (w, v) => {
    writeFields(w, v, rampWriters);
  },
};

const itemWriters: Writers<StreamItem> = { id: str, label: str, spawnTick: int, landTick: int };

const laneWriters: Writers<Lane> = {
  health: int,
  active: (w, v) => {
    writeArray(w, v, str);
  },
  cleared: int,
  wrong: int,
  landed: int,
  answered: int,
  correct: int,
  outcomes: (w, v) => {
    writeArray(w, v, int);
  },
};

const stateWriters: Writers<InboxState> = {
  tick: int,
  seed: int,
  config: (w, v) => {
    writeFields(w, v, configWriters);
  },
  stream: (w, v) => {
    writeArray(w, v, (w2, item) => {
      writeFields(w2, item, itemWriters);
    });
  },
  next: int,
  lanes: (w, v) => {
    writeArray(w, v, (w2, lane) => {
      writeFields(w2, lane, laneWriters);
    });
  },
  over: bool,
};

/** Field lists the hasher covers, in serialization order (used by the coverage test). */
export const HASHED_STATE_KEYS = Object.keys(stateWriters) as (keyof InboxState)[];
export const HASHED_LANE_KEYS = Object.keys(laneWriters) as (keyof Lane)[];
export const HASHED_ITEM_KEYS = Object.keys(itemWriters) as (keyof StreamItem)[];
export const HASHED_CONFIG_KEYS = Object.keys(configWriters) as (keyof InboxConfig)[];
export const HASHED_RAMP_KEYS = Object.keys(rampWriters) as (keyof Ramp)[];

/** Hash the full state. Throws if any number is not an integer. */
export function hashInbox(state: InboxState): string {
  const w = new ByteWriter();
  writeFields(w, state, stateWriters);
  return fnv1a64(w.bytes);
}
