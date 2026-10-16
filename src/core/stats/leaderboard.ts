import type { Hosting } from '../classifier/hosting.js';
import type { ExcludedMatch } from '../results/excluded.js';
import { formatPercent, formatShare } from './format.js';
import type { GameSummary, LatencySummary, PairingSummary, Record3, RunCheck } from './summary.js';
import { wilson, type Interval } from './wilson.js';

/**
 * The overall leaderboard from every game's summary (docs/architecture/core.md, "Scores";
 * written to `results/leaderboard.{json,md}` by `pnpm leaderboard` and drawn at `/`). Pure.
 *
 * One row per provider model. Per game: its head-to-head win rate against the other model(s) with
 * a 95% Wilson interval, accuracy (graded games), refusal rate, p50/p95 latency and cost per 1,000
 * decisions.
 * Overall: the mean of the per-game head-to-head win rates, every game weighted equally; a game
 * without a head-to-head is left out of the mean. Baselines appear as reference rows only.
 */

/**
 * 2: `games[].runCheck` added. 3: `models[].games[].refusals` and `refusalRate`. 4:
 * `games[].excluded` and `games[].matches.excluded` (the exclusion list). 5: timeouts never make
 * a match invalid; `games[].runCheck` for every game, never null.
 */
export const LEADERBOARD_SCHEMA_VERSION = 5;

/** How the overall score is computed, stated on the page and in leaderboard.md. */
export const OVERALL_FORMULA =
  'Overall = the mean of the per-game head-to-head win rates against the other model, every ' +
  'game weighted equally. A game’s win rate = (wins + ½ × draws) ÷ valid head-to-head matches ' +
  '(a draw counts as half a win), shown with its 95% Wilson interval. Only valid matches count. ' +
  'A game with no head-to-head yet shows — and is left out of the mean.';

export interface LeaderboardGame {
  id: string;
  label: string;
  graded: boolean;
  /** `invalid` includes the `excluded` ones, as in the summary. */
  matches: { valid: number; invalid: number; excluded: number; headToHead: number };
  /** Matches excluded by hand (`results/excluded.json`), with each reason. */
  excluded: ExcludedMatch[];
  /** The featured head-to-head (closest valid one), or null. */
  featured: string | null;
  /** The run-level miss check from the summary. */
  runCheck: RunCheck;
}

export interface HeadToHeadCell extends Record3 {
  /** The other providers this model played in this game. */
  opponents: string[];
  matches: number;
  winRate: Interval;
}

export interface ModelGameCell {
  game: string;
  /** Null when this model has no valid head-to-head in this game yet. */
  headToHead: HeadToHeadCell | null;
  accuracy: number | null;
  latencyMs: LatencySummary;
  costPer1000: number | null;
  decisions: number;
  /** Timeouts and transport failures over decisions (refusals are not misses). */
  missRate: number;
  /** Decisions the model declined to answer, in valid matches. Never counted toward validity. */
  refusals: number;
  /** refusals / decisions; 0 with no decisions. */
  refusalRate: number;
}

export interface ModelRow {
  player: string;
  label: string;
  model: string | null;
  hosting: Hosting | null;
  /** The mean of the head-to-head win rates of `overallGames`; null when there are none. */
  overall: number | null;
  /** Games whose head-to-head win rate is in `overall`, in game order. */
  overallGames: string[];
  /** One cell per leaderboard game, in game order. */
  games: ModelGameCell[];
}

/** A model's record against one baseline in one game. */
export interface BaselineRecordRow extends Record3 {
  game: string;
  player: string;
  label: string;
  opponent: string;
  opponentLabel: string;
  matches: number;
  winRate: Interval;
}

/** A baseline's own numbers in one game. */
export interface BaselineRow {
  game: string;
  player: string;
  label: string;
  matches: number;
  decisions: number;
  accuracy: number | null;
  latencyMs: LatencySummary;
}

export interface Leaderboard {
  schemaVersion: typeof LEADERBOARD_SCHEMA_VERSION;
  formula: string;
  /** The run ids (machines) of the valid provider matches, over every game, distinct and sorted. */
  runIds: string[];
  games: LeaderboardGame[];
  /** Best overall first (no overall last), then by id. */
  models: ModelRow[];
  /** By game, then model, then baseline. */
  baselineRecords: BaselineRecordRow[];
  /** By game, then baseline. */
  baselines: BaselineRow[];
}

/** `pairing`'s record from `player`'s side (`player` must be in it). */
function sideOf(pairing: PairingSummary, player: string): Record3 {
  const first = pairing.players[0] === player;
  return {
    wins: first ? pairing.wins : pairing.losses,
    draws: pairing.draws,
    losses: first ? pairing.losses : pairing.wins,
  };
}

