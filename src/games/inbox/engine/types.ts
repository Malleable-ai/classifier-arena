import type { Seat } from '../../../core/classifier/types.js';
import type { InboxLabel } from '../data-build.js';

export type { InboxLabel };

/**
 * Inbox Invaders engine types (docs/architecture/inbox.md). Every number in the state is an
 * integer, so the hash is the same in Node and every browser. Times are ticks at 60 Hz.
 */

/**
 * A value that moves linearly from `startTicks` (at tick 0) to `endTicks` (at `rampTicks` and
 * after), rounded down to whole ticks: `start - floor((start - end) * min(t, ramp) / ramp)`.
 */
export interface Ramp {
  startTicks: number;
  endTicks: number;
  rampTicks: number;
}

export interface InboxConfig {
  /** Each lane's starting health. */
  health: number;
  /** Health lost per wrong answer or landed message (times `smishingMultiplier` for smishing). */
  damage: number;
  smishingMultiplier: number;
  /** Longest message text a seat is shown (the view trims anything longer). */
  maxChars: number;
  /** Messages in the stream (a seeded order of the dataset, cut to this length). */
  streamLength: number;
  /** Ticks from one spawn to the next, by the tick of the earlier spawn. */
  spawn: Ramp;
  /** Ticks from a message's spawn to its landing, by its spawn tick. */
  fall: Ramp;
}

/** What the engine needs from the dataset: no text (the view looks that up by id). */
export interface MessageRef {
  id: string;
  label: InboxLabel;
}

/** One message of the stream, the same for both lanes. Active while spawnTick ≤ tick < landTick. */
export interface StreamItem {
  id: string;
  label: InboxLabel;
  spawnTick: number;
  landTick: number;
}

/** What became of one stream item in one lane (`Lane.outcomes`). */
export const OUTCOME = { pending: 0, cleared: 1, wrong: 2, landed: 3 } as const;
export type Outcome = (typeof OUTCOME)[keyof typeof OUTCOME];

/**
 * One seat's inbox. Invariants: `answered = cleared + wrong`, `correct = cleared` (kept both so the
 * accuracy tie-break and the renderer read plainly).
 */
export interface Lane {
  /** Never below 0. */
  health: number;
  /** Ids of the spawned, unresolved messages, soonest to land first. */
  active: string[];
  /** Messages answered right (cleared at no cost). */
  cleared: number;
  /** Messages answered wrong (cleared, with damage). */
  wrong: number;
  /** Messages that landed unanswered (damage). */
  landed: number;
  /** Answers applied to an active message (dropped answers don't count). */
  answered: number;
  /** Answers that were right. */
  correct: number;
  /**
   * Per stream index, what became of that message in this lane (OUTCOME). Tells a late answer for
   * a landed message from one for a message already answered, and lets a renderer colour cards.
   */
  outcomes: Outcome[];
}

export interface InboxState {
  /** Ticks simulated. The state is "at tick `tick`": spawns and landings up to it have happened. */
  tick: number;
  seed: number;
  config: InboxConfig;
  /** The whole stream, in spawn order, fixed (and frozen) at create; clones share it. */
  stream: StreamItem[];
  /** Index of the next stream item to spawn (= stream.length once all have spawned). */
  next: number;
  lanes: [Lane, Lane];
  over: boolean;
}

export type HitCause = 'wrong' | 'landed';

/** A lane lost health: a wrong answer or a landed message. `health` is after the hit. */
export type HitEvent = {
  kind: 'hit';
  seat: Seat;
  id: string;
  cause: HitCause;
  damage: number;
  health: number;
};

export type GameOverEvent = {
  kind: 'game_over';
  winner: Seat | 'draw';
  health: [number, number];
};

export type InboxEvent = HitEvent | GameOverEvent;
