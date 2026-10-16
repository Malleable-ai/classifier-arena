import type { Seat } from '../../core/classifier/types.js';
import { ELLIPSIS, trimText } from './data-build.js';
import { messageText } from './data.js';
import { soonest } from './engine/sim.js';
import type { InboxState } from './engine/types.js';

/**
 * What a seat sees (docs/architecture/inbox.md): the soonest-to-land unresolved message in its own
 * lane and how long until it lands. Nothing about the other lane. Both seats see the same text for
 * the same message. State format version 1 (INBOX_PROMPT_CONFIG.stateFormatVersion).
 */
export type InboxView = {
  text: string;
  /** Ticks until it lands / 60, rounded to one decimal. */
  seconds_to_land: number;
};

/** What `inboxGame.view` returns for an empty lane. It is never sent: the lane can't be asked. */
export const EMPTY_LANE_VIEW: InboxView = { text: '', seconds_to_land: 0 };

/** Seconds for a tick count at 60 Hz, rounded to 0.1 s (half up). */
export function secondsToLand(ticks: number): number {
  return Math.round(ticks / 6) / 10;
}

/**
 * `text` cut to `max` characters plus `…`, unless it already fits. A text the data build trimmed
 * at the same length (`max` characters + `…`) is left as it is.
 */
export function fitText(text: string, max: number): string {
  if (text.length <= max) return text;
  if (text.length === max + ELLIPSIS.length && text.endsWith(ELLIPSIS)) return text;
  return trimText(text, max);
}

/** The view for `seat`, or null when its lane is empty (it is then never asked). */
export function inboxView(s: InboxState, seat: Seat): InboxView | null {
  const item = soonest(s, seat);
  if (!item) return null;
  return {
    text: fitText(messageText(item.id), s.config.maxChars),
    seconds_to_land: secondsToLand(item.landTick - s.tick),
  };
}
