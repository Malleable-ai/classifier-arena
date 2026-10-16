import { REFUSAL_ERROR, type Seat } from '../classifier/types.js';
import type {
  DecisionLine,
  HeaderLine,
  HeaderSeat,
  LogLine,
  MatchEndLine,
  MatchStall,
} from '../log/schema.js';
import type { Exclusions } from '../results/excluded.js';

/**
 * The 2% limit. Per match: a seat whose transport failures are more than this share of
 * its decisions makes the match invalid. Per published run: a player whose misses (timeouts and
 * failures) are more than this share gets the run-level warning (src/core/stats/summary.ts).
 */
export const MAX_MISS_RATE = 0.02;

/**
 * Real-time: a tick processed more than this late (from when it was due) is a stall, and the match
 * is invalid. The Node driver runs the scheduler about once a tick (16.7 ms at 60 Hz) and the
 * browser every ~4 ms, so normal jitter (a busy event loop, a GC pause) is tens of ms. Past 250 ms
 * the machine itself held the scheduler up (sleep, suspend, a clock jump): the game clock then
 * catches up in one burst (15 ticks at 60 Hz and more) in which no answer can land and each seat
 * can send at most once, so the seats lose moves through no fault of the models. It is also a
 * quarter of the 1 s request timeout.
 */
export const REALTIME_STALL_MS = 250;
/**
 * Turns: a turn that finishes more than this long after its deadline is a stall, and the match is
 * invalid. A turn always ends by its deadline (the timeout races every request), so time past it
 * is the machine held up, not a slow model. Generous, so only a real pause (sleep, suspend, a
 * clock jump) counts; a shorter one shows as both seats timing out.
 */
export const TURN_STALL_SLACK_MS = 3_000;

/**
 * `error` on a request that was still in flight (or an answer still waiting) when the match ended.
 * It never had a chance to reach the game, so it is logged (for its cost) but is not a decision
 * for the miss rate.
 */
export const MATCH_OVER = 'matchOver';

/** A match's cadence: the real-time checks (stall slack, empty provider seats) depend on it. */
export type CadenceKind = HeaderLine['cadence']['kind'];

function counted(line: LogLine, seat: Seat): line is DecisionLine {
  return line.type === 'decision' && line.seat === seat && line.error !== MATCH_OVER;
}

/**
 * The model declined to answer: status `refusal`, or, in a line that never went through the log
 * reader, the `error` status with REFUSAL_ERROR that logs used before the `refusal` status
 * (2026-10-12). The reader already turns those into `refusal`.
 */
export function isRefusal(line: DecisionLine): boolean {
  return line.status === 'refusal' || (line.status === 'error' && line.error === REFUSAL_ERROR);
}

/**
 * A transport or format failure: every `error` line that is not a refusal. That is an HTTP error
 * (and a turn seat's BACKOFF_MISS after a 429 or 5xx), a network error, a malformed or unusable
 * response, an `ok` without a choice, or a decider that threw.
 */
export function isFailure(line: DecisionLine): boolean {
  return line.status === 'error' && !isRefusal(line);
}

/** Lines of `seat` that `hit` matches, over its decisions; 0 when it made no decisions. */
function rateOf(lines: readonly LogLine[], seat: Seat, hit: (l: DecisionLine) => boolean): number {
  let total = 0;
  let hits = 0;
  for (const line of lines) {
    if (!counted(line, seat)) continue;
    total++;
    if (hit(line)) hits++;
  }
  return total === 0 ? 0 : hits / total;
}

/**
 * Misses (timeouts and transport failures) / decisions for `seat`; 0 when it made no decisions.
 * A `dropped` answer is not a miss: the API answered and the game played the answer out (it was
 * stale, or the seat was busy). That's the model's play, reported by `droppedRate`. A refusal is
 * not a miss either: the model chose not to answer, reported by `refusalRate`.
 */
export function missRate(lines: readonly LogLine[], seat: Seat): number {
  return rateOf(lines, seat, (l) => l.status === 'timeout' || isFailure(l));
}

/** Timeouts / decisions for `seat` (a part of `missRate`). */
export function timeoutRate(lines: readonly LogLine[], seat: Seat): number {
  return rateOf(lines, seat, (l) => l.status === 'timeout');
}

/**
 * Transport failures / decisions for `seat` (`isFailure`). Timeouts and refusals are not
 * failures here.
 */
export function failureRate(lines: readonly LogLine[], seat: Seat): number {
  return rateOf(lines, seat, isFailure);
}

/** Refusals / decisions for `seat` (`isRefusal`). Reported, never counted toward validity. */
export function refusalRate(lines: readonly LogLine[], seat: Seat): number {
  return rateOf(lines, seat, isRefusal);
}

