import { PLAYER_ID_RE } from '../classifier/types.js';
import { GAME_ID_RE } from '../game.js';

/**
 * Where results live (docs/architecture/core.md, "Results layout"), as pure string functions shared
 * by the CLIs, the proxy and the web build. Paths are relative to the repo root and always
 * `/`-separated (no node:path here, so the web build can use them):
 *
 *   results/<game>/matches/<matchId>.jsonl     one log per match
 *   results/<game>/summary.{json,md}           per-game summary
 *   results/leaderboard.{json,md}              every game
 *   results/index.json                         every match (src/core/replay/results-index.ts)
 *   results/featured.json                      each game's featured match id (committed)
 *   results/excluded.json                      matches excluded by hand, with reasons (committed)
 *   results/states/<game>/<matchId>/<seat>-<seq>.json   full request/response snapshots
 *
 * Match ids are `<yyyymmdd>-<hhmmss>-<game>-<a>-vs-<b>-<n>`.
 */

export const RESULTS_DIR = 'results';
export const INDEX_FILE = `${RESULTS_DIR}/index.json`;
/** `{ "<game>": "<match id>" }`: the match `pnpm index-results` marks featured for each game. */
export const FEATURED_FILE = `${RESULTS_DIR}/featured.json`;
/**
 * `{ "matches": [{ "id", "reason" }] }`: matches excluded by hand (src/core/results/excluded.ts).
 * Each counts as invalid everywhere the stats score a log.
 */
export const EXCLUDED_FILE = `${RESULTS_DIR}/excluded.json`;
export const LEADERBOARD_FILES = {
  json: `${RESULTS_DIR}/leaderboard.json`,
  md: `${RESULTS_DIR}/leaderboard.md`,
} as const;

/** Lowercase `-`-separated segments of letters, digits and `_`: no dots, slashes or spaces. */
export const MATCH_ID_SAFE_RE = /^[a-z0-9_]+(?:-[a-z0-9_]+)*$/;

function gameDir(game: string): string {
  if (!GAME_ID_RE.test(game)) throw new Error(`not a game id: ${JSON.stringify(game)}`);
  return game;
}

function safeId(id: string): string {
  if (!MATCH_ID_SAFE_RE.test(id)) throw new Error(`not a usable match id: ${JSON.stringify(id)}`);
  return id;
}

export function matchesDir(game: string): string {
  return `${RESULTS_DIR}/${gameDir(game)}/matches`;
}

/** A match log's path relative to `results/` (what results/index.json records). */
export function matchFileInResults(game: string, id: string): string {
  return `${gameDir(game)}/matches/${safeId(id)}.jsonl`;
}

export function matchFile(game: string, id: string): string {
  return `${RESULTS_DIR}/${matchFileInResults(game, id)}`;
}

export function summaryFiles(game: string): { json: string; md: string } {
  const dir = `${RESULTS_DIR}/${gameDir(game)}`;
  return { json: `${dir}/summary.json`, md: `${dir}/summary.md` };
}

/** Where one match's request/response snapshots go (gitignored). */
export function statesDir(game: string, id: string): string {
  return `${RESULTS_DIR}/states/${gameDir(game)}/${safeId(id)}`;
}

export interface MatchIdParts {
  game: string;
  /** Seat 0's player id. */
  a: string;
  /** Seat 1's player id. */
  b: string;
  /**
   * When the match started. A Date gives its local date and time (as the CLIs always have). A
   * string must start `YYYY-MM-DDTHH:MM:SS` and is taken as written, with no time-zone conversion.
   */
  when: Date | string;
  /** 1, 2, … to tell apart matches started in the same second. */
  run: number;
}

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/;

function stamp(when: Date | string): string {
  if (typeof when === 'string') {
    const m = ISO_RE.exec(when);
    if (!m) throw new Error(`when must be a Date or start YYYY-MM-DDTHH:MM:SS, got "${when}"`);
    return `${m[1] ?? ''}${m[2] ?? ''}${m[3] ?? ''}-${m[4] ?? ''}${m[5] ?? ''}${m[6] ?? ''}`;
  }
  const p = (n: number): string => String(n).padStart(2, '0');
  return (
    `${String(when.getFullYear())}${p(when.getMonth() + 1)}${p(when.getDate())}-` +
    `${p(when.getHours())}${p(when.getMinutes())}${p(when.getSeconds())}`
  );
}

/** `<yyyymmdd>-<hhmmss>-<game>-<a>-vs-<b>-<run>`. Throws on a bad game id, player id or run. */
export function matchIdFor({ game, a, b, when, run }: MatchIdParts): string {
  gameDir(game);
  for (const p of [a, b]) {
    if (!PLAYER_ID_RE.test(p)) throw new Error(`not a player id: ${JSON.stringify(p)}`);
  }
  if (!Number.isInteger(run) || run < 1) {
    throw new Error(`run must be an integer ≥ 1, got ${String(run)}`);
  }
  return `${stamp(when)}-${game}-${a}-vs-${b}-${String(run)}`;
}

export interface ParsedMatchId {
  /** `YYYY-MM-DD`, as stamped. */
  date: string;
  /** `HH:MM:SS`, as stamped. */
  time: string;
  game: string;
  /** Seat 0 then seat 1. */
  players: [string, string];
  run: number;
}

const STAMP_RE = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-(.+)$/;
const PLAYERS_RE = /^([a-z0-9_]+)-vs-([a-z0-9_]+)-([1-9]\d*)$/;

/**
 * Split a match id on the known game ids (longest first, so `clue_clash` wins over `clue`) and
 * `-vs-`. Null for a malformed id or one whose game is not in `gameIds`.
 */
export function parseMatchId(id: string, gameIds: readonly string[]): ParsedMatchId | null {
  const m = STAMP_RE.exec(id);
  if (m === null) return null;
  const g = (i: number): string => m[i] ?? '';
  const rest = g(7);
  const byLength = [...gameIds].sort((x, y) => y.length - x.length);
  for (const game of byLength) {
    if (!rest.startsWith(`${game}-`)) continue;
    const p = PLAYERS_RE.exec(rest.slice(game.length + 1));
    if (p === null) continue;
    return {
      date: `${g(1)}-${g(2)}-${g(3)}`,
      time: `${g(4)}:${g(5)}:${g(6)}`,
      game,
      players: [p[1] ?? '', p[2] ?? ''],
      run: Number(p[3]),
    };
  }
  return null;
}
