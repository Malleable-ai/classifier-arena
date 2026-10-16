import { gameBaselines } from '../classifier/baselines.js';
import type { Hosting } from '../classifier/hosting.js';
import type { Seat } from '../classifier/types.js';
import type { GameCommon } from '../game.js';
import type { MatchLog } from '../log/read.js';
import type { DecisionLine } from '../log/schema.js';
import type { ExcludedMatch, Exclusions } from '../results/excluded.js';
import {
  MATCH_OVER,
  MAX_MISS_RATE,
  invalidReasonText,
  invalidReasonsOfLog,
  isFailure,
  isRefusal,
} from '../sched/validity.js';
import { percentile } from './percentiles.js';
import { wilson, type Interval } from './wilson.js';

/**
 * One game's results from its match logs alone (docs/architecture/core.md, "Scores"; written to
 * `results/<game>/summary.{json,md}` by `pnpm leaderboard`). Pure: the caller reads the logs.
 *
 * - Only matches of the game's current version count (`game.version`). A log of an older
 *   version is listed in `olderVersion` ("older version, not scored") and adds nothing else but
 *   its spend; a log of a newer version than the code is an error.
 * - Only valid matches count. Validity is recomputed from each log with the current rule
 *   (`invalidReasonsOfLog`, the same `invalidReasons` the schedulers use), not read from
 *   `match_end.valid`, so a rule change re-scores the logs already written; the matches whose
 *   validity changed are listed in `rescored`. Invalid matches are counted and listed with their
 *   reasons (`invalidMatches`), but add nothing else. Logs without a match_end are counted as
 *   unfinished.
 * - Matches on the exclusion list (`results/excluded.json`, src/core/results/excluded.ts) are
 *   invalid too: counted with the invalid ones (and as `excluded`), listed apart with their
 *   reasons in `excluded`, never in `invalidMatches` or `rescored`.
 * - A pairing is an unordered pair of players. Its record is `players[0]`'s (ids sorted), with a
 *   draw as half a win; for a mirror pairing (random vs random) it is seat 0's.
 * - A head-to-head is a match between two different providers (neither seat a baseline).
 * - Per player, over its seats in valid matches: decisions are the lines validity.ts counts (not
 *   `matchOver`); misses are timeouts and transport failures (`error`); refusals (the model
 *   declining to answer) are counted apart and are not misses; accuracy is correct over lines
 *   with a `correct` field (graded games only); latency is over `ok` and `dropped` decisions (an
 *   answer arrived); cost is every line's `costUsd` (the billed `matchOver` ones too) plus the
 *   warm-ups.
 * - Every game gets the run-level miss check (`RunCheck`): a timeout is the model's own miss and
 *   never makes a match invalid, so the 2% limit on misses (timeouts and failures) is checked
 *   over the whole published run instead.
 */

/**
 * 2: `runCheck` added. 3: refusals per player and `rescored`; validity recomputed from the
 * decisions (refusals don't count toward it). 4: `excluded` and `matches.excluded` (the
 * exclusion list); stalls and empty real-time provider seats are invalid. 5: timeouts never make
 * a match invalid and stalls are read from the log too; `invalidMatches` (with reasons) replaces
 * `invalidMatchIds`; `runCheck` for every game; only the current version is scored
 * (`gameVersion`, `olderVersion`, `matches.olderVersion` replace `gameVersions`).
 */
export const SUMMARY_SCHEMA_VERSION = 5;

/** What a summary needs to know about its game (any registered `Game` fits). */
export type SummaryGame = Pick<
  GameCommon<unknown, unknown>,
  'id' | 'label' | 'version' | 'graded' | 'baselines' | 'baselineLabels'
>;

/** A player over the run-level miss limit. */
export interface RunCheckFailure {
  player: string;
  label: string;
  /** Over the run's valid matches, as in `PlayerSummary`. */
  decisions: number;
  misses: number;
  missRate: number;
}

