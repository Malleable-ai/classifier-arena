import { describe, expect, it } from 'vitest';
import { wilson } from '../../../src/core/stats/wilson.js';

/**
 * Wilson score intervals against published values (z = 1.96), e.g. 8/10 → 0.490–0.943 and
 * 0/10 → 0–0.278, and worked by hand for half wins (draws count ½).
 */

describe('wilson', () => {
  it.each([
    // successes, n, p, low, high
    [5, 10, 0.5, 0.2366, 0.7634],
    [8, 10, 0.8, 0.4902, 0.9433],
    [0, 10, 0, 0, 0.2775],
    [10, 10, 1, 0.7225, 1],
    [0, 3, 0, 0, 0.5615],
    [1, 1, 1, 0.2065, 1],
  ])('%d/%d → p %d, %d–%d', (s, n, p, low, high) => {
    const w = wilson(s, n);
    expect(w.p).toBeCloseTo(p, 10);
    expect(w.low).toBeCloseTo(low, 4);
    expect(w.high).toBeCloseTo(high, 4);
  });

  it('takes fractional successes (a draw is half a win)', () => {
    // 1 win, 1 draw, 1 loss: 1.5 / 3.
    const w = wilson(1.5, 3);
    expect(w.p).toBe(0.5);
    expect(w.low).toBeCloseTo(0.1253, 4);
    expect(w.high).toBeCloseTo(0.8747, 4);
    // 2 wins, 1 draw, 1 loss: 2.5 / 4.
    const v = wilson(2.5, 4);
    expect(v.p).toBe(0.625);
    expect(v.low).toBeCloseTo(0.2194, 4);
    expect(v.high).toBeCloseTo(0.9081, 4);
  });

  it('is symmetric: the other side of a pairing is 1 − p with the bounds flipped', () => {
    const w = wilson(2.5, 4);
    const v = wilson(1.5, 4);
    expect(v.p).toBeCloseTo(1 - w.p, 12);
    expect(v.low).toBeCloseTo(1 - w.high, 12);
    expect(v.high).toBeCloseTo(1 - w.low, 12);
  });

  it('a wider z gives a wider interval', () => {
    const narrow = wilson(5, 10, 1.645);
    const wide = wilson(5, 10, 2.576);
    expect(narrow.high - narrow.low).toBeLessThan(wide.high - wide.low);
  });

  it('n = 0 says nothing: p 0 over the whole [0, 1]', () => {
    expect(wilson(0, 0)).toEqual({ p: 0, low: 0, high: 1 });
  });

  it.each([
    [-1, 10],
    [11, 10],
    [1, -1],
    [Number.NaN, 10],
    [1, 2.5],
  ])('refuses %d/%d', (s, n) => {
    expect(() => wilson(s, n)).toThrow(RangeError);
  });
});
