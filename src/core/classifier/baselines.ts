import type { GameCommon } from '../game.js';
import type { PlayerId } from './types.js';

/**
 * Baselines as listed and logged: core's `random` plus a game's own, each with its display label.
 * Kept apart from players.ts (which builds deciders and knows the providers) so the web build can
 * name baselines without pulling in the provider registry.
 */

/** A baseline player as listed: its id and label. */
export interface BaselineInfo {
  id: PlayerId;
  label: string;
}

/** The one baseline every game gets from core. Games add their own (e.g. scripted, human). */
export const RANDOM_BASELINE: BaselineInfo = { id: 'random', label: 'Random (uniform)' };

/**
 * A game's baselines: `random` from core, then the game's own ids, labelled from
 * `game.baselineLabels` (an id without a label is shown as itself). Every place that names a
 * baseline gets its label here: match headers, the CLI, the proxy's `/players` (so live mode) and
 * the history page.
 */
export function gameBaselines(
  game: Pick<GameCommon<unknown, unknown>, 'baselines' | 'baselineLabels'>,
): BaselineInfo[] {
  const labels = game.baselineLabels ?? {};
  return [
    RANDOM_BASELINE,
    ...game.baselines.map((id) => ({
      id,
      label: (Object.hasOwn(labels, id) ? labels[id] : undefined) ?? id,
    })),
  ];
}
