import type { Leaderboard } from '../../core/stats/leaderboard.js';
import { splitLabel } from './outro-model.js';

/**
 * The intro card's result teaser, from `results/leaderboard.json` alone, computed when the card
 * renders (never written into the card): how many head-to-head matches the leading model won,
 * over every game. Null before any head-to-head, or when the top two models tie overall. Pure
 * (tests).
 */

export interface IntroTeaser {
  /** The leading model's player id (for its color). */
  player: string;
  /** "Jev won 130 of 160 head-to-head matches (81%)". */
  text: string;
}

export function introTeaser(lb: Leaderboard | null): IntroTeaser | null {
  const [top, next] = lb?.models ?? [];
  if (top === undefined || top.overall === null) return null;
  if (next !== undefined && next.overall !== null && next.overall >= top.overall) return null;
  let matches = 0;
  let wins = 0;
  let draws = 0;
  for (const g of top.games) {
    if (g.headToHead === null) continue;
    matches += g.headToHead.matches;
    wins += g.headToHead.wins;
    draws += g.headToHead.draws;
  }
  if (matches === 0) return null;
  const name = splitLabel(top.label).name;
  const pct = `${String(Math.round(((wins + draws / 2) / matches) * 100))}%`;
  const record =
    draws === 0
      ? `won ${String(wins)} of ${String(matches)}`
      : `won ${String(wins)} and drew ${String(draws)} of ${String(matches)}`;
  return { player: top.player, text: `${name} ${record} head-to-head matches (${pct})` };
}
