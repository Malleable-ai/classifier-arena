/**
 * Clocks for the match loop. `realClock` paces live matches; `SimClock` is a manual clock for
 * tests and offline baseline matches (`pnpm match -- --sim`). Both are DOM-free. `realClock`
 * reads wall time and timers, so it is exempt from src/core's purity rules.
 */

/** The minimal clock deciders and schedulers need. */
export interface Clock {
  now(): number;
  /** Resolves after `ms`; rejects if `signal` aborts first. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('aborted');
}

export const realClock: Clock = {
  now: () => performance.now(),
  sleep(ms, signal) {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortReason(signal));
        return;
      }
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(abortReason(signal as AbortSignal));
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  },
};

interface Sleeper {
  due: number;
  order: number;
  resolve: () => void;
}

/** Flush promise continuations without a timer turn (cheap; enough for short await chains). */
async function flushMicrotasks(rounds = 50): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

/**
 * A manual clock. `sleep` registers a sleeper; `advance(ms)` moves time forward, waking sleepers
 * in due order (ties in registration order), setting `now()` to each sleeper's due time before it
 * wakes and letting its continuation run before the next one wakes.
 */
export class SimClock implements Clock {
  private t: number;
  private seq = 0;
  private sleepers: Sleeper[] = [];

  constructor(start = 0) {
    this.t = start;
  }

  now(): number {
    return this.t;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortReason(signal));
        return;
      }
      const sleeper: Sleeper = {
        due: this.t + Math.max(0, ms),
        order: this.seq++,
        resolve: () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        },
      };
      const onAbort = (): void => {
        this.sleepers = this.sleepers.filter((s) => s !== sleeper);
        reject(abortReason(signal as AbortSignal));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.sleepers.push(sleeper);
    });
  }

  /** The earliest pending sleeper's due time, or null. */
  nextDue(): number | null {
    let best: number | null = null;
    for (const s of this.sleepers) if (best === null || s.due < best) best = s.due;
    return best;
  }

  /** Move time forward by `ms`, waking every sleeper due by then. */
  async advance(ms: number): Promise<void> {
    await this.advanceTo(this.t + Math.max(0, ms));
  }

  async advanceTo(target: number): Promise<void> {
    await flushMicrotasks();
    for (;;) {
      let next: Sleeper | null = null;
      for (const s of this.sleepers) {
        if (s.due > target) continue;
        if (next === null || s.due < next.due || (s.due === next.due && s.order < next.order)) {
          next = s;
        }
      }
      if (next === null) break;
      const woken = next;
      this.sleepers = this.sleepers.filter((s) => s !== woken);
      this.t = Math.max(this.t, woken.due);
      woken.resolve();
      await flushMicrotasks();
    }
    this.t = Math.max(this.t, target);
  }
}
