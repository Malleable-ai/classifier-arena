import { createRandomDecider, randomDeciderSeed } from '../../core/classifier/random.js';
import {
  createRemoteDecider,
  type EstimateResponse,
  type PlayersResponse,
} from '../../core/classifier/remote.js';
import type { Decider, Seat } from '../../core/classifier/types.js';
import type { Game, RealtimeGame, RealtimeInput } from '../../core/game.js';
import type { DecisionLine, HeaderLine, LogLine, MatchEndLine } from '../../core/log/schema.js';
import { NO_EXCLUSIONS } from '../../core/results/excluded.js';
import type { RealtimeRunner } from '../../core/sched/realtime.js';
import { invalidReasonText, invalidReasonsOfLog } from '../../core/sched/validity.js';
import type { TurnRunner } from '../../core/sched/turns.js';
import type { Clock } from '../../core/util/clock.js';
import { createPrng } from '../../core/util/prng.js';

/**
 * Live mode's DOM-free logic: the game picker, the proxy URLs (always with `?game=`), which players
 * can be picked, the cost gate, the deciders per seat, and the step tap that lets a renderer see
 * each simulated tick.
 */

export type LivePlayer = PlayersResponse['players'][number];

export interface GameOption {
  value: string;
  label: string;
}

/** The games live mode can play: registered and drawable (a renderer exists). */
export function liveGames(
  games: readonly Pick<Game, 'id' | 'label'>[],
  hasRenderer: (id: string) => boolean,
): GameOption[] {
  return games.filter((g) => hasRenderer(g.id)).map((g) => ({ value: g.id, label: g.label }));
}

/** `GET /players?game=<id>`: providers plus that game's baselines. */
export function playersPath(game: string): string {
  return `/players?game=${encodeURIComponent(game)}`;
}

/** `GET /estimate?game=<id>&a=<player>&b=<player>`. */
export function estimatePath(game: string, a: string, b: string): string {
  const q = new URLSearchParams({ game, a, b });
  return `/estimate?${q.toString()}`;
}

export interface PlayerOption {
  value: string;
  label: string;
  disabled: boolean;
}

/** One option per player; providers whose keys aren't set are listed but disabled. */
export function playerOptions(players: readonly LivePlayer[]): PlayerOption[] {
  return players.map((p) => ({
    value: p.id,
    label:
      p.kind === 'provider' && !p.available
        ? `${p.label} (keys not set: ${(p.missingEnv ?? []).join(', ')})`
        : p.kind === 'provider'
          ? `${p.label} (paid API)`
          : p.label,
    disabled: !p.available,
  }));
}

/** The pair picked when a game is chosen: a human vs the scripted bot where the game has them. */
export function defaultPicks(players: readonly LivePlayer[]): [string, string] {
  const has = (id: string): boolean => players.some((p) => p.id === id && p.available);
  return [has('human') ? 'human' : 'random', has('scripted') ? 'scripted' : 'random'];
}

export interface Gate {
  canStart: boolean;
  /** A paid provider plays: the estimate must be shown and confirmed. */
  paid: boolean;
  /** Paid and under the limit: the confirm box is shown. */
  needsConfirm: boolean;
  message: string;
}

const usd = (n: number): string => `$${n.toFixed(n < 0.1 ? 4 : 2)}`;

/**
 * Whether a match may start. Baselines and human are free. A paid provider needs the estimate
 * loaded, at most `limitUsd` worst case (RULES.md: never above $5 from the UI) and an explicit
 * confirm.
 */
export function startGate(
  players: readonly LivePlayer[],
  a: string,
  b: string,
  estimate: EstimateResponse | null,
  confirmed: boolean,
): Gate {
  const blocked = (message: string): Gate => ({
    canStart: false,
    paid: false,
    needsConfirm: false,
    message,
  });
  const pa = players.find((p) => p.id === a);
  const pb = players.find((p) => p.id === b);
  if (!pa || !pb) return blocked('Pick two players.');
  for (const p of [pa, pb]) {
    if (!p.available) return blocked(`${p.label} has no keys set in .env.`);
  }
  if (a === 'human' && b === 'human') return blocked('Only one side can be human (one keyboard).');
  const paid = pa.kind === 'provider' || pb.kind === 'provider';
  if (!paid)
    return { canStart: true, paid, needsConfirm: false, message: 'Free: no paid API calls.' };
  if (estimate === null) {
    return { canStart: false, paid, needsConfirm: false, message: 'Estimating cost…' };
  }
  const range = `${usd(estimate.typicalUsd)} typical, ${usd(estimate.totalUsd)} worst case`;
  if (estimate.totalUsd > estimate.limitUsd) {
    return {
      canStart: false,
      paid,
      needsConfirm: false,
      message: `Estimated ${range}: over the $${String(estimate.limitUsd)} limit. Live mode won't run it.`,
    };
  }
  return {
    canStart: confirmed,
    paid,
    needsConfirm: true,
    message: `This match calls a paid API: about ${range}.`,
  };
}

