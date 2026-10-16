/**
 * The game contract. A game is plain data plus pure functions over its own state `S` and config
 * `C`; the schedulers in src/core/sched drive it, ask both seats its questions (through
 * `orderOptions`, so both get the same option order) and log what happens. Two cadences:
 * real-time games advance by ticks whether or not anyone answered, turn games advance once both
 * seats have answered or timed out. Nothing here knows any particular game.
 *
 * Methods are declared with method syntax on purpose: method parameters are bivariant, so any
 * `RealtimeGame<S, C>` or `TurnGame<S, C>` is assignable to the erased `Game` the registry holds,
 * without `any`.
 */

import type { Decider, Question, QuestionOption, Seat } from './classifier/types.js';
import type { Clock } from './util/clock.js';
import type { PrngState } from './util/prng.js';

export { QUESTION_ID_RE, validateQuestion } from './classifier/question.js';

/** A JSON object: what `view` returns and the proxy accepts as `state`. */
export type JsonObject = Readonly<Record<string, unknown>>;

/** A game id: it goes into match ids and result paths (`results/<game>/…`). */
export const GAME_ID_RE = /^[a-z][a-z0-9_]*$/;

/** A seat's current question. `key` names it for option order and settlement matching. */
export interface AskedQuestion {
  key: string;
  /** Options in the game's canonical order; the scheduler orders them per match and key. */
  question: Question;
}

export interface GameResult {
  over: boolean;
  /** null while the game is running. */
  winner: Seat | 'draw' | null;
  scores: [number, number];
}

/** Something a game reports for the log and the viewer. JSON-safe payload. */
export interface GameEvent {
  kind: string;
  [field: string]: unknown;
}

/** What became of one seat's real-time input. */
export interface Settlement {
  seat: Seat;
  choice: string;
  outcome: 'applied' | 'dropped';
  /** Why it was dropped (e.g. 'stale'). */
  reason?: string;
  /** Graded games: whether the applied choice was right. */
  correct?: boolean;
}

/** The frozen prompt config whose hash goes in every match header. */
export interface GamePromptConfig {
  version: number;
  questionName: string;
  primer: string;
  /** 'per-question' when options come from the game data (e.g. a clue board). */
  options: readonly QuestionOption[] | 'per-question';
  stateFormatVersion: number;
}

/** Decisions one seat makes in a typical and a worst-case match. */
export interface DecisionCounts {
  typical: number;
  worst: number;
}

/** What src/core/estimate.ts prices a match from (one warm-up call per provider seat is added). */
export interface GameEstimate {
  /** Decisions per seat in a typical and a worst-case match (for the $5 guard). */
  decisionsPerSeat: DecisionCounts;
  /**
   * Per provider id, where its measured speed changes the count (a real-time game keeps one
   * request in flight, so a slower provider decides less often). Others use `decisionsPerSeat`.
   */
  decisionsPerSeatByPlayer?: Readonly<Record<string, DecisionCounts>>;
  /** Measured input tokens per decision per provider id; fallback for unmeasured providers. */
  inputTokens: Readonly<Record<string, number>>;
  fallbackInputTokens: number;
}

/** What a game's own baselines get to build a decider from. */
export interface BaselineDeps {
  clock: Clock;
  /** Simulated think time; a baseline uses its own default when absent. */
  delayMs?: number;
  /** Its own PRNG for a baseline that needs randomness, never the game's. */
  prng?: PrngState;
  /** Game-specific inputs a baseline needs (e.g. the fighter's human keyboard source). */
  extra?: Readonly<Record<string, unknown>>;
}