/** Dropped answers / decisions for `seat`: answers the game couldn't use. A stat, not validity. */
export function droppedRate(lines: readonly LogLine[], seat: Seat): number {
  return rateOf(lines, seat, (l) => l.status === 'dropped');
}

export function decisionCount(lines: readonly LogLine[], seat: Seat): number {
  let n = 0;
  for (const line of lines) if (counted(line, seat)) n++;
  return n;
}

/** How long past the timeout a decision line's latency may run before it means a stall. */
export function stallSlackMs(cadence: CadenceKind): number {
  return cadence === 'realtime' ? REALTIME_STALL_MS : TURN_STALL_SLACK_MS;
}

/**
 * Stalls the decision lines show by themselves (any seat, `matchOver` lines included): a line whose
 * `latencyMs` is more than `timeoutMs` plus the cadence's stall slack (`stallSlackMs`). A request
 * can't take longer than its timeout, which races it on the scheduler's clock, unless the process
 * was paused: that is how the Inbox matches that ran across a machine sleep before stall detection
 * existed show up (both seats' last requests logged `matchOver` after ~15 minutes). Each is
 * `{ atTick: sentTick, gapMs }`, `gapMs` the whole ms past the timeout, in log order.
 */
export function logStalls(
  lines: readonly LogLine[],
  cadence: CadenceKind,
  timeoutMs: number,
): MatchStall[] {
  const limit = timeoutMs + stallSlackMs(cadence);
  const out: MatchStall[] = [];
  for (const line of lines) {
    if (line.type === 'decision' && line.latencyMs > limit) {
      out.push({ atTick: line.sentTick, gapMs: Math.round(line.latencyMs - timeoutMs) });
    }
  }
  return out;
}

/** What decides validity besides the decision lines (from the header and match_end). */
export interface ValidityFacts {
  /**
   * Which seats a provider played (`isProviderSeat`). A real-time provider seat with no decisions
   * makes the match invalid. Omitted: no seat is checked.
   */
  providerSeats?: readonly [boolean, boolean];
  /** `match_end.stalls`: any stall the scheduler measured makes the match invalid. */
  stalls?: readonly MatchStall[];
  /**
   * The header's `timing.timeoutMs`: a decision line longer than this plus the stall slack is a
   * stall too (`logStalls`). Omitted: not checked.
   */
  timeoutMs?: number;
}

/** A header seat played by a provider: it has a format (baselines have null for every such field). */
export function isProviderSeat(seat: Pick<HeaderSeat, 'format'>): boolean {
  return typeof seat.format === 'string';
}

/** Why a match is invalid. */
export type InvalidReason =
  /** On `results/excluded.json` (only from `invalidReasonsOfLog`). */
  | { kind: 'excluded'; reason: string }
  /**
   * The machine held the scheduler up: `scheduler` when it measured the stall
   * (`match_end.stalls`), `log` when only the decision lines show it (`logStalls`).
   */
  | { kind: 'stall'; from: 'scheduler' | 'log'; stalls: MatchStall[] }
  /** Real-time: a provider seat made no decisions. */
  | { kind: 'noDecisions'; seat: Seat }
  /** A seat's transport failures are over MAX_MISS_RATE of its decisions. */
  | { kind: 'failures'; seat: Seat; rate: number };

/**
 * Every reason the match is invalid; none means it is valid. The rule is the same for every game
 * and both seats (approved by the maintainer on 2026-10-16):
 *
 * - **A stall** (`facts.stalls`, else `logStalls` with `facts.timeoutMs`): the machine held the
 *   scheduler up (sleep, suspend, a clock jump), an infrastructure failure the tournament reruns,
 *   not the models' play. Reported once, as `scheduler` when it measured one.
 * - **Real-time: a provider seat with no decisions.** A defensive check: a live provider seat
 *   always gets answers, so none means the run was broken (0 failures of 0 decisions is not a
 *   valid match).
 * - **Transport and format failures** (`failureRate`: network, HTTP, 429/5xx backoff misses,
 *   malformed responses, a decider that throws) over MAX_MISS_RATE of a seat's decisions.
 *
 * **Timeouts never count**, in either cadence. A timeout is the model's own miss: no move in a
 * real-time game, 0 for that ask in a turn game. Counting it toward validity made the tournament
 * rerun exactly the matches where the slower model timed out a lot, dropping its losses (Jev won
 * all ten such head-to-heads), a bias toward the slower model. Timeouts are still reported
 * (`match_end.missRates` includes them, `match_end.timeoutRates` counts them alone) and checked
 * over the whole published run (the run-level check). **Refusals never count** either (approved
 * 2026-10-12): rerunning the matches where a model refused would hide that behaviour.
 */