export interface EstimateCache {
  /** The estimate for this exact game and pair, or null while it hasn't loaded. */
  get(game: string, a: string, b: string): EstimateResponse | null;
  /** Loads once per game and pair (in-flight requests are shared); a failure is forgotten. */
  load(game: string, a: string, b: string): Promise<EstimateResponse>;
}

/**
 * Cost estimates keyed by game and pair. The page always reads the estimate for what is selected
 * now, so a slow answer for another pair (or game) can't stick the gate on "Estimating cost…" or
 * show the wrong cost.
 */
export function createEstimateCache(
  fetchEstimate: (game: string, a: string, b: string) => Promise<EstimateResponse>,
): EstimateCache {
  const done = new Map<string, EstimateResponse>();
  const pending = new Map<string, Promise<EstimateResponse>>();
  const key = (game: string, a: string, b: string): string => `${game}:${a}+${b}`;
  return {
    get: (game, a, b) => done.get(key(game, a, b)) ?? null,
    load(game, a, b) {
      const k = key(game, a, b);
      const hit = done.get(k);
      if (hit) return Promise.resolve(hit);
      let p = pending.get(k);
      if (!p) {
        p = fetchEstimate(game, a, b).then(
          (e) => {
            done.set(k, e);
            pending.delete(k);
            return e;
          },
          (err: unknown) => {
            pending.delete(k);
            throw err;
          },
        );
        pending.set(k, p);
      }
      return p;
    },
  };
}

/** One match at a time: taken synchronously when Start (or Rematch) is clicked. */
export interface RunLatch {
  readonly busy: boolean;
  tryEnter(): boolean;
  leave(): void;
}

export function createRunLatch(): RunLatch {
  let busy = false;
  return {
    get busy() {
      return busy;
    },
    tryEnter() {
      if (busy) return false;
      busy = true;
      return true;
    },
    leave() {
      busy = false;
    },
  };
}

/** Human decisions are logged with latency 0: the wait is the player's, not an API's. */
export function withZeroLatency(decider: Decider): Decider {
  return {
    player: decider.player,
    async decide(state, question, signal, ctx) {
      const r = await decider.decide(state, question, signal, ctx);
      return { ...r, latencyMs: 0 };
    },
  };
}

export interface LiveDeciderOptions {
  /** The player id on this seat. */
  id: string;
  seat: Seat;
  game: Game;
  players: readonly LivePlayer[];
  /** The match seed: baselines get the seat's own PRNG from it, never the game's. */
  seed: number;
  matchId: string;
  clock: Clock;
  /** The keyboard's input source for a `human` seat (the renderer's `human().input`). */
  humanInput?: unknown;
  /** Builds a provider's decider; default the proxy (`createRemoteDecider`) with `game`. */
  remote?: (player: string, seat: Seat) => Decider;
}

/**
 * A seat's decider: `random` from core, the game's own baselines (`human` with the keyboard and
 * latency 0), or a provider through the proxy, which is sent the game id and writes snapshots for
 * this match and seat.
 */
export function liveDecider(o: LiveDeciderOptions): Decider {
  const prng = createPrng(randomDeciderSeed(o.seed, o.seat));
  if (o.id === 'random') return createRandomDecider({ prng, clock: o.clock });
  if (o.game.baselines.includes(o.id)) {
    if (!o.game.createBaseline) throw new Error(`${o.game.id} cannot build baseline "${o.id}"`);
    const decider = o.game.createBaseline(o.id, {
      clock: o.clock,
      prng,
      ...(o.humanInput === undefined ? {} : { extra: { humanInput: o.humanInput } }),
    });
    return o.id === 'human' ? withZeroLatency(decider) : decider;
  }
  const player = o.players.find((p) => p.id === o.id);
  if (player?.kind !== 'provider') throw new Error(`unknown player ${o.id} for ${o.game.id}`);
  if (o.remote) return o.remote(o.id, o.seat);
  return createRemoteDecider({
    player: o.id,
    game: o.game.id,
    snapshot: { matchId: o.matchId, seat: o.seat },
  });
}