/**
 * The run-level miss check (every game). Each player's miss rate (timeouts and transport failures
 * over decisions, `matchOver` lines not counted; refusals are not misses) over every valid match
 * in the summary, seats pooled: the same numbers as its `PlayerSummary`. The check fails when any
 * player's rate is above `maxMissRate` (2%, the per-match limit on failures); the results are
 * still shown, with a warning.
 */
export interface RunCheck {
  maxMissRate: number;
  passed: boolean;
  /** The players over the limit, worst first (then by id); empty when passed. */
  failing: RunCheckFailure[];
}

export interface LatencySummary {
  p50: number | null;
  p95: number | null;
  /** How many latencies (ok and dropped decisions). */
  n: number;
}

export interface PlayerSummary {
  player: string;
  label: string;
  kind: 'provider' | 'baseline';
  /** The provider's model as logged in the newest header; null for a baseline. */
  model: string | null;
  hosting: Hosting | null;
  /** Valid matches played (a mirror match counts once). */
  matches: number;
  decisions: number;
  /** Timeouts and transport failures (`error`), not refusals. */
  misses: number;
  /** misses / decisions; 0 with no decisions. */
  missRate: number;
  /** Decisions the model declined to answer (status `refusal`). Never counted toward validity. */
  refusals: number;
  /** refusals / decisions; 0 with no decisions. */
  refusalRate: number;
  dropped: number;
  /** Decisions with a `correct` field (graded games only). */
  graded: number;
  correct: number;
  /** correct / graded; null for an ungraded game or no graded decisions. */
  accuracy: number | null;
  latencyMs: LatencySummary;
  /** Every decision line's cost plus the warm-ups. */
  costUsd: number;
  /** costUsd / decisions × 1000; null with no decisions. */
  costPer1000: number | null;
}

export interface Record3 {
  wins: number;
  draws: number;
  losses: number;
}

export interface PairingSummary extends Record3 {
  /** Sorted player ids. The record and win rate are `players[0]`'s. */
  players: [string, string];
  labels: [string, string];
  /** Two different providers. */
  headToHead: boolean;
  /** Valid matches. */
  matches: number;
  /** Matches of this pairing not in the record: invalid by the rule or excluded by hand. */
  invalid: number;
  /** (wins + ½ draws) / matches, with its 95% Wilson interval. */
  winRate: Interval;
}

export interface FeaturedMatch {
  id: string;
  /** Seat 0 then seat 1. */
  players: [string, string];
  /**
   * `match_end.winner`. With equal scores and a winner, the game's tiebreak decided it (Clue
   * Clash's latency), so `formatResult` says so instead of showing a tied score.
   */
  winner: Seat | 'draw' | null;
  scores: [number, number];
  /** |scores[0] − scores[1]|. */
  margin: number;
  /** Ticks (real-time) or turns played. */
  totalTicks: number;
}

/** A match not scored, with why (`invalidReasonText`, several joined by "; "). */
export interface InvalidMatch {
  id: string;
  reason: string;
}

/** A match of an older game version than the one scored: listed, not scored. */
export interface OlderVersionMatch {
  id: string;
  gameVersion: number;
}

/** A finished match whose validity under the current rule differs from its `match_end.valid`. */
export interface RescoredMatch {
  id: string;
  /** `match_end.valid`, written by the rule in force when the match was played. */
  loggedValid: boolean;
  /** Under the current rule (`isValidLog`); what the summary counts. */
  valid: boolean;
}

