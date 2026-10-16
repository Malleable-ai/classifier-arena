/**
 * Card timing (docs/architecture/core.md, "Video cards"): how long each card lasts and when its
 * parts appear, as pure functions of the frame index at 60 fps. A card's frame depends on nothing
 * else, so it renders the same every time.
 */

export const CARD_FPS = 60;

/**
 * Card lengths in frames: a 4 s intro (all of it on screen from its first frame, so the video's
 * thumbnail is the whole card), a 1.5 s title per game, a 7.5 s outro (its table and the repo
 * link stay whole on screen for the last 5 s and more).
 */
export const CARD_FRAMES = { intro: 240, title: 90, outro: 450 } as const;

/** Whole-card fade in and out. */
export const FADE_FRAMES = 12;
/** A part's own fade in. */
export const PART_FRAMES = 16;

/** Smoothstep 0 → 1 over [start, start + frames); 0 before, 1 after. */
export function ramp(frame: number, start: number, frames: number): number {
  if (frames <= 0) return frame >= start ? 1 : 0;
  const t = Math.max(0, Math.min(1, (frame - start) / frames));
  return t * t * (3 - 2 * t);
}

/**
 * The card's opacity at `frame`: in over the first `fadeIn` frames, out over the last `fadeOut`
 * (0 for no fade out). Frames outside the card clamp to its ends.
 */
export function cardOpacity(
  frame: number,
  frames: number,
  fadeIn = FADE_FRAMES,
  fadeOut = FADE_FRAMES,
): number {
  const f = Math.max(0, Math.min(frames - 1, frame));
  const inA = ramp(f, 0, fadeIn);
  const outA = fadeOut <= 0 ? 1 : 1 - ramp(f, frames - fadeOut, fadeOut - 1);
  return Math.min(inA, outA);
}

/** `count` start frames: `first`, then every `step` frames. */
export function stagger(count: number, first: number, step: number): number[] {
  return Array.from({ length: count }, (_, i) => first + i * step);
}

/** When each part of each card appears (frames from the card's start). The intro has no build. */
export const TITLE_TIMES = { name: 0, description: 14 } as const;
/** Outro: heading, the overall row, one row per game, then the repo link. */
export function outroTimes(games: number): {
  heading: number;
  overall: number;
  games: number[];
  url: number;
} {
  const rows = stagger(games, 44, 22);
  return { heading: 0, overall: 20, games: rows, url: (rows.at(-1) ?? 20) + 36 };
}
