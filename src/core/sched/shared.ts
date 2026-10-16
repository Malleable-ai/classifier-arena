import { FORMATS } from '../classifier/formats/index.js';
import type { Hosting } from '../classifier/hosting.js';
import { OPTION_ORDER_RULE, orderOptions } from '../classifier/order.js';
import type { BaselineInfo } from '../classifier/baselines.js';
import type { ProviderEntry } from '../classifier/providers.js';
import { promptConfigHash } from '../classifier/prompt.js';
import type { Decider, DecisionResult, Question, Seat } from '../classifier/types.js';
import { emptyResult } from '../classifier/types.js';
import type { AskedQuestion, GameResult, RealtimeGame, TurnGame } from '../game.js';
import type {
  DecisionLine,
  DecisionLineStatus,
  HeaderLine,
  HeaderSeat,
  LogLine,
  MatchEndLine,
  MatchLogSink,
  MatchStall,
  SeatPrice,
  WarmupRecord,
} from '../log/schema.js';
import { SCHEMA_VERSION } from '../log/schema.js';
import type { Clock } from '../util/clock.js';
import {
  decisionCount,
  isProviderSeat,
  isValidMatch,
  missRate,
  refusalRate,
  timeoutRate,
  type CadenceKind,
} from './validity.js';

export type { SeatPrice, WarmupRecord } from '../log/schema.js';

/**
 * What both schedulers share (docs/architecture/core.md, "Schedulers"): the timings, the warm-up,
 * the header, cost estimates for unanswered requests, decision lines and the match_end bookkeeping.
 * FAIRNESS: every value here is the same for both seats; nothing takes a seat-specific setting.
 */

/** Minimum time between a seat's sends (real-time) and the pause between turns (turns). */
export const FLOOR_MS = 100;
/** A request unanswered this long after it was sent (real-time) or the turn began (turns) misses. */
export const TIMEOUT_MS = 1_000;
export const BACKOFF_START_MS = 250;
export const BACKOFF_MAX_MS = 2_000;
/** Cap on each provider seat's warm-up call (on the injected clock). */
export const WARMUP_TIMEOUT_MS = 10_000;
/** Tick times are k × 1000/rate, so compare clock times with a tolerance for float rounding. */
export const EPS_MS = 1e-6;
/** The stall thresholds live with the rule they feed (validity.ts); re-exported for the runners. */
export { REALTIME_STALL_MS, TURN_STALL_SLACK_MS } from './validity.js';

export const SEATS: readonly [0, 1] = [0, 1];

/**
 * What the match header needs to know about a seat's player, besides its decider. Baselines have
 * `null` for every provider-only field.
 */
export interface SeatMeta {
  kind: 'provider' | 'baseline';
  player: string;
  label: string;
  format: string | null;
  hosting: Hosting | null;
  model: string | null;
  serviceTier: string | null;
  price: SeatPrice | null;
}

/**
 * A player's header metadata: one of `baselines` (null provider fields), else a provider from the
 * registry. Throws on an id that is neither.
 */
export function playerMeta(
  id: string,
  providers: readonly ProviderEntry[],
  baselines: readonly BaselineInfo[],
): SeatMeta {
  const baseline = baselines.find((b) => b.id === id);
  if (baseline) {
    return {
      kind: 'baseline',
      player: id,
      label: baseline.label,
      format: null,
      hosting: null,
      model: null,
      serviceTier: null,
      price: null,
    };
  }
  const entry = providers.find((p) => p.id === id);
  if (!entry) throw new Error(`unknown player ${id}`);
  const { inputPerMTokUsd, outputPerMTokUsd, asOf } = entry.price;
  return {
    kind: 'provider',
    player: entry.id,
    label: entry.label,
    format: entry.format,
    hosting: entry.hosting,
    model: entry.model,
    serviceTier: FORMATS[entry.format].serviceTier,
    price: { inputPerMTokUsd, outputPerMTokUsd, asOf },
  };
}

