import type { Decider, DecisionResult, Seat } from '../classifier/types.js';
import type { AskedQuestion, RealtimeGame, RealtimeInput, Settlement } from '../game.js';
import type { DecisionLine, MatchEndLine, MatchStall } from '../log/schema.js';
import type { Clock } from '../util/clock.js';
import {
  EPS_MS,
  FLOOR_MS,
  REALTIME_STALL_MS,
  SEATS,
  TIMEOUT_MS,
  buildHeader,
  createLogBook,
  createQuestionOrder,
  decisionLine,
  isBackoffError,
  missResult,
  nextBackoffMs,
  requireChoice,
  warmUpSeats,
  withEstimatedCost,
  type Answer,
  type MatchOptions,
} from './shared.js';
import { MATCH_OVER } from './validity.js';

/**
 * The real-time scheduler (docs/architecture/core.md, "Schedulers"), generic over `RealtimeGame`
 * and shared by Node (src/core/sched/drive.ts) and the browser (live mode's timer). DOM- and
 * Node-free: the caller owns pacing and calls `advance(clock.now())`.
 *
 * Per processed tick T (fixed timeline at the game's tick rate from the moment the clock starts,
 * accumulator):
 *   1. Take each seat's `ok` answer that arrived since the last tick; it becomes this tick's `step`
 *      input `{ choice, questionKey }`, so `appliedTick = T` (the next tick processed after
 *      arrival).
 *   2. Poll both seats for a new request on the state before T (`sentTick = T`). FAIRNESS: the
 *      polling order alternates by tick parity (even: seat 0 first, odd: seat 1 first), so neither
 *      seat systematically sends first. Floor, timeout and backoff are the same for both. Nothing
 *      is sent when `game.canAsk` is false or `game.question` is null, nor, for a game with
 *      `answerRetiresKey`, to a seat whose step-1 input answers the very key it would be asked.
 *      Each question's options are ordered by `orderOptions`, memoised per key, so both seats get
 *      the same Question object.
 *   3. `step`, then match the game's settlements back to decisions and write its events.
 *
 * Decision-line rule: every answered request gets exactly one line, written when its outcome is
 * final. Timeouts, errors and refusals are written on arrival (`appliedTick: null`): none of them
 * reaches the game. An `ok` answer fed to
 * the game waits, per seat in FIFO order, for the settlement that resolves it: `applied` (status
 * `ok`) or `dropped` (status `dropped`, reason in `error`), with `correct` when the game reports
 * it. A settlement is matched to the oldest waiting answer from that seat with the same choice
 * (exact for a game that settles each input once and drops older inputs of a kind first).
 * `appliedTick` stays the tick the answer was fed to `step` (what a replay needs).
 *
 * Stalls: each `advance` measures how late it runs, from when the next tick was due (on the
 * injected clock, so tests can simulate a jump). Over REALTIME_STALL_MS the machine held the
 * scheduler up (sleep, suspend, a clock jump) and the game clock catches up in one burst with no
 * answers landing, so the stall is recorded (`{ atTick, gapMs }`, written in `match_end.stalls`)
 * and the match is invalid. Measuring lateness rather than the time between calls keeps a game
 * with a slow tick rate (ticks further apart than the threshold) from looking stalled.
 */

/** Options for one seat's controller. */
export interface SeatControllerOptions {
  seat: Seat;
  decider: Decider;
  clock: Clock;
  floorMs?: number;
  timeoutMs?: number;
  /** Called once per request when it resolves, times out or fails (never for cancelled ones). */
  onAnswer: (answer: Answer) => void;
}

/**
 * One seat's controller: at most one request in flight; the next goes out once the
 * answer is in, at least `floorMs` after the last send, and not during a 429/5xx backoff. A
 * request that has not answered `timeoutMs` after it was sent is a `timeout` and its late answer,
 * if any, is discarded.
 *
 * The timeout runs on the injected clock (not `AbortSignal.timeout`) so SimClock tests and offline
 * matches time out on simulated time; on `realClock` it is the same thing.
 */
