/**
 * The Wilson score interval for a proportion (the leaderboard's head-to-head win rates with a 95%
 * interval). Unlike the normal approximation it stays inside [0, 1] and behaves at 0/n and n/n,
 * which small samples (50 matches) hit. Pure.
 */

/** A proportion and its interval, all in [0, 1]. */
export interface Interval {
  p: number;
  low: number;
  high: number;
}

/**
 * `successes` out of `n`, with `z` standard errors (1.96 for 95%). `successes` may be fractional,
 * because a draw counts as half a win. With `n = 0` there is no information: p 0 over [0, 1].
 */
export function wilson(successes: number, n: number, z = 1.96): Interval {
  if (!Number.isInteger(n) || n < 0) {
    throw new RangeError(`n must be a non-negative integer, got ${String(n)}`);
  }
  if (!Number.isFinite(successes) || successes < 0 || successes > n) {
    throw new RangeError(`successes must be in [0, ${String(n)}], got ${String(successes)}`);
  }
  if (n === 0) return { p: 0, low: 0, high: 1 };
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { p, low: Math.max(0, center - half), high: Math.min(1, center + half) };
}
