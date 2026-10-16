import type { Hosting } from '../classifier/hosting.js';
import type { DecisionStatus, Seat } from '../classifier/types.js';
import type { GameEvent } from '../game.js';

/**
 * Match log schema v2 (docs/architecture/core.md), the same for every game. One JSONL file per
 * match: a `header`, one `decision` line per decision, an `event` line per game event and a
 * `match_end`. The schedulers in src/core/sched write these lines into a sink (writer.ts: JSONL
 * file, Node only; memory.ts: in memory) and read.ts parses them back. v1 logs are no longer read.
 */
export const SCHEMA_VERSION = 2;

/** A provider's dated price, as logged in the header. */
export interface SeatPrice {
  inputPerMTokUsd: number;
  outputPerMTokUsd: number;
  asOf: string;
}

/**
 * A provider seat's warm-up call, made before the clock starts (src/core/sched/shared.ts). Only an
 * `ok` or a `refusal` warm-up starts a match (`warmUpSucceeded`), so a logged header has one of
 * those here; a refusal keeps its `error` (REFUSAL_ERROR).
 */
export interface WarmupRecord {
  latencyMs: number;
  status: DecisionStatus;
  costUsd: number;
  error?: string;
}

/** Per-seat header entry. Baselines have `null` for every provider-only field. */
export interface HeaderSeat {
  seat: Seat;
  player: string;
  label: string;
  format: string | null;
  hosting: Hosting | null;
  model: string | null;
  /** The provider service tier (from the format), or null. */
  serviceTier: string | null;
  /** The model version the API reported (from the warm-up), or null. */
  modelVersion: string | null;
  price: SeatPrice | null;
  /** Provider seats only; baselines skip the warm-up. */
  warmup: WarmupRecord | null;
}

export interface HeaderLine {
  type: 'header';
  schemaVersion: 2;
  game: string;
  gameVersion: number;
  matchId: string;
  /** ISO time the clock started (after the warm-up). */
  startTime: string;
  gitCommit: string;
  seed: number;
  /** Free-text `RUN_LOCATION` label (`unspecified` when unset, `sim` for a simulated run). */
  runLocation: string;
  /**
   * Which machine ran the match, without saying where it is (src/cli/run-id.ts): `m-` plus 12
   * hex digits hashed from the machine's own stable identifier (before 2026-10-15, from its host
   * name), `h-` plus 12 hex digits from the host name when no identifier was readable, `sim` for
   * a simulated run. Logs written before the field existed read as `unknown` (`sim` when their
   * `runLocation` is `sim`).
   */
  runId: string;
  cadence: { kind: 'realtime'; tickRate: number } | { kind: 'turns' };
  /** The same for both seats. */
  timing: { floorMs: number; timeoutMs: number };
  promptConfigHash: string;
  /** How every question's option order is derived (OPTION_ORDER_RULE). */
  optionOrderRule: string;
  /** `game.logConfig(config)`. */
  config: Record<string, unknown>;
  seats: [HeaderSeat, HeaderSeat];
}

/**
 * `refusal` (since 2026-10-12): the API declined to answer. Older logs wrote a refusal as `error`
 * with `error: REFUSAL_ERROR`; the reader reads those lines as `refusal`.
 */
export type DecisionLineStatus = 'ok' | 'timeout' | 'error' | 'refusal' | 'dropped';

/**
 * One line per decision, written once its outcome is final.
 *
 * - `questionKey`: the key of the question asked; with the header's seed and `optionOrderRule` it
 *   rebuilds the option order the seat saw.
 * - `sentTick`: real-time, the tick on which the request was sent (its view is the state before
 *   that tick); turn games, the turn index.
 * - `appliedTick`: real-time, the tick on which the answer was fed to `step`, or null if it never
 *   reached the game (timeout, error, or the match ended first); replays feed every line with a
 *   non-null `appliedTick` on that tick, `dropped` ones included. Turn games: the turn index.
 * - `status`: real-time `ok` answers become `dropped` when the game settles them as dropped (the
 *   reason is in `error`). Turn games never drop an `ok` answer. `timeout`, `error` and `refusal`
 *   lines have no choice. A refusal is the model declining to answer: it never counts toward
 *   validity (src/core/sched/validity.ts).
 * - `correct`: graded games, when the game reported it.
 */
