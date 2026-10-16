import { REFUSAL_ERROR, type Seat } from '../../../src/core/classifier/types.js';
import type { MatchLog } from '../../../src/core/log/read.js';
import type {
  DecisionLine,
  HeaderLine,
  HeaderSeat,
  MatchEndLine,
} from '../../../src/core/log/schema.js';
import { matchIdFor } from '../../../src/core/results/paths.js';
import type { SummaryGame } from '../../../src/core/stats/summary.js';

/**
 * Hand-built v2 match logs for the stats tests, so every expected number can be worked out by
 * hand. `jev` and `openai` are provider seats (format, model, price); anything else is a baseline.
 */

export const INBOX: SummaryGame = {
  id: 'inbox',
  label: 'Inbox Invaders',
  version: 1,
  graded: true,
  baselines: ['scripted'],
  baselineLabels: { scripted: 'Always legit' },
};

export const FIGHTER: SummaryGame = {
  id: 'fighter',
  label: 'Fighter',
  version: 1,
  graded: false,
  baselines: ['scripted', 'human'],
  baselineLabels: { scripted: 'Scripted bot', human: 'Human (live mode)' },
};

/** A turn game (`fakeLog` gives its logs the turn cadence). */
export const CLUES: SummaryGame = {
  id: 'clues',
  label: 'Clue Clash',
  version: 1,
  graded: true,
  baselines: [],
};

const LABELS: Readonly<Record<string, string>> = {
  jev: 'Jev (TypeSafe)',
  openai: 'OpenAI Decisions (gpt-6-luna)',
  random: 'Random (uniform)',
  scripted: 'Scripted bot',
};

export const isProviderId = (p: string): boolean => p === 'jev' || p === 'openai';

export function seatOf(player: string, seat: Seat, warmupCostUsd = 0): HeaderSeat {
  const label = LABELS[player] ?? player;
  if (!isProviderId(player)) {
    return {
      seat,
      player,
      label,
      format: null,
      hosting: null,
      model: null,
      serviceTier: null,
      modelVersion: null,
      price: null,
      warmup: null,
    };
  }
  return {
    seat,
    player,
    label,
    format: player === 'jev' ? 'systemone' : 'openai-decisions',
    hosting: 'vendor-api',
    model: player === 'jev' ? 'jev-latest' : 'gpt-6-luna',
    serviceTier: 'default',
    modelVersion: `${player}-v1`,
    price: { inputPerMTokUsd: 0.1, outputPerMTokUsd: 0, asOf: '2026-10-07' },
    warmup: { latencyMs: 300, status: 'ok', costUsd: warmupCostUsd },
  };
}

/** A decision line for `seat` (an `ok` pick of `legit` after 100 ms unless overridden). */
export function decision(seat: Seat, over: Partial<DecisionLine> = {}): DecisionLine {
  return {
    type: 'decision',
    seat,
    seq: 0,
    questionKey: 'q',
    sentTick: 0,
    appliedTick: 1,
    latencyMs: 100,
    choice: 'legit',
    probabilities: null,
    confidence: null,
    inputTokens: null,
    costUsd: 0,
    status: 'ok',
    ...over,
  };
}

/** A transport failure for `seat` (an HTTP 503): it counts toward validity in every game. */
export function failure(seat: Seat, over: Partial<DecisionLine> = {}): DecisionLine {
  return decision(seat, {
    status: 'error',
    error: 'http 503: unavailable',
    choice: null,
    appliedTick: null,
    ...over,
  });
}

/**
 * A refusal for `seat`: the model declined to answer (billed, no choice). `legacy` writes it the
 * way logs did before the `refusal` status: `status: 'error'` with REFUSAL_ERROR.
 */
export function refusal(
  seat: Seat,
  over: Partial<DecisionLine> = {},
  legacy = false,
): DecisionLine {
  return decision(seat, {
    status: legacy ? 'error' : 'refusal',
    error: REFUSAL_ERROR,
    choice: null,
    appliedTick: null,
    ...over,
  });
}

