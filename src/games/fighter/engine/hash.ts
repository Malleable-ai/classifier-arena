import { fnv1a64 } from '../../../core/util/hash.js';
import type {
  BufferedInput,
  EngineConfig,
  FighterState,
  MatchState,
  PrngState,
  Projectile,
  RoundResult,
} from './types.js';

/**
 * State hash: a hand-written canonical serialization of every MatchState field, folded through
 * FNV-1a 64 (two u32 halves, integer-only so Node and browsers agree). Returns 16 hex chars.
 *
 * Each object type has a writer table typed `Writers<T>`, so leaving a field of T out is a
 * compile error. The serialization order is the table's key order. hash.test.ts also checks the
 * runtime objects have no extra keys.
 */

/** Byte sink. Integers are 4 bytes little-endian of `n >>> 0`; strings are length + UTF-16 units. */
class ByteWriter {
  readonly bytes: number[] = [];

  int(n: number): void {
    if (!Number.isInteger(n) || n < -0x80000000 || n > 0xffffffff) {
      throw new RangeError(`hashState: non-integer or out-of-range number ${String(n)}`);
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

  /** `Side | 'draw' | null` style values: tag byte, then payload. */
  sideOrTag(v: number | string | null): void {
    if (v === null) this.bytes.push(0);
    else if (typeof v === 'number') {
      this.bytes.push(1);
      this.int(v);
    } else {
      this.bytes.push(2);
      this.str(v);
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

const bufferedWriters: Writers<BufferedInput> = { move: str, ticksLeft: int };

const fighterWriters: Writers<FighterState> = {
  x: int,
  vx: int,
  y: int,
  vy: int,
  health: int,
  action: str,
  phase: str,
  phaseTick: int,
  busyTicks: int,
  invulnTicks: int,
  fireballCooldown: int,
  buffered: (w, v) => {
    w.bool(v !== null);
    if (v !== null) writeFields(w, v, bufferedWriters);
  },
  pendingHold: (w, v) => {
    w.sideOrTag(v);
  },
  lastMoves: (w, v) => {
    writeArray(w, v, str);
  },
  roundsWon: int,
  hitThisMove: bool,
};

const projectileWriters: Writers<Projectile> = { owner: int, x: int, vx: int, active: bool };

const prngWriters: Writers<PrngState> = { a: int, b: int, c: int, d: int };

const configWriters: Writers<EngineConfig> = {
  maxHealth: int,
  roundTicks: int,
  roundsToWin: int,
  maxRounds: int,
  bufferTicks: int,
  roundPauseTicks: int,
};

const roundResultWriters: Writers<RoundResult> = {
  round: int,
  winner: (w, v) => {
    w.sideOrTag(v);
  },
  reason: str,
  endTick: int,
  health: (w, v) => {
    writeArray(w, v, int);
  },
};

const matchWriters: Writers<MatchState> = {
  tick: int,
  roundTick: int,
  round: int,
  fighters: (w, v) => {
    writeArray(w, v, (w2, f) => {
      writeFields(w2, f, fighterWriters);
    });
  },
  projectiles: (w, v) => {
    writeArray(w, v, (w2, p) => {
      writeFields(w2, p, projectileWriters);
    });
  },
  prng: (w, v) => {
    writeFields(w, v, prngWriters);
  },
  status: str,
  winner: (w, v) => {
    w.sideOrTag(v);
  },
  roundResults: (w, v) => {
    writeArray(w, v, (w2, r) => {
      writeFields(w2, r, roundResultWriters);
    });
  },
  pauseTicksLeft: int,
  config: (w, v) => {
    writeFields(w, v, configWriters);
  },
};

/** Field lists the hasher covers, in serialization order (used by the coverage test). */
export const HASHED_MATCH_KEYS = Object.keys(matchWriters) as (keyof MatchState)[];
export const HASHED_FIGHTER_KEYS = Object.keys(fighterWriters) as (keyof FighterState)[];
export const HASHED_PROJECTILE_KEYS = Object.keys(projectileWriters) as (keyof Projectile)[];
export const HASHED_PRNG_KEYS = Object.keys(prngWriters) as (keyof PrngState)[];
export const HASHED_CONFIG_KEYS = Object.keys(configWriters) as (keyof EngineConfig)[];

/** Hash the full match state. Throws if any number is not an integer. */
export function hashState(state: MatchState): string {
  const w = new ByteWriter();
  writeFields(w, state, matchWriters);
  return fnv1a64(w.bytes);
}
