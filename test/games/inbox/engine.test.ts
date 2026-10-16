import { describe, expect, it } from 'vitest';
import type { Settlement } from '../../../src/core/game.js';
import {
  buildSchedule,
  inboxMaxTicks,
  rampAt,
  validateConfig,
} from '../../../src/games/inbox/engine/schedule.js';
import {
  canAskLane,
  cloneInbox,
  createInbox,
  damageOf,
  inboxResult,
  soonest,
  stepInbox,
} from '../../../src/games/inbox/engine/sim.js';
import { OUTCOME, type InboxState } from '../../../src/games/inbox/engine/types.js';
import {
  MESSAGES,
  SEED,
  SMALL,
  answer,
  firstWithLabel,
  itemAt,
  runTo,
  small,
  wrongFor,
} from './fixtures.js';

describe('rampAt', () => {
  const r = { startTicks: 20, endTicks: 8, rampTicks: 120 };

  it('moves linearly from start to end, rounding the drop down, then holds the end', () => {
    expect(rampAt(r, 0)).toBe(20);
    expect(rampAt(r, 1)).toBe(20);
    expect(rampAt(r, 60)).toBe(14);
    expect(rampAt(r, 119)).toBe(9);
    expect(rampAt(r, 120)).toBe(8);
    expect(rampAt(r, 100_000)).toBe(8);
  });

  it('holds a flat ramp', () => {
    expect(rampAt({ startTicks: 10, endTicks: 10, rampTicks: 1 }, 0)).toBe(10);
    expect(rampAt({ startTicks: 10, endTicks: 10, rampTicks: 1 }, 50)).toBe(10);
  });
});

describe('buildSchedule', () => {
  it('spawns the first message at tick 0 and the rest by the spawn ramp; lands by the fall ramp', () => {
    const config = {
      ...SMALL,
      streamLength: 5,
      spawn: { startTicks: 30, endTicks: 10, rampTicks: 60 },
      fall: { startTicks: 100, endTicks: 40, rampTicks: 60 },
    };
    expect(buildSchedule(config)).toEqual([
      { spawnTick: 0, landTick: 100 },
      { spawnTick: 30, landTick: 30 + 70 },
      { spawnTick: 50, landTick: 50 + 50 },
      { spawnTick: 64, landTick: 64 + 40 },
      { spawnTick: 74, landTick: 74 + 40 },
    ]);
    expect(inboxMaxTicks(config)).toBe(115);
  });

  it('gives maxTicks = last landTick + 1', () => {
    const last = buildSchedule(SMALL).at(-1);
    expect(last).toEqual({ spawnTick: 50, landTick: 80 });
    expect(inboxMaxTicks(SMALL)).toBe(81);
  });
});

describe('validateConfig', () => {
  it('accepts the small config', () => {
    expect(() => {
      validateConfig(SMALL);
    }).not.toThrow();
  });

  it.each([
    ['health', { health: 0 }],
    ['damage', { damage: 1.5 }],
    ['smishingMultiplier', { smishingMultiplier: 0 }],
    ['maxChars', { maxChars: 0 }],
    ['streamLength', { streamLength: 0 }],
    ['spawn.endTicks', { spawn: { startTicks: 10, endTicks: 0, rampTicks: 1 } }],
    ['fall.rampTicks', { fall: { startTicks: 10, endTicks: 10, rampTicks: 0 } }],
    ['fall.startTicks', { fall: { startTicks: 2.5, endTicks: 10, rampTicks: 1 } }],
  ])('rejects a bad %s', (field, patch) => {
    expect(() => {
      validateConfig({ ...SMALL, ...patch });
    }).toThrow(field);
  });
});