const rate = (r: Record3, n: number): Interval => wilson(r.wins + r.draws / 2, n);

export function buildLeaderboard(summaries: readonly GameSummary[]): Leaderboard {
  const models = new Map<
    string,
    { label: string; model: string | null; hosting: Hosting | null }
  >();
  for (const s of summaries) {
    for (const p of s.players) {
      if (p.kind === 'provider') {
        models.set(p.player, { label: p.label, model: p.model, hosting: p.hosting });
      }
    }
  }

  const rows: ModelRow[] = [...models].map(([player, meta]) => {
    const games = summaries.map((s): ModelGameCell => {
      const stats = s.players.find((p) => p.player === player);
      const h2h = s.pairings.filter((p) => p.headToHead && p.players.includes(player));
      const matches = h2h.reduce((n, p) => n + p.matches, 0);
      let headToHead: HeadToHeadCell | null = null;
      if (matches > 0) {
        const record = h2h.reduce<Record3>(
          (acc, p) => {
            const side = sideOf(p, player);
            return {
              wins: acc.wins + side.wins,
              draws: acc.draws + side.draws,
              losses: acc.losses + side.losses,
            };
          },
          { wins: 0, draws: 0, losses: 0 },
        );
        headToHead = {
          opponents: h2h
            .filter((p) => p.matches > 0)
            .map((p) => (p.players[0] === player ? p.players[1] : p.players[0])),
          matches,
          ...record,
          winRate: rate(record, matches),
        };
      }
      return {
        game: s.game,
        headToHead,
        accuracy: stats?.accuracy ?? null,
        latencyMs: stats?.latencyMs ?? { p50: null, p95: null, n: 0 },
        costPer1000: stats?.costPer1000 ?? null,
        decisions: stats?.decisions ?? 0,
        missRate: stats?.missRate ?? 0,
        refusals: stats?.refusals ?? 0,
        refusalRate: stats?.refusalRate ?? 0,
      };
    });
    const counted = games.filter((c) => c.headToHead !== null);
    const overall =
      counted.length === 0
        ? null
        : counted.reduce((sum, c) => sum + (c.headToHead?.winRate.p ?? 0), 0) / counted.length;
    return {
      player,
      label: meta.label,
      model: meta.model,
      hosting: meta.hosting,
      overall,
      overallGames: counted.map((c) => c.game),
      games,
    };
  });
  rows.sort((a, b) => {
    if (a.overall !== b.overall) {
      if (a.overall === null) return 1;
      if (b.overall === null) return -1;
      return b.overall - a.overall;
    }
    return a.player < b.player ? -1 : a.player > b.player ? 1 : 0;
  });
  const modelIds = rows.map((r) => r.player).sort();

  const baselineRecords: BaselineRecordRow[] = [];
  const baselines: BaselineRow[] = [];
  for (const s of summaries) {
    const kindOf = new Map(s.players.map((p) => [p.player, p.kind]));
    for (const player of modelIds) {
      const vsBaselines = s.pairings
        .filter(
          (p) =>
            p.matches > 0 &&
            p.players.includes(player) &&
            p.players.some((x) => kindOf.get(x) === 'baseline'),
        )
        .map((p) => {
          const first = p.players[0] === player;
          return {
            pairing: p,
            opponent: first ? p.players[1] : p.players[0],
            opponentLabel: first ? p.labels[1] : p.labels[0],
            label: first ? p.labels[0] : p.labels[1],
          };
        })
        .sort((x, y) => (x.opponent < y.opponent ? -1 : x.opponent > y.opponent ? 1 : 0));
      for (const v of vsBaselines) {
        const record = sideOf(v.pairing, player);
        baselineRecords.push({
          game: s.game,
          player,
          label: v.label,
          opponent: v.opponent,
          opponentLabel: v.opponentLabel,
          matches: v.pairing.matches,
          ...record,
          winRate: rate(record, v.pairing.matches),
        });
      }
    }
    for (const p of s.players) {
      if (p.kind !== 'baseline') continue;
      baselines.push({
        game: s.game,
        player: p.player,
        label: p.label,
        matches: p.matches,
        decisions: p.decisions,
        accuracy: p.accuracy,
        latencyMs: p.latencyMs,
      });
    }
  }

  return {
    schemaVersion: LEADERBOARD_SCHEMA_VERSION,
    formula: OVERALL_FORMULA,
    runIds: [...new Set(summaries.flatMap((s) => s.runIds))].sort(),
    games: summaries.map((s) => ({
      id: s.game,
      label: s.label,
      graded: s.graded,
      matches: {
        valid: s.matches.valid,
        invalid: s.matches.invalid,
        excluded: s.matches.excluded,
        headToHead: s.pairings.filter((p) => p.headToHead).reduce((n, p) => n + p.matches, 0),
      },
      excluded: s.excluded.map((e) => ({ ...e })),
      featured: s.featured?.id ?? null,
      runCheck: s.runCheck,
    })),
    models: rows,
    baselineRecords,
    baselines,
  };
}