export interface GameSummary {
  schemaVersion: typeof SUMMARY_SCHEMA_VERSION;
  game: string;
  label: string;
  graded: boolean;
  /** The game version scored: the game's current version. */
  gameVersion: number;
  /**
   * The machines that ran the valid matches with a provider seat (`header.runId`), distinct and
   * sorted. One id means every published run came from one machine.
   */
  runIds: string[];
  /**
   * `invalid` counts every finished match not scored: invalid by the rule, or excluded by hand
   * (`excluded`, a part of `invalid`). An excluded log is counted there even if unfinished.
   * `olderVersion` counts the logs of an older game version (not scored, not in the others).
   */
  matches: {
    total: number;
    valid: number;
    invalid: number;
    excluded: number;
    unfinished: number;
    olderVersion: number;
  };
  /** Matches invalid by the rule (not the excluded ones), by id, with why. */
  invalidMatches: InvalidMatch[];
  /**
   * This game's matches on the exclusion list (`results/excluded.json`), by id, with each reason.
   * Counted as invalid; listed apart from `invalidMatches` and `rescored`.
   */
  excluded: ExcludedMatch[];
  /** Logs of an older game version than `gameVersion`, by id: "older version, not scored". */
  olderVersion: OlderVersionMatch[];
  /**
   * Finished matches whose validity was re-scored: the current rule disagrees with the
   * `match_end.valid` written when they were played (for example a match made invalid only by
   * refusals, which no longer count). By id.
   */
  rescored: RescoredMatch[];
  /** Spend over every log, valid or not, finished or not: decision lines plus warm-ups. */
  totalCostUsd: number;
  /** Providers first, then baselines, each by id. */
  players: PlayerSummary[];
  /** Head-to-head first, then by player ids. */
  pairings: PairingSummary[];
  /**
   * The valid head-to-head with the smallest score margin; ties go to the longer match, then the
   * earliest id. Null when there is none.
   */
  featured: FeaturedMatch | null;
  /** The run-level miss check over the valid matches. */
  runCheck: RunCheck;
}

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const sortedUnique = <T extends string | number>(xs: Iterable<T>): T[] =>
  [...new Set(xs)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

/** The run-level miss check over a game's players (`players` from the summary). */
export function runCheckOf(players: readonly PlayerSummary[]): RunCheck {
  const failing = players
    .filter((p) => p.decisions > 0 && p.missRate > MAX_MISS_RATE)
    .map((p): RunCheckFailure => ({
      player: p.player,
      label: p.label,
      decisions: p.decisions,
      misses: p.misses,
      missRate: p.missRate,
    }))
    .sort((a, b) => b.missRate - a.missRate || byString(a.player, b.player));
  return { maxMissRate: MAX_MISS_RATE, passed: failing.length === 0, failing };
}

/** Every line billed to `seat`, plus its warm-up. */
function seatCost(log: MatchLog, seat: Seat): number {
  const warmup = log.header.seats[seat].warmup?.costUsd ?? 0;
  return log.decisions.reduce((sum, d) => (d.seat === seat ? sum + d.costUsd : sum), warmup);
}

interface PlayerAcc {
  player: string;
  label: string;
  kind: 'provider' | 'baseline';
  model: string | null;
  hosting: Hosting | null;
  matches: number;
  decisions: number;
  misses: number;
  refusals: number;
  dropped: number;
  graded: number;
  correct: number;
  latencies: number[];
  costUsd: number;
}

interface PairingAcc extends Record3 {
  players: [string, string];
  labels: [string, string];
  headToHead: boolean;
  matches: number;
  invalid: number;
}

/** "Jev (TypeSafe)" → "Jev": a label without its trailing parenthetical, for reasons. */
const shortName = (label: string): string => label.replace(/\s*\([^)]*\)\s*$/, '').trim() || label;

/**
 * `excluded`: the exclusion list (`results/excluded.json`); its matches are invalid here. The
 * caller checks it names real logs (the CLIs do). Required, so no caller forgets it (pass
 * NO_EXCLUSIONS where there is no results tree). Throws on a log of a newer game version than
 * `game.version`.
 */
