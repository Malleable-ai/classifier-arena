import { describe, expect, it } from 'vitest';
import {
  PUSHBOX_HALF_WIDTH,
  STAGE_MAX,
  STAGE_MIN,
  START_X,
  SUB,
  WALK_SPEED,
} from '../../../../src/games/fighter/engine/constants.js';
import { facingOf } from '../../../../src/games/fighter/engine/fighter.js';
import { createPrng, nextBelow } from '../../../../src/core/util/prng.js';
import { createMatch, step } from '../../../../src/games/fighter/engine/sim.js';
import type { MoveId } from '../../../../src/games/fighter/engine/types.js';
import { MOVE_IDS } from '../../../../src/games/fighter/engine/types.js';

const MIN_GAP = 2 * PUSHBOX_HALF_WIDTH;
const LEFT_WALL = STAGE_MIN + PUSHBOX_HALF_WIDTH;
const RIGHT_WALL = STAGE_MAX - PUSHBOX_HALF_WIDTH;

function run(
  state: ReturnType<typeof createMatch>,
  inputs: readonly [MoveId | null, MoveId | null],
  ticks: number,
) {
  step(state, inputs);
  for (let i = 1; i < ticks; i++) step(state, [null, null]);
}

describe('option order', () => {
  it('MOVE_IDS is the canonical option order', () => {
    expect(MOVE_IDS).toEqual([
      'walk_forward',
      'walk_back',
      'block_high',
      'block_low',
      'jab',
      'heavy_punch',
      'sweep',
      'fireball',
      'uppercut',
      'throw',
      'jump_in',
    ]);
  });
});

describe('createMatch', () => {
  it('starts both fighters at their start positions, standing, facing each other', () => {
    const s = createMatch(1);
    expect(s.fighters[0].x).toBe(START_X[0]);
    expect(s.fighters[1].x).toBe(START_X[1]);
    expect(s.fighters[0].action).toBe('stand');
    expect(s.fighters[0].phase).toBe('idle');
    expect(facingOf(s, 0)).toBe(1);
    expect(facingOf(s, 1)).toBe(-1);
    expect(s.tick).toBe(0);
    expect(s.round).toBe(1);
    expect(s.status).toBe('fighting');
  });

  it('accepts partial config overrides', () => {
    const s = createMatch(1, { roundTicks: 120, maxHealth: 10 });
    expect(s.config.roundTicks).toBe(120);
    expect(s.fighters[1].health).toBe(10);
  });
});

describe('walking', () => {
  it('walks at 3 units per tick, starting on the tick the input arrives', () => {
    const s = createMatch(1);
    step(s, ['walk_forward', 'walk_forward']);
    expect(s.fighters[0].x).toBe(START_X[0] + WALK_SPEED);
    expect(s.fighters[1].x).toBe(START_X[1] - WALK_SPEED);
    expect(WALK_SPEED).toBe(3 * SUB);
  });

  it('walk_back moves away from the opponent', () => {
    const s = createMatch(1);
    run(s, ['walk_back', 'walk_back'], 10);
    expect(s.fighters[0].x).toBe(START_X[0] - 10 * WALK_SPEED);
    expect(s.fighters[1].x).toBe(START_X[1] + 10 * WALK_SPEED);
  });

  it('emits an applied event for a hold', () => {
    const s = createMatch(1);
    const events = step(s, ['block_high', null]);
    expect(events).toEqual([{ type: 'applied', tick: 0, fighter: 0, move: 'block_high' }]);
    expect(s.fighters[0].lastMoves).toEqual(['block_high']);
  });

  it('a hold lasts until the next input', () => {
    const s = createMatch(1);
    run(s, ['walk_forward', null], 20);
    expect(s.fighters[0].x).toBe(START_X[0] + 20 * WALK_SPEED);
    step(s, ['block_high', null]);
    const x = s.fighters[0].x;
    run(s, [null, null], 30);
    expect(s.fighters[0].x).toBe(x);
    expect(s.fighters[0].action).toBe('block_high');
    expect(s.fighters[0].vx).toBe(0);
  });

  it('blocks set a block stance and stop walking', () => {
    const s = createMatch(1);
    run(s, ['walk_forward', 'walk_forward'], 5);
    run(s, ['block_low', 'block_high'], 5);
    expect(s.fighters[0].action).toBe('block_low');
    expect(s.fighters[1].action).toBe('block_high');
    expect(s.fighters[0].x).toBe(START_X[0] + 5 * WALK_SPEED);
  });

  it('a hold arriving while busy becomes the pending hold, not applied yet', () => {
    const s = createMatch(1);
    s.fighters[0].phase = 'recovery';
    s.fighters[0].action = 'jab';
    const events = step(s, ['walk_forward', null]);
    expect(events).toEqual([]);
    expect(s.fighters[0].action).toBe('jab');
    expect(s.fighters[0].x).toBe(START_X[0]);
    // Holds never expire: it waits as pendingHold until the fighter is idle.
    expect(s.fighters[0].buffered).toBeNull();
    expect(s.fighters[0].pendingHold).toBe('walk_forward');
  });

  it('keeps only the last 3 applied moves, oldest first', () => {
    const s = createMatch(1);
    for (const m of ['walk_forward', 'block_high', 'walk_back', 'block_low'] as const) {
      step(s, [m, null]);
    }
    expect(s.fighters[0].lastMoves).toEqual(['block_high', 'walk_back', 'block_low']);
  });
});

