import { PUSHBOX_HALF_WIDTH, STAGE_MAX, STAGE_MIN } from './constants.js';
import {
  facingOf,
  isIdle,
  recordMove,
  setHold,
  supersedeBuffered,
  supersedePendingHold,
} from './fighter.js';
import {
  FIREBALL_HALF_WIDTH,
  FIREBALL_SPEED,
  JUMP_ARC_TICKS,
  JUMP_G,
  JUMP_VX,
  MOVES,
  THROW_TECH_PUSH,
} from './moves.js';
import type { AttackHeight, FighterState, MatchState, MoveId, Side, StepEvent } from './types.js';
import { MOVE_KIND } from './types.js';

/**
 * Combat: one-shot moves, the input buffer, phases, strikes, blocking, throws, fireballs, jumps.
 *
 * updateCombat order each tick:
 *   1. per fighter (side 0, then 1): phase transitions (incl. fireball spawn and the return to
 *      'stand'); once idle, the buffered one-shot starts if it can, else the pending hold is
 *      applied; buffer countdown / `dropped`; then phaseTick++ (and stun countdown).
 *   2. jump arcs (x/y/vx/vy), both from start-of-tick positions so neither side is favoured.
 *   3. projectiles: move, despawn at walls, clash.
 *   4. collect every strike, throw and projectile hit, then apply them all (so same-tick hits
 *      trade); throw tech.
 *   5. `whiff` for moves whose active window ended without contact.
 *   6. timers: invulnTicks, fireballCooldown, busyTicks; health clamped at 0.
 *
 * After a step, `phase` is the phase the fighter was in during that tick, and `busyTicks` is
 * how many more ticks it stays busy.
 */

const MIN_GAP = 2 * PUSHBOX_HALF_WIDTH;

function other(side: Side): Side {
  return side === 0 ? 1 : 0;
}

function moveOf(f: FighterState): MoveId | null {
  return f.action === 'stand' ? null : f.action;
}

/** In the jump arc (startup or active of jump_in). */
export function isAirborne(f: FighterState): boolean {
  return f.action === 'jump_in' && (f.phase === 'startup' || f.phase === 'active');
}

function isStun(f: FighterState): boolean {
  return f.phase === 'hitstun' || f.phase === 'blockstun' || f.phase === 'knockdown';
}

/** In the active window of a strike (not a throw, not a projectile). */
function isActiveStrike(f: FighterState): boolean {
  const m = moveOf(f);
  if (f.phase !== 'active' || m === null) return false;
  const h = MOVES[m].height;
  return h === 'mid' || h === 'low' || h === 'overhead';
}

function canStart(state: MatchState, side: Side, move: MoveId): boolean {
  const f = state.fighters[side];
  if (!isIdle(f)) return false;
  if (move === 'fireball') {
    if (f.fireballCooldown > 0) return false;
    if (state.projectiles.some((p) => p.owner === side)) return false;
  }
  return true;
}

function startMove(state: MatchState, side: Side, move: MoveId, events: StepEvent[]): void {
  const f = state.fighters[side];
  f.action = move;
  f.phase = 'startup';
  f.phaseTick = 0;
  f.hitThisMove = false;
  f.invulnTicks = MOVES[move].invulnStartTicks;
  f.buffered = null;
  supersedePendingHold(state, side, events);
  f.vx = 0;
  recordMove(f, move);
  events.push({ type: 'applied', tick: state.tick, fighter: side, move });
}

/**
 * Called by `step` for each non-null ONE-SHOT input, side 0 then side 1, while fighting.
 * Starts the move if the fighter can act now; otherwise buffers it. Either way an older waiting
 * one-shot is dropped as 'superseded'. A pending hold is superseded once the move starts.
 */
export function applyInput(state: MatchState, side: Side, move: MoveId, events: StepEvent[]): void {
  supersedeBuffered(state, side, events);
  if (canStart(state, side, move)) startMove(state, side, move, events);
  else state.fighters[side].buffered = { move, ticksLeft: state.config.bufferTicks };
}

