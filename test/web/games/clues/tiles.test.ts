import { describe, expect, it } from 'vitest';
import {
  CONDENSE_MIN,
  DARK_TEXT_ALPHA,
  SHADE_MAX_ALPHA,
  WORD_LEAST_PX,
  WORD_MAX_PX,
  WORD_MIN_PX,
  boundarySplit,
  darkTextOn,
  fitWord,
  wordSizes,
  shadeAlpha,
  wrapText,
} from '../../../../src/web/games/clues/tiles.js';

describe('tile shade', () => {
  it('maps probability 0 → no shade and 1 → the full seat color', () => {
    expect(shadeAlpha(0)).toBe(0);
    expect(shadeAlpha(1)).toBe(SHADE_MAX_ALPHA);
  });

  it('rises with the square root, so small probabilities still show', () => {
    expect(shadeAlpha(0.25)).toBeCloseTo(SHADE_MAX_ALPHA * 0.5);
    expect(shadeAlpha(0.04)).toBeCloseTo(SHADE_MAX_ALPHA * 0.2);
    expect(shadeAlpha(1 / 16)).toBeGreaterThan(0.2);
  });

  it('is monotonic over [0, 1]', () => {
    let prev = -1;
    for (let i = 0; i <= 100; i++) {
      const a = shadeAlpha(i / 100);
      expect(a).toBeGreaterThan(prev);
      prev = a;
    }
  });

  it('treats a missing, invalid or out-of-range probability safely', () => {
    expect(shadeAlpha(null)).toBe(0);
    expect(shadeAlpha(undefined)).toBe(0);
    expect(shadeAlpha(Number.NaN)).toBe(0);
    expect(shadeAlpha(-0.2)).toBe(0);
    expect(shadeAlpha(1.4)).toBe(SHADE_MAX_ALPHA);
  });

  it('switches the tile text to dark on a strong shade', () => {
    expect(darkTextOn(0)).toBe(false);
    expect(darkTextOn(DARK_TEXT_ALPHA - 0.01)).toBe(false);
    expect(darkTextOn(DARK_TEXT_ALPHA)).toBe(true);
    expect(darkTextOn(shadeAlpha(0.6))).toBe(true);
    expect(darkTextOn(shadeAlpha(0.1))).toBe(false);
  });
});

/** A fake font: every letter is 0.6 em wide. */
const measure = (s: string, px: number): number => s.length * px * 0.6;

describe('fitting a word into a tile', () => {
  const maxW = 185;

  it('keeps a short word on one line at the largest size', () => {
    expect(fitWord('eel', maxW, measure)).toEqual({ lines: ['eel'], px: WORD_MAX_PX, scaleX: 1 });
  });

  it('shrinks a longer word before condensing it', () => {
    const fit = fitWord('mackerel', maxW, measure); // 8 letters: fits at 38.5 px … so 40 condensed
    expect(fit.lines).toEqual(['mackerel']);
    expect(fit.px).toBe(WORD_MIN_PX);
    const six = fitWord('salmon', maxW, measure); // 6 × 0.6 × px ≤ 185 → px ≤ 51
    expect(six).toEqual({ lines: ['salmon'], px: 50, scaleX: 1 });
  });

  it('condenses down to CONDENSE_MIN, then goes smaller, always on one line (no hyphen inside)', () => {
    const nine = fitWord('barracuda', maxW, measure); // 216 px at 40 → condensed to 0.86
    expect(nine.lines).toEqual(['barracuda']);
    expect(nine.scaleX).toBeCloseTo(maxW / measure('barracuda', WORD_MIN_PX));
    expect(nine.scaleX).toBeGreaterThanOrEqual(CONDENSE_MIN);
    const twelve = fitWord('precipitator', maxW, measure);
    expect(twelve.lines).toEqual(['precipitator']);
    expect(twelve.px).toBeLessThan(WORD_MIN_PX);
    expect(twelve.px).toBeGreaterThanOrEqual(WORD_LEAST_PX);
    expect(twelve.scaleX).toBeGreaterThanOrEqual(CONDENSE_MIN);
    expect(measure('precipitator', twelve.px) * twelve.scaleX).toBeLessThanOrEqual(maxW + 1e-9);
  });

  it('breaks only at a real boundary (a space or a hyphen), and only when one line can’t fit', () => {
    expect(boundarySplit('steeplejack')).toBeNull();
    expect(boundarySplit('ice cream')).toEqual(['ice', 'cream']);
    expect(boundarySplit('half-life')).toEqual(['half-', 'life']);
    expect(boundarySplit('jack-in-the-box')).toEqual(['jack-in-', 'the-box']);
    const two = fitWord('chocolate chip cookie', maxW, measure);
    expect(two.lines).toEqual(['chocolate', 'chip cookie']);
    for (const line of two.lines) {
      expect(measure(line, two.px) * two.scaleX).toBeLessThanOrEqual(maxW + 1e-9);
    }
    // A word too long for any of that stays on one line, condensed as far as it takes.
    const long = fitWord('pneumonoultramicroscopic', maxW, measure);
    expect(long.lines).toEqual(['pneumonoultramicroscopic']);
    expect(measure(long.lines[0] ?? '', long.px) * long.scaleX).toBeCloseTo(maxW);
  });

  it('at a legibility floor, keeps one line at the floor, and a long word a little under it', () => {
    const sizes = wordSizes(49);
    expect(sizes).toEqual({ max: 55, min: 49, least: 45, twoMax: 51, twoMin: 45 });
    // A floor under the design sizes changes nothing.
    expect(wordSizes(20)).toEqual(wordSizes(0));
    // The square video's widest tile words (tall layout: about 207 px of room).
    for (const word of ['steeplejack', 'dispatcher', 'prospector', 'submersible', 'harpsichord']) {
      const fitted = fitWord(word, 207, measure, sizes);
      expect(fitted.lines, word).toEqual([word]);
      expect(fitted.px, word).toBeGreaterThanOrEqual(sizes.least);
      expect(measure(word, fitted.px) * fitted.scaleX).toBeLessThanOrEqual(207 + 1e-9);
    }
    const short = fitWord('yacht', maxW, measure, sizes);
    expect(short.lines).toEqual(['yacht']);
    expect(short.px).toBeGreaterThanOrEqual(49);
  });
});

describe('wrapping the definition', () => {
  const width = (s: string): number => s.length;

  it('wraps greedily on spaces', () => {
    expect(wrapText('one two three four', 9, width)).toEqual(['one two', 'three', 'four']);
    expect(wrapText('  spaced   out  ', 20, width)).toEqual(['spaced out']);
  });

  it('gives a too-long word its own line', () => {
    expect(wrapText('a supercalifragilistic b', 6, width)).toEqual([
      'a',
      'supercalifragilistic',
      'b',
    ]);
  });
});
