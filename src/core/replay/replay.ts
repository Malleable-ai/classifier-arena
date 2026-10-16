import type { Seat } from '../classifier/types.js';
import {
  isRealtime,
  type GameEvent,
  type RealtimeGame,
  type RealtimeInput,
  type TurnAnswer,
  type TurnGame,
} from '../game.js';
import type { MatchLog } from '../log/read.js';
import type { DecisionLine } from '../log/schema.js';

/**
 * Replays, generic over the game contract (docs/architecture/core.md, "Replay"). The header's seed
 * and config plus the logged decisions rebuild a match tick by tick (real-time) or turn by turn:
 * `replayLog` checks the result against `match_end.finalStateHash`, and `createReplayCursor` gives
 * random access for the viewer and render mode. Node- and DOM-free.
 *
 * - Real-time: every decision line with a non-null `appliedTick` is fed to `step` on that tick as
 *   `{ choice, questionKey }`, `dropped` ones included (the game re-derives the drop, and a
 *   dropped input still superseded whatever was waiting before it). If a seat has several lines
 *   on one tick, the last in log order wins.
 * - Turns: on turn t each seat's line for t becomes `{ choice, latencyMs }` when its status is
 *   `ok`, else null (a miss), exactly what the turn scheduler passed to `applyTurn`.
 */

/** Re-sim checkpoints for `seek`: one cloned state every this many ticks (or turns). */
export const KEYFRAME_TICKS = 600;

type AnyGame<S, C> = RealtimeGame<S, C> | TurnGame<S, C>;

/**
 * A replay only reproduces the match on the game (and game version) that recorded it: a rule
 * change bumps the version and would silently replay a different match. Throws a clear error.
 */
export function assertReplayable<S, C>(log: MatchLog, game: AnyGame<S, C>): void {
  const h = log.header;
  if (h.game !== game.id) {
    throw new Error(`match log is for game "${h.game}", not "${game.id}"`);
  }
  if (h.gameVersion !== game.version) {
    throw new Error(
      `match log was recorded with ${game.id} version ${String(h.gameVersion)}, but this build ` +
        `runs version ${String(game.version)}; it cannot be replayed`,
    );
  }
  const logged = h.cadence;
  const ours = game.cadence;
  const same =
    logged.kind === ours.kind &&
    (logged.kind !== 'realtime' || ours.kind !== 'realtime' || logged.tickRate === ours.tickRate);
  if (!same) {
    throw new Error(
      `match log cadence ${JSON.stringify(logged)} does not match ${game.id}'s ` +
        `${JSON.stringify(ours)}; it cannot be replayed`,
    );
  }
}

/** The tick a decision line's outcome became known: when it was fed, else when it arrived. */
export function resolvedTick(d: DecisionLine, tickRate: number): number {
  return d.appliedTick ?? d.sentTick + Math.ceil((d.latencyMs * tickRate) / 1000);
}

/** Per-cadence driving, so the replay and the cursor share one loop. */
interface Driver<S> {
  create(): S;
  clone(s: S): S;
  hash(s: S): string;
  /** Ticks simulated (real-time) or turns played. */
  at(s: S): number;
  /** Over, or at the game's tick/turn cap. */
  done(s: S): boolean;
  /** One tick or turn; returns its events. */
  advance(s: S): GameEvent[];
  /** The tick (real-time) or turn count (turns) by which a decision line is resolved. */
  resolvedAt(d: DecisionLine): number;
}

type Pair<T> = [T | null, T | null];

/** Per tick or turn, per seat, the last value `pick` gives in log order (null: skip the line). */
function bySlot<T>(
  decisions: readonly DecisionLine[],
  pick: (d: DecisionLine) => { slot: number; seat: Seat; value: T } | null,
): Map<number, Pair<T>> {
  const out = new Map<number, Pair<T>>();
  for (const d of decisions) {
    const p = pick(d);
    if (p === null) continue;
    let pair = out.get(p.slot);
    if (!pair) {
      pair = [null, null];
      out.set(p.slot, pair);
    }
    pair[p.seat] = p.value;
  }
  return out;
}

function realtimeDriver<S, C>(log: MatchLog, game: RealtimeGame<S, C>): Driver<S> {
  const config = game.configFromLog(log.header.config);
  const maxTicks = game.maxTicks(config);
  const { tickRate } = game.cadence;
  const inputs = bySlot<RealtimeInput>(log.decisions, (d) =>
    d.appliedTick === null || d.choice === null
      ? null
      : {
          slot: d.appliedTick,
          seat: d.seat,
          value: { choice: d.choice, questionKey: d.questionKey },
        },
  );
  const none: Pair<RealtimeInput> = [null, null];
  return {
    create: () => game.create(log.header.seed, config),
    clone: (s) => game.clone(s),
    hash: (s) => game.hash(s),
    at: (s) => game.tick(s),
    done: (s) => game.tick(s) >= maxTicks || game.result(s).over,
    advance: (s) => game.step(s, inputs.get(game.tick(s)) ?? none).events,
    resolvedAt: (d) => resolvedTick(d, tickRate),
  };
}