describe('createInbox', () => {
  it('builds a seeded stream of distinct messages on the schedule, with labels from the data', () => {
    const s = small();
    expect(s.stream).toHaveLength(6);
    const byId = new Map(MESSAGES.map((m) => [m.id, m.label]));
    expect(new Set(s.stream.map((it) => it.id)).size).toBe(6);
    for (const it of s.stream) expect(it.label).toBe(byId.get(it.id));
    expect(s.stream.map(({ spawnTick, landTick }) => ({ spawnTick, landTick }))).toEqual(
      buildSchedule(SMALL),
    );
    expect(small().stream).toEqual(s.stream);
    const orders = new Set(
      [1, 2, 3, 4, 5].map((seed) =>
        small({}, seed)
          .stream.map((x) => x.id)
          .join(),
      ),
    );
    expect(orders.size).toBeGreaterThan(1);
  });

  it('starts both lanes at full health with the first message active', () => {
    const s = small();
    expect(s.tick).toBe(0);
    expect(s.seed).toBe(SEED);
    expect(s.next).toBe(1);
    expect(s.over).toBe(false);
    for (const lane of s.lanes) {
      expect(lane).toEqual({
        health: 100,
        active: [itemAt(s, 0).id],
        cleared: 0,
        wrong: 0,
        landed: 0,
        answered: 0,
        correct: 0,
        outcomes: [0, 0, 0, 0, 0, 0],
      });
    }
  });

  it('can use the whole message list, and refuses a stream longer than it', () => {
    expect(small({ streamLength: 8 }).stream).toHaveLength(8);
    expect(() => small({ streamLength: 9 })).toThrow(/streamLength/);
    expect(() => createInbox(1, SMALL, [...MESSAGES, { id: 'sms-1', label: 'spam' }])).toThrow(
      /duplicate/,
    );
  });

  it('keeps a copy of the config', () => {
    const config = { ...SMALL, spawn: { ...SMALL.spawn } };
    const s = createInbox(1, config, MESSAGES);
    config.spawn.startTicks = 99;
    expect(s.config.spawn.startTicks).toBe(10);
  });
});

describe('stepInbox: spawning and landing', () => {
  it('spawns every message into both lanes on its spawnTick and lands it on its landTick', () => {
    const s = small({ health: 1000 });
    const seen: [string[], string[]][] = [];
    while (!s.over) {
      seen.push([[...s.lanes[0].active], [...s.lanes[1].active]]);
      stepInbox(s, [null, null]);
    }
    for (const [a, b] of seen) expect(b).toEqual(a);
    s.stream.forEach((item, i) => {
      const activeAt = seen.flatMap(([a], tick) => (a.includes(item.id) ? [tick] : []));
      expect(activeAt[0], `item ${String(i)} spawn`).toBe(item.spawnTick);
      expect(activeAt.at(-1), `item ${String(i)} land`).toBe(item.landTick - 1);
    });
    // Soonest to land first.
    expect(seen[25]?.[0]).toEqual([itemAt(s, 0).id, itemAt(s, 1).id, itemAt(s, 2).id]);
  });

  it('lands a message unanswered: damage (×3 for smishing), a landed count and a hit event', () => {
    const s = small();
    const first = itemAt(s, 0);
    runTo(s, first.landTick - 1);
    const out = stepInbox(s, [null, null]);
    const dmg = first.label === 'smishing' ? 30 : 10;
    expect(out.settlements).toEqual([]);
    expect(out.events).toEqual([
      { kind: 'hit', seat: 0, id: first.id, cause: 'landed', damage: dmg, health: 100 - dmg },
      { kind: 'hit', seat: 1, id: first.id, cause: 'landed', damage: dmg, health: 100 - dmg },
    ]);
    for (const lane of s.lanes) {
      expect(lane.landed).toBe(1);
      expect(lane.health).toBe(100 - dmg);
      expect(lane.outcomes[0]).toBe(OUTCOME.landed);
      expect(lane.active).not.toContain(first.id);
    }
  });

  it('triples damage for smishing, wrong or landed', () => {
    expect(damageOf(SMALL, 'legit')).toBe(10);
    expect(damageOf(SMALL, 'spam')).toBe(10);
    expect(damageOf(SMALL, 'smishing')).toBe(30);
    expect(damageOf({ ...SMALL, smishingMultiplier: 5, damage: 2 }, 'smishing')).toBe(10);

    const s = small({ streamLength: 8, health: 1000 });
    const i = firstWithLabel(s, 'smishing');
    const item = itemAt(s, i);
    runTo(s, item.spawnTick);
    const healthBefore = s.lanes[0].health;
    // Seat 0 answers it wrong; seat 1 lets it land.
    const wrong = stepInbox(s, [answer(item, 'legit'), null]);
    expect(wrong.events).toContainEqual({
      kind: 'hit',
      seat: 0,
      id: item.id,
      cause: 'wrong',
      damage: 30,
      health: healthBefore - 30,
    });
    const before1 = s.lanes[1].health;
    const landed: unknown[] = [];
    while (s.lanes[1].active.includes(item.id)) landed.push(...stepInbox(s, [null, null]).events);
    expect(landed).toContainEqual({
      kind: 'hit',
      seat: 1,
      id: item.id,
      cause: 'landed',
      damage: 30,
      health: expect.any(Number) as number,
    });
    expect(s.lanes[1].health).toBeLessThanOrEqual(before1 - 30);
  });
});

