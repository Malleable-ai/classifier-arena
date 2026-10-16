import type { MatchLog } from '../../../core/log/read.js';
import type { DecisionLine } from '../../../core/log/schema.js';
import { createReplayCursor, type ReplayCursor } from '../../../core/replay/replay.js';
import type { InboxState } from '../../../games/inbox/engine/types.js';
import { inboxGame } from '../../../games/inbox/game.js';
import { END_HOLD_FRAMES, frameBase } from '../../shell/frames.js';
import { legibleFloor } from '../../shell/theme.js';
import type { Chapter, FrameInfo, GameRenderer, SeatPair, Timeline } from '../index.js';
import { drawInboxStage } from './draw.js';
import { formatClock, optionLabel, STAGE_H, STAGE_W, TICK_RATE } from './model.js';

/**
 * Inbox Invaders' `GameRenderer`: a frame is a tick. The timeline replays the match with the core
 * replay cursor; everything the stage animates (answered cards, landings, health pulses) comes
 * from the frame's resolved decision lines and logged events, so jumping to a tick draws exactly
 * what playing up to it does, with no window to re-simulate. A finished match holds its last tick
 * for END_HOLD_FRAMES frames. Live mode draws the generic frame.
 */

export interface InboxTimeline extends Timeline<FrameInfo<InboxState>> {
  readonly cursor: ReplayCursor<InboxState>;
}

export function createInboxTimeline(log: MatchLog): InboxTimeline {
  const cursor = createReplayCursor(log, inboxGame);
  const [a, b] = log.header.seats;
  const labels: SeatPair<string> = [a.label, b.label];
  const players: SeatPair<string> = [a.player, b.player];
  // A finished match holds its last tick (the result banner) for END_HOLD_FRAMES more frames.
  const hold = log.matchEnd === null ? 0 : END_HOLD_FRAMES;
  return {
    frames: cursor.lastTick + 1 + hold,
    cursor,
    at(frame) {
      const n = Math.max(0, Math.min(cursor.lastTick + hold, Math.floor(frame)));
      cursor.stepTo(n);
      const tick = cursor.tick;
      return frameBase({
        frame: n,
        tick,
        state: cursor.state,
        labels,
        players,
        cadence: log.header.cadence,
        decisions: log.decisions,
        events: log.events,
      });
    },
    hash: () => cursor.hash(),
  };
}

/** Chapters every this many seconds (after the start). */
export const CHAPTER_EVERY_S = 30;
/** An event chapter starts this many ticks before its event, so the event is seen happening. */
export const EVENT_LEAD_TICKS = 30;
/** Chapters closer than this to an earlier kept one are dropped (no two buttons for one moment). */
export const CHAPTER_GAP_TICKS = 60;

/** The last tick a log reaches: `match_end`, else the latest tick any line mentions. */
function lastTickOf(log: MatchLog): number {
  if (log.matchEnd !== null) return log.matchEnd.totalTicks;
  let last = 0;
  for (const d of log.decisions) last = Math.max(last, d.appliedTick ?? d.sentTick);
  for (const e of log.events) last = Math.max(last, e.tick + 1);
  return last;
}

/**
 * Jump points: the start; the first hit and the first landing (just before each); then every
 * 30 s. Ranked in that order, a chapter within CHAPTER_GAP_TICKS of a better-ranked one is dropped
 * (a baseline's first hit comes a fraction of a second in, so it folds into the start).
 */
export function inboxChapters(log: MatchLog): Chapter[] {
  const rate = log.header.cadence.kind === 'realtime' ? log.header.cadence.tickRate : TICK_RATE;
  const last = lastTickOf(log);
  const ranked: Chapter[] = [{ label: '0:00', title: 'the start', frame: 0 }];
  const firstHit = log.events.find((e) => e.game.kind === 'hit');
  const firstLanding = log.events.find((e) => e.game.kind === 'hit' && e.game.cause === 'landed');
  const lead = (tick: number): number => Math.max(0, tick - EVENT_LEAD_TICKS);
  if (firstHit !== undefined) {
    ranked.push({ label: 'Hit', title: 'the first hit', frame: lead(firstHit.tick) });
  }
  if (firstLanding !== undefined) {
    ranked.push({ label: 'Landed', title: 'the first landing', frame: lead(firstLanding.tick) });
  }
  for (let t = CHAPTER_EVERY_S * rate; t < last; t += CHAPTER_EVERY_S * rate) {
    const label = formatClock(t, rate);
    ranked.push({ label, title: label, frame: t });
  }
  const kept: Chapter[] = [];
  for (const c of ranked) {
    if (kept.every((k) => Math.abs(k.frame - c.frame) >= CHAPTER_GAP_TICKS)) kept.push(c);
  }
  return kept.sort((a, b) => a.frame - b.frame);
}

/** Why Inbox didn't use an answer: it arrived after its message had landed ("too late"). */
export function inboxDroppedLabel(d: DecisionLine): string {
  return d.error === 'dropped: landed' ? 'too late' : 'dropped';
}

export const inboxRenderer: GameRenderer<InboxState> = {
  gameId: inboxGame.id,
  stage: { width: STAGE_W, height: STAGE_H },
  timeline: createInboxTimeline,
  draw(ctx, frame, view) {
    drawInboxStage(ctx, frame, legibleFloor(view.cssScale));
  },
  optionLabel,
  chapters: inboxChapters,
  droppedLabel: inboxDroppedLabel,
};
