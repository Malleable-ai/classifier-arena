import type { DecisionResult, Seat } from '../classifier/types.js';
import type { TurnAnswer, TurnGame } from '../game.js';
import type { DecisionLine, MatchEndLine, MatchStall } from '../log/schema.js';
import {
  EPS_MS,
  FLOOR_MS,
  SEATS,
  TIMEOUT_MS,
  TURN_STALL_SLACK_MS,
  buildHeader,
  createLogBook,
  createQuestionOrder,
  decisionLine,
  isBackoffError,
  logLatency,
  missResult,
  nextBackoffMs,
  requireChoice,
  warmUpSeats,
  withEstimatedCost,
  type Answer,
  type MatchOptions,
} from './shared.js';

/**
 * The turn scheduler (docs/architecture/core.md, "Turns"), generic over `TurnGame`. Per turn, until
 * the game is over or `maxTurns` is reached:
 *
 *   1. Ask both seats at once, each with its own `view` and the question ordered by
 *      `orderOptions` (memoised per key, so both seats get the same Question object). FAIRNESS:
 *      both share one deadline, `timeoutMs` after the turn starts, on the injected clock; the
 *      seat whose request is dispatched first alternates by turn parity, as in real time.
 *   2. When both have answered or missed, call `applyTurn` with `{ choice, latencyMs }` per seat,
 *      or null for a timeout, an error, a refusal or a seat with no question. The latency is the
 *      logged (rounded) one, so a replay from the log feeds `applyTurn` the same values.
 *   3. Write both decision lines (`sentTick = appliedTick = turn`, `correct` from `applyTurn`,
 *      status as answered: an `ok` answer is never `dropped` here) and the turn's events.
 *   4. Wait `floorMs` before the next turn.
 *
 * A 429/5xx backs the seat off as in real time (250 ms doubling to 2 s, reset by an `ok`): its
 * next ask waits until the backoff ends. The deadline does not move, so a seat that cannot ask
 * before it misses the turn (status `error`, BACKOFF_MISS, no request sent, no cost).
 *
 * Stalls: a turn always ends by its deadline, so a turn that finishes more than
 * TURN_STALL_SLACK_MS after it (on the injected clock) means the machine held the scheduler up
 * (sleep, suspend, a clock jump). It is recorded (`{ atTick: turn, gapMs }`, written in
 * `match_end.stalls`) and the match is invalid.
 */

/** `error` of a turn a backed-off seat could not ask before the deadline. */
export const BACKOFF_MISS = 'backoff: no time to ask before the turn deadline';

export interface TurnRunnerOptions<S, C> extends MatchOptions<C> {
  game: TurnGame<S, C>;
}

export interface TurnRunner<S> {
  readonly state: S;
  /** The last decision line written for each seat (null before its first). */
  readonly latestDecisions: readonly [DecisionLine | null, DecisionLine | null];
  readonly done: boolean;
  readonly result: MatchEndLine | null;
  /** Warm-up (provider seats), then the header. Throws WarmupError on a failure. */
  start(): Promise<void>;
  /** Play every turn (starting first if `start` wasn't called) and return the match_end line. */
  run(): Promise<MatchEndLine>;
  /**
   * Abort every request in flight. For a match that failed (`run` rejected), so it stops spending;
   * nothing more is logged for those requests.
   */
  abort(): void;
}

interface SeatState {
  seq: number;
  lastOkCostUsd: number;
  backoffMs: number;
  backoffUntil: number;
}