export function summarizeGame(
  game: SummaryGame,
  allLogs: readonly MatchLog[],
  excluded: Exclusions,
): GameSummary {
  const baselineIds = new Set(gameBaselines(game).map((b) => b.id));
  const isProvider = (player: string): boolean => !baselineIds.has(player);
  // Oldest first, so a player's label and model come from its newest log.
  const logs = allLogs
    .filter((l) => l.header.game === game.id)
    .sort((a, b) => byString(a.header.matchId, b.header.matchId));

  const players = new Map<string, PlayerAcc>();
  const pairings = new Map<string, PairingAcc>();
  const invalidMatches: InvalidMatch[] = [];
  const excludedList: ExcludedMatch[] = [];
  const olderVersion: OlderVersionMatch[] = [];
  const rescored: RescoredMatch[] = [];
  const runIds: string[] = [];
  let valid = 0;
  let unfinished = 0;
  let totalCostUsd = 0;
  let featured: FeaturedMatch | null = null;

  const pairingOf = (log: MatchLog): PairingAcc => {
    const [a, b] = log.header.seats;
    const first = byString(a.player, b.player) <= 0 ? a : b;
    const second = first === a ? b : a;
    const key = `${first.player}\u0000${second.player}`;
    let p = pairings.get(key);
    if (p === undefined) {
      p = {
        players: [first.player, second.player],
        labels: [first.label, second.label],
        headToHead: a.player !== b.player && isProvider(a.player) && isProvider(b.player),
        matches: 0,
        invalid: 0,
        wins: 0,
        draws: 0,
        losses: 0,
      };
      pairings.set(key, p);
    }
    p.labels = [first.label, second.label];
    return p;
  };

  for (const log of logs) {
    totalCostUsd += seatCost(log, 0) + seatCost(log, 1);
    const end = log.matchEnd;
    const reason = excluded.get(log.header.matchId);
    if (reason !== undefined) {
      // Excluded by hand: invalid, listed apart with its reason, never re-scored.
      excludedList.push({ id: log.header.matchId, reason });
      pairingOf(log).invalid++;
      continue;
    }
    const version = log.header.gameVersion;
    if (version > game.version) {
      throw new Error(
        `${log.header.matchId}: game version ${String(version)} is newer than ${game.id}'s ` +
          `current version ${String(game.version)}`,
      );
    }
    if (version < game.version) {
      olderVersion.push({ id: log.header.matchId, gameVersion: version });
      continue;
    }
    if (end === null) {
      unfinished++;
      continue;
    }
    const pairing = pairingOf(log);
    const reasons = invalidReasonsOfLog(log, excluded);
    const isValid = reasons.length === 0;
    if (isValid !== end.valid) {
      rescored.push({ id: log.header.matchId, loggedValid: end.valid, valid: isValid });
    }
    if (!isValid) {
      const labels = [
        shortName(log.header.seats[0].label),
        shortName(log.header.seats[1].label),
      ] as const;
      invalidMatches.push({
        id: log.header.matchId,
        reason: reasons.map((r) => invalidReasonText(r, labels)).join('; '),
      });
      pairing.invalid++;
      continue;
    }
    valid++;
    const seats = log.header.seats;
    if (seats.some((s) => isProvider(s.player))) runIds.push(log.header.runId);

    // The record, from players[0]'s side (seat 0's in a mirror pairing).
    pairing.matches++;
    const w = end.winner;
    if (w !== 0 && w !== 1) pairing.draws++;
    else if (seats[0].player === seats[1].player) {
      if (w === 0) pairing.wins++;
      else pairing.losses++;
    } else if (seats[w].player === pairing.players[0]) pairing.wins++;
    else pairing.losses++;

    // Players: a mirror match counts once for matches, both seats for everything else.
    const seen = new Set<string>();
    for (const s of seats) {
      let acc = players.get(s.player);
      if (acc === undefined) {
        acc = {
          player: s.player,
          label: s.label,
          kind: isProvider(s.player) ? 'provider' : 'baseline',
          model: null,
          hosting: null,
          matches: 0,
          decisions: 0,
          misses: 0,
          refusals: 0,
          dropped: 0,
          graded: 0,
          correct: 0,
          latencies: [],
          costUsd: 0,
        };
        players.set(s.player, acc);
      }
      acc.label = s.label;
      acc.model = s.model;
      acc.hosting = s.hosting;
      if (!seen.has(s.player)) acc.matches++;
      seen.add(s.player);
      acc.costUsd += seatCost(log, s.seat);
      for (const d of log.decisions) {
        if (d.seat === s.seat) addDecision(acc, d, game.graded);
      }
    }

    if (pairing.headToHead) featured = closer(featured, log);
  }

  const playerList = [...players.values()]
    .sort((a, b) =>
      a.kind !== b.kind ? (a.kind === 'provider' ? -1 : 1) : byString(a.player, b.player),
    )
    .map(finishPlayer);
  const pairingList = [...pairings.values()]
    .filter((p) => p.matches > 0 || p.invalid > 0)
    .sort((a, b) =>
      a.headToHead !== b.headToHead
        ? a.headToHead
          ? -1
          : 1
        : byString(a.players.join(' '), b.players.join(' ')),
    )
    .map((p): PairingSummary => ({
      players: p.players,
      labels: p.labels,
      headToHead: p.headToHead,
      matches: p.matches,
      invalid: p.invalid,
      wins: p.wins,
      draws: p.draws,
      losses: p.losses,
      winRate: wilson(p.wins + p.draws / 2, p.matches),
    }));

  return {
    schemaVersion: SUMMARY_SCHEMA_VERSION,
    game: game.id,
    label: game.label,
    graded: game.graded,
    gameVersion: game.version,
    runIds: sortedUnique(runIds),
    matches: {
      total: logs.length,
      valid,
      invalid: invalidMatches.length + excludedList.length,
      excluded: excludedList.length,
      unfinished,
      olderVersion: olderVersion.length,
    },
    invalidMatches,
    excluded: excludedList,
    olderVersion,
    rescored,
    totalCostUsd,
    players: playerList,
    pairings: pairingList,
    featured,
    runCheck: runCheckOf(playerList),
  };
}

