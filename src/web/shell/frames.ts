import { resolvedTick } from '../../core/replay/replay.js';
import type { DecisionLine, EventLine, HeaderLine, LogLine } from '../../core/log/schema.js';
import type { FrameInfo, InFlight, SeatPair } from '../games/index.js';
import { playerColors } from './theme.js';

/**
 * The game-independent parts of a frame (src/web/games/index.ts): which decision lines have
 * resolved by a tick or turn, the latest per seat, and the events so far. Replay timelines and
 * live mode both build their frames here, so the panel reads the same thing in both.
 */

export type Cadence = HeaderLine['cadence'];

/**
 * Frames every game's timeline holds the end of a finished match for (2.5 s at 60 fps), so the
 * result banner and the last moment (the fighter's K.O. fall) are seen in replays, render mode and
 * the video cuts. Part of `Timeline.frames`, so `window.renderFrame` and `pnpm render` include it.
 */
export const END_HOLD_FRAMES = 150;

/**
 * When a decision line's outcome is known, in the frame's `tick` units. Real-time: the tick its
 * choice was fed to the game, else the tick its answer (or timeout) arrived (`resolvedTick`).
 * Turns: once its turn has been played.
 */
export function resolvedAt(cadence: Cadence): (d: DecisionLine) => number {
  if (cadence.kind === 'realtime') {
    const rate = cadence.tickRate;
    return (d) => resolvedTick(d, rate);
  }
  return (d) => (d.appliedTick ?? d.sentTick) + 1;
}

/** The lines resolved by `tick`, ordered by when they resolved (log order breaks ties). */
export function resolvedBy(
  lines: readonly DecisionLine[],
  tick: number,
  cadence: Cadence,
): DecisionLine[] {
  const at = resolvedAt(cadence);
  return lines
    .map((d, i) => ({ d, at: at(d), i }))
    .filter((e) => e.at <= tick)
    .sort((a, b) => a.at - b.at || a.i - b.i)
    .map((e) => e.d);
}

/**
 * The request each seat has in flight at `tick`, from the decision line it becomes: sent by then
 * and not yet resolved (`resolvedAt`). Real-time: sent on an earlier tick (a request sent on tick
 * T goes out while T is simulated, after the frame at T). Turns: the turn being played (or an
 * earlier one). Only the line's seq, question key and sent tick are kept, never its answer, so a
 * frame can't show an answer early. A log line is written once its request resolves, so a live
 * match (no future lines) has nothing in flight here.
 */
export function inFlightAt(
  lines: readonly DecisionLine[],
  tick: number,
  cadence: Cadence,
): SeatPair<InFlight | null> {
  const at = resolvedAt(cadence);
  const sent =
    cadence.kind === 'realtime'
      ? (d: DecisionLine) => d.sentTick < tick
      : (d: DecisionLine) => d.sentTick <= tick;
  const out: [InFlight | null, InFlight | null] = [null, null];
  for (const d of lines) {
    if (!sent(d) || at(d) <= tick) continue;
    const cur = out[d.seat];
    // One request per seat at a time; if a log ever overlaps two, keep the latest sent.
    if (cur === null || d.sentTick >= cur.sentTick) {
      out[d.seat] = { seq: d.seq, questionKey: d.questionKey, sentTick: d.sentTick };
    }
  }
  return out;
}

/** The last line per seat of `resolved` (already in resolution order). */
export function latestPerSeat(resolved: readonly DecisionLine[]): SeatPair<DecisionLine | null> {
  const latest: [DecisionLine | null, DecisionLine | null] = [null, null];
  for (const d of resolved) latest[d.seat] = d;
  return latest;
}

export interface FrameParts<S> {
  frame: number;
  tick: number;
  state: S;
  labels: SeatPair<string>;
  /** Both seats' player ids (the header's `player`), for their colors; '' when unknown. */
  players: SeatPair<string>;
  cadence: Cadence;
  /** Every decision line so far (any order the log has them in). */
  decisions: readonly DecisionLine[];
  /** Every event line so far. */
  events: readonly EventLine[];
  note?: string;
}

/**
 * The generic frame at `tick`: decisions resolved by then, the requests still in flight, events
 * logged before it.
 */
export function frameBase<S>(p: FrameParts<S>): FrameInfo<S> {
  const decisions = resolvedBy(p.decisions, p.tick, p.cadence);
  const frame: FrameInfo<S> = {
    frame: p.frame,
    tick: p.tick,
    state: p.state,
    labels: p.labels,
    colors: playerColors(p.players),
    decisions,
    latestDecisions: latestPerSeat(decisions),
    inFlight: inFlightAt(p.decisions, p.tick, p.cadence),
    events: p.events.filter((e) => e.tick < p.tick),
  };
  if (p.note !== undefined) frame.note = p.note;
  return frame;
}

/** Decision and event lines out of a stream of log lines (live mode's in-memory log). */
export function splitLines(lines: readonly LogLine[]): {
  decisions: DecisionLine[];
  events: EventLine[];
} {
  const decisions: DecisionLine[] = [];
  const events: EventLine[] = [];
  for (const l of lines) {
    if (l.type === 'decision') decisions.push(l);
    else if (l.type === 'event') events.push(l);
  }
  return { decisions, events };
}