function turnDriver<S, C>(log: MatchLog, game: TurnGame<S, C>): Driver<S> {
  const config = game.configFromLog(log.header.config);
  const maxTurns = game.maxTurns(config);
  const turnOf = (d: DecisionLine): number => d.appliedTick ?? d.sentTick;
  const answers = bySlot<TurnAnswer | null>(log.decisions, (d) => ({
    slot: turnOf(d),
    seat: d.seat,
    value:
      d.status === 'ok' && d.choice !== null ? { choice: d.choice, latencyMs: d.latencyMs } : null,
  }));
  const none: Pair<TurnAnswer> = [null, null];
  return {
    create: () => game.create(log.header.seed, config),
    clone: (s) => game.clone(s),
    hash: (s) => game.hash(s),
    at: (s) => game.turn(s),
    done: (s) => game.turn(s) >= maxTurns || game.result(s).over,
    advance: (s) => game.applyTurn(s, answers.get(game.turn(s)) ?? none).events,
    // A turn's lines are resolved once that turn has been played.
    resolvedAt: (d) => turnOf(d) + 1,
  };
}

function driverFor<S, C>(log: MatchLog, game: AnyGame<S, C>): Driver<S> {
  assertReplayable(log, game);
  return isRealtime(game) ? realtimeDriver(log, game) : turnDriver(log, game);
}

export interface ReplayResult<S> {
  /** The state once the game is over (or at its tick/turn cap). */
  state: S;
  hash: string;
  /** True when the log has a match_end and `hash` equals its `finalStateHash`. */
  matches: boolean;
}

export function replayLog<S, C>(log: MatchLog, game: AnyGame<S, C>): ReplayResult<S> {
  const drive = driverFor(log, game);
  const state = drive.create();
  while (!drive.done(state)) drive.advance(state);
  const hash = drive.hash(state);
  return { state, hash, matches: log.matchEnd !== null && log.matchEnd.finalStateHash === hash };
}

export interface ReplayCursor<S> {
  readonly log: MatchLog;
  /** The live replayed state. Read it, don't mutate it; `seek` may replace it. */
  readonly state: S;
  /** Ticks simulated (real-time) or turns played (turns). */
  readonly tick: number;
  /** The last tick or turn (`match_end.totalTicks`, or where the re-sim stops without one). */
  readonly lastTick: number;
  /** Jump to `n` (clamped to [0, lastTick]): re-sim from the nearest keyframe at or before it. */
  seek(n: number): void;
  /** Step forward to `n` (clamped); seeks if `n` is behind the cursor. */
  stepTo(n: number): void;
  /** One tick or turn (no-op at the end). Returns its events. */
  step(): GameEvent[];
  /**
   * Decision lines resolved by tick or turn `n`, in log order: real-time, `resolvedTick ≤ n`;
   * turns, the lines of turns before `n` (the ones played to reach it).
   */
  decisionsUpTo(n: number): DecisionLine[];
  hash(): string;
}

export function createReplayCursor<S, C>(log: MatchLog, game: AnyGame<S, C>): ReplayCursor<S> {
  const drive = driverFor(log, game);
  const keyframes = new Map<number, S>([[0, drive.create()]]);
  let state = drive.clone(keyframes.get(0) as S);

  const advance = (): GameEvent[] => {
    if (drive.done(state)) return [];
    const events = drive.advance(state);
    const at = drive.at(state);
    if (at % KEYFRAME_TICKS === 0 && !keyframes.has(at)) keyframes.set(at, drive.clone(state));
    return events;
  };

  const lastTick =
    log.matchEnd?.totalTicks ??
    (() => {
      const probe = drive.create();
      while (!drive.done(probe)) drive.advance(probe);
      return drive.at(probe);
    })();

  const clamp = (n: number): number => Math.max(0, Math.min(lastTick, Math.floor(n)));

  const runTo = (target: number): void => {
    while (drive.at(state) < target && !drive.done(state)) advance();
  };

  const seek = (n: number): void => {
    const target = clamp(n);
    let k = Math.floor(target / KEYFRAME_TICKS) * KEYFRAME_TICKS;
    while (!keyframes.has(k)) k -= KEYFRAME_TICKS;
    const at = drive.at(state);
    // Already between that keyframe and the target: just step on.
    if (!(at >= k && at <= target)) state = drive.clone(keyframes.get(k) as S);
    runTo(target);
  };

  return {
    log,
    get state() {
      return state;
    },
    get tick() {
      return drive.at(state);
    },
    lastTick,
    seek,
    stepTo(n) {
      const target = clamp(n);
      if (target < drive.at(state)) seek(target);
      else runTo(target);
    },
    step: advance,
    decisionsUpTo(n) {
      return log.decisions.filter((d) => drive.resolvedAt(d) <= n);
    },
    hash() {
      return drive.hash(state);
    },
  };
}