describe('stepInbox: answers', () => {
  it('clears a correct answer at no cost and settles it applied, correct', () => {
    const s = small();
    const item = itemAt(s, 0);
    const out = stepInbox(s, [answer(item), null]);
    expect(out.settlements).toEqual<Settlement[]>([
      { seat: 0, choice: item.label, outcome: 'applied', correct: true },
    ]);
    expect(out.events).toEqual([]);
    expect(s.lanes[0]).toMatchObject({
      health: 100,
      active: [],
      cleared: 1,
      correct: 1,
      answered: 1,
      wrong: 0,
      landed: 0,
    });
    expect(s.lanes[0].outcomes[0]).toBe(OUTCOME.cleared);
    // The other lane is untouched.
    expect(s.lanes[1]).toMatchObject({ active: [item.id], answered: 0, cleared: 0 });
  });

  it('clears a wrong answer with damage, a hit event and settles it applied, not correct', () => {
    const s = small();
    const item = itemAt(s, 0);
    const out = stepInbox(s, [null, answer(item, wrongFor(item))]);
    const dmg = damageOf(SMALL, item.label);
    expect(out.settlements).toEqual<Settlement[]>([
      { seat: 1, choice: wrongFor(item), outcome: 'applied', correct: false },
    ]);
    expect(out.events).toEqual([
      { kind: 'hit', seat: 1, id: item.id, cause: 'wrong', damage: dmg, health: 100 - dmg },
    ]);
    expect(s.lanes[1]).toMatchObject({
      health: 100 - dmg,
      active: [],
      wrong: 1,
      answered: 1,
      correct: 0,
      cleared: 0,
    });
    expect(s.lanes[1].outcomes[0]).toBe(OUTCOME.wrong);
  });

  it('answers any active message, not only the soonest', () => {
    const s = small();
    runTo(s, 20);
    const second = itemAt(s, 1);
    expect(soonest(s, 0)?.id).toBe(itemAt(s, 0).id);
    stepInbox(s, [answer(second), null]);
    expect(s.lanes[0].active).toEqual([itemAt(s, 0).id, itemAt(s, 2).id]);
    expect(s.lanes[0].outcomes[1]).toBe(OUTCOME.cleared);
  });

  it('drops an answer for a message that landed, was answered, or is unknown', () => {
    const s = small();
    const first = itemAt(s, 0);
    const second = itemAt(s, 1);
    runTo(s, second.spawnTick);
    stepInbox(s, [answer(second), null]);
    runTo(s, first.landTick);
    const healthBefore = [s.lanes[0].health, s.lanes[1].health];
    const out = stepInbox(s, [answer(first), answer(second, wrongFor(second))]);
    expect(out.settlements).toEqual<Settlement[]>([
      { seat: 0, choice: first.label, outcome: 'dropped', reason: 'landed' },
      { seat: 1, choice: wrongFor(second), outcome: 'applied', correct: false },
    ]);
    const again = stepInbox(s, [answer(second), { choice: 'spam', questionKey: 'sms-404' }]);
    expect(again.settlements).toEqual<Settlement[]>([
      { seat: 0, choice: second.label, outcome: 'dropped', reason: 'resolved' },
      { seat: 1, choice: 'spam', outcome: 'dropped', reason: 'unknown' },
    ]);
    // A message that has not spawned yet is unknown to the lane too.
    const last = itemAt(s, 5);
    expect(stepInbox(s, [answer(last), null]).settlements).toEqual<Settlement[]>([
      { seat: 0, choice: last.label, outcome: 'dropped', reason: 'unknown' },
    ]);
    // Dropped answers cost nothing and don't count as answered.
    expect(s.lanes[0].health).toBe(healthBefore[0]);
    expect(s.lanes[0].answered).toBe(1);
  });
});

