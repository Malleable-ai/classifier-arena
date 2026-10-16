import { gameBaselines } from '../../../src/core/classifier/baselines.js';
import type { Seat } from '../../../src/core/classifier/types.js';
import type { MatchLog } from '../../../src/core/log/read.js';
import type { DecisionLine } from '../../../src/core/log/schema.js';
import { buildLeaderboard, type Leaderboard } from '../../../src/core/stats/leaderboard.js';
import { summarizeGame, type GameSummary } from '../../../src/core/stats/summary.js';
import { createPrng, nextBelow, type PrngState } from '../../../src/core/util/prng.js';
import { GAMES } from '../../../src/games/index.js';
import { decision, failure, fakeLog, refusal } from '../../core/stats/helpers.js';
import { NO_EXCLUSIONS } from '../../../src/core/results/excluded.js';

/**
 * FAKE results, for the page tests and the dev loop only (`/?fixture=1` in `pnpm dev`; the
 * production builds drop it). Seeded logs run through the real summarizer and leaderboard, so the
 * page sees the real shapes with every table filled. These numbers mean nothing and never go
 * under `results/`.
 */

export interface FixtureResults {
  leaderboard: Leaderboard;
  /** By game id. */
  summaries: Record<string, GameSummary>;
}

interface Profile {
  /** Latency range, ms. */
  latency: [number, number];
  accuracy: number;
  costPerDecision: number;
}

const PROFILES: Readonly<Record<string, Profile>> = {
  jev: { latency: [140, 420], accuracy: 0.88, costPerDecision: 0.00002 },
  openai: { latency: [260, 900], accuracy: 0.84, costPerDecision: 0.0003 },
  random: { latency: [200, 200], accuracy: 0.33, costPerDecision: 0 },
  scripted: { latency: [200, 200], accuracy: 0.5, costPerDecision: 0 },
};

/** Jev's chance of winning a head-to-head, per game. */
const JEV_WINS: Readonly<Record<string, number>> = { fighter: 0.62, inbox: 0.56, clues: 0.46 };

const chance = (prng: PrngState, p: number): boolean => nextBelow(prng, 10_000) < p * 10_000;

/**
 * Turn games: one timeout in this many provider decisions; OpenAI's fixture times out far more
 * (about 3%), so `/?fixture=1` shows a failed run-level miss check on Clue Clash. Real-time games
 * have none (0), so only Clue Clash shows the warning.
 */
const timeoutOneIn = (player: string, turns: boolean): number =>
  !turns ? 0 : player === 'openai' ? 30 : 400;

/** OpenAI's fixture refuses about one decision in this many, in every game (never invalid). */
const REFUSE_ONE_IN = 80;

function decisions(
  prng: PrngState,
  seat: Seat,
  player: string,
  game: (typeof GAMES)[number],
  n: number,
): DecisionLine[] {
  const p = PROFILES[player] ?? { latency: [200, 200], accuracy: 0.3, costPerDecision: 0 };
  const graded = game.graded;
  const oneIn = timeoutOneIn(player, game.cadence.kind === 'turns');
  return Array.from({ length: n }, (_, i) => {
    const [lo, hi] = p.latency;
    const latencyMs = lo + nextBelow(prng, hi - lo + 1);
    if (player === 'openai' && nextBelow(prng, REFUSE_ONE_IN) === 0) {
      return refusal(seat, { latencyMs, costUsd: p.costPerDecision, sentTick: i });
    }
    if (p.costPerDecision > 0 && oneIn > 0 && nextBelow(prng, oneIn) === 0) {
      return decision(seat, {
        status: 'timeout',
        error: 'timeout',
        choice: null,
        appliedTick: null,
        latencyMs: 1000,
        costUsd: p.costPerDecision,
        costEstimated: true,
        sentTick: i,
      });
    }
    return decision(seat, {
      latencyMs,
      costUsd: p.costPerDecision,
      sentTick: i,
      ...(graded ? { correct: chance(prng, p.accuracy) } : {}),
    });
  });
}

function match(
  prng: PrngState,
  game: (typeof GAMES)[number],
  players: [string, string],
  aWins: number,
  run: number,
  valid = true,
): MatchLog {
  const draw = chance(prng, 0.06);
  const aWon = chance(prng, aWins);
  const winner: Seat | 'draw' = draw ? 'draw' : aWon ? 0 : 1;
  const hi = 20 + nextBelow(prng, 60);
  const lo = draw ? hi : Math.max(0, hi - 1 - nextBelow(prng, 25));
  const scores: [number, number] = winner === 1 ? [lo, hi] : [hi, lo];
  const n = 20 + nextBelow(prng, 20);
  const paid = players.some((p) => p === 'jev' || p === 'openai');
  const log = fakeLog({
    game: game.id,
    players,
    winner,
    scores,
    valid,
    run,
    gameVersion: game.version,
    totalTicks: 1200 + nextBelow(prng, 6000),
    runLocation: paid ? 'fixture-bench' : 'sim',
    runId: paid ? 'm-fixture' : 'sim',
    warmupCostUsd: [
      PROFILES[players[0]]?.costPerDecision ?? 0,
      PROFILES[players[1]]?.costPerDecision ?? 0,
    ],
    decisions: [
      ...decisions(prng, 0, players[0], game, n),
      ...decisions(prng, 1, players[1], game, n),
      // The stats recompute validity: an invalid fixture match needs a transport failure.
      ...(valid ? [] : [failure(0, { sentTick: n })]),
    ],
  });
  const labels = new Map(gameBaselines(game).map((b) => [b.id, b.label]));
  for (const s of log.header.seats) s.label = labels.get(s.player) ?? s.label;
  return log;
}

export function fixtureResults(): FixtureResults {
  const prng = createPrng(20261008);
  const summaries: Record<string, GameSummary> = {};
  for (const game of GAMES) {
    const logs: MatchLog[] = [];
    let run = 0;
    const jevWins = JEV_WINS[game.id] ?? 0.5;
    for (let i = 0; i < 50; i++) {
      const seats: [string, string] = i % 2 === 0 ? ['jev', 'openai'] : ['openai', 'jev'];
      logs.push(match(prng, game, seats, i % 2 === 0 ? jevWins : 1 - jevWins, ++run));
    }
    logs.push(match(prng, game, ['jev', 'openai'], 0.5, ++run, false));
    for (const model of ['jev', 'openai']) {
      for (const baseline of ['random', ...game.baselines.filter((b) => b !== 'human')]) {
        for (let i = 0; i < 10; i++) {
          const seats: [string, string] = i % 2 === 0 ? [model, baseline] : [baseline, model];
          logs.push(match(prng, game, seats, i % 2 === 0 ? 0.9 : 0.1, ++run));
        }
      }
    }
    summaries[game.id] = summarizeGame(game, logs, NO_EXCLUSIONS);
  }
  return {
    leaderboard: buildLeaderboard(GAMES.map((g) => summaries[g.id]).filter((s) => s !== undefined)),
    summaries,
  };
}