export function invalidReasons(
  lines: readonly LogLine[],
  cadence: CadenceKind,
  facts: ValidityFacts = {},
): InvalidReason[] {
  const out: InvalidReason[] = [];
  const measured = facts.stalls ?? [];
  if (measured.length > 0) {
    out.push({ kind: 'stall', from: 'scheduler', stalls: measured.map((x) => ({ ...x })) });
  } else if (facts.timeoutMs !== undefined) {
    const shown = logStalls(lines, cadence, facts.timeoutMs);
    if (shown.length > 0) out.push({ kind: 'stall', from: 'log', stalls: shown });
  }
  const providers = facts.providerSeats;
  if (cadence === 'realtime' && providers !== undefined) {
    for (const seat of [0, 1] as const) {
      if (providers[seat] && decisionCount(lines, seat) === 0)
        out.push({ kind: 'noDecisions', seat });
    }
  }
  for (const seat of [0, 1] as const) {
    const rate = failureRate(lines, seat);
    if (rate > MAX_MISS_RATE) out.push({ kind: 'failures', seat, rate });
  }
  return out;
}

/** True when `invalidReasons` finds none. */
export function isValidMatch(
  lines: readonly LogLine[],
  cadence: CadenceKind,
  facts: ValidityFacts = {},
): boolean {
  return invalidReasons(lines, cadence, facts).length === 0;
}

/**
 * One reason in words: "stall", "stall (from the log)", "Jev (seat 0) made no decisions",
 * "OpenAI (seat 1) had transport errors on 3.1% of its decisions (limit 2%)". `labels` name the
 * seats (default: just "seat 0" and "seat 1").
 */
export function invalidReasonText(
  reason: InvalidReason,
  labels?: readonly [string, string],
): string {
  const who = (seat: Seat): string =>
    labels === undefined ? `seat ${String(seat)}` : `${labels[seat]} (seat ${String(seat)})`;
  switch (reason.kind) {
    case 'excluded':
      return `excluded by hand: ${reason.reason}`;
    case 'stall':
      return reason.from === 'scheduler' ? 'stall' : 'stall (from the log)';
    case 'noDecisions':
      return `${who(reason.seat)} made no decisions`;
    case 'failures':
      return (
        `${who(reason.seat)} had transport errors on ${(reason.rate * 100).toFixed(1)}% of its ` +
        `decisions (limit ${String(MAX_MISS_RATE * 100)}%)`
      );
  }
}

/** What re-scoring a log needs: its header (cadence, timing, seats, id), decisions and match_end. */
export interface ScoredLog {
  header: {
    cadence: Pick<HeaderLine['cadence'], 'kind'>;
    /** For the stall rule from the log (`logStalls`); omitted, not checked. */
    timing?: Pick<HeaderLine['timing'], 'timeoutMs'>;
    /** For the real-time provider-seat check; omitted, no seat is checked. */
    seats?: readonly [Pick<HeaderSeat, 'format'>, Pick<HeaderSeat, 'format'>];
    /** For the exclusion list. */
    matchId?: string;
  };
  decisions: readonly DecisionLine[];
  /** For its `stalls`; null or omitted for an unfinished log. */
  matchEnd?: Pick<MatchEndLine, 'stalls'> | null;
}

/**
 * Every reason a log is invalid under the current rule, recomputed from the log with the same
 * `invalidReasons` the schedulers use for `match_end.valid` (its decision lines, its header's
 * cadence, timeout and provider seats, and its recorded stalls). An excluded match has the one
 * reason `excluded`.
 */
export function invalidReasonsOfLog(log: ScoredLog, excluded: Exclusions): InvalidReason[] {
  const id = log.header.matchId;
  const reason = id === undefined ? undefined : excluded.get(id);
  if (reason !== undefined) return [{ kind: 'excluded', reason }];
  const { seats, timing } = log.header;
  const stalls = log.matchEnd?.stalls;
  return invalidReasons(log.decisions, log.header.cadence.kind, {
    ...(seats === undefined
      ? {}
      : { providerSeats: [isProviderSeat(seats[0]), isProviderSeat(seats[1])] as const }),
    ...(stalls === undefined ? {} : { stalls }),
    ...(timing === undefined ? {} : { timeoutMs: timing.timeoutMs }),
  });
}

/**
 * A log's validity under the current rule (`invalidReasonsOfLog` finds none). `match_end.valid`
 * stays the record of what the rule said when the match was played; the summaries, the
 * leaderboard, the index and the history page use this instead, so a rule change (refusals no
 * longer counting, 2026-10-12; timeouts no longer counting and stalls read from the log,
 * 2026-10-16) re-scores the logs already written.
 *
 * `excluded` is `results/excluded.json` (src/core/results/excluded.ts): a match on it is never
 * valid, whatever its log says. It is required so no caller forgets it; pass NO_EXCLUSIONS where
 * there is no results tree.
 */
export function isValidLog(log: ScoredLog, excluded: Exclusions): boolean {
  return invalidReasonsOfLog(log, excluded).length === 0;
}
