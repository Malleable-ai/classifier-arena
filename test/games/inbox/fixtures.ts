import type { RealtimeInput } from '../../../src/core/game.js';
import { createInbox, stepInbox } from '../../../src/games/inbox/engine/sim.js';
import type {
  InboxConfig,
  InboxState,
  MessageRef,
  StreamItem,
} from '../../../src/games/inbox/engine/types.js';

/** A small, fixed schedule: a spawn every 10 ticks, each falls for 30. */
export const SMALL: InboxConfig = {
  health: 100,
  damage: 10,
  smishingMultiplier: 3,
  maxChars: 240,
  streamLength: 6,
  spawn: { startTicks: 10, endTicks: 10, rampTicks: 1 },
  fall: { startTicks: 30, endTicks: 30, rampTicks: 1 },
};

export const MESSAGES: readonly MessageRef[] = [
  { id: 'sms-1', label: 'legit' },
  { id: 'sms-2', label: 'spam' },
  { id: 'sms-3', label: 'smishing' },
  { id: 'sms-4', label: 'legit' },
  { id: 'sms-5', label: 'spam' },
  { id: 'sms-6', label: 'smishing' },
  { id: 'sms-7', label: 'legit' },
  { id: 'sms-8', label: 'legit' },
];

export const SEED = 20261007;

export function small(config: Partial<InboxConfig> = {}, seed = SEED): InboxState {
  return createInbox(seed, { ...SMALL, ...config }, MESSAGES);
}

/** The stream item at index `i`, or throw. */
export function itemAt(s: InboxState, i: number): StreamItem {
  const item = s.stream[i];
  if (!item) throw new Error(`no stream item ${String(i)}`);
  return item;
}

/** A wrong label for `item`. */
export function wrongFor(item: StreamItem): string {
  return item.label === 'legit' ? 'spam' : 'legit';
}

export const answer = (item: StreamItem, choice: string = item.label): RealtimeInput => ({
  choice,
  questionKey: item.id,
});

/** Step with no inputs until `tick` (exclusive of further steps). */
export function runTo(s: InboxState, tick: number): void {
  while (s.tick < tick && !s.over) stepInbox(s, [null, null]);
}

/** The first stream index whose label is `label`, or throw. */
export function firstWithLabel(s: InboxState, label: StreamItem['label']): number {
  const i = s.stream.findIndex((it) => it.label === label);
  if (i < 0) throw new Error(`no ${label} in the stream`);
  return i;
}
