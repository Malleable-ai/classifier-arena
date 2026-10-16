import type { ProviderEntry } from './classifier/providers.js';
import type { GameEstimate } from './game.js';

/**
 * The cost estimate printed before any run that includes a provider (RULES.md: ask above $5), for
 * any game. Per provider seat: (the game's decisions per seat + one warm-up call) × input tokens
 * per call × the provider's input price. The game supplies the decision counts and the measured
 * tokens per call (`game.estimate`); baselines cost nothing. The $5 guard uses the worst case;
 * the typical case is for information only. Pure: no I/O, no clock.
 */

/** Ask before any single run estimated above this (RULES.md). */
export const APPROVAL_LIMIT_USD = 5;

/** A seat to price: its player and the provider's input price, or null for a baseline. */
export interface PricedSeat {
  player: string;
  price: { inputPerMTokUsd: number } | null;
}

export interface SeatEstimate {
  player: string;
  /** False for a baseline: no calls, no cost. */
  paid: boolean;
  /** True when the game has measured input tokens for this player. */
  measured: boolean;
  /** Worst case per match: the decisions plus one warm-up call (0 for a baseline). */
  calls: number;
  inputTokensPerCall: number;
  inputTokens: number;
  /** Worst case per match. */
  costUsd: number;
  /** Typical case per match: decisions plus the warm-up. */
  typicalCalls: number;
  typicalUsd: number;
}

export interface MatchEstimate {
  /** One entry per seat, in seat order. Costs are per match. */
  perSeat: SeatEstimate[];
  matches: number;
  /** Worst case over all matches. The approval guard uses this. */
  totalUsd: number;
  /** Typical case over all matches, for information. */
  typicalUsd: number;
  /** `formatEstimate` of the above. */
  text: string;
}

export interface EstimateOptions {
  /** How many matches the run plays (default 1). */
  matches?: number;
}

/** Each player's seat, priced from the provider registry (anything else is a free baseline). */
export function pricedSeats(
  players: readonly string[],
  providers: readonly ProviderEntry[],
): PricedSeat[] {
  return players.map((player) => ({
    player,
    price: providers.find((p) => p.id === player)?.price ?? null,
  }));
}

function seatEstimate(game: GameEstimate, { player, price }: PricedSeat): SeatEstimate {
  const measured = Object.hasOwn(game.inputTokens, player);
  const free: SeatEstimate = {
    player,
    paid: false,
    measured,
    calls: 0,
    inputTokensPerCall: 0,
    inputTokens: 0,
    costUsd: 0,
    typicalCalls: 0,
    typicalUsd: 0,
  };
  if (price === null) return free;
  const tokensPerCall =
    (measured ? game.inputTokens[player] : undefined) ?? game.fallbackInputTokens;
  const byPlayer = game.decisionsPerSeatByPlayer ?? {};
  const decisions =
    (Object.hasOwn(byPlayer, player) ? byPlayer[player] : undefined) ?? game.decisionsPerSeat;
  const usd = (calls: number): number =>
    (calls * tokensPerCall * price.inputPerMTokUsd) / 1_000_000;
  const calls = decisions.worst + 1; // + warm-up
  const typicalCalls = decisions.typical + 1;
  return {
    ...free,
    paid: true,
    calls,
    inputTokensPerCall: tokensPerCall,
    inputTokens: calls * tokensPerCall,
    costUsd: usd(calls),
    typicalCalls,
    typicalUsd: usd(typicalCalls),
  };
}

/** Estimate `opts.matches` matches (default 1) of a game between `seats`. */
export function estimateMatch(
  game: GameEstimate,
  seats: readonly PricedSeat[],
  opts: EstimateOptions = {},
): MatchEstimate {
  const matches = opts.matches ?? 1;
  if (!Number.isInteger(matches) || matches < 1) {
    throw new RangeError(`matches must be an integer ≥ 1, got ${String(matches)}`);
  }
  const perSeat = seats.map((s) => seatEstimate(game, s));
  const perMatch = perSeat.reduce((sum, s) => sum + s.costUsd, 0);
  const typical = perSeat.reduce((sum, s) => sum + s.typicalUsd, 0);
  const est = { perSeat, matches, totalUsd: perMatch * matches, typicalUsd: typical * matches };
  return { ...est, text: formatEstimate(est) };
}

/** One row per paid seat, then the worst-case total and the typical one. */
export function formatEstimate(est: Omit<MatchEstimate, 'text'>): string {
  const paid = est.perSeat.filter((s) => s.paid);
  if (paid.length === 0) return 'Cost estimate: $0 (no paid players)';
  const rows = paid.map(
    (s) =>
      `  ${s.player}: ${String(s.calls)} calls (${String(s.calls - 1)} decisions + warm-up), ` +
      `${(s.inputTokens / 1000).toFixed(0)}K input tokens, $${s.costUsd.toFixed(4)}` +
      (s.measured
        ? ''
        : ` (not measured; assumed ${String(s.inputTokensPerCall)} tokens per decision)`),
  );
  return [
    `Cost estimate (worst case, ${String(est.matches)} match(es)):`,
    ...rows,
    `  total: $${est.totalUsd.toFixed(4)} worst case ($${est.typicalUsd.toFixed(4)} typical)`,
  ].join('\n');
}
