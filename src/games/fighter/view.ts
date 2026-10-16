import { PUSHBOX_HALF_WIDTH, STAGE_MAX, SUB, TICK_RATE } from './engine/constants.js';
import { isAirborne } from './engine/combat.js';
import type { FighterState, MatchState, MoveId, Phase, Side } from './engine/types.js';

/**
 * The fighter's model-facing state (docs/architecture/fighter.md). Everything a fighter decider
 * sees is a `View` plus the match's question; nothing here exposes engine state, so baselines and
 * models get exactly the same information (RULES.md, fairness).
 */

export type Range = 'close' | 'mid' | 'far';

/** Model-facing phase vocabulary, stable even if engine phases change. */
export type ViewPhase = 'idle' | 'startup' | 'active' | 'recovery' | 'stunned' | 'knocked_down';

/** One fighter as the model sees it. All distances and positions in whole units. */
export interface FighterView {
  health: number;
  /**
   * Position in units from the viewer's own point of view: distance from the wall behind where
   * the viewing fighter started (side 0: engine x; side 1: 1000 - engine x). Both `you.x` and
   * `opponent.x` use the viewer's frame, so the two sides of a mirrored state see the same view.
   */
  x: number;
  airborne: boolean;
  /** Current hold or one-shot; 'stand' after a one-shot ends (not blocking). */
  action: MoveId | 'stand';
  phase: ViewPhase;
  /** Ticks until this fighter can act again (0 = can act now). */
  busy_ticks: number;
  /** Off cooldown and no own fireball on screen. */
  fireball_ready: boolean;
  /** Last 3 applied moves, oldest first. */
  last_moves: MoveId[];
}

export interface FireballView {
  /** Units the fireball still has to travel before it connects. */
  distance: number;
  ticks_to_hit: number;
}

/**
 * The model-facing state JSON, from one fighter's point of view. A type alias, not an interface,
 * so it is a `JsonObject` (what `Game.view` returns).
 */
export type View = {
  you: FighterView;
  opponent: FighterView;
  distance: number;
  range: Range;
  /** Null when the opponent has no fireball heading at you. */
  opponent_fireball: FireballView | null;
  your_fireball_on_screen: boolean;
  round: number;
  round_clock_s: number;
  rounds_won: { you: number; opponent: number };
};

const PHASES: Readonly<Record<Phase, ViewPhase>> = {
  idle: 'idle',
  startup: 'startup',
  active: 'active',
  recovery: 'recovery',
  hitstun: 'stunned',
  blockstun: 'stunned',
  knockdown: 'knocked_down',
  airborne: 'active',
};

const units = (subUnits: number): number => Math.floor(subUnits / SUB);

/** close < 120 <= mid <= 350 < far (whole units). */
export function rangeOf(distanceUnits: number): Range {
  if (distanceUnits < 120) return 'close';
  if (distanceUnits <= 350) return 'mid';
  return 'far';
}

/**
 * A stage position as `viewer` sees it: distance from the wall behind where `viewer` started.
 * Side 0 starts on the left, so its frame is the engine's; side 1's is mirrored (STAGE_MAX - x),
 * computed in sub-units before flooring so a mirrored state gives identical views (fairness).
 */
function ownFrameX(x: number, viewer: Side): number {
  return units(viewer === 0 ? x : STAGE_MAX - x);
}

function fighterView(state: MatchState, side: Side, viewer: Side): FighterView {
  const f: FighterState = state.fighters[side];
  const onScreen = state.projectiles.some((p) => p.owner === side);
  return {
    health: f.health,
    x: ownFrameX(f.x, viewer),
    airborne: isAirborne(f) || f.y > 0,
    action: f.action,
    phase: PHASES[f.phase],
    busy_ticks: Math.max(0, f.busyTicks),
    fireball_ready: f.fireballCooldown <= 0 && !onScreen,
    last_moves: [...f.lastMoves],
  };
}

/**
 * The opponent's fireball heading at `side`. It connects once its center is within
 * PUSHBOX_HALF_WIDTH of the target's center (combat.ts), so `distance` is the gap still to cover.
 * Null if there is none or it has already passed (moving away).
 */
function incomingFireball(state: MatchState, side: Side): FireballView | null {
  const target = state.fighters[side].x;
  for (const p of state.projectiles) {
    if (p.owner === side || !p.active || p.vx === 0) continue;
    const toward = Math.sign(target - p.x);
    if (toward !== 0 && toward !== Math.sign(p.vx)) continue;
    const gap = Math.max(0, Math.abs(target - p.x) - PUSHBOX_HALF_WIDTH);
    return { distance: units(gap), ticks_to_hit: Math.ceil(gap / Math.abs(p.vx)) };
  }
  return null;
}

/** The model-facing state for `side`. Pure: never mutates `state`. */
export function buildView(state: MatchState, side: Side): View {
  const opp: Side = side === 0 ? 1 : 0;
  const distance = units(Math.abs(state.fighters[0].x - state.fighters[1].x));
  const ticksLeft = Math.max(0, state.config.roundTicks - state.roundTick);
  return {
    you: fighterView(state, side, side),
    opponent: fighterView(state, opp, side),
    distance,
    range: rangeOf(distance),
    opponent_fireball: incomingFireball(state, side),
    your_fireball_on_screen: state.projectiles.some((p) => p.owner === side),
    round: state.round,
    round_clock_s: Math.ceil(ticksLeft / TICK_RATE),
    rounds_won: { you: state.fighters[side].roundsWon, opponent: state.fighters[opp].roundsWon },
  };
}
