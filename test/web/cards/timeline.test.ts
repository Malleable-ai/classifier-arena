import { describe, expect, it } from 'vitest';
import {
  CARD_FPS,
  CARD_FRAMES,
  cardOpacity,
  outroTimes,
  ramp,
  stagger,
} from '../../../src/web/cards/timeline.js';

describe('card timing', () => {
  it('lasts 4 s (intro), 1.5 s (a title) and 7.5 s (outro) at 60 fps', () => {
    expect(CARD_FPS).toBe(60);
    expect(CARD_FRAMES).toEqual({ intro: 240, title: 90, outro: 450 });
  });

  it('starts the intro whole (no fade in: its first frame is the thumbnail), fading out', () => {
    expect(cardOpacity(0, CARD_FRAMES.intro, 0)).toBe(1);
    expect(cardOpacity(CARD_FRAMES.intro - 1, CARD_FRAMES.intro, 0)).toBe(0);
  });

  it('ramps 0 → 1 smoothly over its frames', () => {
    expect(ramp(0, 10, 20)).toBe(0);
    expect(ramp(10, 10, 20)).toBe(0);
    expect(ramp(20, 10, 20)).toBeCloseTo(0.5);
    expect(ramp(30, 10, 20)).toBe(1);
    expect(ramp(99, 10, 20)).toBe(1);
    expect(ramp(5, 5, 0)).toBe(1);
    expect(ramp(4, 5, 0)).toBe(0);
    for (let f = 10; f < 30; f++) expect(ramp(f + 1, 10, 20)).toBeGreaterThan(ramp(f, 10, 20));
  });

  it('fades a card in from black and out to black', () => {
    expect(cardOpacity(0, 90, 10, 10)).toBe(0);
    expect(cardOpacity(10, 90, 10, 10)).toBe(1);
    expect(cardOpacity(45, 90, 10, 10)).toBe(1);
    expect(cardOpacity(80, 90, 10, 10)).toBe(1);
    expect(cardOpacity(89, 90, 10, 10)).toBe(0);
    // Out of range clamps to the ends.
    expect(cardOpacity(-5, 90, 10, 10)).toBe(0);
    expect(cardOpacity(500, 90, 10, 10)).toBe(0);
  });

  it('holds the last frame without a fade out (the outro ends the video)', () => {
    expect(cardOpacity(299, 300, 12, 0)).toBe(1);
  });

  it('staggers parts and puts the outro link after the last game row', () => {
    expect(stagger(3, 44, 22)).toEqual([44, 66, 88]);
    const t = outroTimes(3);
    expect(t.games).toEqual([44, 66, 88]);
    expect(t.url).toBeGreaterThan(88);
    // Everything is on screen well before the outro ends: the finished table and the repo link
    // stay whole for at least 5 s.
    expect(t.url + 16).toBeLessThan(CARD_FRAMES.outro / 2);
    expect(CARD_FRAMES.outro - (t.url + 16)).toBeGreaterThanOrEqual(5 * CARD_FPS);
  });
});
