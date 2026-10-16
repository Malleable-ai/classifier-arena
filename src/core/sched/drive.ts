import type { Clock } from '../util/clock.js';
import { SimClock } from '../util/clock.js';

/** What `driveRealtime` needs from a runner (createRealtimeRunner's result has it). */
export interface PacedRunner {
  start(): Promise<void>;
  advance(nowMs: number): void;
  nextTickDueMs(): number;
  readonly done: boolean;
}

/**
 * Node drivers: `driveRealtime` paces a real-time runner, `driveTurns` runs a turn runner. On a
 * SimClock both move simulated time themselves, so an offline match takes seconds.
 */

/**
 * Node driver for a real-time match: start the runner, then process ticks until the match ends. On
 * a SimClock it jumps simulated time straight to each tick's due time (sleepers wake in order on
 * the way), so an offline match takes seconds. On the real clock it sleeps with setTimeout until a
 * couple of ms before the next tick, then spins on setImmediate so ticks land on time; the
 * accumulator in the runner absorbs any jitter. The browser paces with requestAnimationFrame.
 */
export async function driveRealtime(runner: PacedRunner, clock: Clock): Promise<void> {
  await runner.start();
  if (clock instanceof SimClock) {
    while (!runner.done) {
      await clock.advanceTo(runner.nextTickDueMs());
      runner.advance(clock.now());
    }
    return;
  }
  for (;;) {
    runner.advance(clock.now());
    if (runner.done) return;
    const wait = runner.nextTickDueMs() - clock.now();
    await new Promise<void>((resolve) => {
      if (wait > 2) setTimeout(resolve, wait - 1);
      else setImmediate(resolve);
    });
  }
}

/** What `driveTurns` needs from a runner (createTurnRunner's result has it). */
export interface TurnDrivable<T> {
  run(): Promise<T>;
}

/** Microtask turns `driveTurns` waits with no sleeper due before it calls the run stalled. */
const STALL_ROUNDS = 10_000;

/**
 * Run a turn match to its end. The turn runner waits on the clock (deadlines, the pause between
 * turns, baseline delays), so on a SimClock this moves time from one sleeper to the next until the
 * run settles; it throws if the run stalls with nothing left to wake (a decider waiting on
 * something other than the clock, e.g. a real API on simulated time). On the real clock it just
 * awaits the run.
 */
export async function driveTurns<T>(runner: TurnDrivable<T>, clock: Clock): Promise<T> {
  const run = runner.run();
  if (!(clock instanceof SimClock)) return run;
  let settled = false as boolean;
  const watched = run.finally(() => {
    settled = true;
  });
  watched.catch(() => undefined);
  let idle = 0;
  while (!settled) {
    const due = clock.nextDue();
    if (due === null) {
      await Promise.resolve();
      if (++idle > STALL_ROUNDS) throw new Error('turn match stalled: nothing left to wake');
    } else {
      idle = 0;
      await clock.advanceTo(due);
    }
  }
  return watched;
}
