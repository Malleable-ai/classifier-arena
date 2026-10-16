import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parseMatchLog, type MatchLog } from '../core/log/read.js';
import {
  FeaturedMatchError,
  buildResultsIndex,
  parseFeatured,
  type ResultsIndex,
} from '../core/replay/results-index.js';
import {
  exclusionsOf,
  parseExcluded,
  unknownExcludedIds,
  type ExcludedMatch,
  type Exclusions,
} from '../core/results/excluded.js';
import {
  EXCLUDED_FILE,
  FEATURED_FILE,
  INDEX_FILE,
  RESULTS_DIR,
  matchesDir,
} from '../core/results/paths.js';

/**
 * Regenerate the results index from every game's logs, `results/<game>/matches/*.jsonl`
 * (schema v2). Each game's featured match comes from `results/featured.json`
 * (`{ "<game>": "<match id>" }`, committed), so the choice survives regenerating the index.
 * Matches on `results/excluded.json` (committed) are indexed as invalid, with their reason.
 *
 *   pnpm index-results                      feature what results/featured.json names
 *   pnpm index-results --featured <id>      feature this match for its game (repeatable, one per
 *                                           game) and write it to results/featured.json
 *   pnpm index-results --root <dir>         the folder that holds results/ (default .)
 *   pnpm index-results --out <path>         where to write, relative to the root (default
 *                                           results/index.json, which the web reads)
 */

/** Where the index goes by default: `results/index.json` (INDEX_FILE). */
export const DEFAULT_OUT = INDEX_FILE;

export interface IndexResultsOptions {
  /** The folder that holds `results/` (default: the working directory). */
  root?: string;
  /**
   * Match ids to feature, at most one per game. Each replaces its game's entry in
   * `results/featured.json`, which is written back. Omitted: the file is used as it is.
   */
  featured?: readonly string[];
  /** Where to write, relative to `root` (default DEFAULT_OUT). */
  out?: string;
}

export interface IndexResultsSummary {
  path: string;
  matches: number;
  /** Logs without a match_end (not indexed). */
  skipped: number;
  /** The featured match ids, by game id order. */
  featured: readonly string[];
}

/** `results/featured.json` under `root`, checked; `{}` when there is none. */
export function readFeatured(root: string): Record<string, string> {
  const path = join(root, FEATURED_FILE);
  if (!existsSync(path)) return {};
  try {
    return parseFeatured(JSON.parse(readFileSync(path, 'utf8')));
  } catch (e) {
    throw new Error(`${FEATURED_FILE}: ${e instanceof Error ? e.message : String(e)}`, {
      cause: e,
    });
  }
}

/**
 * `results/excluded.json` under `root`, checked against `logs`: every id must name one of them, so
 * a typo fails loudly instead of excluding nothing. Empty when there is no file.
 */
export function readExcludedList(root: string, logs: readonly MatchLog[]): ExcludedMatch[] {
  const path = join(root, EXCLUDED_FILE);
  if (!existsSync(path)) return [];
  let list: ExcludedMatch[];
  try {
    list = parseExcluded(JSON.parse(readFileSync(path, 'utf8')));
  } catch (e) {
    throw new Error(`${EXCLUDED_FILE}: ${e instanceof Error ? e.message : String(e)}`, {
      cause: e,
    });
  }
  const unknown = unknownExcludedIds(
    list,
    logs.map((l) => l.header.matchId),
  );
  if (unknown.length > 0) {
    throw new Error(
      `${EXCLUDED_FILE}: no match ${unknown.map((id) => `"${id}"`).join(', ')} in ` +
        `${RESULTS_DIR}/*/matches/ (check the id; nothing was written)`,
    );
  }
  return list;
}

/** `readExcludedList` as id → reason. */
export function readExclusions(root: string, logs: readonly MatchLog[]): Exclusions {
  return exclusionsOf(readExcludedList(root, logs));
}

