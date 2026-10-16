import type { Seat } from '../classifier/types.js';
import type { Interval } from './wilson.js';

/**
 * How the summaries, the leaderboard Markdown and the leaderboard page print numbers, so they all
 * agree. `null` (no data) prints as an em dash. Pure.
 */

export const NONE = '—';

/** 0.625 → "62.5%". */
export function formatPercent(x: number | null): string {
  return x === null ? NONE : `${(x * 100).toFixed(1)}%`;
}

/** A limit or share with no trailing zeros: 0.02 → "2%", 0.025 → "2.5%". */
export function formatShare(x: number): string {
  return `${String(Math.round(x * 1000) / 10)}%`;
}

/** An interval's bounds: "20.7–90.8%". */
export function formatInterval(i: Interval): string {
  return `${(i.low * 100).toFixed(1)}–${(i.high * 100).toFixed(1)}%`;
}

/** 183.26 → "183 ms". */
export function formatMs(x: number | null): string {
  return x === null ? NONE : `${String(Math.round(x))} ms`;
}

/**
 * "$0", "$0.00046" and "$0.021" (two significant digits under $1), "$1.50". Always plain
 * decimals, never exponent form ("$0.0000012", not "$1.2e-6").
 */
export function formatUsd(x: number | null): string {
  if (x === null) return NONE;
  if (x === 0) return '$0';
  if (x >= 1) return `$${x.toFixed(2)}`;
  const precise = x.toPrecision(2);
  if (!precise.includes('e')) return `$${precise}`;
  // toPrecision switches to exponent form under 1e-6: write the same two digits out in full.
  const rounded = Number(precise);
  return `$${rounded.toFixed(Math.min(100, 1 - Math.floor(Math.log10(rounded))))}`;
}

/**
 * A finished match in words, the winner's score first: "Jev wins 34–33", "Draw 33–33". A win on
 * equal scores (a game's tiebreak, such as Clue Clash's latency) says so: "Jev wins on the
 * tiebreak (33–33)", so it never reads as a draw. `names` are seat 0's and seat 1's.
 */
export function formatResult(
  names: readonly [string, string],
  winner: Seat | 'draw' | null,
  scores: readonly [number, number],
): string {
  const [a, b] = scores;
  if (winner !== 0 && winner !== 1) return `Draw ${String(a)}–${String(b)}`;
  const score = winner === 0 ? `${String(a)}–${String(b)}` : `${String(b)}–${String(a)}`;
  return a === b
    ? `${names[winner]} wins on the tiebreak (${score})`
    : `${names[winner]} wins ${score}`;
}

/** Wins–draws–losses: "3–0–1". */
export function formatRecord(r: { wins: number; draws: number; losses: number }): string {
  return `${String(r.wins)}–${String(r.draws)}–${String(r.losses)}`;
}