/** Either cadence (the parts both schedulers use). */
export type AnyGame<S, C> = RealtimeGame<S, C> | TurnGame<S, C>;

/** Options both runners take (the game itself is added per cadence). */
export interface MatchOptions<C> {
  seed: number;
  config: C;
  matchId: string;
  seats: readonly [SeatMeta, SeatMeta];
  deciders: readonly [Decider, Decider];
  clock: Clock;
  sink: MatchLogSink;
  gitCommit: string;
  runLocation: string;
  /** The machine's run id (computed in Node: src/cli/run-id.ts; the browser gets the proxy's). */
  runId: string;
  /** ISO time for the header, called once when the clock starts (src/core has no wall clock). */
  startTime: () => string;
  floorMs?: number;
  timeoutMs?: number;
}

/** A request that came back (or missed). `seq` counts this seat's decisions from 0. */
export interface Answer {
  seat: Seat;
  seq: number;
  /** Real-time: the tick it was sent on. Turns: the turn. */
  sentTick: number;
  questionKey: string;
  result: DecisionResult;
}

/** True for `http 429` and `http 5xx` errors (provider-decider puts the status first). */
export function isBackoffError(result: DecisionResult): boolean {
  if (result.status !== 'error' || result.error === undefined) return false;
  const m = /^http (\d{3})/.exec(result.error);
  if (!m) return false;
  const code = Number(m[1]);
  return code === 429 || (code >= 500 && code <= 599);
}

/** The backoff after one more 429/5xx: 250 ms, then doubling up to 2 s. */
export function nextBackoffMs(currentMs: number): number {
  return currentMs === 0 ? BACKOFF_START_MS : Math.min(currentMs * 2, BACKOFF_MAX_MS);
}

/** A result with no answer (timeout or error). */
export function missResult(
  status: 'timeout' | 'error',
  error: string,
  latencyMs: number,
): DecisionResult {
  return { ...emptyResult(status, latencyMs), error };
}

/** An `ok` result must carry a choice; one without is an error. */
export function requireChoice(result: DecisionResult): DecisionResult {
  if (result.status === 'ok' && result.choice === null) {
    return { ...result, status: 'error', error: 'ok answer without a choice' };
  }
  return result;
}

/**
 * `result` at an estimated cost: the request was sent but never answered (timed out, or still in
 * flight at match end), so the provider still bills it but its usage is unknown. It is logged at
 * the seat's last `ok` cost (seeded from the warm-up), since the prompt size barely changes.
 */
export function withEstimatedCost(result: DecisionResult, lastOkCostUsd: number): DecisionResult {
  return { ...result, costUsd: lastOkCostUsd, costEstimated: true };
}

/** Latency as logged: rounded to 0.1 ms. Turn games get this same value, so replays match. */
export function logLatency(ms: number): number {
  return Math.round(ms * 10) / 10;
}

/**
 * The decision line for `answer`. Probabilities are logged as the API reported them; when they
 * have no entry for the choice the line carries `probabilitiesPartial: true`, which the reader
 * requires for such a line.
 */
export function decisionLine(
  answer: Answer,
  status: DecisionLineStatus,
  appliedTick: number | null,
  extra: { error?: string; correct?: boolean } = {},
): DecisionLine {
  const r = answer.result;
  const line: DecisionLine = {
    type: 'decision',
    seat: answer.seat,
    seq: answer.seq,
    questionKey: answer.questionKey,
    sentTick: answer.sentTick,
    appliedTick,
    latencyMs: logLatency(r.latencyMs),
    choice: r.choice,
    probabilities: r.probabilities,
    confidence: r.confidence,
    inputTokens: r.inputTokens,
    costUsd: r.costUsd,
    status,
  };
  if (r.costEstimated === true) line.costEstimated = true;
  if (r.choice !== null && r.probabilities !== null && !Object.hasOwn(r.probabilities, r.choice)) {
    line.probabilitiesPartial = true;
  }
  const error = extra.error ?? r.error;
  if (error !== undefined) line.error = error;
  if (extra.correct !== undefined) line.correct = extra.correct;
  return line;
}