export class SeatController {
  readonly seat: Seat;
  inFlight = false;
  lastSentAt = Number.NEGATIVE_INFINITY;
  /** Current backoff step in ms (0 = none). */
  backoffMs = 0;
  backoffUntil = Number.NEGATIVE_INFINITY;
  /** An `ok` answer waiting to be fed to the game on the next processed tick. */
  pending: Answer | null = null;
  /**
   * Cost of this seat's last `ok` answer (the runner seeds it from the warm-up). A request that
   * was sent but never answered is logged at this cost with `costEstimated` (withEstimatedCost).
   */
  lastOkCostUsd = 0;
  private seq = 0;
  private current: { abort: AbortController; cancel: () => Answer | null } | null = null;
  private readonly decider: Decider;
  private readonly clock: Clock;
  private readonly floorMs: number;
  private readonly timeoutMs: number;
  private readonly onAnswer: (answer: Answer) => void;

  constructor(opts: SeatControllerOptions) {
    this.seat = opts.seat;
    this.decider = opts.decider;
    this.clock = opts.clock;
    this.floorMs = opts.floorMs ?? FLOOR_MS;
    this.timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
    this.onAnswer = opts.onAnswer;
  }

  /** Requests sent so far. */
  get sent(): number {
    return this.seq;
  }

  canSend(nowMs: number): boolean {
    return (
      !this.inFlight &&
      this.pending === null &&
      nowMs - this.lastSentAt >= this.floorMs - EPS_MS &&
      nowMs >= this.backoffUntil - EPS_MS
    );
  }

  /**
   * Send `asked.question` (already in the match's option order) with `state` (this seat's view of
   * the state before `tick` is simulated) if eligible. The answer carries `asked.key`.
   */
  maybeSend(tick: number, nowMs: number, state: unknown, asked: AskedQuestion): boolean {
    if (!this.canSend(nowMs)) return false;
    const { clock, seat } = this;
    const seq = this.seq++;
    const questionKey = asked.key;
    const abort = new AbortController();
    const start = clock.now();
    let settled = false;
    this.inFlight = true;
    this.lastSentAt = nowMs;
    const answer = (result: DecisionResult): Answer => ({
      seat,
      seq,
      sentTick: tick,
      questionKey,
      result,
    });

    // First of {answer, error, timeout} wins; anything after is discarded. `cancel` (match over)
    // settles silently: the request never produced a decision.
    const finish = (result: DecisionResult | null): void => {
      if (settled) return;
      settled = true;
      if (this.current?.abort === abort) this.current = null;
      this.inFlight = false;
      if (!abort.signal.aborted) abort.abort(new Error('settled')); // cancels the other branch
      if (result) this.onResult(answer(result), clock.now());
    };
    this.current = {
      abort,
      cancel: () => {
        if (settled) return null;
        finish(null);
        const result = missResult('error', 'cancelled', clock.now() - start);
        return answer(withEstimatedCost(result, this.lastOkCostUsd));
      },
    };

    clock.sleep(this.timeoutMs, abort.signal).then(
      () => {
        finish(missResult('timeout', 'timeout', clock.now() - start));
      },
      () => undefined,
    );
    // Through a promise, so a decider that throws synchronously is an `error` too. The seq goes
    // with the request: it is the log line's, and names the proxy's snapshot.
    Promise.resolve()
      .then(() => this.decider.decide(state, asked.question, abort.signal, { seq }))
      .then(
        (result) => {
          finish(result);
        },
        (err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          finish(missResult('error', `decider threw: ${msg}`, clock.now() - start));
        },
      );
    return true;
  }

