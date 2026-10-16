import type { Seat } from '../../../core/classifier/types.js';
import type { GameResult, RealtimeInput, Settlement } from '../../../core/game.js';
import { createPrng, nextBelow } from '../../../core/util/prng.js';
import { buildSchedule, validateConfig } from './schedule.js';
import {
  OUTCOME,
  type HitCause,
  type InboxConfig,
  type InboxEvent,
  type InboxLabel,
  type InboxState,
  type Lane,
  type MessageRef,
  type StreamItem,
} from './types.js';

/**
 * The Inbox Invaders simulation (docs/architecture/inbox.md). Pure and deterministic: no clock, DOM
 * or Math.random, integers only in the state. Two lanes share one seeded stream of messages on one
 * schedule; each seat answers in its own lane only.
 *
 * Tick order (`stepInbox` on a state at tick T):
 *   1. Each seat's input is applied to its own lane: an answer for an active message resolves it
 *      (right: cleared at no cost; wrong: damage) and settles `applied`; anything else settles
 *      `dropped` with reason `landed`, `resolved` or `unknown`.
 *   2. The tick advances to T + 1; messages whose spawnTick ≤ T + 1 spawn into both lanes.
 *   3. Active messages whose landTick ≤ T + 1 land in each lane that still has them (damage).
 *   4. The game ends when a lane's health reaches 0, or every message has spawned and both lanes
 *      are empty. Damage is `config.damage`, times `smishingMultiplier` for smishing.
 */

const SEATS: readonly Seat[] = [0, 1];

/** Stream index by message id, per stream array (a stream never changes after create). */
const indexCache = new WeakMap<readonly StreamItem[], ReadonlyMap<string, number>>();

/** The stream index of message `id`, or -1. */
export function streamIndex(s: InboxState, id: string): number {
  let index = indexCache.get(s.stream);
  if (!index) {
    index = new Map(s.stream.map((item, i) => [item.id, i]));
    indexCache.set(s.stream, index);
  }
  return index.get(id) ?? -1;
}

function itemOf(s: InboxState, id: string): StreamItem {
  const item = s.stream[streamIndex(s, id)];
  if (!item) throw new Error(`inbox: no stream item ${JSON.stringify(id)}`);
  return item;
}

export function damageOf(config: InboxConfig, label: InboxLabel): number {
  return config.damage * (label === 'smishing' ? config.smishingMultiplier : 1);
}

function cloneConfig(c: InboxConfig): InboxConfig {
  return { ...c, spawn: { ...c.spawn }, fall: { ...c.fall } };
}

/**
 * A new match: the messages in a seeded order (sfc32 Fisher–Yates over the whole list), the first
 * `streamLength` of them on the schedule, both lanes at full health with every message due at
 * tick 0 already spawned. The stream is frozen (it never changes after create, so clones share
 * it). Throws on a bad config, a stream longer than the list or duplicate ids.
 */
export function createInbox(
  seed: number,
  config: InboxConfig,
  messages: readonly MessageRef[],
): InboxState {
  validateConfig(config);
  if (config.streamLength > messages.length) {
    throw new RangeError(
      `inbox config: streamLength ${String(config.streamLength)} exceeds the ` +
        `${String(messages.length)} messages`,
    );
  }
  const ids = new Set<string>();
  for (const { id } of messages) {
    if (ids.has(id)) throw new Error(`inbox: duplicate message id ${JSON.stringify(id)}`);
    ids.add(id);
  }
  const order = messages.map((_, i) => i);
  const prng = createPrng(seed >>> 0);
  for (let i = order.length - 1; i > 0; i--) {
    const j = nextBelow(prng, i + 1);
    const a = order[i];
    const b = order[j];
    if (a === undefined || b === undefined) throw new Error('unreachable');
    order[i] = b;
    order[j] = a;
  }
  const stream = buildSchedule(config).map(({ spawnTick, landTick }, i): StreamItem => {
    const m = messages[order[i] ?? -1];
    if (!m) throw new Error('unreachable');
    return Object.freeze({ id: m.id, label: m.label, spawnTick, landTick });
  });
  Object.freeze(stream);
  const lane = (): Lane => ({
    health: config.health,
    active: [],
    cleared: 0,
    wrong: 0,
    landed: 0,
    answered: 0,
    correct: 0,
    outcomes: stream.map(() => OUTCOME.pending),
  });
  const state: InboxState = {
    tick: 0,
    seed: seed >>> 0,
    config: cloneConfig(config),
    stream,
    next: 0,
    lanes: [lane(), lane()],
    over: false,
  };
  spawnDue(state);
  return state;
}

/** A deep copy, except the stream: it is immutable after create, so the clone shares it. */
export function cloneInbox(s: InboxState): InboxState {
  const lane = (l: Lane): Lane => ({ ...l, active: [...l.active], outcomes: [...l.outcomes] });
  return {
    tick: s.tick,
    seed: s.seed,
    config: cloneConfig(s.config),
    stream: s.stream,
    next: s.next,
    lanes: [lane(s.lanes[0]), lane(s.lanes[1])],
    over: s.over,
  };
}

