import { parseMatchLog, type MatchLog } from '../core/log/read.js';
import type { ResultsIndex } from '../core/replay/results-index.js';
import {
  NO_EXCLUSIONS,
  exclusionsOf,
  parseExcluded,
  type Exclusions,
} from '../core/results/excluded.js';
import { LEADERBOARD_SCHEMA_VERSION, type Leaderboard } from '../core/stats/leaderboard.js';
import { SUMMARY_SCHEMA_VERSION, type GameSummary } from '../core/stats/summary.js';

/**
 * The committed match logs and results index, bundled by Vite: `import.meta.glob` with `?raw`
 * turns each `results/<game>/matches/<id>.jsonl` into a lazy chunk (fetched only when that match
 * is opened), the same in `pnpm dev`, `vite build` and Vitest. No server, no `public/` copy, no
 * Vite config. Logs are keyed `<game>/<id>`.
 */
const LOGS = import.meta.glob<string>('../../results/*/matches/*.jsonl', {
  query: '?raw',
  import: 'default',
});

/** `results/index.json` (schema v2), eager: the history pages read it on load. */
const INDEX = import.meta.glob<unknown>('../../results/index.json', {
  eager: true,
  import: 'default',
});

/** `results/excluded.json`, eager: matches excluded by hand, with reasons. */
const EXCLUDED = import.meta.glob<unknown>('../../results/excluded.json', {
  eager: true,
  import: 'default',
});

/** `results/leaderboard.json` and each `results/<game>/summary.json` (`pnpm leaderboard`), eager. */
const LEADERBOARD = import.meta.glob<unknown>('../../results/leaderboard.json', {
  eager: true,
  import: 'default',
});
const SUMMARIES = import.meta.glob<unknown>('../../results/*/summary.json', {
  eager: true,
  import: 'default',
});
const SUMMARY_PATH_RE = /\/results\/([^/]+)\/summary\.json$/;

const LOG_PATH_RE = /\/results\/([^/]+)\/matches\/([^/]+)\.jsonl$/;

const byKey = new Map<string, () => Promise<string>>();
for (const [path, load] of Object.entries(LOGS)) {
  const m = LOG_PATH_RE.exec(path);
  if (m !== null) byKey.set(`${m[1] ?? ''}/${m[2] ?? ''}`, load);
}

/** Every committed log id of `game`, sorted. */
export function committedMatchIds(game: string): string[] {
  const prefix = `${game}/`;
  return [...byKey.keys()]
    .filter((k) => k.startsWith(prefix))
    .map((k) => k.slice(prefix.length))
    .sort();
}

/** One committed log, parsed (schema v2). Throws for an unknown id or a log of another game. */
export async function loadCommittedLog(game: string, id: string): Promise<MatchLog> {
  const load = byKey.get(`${game}/${id}`);
  if (load === undefined) throw new Error(`no committed ${game} match log "${id}"`);
  const log = parseMatchLog(await load());
  if (log.header.game !== game) {
    throw new Error(`match log "${id}" is a ${log.header.game} log, filed under ${game}`);
  }
  return log;
}

/** `results/index.json`, or null when it is missing or not schema v2. */
export function resultsIndex(): ResultsIndex | null {
  const index = Object.values(INDEX)[0];
  if (typeof index !== 'object' || index === null) return null;
  return (index as { schemaVersion?: unknown }).schemaVersion === 2
    ? (index as ResultsIndex)
    : null;
}

let exclusions: Exclusions | null = null;

/**
 * `results/excluded.json` as id → reason (none when the file is missing). Throws on a malformed
 * file, which `pnpm leaderboard` would have refused too.
 */
export function committedExclusions(): Exclusions {
  if (exclusions === null) {
    const file = Object.values(EXCLUDED)[0];
    exclusions = file === undefined ? NO_EXCLUSIONS : exclusionsOf(parseExcluded(file));
  }
  return exclusions;
}

const hasVersion = (value: unknown, version: number): boolean =>
  typeof value === 'object' &&
  value !== null &&
  (value as { schemaVersion?: unknown }).schemaVersion === version;

/** `results/leaderboard.json`, or null when it is missing or another schema version. */
export function committedLeaderboard(): Leaderboard | null {
  const lb = Object.values(LEADERBOARD)[0];
  return hasVersion(lb, LEADERBOARD_SCHEMA_VERSION) ? (lb as Leaderboard) : null;
}

/** `results/<game>/summary.json`, or null when it is missing or another schema version. */
export function committedSummary(game: string): GameSummary | null {
  for (const [path, value] of Object.entries(SUMMARIES)) {
    if (SUMMARY_PATH_RE.exec(path)?.[1] !== game) continue;
    return hasVersion(value, SUMMARY_SCHEMA_VERSION) ? (value as GameSummary) : null;
  }
  return null;
}

// Live mode (`pnpm live`) adds logs while the dev server runs. Accept the new list here instead of
// letting Vite reload the page, which would kill the running match; the next page load sees it.
if (import.meta.hot) import.meta.hot.accept();
