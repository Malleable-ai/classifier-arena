import { createRandomDecider, randomDeciderSeed } from '../../../src/core/classifier/random.js';
import type { Decider, Seat } from '../../../src/core/classifier/types.js';
import type { RealtimeGame } from '../../../src/core/game.js';
import type { HeaderLine, LogLine, MatchLogSink } from '../../../src/core/log/schema.js';
import { createRealtimeRunner } from '../../../src/core/sched/realtime.js';
import { createTurnRunner } from '../../../src/core/sched/turns.js';
import { SimClock } from '../../../src/core/util/clock.js';
import { createPrng } from '../../../src/core/util/prng.js';
import {
  counterRealtime,
  type CounterRealtimeConfig,
  type CounterRealtimeState,
  type CounterRealtimeView,
} from '../games/counter-realtime.js';
import {
  counterTurns,
  type CounterTurnsConfig,
  type CounterTurnsView,
} from '../games/counter-turns.js';
import {
  COMMON,
  baselineMeta,
  fakeDecider,
  memorySink,
  providerMeta,
  settleOnSim,
} from '../sched/helpers.js';

/**
 * Real v2 logs for the log, replay and results tests: the two counter games run through the real
 * schedulers on a SimClock with seeded deciders. Seat 0 is the seeded `random` baseline; seat 1 is
 * a fake provider (warm-up, price, costs) that answers right after a varying delay and times out
 * every few requests, so the logs hold ok, dropped (real-time) and timeout lines.
 */

export interface RunOptions<C> {
  seed: number;
  config?: C;
  matchId?: string;
  /** Extra sink to tee every line into (e.g. a JSONL file). */
  sink?: MatchLogSink;
  /** Real-time only: called before every tick with the state it starts from (do not mutate it). */
  beforeStep?: (before: Readonly<CounterRealtimeState>) => void;
}

const random = (seed: number, seat: Seat, clock: SimClock): Decider =>
  createRandomDecider({ prng: createPrng(randomDeciderSeed(seed, seat)), clock });

const tee = (a: MatchLogSink, b: MatchLogSink | undefined): MatchLogSink =>
  b === undefined
    ? a
    : {
        write(line) {
          a.write(line);
          b.write(line);
        },
      };

/** The fake provider's script: right answers, a timeout every 9th request (warm-up is n = 0). */
const realtimeScript = (n: number) =>
  n % 9 === 4
    ? { latencyMs: 1_500 }
    : {
        latencyMs: 90 + ((n * 53) % 400),
        costUsd: 0.001,
        inputTokens: 120,
        choice: (state: unknown) =>
          ((state as CounterRealtimeView).target ?? 0) % 2 === 0 ? 'up' : 'down',
      };

export async function realtimeLines(opts: RunOptions<CounterRealtimeConfig>): Promise<LogLine[]> {
  const clock = new SimClock();
  const sink = memorySink();
  const { beforeStep } = opts;
  const game: RealtimeGame<CounterRealtimeState, CounterRealtimeConfig> =
    beforeStep === undefined
      ? counterRealtime
      : {
          ...counterRealtime,
          step(state, inputs) {
            beforeStep(state);
            return counterRealtime.step(state, inputs);
          },
        };
  const runnerOpts = {
    ...COMMON,
    game,
    seed: opts.seed,
    config: opts.config ?? counterRealtime.defaultConfig,
    seats: [baselineMeta('random'), providerMeta('fake_provider')] as const,
    deciders: [
      random(opts.seed, 0, clock),
      fakeDecider(clock, realtimeScript, 'fake_provider'),
    ] as const,
    clock,
    sink: tee(sink, opts.sink),
    ...(opts.matchId === undefined ? {} : { matchId: opts.matchId }),
  };
  const runner = createRealtimeRunner(runnerOpts);
  // The provider seat warms up on the SimClock first (driveRealtime would wait on it forever).
  await settleOnSim(clock, runner.start());
  while (!runner.done) {
    await clock.advanceTo(runner.nextTickDueMs());
    runner.advance(clock.now());
  }
  return sink.lines;
}

const IDS = ['a', 'b', 'c', 'd'] as const;

/** Right answers after a growing delay; every 4th request (from n = 2) times out. */
const turnScript = (n: number) =>
  n % 4 === 2
    ? { latencyMs: 1_500 }
    : {
        latencyMs: 150 + n * 10.37,
        costUsd: 0.002,
        inputTokens: 100,
        choice: (state: unknown) => IDS[((state as CounterTurnsView).target ?? 0) % 4] ?? 'a',
      };

export async function turnLines(opts: RunOptions<CounterTurnsConfig>): Promise<LogLine[]> {
  const clock = new SimClock();
  const sink = memorySink();
  const runner = createTurnRunner({
    ...COMMON,
    game: counterTurns,
    seed: opts.seed,
    config: opts.config ?? counterTurns.defaultConfig,
    seats: [baselineMeta('random'), providerMeta('fake_provider')],
    deciders: [random(opts.seed, 0, clock), fakeDecider(clock, turnScript, 'fake_provider')],
    clock,
    sink: tee(sink, opts.sink),
    ...(opts.matchId === undefined ? {} : { matchId: opts.matchId }),
  });
  await settleOnSim(clock, runner.run());
  return sink.lines;
}

/** Lines as JSONL text (what a log file holds). */
export const toJsonl = (lines: readonly unknown[]): string =>
  lines.map((l) => JSON.stringify(l)).join('\n') + '\n';

/** A line as it reads back from JSON (undefined fields gone). */
export const viaJson = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export function headerOf(lines: readonly LogLine[]): HeaderLine {
  const h = lines[0];
  if (h?.type !== 'header') throw new Error('no header');
  return h;
}