function spawnFireball(state: MatchState, side: Side): void {
  const f = state.fighters[side];
  const dir = facingOf(state, side);
  f.fireballCooldown = MOVES.fireball.cooldown;
  state.projectiles.push({
    owner: side,
    x: f.x + dir * PUSHBOX_HALF_WIDTH,
    vx: dir * FIREBALL_SPEED,
    active: true,
  });
}

function toIdle(f: FighterState, action: FighterState['action']): void {
  f.phase = 'idle';
  f.phaseTick = 0;
  f.busyTicks = 0;
  f.action = action;
  f.vx = 0;
  f.vy = 0;
  f.y = 0;
}

function transition(state: MatchState, side: Side): void {
  const f = state.fighters[side];
  for (;;) {
    if (isIdle(f)) return;
    if (isStun(f)) {
      if (f.busyTicks > 0) return;
      toIdle(f, f.phase === 'knockdown' ? 'stand' : f.action);
      return;
    }
    const move = moveOf(f);
    if (move === null) {
      toIdle(f, 'stand');
      return;
    }
    const m = MOVES[move];
    const dur = f.phase === 'startup' ? m.startup : f.phase === 'active' ? m.active : m.recovery;
    if (f.phaseTick < dur) return;
    f.phaseTick = 0;
    if (f.phase === 'startup') {
      f.phase = 'active';
      if (move === 'fireball') spawnFireball(state, side);
    } else if (f.phase === 'active') {
      f.phase = 'recovery';
    } else {
      // A finished one-shot leaves the fighter standing, NOT blocking, until its next input.
      toIdle(f, 'stand');
      return;
    }
  }
}

function advanceFighter(state: MatchState, side: Side, events: StepEvent[]): void {
  const f = state.fighters[side];
  transition(state, side);

  // pendingHold is always older than `buffered` (a hold decision clears the buffer), so a
  // one-shot that can start wins; otherwise the latest hold becomes the stance now.
  if (isIdle(f)) {
    if (f.buffered !== null && canStart(state, side, f.buffered.move)) {
      startMove(state, side, f.buffered.move, events);
    } else if (f.pendingHold !== null) {
      setHold(state, side, f.pendingHold, events);
    }
  }
  if (f.buffered !== null) {
    f.buffered.ticksLeft -= 1;
    if (f.buffered.ticksLeft <= 0) {
      events.push({
        type: 'dropped',
        tick: state.tick,
        fighter: side,
        move: f.buffered.move,
        reason: 'busy',
      });
      f.buffered = null;
    }
  }

  if (!isIdle(f)) {
    f.phaseTick += 1;
    if (isStun(f)) f.busyTicks -= 1;
  }
}

/**
 * Jump arcs. Each jumper moves JUMP_VX toward the opponent, but never past the opponent's front
 * (no cross-ups). Every step is computed from start-of-tick positions: against a grounded
 * opponent the jumper stops at its front; when both are airborne they split the free room
 * equally (an odd sub-unit is left unused), so a mirrored situation gives a mirrored result.
 */
function updateJumps(state: MatchState): void {
  const [a, b] = state.fighters;
  const air = [isAirborne(a), isAirborne(b)] as const;
  const room = Math.max(0, Math.abs(b.x - a.x) - MIN_GAP);
  const steps = [0, 0];
  for (const side of [0, 1] as const) {
    if (!air[side]) continue;
    const share = air[other(side)] ? Math.floor(room / 2) : room;
    steps[side] = facingOf(state, side) * Math.min(JUMP_VX, share);
  }
  for (const side of [0, 1] as const) {
    const f = state.fighters[side];
    if (!air[side]) {
      if (!isIdle(f)) f.vx = 0;
      if (f.y !== 0 || f.vy !== 0) {
        f.y = 0;
        f.vy = 0;
      }
      continue;
    }
    const t = f.phase === 'startup' ? f.phaseTick : MOVES.jump_in.startup + f.phaseTick;
    const y = (JUMP_G * t * (JUMP_ARC_TICKS - t)) / 2;
    f.vy = y - f.y;
    f.y = y;
    f.vx = steps[side] ?? 0;
    f.x += f.vx;
  }
}

