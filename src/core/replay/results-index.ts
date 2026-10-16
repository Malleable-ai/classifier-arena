import type { Seat } from '../classifier/types.js';
import { GAME_ID_RE } from '../game.js';
import type { MatchLog } from '../log/read.js';
import type { Exclusions } from '../results/excluded.js';
import { matchFileInResults } from '../results/paths.js';
import { isValidLog } from '../sched/validity.js';

/**
 * `results/index.json` (docs/architecture/core.md, "Results layout"): every finished match of every
 * game, for the history pages. Built by the index-results CLI, which scans
 * `results/<game>/matches/`; this is the pure part.
 */

export interface ResultsIndexEntry {
  id: string;
  game: string;
  /** Path relative to `results/` (`<game>/matches/<id>.jsonl`). */
  file: string;
  /** Player ids, seat 0 then seat 1 (e.g. "jev", "random"). */
  players: [string, string];
  labels: [string, string];
  /** The winning player id, or "draw" (also when match_end has no winner). */
  winner: string;
  winnerSeat: Seat | null;
  scores: [number, number];
  /**
   * Under the current validity rule, recomputed from the log (`isValidLog`), so it can differ
   * from the log's own `match_end.valid` after a rule change. False for an excluded match.
   */
  valid: boolean;
  /** Present when the match is on `results/excluded.json`: the reason it was excluded by hand. */
  excluded?: string;
  featured: boolean;
  seed: number;
  startTime: string;
  /** Real-time: ticks simulated. Turn games: turns played. */
  totalTicks: number;
  finalStateHash: string;
  costUsd: number;
}

export interface ResultsIndex {
  schemaVersion: 2;
  /** Sorted by id (so by start time). */
  matches: ResultsIndexEntry[];
}

/**
 * Each game's featured match, `{ "<game>": "<match id>" }` (`results/featured.json`). Kept apart
 * from the index so the choice survives regenerating it; `pnpm leaderboard` writes it.
 */
export type FeaturedMatches = Readonly<Record<string, string>>;

/** Check a parsed `results/featured.json`: an object of game id → match id. */
export function parseFeatured(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('must be an object of game id to match id');
  }
  const out: Record<string, string> = {};
  for (const [game, id] of Object.entries(value)) {
    if (!GAME_ID_RE.test(game)) throw new Error(`${JSON.stringify(game)} is not a game id`);
    if (typeof id !== 'string' || id === '') {
      throw new Error(`"${game}" must name a match id, got ${JSON.stringify(id)}`);
    }
    out[game] = id;
  }
  return out;
}

/** A featured match that isn't a finished match of its game (stale or misfiled). */
export class FeaturedMatchError extends Error {
  override name = 'FeaturedMatchError';
}

export interface BuildIndexOptions {
  /**
   * Each game's featured match. Each must be a finished match of that game in `logs`, and not
   * excluded.
   */
  featured: FeaturedMatches;
  /**
   * `results/excluded.json`: those matches are indexed as invalid, with their reason. Required, so
   * no caller forgets it (pass NO_EXCLUSIONS where there is no results tree).
   */
  excluded: Exclusions;
}

/** Index the logs that have a match_end (an unfinished run is skipped). */
export function buildResultsIndex(
  logs: readonly MatchLog[],
  opts: BuildIndexOptions,
): ResultsIndex {
  const matches: ResultsIndexEntry[] = [];
  const ids = new Set<string>();
  const featured = new Set(Object.values(opts.featured));
  const { excluded } = opts;
  for (const log of logs) {
    const { header, matchEnd } = log;
    if (matchEnd === null) continue;
    const id = header.matchId;
    if (ids.has(id)) throw new Error(`match "${id}" is listed twice`);
    ids.add(id);
    const [a, b] = header.seats;
    const players: [string, string] = [a.player, b.player];
    const w = matchEnd.winner;
    const winnerSeat = w === 0 || w === 1 ? w : null;
    const reason = excluded.get(id);
    matches.push({
      id,
      game: header.game,
      file: matchFileInResults(header.game, id),
      players,
      labels: [a.label, b.label],
      winner: winnerSeat === null ? 'draw' : players[winnerSeat],
      winnerSeat,
      scores: [matchEnd.scores[0], matchEnd.scores[1]],
      valid: isValidLog(log, excluded),
      ...(reason === undefined ? {} : { excluded: reason }),
      featured: featured.has(id),
      seed: header.seed,
      startTime: header.startTime,
      totalTicks: matchEnd.totalTicks,
      finalStateHash: matchEnd.finalStateHash,
      costUsd: matchEnd.costUsd,
    });
  }
  matches.sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  for (const [game, id] of Object.entries(opts.featured)) {
    const m = matches.find((x) => x.id === id);
    if (!m) {
      throw new FeaturedMatchError(`featured match "${id}" is not among the indexed matches`);
    }
    if (m.game !== game) {
      throw new FeaturedMatchError(`featured match "${id}" is a ${m.game} match, not ${game}`);
    }
    if (m.excluded !== undefined) {
      throw new FeaturedMatchError(`featured match "${id}" is excluded (${m.excluded})`);
    }
  }
  return { schemaVersion: 2, matches };
}