/** Sorted by game id, so the file and the summary are stable. */
export function sortedByGame(featured: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(featured).sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** `featured` with each of `ids` set for its game (found from the logs). */
function withFeatured(
  featured: Readonly<Record<string, string>>,
  ids: readonly string[],
  logs: readonly MatchLog[],
): Record<string, string> {
  const out = { ...featured };
  const set = new Set<string>();
  for (const id of ids) {
    const log = logs.find((l) => l.header.matchId === id);
    if (!log) throw new Error(`--featured: no match "${id}" in ${RESULTS_DIR}/*/matches/`);
    const { game } = log.header;
    if (set.has(game)) throw new Error(`--featured: two ${game} matches; one per game`);
    set.add(game);
    out[game] = id;
  }
  return out;
}

/** Every `results/<game>/matches/*.jsonl` under `root`, parsed and checked against its path. */
export function readAllMatchLogs(root: string): MatchLog[] {
  const results = join(root, RESULTS_DIR);
  const games = readdirSync(results, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(results, d.name, 'matches')))
    .map((d) => d.name)
    .sort();
  const logs: MatchLog[] = [];
  for (const game of games) {
    const dir = matchesDir(game);
    const files = readdirSync(join(root, dir))
      .filter((f) => f.endsWith('.jsonl'))
      .sort();
    for (const f of files) {
      const rel = `${dir}/${f}`;
      try {
        const log = parseMatchLog(readFileSync(join(root, rel), 'utf8'));
        const { header } = log;
        if (header.game !== game) {
          throw new Error(`header.game is "${header.game}" but the log is filed under "${game}"`);
        }
        if (`${header.matchId}.jsonl` !== f) {
          throw new Error(`header.matchId is "${header.matchId}" but the file is named "${f}"`);
        }
        logs.push(log);
      } catch (e) {
        throw new Error(`${rel}: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
      }
    }
  }
  return logs;
}

/** An index built and checked in memory, not yet written (`writeIndex`). */
export interface PreparedIndex {
  /** Where the index goes, under the root. */
  path: string;
  index: ResultsIndex;
  /** `results/featured.json` as the index used it, sorted by game. */
  featured: Record<string, string>;
  /** Logs without a match_end (not indexed). */
  skipped: number;
}

/**
 * Build the index in memory from `logs`, checking every featured id (a finished, not excluded
 * match of its game). Throws, naming `from` (where the featured ids came from), before anything
 * is written.
 */
export function prepareIndex(
  root: string,
  logs: readonly MatchLog[],
  excluded: Exclusions,
  featured: Readonly<Record<string, string>>,
  from: string,
  out: string = DEFAULT_OUT,
): PreparedIndex {
  const sorted = sortedByGame(featured);
  let index;
  try {
    index = buildResultsIndex(logs, { featured: sorted, excluded });
  } catch (e) {
    if (!(e instanceof FeaturedMatchError)) throw e;
    throw new Error(`${from}: ${e.message}`, { cause: e });
  }
  return {
    path: join(root, out),
    index,
    featured: sorted,
    skipped: logs.length - index.matches.length,
  };
}

/** Write a prepared index, and `results/featured.json` too when `writeFeatured`. */
export function writeIndex(
  root: string,
  prepared: PreparedIndex,
  writeFeatured: boolean,
): IndexResultsSummary {
  if (writeFeatured) {
    writeFileSync(join(root, FEATURED_FILE), JSON.stringify(prepared.featured, null, 2) + '\n');
  }
  writeFileSync(prepared.path, JSON.stringify(prepared.index, null, 2) + '\n');
  return {
    path: prepared.path,
    matches: prepared.index.matches.length,
    skipped: prepared.skipped,
    featured: Object.values(prepared.featured),
  };
}

/** Scan, build and write the index (`opts.out`, default DEFAULT_OUT). Returns what it wrote. */
export function indexResults(opts: IndexResultsOptions = {}): IndexResultsSummary {
  const root = opts.root ?? '.';
  const logs = readAllMatchLogs(root);
  const excluded = readExclusions(root, logs);
  const current = readFeatured(root);
  const featured =
    opts.featured === undefined ? current : withFeatured(current, opts.featured, logs);
  const from = opts.featured === undefined ? FEATURED_FILE : '--featured';
  const prepared = prepareIndex(root, logs, excluded, featured, from, opts.out);
  return writeIndex(root, prepared, opts.featured !== undefined);
}

function main(): void {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((a) => a !== '--'),
    options: {
      featured: { type: 'string', multiple: true },
      root: { type: 'string' },
      out: { type: 'string' },
    },
  });
  const s = indexResults({
    ...(values.root === undefined ? {} : { root: values.root }),
    ...(values.out === undefined ? {} : { out: values.out }),
    ...(values.featured === undefined ? {} : { featured: values.featured }),
  });
  console.log(
    `${s.path}: ${String(s.matches)} matches` +
      (s.skipped > 0 ? ` (${String(s.skipped)} unfinished skipped)` : '') +
      `, featured: ${s.featured.join(', ') || 'none'}`,
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
