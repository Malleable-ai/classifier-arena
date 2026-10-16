import { updateCombat } from '../../../games/fighter/engine/combat.js';
import { resolvePositions } from '../../../games/fighter/engine/fighter.js';
import type { FighterState, MatchState } from '../../../games/fighter/engine/types.js';

/**
 * What the stage shows after a round ends. The engine freezes the fighters on the tick a round is
 * decided (between rounds only the clock ticks; at match end nothing moves), so a K.O.'d fighter
 * would stand in hitstun through the pause and the end hold. `settledState` plays the end out for
 * the eye only: a fighter at 0 health falls and stays down, the other finishes its move and stands,
 * projectiles fly on, and nobody can be hit. It runs the engine's own combat and position steps on
 * a copy, so poses come from the same frame data; health, rounds and the result are the decided
 * ones. Pure: a function of (the state the round ended in, ticks since), never of the match's
 * future, and it never touches the replay's state.
 */

/** Long enough that a downed fighter never gets up, and the standing one is never hit. */
const FOREVER = 1_000_000;
/** A fighter K.O.'d in the air drops to the floor over about this many ticks. */
const DROP_TICKS = 8;

function settleFighter(f: FighterState, airborne0: number): void {
  f.buffered = null;
  f.pendingHold = null;
  f.vx = 0;
  if (f.health <= 0) {
    if (f.phase !== 'knockdown') {
      f.phase = 'knockdown';
      f.phaseTick = 0;
    }
    f.action = 'stand';
    f.vy = 0;
    f.busyTicks = FOREVER;
    f.y = Math.max(0, f.y - Math.ceil(airborne0 / DROP_TICKS));
  } else {
    f.invulnTicks = FOREVER;
    // A walk is a hold: the standing fighter stops rather than walking in place.
    if (f.phase === 'idle' && (f.action === 'walk_forward' || f.action === 'walk_back')) {
      f.action = 'stand';
    }
  }
}

/**
 * The state to draw `ticks` ticks after `ended`, a state whose round is over (status 'roundOver'
 * or 'matchOver', as the engine left it). `ticks` 0 returns a copy of `ended` as is.
 */
export function settledState(ended: MatchState, ticks: number): MatchState {
  const s = structuredClone(ended);
  const health = [ended.fighters[0].health, ended.fighters[1].health] as const;
  const air = [ended.fighters[0].y, ended.fighters[1].y] as const;
  for (let k = 0; k < ticks; k++) {
    settleFighter(s.fighters[0], air[0]);
    settleFighter(s.fighters[1], air[1]);
    updateCombat(s, []);
    resolvePositions(s);
    s.fighters[0].health = health[0];
    s.fighters[1].health = health[1];
    s.tick += 1;
  }
  return s;
}
