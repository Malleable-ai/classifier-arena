/**
 * Pure helpers for the Clue Clash boards: how a tile is shaded by an API-reported probability,
 * which text color reads on that shade, and how a word is fitted into a tile on one line (shrink,
 * then a horizontal condense; never a hyphen inside a word). No canvas here: text is measured
 * through a callback, so tests can run in Node.
 */

/** Fill alpha of the seat color at probability 1. */
export const SHADE_MAX_ALPHA = 0.92;
/** From this fill alpha up, tile text switches to dark (both seat colors are light). */
export const DARK_TEXT_ALPHA = 0.5;

/**
 * The seat-color fill alpha for an API-reported probability: 0 for none, rising with √p, so a
 * 5% option is still visible next to a 60% one. Clamped to [0, 1]; the legend uses the same map.
 */
export function shadeAlpha(p: number | null | undefined): number {
  if (p === null || p === undefined || !Number.isFinite(p) || p <= 0) return 0;
  return SHADE_MAX_ALPHA * Math.sqrt(Math.min(1, p));
}

/** True when tile text should be dark on a fill of `alpha` (light seat colors underneath). */
export function darkTextOn(alpha: number): boolean {
  return alpha >= DARK_TEXT_ALPHA;
}

/** `ctx.measureText(text).width` at a font size in px (the caller sets the family and weight). */
export type MeasureText = (text: string, px: number) => number;

export interface WordFit {
  /** One line, or two when the word has a real boundary to break at (a space or a hyphen). */
  lines: string[];
  px: number;
  /** Horizontal scale (1 = none): a condense before a word goes any smaller. */
  scaleX: number;
}

/** Largest and smallest one-line size, then the two-line sizes, in logical px. */
export const WORD_MAX_PX = 52;
export const WORD_MIN_PX = 40;
/** The smallest a one-line word gets on the design stage before it is condensed past CONDENSE_MIN. */
export const WORD_LEAST_PX = 32;
export const TWO_LINE_MAX_PX = 46;
export const TWO_LINE_MIN_PX = 32;

export interface WordSizes {
  max: number;
  /** One line shrinks to this, then is condensed (down to CONDENSE_MIN) … */
  min: number;
  /** … and shrinks on, condensed, to this before anything else. */
  least: number;
  twoMax: number;
  twoMin: number;
}

export const WORD_SIZES: WordSizes = {
  max: WORD_MAX_PX,
  min: WORD_MIN_PX,
  least: WORD_LEAST_PX,
  twoMax: TWO_LINE_MAX_PX,
  twoMin: TWO_LINE_MIN_PX,
};

/**
 * The sizes for a stage whose must-read text is at least `floor` logical px (legibleFloor): one
 * line at the floor, and if a long word needs it, a little under (92% of it: about 25 px of the
 * 1080 square). A floor under the design sizes changes nothing.
 */
export function wordSizes(floor: number): WordSizes {
  const f = Math.round(floor);
  return {
    max: Math.max(WORD_MAX_PX, f + 6),
    min: Math.max(WORD_MIN_PX, f),
    least: Math.max(WORD_LEAST_PX, Math.round(f * 0.92)),
    twoMax: Math.max(TWO_LINE_MAX_PX, f + 2),
    twoMin: Math.max(TWO_LINE_MIN_PX, f - 4),
  };
}
/** The narrowest condense before a word goes smaller (glyphs stay readable down to about 75%). */
export const CONDENSE_MIN = 0.76;

/**
 * Where a word can be broken without cutting into it: at a space (dropped) or after a hyphen
 * (kept on the first line), as balanced as it can be. Null for a word with neither (most of them:
 * those are never broken).
 */
export function boundarySplit(word: string): [string, string] | null {
  let best: [string, string] | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let i = 1; i < word.length - 1; i++) {
    const c = word[i];
    if (c !== ' ' && c !== '-') continue;
    const parts: [string, string] =
      c === ' ' ? [word.slice(0, i), word.slice(i + 1)] : [word.slice(0, i + 1), word.slice(i + 1)];
    const score = Math.max(parts[0].length, parts[1].length);
    if (score < bestScore) {
      bestScore = score;
      best = parts;
    }
  }
  return best;
}

/**
 * Fits `word` into a tile `maxW` wide, on one line: the largest size from `max` down to `min`;
 * then condensed (down to CONDENSE_MIN) and on down to `least`; then, only for a word with a real
 * boundary (a space or a hyphen), two lines broken there; else one line at `least`, condensed as
 * far as it takes. Never a hyphen inside a word.
 */
export function fitWord(
  word: string,
  maxW: number,
  measure: MeasureText,
  sizes: WordSizes = WORD_SIZES,
): WordFit {
  for (let px = sizes.max; px >= sizes.min; px -= 2) {
    if (measure(word, px) <= maxW) return { lines: [word], px, scaleX: 1 };
  }
  for (let px = sizes.min; px >= sizes.least; px -= 2) {
    const w = measure(word, px);
    if (w * CONDENSE_MIN <= maxW) return { lines: [word], px, scaleX: Math.min(1, maxW / w) };
  }
  const parts = boundarySplit(word);
  if (parts !== null) {
    const [a, b] = parts;
    const widest = (px: number): number => Math.max(measure(a, px), measure(b, px));
    for (let px = sizes.twoMax; px >= sizes.twoMin; px -= 2) {
      const w = widest(px);
      if (w * CONDENSE_MIN <= maxW) return { lines: [a, b], px, scaleX: Math.min(1, maxW / w) };
    }
  }
  return { lines: [word], px: sizes.least, scaleX: maxW / measure(word, sizes.least) };
}

/** Greedy word wrap of `text` into lines no wider than `maxW` (a too-long word gets its own line). */
export function wrapText(text: string, maxW: number, width: (s: string) => number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter((w) => w !== '')) {
    const next = line === '' ? word : `${line} ${word}`;
    if (line !== '' && width(next) > maxW) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line !== '') lines.push(line);
  return lines;
}