  private onResult(answer: Answer, nowMs: number): void {
    let result = requireChoice(answer.result);
    if (result.status === 'timeout') result = withEstimatedCost(result, this.lastOkCostUsd);
    const final = result === answer.result ? answer : { ...answer, result };
    if (result.status === 'ok') {
      this.lastOkCostUsd = result.costUsd;
      this.backoffMs = 0;
      this.backoffUntil = Number.NEGATIVE_INFINITY;
      this.pending = final;
    } else if (isBackoffError(result)) {
      this.backoffMs = nextBackoffMs(this.backoffMs);
      this.backoffUntil = nowMs + this.backoffMs;
    }
    this.onAnswer(final);
  }

  /** Take the answer waiting for the game, if any. */
  takePending(): Answer | null {
    const p = this.pending;
    this.pending = null;
    return p;
  }

  /**
   * Abort the request in flight (its answer, if any, is discarded). Returns it as an unanswered
   * Answer (choice null, estimated cost) so the caller can log its spend, or null if none was.
   */
  abort(): Answer | null {
    return this.current?.cancel() ?? null;
  }
}

/**
 * To watch each `step` (live mode draws effects from them), pass a wrapped game: see `tapSteps`
 * in src/web/live/setup.ts.
 */
export interface RealtimeRunnerOptions<S, C> extends MatchOptions<C> {
  game: RealtimeGame<S, C>;
}

export interface RealtimeRunner<S> {
  readonly state: S;
  readonly controllers: readonly [SeatController, SeatController];
  /** The last decision line written for each seat (null before its first). */
  readonly latestDecisions: readonly [DecisionLine | null, DecisionLine | null];
  readonly done: boolean;
  /** Clock time tick 0 is due (null until `start` resolves). */
  readonly startMs: number | null;
  readonly result: MatchEndLine | null;
  /** Warm-up (provider seats), header, then start the clock. Throws WarmupError on a failure. */
  start(): Promise<void>;
  /** Process every tick due by `nowMs`. */
  advance(nowMs: number): void;
  /** Clock time the next tick is due. */
  nextTickDueMs(): number;
  /**
   * Abort both seats' requests in flight without logging them. For a match that failed (`advance`
   * threw), so it stops spending; a match that ends normally logs its in-flight requests itself.
   */
  abort(): void;
}

interface Waiting {
  answer: Answer;
  choice: string;
  appliedTick: number;
}

