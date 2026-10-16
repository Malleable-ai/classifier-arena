import { describe, expect, it } from 'vitest';
import {
  activityRate,
  pickWindow,
  SCORE_WEIGHT,
  type Activity,
} from '../../../src/cli/video/segments.js';

/** A real-time activity: `frames` frames, decisions and score changes at the given frames. */
function activity(
  frames: number,
  decisionsAt: readonly number[],
  scoresAt: readonly number[] = [],
  bounds: readonly number[] | null = null,
): Activity {
  const decisions = new Array<number>(frames).fill(0);
  const scores = new Array<number>(frames).fill(0);
  for (const f of decisionsAt) decisions[f] = (decisions[f] ?? 0) + 1;
  for (const f of scoresAt) scores[f] = (scores[f] ?? 0) + 1;
  return { frames, decisions, scores, bounds };
}

describe('pickWindow (real-time)', () => {
  it('ends with the match: its last `seconds`, the end hold (the result banner) included', () => {
    // 1200 frames, the last 150 the hold; all the action early on.
    const a = { ...activity(1200, [10, 20, 30], [40]), hold: 150 };
    expect(pickWindow(a, 600 / 60)).toMatchObject({ from: 600, to: 1200 });
    // Wherever the busiest stretch is, the window still closes on the last frame.
    const late = { ...activity(1200, [900, 910, 920], [930]), hold: 150 };
    expect(pickWindow(late, 100 / 60)).toMatchObject({ from: 1100, to: 1200 });
  });

  it('takes the whole match when it is shorter than the window', () => {
    expect(pickWindow(activity(50, [5]), 10)).toEqual({ from: 0, to: 50, score: 60 / 50 });
  });

  it('reports the window’s activity: decisions plus SCORE_WEIGHT × score changes, per second', () => {
    const a = activity(600, [500, 510, 520], [550]);
    const w = pickWindow(a, 2);
    expect(w).toMatchObject({ from: 480, to: 600 });
    expect(w.score).toBeCloseTo(((3 + SCORE_WEIGHT) * 60) / 120);
    expect(activityRate(a, 0, 0)).toBe(0);
  });
});

describe('pickWindow (turn games)', () => {
  // Five turns of 100 frames each, the last one with the result hold.
  const bounds = [0, 100, 200, 300, 400, 500];

  it('holds the whole turns that end the match, as many as fit', () => {
    const a = activity(500, [50, 150, 250, 350, 450], [380], bounds);
    const w = pickWindow(a, 250 / 60);
    expect(w).toMatchObject({ from: 300, to: 500 });
    expect(bounds).toContain(w.from);
    // Exactly three turns' worth: all three.
    expect(pickWindow(a, 300 / 60)).toMatchObject({ from: 200, to: 500 });
  });

  it('keeps the last turn even when it is longer than the limit', () => {
    const a = activity(500, [10], [], bounds);
    expect(pickWindow(a, 50 / 60)).toMatchObject({ from: 400, to: 500 });
  });
});
