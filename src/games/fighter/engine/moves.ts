import { SUB } from './constants.js';
import type { MoveData, MoveId } from './types.js';

/**
 * Frame data for the 11 options, documented in docs/architecture/fighter.md. Startup/active/
 * recovery/damage come from the first design's move table; reach and stun values were its starting
 * values (hitstun = recovery + 4, blockstun = recovery - 2). Engine v2 tuned six of them with
 * `pnpm tune --game fighter` (fighter.md, "Tuning"): jab and heavy_punch reach, heavy_punch stun,
 * uppercut, throw and jump_in recovery. Damage is unchanged: the option descriptions in prompt.ts
 * state it, and that config is frozen.
 *
 * Phase timing (ticks counted from the tick the move starts, which is startup tick 1):
 * startup ticks 1..S, active S+1..S+A, recovery S+A+1..S+A+R, idle again on S+A+R+1.
 */

/** Knockdown time on the floor (sweep, throw). Untouchable while down. */
export const KNOCKDOWN_TICKS = 40;
/** Fireball speed and cooldown (1.5 s, counted from spawn). */
export const FIREBALL_SPEED = 6 * SUB;
export const FIREBALL_COOLDOWN = 90;
/** Two fireballs whose centers are within 2x this cancel. */
export const FIREBALL_HALF_WIDTH = 10 * SUB;
/** Two throws on the same tick push the fighters this much further apart (each moves half). */
export const THROW_TECH_PUSH = 40 * SUB;

/** Jump arc: JUMP_ARC_TICKS long, y(t) = JUMP_G * t * (ARC - t) / 2, so peak = 120 units. */
export const JUMP_ARC_TICKS = 40;
export const JUMP_G = 60;
/** Forward jump speed; clamped so the jumper lands in front of the opponent. */
export const JUMP_VX = 5 * SUB;
/** Landing recovery after a jump-in (8 before tuning): a landed or blocked jump-in is minus. */
export const JUMP_LANDING_RECOVERY = 28;

function hold(): MoveData {
  return {
    kind: 'hold',
    startup: 0,
    active: 0,
    recovery: 0,
    damage: 0,
    reach: 0,
    height: null,
    hitstun: 0,
    blockstun: 0,
    pushOnHit: 0,
    chip: 0,
    knockdown: 0,
    invulnStartTicks: 0,
    cooldown: 0,
    airborne: false,
  };
}

type OneShot = Omit<
  MoveData,
  'kind' | 'hitstun' | 'blockstun' | 'chip' | 'invulnStartTicks' | 'cooldown' | 'airborne'
> &
  Partial<MoveData>;

function oneShot(d: OneShot): MoveData {
  return {
    kind: 'oneShot',
    hitstun: d.recovery + 4,
    blockstun: d.recovery - 2,
    chip: 0,
    invulnStartTicks: 0,
    cooldown: 0,
    airborne: false,
    ...d,
  };
}

export const MOVES: Readonly<Record<MoveId, MoveData>> = {
  walk_forward: hold(),
  walk_back: hold(),
  block_high: hold(),
  block_low: hold(),
  jab: oneShot({
    startup: 4,
    active: 3,
    recovery: 8,
    damage: 4,
    /** 120 (was 110): reaches the whole `close` range the view and primer name (< 120). */
    reach: 120 * SUB,
    height: 'mid',
    pushOnHit: 5 * SUB,
    knockdown: 0,
  }),
  /**
   * Reach 130 (was 160) and stun 16 / 10 (was the formula's 22 / 16, so -5 on hit instead of +1):
   * at 160 a heavy spammer kept an approaching opponent at mid range and hit it there.
   */
  heavy_punch: oneShot({
    startup: 9,
    active: 4,
    recovery: 18,
    damage: 9,
    reach: 130 * SUB,
    height: 'mid',
    pushOnHit: 20 * SUB,
    knockdown: 0,
    hitstun: 16,
    blockstun: 10,
  }),
  sweep: oneShot({
    startup: 7,
    active: 4,
    recovery: 20,
    damage: 7,
    reach: 150 * SUB,
    height: 'low',
    pushOnHit: 0,
    knockdown: KNOCKDOWN_TICKS,
  }),
  /** Active 0: the fireball spawns on the tick startup ends, and that tick is recovery tick 1. */
  fireball: oneShot({
    startup: 12,
    active: 0,
    recovery: 20,
    damage: 6,
    reach: 0,
    height: 'projectile',
    pushOnHit: 0,
    chip: 1,
    knockdown: 0,
    cooldown: FIREBALL_COOLDOWN,
  }),
  /**
   * Recovery 50 (was 30) with the stun left at 34 / 28 (the old formula values), so it is -21 on
   * hit and -27 on block: invulnerable on startup and fast, it won almost every match when it
   * could be used again before the opponent acted.
   */
  uppercut: oneShot({
    startup: 3,
    active: 6,
    recovery: 50,
    damage: 10,
    reach: 90 * SUB,
    height: 'mid',
    pushOnHit: 0,
    knockdown: 0,
    invulnStartTicks: 6,
    hitstun: 34,
    blockstun: 28,
  }),
  /** Connects (or whiffs) on its single active tick, i.e. right at the end of startup. */
  throw: oneShot({
    startup: 3,
    active: 1,
    /** 22 (was 20): a whiffed throw is punishable a little longer. */
    recovery: 22,
    damage: 10,
    reach: 80 * SUB,
    height: 'throw',
    pushOnHit: 0,
    knockdown: KNOCKDOWN_TICKS,
    hitstun: 0,
    blockstun: 0,
  }),
  /**
   * Startup + active is the 40-tick arc (airborne throughout); the kick is the last 12 ticks.
   * Recovery is the landing (JUMP_LANDING_RECOVERY, 28). The stun values were raised from the
   * formula when the landing was 8 ticks; with the 28-tick landing a landed jump-in is minus, so
   * the opponent can punish it: only an uppercut or a jump-in reaches a jumper in the air.
   */
  jump_in: oneShot({
    startup: JUMP_ARC_TICKS - 12,
    active: 12,
    recovery: JUMP_LANDING_RECOVERY,
    damage: 8,
    reach: 110 * SUB,
    height: 'overhead',
    pushOnHit: 0,
    knockdown: 0,
    hitstun: 20,
    blockstun: 12,
    airborne: true,
  }),
};
