/**
 * Engine types shared by sim.ts (2a), combat.ts / moves.ts (2b) and rounds.ts / run.ts (2c).
 * All numbers are integers: positions and velocities in sub-units, times in ticks.
 * Every field of MatchState and FighterState must also be serialized in hash.ts
 * (test/games/fighter/engine/hash.test.ts fails otherwise).
 */

import type { PrngState } from '../../../core/util/prng.js';

/** The 11 options, in canonical order (docs/architecture/fighter.md). The single source of it. */
export const MOVE_IDS = [
  'walk_forward',
  'walk_back',
  'block_high',
  'block_low',
  'jab',
  'heavy_punch',
  'sweep',
  'fireball',
  'uppercut',
  'throw',
  'jump_in',
] as const;

export type MoveId = (typeof MOVE_IDS)[number];

export type MoveKind = 'hold' | 'oneShot';

/** Hold vs one-shot per option. sim.ts routes inputs on this; moves.ts (2b) should reuse it. */
export const MOVE_KIND: Readonly<Record<MoveId, MoveKind>> = {
  walk_forward: 'hold',
  walk_back: 'hold',
  block_high: 'hold',
  block_low: 'hold',
  jab: 'oneShot',
  heavy_punch: 'oneShot',
  sweep: 'oneShot',
  fireball: 'oneShot',
  uppercut: 'oneShot',
  throw: 'oneShot',
  jump_in: 'oneShot',
};

export type Phase =
  'idle' | 'startup' | 'active' | 'recovery' | 'hitstun' | 'blockstun' | 'knockdown' | 'airborne';

export type Side = 0 | 1;

/** What a strike hits against. `null` for holds. */
export type AttackHeight = 'mid' | 'low' | 'overhead' | 'throw' | 'projectile';

/** Frame data for one option. Values live in moves.ts (2b). */
export interface MoveData {
  kind: MoveKind;
  startup: number;
  active: number;
  recovery: number;
  damage: number;
  /** Center-to-center reach in sub-units. */
  reach: number;
  height: AttackHeight | null;
  hitstun: number;
  blockstun: number;
  /** Sub-units the defender is pushed back on hit. */
  pushOnHit: number;
  /** Damage dealt through a block. */
  chip: number;
  /** Knockdown duration in ticks on hit; 0 = no knockdown. */
  knockdown: number;
  /** Ticks of strike invulnerability from the start of the move. */
  invulnStartTicks: number;
  /** Ticks before the move can be used again (fireball). */
  cooldown: number;
  airborne: boolean;
}

export interface BufferedInput {
  move: MoveId;
  ticksLeft: number;
}

export interface FighterState {
  /** Center x in sub-units. */
  x: number;
  vx: number;
  /** Height above the floor in sub-units (0 = grounded). */
  y: number;
  vy: number;
  health: number;
  /** Current hold or one-shot; 'stand' after a one-shot ends (not blocking). */
  action: MoveId | 'stand';
  phase: Phase;
  /** Ticks spent in the current phase. */
  phaseTick: number;
  /** Ticks until the fighter can act again (0 when idle). */
  busyTicks: number;
  invulnTicks: number;
  fireballCooldown: number;
  /**
   * A ONE-SHOT that arrived while it could not start; retried each tick until it starts or
   * ticksLeft hits 0 (then `dropped` 'busy'). Holds are never buffered here (see pendingHold).
   */
  buffered: BufferedInput | null;
  /**
   * The latest HOLD decided while busy. It becomes `action` on the first idle tick (with an
   * `applied` event) and never expires; a later one-shot or hold supersedes it.
   */
  pendingHold: MoveId | null;
  /** Last LAST_MOVES_MAX applied moves, oldest first. */
  lastMoves: MoveId[];
  roundsWon: number;
  /** The current one-shot already connected (one hit per move). */
  hitThisMove: boolean;
}

export interface Projectile {
  owner: Side;
  x: number;
  vx: number;
  active: boolean;
}

/** Defined with the PRNG in src/core/util/prng.ts. */
export type { PrngState };

/** Rules that tests (and future modes) may override. Stored in MatchState, so it is hashed. */
export interface EngineConfig {
  maxHealth: number;
  roundTicks: number;
  roundsToWin: number;
  maxRounds: number;
  bufferTicks: number;
  roundPauseTicks: number;
}

export type MatchStatus = 'fighting' | 'roundOver' | 'matchOver';

export type RoundEndReason = 'ko' | 'doubleKo' | 'timeout';

export interface RoundResult {
  round: number;
  winner: Side | 'draw';
  reason: RoundEndReason;
  /** `MatchState.tick` on which the round ended. */
  endTick: number;
  health: [number, number];
}

export interface MatchState {
  /** Global tick; the tick the next `step` call simulates. */
  tick: number;
  /** Ticks elapsed in the current round's fighting time (frozen during the pause). */
  roundTick: number;
  /** 1-based round number. */
  round: number;
  fighters: [FighterState, FighterState];
  projectiles: Projectile[];
  prng: PrngState;
  status: MatchStatus;
  winner: Side | 'draw' | null;
  roundResults: RoundResult[];
  /** Ticks left in the between-round pause while status === 'roundOver' (rounds.ts, 2c). */
  pauseTicksLeft: number;
  config: EngineConfig;
}

/** Per-tick inputs: a new decision per side, or null for "no new decision this tick". */
export type TickInputs = readonly [MoveId | null, MoveId | null];

/**
 * Everything `step` reports. `tick` is the tick being simulated; `fighter` is the actor
 * (the attacker for hit/blocked, the one whose input it was for applied/dropped).
 */
export type StepEvent =
  | { type: 'applied'; tick: number; fighter: Side; move: MoveId }
  | {
      type: 'dropped';
      tick: number;
      fighter: Side;
      move: MoveId;
      /**
       * 'busy': a one-shot waited BUFFER_TICKS and never started. 'superseded': a waiting input
       * was replaced by a newer decision. 'notFighting': arrived between rounds, or was still
       * waiting when the round ended.
       */
      reason: 'busy' | 'superseded' | 'notFighting';
    }
  | {
      type: 'hit';
      tick: number;
      fighter: Side;
      target: Side;
      move: MoveId;
      damage: number;
      knockdown: boolean;
    }
  | { type: 'blocked'; tick: number; fighter: Side; target: Side; move: MoveId; chip: number }
  | { type: 'whiff'; tick: number; fighter: Side; move: MoveId }
  | { type: 'throwTech'; tick: number }
  | { type: 'fireballClash'; tick: number }
  | {
      type: 'roundEnd';
      tick: number;
      round: number;
      winner: Side | 'draw';
      reason: RoundEndReason;
    }
  | { type: 'matchEnd'; tick: number; winner: Side | 'draw' };

export type StepEventType = StepEvent['type'];

/** A decision as logged: which fighter, the tick it was applied on, and the move. */
export interface AppliedDecision {
  fighter: Side;
  appliedTick: number;
  move: MoveId;
}