/**
 * The warning for a failed run-level check (page, leaderboard.md, summary.md), or null when it
 * passed or doesn't apply: "Run-level miss check failed: OpenAI Decisions (gpt-6-luna) missed
 * 3.1% of its decisions (5 of 160) over this run's valid matches; the limit is 2%."
 */
export function runCheckWarning(check: RunCheck | null): string | null {
  if (check === null || check.passed) return null;
  const who = check.failing
    .map(
      (f) =>
        `${f.label} missed ${formatPercent(f.missRate)} of its decisions ` +
        `(${String(f.misses)} of ${String(f.decisions)})`,
    )
    .join('; ');
  const limit = formatShare(check.maxMissRate);
  return (
    `Run-level miss check failed: ${who} over this run’s valid matches; the limit is ${limit}. ` +
    'The results are shown but don’t meet the miss limit.'
  );
}

/** Where the run ids are explained: the "Run id" section of the core architecture page. */
export const RUN_ID_DOC = 'the “Run id” section of docs/architecture/core.md';

/**
 * The honesty notes printed under the leaderboard (page and Markdown): what the probabilities are,
 * which machine latency was measured from (by run id), how the providers differ, what "valid"
 * means, that timeouts are checked over the whole run, and the exclusion list.
 */
export function leaderboardNotes(
  lb: Pick<Leaderboard, 'runIds'> & {
    games?: readonly (Pick<LeaderboardGame, 'label' | 'runCheck'> &
      Partial<Pick<LeaderboardGame, 'excluded'>>)[];
  },
): string[] {
  const where =
    lb.runIds.length === 0
      ? 'Latency will be wall time per request, measured from one machine whose run id is in every log; there are no provider runs yet.'
      : lb.runIds.length === 1
        ? `Latency is wall time per request, measured from one machine (run id ${lb.runIds[0] ?? ''}), the same for both models; it includes each provider’s network path from that machine.`
        : `Latency is wall time per request, measured on the machine that ran each match, the same for both models in each match; it includes each provider’s network path from that machine. The logs carry run ids ${lb.runIds.join(', ')}: ids from before 2026-10-15 were hashed from the host name, which changed with the network (see ${RUN_ID_DOC}).`;
  return [
    'Probabilities are API-reported: each model’s pick is its API’s top choice, and the bars show what the API returned.',
    where,
    'The two providers are hosted differently (different vendors, networks and regions).',
    'Only valid matches count: a match where either side’s requests fail (network or HTTP errors, malformed responses) on more than 2% of its decisions, or where the machine running it stalled (sleep or suspend), is kept and listed, but not scored.',
    'A timeout is the model’s own miss: it plays no move (real-time games) or scores 0 for that ask (turn games), and it never makes a match invalid, in any game. Invalid matches are rerun, so counting timeouts would drop exactly the matches the slower model lost.',
    'A refusal (the model declining to answer) is not a miss: it never makes a match invalid, and each model’s refusal rate is shown beside its results. Validity is recomputed from the logs with the current rule, so matches logged as invalid under an older rule (timeouts or refusals) are scored.',
    ...runCheckNote(lb.games ?? []),
    ...excludedNote(lb.games ?? []),
  ];
}

/** Said only when a game has matches excluded by hand. */
function excludedNote(games: readonly { label: string; excluded?: readonly ExcludedMatch[] }[]) {
  const n = games.reduce((sum, g) => sum + (g.excluded?.length ?? 0), 0);
  if (n === 0) return [];
  return [
    `${String(n)} ${n === 1 ? 'match is' : 'matches are'} excluded by hand ` +
      '(results/excluded.json) for an infrastructure failure its log can’t show, each listed ' +
      'with its reason under its game. Not scored; the logs stay.',
  ];
}

function runCheckNote(games: readonly Pick<LeaderboardGame, 'label' | 'runCheck'>[]): string[] {
  if (games.length === 0) return [];
  return [
    'Every game also checks the 2% limit over the whole run: a model that misses (times out or ' +
      'errors on) more than 2% of its decisions across the published matches gets a warning on ' +
      'that game.',
  ];
}
