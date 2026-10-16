import { describe, expect, it } from 'vitest';
import { SUB } from '../../../../src/games/fighter/engine/constants.js';
import { MOVES } from '../../../../src/games/fighter/engine/moves.js';
import type { MoveId, Phase } from '../../../../src/games/fighter/engine/types.js';
import { MOVE_IDS, MOVE_KIND } from '../../../../src/games/fighter/engine/types.js';
import { matchAt, ofType, run, runs } from './combat-helpers.js';

/** Phase of fighter 0 on each tick after it inputs `move` on tick 0, far from the opponent. */
function phases(move: MoveId, ticks = 60): Phase[] {
  const s = matchAt(900);
  const out: Phase[] = [];
  run(s, ticks, { 0: [move, null] }, () => out.push(s.fighters[0].phase));
  return out;
}

function expectFrames(move: MoveId, startup: number, active: number, recovery: number): void {
  const r = runs(phases(move, startup + active + recovery + 5));
  const expected: [Phase, number][] = [['startup', startup]];
  if (active > 0) expected.push(['active', active]);
  expected.push(['recovery', recovery]);
  expect(r.slice(0, expected.length)).toEqual(expected);
  expect(r[expected.length]?.[0]).toBe('idle');
}

describe('move table', () => {
  it('has a kind for every option that agrees with MOVE_KIND', () => {
    for (const id of MOVE_IDS) expect(MOVES[id].kind).toBe(MOVE_KIND[id]);
  });

  it('uses integers only', () => {
    for (const id of MOVE_IDS) {
      for (const v of Object.values(MOVES[id])) {
        if (typeof v === 'number') expect(Number.isInteger(v)).toBe(true);
      }
    }
  });
});

describe('jab', () => {
  it('is 4 startup, 3 active, 8 recovery', () => {
    expectFrames('jab', 4, 3, 8);
  });
});

describe('heavy_punch', () => {
  it('is 9 startup, 4 active, 18 recovery', () => {
    expectFrames('heavy_punch', 9, 4, 18);
  });
});

describe('sweep', () => {
  it('is 7 startup, 4 active, 20 recovery', () => {
    expectFrames('sweep', 7, 4, 20);
  });
});

describe('fireball', () => {
  it('is 12 startup, then 20 recovery, spawning on the first recovery tick', () => {
    expectFrames('fireball', 12, 0, 20);
    const s = matchAt(900);
    const spawnedAt: number[] = [];
    run(s, 20, { 0: ['fireball', null] }, (i) => {
      if (s.projectiles.length > 0 && spawnedAt.length === 0) spawnedAt.push(i);
    });
    expect(spawnedAt).toEqual([12]);
  });

  it('moves 6 units per tick and starts a 90-tick cooldown at spawn', () => {
    const s = matchAt(900);
    run(s, 13, { 0: ['fireball', null] });
    const x = s.projectiles[0]?.x ?? 0;
    expect(s.fighters[0].fireballCooldown).toBe(89);
    run(s, 1);
    expect((s.projectiles[0]?.x ?? 0) - x).toBe(6 * SUB);
  });
});

describe('uppercut', () => {
  it('is 3 startup, 6 active, 50 recovery', () => {
    expectFrames('uppercut', 3, 6, 50);
  });

  it('is invulnerable for its first 6 ticks only', () => {
    const s = matchAt(900);
    const inv: boolean[] = [];
    run(s, 8, { 0: ['uppercut', null] }, () => {
      // invulnTicks is decremented at the end of the tick, so > 0 or just used this tick.
      inv.push(s.fighters[0].invulnTicks > 0);
    });
    expect(inv).toEqual([true, true, true, true, true, false, false, false]);
  });
});

describe('throw', () => {
  it('is 3 startup, 1 active (the connect tick), 22 recovery', () => {
    expectFrames('throw', 3, 1, 22);
  });
});

describe('jump_in', () => {
  it('is a 40-tick arc (kick on the last 12) and 28 ticks of landing', () => {
    expectFrames('jump_in', 28, 12, 28);
  });

  it('peaks at 120 units and lands on tick 40 at y = 0', () => {
    const s = matchAt(900);
    const ys: number[] = [];
    run(s, 41, { 0: ['jump_in', null] }, () => ys.push(s.fighters[0].y));
    expect(Math.max(...ys)).toBe(120 * SUB);
    expect(ys[19]).toBe(120 * SUB);
    expect(ys[0]).toBeGreaterThan(0);
    expect(ys[39]).toBe(0);
    expect(ys[40]).toBe(0);
  });

  it('never lands past the opponent (no cross-up)', () => {
    const s = matchAt(100);
    run(s, 48, { 0: ['jump_in', 'block_high'] }, () => {
      expect(s.fighters[0].x).toBeLessThan(s.fighters[1].x);
    });
  });

  it('emits whiff when the kick never connects', () => {
    const s = matchAt(900);
    const ev = run(s, 50, { 0: ['jump_in', null] });
    expect(ofType(ev, 'whiff')).toEqual([{ type: 'whiff', tick: 39, fighter: 0, move: 'jump_in' }]);
  });
});