function addDecision(acc: PlayerAcc, d: DecisionLine, graded: boolean): void {
  if (d.error === MATCH_OVER) return; // billed (seatCost), but not a decision
  acc.decisions++;
  if (isRefusal(d)) acc.refusals++;
  else if (d.status === 'timeout' || isFailure(d)) acc.misses++;
  if (d.status === 'dropped') acc.dropped++;
  if (d.status === 'ok' || d.status === 'dropped') acc.latencies.push(d.latencyMs);
  if (graded && d.correct !== undefined) {
    acc.graded++;
    if (d.correct) acc.correct++;
  }
}

function finishPlayer(acc: PlayerAcc): PlayerSummary {
  return {
    player: acc.player,
    label: acc.label,
    kind: acc.kind,
    model: acc.model,
    hosting: acc.hosting,
    matches: acc.matches,
    decisions: acc.decisions,
    misses: acc.misses,
    missRate: acc.decisions === 0 ? 0 : acc.misses / acc.decisions,
    refusals: acc.refusals,
    refusalRate: acc.decisions === 0 ? 0 : acc.refusals / acc.decisions,
    dropped: acc.dropped,
    graded: acc.graded,
    correct: acc.correct,
    accuracy: acc.graded === 0 ? null : acc.correct / acc.graded,
    latencyMs: {
      p50: percentile(acc.latencies, 0.5),
      p95: percentile(acc.latencies, 0.95),
      n: acc.latencies.length,
    },
    costUsd: acc.costUsd,
    costPer1000: acc.decisions === 0 ? null : (acc.costUsd / acc.decisions) * 1000,
  };
}

/**
 * The closer of `best` and `log`'s match: the smaller margin, then the longer match, then the
 * earlier id. Logs arrive sorted by id, so on a full tie the one already held is earlier.
 */
function closer(best: FeaturedMatch | null, log: MatchLog): FeaturedMatch {
  const end = log.matchEnd;
  if (end === null) throw new Error('closer: an unfinished match');
  const [a, b] = log.header.seats;
  const candidate: FeaturedMatch = {
    id: log.header.matchId,
    players: [a.player, b.player],
    winner: end.winner,
    scores: [end.scores[0], end.scores[1]],
    margin: Math.abs(end.scores[0] - end.scores[1]),
    totalTicks: end.totalTicks,
  };
  if (best === null) return candidate;
  if (candidate.margin !== best.margin) return candidate.margin < best.margin ? candidate : best;
  if (candidate.totalTicks !== best.totalTicks) {
    return candidate.totalTicks > best.totalTicks ? candidate : best;
  }
  return byString(candidate.id, best.id) < 0 ? candidate : best;
}
