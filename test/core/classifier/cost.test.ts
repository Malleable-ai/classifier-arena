import { describe, expect, it } from 'vitest';
import { costUsd } from '../../../src/core/classifier/cost.js';

const price = { usdPerMillionInputTokens: 2.5, asOf: '2026-10-01' };

describe('costUsd', () => {
  it('is input tokens times the per-token price', () => {
    expect(costUsd(price, 1_000_000)).toBe(2.5);
    expect(costUsd(price, 400)).toBeCloseTo(0.001, 12);
  });

  it('is 0 for unknown or zero tokens', () => {
    expect(costUsd(price, null)).toBe(0);
    expect(costUsd(price, 0)).toBe(0);
  });

  it('rejects negative token counts', () => {
    expect(() => costUsd(price, -1)).toThrow();
  });
});