/**
 * What differs between two questions asked under one key: `name`, `instructions`, or `options`
 * (ids and descriptions compared as a set, since order is the cache's to apply). Null when equal.
 */
function questionDiff(a: Question, b: Question): string | null {
  if (a.name !== b.name) return `name ${JSON.stringify(a.name)} vs ${JSON.stringify(b.name)}`;
  if (a.instructions !== b.instructions) return 'instructions differ';
  const byId = new Map(a.options.map((o) => [o.id, o.description]));
  const same =
    a.options.length === b.options.length &&
    b.options.every((o) => byId.get(o.id) === o.description);
  return same ? null : 'options differ (ids or descriptions)';
}

/**
 * `asked` with its options in this match's order for its key, memoised per key: both seats get the
 * same Question object for the same key (OPTION_ORDER_RULE). Validates each question once. A key
 * names one question for the whole match: a cache hit is checked against the cached content, and
 * a game that reuses a key for a different question throws (its log could not rebuild the order).
 */
export function createQuestionOrder(seed: number): (asked: AskedQuestion) => AskedQuestion {
  const memo = new Map<string, { source: Question; ordered: AskedQuestion }>();
  return (asked) => {
    const hit = memo.get(asked.key);
    if (!hit) {
      const ordered = { key: asked.key, question: orderOptions(asked.question, seed, asked.key) };
      memo.set(asked.key, { source: asked.question, ordered });
      return ordered;
    }
    if (hit.source !== asked.question) {
      const diff = questionDiff(hit.ordered.question, asked.question);
      if (diff !== null) {
        throw new Error(
          `question key ${JSON.stringify(asked.key)} was reused for a different question ` +
            `(${diff}); a game must never reuse a key for a different question`,
        );
      }
    }
    return hit.ordered;
  };
}

// --- warm-up ---------------------------------------------------------------------------------

/** A seat's warm-up as the header logs it. */
export interface Warmup {
  record: WarmupRecord;
  /** The model version the API reported, or null. */
  modelVersion: string | null;
}

/**
 * A provider seat's warm-up failed (an error, or no answer within WARMUP_TIMEOUT_MS). The match
 * never starts and nothing is written: a match whose API is down or misconfigured would only
 * produce an invalid log. A refusal is not a failure (`warmUpSucceeded`).
 */
export class WarmupError extends Error {
  override name = 'WarmupError';
  /** The failed call, or null when no call was made. */
  readonly record: WarmupRecord | null;

  constructor(message: string, record: WarmupRecord | null = null) {
    super(message);
    this.record = record;
  }
}

/**
 * Whether a warm-up answer lets the match start: `ok`, or a `refusal`. The warm-up only opens the
 * connection before the clock starts, and a refusal is a well-formed answer from a working API,
 * so it succeeded (approved 2026-10-12). Timeouts and errors (network, HTTP, malformed) did not.
 */
export function warmUpSucceeded(status: WarmupRecord['status']): boolean {
  return status === 'ok' || status === 'refusal';
}

/**
 * One warm-up call: the game's first question, in this match's option order, for seat 0's view of
 * a fresh state (the same for every seat), capped at WARMUP_TIMEOUT_MS on `clock`. Returns the
 * record (status `ok` or `refusal`); throws WarmupError on a timeout or an error. Baselines skip
 * the warm-up.
 */