describe('walls', () => {
  it('clamps fighters at the walls', () => {
    const s = createMatch(1);
    run(s, ['walk_back', 'walk_back'], 200);
    expect(s.fighters[0].x).toBe(LEFT_WALL);
    expect(s.fighters[1].x).toBe(RIGHT_WALL);
  });
});

describe('pushbox', () => {
  it('fighters walking into each other stop 60 units apart and never pass', () => {
    const s = createMatch(1);
    run(s, ['walk_forward', 'walk_forward'], 100);
    expect(s.fighters[1].x - s.fighters[0].x).toBe(MIN_GAP);
    expect(s.fighters[0].x).toBe(50_000 - MIN_GAP / 2);
  });

  it('a walker pushes a standing opponent, each taking half the overlap', () => {
    const s = createMatch(1);
    s.fighters[0].x = s.fighters[1].x - MIN_GAP;
    const x1 = s.fighters[1].x;
    run(s, ['walk_forward', null], 10);
    expect(s.fighters[1].x).toBe(x1 + 10 * (WALK_SPEED / 2));
    expect(s.fighters[1].x - s.fighters[0].x).toBe(MIN_GAP);
  });

  it('against a wall the other fighter takes the whole push', () => {
    const s = createMatch(1);
    s.fighters[1].x = RIGHT_WALL;
    s.fighters[0].x = RIGHT_WALL - MIN_GAP;
    run(s, ['walk_forward', null], 10);
    expect(s.fighters[1].x).toBe(RIGHT_WALL);
    expect(s.fighters[0].x).toBe(RIGHT_WALL - MIN_GAP);
  });

  it('restores order and gap even from an overlapping state', () => {
    const s = createMatch(1);
    s.fighters[0].x = 50_000;
    s.fighters[1].x = 49_000;
    step(s, [null, null]);
    expect(s.fighters[1].x - s.fighters[0].x).toBe(MIN_GAP);
  });
});

describe('facing', () => {
  it('never flips under random holds (no cross-ups)', () => {
    const s = createMatch(1);
    const prng = createPrng(99);
    const holds: MoveId[] = ['walk_forward', 'walk_back', 'block_high', 'block_low'];
    for (let i = 0; i < 3000; i++) {
      const pick = (): MoveId | null =>
        nextBelow(prng, 4) === 0 ? (holds[nextBelow(prng, 4)] ?? null) : null;
      step(s, [pick(), pick()]);
      const [a, b] = s.fighters;
      expect(b.x - a.x).toBeGreaterThanOrEqual(MIN_GAP);
      expect(a.x).toBeGreaterThanOrEqual(LEFT_WALL);
      expect(b.x).toBeLessThanOrEqual(RIGHT_WALL);
      expect(facingOf(s, 0)).toBe(1);
      expect(facingOf(s, 1)).toBe(-1);
    }
  });
});

describe('clock and status', () => {
  it('advances tick and roundTick once per step while fighting', () => {
    const s = createMatch(1);
    run(s, [null, null], 25);
    expect(s.tick).toBe(25);
    expect(s.roundTick).toBe(25);
  });

  it('drops inputs between rounds and still advances the tick', () => {
    const s = createMatch(1);
    s.status = 'roundOver';
    const events = step(s, ['jab', 'walk_forward']);
    expect(events).toEqual([
      { type: 'dropped', tick: 0, fighter: 0, move: 'jab', reason: 'notFighting' },
      { type: 'dropped', tick: 0, fighter: 1, move: 'walk_forward', reason: 'notFighting' },
    ]);
    expect(s.tick).toBe(1);
    expect(s.roundTick).toBe(0);
  });

  it('is a no-op once the match is over', () => {
    const s = createMatch(1);
    s.status = 'matchOver';
    expect(step(s, ['walk_forward', null])).toEqual([]);
    expect(s.tick).toBe(0);
    expect(s.fighters[0].x).toBe(START_X[0]);
  });
});
