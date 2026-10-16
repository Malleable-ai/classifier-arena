import { LAST_MOVES_MAX, PUSHBOX_HALF_WIDTH, STAGE_MAX, STAGE_MIN, START_X } from './constants.js';
import type { EngineConfig, FighterState, MatchState, MoveId, Side, StepEvent } from './types.js';

/**
 * Fighter helpers shared by sim.ts (2a), combat.ts (2b) and rounds.ts (2c).
 * Lives outside sim.ts so combat/rounds can use it without importing sim (no cycles).
 */

export const LEFT_LIMIT = STAGE_MIN + PUSHBOX_HALF_WIDTH;
export const RIGHT_LIMIT = STAGE_MAX - PUSHBOX_HALF_WIDTH;
const MIN_GAP = 2 * PUSHBOX_HALF_WIDTH;

/** A fresh fighter at its start position. 2c's round reset can reuse it (keep `roundsWon`). */
export function createFighter(side: Side, config: EngineConfig): FighterState {
  return {
    x: START_X[side],
    vx: 0,
    y: 0,
    vy: 0,
    health: config.maxHealth,
    action: 'stand',
    phase: 'idle',
    phaseTick: 0,
    busyTicks: 0,
    invulnTicks: 0,
    fireballCooldown: 0,
    buffered: null,
    pendingHold: null,
    lastMoves: [],
    roundsWon: 0,
    hitThisMove: false,
  };
}

/** +1 if the fighter faces right. Always toward the opponent; ties go to side order. */
export function facingOf(state: MatchState, side: Side): 1 | -1 {
  const me = state.fighters[side].x;
  const opp = state.fighters[side === 0 ? 1 : 0].x;
  if (me === opp) return side === 0 ? 1 : -1;
  return opp > me ? 1 : -1;
}

/** Can act on a new decision now (standing, walking or blocking). */
export function isIdle(f: FighterState): boolean {
  return f.phase === 'idle';
}

/** Append to `lastMoves`, keeping the last LAST_MOVES_MAX, oldest first. */
export function recordMove(f: FighterState, move: MoveId): void {
  f.lastMoves.push(move);
  while (f.lastMoves.length > LAST_MOVES_MAX) f.lastMoves.shift();
}

/** Emit `dropped` (reason 'superseded') for a waiting one-shot and clear it. */
export function supersedeBuffered(state: MatchState, side: Side, events: StepEvent[]): void {
  const f = state.fighters[side];
  if (f.buffered === null) return;
  events.push({
    type: 'dropped',
    tick: state.tick,
    fighter: side,
    move: f.buffered.move,
    reason: 'superseded',
  });
  f.buffered = null;
}

/** Emit `dropped` (reason 'superseded') for a pending hold and clear it. */
export function supersedePendingHold(state: MatchState, side: Side, events: StepEvent[]): void {
  const f = state.fighters[side];
  if (f.pendingHold === null) return;
  events.push({
    type: 'dropped',
    tick: state.tick,
    fighter: side,
    move: f.pendingHold,
    reason: 'superseded',
  });
  f.pendingHold = null;
}

/** Make `move` the stance now (the fighter must be idle) and emit `applied`. */
export function setHold(state: MatchState, side: Side, move: MoveId, events: StepEvent[]): void {
  const f = state.fighters[side];
  f.action = move;
  f.vx = 0;
  f.pendingHold = null;
  recordMove(f, move);
  events.push({ type: 'applied', tick: state.tick, fighter: side, move });
}

/**
 * Apply a hold (walk/block) decision. It supersedes any waiting one-shot or earlier pending hold.
 * If idle it takes effect now. If busy it becomes `pendingHold`, which never expires: combat.ts
 * (2b) applies it on the first idle tick, with an `applied` event then.
 */
export function applyHold(state: MatchState, side: Side, move: MoveId, events: StepEvent[]): void {
  const f = state.fighters[side];
  supersedeBuffered(state, side, events);
  supersedePendingHold(state, side, events);
  if (isIdle(f)) setHold(state, side, move, events);
  else f.pendingHold = move;
}

/** Move idle walking fighters by WALK_SPEED toward/away from the opponent; zero vx for others. */
export function walkFighters(state: MatchState, walkSpeed: number): void {
  for (const side of [0, 1] as const) {
    const f = state.fighters[side];
    if (!isIdle(f)) continue;
    const dir = facingOf(state, side);
    if (f.action === 'walk_forward') f.vx = dir * walkSpeed;
    else if (f.action === 'walk_back') f.vx = -dir * walkSpeed;
    else f.vx = 0;
    f.x += f.vx;
  }
}

/**
 * Walls and pushbox. Fighter 0 is always kept left of fighter 1 (no cross-ups), at least
 * 2 * PUSHBOX_HALF_WIDTH apart: each is pushed back half the overlap, and against a wall the
 * other takes all of it. An odd sub-unit goes to the fighter with more room behind it (never
 * by side, so mirrored states resolve to mirrored states; equal room implies an even overlap).
 * Centers are clamped to [LEFT_LIMIT, RIGHT_LIMIT]. Applies to airborne fighters too.
 */
export function resolvePositions(state: MatchState): void {
  const [a, b] = state.fighters;
  a.x = Math.min(Math.max(a.x, LEFT_LIMIT), RIGHT_LIMIT);
  b.x = Math.min(Math.max(b.x, LEFT_LIMIT), RIGHT_LIMIT);
  const overlap = MIN_GAP - (b.x - a.x);
  if (overlap <= 0) return;
  const roomA = a.x - LEFT_LIMIT;
  const roomB = RIGHT_LIMIT - b.x;
  const pushA = Math.floor(overlap / 2) + (overlap % 2 === 1 && roomA > roomB ? 1 : 0);
  a.x -= pushA;
  b.x += overlap - pushA;
  if (a.x < LEFT_LIMIT) {
    b.x += LEFT_LIMIT - a.x;
    a.x = LEFT_LIMIT;
  } else if (b.x > RIGHT_LIMIT) {
    a.x -= b.x - RIGHT_LIMIT;
    b.x = RIGHT_LIMIT;
  }
}
