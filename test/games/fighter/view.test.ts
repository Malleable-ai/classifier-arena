import { describe, expect, it } from 'vitest';
import { FIREBALL_SPEED } from '../../../src/games/fighter/engine/moves.js';
import { PUSHBOX_HALF_WIDTH, STAGE_MAX, SUB } from '../../../src/games/fighter/engine/constants.js';
import { createPrng, nextBelow } from '../../../src/core/util/prng.js';
import { cloneState, createMatch, step } from '../../../src/games/fighter/engine/sim.js';
import type { MatchState, MoveId, Side } from '../../../src/games/fighter/engine/types.js';
import { MOVE_IDS } from '../../../src/games/fighter/engine/types.js';
import { buildView, rangeOf } from '../../../src/games/fighter/view.js';

function midFight(): MatchState {
  const s = createMatch(7);
  s.round = 2;
  s.roundTick = 19 * 60 + 1;
  s.fighters[0].health = 72;
  s.fighters[0].x = 410 * SUB + 37;
  s.fighters[0].action = 'block_high';
  s.fighters[0].lastMoves = ['jab', 'walk_forward', 'block_high'];
  s.fighters[0].roundsWon = 1;
  s.fighters[1].health = 65;
  s.fighters[1].x = 590 * SUB;
  s.fighters[1].action = 'heavy_punch';
  s.fighters[1].phase = 'startup';
  s.fighters[1].busyTicks = 5;
  s.fighters[1].fireballCooldown = 30;
  s.fighters[1].lastMoves = ['fireball', 'walk_back', 'heavy_punch'];
  return s;
}

describe('buildView', () => {
  it('reports the start state in whole units', () => {
    const v = buildView(createMatch(1), 0);
    expect(v).toEqual({
      you: {
        health: 100,
        x: 350,
        airborne: false,
        action: 'stand',
        phase: 'idle',
        busy_ticks: 0,
        fireball_ready: true,
        last_moves: [],
      },
      opponent: {
        health: 100,
        x: 650,
        airborne: false,
        action: 'stand',
        phase: 'idle',
        busy_ticks: 0,
        fireball_ready: true,
        last_moves: [],
      },
      distance: 300,
      range: 'mid',
      opponent_fireball: null,
      your_fireball_on_screen: false,
      round: 1,
      round_clock_s: 60,
      rounds_won: { you: 0, opponent: 0 },
    });
  });

  it('is mirror-consistent across the two sides of one state', () => {
    const s = midFight();
    const a = buildView(s, 0);
    const b = buildView(s, 1);
    // Same fighters, each side's own frame: everything but x matches; x is mirrored.
    expect({ ...a.you, x: 0 }).toEqual({ ...b.opponent, x: 0 });
    expect({ ...a.opponent, x: 0 }).toEqual({ ...b.you, x: 0 });
    expect(b.you.x).toBe(410); // floor((100000 - 59000) / 100)
    expect(b.opponent.x).toBe(589); // floor((100000 - 41037) / 100)
    expect(a.distance).toBe(b.distance);
    expect(a.range).toBe(b.range);
    expect(a.round).toBe(b.round);
    expect(a.round_clock_s).toBe(b.round_clock_s);
    expect(a.rounds_won).toEqual({ you: 1, opponent: 0 });
    expect(b.rounds_won).toEqual({ you: 0, opponent: 1 });
    expect(a.distance).toBe(179); // (59000 - 41037) / 100, floored
    expect(a.you.x).toBe(410);
    expect(a.round_clock_s).toBe(41);
    expect(a.opponent.phase).toBe('startup');
    expect(a.opponent.busy_ticks).toBe(5);
    expect(a.opponent.fireball_ready).toBe(false);
  });

  it('copies last_moves rather than aliasing engine state', () => {
    const s = midFight();
    const v = buildView(s, 0);
    v.you.last_moves.push('jab');
    expect(s.fighters[0].lastMoves).toHaveLength(3);
  });

  it('maps engine phases to the model-facing vocabulary', () => {
    const s = createMatch(1);
    s.fighters[1].phase = 'hitstun';
    expect(buildView(s, 0).opponent.phase).toBe('stunned');
    s.fighters[1].phase = 'blockstun';
    expect(buildView(s, 0).opponent.phase).toBe('stunned');
    s.fighters[1].phase = 'knockdown';
    expect(buildView(s, 0).opponent.phase).toBe('knocked_down');
    s.fighters[1].phase = 'recovery';
    expect(buildView(s, 0).opponent.phase).toBe('recovery');
  });

  it('reports airborne during a jump_in arc', () => {
    const s = createMatch(1);
    s.fighters[1].action = 'jump_in';
    s.fighters[1].phase = 'active';
    expect(buildView(s, 0).opponent.airborne).toBe(true);
  });
});

