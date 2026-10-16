import { formatMs, formatPercent, formatUsd, NONE } from '../../core/stats/format.js';
import type { Leaderboard } from '../../core/stats/leaderboard.js';
import { playerColor } from '../shell/theme.js';

/**
 * What the outro card shows, from `results/leaderboard.json` alone (docs/architecture/core.md,
 * "Video cards"): each model's overall score, and per game its head-to-head win rate, p50 latency
 * and cost per 1,000 decisions.
 * With no head-to-head yet it says "results pending" and still lists the games. Pure (tests).
 */

/** The public repo, as the outro prints it (no scheme, so it reads as text, not a logo). */
export const REPO_URL = 'github.com/Malleable-ai/classifier-arena';
/** Models the outro has columns for: the two in the published results. */
export const OUTRO_MODELS_MAX = 2;

export interface OutroCell {
  /** Head-to-head win rate, "62.5%", or "—". */
  winRate: string;
  /** "p50 210 ms". */
  p50: string;
  /** "$0.020 / 1k". */
  cost: string;
  /** The higher win rate in its row. */
  lead: boolean;
}

export interface OutroGame {
  id: string;
  label: string;
  /** One per model column; a model without numbers here shows dashes. */
  cells: OutroCell[];
  /** No head-to-head in this game yet. */
  pending: boolean;
}

export interface OutroColumn {
  /** The whole label, "OpenAI Decisions (gpt-6-luna)". */
  label: string;
  /** Its two lines: "OpenAI Decisions" and "gpt-6-luna" (empty without a parenthetical). */
  name: string;
  detail: string;
  /** The model's color (theme.ts: Jev teal, OpenAI Decisions amber), its column drawn in it. */
  color: string;
  overall: string;
  lead: boolean;
}

export interface OutroModel {
  /** No head-to-head in any game yet. */
  pending: boolean;
  /** Model columns (plain-text labels), best overall first. */
  models: OutroColumn[];
  games: OutroGame[];
  /** What the numbers are, one line. */
  legend: string;
  url: string;
}

export const OUTRO_LEGEND =
  'Head-to-head win rate (a draw counts ½) · p50 latency · cost per 1,000 decisions';
export const PENDING_LEGEND = 'Every match replays from its log in the repo';

/** "OpenAI Decisions (gpt-6-luna)" → { name: "OpenAI Decisions", detail: "gpt-6-luna" }. */
export function splitLabel(label: string): { name: string; detail: string } {
  const m = /^(.*?)\s*\(([^()]*)\)\s*$/.exec(label.trim());
  return m === null || (m[1] ?? '') === ''
    ? { name: label.trim(), detail: '' }
    : { name: m[1] ?? '', detail: m[2] ?? '' };
}

/** Index of the single highest value, or −1 when there is none or it is tied. */
function leader(values: readonly (number | null)[]): number {
  let best = -1;
  let tie = false;
  for (const [i, v] of values.entries()) {
    if (v === null) continue;
    const b = best === -1 ? null : (values[best] ?? null);
    if (b === null || v > b) {
      best = i;
      tie = false;
    } else if (v === b) tie = true;
  }
  return tie ? -1 : best;
}

export function outroModel(
  lb: Leaderboard | null,
  games: readonly { id: string; label: string }[],
): OutroModel {
  const rows = (lb?.models ?? []).slice(0, OUTRO_MODELS_MAX);
  const anyHeadToHead = rows.some((m) => m.games.some((g) => g.headToHead !== null));
  const gameList = lb?.games.map((g) => ({ id: g.id, label: g.label })) ?? [...games];

  if (!anyHeadToHead) {
    return {
      pending: true,
      models: [],
      games: gameList.map((g) => ({ ...g, cells: [], pending: true })),
      legend: PENDING_LEGEND,
      url: REPO_URL,
    };
  }

  const overallLead = leader(rows.map((m) => m.overall));
  return {
    pending: false,
    models: rows.map((m, i) => ({
      label: m.label,
      ...splitLabel(m.label),
      color: playerColor(m.player, i === 0 ? 0 : 1),
      overall: formatPercent(m.overall),
      lead: i === overallLead,
    })),
    games: gameList.map((g) => {
      const cells = rows.map((m) => m.games.find((c) => c.game === g.id) ?? null);
      const rates = cells.map((c) => c?.headToHead?.winRate.p ?? null);
      const lead = leader(rates);
      return {
        ...g,
        pending: rates.every((r) => r === null),
        cells: cells.map((c, i) => ({
          winRate: formatPercent(rates[i] ?? null),
          p50: `p50 ${formatMs(c?.latencyMs.p50 ?? null)}`,
          cost:
            c?.costPer1000 === null || c === null
              ? `${NONE} / 1k`
              : `${formatUsd(c.costPer1000)} / 1k`,
          lead: i === lead,
        })),
      };
    }),
    legend: OUTRO_LEGEND,
    url: REPO_URL,
  };
}
