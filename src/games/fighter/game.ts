import type { Seat } from '../../core/classifier/types.js';
import type { GameEvent, RealtimeGame, RealtimeInput, Settlement } from '../../core/game.js';
import {
  FIGHTER_BASELINE_IDS,
  FIGHTER_BASELINE_LABELS,
  createFighterBaseline,
} from './baselines.js';
import { ENGINE_VERSION, TICK_RATE } from './engine/constants.js';
import { HASHED_CONFIG_KEYS, hashState } from './engine/hash.js';
import { defaultMaxTicks } from './engine/run.js';
import { DEFAULT_CONFIG, cloneState, createMatch, step } from './engine/sim.js';
import type {
  EngineConfig,
  MatchState,
  MoveId,
  RoundEndReason,
  Side,
  StepEvent,
} from './engine/types.js';
import { MOVE_IDS } from './engine/types.js';
import { fighterEstimate } from './estimate.js';
import { FIGHTER_PROMPT_CONFIG } from './prompt.js';
import { FIGHTER_QUESTION, FIGHTER_QUESTION_KEY } from './question.js';
import { buildView } from './view.js';

/**
 * The fighter on the game contract (src/core/game.ts): a real-time game at 60 ticks/s over the
 * engine in ./engine. Both seats are asked `next_move` (one key all match) whenever they are
 * fighting; each answer is fed to the engine on the tick after it arrives, and the engine's own
 * `applied`/`dropped` events settle it. Round ends are logged as `round_end` events.
 */

const SEATS: readonly Seat[] = [0, 1];

/** A round end as logged: `{ type: 'event', tick, game: RoundEndEvent }`. */
export interface RoundEndEvent extends GameEvent {
  kind: 'round_end';
  round: number;
  winner: Side | 'draw';
  reason: RoundEndReason;
  /** Both fighters' health when the round ended, seat 0 then seat 1. */
  health: [number, number];
}

const MOVES: ReadonlySet<string> = new Set(MOVE_IDS);

const isMoveId = (choice: string): choice is MoveId => MOVES.has(choice);

/** Lower bound per logged config field (every field is an integer). */
const CONFIG_MIN: Readonly<Record<keyof EngineConfig, number>> = {
  maxHealth: 1,
  roundTicks: 1,
  roundsToWin: 1,
  maxRounds: 1,
  bufferTicks: 0,
  roundPauseTicks: 0,
};

/** Every EngineConfig field (the hasher's list, so a new field is logged too). */
function logConfig(config: EngineConfig): Record<string, unknown> {
  return Object.fromEntries(HASHED_CONFIG_KEYS.map((k) => [k, config[k]]));
}

function configFromLog(logged: Readonly<Record<string, unknown>>): EngineConfig {
  const fail = (why: string): never => {
    throw new Error(`fighter: logged config ${why}`);
  };
  const known = new Set<string>(HASHED_CONFIG_KEYS);
  for (const k of Object.keys(logged)) if (!known.has(k)) fail(`has an unknown field "${k}"`);
  const config = { ...DEFAULT_CONFIG };
  for (const k of HASHED_CONFIG_KEYS) {
    const v = logged[k];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < CONFIG_MIN[k]) {
      fail(`${k} must be an integer ≥ ${String(CONFIG_MIN[k])}, got ${JSON.stringify(v)}`);
    }
    config[k] = v as number;
  }
  return config;
}

/** One tick as the contract reports it, plus the engine's own events for that tick. */
export interface FighterStep {
  settlements: Settlement[];
  events: GameEvent[];
  /** Every engine StepEvent (hits, blocks, clashes, …): renderers draw effects from them. */
  engineEvents: StepEvent[];
}

/**
 * `fighterGame.step`, also returning the engine's StepEvents (the log keeps only `round_end`).
 * The web renderer calls this while replaying, so its hit effects come from the same simulation
 * the state does.
 */
export function stepFighter(
  state: MatchState,
  inputs: readonly [RealtimeInput | null, RealtimeInput | null],
): FighterStep {
  const settlements: Settlement[] = [];
  const moves: [MoveId | null, MoveId | null] = [null, null];
  for (const seat of SEATS) {
    const input = inputs[seat];
    if (!input) continue;
    const { choice } = input;
    // Neither happens in a match (one key, provider answers are checked against the options),
    // but a hand-edited log must not reach the engine.
    if (input.questionKey !== FIGHTER_QUESTION_KEY) {
      settlements.push({ seat, choice, outcome: 'dropped', reason: 'stale' });
    } else if (!isMoveId(choice)) {
      settlements.push({ seat, choice, outcome: 'dropped', reason: 'unknown_move' });
    } else {
      moves[seat] = choice;
    }
  }
  const events: GameEvent[] = [];
  const engineEvents = step(state, moves);
  for (const e of engineEvents) {
    if (e.type === 'applied') {
      settlements.push({ seat: e.fighter, choice: e.move, outcome: 'applied' });
    } else if (e.type === 'dropped') {
      settlements.push({ seat: e.fighter, choice: e.move, outcome: 'dropped', reason: e.reason });
    } else if (e.type === 'roundEnd') {
      const r = state.roundResults.find((x) => x.round === e.round);
      if (!r) throw new Error(`fighter: no result for round ${String(e.round)}`);
      const roundEnd: RoundEndEvent = {
        kind: 'round_end',
        round: e.round,
        winner: e.winner,
        reason: e.reason,
        health: [r.health[0], r.health[1]],
      };
      events.push(roundEnd);
    }
  }
  return { settlements, events, engineEvents };
}

export const fighterGame: RealtimeGame<MatchState, EngineConfig> = {
  id: 'fighter',
  label: 'Fighter',
  version: ENGINE_VERSION,
  defaultConfig: DEFAULT_CONFIG,
  promptConfig: FIGHTER_PROMPT_CONFIG,
  graded: false,
  baselines: FIGHTER_BASELINE_IDS,
  baselineLabels: FIGHTER_BASELINE_LABELS,
  createBaseline: createFighterBaseline,
  estimate: fighterEstimate,
  cadence: { kind: 'realtime', tickRate: TICK_RATE },

  create: (seed, config) => createMatch(seed, config),
  clone: cloneState,
  hash: hashState,
  view: buildView,
  question: (state) =>
    state.status === 'matchOver' ? null : { key: FIGHTER_QUESTION_KEY, question: FIGHTER_QUESTION },
  result: (state) => ({
    over: state.status === 'matchOver',
    winner: state.winner,
    scores: [state.fighters[0].roundsWon, state.fighters[1].roundsWon],
  }),
  logConfig,
  configFromLog,

  tick: (state) => state.tick,
  canAsk: (state) => state.status === 'fighting',
  step(state, inputs) {
    const { settlements, events } = stepFighter(state, inputs);
    return { settlements, events };
  },
  maxTicks: defaultMaxTicks,
};