export interface FakeMatch {
  game?: string;
  /** Seat 0 then seat 1. */
  players: [string, string];
  winner: Seat | 'draw' | null;
  scores: [number, number];
  /**
   * `match_end.valid` as logged (default true). The stats recompute validity from the decisions,
   * so a log with `valid: false` and no `decisions` gets one transport failure for seat 0, making
   * it invalid under the rule too. With `decisions` given, they decide.
   *
   * A valid real-time log without `decisions` gives each provider seat one `ok` decision (100 ms,
   * ungraded, free; `defaultDecisions`): a real-time provider seat with no decisions makes a match
   * invalid.
   */
  valid?: boolean;
  totalTicks?: number;
  /** Disambiguates match ids (the n-th match of the pairing). Default 1. */
  run?: number;
  /** `HH:MM:SS` of the match id. Default 12:00:00. */
  time?: string;
  decisions?: DecisionLine[];
  runLocation?: string;
  /** Default `sim`. */
  runId?: string;
  gameVersion?: number;
  warmupCostUsd?: [number, number];
  /** False: the run stopped before match_end. */
  finished?: boolean;
}

/** A complete v2 log: header, the given decisions (seq renumbered per seat), match_end. */
export function fakeLog(m: FakeMatch): MatchLog {
  const game = m.game ?? INBOX.id;
  const [a, b] = m.players;
  const matchId = matchIdFor({
    game,
    a,
    b,
    when: `2026-10-08T${m.time ?? '12:00:00'}`,
    run: m.run ?? 1,
  });
  const warm = m.warmupCostUsd ?? [0, 0];
  const header: HeaderLine = {
    type: 'header',
    schemaVersion: 2,
    game,
    gameVersion: m.gameVersion ?? 1,
    matchId,
    startTime: '2026-10-08T17:00:00.000Z',
    gitCommit: 'abc123',
    seed: m.run ?? 1,
    runLocation: m.runLocation ?? 'sim',
    runId: m.runId ?? 'sim',
    cadence: game === CLUES.id ? { kind: 'turns' } : { kind: 'realtime', tickRate: 60 },
    timing: { floorMs: 100, timeoutMs: 1000 },
    promptConfigHash: '0000000000000000',
    optionOrderRule: 'test',
    config: {},
    seats: [seatOf(a, 0, warm[0]), seatOf(b, 1, warm[1])],
  };
  const seq: [number, number] = [0, 0];
  const given = m.decisions ?? defaultDecisions(m.players, header.cadence.kind, m.valid !== false);
  const decisions = given.map((d) => ({ ...d, seq: seq[d.seat]++ }));
  const costUsd = decisions.reduce((sum, d) => sum + d.costUsd, 0) + warm[0] + warm[1];
  const matchEnd: MatchEndLine = {
    type: 'match_end',
    winner: m.winner,
    scores: m.scores,
    totalTicks: m.totalTicks ?? 600,
    finalStateHash: '0123456789abcdef',
    valid: m.valid ?? true,
    missRates: [0, 0],
    decisions: [seq[0], seq[1]],
    costUsd,
  };
  return { header, decisions, events: [], matchEnd: m.finished === false ? null : matchEnd };
}

/**
 * What a log without `decisions` gets: one transport failure for seat 0 when invalid; else, in a
 * real-time game, one `ok` decision per provider seat (100 ms, ungraded, free).
 */
export function defaultDecisions(
  players: readonly [string, string],
  cadence: 'realtime' | 'turns',
  valid: boolean,
): DecisionLine[] {
  if (!valid) return [failure(0)];
  if (cadence !== 'realtime') return [];
  return ([0, 1] as const)
    .filter((seat) => isProviderId(players[seat]))
    .map((seat) => decision(seat));
}

/** The log as JSONL, the way the writer lays it out. */
export function toJsonl(log: MatchLog): string {
  const lines: unknown[] = [log.header, ...log.decisions, ...log.events];
  if (log.matchEnd !== null) lines.push(log.matchEnd);
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}

/**
 * A valid Jev vs OpenAI Clue Clash match of 16 turns where each seat times out on its first
 * `misses[seat]` turns (a turn game's timeout no longer makes a match invalid).
 */
export function cluesMatch(misses: [number, number], run = 1): MatchLog {
  const turns = (seat: Seat, n: number): DecisionLine[] =>
    Array.from({ length: 16 }, (_, t) =>
      t < n
        ? decision(seat, {
            sentTick: t,
            appliedTick: t,
            status: 'timeout',
            error: 'timeout',
            choice: null,
            latencyMs: 1000,
          })
        : decision(seat, { sentTick: t, appliedTick: t, correct: true }),
    );
  return fakeLog({
    game: CLUES.id,
    players: ['jev', 'openai'],
    winner: 0,
    scores: [16 - misses[0], 16 - misses[1]],
    totalTicks: 16,
    run,
    decisions: [...turns(0, misses[0]), ...turns(1, misses[1])],
  });
}
