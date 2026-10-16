import type { DecisionCounts, GameEstimate } from '../../core/game.js';
import { FLOOR_MS } from '../../core/sched/shared.js';
import { TICK_RATE } from './engine/constants.js';
import { defaultMaxTicks } from './engine/run.js';
import { DEFAULT_CONFIG } from './engine/sim.js';

/**
 * The fighter's numbers for the generic estimate (src/core/estimate.ts): `fighterGame.estimate`.
 *
 * Per provider seat: decisions/s (one request in flight, so ≈ 1000 / max(floor, p50 latency)) ×
 * match length, plus the warm-up the generic estimate adds. The $5 guard uses the worst case: the
 * engine's longest match (every round to time, plus pauses). Spike numbers:
 * docs/research/decision-apis.md, "Spike results (2026-10-07)".
 */

/** Longest possible match: `defaultMaxTicks` (maxRounds full rounds + pauses) ≈ 307.5 s. */
export const MATCH_SECONDS_WORST_CASE = defaultMaxTicks(DEFAULT_CONFIG) / TICK_RATE;
/**
 * Typical match, for information only (never used for the guard): the shortest match that goes
 * the distance, `roundsToWin` full rounds + pauses ≈ 123 s.
 */
export const MATCH_SECONDS_TYPICAL =
  (DEFAULT_CONFIG.roundsToWin * (DEFAULT_CONFIG.roundTicks + DEFAULT_CONFIG.roundPauseTicks)) /
  TICK_RATE;

export interface SpikeStats {
  p50LatencyMs: number;
  inputTokensPerCall: number;
}

export const SPIKE_STATS: Readonly<Record<string, SpikeStats>> = {
  jev: { p50LatencyMs: 170, inputTokensPerCall: 1166 },
  openai: { p50LatencyMs: 184, inputTokensPerCall: 782 },
};

/** Unmeasured providers: assume the floor cadence and a generous prompt. */
export const DEFAULT_STATS: SpikeStats = { p50LatencyMs: FLOOR_MS, inputTokensPerCall: 2000 };

/** Decisions one seat makes in `matchSeconds` at its p50 latency (never faster than the floor). */
function decisionsIn(stats: SpikeStats, matchSeconds: number): number {
  const decisionsPerSecond = 1000 / Math.max(FLOOR_MS, stats.p50LatencyMs);
  return Math.ceil(decisionsPerSecond * matchSeconds);
}

const countsFor = (stats: SpikeStats): DecisionCounts => ({
  typical: decisionsIn(stats, MATCH_SECONDS_TYPICAL),
  worst: decisionsIn(stats, MATCH_SECONDS_WORST_CASE),
});

const spikes = Object.entries(SPIKE_STATS);

export const fighterEstimate: GameEstimate = {
  decisionsPerSeat: countsFor(DEFAULT_STATS),
  decisionsPerSeatByPlayer: Object.fromEntries(spikes.map(([id, s]) => [id, countsFor(s)])),
  inputTokens: Object.fromEntries(spikes.map(([id, s]) => [id, s.inputTokensPerCall])),
  fallbackInputTokens: DEFAULT_STATS.inputTokensPerCall,
};