export interface GameCommon<S, C> {
  /** Lowercase letters, digits and `_`, starting with a letter (GAME_ID_RE). */
  id: string;
  label: string;
  version: number;
  defaultConfig: C;
  promptConfig: GamePromptConfig;
  /** True when answers are right or wrong (`Settlement.correct`, `applyTurn().correct`). */
  graded: boolean;
  /** Baselines this game offers besides 'random' (e.g. ['scripted']). */
  baselines: readonly string[];
  /**
   * Display labels for `baselines`, by id (e.g. `{ scripted: 'Scripted bot' }`). They go in match
   * headers, the CLI's player list, the proxy's `/players` and the UI (`gameBaselines`). An id
   * without one is shown as itself.
   */
  baselineLabels?: Readonly<Record<string, string>>;
  /** Builds one of `baselines`; absent when the game has none ('random' comes from core). */
  createBaseline?(id: string, deps: BaselineDeps): Decider;
  estimate: GameEstimate;
  create(seed: number, config: C): S;
  clone(state: S): S;
  /** 16 lowercase hex chars over a canonical encoding of the whole state. */
  hash(state: S): string;
  /**
   * What a seat sees: a JSON object (JSON-safe values), the state every decider is sent. An object
   * because the proxy only passes on an object `state` and the formats send it as one.
   */
  view(state: S, seat: Seat): JsonObject;
  /** null when this seat has nothing to answer (e.g. the game is over). */
  question(state: S, seat: Seat): AskedQuestion | null;
  result(state: S): GameResult;
  /** The game config as logged in the header (JSON-safe). */
  logConfig(config: C): Record<string, unknown>;
  /**
   * The inverse of `logConfig`: the config a replay passes to `create`, rebuilt from a header's
   * `config`. Throws (naming the game) on a malformed one.
   */
  configFromLog(logged: Readonly<Record<string, unknown>>): C;
}

export interface RealtimeInput {
  choice: string;
  /** The key of the question this answers; a game drops inputs for a stale key. */
  questionKey: string;
}

export interface RealtimeGame<S, C> extends GameCommon<S, C> {
  cadence: { kind: 'realtime'; tickRate: number };
  /**
   * True when an applied answer retires its question key (Inbox Invaders: the answered message
   * leaves the lane). The scheduler asks on the state from before the tick's inputs are applied,
   * so without this a seat whose answer is applied on tick T would be re-asked that same key on T
   * and its next answer dropped. With it, the scheduler skips that seat on T when its question
   * still has the key being answered; it is asked on T + 1. Absent or false: no skip (the fighter
   * asks its one key all match).
   */
  answerRetiresKey?: boolean;
  tick(state: S): number;
  /** Can this seat usefully be asked now (fighter: not between rounds)? */
  canAsk(state: S, seat: Seat): boolean;
  /** Simulates one tick, mutating `state`. */
  step(
    state: S,
    inputs: readonly [RealtimeInput | null, RealtimeInput | null],
  ): { settlements: Settlement[]; events: GameEvent[] };
  /** Upper bound on match length in ticks (replay and offline runs stop there). */
  maxTicks(config: C): number;
}

/** A seat's answer for one turn; the scheduler passes null for a miss. */
export interface TurnAnswer {
  choice: string | null;
  latencyMs: number;
}

export interface TurnGame<S, C> extends GameCommon<S, C> {
  cadence: { kind: 'turns' };
  turn(state: S): number;
  /** Plays one turn, mutating `state`. `correct` is null for a seat that gave no answer. */
  applyTurn(
    state: S,
    answers: readonly [TurnAnswer | null, TurnAnswer | null],
  ): { correct: [boolean | null, boolean | null]; events: GameEvent[] };
  maxTurns(config: C): number;
}

/** Any game, with its state and config erased (what the registry holds). */
export type Game = RealtimeGame<unknown, unknown> | TurnGame<unknown, unknown>;

export function isRealtime<S, C>(
  game: RealtimeGame<S, C> | TurnGame<S, C>,
): game is RealtimeGame<S, C> {
  return game.cadence.kind === 'realtime';
}

export function isTurns<S, C>(game: RealtimeGame<S, C> | TurnGame<S, C>): game is TurnGame<S, C> {
  return game.cadence.kind === 'turns';
}
