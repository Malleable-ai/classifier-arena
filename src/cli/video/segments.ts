import { FPS } from './args.js';

/**
 * Picking each game's window for the cut (docs/architecture/core.md). Pure: it works on a match's
 * activity, per frame, and returns frame ranges.
 *
 * Every window ends where the match's timeline ends, so a segment closes on the match's actual
 * result: the deciding moment, then the end hold with the result banner (END_HOLD_FRAMES, 2.5 s,
 * part of every finished match's timeline). Real-time windows have a fixed length; turn games'
 * windows hold whole turns (they start on a turn boundary), as many as fit in the length. A
 * window's score, (decisions + SCORE_WEIGHT × score changes) per second, is reported in the plan
 * only: it no longer moves the window.
 */

/** A score change counts this many decisions in a window's activity score. */
export const SCORE_WEIGHT = 4;

export interface Activity {
  /** Frames in the match's timeline. */
  frames: number;
  /** Per frame: decision lines resolving on it (both seats). */
  decisions: readonly number[];
  /** Per frame: score changes on it. */
  scores: readonly number[];
  /**
   * Turn games: the turn boundaries, ascending, from 0 to `frames` (turn t is
   * [bounds[t], bounds[t + 1]); the last one includes the result hold). Null for real-time games.
   */
  bounds: readonly number[] | null;
  /** Frames at the end that hold the finished match (END_HOLD_FRAMES), 0 if none. */
  hold?: number;
}

export interface Window {
  /** First frame. */
  from: number;
  /** The frame it stops before. */
  to: number;
  /** (decisions + SCORE_WEIGHT × score changes) per second. */
  score: number;
}

/** (decisions + SCORE_WEIGHT × score changes) per second over [from, to). */
export function activityRate(a: Activity, from: number, to: number): number {
  if (to <= from) return 0;
  let sum = 0;
  for (let i = from; i < to; i++) sum += (a.decisions[i] ?? 0) + SCORE_WEIGHT * (a.scores[i] ?? 0);
  return (sum * FPS) / (to - from);
}

/**
 * The window that ends with the match: its last `seconds` (the whole match if shorter); for a
 * turn game, the run of whole turns ending at the last frame that lasts at most `seconds` (at
 * least the last turn, even a longer one).
 */
export function pickWindow(a: Activity, seconds: number): Window {
  const length = Math.max(1, Math.round(seconds * FPS));
  const to = a.frames;
  let from = Math.max(0, to - length);
  if (a.bounds !== null) {
    const starts = a.bounds.filter((b) => b < to);
    from = starts.find((b) => to - b <= length) ?? starts.at(-1) ?? 0;
  }
  return { from, to, score: activityRate(a, from, to) };
}