describe('end of the game', () => {
  it('ends when a lane reaches 0 health, clamping it at 0, with one game_over event', () => {
    const s = small({ health: 10 });
    const item = itemAt(s, 0);
    const out = stepInbox(s, [answer(item, wrongFor(item)), answer(item)]);
    expect(s.lanes[0].health).toBe(0);
    expect(s.over).toBe(true);
    expect(out.events.at(-1)).toEqual({ kind: 'game_over', winner: 1, health: [0, 10] });
    expect(inboxResult(s)).toEqual({ over: true, winner: 1, scores: [0, 10] });
    expect(canAskLane(s, 0)).toBe(false);
    expect(canAskLane(s, 1)).toBe(false);
    expect(() => stepInbox(s, [null, null])).toThrow(/over/);
  });

  it('ends once every message has spawned and both lanes are empty', () => {
    const s = small();
    let ticks = 0;
    const events: unknown[] = [];
    while (!s.over) {
      // Both seats answer every message right as soon as it spawns.
      const inputs = [0, 1].map((seat) => {
        const it = soonest(s, seat === 0 ? 0 : 1);
        return it ? answer(it) : null;
      });
      events.push(...stepInbox(s, [inputs[0] ?? null, inputs[1] ?? null]).events);
      ticks++;
    }
    // The last message spawns at 50 and is answered on that tick's step (state tick 51).
    expect(ticks).toBe(51);
    expect(events).toEqual([{ kind: 'game_over', winner: 'draw', health: [100, 100] }]);
    expect(inboxResult(s)).toEqual({ over: true, winner: 'draw', scores: [100, 100] });
  });

  it('ends no later than maxTicks with nobody answering', () => {
    const s = small({ health: 10_000 });
    let ticks = 0;
    while (!s.over) {
      stepInbox(s, [null, null]);
      ticks++;
    }
    expect(ticks).toBeLessThan(inboxMaxTicks(SMALL));
    expect(ticks).toBe(80);
  });

  it('reports a running game as not over, with health as scores', () => {
    const s = small();
    const item = itemAt(s, 0);
    stepInbox(s, [answer(item, wrongFor(item)), null]);
    const hp = 100 - damageOf(SMALL, item.label);
    expect(inboxResult(s)).toEqual({ over: false, winner: null, scores: [hp, 100] });
  });
});