export async function warmUp<S, C>(
  decider: Decider,
  game: AnyGame<S, C>,
  seed: number,
  config: C,
  clock: Clock,
): Promise<Warmup> {
  const state = game.create(seed, config);
  const asked = game.question(state, 0);
  if (!asked) {
    throw new WarmupError(
      `warm-up failed: ${decider.player}: the game has no question for seat 0 at the start`,
    );
  }
  const question = orderOptions(asked.question, seed, asked.key);
  const view = game.view(state, 0);
  const start = clock.now();
  const abort = new AbortController();
  let result: DecisionResult;
  try {
    const timedOut = clock
      .sleep(WARMUP_TIMEOUT_MS, abort.signal)
      .then(() =>
        missResult(
          'timeout',
          `warm-up timeout after ${String(WARMUP_TIMEOUT_MS)} ms`,
          clock.now() - start,
        ),
      );
    timedOut.catch(() => undefined);
    result = await Promise.race([decider.decide(view, question, abort.signal), timedOut]);
  } catch (err) {
    result = missResult(
      'error',
      err instanceof Error ? err.message : String(err),
      clock.now() - start,
    );
  } finally {
    if (!abort.signal.aborted) abort.abort(new Error('warm-up settled'));
  }
  const record: WarmupRecord = {
    latencyMs: logLatency(result.latencyMs),
    status: result.status,
    costUsd: result.costUsd,
  };
  if (result.error !== undefined) record.error = result.error;
  if (!warmUpSucceeded(record.status)) {
    const why = `${record.status}: ${record.error ?? record.status}`;
    throw new WarmupError(`warm-up failed: ${decider.player}: ${why}`, record);
  }
  return { record, modelVersion: result.modelVersion ?? null };
}

/**
 * Warm up every provider seat at once (baselines get null). If any fails, throws one WarmupError
 * naming every failed seat, after all warm-ups have settled.
 */
export async function warmUpSeats<S, C>(
  game: AnyGame<S, C>,
  opts: Pick<MatchOptions<C>, 'seed' | 'config' | 'seats' | 'deciders' | 'clock'>,
): Promise<[Warmup | null, Warmup | null]> {
  const { seed, config, seats, deciders, clock } = opts;
  const settled = await Promise.allSettled(
    SEATS.map((seat) =>
      seats[seat].kind === 'provider'
        ? warmUp(deciders[seat], game, seed, config, clock)
        : Promise.resolve(null),
    ),
  );
  const out: [Warmup | null, Warmup | null] = [null, null];
  const failed: string[] = [];
  for (const seat of SEATS) {
    const s = settled[seat];
    if (!s) continue;
    if (s.status === 'fulfilled') {
      out[seat] = s.value;
      continue;
    }
    const err: unknown = s.reason;
    if (!(err instanceof WarmupError)) throw err;
    const why = err.record
      ? `${err.record.status}: ${err.record.error ?? err.record.status}`
      : err.message;
    failed.push(`${seats[seat].player} (seat ${String(seat)}): ${why}`);
  }
  if (failed.length > 0) {
    throw new WarmupError(`warm-up failed, match not started: ${failed.join('; ')}`);
  }
  return out;
}

// --- header and match end ----------------------------------------------------------------------

export interface HeaderInput<S, C> {
  game: AnyGame<S, C>;
  config: C;
  seed: number;
  matchId: string;
  startTime: string;
  gitCommit: string;
  runLocation: string;
  runId: string;
  floorMs: number;
  timeoutMs: number;
  seats: readonly [SeatMeta, SeatMeta];
  warmups: readonly [Warmup | null, Warmup | null];
}

