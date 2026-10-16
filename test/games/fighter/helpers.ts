import type { Decider } from '../../../src/core/classifier/types.js';
import type { DecisionLine, EventLine, LogLine } from '../../../src/core/log/schema.js';
import { createRealtimeRunner, type RealtimeRunner } from '../../../src/core/sched/realtime.js';
import type { SeatMeta } from '../../../src/core/sched/shared.js';
import type { EngineConfig, MatchState } from '../../../src/games/fighter/engine/types.js';
import { fighterGame } from '../../../src/games/fighter/game.js';
import {
  COMMON,
  SimClock,
  baselineMeta,
  decisionsOf,
  memorySink,
  settleOnSim,
} from '../../core/sched/helpers.js';

/** A fighter match on the core real-time scheduler, started on a SimClock, stepped by hand. */
export interface FighterHarness {
  clock: SimClock;
  runner: RealtimeRunner<MatchState>;
  lines: LogLine[];
  /** Process ticks until `state.tick` reaches `tick` (or the match ends). */
  runUntilTick(tick: number): Promise<void>;
  decisions(seat?: 0 | 1): DecisionLine[];
  events(): EventLine[];
}

export async function fighterHarness(
  a: (clock: SimClock) => Decider,
  b: (clock: SimClock) => Decider,
  opts: { seed?: number; seats?: [SeatMeta, SeatMeta]; config?: Partial<EngineConfig> } = {},
): Promise<FighterHarness> {
  const clock = new SimClock();
  const sink = memorySink();
  const runner = createRealtimeRunner({
    game: fighterGame,
    seed: opts.seed ?? 7,
    config: { ...fighterGame.defaultConfig, ...opts.config },
    seats: opts.seats ?? [baselineMeta(), baselineMeta()],
    deciders: [a(clock), b(clock)],
    clock,
    sink,
    ...COMMON,
  });
  // Warm-ups sleep on the SimClock; keep advancing until start resolves.
  await settleOnSim(clock, runner.start());
  return {
    clock,
    runner,
    lines: sink.lines,
    async runUntilTick(tick) {
      while (!runner.done && runner.state.tick < tick) {
        await clock.advanceTo(runner.nextTickDueMs());
        runner.advance(clock.now());
      }
    },
    decisions: (seat) => decisionsOf(sink.lines, seat),
    events: () => sink.lines.filter((l): l is EventLine => l.type === 'event'),
  };
}
