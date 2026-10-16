/**
 * The simulation step. Pure and deterministic: integer math only, no DOM, clock or Math.random.
 *
 * step(state, inputs) mutates `state` and returns the tick's events. Fixed order:
 *
 *   0. status 'matchOver'  -> no-op, returns [] (tick does not advance).
 *   1. status 'roundOver'  -> each non-null input emits `dropped` (reason 'notFighting'),
 *                             then rounds.updateRoundPause(state, events), then tick++. Done.
 *   2. status 'fighting':
 *      a. inputs, side 0 then side 1 (null = no new decision; the current hold continues):
 *           hold     -> fighter.applyHold   (2a: sets the stance now, or becomes pendingHold if
 *                                           busy; never expires; a waiting input is `dropped`
 *                                           as 'superseded')
 *           one-shot -> combat.applyInput   (2b: starts now, or buffered for bufferTicks; an older
 *                                           buffered one-shot is `dropped` as 'superseded')
 *      b. fighter.walkFighters              (2a: idle walkers move WALK_SPEED; idle others vx = 0)
 *      c. combat.updateCombat               (2b: buffer, phases, physics, projectiles, hits)
 *      d. fighter.resolvePositions          (2a: walls, then pushbox; never cross)
 *      e. roundTick++                       (2a: round clock)
 *      f. rounds.checkRoundEnd              (2c: KO / timeout / match end; anything still
 *                                           waiting is `dropped` as 'notFighting')
 *      g. tick++
 *
 * Events carry `tick` = the tick being simulated (state.tick before step 2g).
 */
import { applyInput, updateCombat } from './combat.js';
import {
  BUFFER_TICKS,
  MAX_HEALTH,
  MAX_ROUNDS,
  ROUND_PAUSE_TICKS,
  ROUND_TICKS,
  ROUNDS_TO_WIN,
  WALK_SPEED,
} from './constants.js';
import { applyHold, createFighter, resolvePositions, walkFighters } from './fighter.js';
import { createPrng } from '../../../core/util/prng.js';
import { checkRoundEnd, updateRoundPause } from './rounds.js';
import type { EngineConfig, MatchState, StepEvent, TickInputs } from './types.js';
import { MOVE_KIND } from './types.js';

export const DEFAULT_CONFIG: Readonly<EngineConfig> = {
  maxHealth: MAX_HEALTH,
  roundTicks: ROUND_TICKS,
  roundsToWin: ROUNDS_TO_WIN,
  maxRounds: MAX_ROUNDS,
  bufferTicks: BUFFER_TICKS,
  roundPauseTicks: ROUND_PAUSE_TICKS,
};

export function createMatch(seed: number, config: Partial<EngineConfig> = {}): MatchState {
  const cfg: EngineConfig = { ...DEFAULT_CONFIG, ...config };
  return {
    tick: 0,
    roundTick: 0,
    round: 1,
    fighters: [createFighter(0, cfg), createFighter(1, cfg)],
    projectiles: [],
    prng: createPrng(seed),
    status: 'fighting',
    winner: null,
    roundResults: [],
    pauseTicksLeft: 0,
    config: cfg,
  };
}

/** Advance one tick. Mutates `state`; returns the events of this tick. */
export function step(state: MatchState, inputs: TickInputs): StepEvent[] {
  const events: StepEvent[] = [];
  if (state.status === 'matchOver') return events;

  if (state.status === 'roundOver') {
    for (const side of [0, 1] as const) {
      const move = inputs[side];
      if (move !== null) {
        events.push({
          type: 'dropped',
          tick: state.tick,
          fighter: side,
          move,
          reason: 'notFighting',
        });
      }
    }
    updateRoundPause(state, events);
    state.tick += 1;
    return events;
  }

  for (const side of [0, 1] as const) {
    const move = inputs[side];
    if (move === null) continue;
    if (MOVE_KIND[move] === 'hold') applyHold(state, side, move, events);
    else applyInput(state, side, move, events);
  }
  walkFighters(state, WALK_SPEED);
  updateCombat(state, events);
  resolvePositions(state);
  state.roundTick += 1;
  checkRoundEnd(state, events);
  state.tick += 1;
  return events;
}

/** Deep copy; the copy shares nothing with `state`. */
export function cloneState(state: MatchState): MatchState {
  return structuredClone(state);
}
