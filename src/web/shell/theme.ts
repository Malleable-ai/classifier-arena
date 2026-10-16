/** Shared drawing constants for every game's stage and the decision panel. */

export const FONT_STACK = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

/**
 * One color per model, whichever seat it sits in, used by the panel, every game's stage and the
 * video cards: Jev is always teal and OpenAI Decisions always amber (different hue and
 * blue/yellow axis, so they separate for CVD too). Seats still keep their places (P1 left, P2
 * right); only the colors follow the model.
 */
export const MODEL_COLORS: Readonly<Record<string, string>> = {
  jev: '#2dd4bf',
  openai: '#fbbf24',
};

/**
 * Players without a model color (baselines, a human, an unknown seat), by seat: slate and violet,
 * so they never read as one of the models and two of them still tell apart.
 */
export const NEUTRAL_COLORS: readonly [string, string] = ['#cbd5e1', '#c084fc'];

/** The color a player draws in from `seat`: its model's, else the seat's neutral one. */
export function playerColor(player: string, seat: 0 | 1): string {
  return Object.hasOwn(MODEL_COLORS, player) ? (MODEL_COLORS[player] ?? '') : NEUTRAL_COLORS[seat];
}

/** Both seats' colors for a match between `players` (seat 0 first; '' for an unknown seat). */
export function playerColors(players: readonly [string, string]): readonly [string, string] {
  return [playerColor(players[0], 0), playerColor(players[1], 1)];
}

export function font(px: number, weight = 700): string {
  return `${String(weight)} ${String(Math.round(px))}px ${FONT_STACK}`;
}

/** `#rrggbb` at alpha `a`. */
export function hexA(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${String((n >> 16) & 255)}, ${String((n >> 8) & 255)}, ${String(n & 255)}, ${a.toFixed(3)})`;
}

/**
 * The smallest size, in CSS px on the viewer's screen, of any text a viewer must read (names,
 * scores, health, the round, answer words). 10 CSS px on a 390 px wide phone is about 28 px of a
 * 1080 × 1080 video.
 */
export const MIN_TEXT_CSS_PX = 10;
/** The floor never goes above this many logical px (a stage's layout has room up to here). */
export const MAX_TEXT_FLOOR = 56;

/**
 * The smallest logical px for must-read text on a stage shown at `cssScale` CSS px per logical px
 * (StageView.cssScale): stages raise small text to this. On a desktop player it is below every
 * stage's own sizes, so it changes nothing there; in the square video and on phones it lifts
 * small text to MIN_TEXT_CSS_PX (at most MAX_TEXT_FLOOR).
 */
export function legibleFloor(cssScale: number): number {
  return cssScale > 0 ? Math.min(MAX_TEXT_FLOOR, MIN_TEXT_CSS_PX / cssScale) : 0;
}