export function buildHeader<S, C>(input: HeaderInput<S, C>): HeaderLine {
  const { game } = input;
  const seat = (s: Seat): HeaderSeat => {
    const m = input.seats[s];
    const w = input.warmups[s];
    return {
      seat: s,
      player: m.player,
      label: m.label,
      format: m.format,
      hosting: m.hosting,
      model: m.model,
      serviceTier: m.serviceTier,
      modelVersion: w?.modelVersion ?? null,
      price: m.price ? { ...m.price } : null,
      warmup: w ? { ...w.record } : null,
    };
  };
  return {
    type: 'header',
    schemaVersion: SCHEMA_VERSION,
    game: game.id,
    gameVersion: game.version,
    matchId: input.matchId,
    startTime: input.startTime,
    gitCommit: input.gitCommit,
    seed: input.seed,
    runLocation: input.runLocation,
    runId: input.runId,
    cadence:
      game.cadence.kind === 'realtime'
        ? { kind: 'realtime', tickRate: game.cadence.tickRate }
        : { kind: 'turns' },
    timing: { floorMs: input.floorMs, timeoutMs: input.timeoutMs },
    promptConfigHash: promptConfigHash(game.promptConfig),
    optionOrderRule: OPTION_ORDER_RULE,
    config: game.logConfig(input.config),
    seats: [seat(0), seat(1)],
  };
}

/** Writes lines to the sink and keeps what match_end and `latestDecisions` need. */
export interface LogBook {
  write(line: LogLine): void;
  /** Forward an answer's raw request/response to the sink's snapshot, if both exist. */
  snapshot(answer: Answer): void;
  readonly latestDecisions: readonly [DecisionLine | null, DecisionLine | null];
  /**
   * Build and write match_end: the game result, validity (validity.ts `isValidMatch`, with the
   * header's provider seats and timeout and the measured `stalls`), miss, timeout and refusal
   * rates, decision counts, total cost, and `stalls` when there were any.
   */
  end(
    result: GameResult,
    totalTicks: number,
    finalStateHash: string,
    stalls?: readonly MatchStall[],
  ): MatchEndLine;
  /** Warm-up spend, added to match_end's cost. */
  warmupCostUsd: number;
}

/**
 * `cadence` is the game's: validity's real-time checks (stall slack, empty provider seats) depend
 * on it (validity.ts `isValidMatch`).
 */
export function createLogBook(sink: MatchLogSink, cadence: CadenceKind): LogBook {
  const decisions: DecisionLine[] = [];
  const latest: [DecisionLine | null, DecisionLine | null] = [null, null];
  /** From the header, for validity's provider-seat check (no header: no seat is checked). */
  let providerSeats: readonly [boolean, boolean] = [false, false];
  /** From the header, for the stall rule on decision lines (no header: not checked). */
  let timeoutMs: number | undefined;
  const book: LogBook = {
    warmupCostUsd: 0,
    get latestDecisions() {
      return latest;
    },
    write(line) {
      if (line.type === 'decision') {
        decisions.push(line);
        latest[line.seat] = line;
      }
      if (line.type === 'header') {
        providerSeats = [isProviderSeat(line.seats[0]), isProviderSeat(line.seats[1])];
        timeoutMs = line.timing.timeoutMs;
      }
      sink.write(line);
    },
    snapshot(answer) {
      if (answer.result.raw && sink.snapshot) {
        sink.snapshot(answer.seat, answer.seq, answer.result.raw);
      }
    },
    end(result, totalTicks, finalStateHash, stalls = []) {
      let cost = book.warmupCostUsd;
      for (const l of decisions) cost += l.costUsd;
      const line: MatchEndLine = {
        type: 'match_end',
        winner: result.winner,
        scores: [result.scores[0], result.scores[1]],
        totalTicks,
        finalStateHash,
        valid: isValidMatch(decisions, cadence, {
          providerSeats,
          stalls,
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        }),
        missRates: [missRate(decisions, 0), missRate(decisions, 1)],
        timeoutRates: [timeoutRate(decisions, 0), timeoutRate(decisions, 1)],
        refusalRates: [refusalRate(decisions, 0), refusalRate(decisions, 1)],
        decisions: [decisionCount(decisions, 0), decisionCount(decisions, 1)],
        costUsd: cost,
      };
      if (stalls.length > 0) line.stalls = stalls.map((x) => ({ ...x }));
      book.write(line);
      return line;
    },
  };
  return book;
}