export function createTurnRunner<S, C>(opts: TurnRunnerOptions<S, C>): TurnRunner<S> {
  const { game, seed, config, seats, deciders, clock } = opts;
  const floorMs = opts.floorMs ?? FLOOR_MS;
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  const maxTurns = game.maxTurns(config);
  const state = game.create(seed, config);
  const ordered = createQuestionOrder(seed);
  const book = createLogBook(opts.sink, game.cadence.kind);
  const seatState: [SeatState, SeatState] = [0, 1].map(() => ({
    seq: 0,
    lastOkCostUsd: 0,
    backoffMs: 0,
    backoffUntil: Number.NEGATIVE_INFINITY,
  })) as [SeatState, SeatState];
  /** Each request in flight's abort controller (`abort()` aborts them all). */
  const inFlight = new Set<AbortController>();
  let starting: Promise<void> | null = null;
  let running = false;
  let result: MatchEndLine | null = null;
  const stalls: MatchStall[] = [];

  const isOver = (): boolean => game.turn(state) >= maxTurns || game.result(state).over;

  /** One seat's ask for `turn`: its answer or miss, or null when the game has no question. */
  const ask = async (seat: Seat, turn: number, deadline: number): Promise<Answer | null> => {
    const asked = game.question(state, seat);
    if (!asked) return null;
    const { key, question } = ordered(asked);
    const view = game.view(state, seat);
    const s = seatState[seat];
    const base = { seat, seq: s.seq++, sentTick: turn, questionKey: key };
    if (s.backoffUntil > clock.now() + EPS_MS) {
      if (s.backoffUntil >= deadline - EPS_MS) {
        return { ...base, result: missResult('error', BACKOFF_MISS, 0) };
      }
      await clock.sleep(s.backoffUntil - clock.now());
    }
    const sentAt = clock.now();
    const abort = new AbortController();
    inFlight.add(abort);
    let raw: DecisionResult;
    try {
      const timedOut = clock
        .sleep(deadline - sentAt, abort.signal)
        .then(() => missResult('timeout', 'timeout', clock.now() - sentAt));
      timedOut.catch(() => undefined);
      // Through a promise, so a decider that throws synchronously is an `error` too.
      const answered = Promise.resolve()
        .then(() => deciders[seat].decide(view, question, abort.signal, { seq: base.seq }))
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          return missResult('error', `decider threw: ${msg}`, clock.now() - sentAt);
        });
      raw = await Promise.race([answered, timedOut]);
    } finally {
      inFlight.delete(abort);
      if (!abort.signal.aborted) abort.abort(new Error('settled'));
    }
    let r = requireChoice(raw);
    if (r.status === 'timeout') r = withEstimatedCost(r, s.lastOkCostUsd);
    if (r.status === 'ok') {
      s.lastOkCostUsd = r.costUsd;
      s.backoffMs = 0;
      s.backoffUntil = Number.NEGATIVE_INFINITY;
    } else if (isBackoffError(r)) {
      s.backoffMs = nextBackoffMs(s.backoffMs);
      s.backoffUntil = clock.now() + s.backoffMs;
    }
    const answer: Answer = { ...base, result: r };
    book.snapshot(answer);
    return answer;
  };

  const playTurn = async (): Promise<void> => {
    const turn = game.turn(state);
    const deadline = clock.now() + timeoutMs;
    const asks: [Promise<Answer | null>, Promise<Answer | null>] = [
      Promise.resolve(null),
      Promise.resolve(null),
    ];
    for (const seat of turn % 2 === 0 ? SEATS : ([1, 0] as const)) {
      asks[seat] = ask(seat, turn, deadline);
    }
    const answers = await Promise.all(asks);
    const lateMs = clock.now() - deadline;
    if (lateMs > TURN_STALL_SLACK_MS) stalls.push({ atTick: turn, gapMs: Math.round(lateMs) });
    const toTurnAnswer = (a: Answer | null): TurnAnswer | null =>
      a && a.result.status === 'ok' && a.result.choice !== null
        ? { choice: a.result.choice, latencyMs: logLatency(a.result.latencyMs) }
        : null;
    const out = game.applyTurn(state, [toTurnAnswer(answers[0]), toTurnAnswer(answers[1])]);
    for (const seat of SEATS) {
      const a = answers[seat];
      if (!a) continue;
      const correct = out.correct[seat];
      const extra = correct === null ? {} : { correct };
      book.write(decisionLine(a, a.result.status, turn, extra));
    }
    for (const e of out.events) book.write({ type: 'event', tick: turn, game: e });
  };

  const start = async (): Promise<void> => {
    const warmups = await warmUpSeats(game, opts);
    for (const seat of SEATS) {
      const w = warmups[seat];
      if (!w) continue;
      seatState[seat].lastOkCostUsd = w.record.costUsd;
      book.warmupCostUsd += w.record.costUsd;
    }
    book.write(
      buildHeader({
        game,
        config,
        seed,
        matchId: opts.matchId,
        startTime: opts.startTime(),
        gitCommit: opts.gitCommit,
        runLocation: opts.runLocation,
        runId: opts.runId,
        floorMs,
        timeoutMs,
        seats,
        warmups,
      }),
    );
  };

  const runner: TurnRunner<S> = {
    state,
    get latestDecisions() {
      return book.latestDecisions;
    },
    get done() {
      return result !== null;
    },
    get result() {
      return result;
    },
    start() {
      if (starting) return Promise.reject(new Error('match already started'));
      starting = start();
      return starting;
    },
    async run() {
      if (running) throw new Error('match already running');
      running = true;
      await (starting ?? runner.start());
      while (!isOver()) {
        await playTurn();
        if (!isOver()) await clock.sleep(floorMs);
      }
      const end = book.end(game.result(state), game.turn(state), game.hash(state), stalls);
      result = end;
      return end;
    },
    abort() {
      for (const a of inFlight) a.abort(new Error('match stopped'));
    },
  };
  return runner;
}