function updateProjectiles(state: MatchState, events: StepEvent[]): void {
  for (const p of state.projectiles) {
    p.x += p.vx;
    if (p.x <= STAGE_MIN || p.x >= STAGE_MAX) p.active = false;
  }
  const ps = state.projectiles;
  for (const [i, a] of ps.entries()) {
    for (const b of ps.slice(i + 1)) {
      if (!a.active || !b.active || a.owner === b.owner) continue;
      if (Math.abs(a.x - b.x) <= 2 * FIREBALL_HALF_WIDTH) {
        a.active = false;
        b.active = false;
        events.push({ type: 'fireballClash', tick: state.tick });
      }
    }
  }
  state.projectiles = ps.filter((p) => p.active);
}

/** Does the defender's current stance stop an attack of this height? */
function blocks(d: FighterState, height: AttackHeight): boolean {
  if (d.phase !== 'idle' && d.phase !== 'blockstun') return false;
  if (d.action === 'block_high') {
    return height === 'mid' || height === 'overhead' || height === 'projectile';
  }
  if (d.action === 'block_low') {
    return height === 'mid' || height === 'low' || height === 'projectile';
  }
  return false;
}

/** Can be struck at all (strikes and projectiles). */
function hittable(d: FighterState): boolean {
  return d.phase !== 'knockdown' && d.invulnTicks <= 0;
}

interface Hit {
  attacker: Side;
  defender: Side;
  move: MoveId;
  blocked: boolean;
}

function throwConnects(state: MatchState, side: Side): boolean {
  const f = state.fighters[side];
  const d = state.fighters[other(side)];
  if (f.action !== 'throw' || f.phase !== 'active' || f.phaseTick !== 1 || f.hitThisMove) {
    return false;
  }
  if (Math.abs(f.x - d.x) > MOVES.throw.reach) return false;
  if (isAirborne(d) || isStun(d) || d.invulnTicks > 0) return false;
  // A throw loses to a strike that is already active.
  if (isActiveStrike(d)) return false;
  return true;
}

function collectHits(state: MatchState, events: StepEvent[]): Hit[] {
  const hits: Hit[] = [];

  for (const side of [0, 1] as const) {
    const f = state.fighters[side];
    const d = state.fighters[other(side)];
    if (!isActiveStrike(f) || f.hitThisMove) continue;
    const move = f.action as MoveId;
    const m = MOVES[move];
    if (m.height === null || Math.abs(f.x - d.x) > m.reach) continue;
    if (!hittable(d)) continue;
    // Only the uppercut (anti-air) and another jump-in reach an airborne fighter.
    if (isAirborne(d) && move !== 'uppercut' && move !== 'jump_in') continue;
    hits.push({ attacker: side, defender: other(side), move, blocked: blocks(d, m.height) });
  }

  const t0 = throwConnects(state, 0);
  const t1 = throwConnects(state, 1);
  if (t0 && t1) {
    events.push({ type: 'throwTech', tick: state.tick });
    const [a, b] = state.fighters;
    const half = THROW_TECH_PUSH / 2;
    const dirA = a.x <= b.x ? -1 : 1;
    a.x += dirA * half;
    b.x -= dirA * half;
    a.hitThisMove = true;
    b.hitThisMove = true;
  } else if (t0) {
    hits.push({ attacker: 0, defender: 1, move: 'throw', blocked: false });
  } else if (t1) {
    hits.push({ attacker: 1, defender: 0, move: 'throw', blocked: false });
  }

  for (const p of state.projectiles) {
    const def = other(p.owner);
    const d = state.fighters[def];
    if (Math.abs(p.x - d.x) > PUSHBOX_HALF_WIDTH) continue;
    // Airborne fighters jump over fireballs; knocked-down and invulnerable ones let them pass.
    if (isAirborne(d) || !hittable(d)) continue;
    p.active = false;
    hits.push({
      attacker: p.owner,
      defender: def,
      move: 'fireball',
      blocked: blocks(d, 'projectile'),
    });
  }
  state.projectiles = state.projectiles.filter((p) => p.active);

  return hits;
}