/** Spawn every message due by `s.tick` into both lanes, keeping each lane soonest-to-land first. */
function spawnDue(s: InboxState): void {
  for (;;) {
    const item = s.stream[s.next];
    if (!item || item.spawnTick > s.tick) return;
    for (const lane of s.lanes) {
      // After any active message landing at the same tick or earlier (stable).
      let at = lane.active.length;
      while (at > 0 && itemOf(s, lane.active[at - 1] ?? '').landTick > item.landTick) at--;
      lane.active.splice(at, 0, item.id);
    }
    s.next++;
  }
}

function hit(
  s: InboxState,
  seat: Seat,
  item: StreamItem,
  cause: HitCause,
  events: InboxEvent[],
): void {
  const lane = s.lanes[seat];
  const damage = damageOf(s.config, item.label);
  lane.health = Math.max(0, lane.health - damage);
  events.push({ kind: 'hit', seat, id: item.id, cause, damage, health: lane.health });
}

function landDue(s: InboxState, events: InboxEvent[]): void {
  for (const seat of SEATS) {
    const lane = s.lanes[seat];
    for (;;) {
      const id = lane.active[0];
      if (id === undefined) break;
      const item = itemOf(s, id);
      if (item.landTick > s.tick) break;
      lane.active.shift();
      lane.landed++;
      lane.outcomes[streamIndex(s, id)] = OUTCOME.landed;
      hit(s, seat, item, 'landed', events);
    }
  }
}

/** Why an answer for `id` can't be applied in `lane`. */
function dropReason(s: InboxState, lane: Lane, id: string): string {
  const i = streamIndex(s, id);
  if (i < 0 || i >= s.next) return 'unknown';
  const outcome = lane.outcomes[i];
  if (outcome === OUTCOME.landed) return 'landed';
  if (outcome === OUTCOME.cleared || outcome === OUTCOME.wrong) return 'resolved';
  return 'unknown';
}

function applyAnswer(
  s: InboxState,
  seat: Seat,
  input: RealtimeInput,
  events: InboxEvent[],
): Settlement {
  const { choice, questionKey } = input;
  const lane = s.lanes[seat];
  const pos = lane.active.indexOf(questionKey);
  if (pos < 0) {
    return { seat, choice, outcome: 'dropped', reason: dropReason(s, lane, questionKey) };
  }
  const i = streamIndex(s, questionKey);
  const item = itemOf(s, questionKey);
  lane.active.splice(pos, 1);
  lane.answered++;
  if (choice === item.label) {
    lane.cleared++;
    lane.correct++;
    lane.outcomes[i] = OUTCOME.cleared;
    return { seat, choice, outcome: 'applied', correct: true };
  }
  lane.wrong++;
  lane.outcomes[i] = OUTCOME.wrong;
  hit(s, seat, item, 'wrong', events);
  return { seat, choice, outcome: 'applied', correct: false };
}

function isEnd(s: InboxState): boolean {
  const [a, b] = s.lanes;
  if (a.health <= 0 || b.health <= 0) return true;
  return s.next >= s.stream.length && a.active.length === 0 && b.active.length === 0;
}

/** Simulates one tick (see the tick order above), mutating `s`. Throws once the game is over. */
export function stepInbox(
  s: InboxState,
  inputs: readonly [RealtimeInput | null, RealtimeInput | null],
): { settlements: Settlement[]; events: InboxEvent[] } {
  if (s.over) throw new Error(`inbox: step after the game is over (tick ${String(s.tick)})`);
  const settlements: Settlement[] = [];
  const events: InboxEvent[] = [];
  for (const seat of SEATS) {
    const input = inputs[seat];
    if (input) settlements.push(applyAnswer(s, seat, input, events));
  }
  s.tick += 1;
  spawnDue(s);
  landDue(s, events);
  if (isEnd(s)) {
    s.over = true;
    events.push({
      kind: 'game_over',
      winner: winnerOf(s),
      health: [s.lanes[0].health, s.lanes[1].health],
    });
  }
  return { settlements, events };
}

/**
 * Higher health wins; equal health goes to the higher accuracy (correct / answered, compared by
 * cross-multiplying; a seat that answered nothing has accuracy 0); then a draw.
 */
function winnerOf(s: InboxState): Seat | 'draw' {
  const [a, b] = s.lanes;
  if (a.health !== b.health) return a.health > b.health ? 0 : 1;
  const accA = a.correct * Math.max(b.answered, 1);
  const accB = b.correct * Math.max(a.answered, 1);
  if (accA !== accB) return accA > accB ? 0 : 1;
  return 'draw';
}

export function inboxResult(s: InboxState): GameResult {
  const scores: [number, number] = [Math.max(0, s.lanes[0].health), Math.max(0, s.lanes[1].health)];
  if (!s.over) return { over: false, winner: null, scores };
  return { over: true, winner: winnerOf(s), scores };
}

/** The soonest-to-land active message in this seat's lane, or null when the lane is empty. */
export function soonest(s: InboxState, seat: Seat): StreamItem | null {
  const id = s.lanes[seat].active[0];
  return id === undefined ? null : itemOf(s, id);
}

/** The seat has something to answer and the game is still on. */
export function canAskLane(s: InboxState, seat: Seat): boolean {
  return !s.over && s.lanes[seat].active.length > 0;
}
