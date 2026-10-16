import type { MatchLog } from '../../core/log/read.js';
import type { CluesState } from '../../games/clues/engine/types.js';
import type { MatchState } from '../../games/fighter/engine/types.js';
import type { InboxState } from '../../games/inbox/engine/types.js';
import { rendererFor } from '../../web/games/index.js';
import type { Activity } from './segments.js';

/**
 * A match's activity per frame (segments.ts), read by playing its log through the game's web
 * timeline in Node: the same frames the video shows, so a window's frames are the video's.
 */

/** The numbers whose changes count as score changes, per game. */
export function scoreSignal(game: string, state: unknown): number[] {
  if (game === 'fighter') {
    const s = state as MatchState;
    return s.fighters.flatMap((f) => [f.health, f.roundsWon]);
  }
  if (game === 'inbox') {
    const s = state as InboxState;
    return s.lanes.map((l) => l.health);
  }
  if (game === 'clues') {
    const s = state as CluesState;
    return [...s.scores];
  }
  return [];
}

export function activityOf(log: MatchLog): Activity {
  const game = log.header.game;
  const renderer = rendererFor(game);
  if (renderer === null) throw new Error(`no renderer for ${game}`);
  const timeline = renderer.timeline(log);
  const decisions: number[] = [];
  const scores: number[] = [];
  let prevDecisions = 0;
  let prevSignal: number[] | null = null;
  let hold = 0;
  for (let n = 0; n < timeline.frames; n++) {
    const f = timeline.at(n);
    // Real-time: a frame past its tick is the end hold.
    if (log.header.cadence.kind === 'realtime' && f.frame > f.tick) hold++;
    decisions.push(Math.max(0, f.decisions.length - prevDecisions));
    prevDecisions = f.decisions.length;
    const signal = scoreSignal(game, f.state);
    const prev = prevSignal;
    scores.push(prev === null ? 0 : signal.filter((v, i) => v !== prev[i]).length);
    prevSignal = signal;
  }
  const bounds =
    log.header.cadence.kind === 'turns'
      ? [...renderer.chapters(log).map((c) => c.frame), timeline.frames]
      : null;
  return { frames: timeline.frames, decisions, scores, bounds, hold };
}