function applyHits(state: MatchState, hits: Hit[], events: StepEvent[]): void {
  for (const h of hits) {
    const a = state.fighters[h.attacker];
    const d = state.fighters[h.defender];
    const m = MOVES[h.move];
    if (h.move !== 'fireball') a.hitThisMove = true;
    if (h.blocked) {
      d.health -= m.chip;
      d.phase = 'blockstun';
      d.phaseTick = 0;
      d.busyTicks = m.blockstun;
      d.vx = 0;
      events.push({
        type: 'blocked',
        tick: state.tick,
        fighter: h.attacker,
        target: h.defender,
        move: h.move,
        chip: m.chip,
      });
      continue;
    }
    d.health -= m.damage;
    // Getting hit cancels the defender's one-shot; a held stance survives the stun.
    if (d.action !== 'stand' && MOVE_KIND[d.action] === 'oneShot') d.action = 'stand';
    d.phase = m.knockdown > 0 ? 'knockdown' : 'hitstun';
    d.phaseTick = 0;
    d.busyTicks = m.knockdown > 0 ? m.knockdown : m.hitstun;
    d.invulnTicks = 0;
    d.y = 0;
    d.vy = 0;
    d.vx = 0;
    if (m.pushOnHit > 0) {
      const away = d.x >= a.x ? 1 : -1;
      d.x += away * m.pushOnHit;
    }
    events.push({
      type: 'hit',
      tick: state.tick,
      fighter: h.attacker,
      target: h.defender,
      move: h.move,
      damage: m.damage,
      knockdown: m.knockdown > 0,
    });
  }
}

function emitWhiffs(state: MatchState, events: StepEvent[]): void {
  for (const side of [0, 1] as const) {
    const f = state.fighters[side];
    const move = moveOf(f);
    if (move === null || f.phase !== 'active' || f.hitThisMove) continue;
    const m = MOVES[move];
    if (m.height === 'projectile' || f.phaseTick !== m.active) continue;
    events.push({ type: 'whiff', tick: state.tick, fighter: side, move });
  }
}

function remainingBusy(f: FighterState): number {
  if (isIdle(f)) return 0;
  if (isStun(f)) return Math.max(0, f.busyTicks);
  const move = moveOf(f);
  if (move === null) return 0;
  const m = MOVES[move];
  if (f.phase === 'startup') return m.startup - f.phaseTick + m.active + m.recovery;
  if (f.phase === 'active') return m.active - f.phaseTick + m.recovery;
  return m.recovery - f.phaseTick;
}

function finishTick(state: MatchState): void {
  for (const f of state.fighters) {
    if (f.invulnTicks > 0) f.invulnTicks -= 1;
    if (f.fireballCooldown > 0) f.fireballCooldown -= 1;
    if (f.health < 0) f.health = 0;
    f.busyTicks = remainingBusy(f);
  }
}

/**
 * Called by `step` once per tick while status === 'fighting', after inputs and walking and
 * before walls/pushbox are resolved. See the order at the top of this file.
 */
export function updateCombat(state: MatchState, events: StepEvent[]): void {
  advanceFighter(state, 0, events);
  advanceFighter(state, 1, events);
  updateJumps(state);
  updateProjectiles(state, events);
  applyHits(state, collectHits(state, events), events);
  emitWhiffs(state, events);
  finishTick(state);
}
