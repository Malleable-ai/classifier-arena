import { TICK_RATE } from '../../../games/fighter/engine/constants.js';
import { advanceAccumulator, MAX_CATCH_UP } from '../../shell/accumulator.js';

/**
 * The sandbox's fixed-step game loop: requestAnimationFrame drives frames, a 60 Hz accumulator
 * decides how many engine ticks each frame runs (at most `maxCatchUp`; any backlog past that is
 * dropped so a hidden tab doesn't fast-forward the fight when it comes back).
 */

export const TICK_MS = 1000 / TICK_RATE;
export {
  advanceAccumulator,
  MAX_CATCH_UP,
  type AccumulatorResult,
} from '../../shell/accumulator.js';

export interface FixedStepLoopOptions {
  onTick: () => void;
  onFrame: () => void;
  tickMs?: number;
  maxCatchUp?: number;
  /** Injected for tests; default window.requestAnimationFrame. Callback gets a ms timestamp. */
  requestFrame?: (cb: (timeMs: number) => void) => number;
  cancelFrame?: (id: number) => void;
}

export interface FixedStepLoop {
  start(): void;
  stop(): void;
  /** Stop running ticks (frames still draw). */
  pause(): void;
  resume(): void;
  readonly paused: boolean;
  /** Run `n` ticks right now and draw once (works while paused). */
  stepTicks(n: number): void;
}

export function createFixedStepLoop(opts: FixedStepLoopOptions): FixedStepLoop {
  const tickMs = opts.tickMs ?? TICK_MS;
  const maxCatchUp = opts.maxCatchUp ?? MAX_CATCH_UP;
  const requestFrame = opts.requestFrame ?? ((cb) => window.requestAnimationFrame(cb));
  const cancelFrame =
    opts.cancelFrame ??
    ((id) => {
      window.cancelAnimationFrame(id);
    });

  let acc = 0;
  let last: number | null = null;
  let frameId: number | null = null;
  let paused = false;

  const frame = (time: number): void => {
    frameId = requestFrame(frame);
    if (paused || last === null) {
      last = time;
      opts.onFrame();
      return;
    }
    const r = advanceAccumulator(acc, time - last, tickMs, maxCatchUp);
    last = time;
    acc = r.acc;
    for (let i = 0; i < r.ticks; i++) opts.onTick();
    opts.onFrame();
  };

  return {
    start() {
      if (frameId !== null) return;
      last = null;
      acc = 0;
      frameId = requestFrame(frame);
    },
    stop() {
      if (frameId !== null) cancelFrame(frameId);
      frameId = null;
    },
    pause() {
      paused = true;
    },
    resume() {
      paused = false;
      acc = 0;
    },
    get paused() {
      return paused;
    },
    stepTicks(n: number) {
      for (let i = 0; i < Math.max(0, Math.floor(n)); i++) opts.onTick();
      opts.onFrame();
    },
  };
}