export type StepTap<S> = (
  before: S,
  inputs: readonly [RealtimeInput | null, RealtimeInput | null],
  after: S,
) => void;

/**
 * `game` with `tap` called after every `step` (with a clone of the state before it). Display only:
 * the game's own `step` runs unchanged and its result is returned as is, so the match is the same.
 */
export function tapSteps<S, C>(game: RealtimeGame<S, C>, tap: StepTap<S>): RealtimeGame<S, C> {
  return {
    ...game,
    step(state, inputs) {
      const before = game.clone(state);
      const out = game.step(state, inputs);
      tap(before, inputs, state);
      return out;
    },
  };
}

/** How a live match ends: once, either way. */
export interface LiveDriveHooks {
  onDone(): void;
  /**
   * The runner threw (a game bug, e.g. a settlement that matches no answer). The match has stopped
   * and its requests in flight are aborted; no match_end is written.
   */
  onError(err: unknown): void;
}

export interface LiveRealtimeDriveOptions extends LiveDriveHooks {
  now(): number;
  /** Runs `fn` later (the page: a ~4 ms timer). */
  schedule(fn: () => void): void;
  /** Called before each `advance` (the page pumps a human seat's keys here). */
  beforeAdvance?(): void;
}

/**
 * Advance a real-time runner on `schedule` until it is done. If a step throws, the loop stops,
 * the runner's requests in flight are aborted and `onError` gets the error, so the page can say
 * so and free the run latch instead of hanging.
 */
export function driveLiveRealtime(
  runner: Pick<RealtimeRunner<unknown>, 'advance' | 'abort' | 'done'>,
  opts: LiveRealtimeDriveOptions,
): void {
  const step = (): void => {
    try {
      opts.beforeAdvance?.();
      runner.advance(opts.now());
    } catch (err) {
      runner.abort();
      opts.onError(err);
      return;
    }
    if (runner.done) opts.onDone();
    else opts.schedule(step);
  };
  step();
}

/** Run a turn runner; a rejected `run()` aborts the requests in flight and goes to `onError`. */
export function driveLiveTurns(
  runner: Pick<TurnRunner<unknown>, 'run' | 'abort'>,
  hooks: LiveDriveHooks,
): void {
  runner.run().then(
    () => {
      hooks.onDone();
    },
    (err: unknown) => {
      runner.abort();
      hooks.onError(err);
    },
  );
}

/** The status line for a match that stopped on an error (and the log's own error, if any). */
export function matchErrorMessage(err: unknown, logError: string | null = null): string {
  const why = err instanceof Error ? err.message : String(err);
  const line = `Match stopped: ${why}. The log was kept without a match_end.`;
  return logError === null ? line : `${line} ${logError}.`;
}

/**
 * What the result line adds for an invalid match ('' for a valid one), from the match's log lines
 * by the same rule that wrote `match_end.valid`. A stall gets the warning: the machine paused, or
 * the tab went to the background (the browser then runs its timers once a second). Anything else
 * gets its reason (`invalidReasonText`).
 */
export function liveInvalidNote(lines: readonly LogLine[], end: MatchEndLine): string {
  if (end.valid) return '';
  const header = lines.find((l): l is HeaderLine => l.type === 'header');
  if (header === undefined) return ' · invalid';
  const decisions = lines.filter((l): l is DecisionLine => l.type === 'decision');
  const reasons = invalidReasonsOfLog({ header, decisions, matchEnd: end }, NO_EXCLUSIONS);
  const stall = reasons.find((r) => r.kind === 'stall');
  if (stall !== undefined) {
    const longest = Math.max(...stall.stalls.map((x) => x.gapMs));
    return (
      ` · invalid: the match stalled (longest ${(longest / 1000).toFixed(1)} s): the tab went to ` +
      'the background or the machine paused. Keep this tab in front and the machine awake.'
    );
  }
  if (reasons.length === 0) return ' · invalid';
  const labels = [header.seats[0].label, header.seats[1].label] as const;
  return ` · invalid: ${reasons.map((r) => invalidReasonText(r, labels)).join('; ')}`;
}
