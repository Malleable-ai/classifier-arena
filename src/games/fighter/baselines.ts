import { BASELINE_DELAY_MS } from '../../core/classifier/random.js';
import type { Decider } from '../../core/classifier/types.js';
import { emptyResult } from '../../core/classifier/types.js';
import type { BaselineDeps } from '../../core/game.js';
import type { Clock } from '../../core/util/clock.js';
import type { MoveId } from './engine/types.js';
import { createHumanDecider, type HumanInput } from './human.js';
import type { View } from './view.js';

/**
 * The fighter's baselines besides core's `random`: its scripted bot and the human player (live
 * mode, keyboard). `fighterGame.createBaseline` builds them; a human needs its input source in
 * `deps.extra.humanInput`.
 */

/** The fighter's own baseline ids (`fighterGame.baselines`). */
export const FIGHTER_BASELINE_IDS = ['scripted', 'human'] as const;

/** Their display labels (`fighterGame.baselineLabels`): match headers, the CLI and the UI. */
export const FIGHTER_BASELINE_LABELS: Readonly<
  Record<(typeof FIGHTER_BASELINE_IDS)[number], string>
> = {
  scripted: 'Scripted bot',
  human: 'Human (live mode)',
};

const STRIKES: ReadonlySet<string> = new Set([
  'jab',
  'heavy_punch',
  'sweep',
  'uppercut',
  'jump_in',
]);

/**
 * The scripted baseline. Uses only the View (what a model sees), first matching rule wins:
 * 1. opponent fireball arriving in < 25 ticks → jump_in
 * 2. opponent airborne and close → uppercut
 * 3. opponent sweeping (startup or active) → block_low
 * 4. opponent striking (startup or active) → block_high
 * 5. opponent blocking and close → throw
 * 6. far and fireball ready → fireball
 * 7. mid → walk_forward
 * 8. close → jab
 * otherwise (far, fireball not ready) → walk_forward
 */
export function scriptedMove(view: View): MoveId {
  const opp = view.opponent;
  const close = view.range === 'close';
  const attacking = opp.phase === 'startup' || opp.phase === 'active';
  if (view.opponent_fireball !== null && view.opponent_fireball.ticks_to_hit < 25) return 'jump_in';
  if (opp.airborne && close) return 'uppercut';
  if (attacking && opp.action === 'sweep') return 'block_low';
  if (attacking && STRIKES.has(opp.action)) return 'block_high';
  if ((opp.action === 'block_high' || opp.action === 'block_low') && close) return 'throw';
  if (view.range === 'far' && view.you.fireball_ready) return 'fireball';
  if (view.range === 'mid') return 'walk_forward';
  if (close) return 'jab';
  return 'walk_forward';
}

export interface ScriptedDeciderOptions {
  delayMs?: number;
  clock: Clock;
}

/** The fighter's scripted bot. `state` is the fighter `View` the scheduler sends every decider. */
export function createScriptedDecider({
  delayMs = BASELINE_DELAY_MS,
  clock,
}: ScriptedDeciderOptions): Decider {
  return {
    player: 'scripted',
    async decide(state, _question, signal) {
      const start = clock.now();
      try {
        await clock.sleep(delayMs, signal);
      } catch {
        return emptyResult('timeout', clock.now() - start);
      }
      return emptyResult('ok', clock.now() - start, scriptedMove(state as View));
    },
  };
}

function isHumanInput(x: unknown): x is HumanInput {
  return (
    typeof x === 'object' && x !== null && typeof (x as { onMove?: unknown }).onMove === 'function'
  );
}

/** `fighterGame.createBaseline`: `scripted`, or `human` with `deps.extra.humanInput`. */
export function createFighterBaseline(id: string, deps: BaselineDeps): Decider {
  const { clock, delayMs } = deps;
  if (id === 'scripted') {
    return createScriptedDecider(delayMs === undefined ? { clock } : { clock, delayMs });
  }
  if (id === 'human') {
    const input = deps.extra?.['humanInput'];
    if (!isHumanInput(input)) throw new Error('human player needs deps.extra.humanInput');
    return createHumanDecider({ input, clock });
  }
  throw new Error(`fighter has no baseline "${id}"`);
}
