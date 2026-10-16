/**
 * Nearest-rank percentiles (the leaderboard's p50 and p95 latency). Every result is one of the
 * measured values, never an interpolation, so a reader can find it in the logs. Pure.
 */

/**
 * The value at rank ⌈q × n⌉ (at least 1) of `values` sorted ascending, for `q` in [0, 1]: the
 * smallest value with at least `q` of the values at or below it. Null when there are no values.
 */
export function percentile(values: readonly number[], q: number): number | null {
  if (!(q >= 0 && q <= 1)) throw new RangeError(`q must be in [0, 1], got ${String(q)}`);
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  // The tolerance keeps q × n from landing a hair above a whole rank through float rounding.
  const rank = Math.max(1, Math.ceil(q * sorted.length - 1e-9));
  return sorted[rank - 1] ?? null;
}