export interface DecisionLine {
  type: 'decision';
  seat: Seat;
  seq: number;
  questionKey: string;
  sentTick: number;
  appliedTick: number | null;
  latencyMs: number;
  choice: string | null;
  probabilities: Record<string, number> | null;
  confidence: number | null;
  inputTokens: number | null;
  costUsd: number;
  /**
   * Present (true) when `costUsd` is an estimate: the request was sent but never answered (timed
   * out, or still in flight when the match ended), so the provider's usage is unknown. Estimated
   * as the cost of that seat's last `ok` answer (or its warm-up), 0 if there was none.
   */
  costEstimated?: true;
  /**
   * Present (true) when `probabilities` is non-null but has no entry for `choice`: the API's
   * probabilities are logged as reported, never patched. The reader accepts a choice missing from
   * `probabilities` only with this flag.
   */
  probabilitiesPartial?: true;
  status: DecisionLineStatus;
  error?: string;
  correct?: boolean;
}

/** A game event. `tick` is the tick simulated (real-time) or the turn played (turn games). */
export interface EventLine {
  type: 'event';
  tick: number;
  game: GameEvent;
}

/**
 * A stretch where the machine held the scheduler up (sleep, suspend, a clock jump): the match is
 * invalid, an infrastructure failure, not the models' play (src/core/sched/validity.ts).
 *
 * - `atTick`: real-time, the first tick processed late; turn games, the turn.
 * - `gapMs`: how late the scheduler ran, in whole ms. Real-time: from when that tick was due to the
 *   call that processed it (over REALTIME_STALL_MS). Turns: from the turn's deadline to when the
 *   turn finished (over TURN_STALL_SLACK_MS).
 *
 * `match_end.stalls` holds the stalls the scheduler measured. The re-score also finds stalls in the
 * decision lines (`logStalls`: a line longer than the timeout plus that slack, `atTick` its
 * `sentTick` and `gapMs` the time past the timeout); those are never written into a log.
 */
export interface MatchStall {
  atTick: number;
  gapMs: number;
}

export interface MatchEndLine {
  type: 'match_end';
  winner: Seat | 'draw' | null;
  scores: [number, number];
  /** Real-time: ticks simulated. Turn games: turns played. */
  totalTicks: number;
  finalStateHash: string;
  /**
   * Valid by the rule in force when the match was played (src/core/sched/validity.ts). Since
   * 2026-10-16, the same in every game: no stall (measured, or shown by a decision line longer
   * than the timeout plus the stall slack), no real-time provider seat without decisions, and each
   * seat's transport failures at most 2% of its decisions; timeouts and refusals never count.
   * Before 2026-10-16 real-time games counted timeouts too (refusals stopped counting on
   * 2026-10-12; stalls and empty provider seats were added on 2026-10-15). This is the historical
   * record: the stats recompute validity from the log with the current rule (`isValidLog`).
   */
  valid: boolean;
  /**
   * Per seat: misses (timeouts and errors) / decisions, whatever the cadence. Refusals are not
   * misses; logs written before 2026-10-12 counted them here, as errors.
   */
  missRates: [number, number];
  /**
   * Per seat: timeouts / decisions (also counted in `missRates`). Written by every log since
   * 2026-10-12 (Clue Clash game version 2); absent in older logs.
   */
  timeoutRates?: [number, number];
  /**
   * Per seat: refusals / decisions (not in `missRates`). Written by every log since 2026-10-12
   * (the refusal rule); absent in older logs.
   */
  refusalRates?: [number, number];
  decisions: [number, number];
  /** Every decision's cost plus the warm-ups. */
  costUsd: number;
  /**
   * Every stall the scheduler measured, in order (since 2026-10-15). Present only when there was
   * one, and then `valid` is false. Absent in older logs and in every match without a stall.
   */
  stalls?: MatchStall[];
}

export type LogLine = HeaderLine | DecisionLine | EventLine | MatchEndLine;

/** Where a scheduler writes. Node writes JSONL files; the browser keeps lines in memory. */
export interface MatchLogSink {
  write(line: LogLine): void;
  /** Full request/response bodies per decision (debugging only; optional). */
  snapshot?(seat: Seat, seq: number, raw: { request: unknown; response: unknown }): void;
}
