import { MATCH_ID_SAFE_RE } from './paths.js';

/**
 * `results/excluded.json` (EXCLUDED_FILE): matches excluded from the results by hand, each with
 * its reason, committed so the exclusion is auditable:
 *
 *   { "matches": [{ "id": "<match id>", "reason": "<short reason>" }] }
 *
 * An excluded match counts as invalid everywhere a log is scored (`isValidLog`: the summaries, the
 * leaderboard, the featured choice, the run-level check, `results/index.json` and the history
 * page), and is listed with its reason apart from the matches invalid by the rule. Its log stays.
 *
 * Only for an infrastructure failure the log can't show, such as a match played while the machine
 * slept before stall detection existed (2026-10-15) that left no request longer than its timeout
 * (validity.ts `logStalls` catches those by itself, so they come off the list). Never to drop a
 * result someone dislikes.
 *
 * Pure and Node-free (the web build reads the same file). The CLIs check every id names a log
 * (`unknownExcludedIds`), so a typo fails loudly instead of excluding nothing.
 */

export interface ExcludedMatch {
  id: string;
  /** Why, in a few words. Shown beside the match wherever it is listed. */
  reason: string;
}

/** Excluded match id → its reason. */
export type Exclusions = ReadonlyMap<string, string>;

/** No exclusions (no results tree, or a scheduler scoring the match it just played). */
export const NO_EXCLUSIONS: Exclusions = new Map();

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Check a parsed `results/excluded.json`. Strict, so a misspelt key can't silently exclude
 * nothing: only `matches` at the top, only `id` and `reason` in each entry, each id a usable match
 * id named once, each reason non-empty. Returns the entries in file order.
 */
export function parseExcluded(value: unknown): ExcludedMatch[] {
  if (!isObj(value)) throw new Error('must be an object { "matches": [...] }');
  const extra = Object.keys(value).filter((k) => k !== 'matches');
  if (extra.length > 0) throw new Error(`unknown key ${JSON.stringify(extra[0])}`);
  const list = value['matches'];
  if (!Array.isArray(list)) throw new Error('"matches" must be an array');
  const seen = new Set<string>();
  return list.map((entry: unknown, i): ExcludedMatch => {
    const at = `matches[${String(i)}]`;
    if (!isObj(entry)) throw new Error(`${at} must be an object { "id", "reason" }`);
    const unknown = Object.keys(entry).filter((k) => k !== 'id' && k !== 'reason');
    if (unknown.length > 0) throw new Error(`${at}: unknown key ${JSON.stringify(unknown[0])}`);
    const { id, reason } = entry;
    if (typeof id !== 'string' || !MATCH_ID_SAFE_RE.test(id)) {
      throw new Error(`${at}.id must be a match id, got ${JSON.stringify(id)}`);
    }
    if (typeof reason !== 'string' || reason.trim() === '') {
      throw new Error(`${at}.reason must be a non-empty string, got ${JSON.stringify(reason)}`);
    }
    if (seen.has(id)) throw new Error(`${at}: "${id}" is listed twice`);
    seen.add(id);
    return { id, reason: reason.trim() };
  });
}

export function exclusionsOf(list: readonly ExcludedMatch[]): Exclusions {
  return new Map(list.map((e) => [e.id, e.reason]));
}

/** The excluded ids that name none of `ids` (the logs on disk), in file order. */
export function unknownExcludedIds(list: readonly ExcludedMatch[], ids: Iterable<string>): string[] {
  const known = new Set(ids);
  return list.filter((e) => !known.has(e.id)).map((e) => e.id);
}