describe('inboxResult tie-breaks', () => {
  /** A finished state with the given lane health and answer counts. */
  function finished(
    health: [number, number],
    counts: [[number, number], [number, number]],
  ): InboxState {
    const s = small();
    s.over = true;
    s.lanes.forEach((lane, seat) => {
      const [correct, answered] = counts[seat] ?? [0, 0];
      lane.health = health[seat] ?? 0;
      lane.correct = correct;
      lane.cleared = correct;
      lane.answered = answered;
      lane.wrong = answered - correct;
    });
    return s;
  }

  it('gives the win to higher health first', () => {
    expect(
      inboxResult(
        finished(
          [40, 30],
          [
            [1, 9],
            [9, 9],
          ],
        ),
      ).winner,
    ).toBe(0);
    expect(
      inboxResult(
        finished(
          [0, 3],
          [
            [9, 9],
            [0, 9],
          ],
        ),
      ).winner,
    ).toBe(1);
  });

  it('breaks equal health by accuracy, compared exactly', () => {
    // 2/3 < 3/4
    expect(
      inboxResult(
        finished(
          [50, 50],
          [
            [2, 3],
            [3, 4],
          ],
        ),
      ).winner,
    ).toBe(1);
    // 7/10 > 2/3
    expect(
      inboxResult(
        finished(
          [0, 0],
          [
            [7, 10],
            [2, 3],
          ],
        ),
      ).winner,
    ).toBe(0);
    // A seat that answered nothing has accuracy 0.
    expect(
      inboxResult(
        finished(
          [5, 5],
          [
            [0, 0],
            [1, 4],
          ],
        ),
      ).winner,
    ).toBe(1);
  });

  it('draws on equal health and equal accuracy (including none answered)', () => {
    expect(
      inboxResult(
        finished(
          [60, 60],
          [
            [2, 4],
            [3, 6],
          ],
        ),
      ).winner,
    ).toBe('draw');
    expect(
      inboxResult(
        finished(
          [0, 0],
          [
            [0, 0],
            [0, 0],
          ],
        ),
      ).winner,
    ).toBe('draw');
  });
});

describe('cloneInbox', () => {
  it('copies the lanes and config, and shares the frozen stream', () => {
    const s = small();
    runTo(s, 12);
    const c = cloneInbox(s);
    expect(c).toEqual(s);
    c.lanes[0].active.push('x');
    c.lanes[1].outcomes[0] = OUTCOME.landed;
    c.config.fall.endTicks = 1;
    expect(s.lanes[0].active).not.toContain('x');
    expect(s.lanes[1].outcomes[0]).toBe(OUTCOME.pending);
    expect(s.config.fall.endTicks).toBe(30);
    expect(c.stream).toBe(s.stream);
    expect(Object.isFrozen(s.stream)).toBe(true);
    expect(s.stream.every((item) => Object.isFrozen(item))).toBe(true);
    expect(() => {
      itemAt(c, 0).landTick = 1;
    }).toThrow(TypeError);
    expect(itemAt(s, 0).landTick).toBe(30);
  });

  it('steps a clone exactly like the original', () => {
    const s = small();
    runTo(s, 15);
    const c = cloneInbox(s);
    const item = itemAt(s, 1);
    const a = stepInbox(s, [answer(item), answer(item, wrongFor(item))]);
    const b = stepInbox(c, [answer(item), answer(item, wrongFor(item))]);
    expect(b).toEqual(a);
    expect(c).toEqual(s);
  });
});

describe('soonest and canAskLane', () => {
  it('names the soonest-to-land active message, or null for an empty lane', () => {
    const s = small();
    expect(soonest(s, 1)).toEqual(itemAt(s, 0));
    expect(canAskLane(s, 1)).toBe(true);
    stepInbox(s, [null, answer(itemAt(s, 0))]);
    expect(soonest(s, 1)).toBeNull();
    expect(canAskLane(s, 1)).toBe(false);
    expect(canAskLane(s, 0)).toBe(true);
  });

  it('works on a clone (no shared lookup state)', () => {
    const s = createInbox(SEED, SMALL, MESSAGES);
    const c = cloneInbox(s);
    runTo(c, 10);
    expect(soonest(c, 0)?.id).toBe(itemAt(c, 0).id);
    expect(c.lanes[0].active).toEqual([itemAt(c, 0).id, itemAt(c, 1).id]);
  });
});
