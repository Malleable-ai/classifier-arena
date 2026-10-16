import type { Decider } from '../../core/classifier/types.js';
import { emptyResult } from '../../core/classifier/types.js';
import type { Clock } from '../../core/util/clock.js';
import type { MoveId } from './engine/types.js';

/**
 * A source of human moves. No DOM types here: the web adapts its keyboard state into this (emit
 * on each one-shot press or hold change), so Node-run code can import this file.
 */
export interface HumanInput {
  /** Subscribe to moves as the player makes them; returns an unsubscribe function. */
  onMove(listener: (move: MoveId) => void): () => void;
}

export interface HumanDeciderOptions {
  input: HumanInput;
  clock: Clock;
}

/** Resolves with the next move the player inputs, or a timeout when `signal` aborts. */
export function createHumanDecider({ input, clock }: HumanDeciderOptions): Decider {
  return {
    player: 'human',
    decide(_state, _question, signal) {
      const start = clock.now();
      if (signal.aborted) return Promise.resolve(emptyResult('timeout', 0));
      return new Promise((resolve) => {
        const subscription: { unsubscribe?: () => void; done: boolean } = { done: false };
        const finish = (move: MoveId | null) => {
          if (subscription.done) return;
          subscription.done = true;
          subscription.unsubscribe?.();
          signal.removeEventListener('abort', onAbort);
          resolve(emptyResult(move === null ? 'timeout' : 'ok', clock.now() - start, move));
        };
        const onAbort = () => {
          finish(null);
        };
        signal.addEventListener('abort', onAbort, { once: true });
        const unsubscribe = input.onMove((move) => {
          finish(move);
        });
        // A source that emits synchronously on subscribe has already finished us.
        if (subscription.done) unsubscribe();
        else subscription.unsubscribe = unsubscribe;
      });
    },
  };
}
