import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { MatchLog } from '../core/log/read.js';
import type { Exclusions } from '../core/results/excluded.js';
import { LEADERBOARD_FILES, RESULTS_DIR, summaryFiles } from '../core/results/paths.js';
import { isValidLog } from '../core/sched/validity.js';
import { buildLeaderboard, type Leaderboard } from '../core/stats/leaderboard.js';
import { leaderboardMarkdown, summaryMarkdown } from '../core/stats/markdown.js';
import { summarizeGame, type GameSummary, type SummaryGame } from '../core/stats/summary.js';
import { GAMES } from '../games/index.js';
import {
  prepareIndex,
  readAllMatchLogs,
  readExclusions,
  readFeatured,
  writeIndex,
  type IndexResultsSummary,
} from './index-results.js';

/**
 * `pnpm leaderboard`: rebuild every game's summary and the leaderboard from the match logs alone
 * (docs/architecture/core.md, "Scores"), then the featured matches and the index.
 *
 *   1. Read every `results/<game>/matches/*.jsonl` (the same scan as `pnpm index-results`) and
 *      `results/excluded.json` (matches excluded by hand; an id that names no log stops the run).
 *   2. Build, in memory, every registered game's summary (empty when it has no logs; a log of a
 *      newer game version than the code stops the run), the leaderboard, the featured matches
 *      and the index (a featured id that isn't a finished, not excluded match stops the run).
 *   3. Only once all of that passed, write `results/<game>/summary.{json,md}`,
 *      `results/leaderboard.{json,md}`, `results/featured.json` and `results/index.json`. A
 *      failure in step 1 or 2 writes nothing, so `results/` is never left half rebuilt.
 *
 * Featured matches (`featuredFor`), recomputed for every game: its closest valid head-to-head.
 * A game with none keeps its current pick only while that is still a valid, finished match of the
 * game's current version (a hand pick made with `pnpm index-results --featured`, such as a
 * baseline match before any head-to-head exists, so the history page has a replay to open);
 * anything else (an invalid, excluded, older-version or missing match) is stale and dropped, and
 * the game has no featured match. Entries for games outside `games` are kept as they are.
 *
 * Every file is a pure function of the logs (no timestamps), so a rerun with no new logs writes
 * the same bytes. `pnpm tournament` runs this after its matches.
 *
 *   pnpm leaderboard                 rebuild under the working directory
 *   pnpm leaderboard --root <dir>    the folder that holds results/
 */

export interface RebuildOptions {
  /** The folder that holds `results/` (default the working directory). */
  root?: string;
  /** The games to summarize, in leaderboard order (default the registry). */
  games?: readonly SummaryGame[];
}

/** What `featuredFor` decided for one game. */
export interface FeaturedChoice {
  game: string;
  /** The featured match id, or null for none. */
  id: string | null;
  /** `head-to-head` (the closest one), `kept` (a current pick, still valid), or `none`. */
  how: 'head-to-head' | 'kept' | 'none';
  /** A current pick dropped as stale, if any. */
  dropped: string | null;
}

export interface RebuildResult {
  summaries: GameSummary[];
  leaderboard: Leaderboard;
  /** Every summary and leaderboard file written, relative to the root, in write order. */
  files: string[];
  /** Per game in `games`, what is featured and why. */
  featured: FeaturedChoice[];
  index: IndexResultsSummary;
}

function writeText(root: string, rel: string, text: string): void {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

const json = (value: unknown): string => JSON.stringify(value, null, 2) + '\n';

/**
 * Each game's featured match (see the module comment): `current` is `results/featured.json`.
 * Returns the new file contents and, per game in `games`, what was chosen.
 */
export function featuredFor(
  games: readonly SummaryGame[],
  summaries: readonly GameSummary[],
  current: Readonly<Record<string, string>>,
  logs: readonly MatchLog[],
  excluded: Exclusions,
): { featured: Record<string, string>; choices: FeaturedChoice[] } {
  const featured = new Map(Object.entries(current));
  const choices = games.map((game, i): FeaturedChoice => {
    const best = summaries[i]?.featured ?? null;
    const pick = Object.hasOwn(current, game.id) ? (current[game.id] ?? null) : null;
    if (best !== null) {
      featured.set(game.id, best.id);
      return { game: game.id, id: best.id, how: 'head-to-head', dropped: null };
    }
    const log = pick === null ? undefined : logs.find((l) => l.header.matchId === pick);
    const stillValid =
      log !== undefined &&
      log.header.game === game.id &&
      log.header.gameVersion === game.version &&
      log.matchEnd !== null &&
      isValidLog(log, excluded);
    if (pick !== null && stillValid) return { game: game.id, id: pick, how: 'kept', dropped: null };
    featured.delete(game.id);
    return { game: game.id, id: null, how: 'none', dropped: pick };
  });
  return { featured: Object.fromEntries(featured), choices };
}

export function rebuildResults(opts: RebuildOptions = {}): RebuildResult {
  const root = opts.root ?? '.';
  const games = opts.games ?? GAMES;
  mkdirSync(join(root, RESULTS_DIR), { recursive: true });

  // 1–2. Read and check everything, and build every file in memory. Nothing is written yet.
  const logs = readAllMatchLogs(root);
  const excluded = readExclusions(root, logs);
  const summaries = games.map((game) =>
    summarizeGame(
      game,
      logs.filter((l) => l.header.game === game.id),
      excluded,
    ),
  );
  const leaderboard = buildLeaderboard(summaries);
  const { featured, choices } = featuredFor(games, summaries, readFeatured(root), logs, excluded);
  const prepared = prepareIndex(root, logs, excluded, featured, 'pnpm leaderboard (featured)');

  // 3. Write.
  const files: string[] = [];
  for (const summary of summaries) {
    const { json: jsonFile, md } = summaryFiles(summary.game);
    writeText(root, jsonFile, json(summary));
    writeText(root, md, summaryMarkdown(summary));
    files.push(jsonFile, md);
  }
  writeText(root, LEADERBOARD_FILES.json, json(leaderboard));
  writeText(root, LEADERBOARD_FILES.md, leaderboardMarkdown(leaderboard));
  files.push(LEADERBOARD_FILES.json, LEADERBOARD_FILES.md);
  const index = writeIndex(root, prepared, true);
  return { summaries, leaderboard, files, featured: choices, index };
}

function main(): void {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((a) => a !== '--'),
    options: { root: { type: 'string' } },
  });
  const out = rebuildResults(values.root === undefined ? {} : { root: values.root });
  for (const [i, s] of out.summaries.entries()) {
    const h2h = s.pairings.filter((p) => p.headToHead).reduce((n, p) => n + p.matches, 0);
    const f = out.featured[i];
    const featured =
      f === undefined || f.id === null
        ? 'none (no valid head-to-head)'
        : f.how === 'kept'
          ? `${f.id} (kept: no valid head-to-head)`
          : f.id;
    console.log(
      `${s.game}: ${String(s.matches.valid)} valid, ${String(s.matches.invalid)} invalid` +
        (s.matches.excluded > 0 ? ` (${String(s.matches.excluded)} excluded by hand)` : '') +
        `, ${String(h2h)} head to head; featured: ${featured}` +
        (f === undefined || f.dropped === null ? '' : `; dropped stale ${f.dropped}`),
    );
  }
  console.log(`wrote ${out.files.join(', ')}`);
  console.log(
    `${out.index.path}: ${String(out.index.matches)} matches, featured: ` +
      (out.index.featured.join(', ') || 'none'),
  );
}

const entry = process.argv[1];
if (entry !== undefined && resolve(entry) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
