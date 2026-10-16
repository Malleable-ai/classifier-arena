import { BASELINE_DELAY_MS } from '../../core/classifier/random.js';
import type { Decider } from '../../core/classifier/types.js';
import { emptyResult } from '../../core/classifier/types.js';
import type { BaselineDeps } from '../../core/game.js';

/**
 * Inbox Invaders' `scripted` baseline (docs/architecture/inbox.md): always the majority class,
 * `legit`, after the same simulated think time as core's `random` (BASELINE_DELAY_MS on the
 * injected clock). It ignores the state, like `random`.
 */
export function createScriptedDecider({
  clock,
  delayMs = BASELINE_DELAY_MS,
}: BaselineDeps): Decider {
  return {
    player: 'scripted',
    async decide(_state, _question, signal) {
      const start = clock.now();
      try {
        await clock.sleep(delayMs, signal);
      } catch {
        return emptyResult('timeout', clock.now() - start);
      }
      return emptyResult('ok', clock.now() - start, 'legit');
    },
  };
}