/** The same position with the sides swapped: x -> STAGE_MAX - x, velocities and owners flipped. */
function mirror(s: MatchState): MatchState {
  const m = cloneState(s);
  const [f0, f1] = m.fighters;
  m.fighters = [f1, f0];
  for (const f of m.fighters) {
    f.x = STAGE_MAX - f.x;
    f.vx = -f.vx;
  }
  m.projectiles = m.projectiles.map((p) => ({
    ...p,
    owner: (1 - p.owner) as Side,
    x: STAGE_MAX - p.x,
    vx: -p.vx,
  }));
  return m;
}

describe('own point of view', () => {
  it('gives side 1 the same start view as side 0', () => {
    expect(buildView(createMatch(1), 1)).toEqual(buildView(createMatch(1), 0));
  });

  it('gives a mirrored state identical views for the two sides, over many random states', () => {
    let checked = 0;
    for (const seed of [1, 5, 42, 977]) {
      const s = createMatch(seed);
      const prng = createPrng(seed + 1000);
      const pick = (): MoveId | null =>
        nextBelow(prng, 6) === 0 ? (MOVE_IDS[nextBelow(prng, MOVE_IDS.length)] ?? null) : null;
      for (let t = 0; t < 4000 && s.status !== 'matchOver'; t++) {
        step(s, [pick(), pick()]);
        if (t % 3 !== 0) continue;
        const m = mirror(s);
        expect(buildView(m, 1)).toEqual(buildView(s, 0));
        expect(buildView(m, 0)).toEqual(buildView(s, 1));
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });
});

describe('ranges', () => {
  it.each([
    [119, 'close'],
    [120, 'mid'],
    [350, 'mid'],
    [351, 'far'],
  ] as const)('%i units is %s', (units, range) => {
    expect(rangeOf(units)).toBe(range);
    const s = createMatch(1);
    s.fighters[0].x = 100 * SUB;
    s.fighters[1].x = 100 * SUB + units * SUB + 99; // the sub-unit remainder is floored away
    const v = buildView(s, 0);
    expect(v.distance).toBe(units);
    expect(v.range).toBe(range);
  });
});

describe('fireballs', () => {
  it('is null with no fireball on screen', () => {
    const v = buildView(createMatch(1), 0);
    expect(v.opponent_fireball).toBeNull();
    expect(v.your_fireball_on_screen).toBe(false);
  });

  it('reports the opponent fireball gap and ticks_to_hit', () => {
    const s = createMatch(1);
    const target = s.fighters[0].x;
    const gap = 240 * SUB + 1;
    s.projectiles.push({
      owner: 1,
      x: target + PUSHBOX_HALF_WIDTH + gap,
      vx: -FIREBALL_SPEED,
      active: true,
    });
    const you = buildView(s, 0);
    expect(you.opponent_fireball).toEqual({ distance: 240, ticks_to_hit: 41 });
    expect(you.your_fireball_on_screen).toBe(false);
    expect(you.opponent.fireball_ready).toBe(false);
    const them = buildView(s, 1);
    expect(them.opponent_fireball).toBeNull();
    expect(them.your_fireball_on_screen).toBe(true);
    expect(them.you.fireball_ready).toBe(false);
  });

  it('is null once the fireball has passed you', () => {
    const s = createMatch(1);
    s.projectiles.push({
      owner: 1,
      x: s.fighters[0].x - PUSHBOX_HALF_WIDTH - 50 * SUB,
      vx: -FIREBALL_SPEED,
      active: true,
    });
    expect(buildView(s, 0).opponent_fireball).toBeNull();
  });

  it('is 0 ticks when it is already touching you', () => {
    const s = createMatch(1);
    s.projectiles.push({ owner: 1, x: s.fighters[0].x, vx: -FIREBALL_SPEED, active: true });
    expect(buildView(s, 0).opponent_fireball).toEqual({ distance: 0, ticks_to_hit: 0 });
  });
});