export function createRealtimeRunner<S, C>(opts: RealtimeRunnerOptions<S, C>): RealtimeRunner<S> {
  const { game, seed, config, seats, deciders, clock } = opts;
  const floorMs = opts.floorMs ?? FLOOR_MS;
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  const tickMs = 1000 / game.cadence.tickRate;
  const maxTicks = game.maxTicks(config);
  const state = game.create(seed, config);
  const ordered = createQuestionOrder(seed);
  const book = createLogBook(opts.sink, game.cadence.kind);
  const waiting: [Waiting[], Waiting[]] = [[], []];
  let starting: Promise<void> | null = null;
  let startMs: number | null = null;
  let ticksProcessed = 0;
  let result: MatchEndLine | null = null;
  const stalls: MatchStall[] = [];

  const onAnswer = (answer: Answer): void => {
    book.snapshot(answer);
    // ok answers wait in controller.pending for the next processed tick.
    if (answer.result.status !== 'ok') book.write(decisionLine(answer, answer.result.status, null));
  };

  const mk = (seat: Seat): SeatController =>
    new SeatController({ seat, decider: deciders[seat], clock, floorMs, timeoutMs, onAnswer });
  const controllers = [mk(0), mk(1)] as const;

  const settle = (s: Settlement): void => {
    const queue = waiting[s.seat];
    const i = queue.findIndex((w) => w.choice === s.choice);
    const w = i < 0 ? undefined : queue.splice(i, 1)[0];
    if (!w) {
      throw new Error(
        `${game.id}: settlement for seat ${String(s.seat)} (${s.choice}) matches no waiting answer`,
      );
    }
    const extra: { error?: string; correct?: boolean } = {};
    if (s.correct !== undefined) extra.correct = s.correct;
    if (s.outcome === 'applied') {
      book.write(decisionLine(w.answer, 'ok', w.appliedTick, extra));
    } else {
      extra.error = `dropped: ${s.reason ?? 'unspecified'}`;
      book.write(decisionLine(w.answer, 'dropped', w.appliedTick, extra));
    }
  };

  const isOver = (): boolean => game.tick(state) >= maxTicks || game.result(state).over;

  const finish = (): void => {
    for (const c of controllers) {
      // A request still in flight was sent and will be billed: log it (estimated cost, not a
      // decision for the miss rate) so the spend total is honest.
      const unanswered = c.abort();
      if (unanswered) book.write(decisionLine(unanswered, 'dropped', null, { error: MATCH_OVER }));
      const p = c.takePending();
      if (p) book.write(decisionLine(p, 'dropped', null, { error: MATCH_OVER }));
    }
    for (const queue of waiting) {
      for (const w of queue.splice(0)) {
        book.write(
          decisionLine(w.answer, 'dropped', w.appliedTick, { error: 'dropped: unresolved' }),
        );
      }
    }
    result = book.end(game.result(state), game.tick(state), game.hash(state), stalls);
  };

  const processTick = (nowMs: number): void => {
    const tick = game.tick(state);
    const inputs: [RealtimeInput | null, RealtimeInput | null] = [null, null];
    for (const c of controllers) {
      const p = c.takePending();
      if (!p || p.result.choice === null) continue;
      const choice = p.result.choice;
      inputs[c.seat] = { choice, questionKey: p.questionKey };
      waiting[c.seat].push({ answer: p, choice, appliedTick: tick });
    }
    for (const seat of tick % 2 === 0 ? SEATS : ([1, 0] as const)) {
      const c = controllers[seat];
      if (!c.canSend(nowMs) || !game.canAsk(state, seat)) continue;
      const asked = game.question(state, seat);
      if (!asked) continue;
      // The state is from before this tick's inputs, so don't re-ask a key the seat is answering
      // right now when the game retires answered keys (RealtimeGame.answerRetiresKey).
      if (game.answerRetiresKey === true && inputs[seat]?.questionKey === asked.key) continue;
      c.maybeSend(tick, nowMs, game.view(state, seat), ordered(asked));
    }
    const out = game.step(state, inputs);
    for (const s of out.settlements) settle(s);
    for (const e of out.events) book.write({ type: 'event', tick, game: e });
    ticksProcessed++;
  };

  const start = async (): Promise<void> => {
    const warmups = await warmUpSeats(game, opts);
    for (const seat of SEATS) {
      const w = warmups[seat];
      if (!w) continue;
      controllers[seat].lastOkCostUsd = w.record.costUsd;
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
    startMs = clock.now();
  };

  return {
    state,
    controllers,
    get latestDecisions() {
      return book.latestDecisions;
    },
    get done() {
      return result !== null;
    },
    get startMs() {
      return startMs;
    },
    get result() {
      return result;
    },
    start() {
      if (starting) return Promise.reject(new Error('match already started'));
      starting = start();
      return starting;
    },
    nextTickDueMs() {
      if (startMs === null) throw new Error('match not started');
      return startMs + ticksProcessed * tickMs;
    },
    advance(nowMs) {
      if (startMs === null) throw new Error('match not started');
      const lateMs = nowMs - (startMs + ticksProcessed * tickMs);
      if (result === null && lateMs > REALTIME_STALL_MS) {
        stalls.push({ atTick: game.tick(state), gapMs: Math.round(lateMs) });
      }
      while (result === null && startMs + ticksProcessed * tickMs <= nowMs + EPS_MS) {
        if (isOver()) {
          finish();
          break;
        }
        processTick(nowMs);
        if (isOver()) finish();
      }
    },
    abort() {
      for (const c of controllers) c.abort();
    },
  };
}
