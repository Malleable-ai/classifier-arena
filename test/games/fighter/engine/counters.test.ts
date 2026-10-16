import { describe, expect, it } from 'vitest';
import type { MoveId, Phase } from '../../../../src/games/fighter/engine/types.js';
import type { Script } from './combat-helpers.js';
import { matchAt, ofType, run } from './combat-helpers.js';

/** Fighter 0 attacks fighter 1 (holding `stance` from tick 0). */
function attackInto(units: number, attack: MoveId, stance: MoveId | null, ticks = 60) {
  const s = matchAt(units);
  const events = run(s, ticks, { 0: [attack, stance] });
  return { s, events, hits: ofType(events, 'hit'), blocks: ofType(events, 'blocked') };
}

describe('the right block stops strikes', () => {
  const cases: [MoveId, MoveId, number][] = [
    ['jab', 'block_high', 100],
    ['jab', 'block_low', 100],
    ['heavy_punch', 'block_high', 100],
    ['heavy_punch', 'block_low', 100],
    ['sweep', 'block_low', 100],
    ['jump_in', 'block_high', 200],
  ];
  for (const [attack, stance, units] of cases) {
    it(`${stance} stops ${attack}`, () => {
      const { s, hits, blocks } = attackInto(units, attack, stance);
      expect(hits).toEqual([]);
      expect(blocks).toHaveLength(1);
      expect(blocks[0]).toMatchObject({ fighter: 0, target: 1, move: attack, chip: 0 });
      expect(s.fighters[1].health).toBe(100);
      // Still holding the block after blockstun.
      expect(s.fighters[1].action).toBe(stance);
    });
  }

  it('either block stops a fireball but takes 1 chip', () => {
    for (const stance of ['block_high', 'block_low'] as const) {
      const { s, blocks } = attackInto(300, 'fireball', stance, 80);
      expect(blocks).toEqual([expect.objectContaining({ move: 'fireball', chip: 1 })]);
      expect(s.fighters[1].health).toBe(99);
    }
  });

  it('an unblocked fireball deals 6', () => {
    const { s, hits } = attackInto(300, 'fireball', null, 80);
    expect(hits).toEqual([expect.objectContaining({ move: 'fireball', damage: 6 })]);
    expect(s.fighters[1].health).toBe(94);
  });
});

describe('a throw beats a block', () => {
  for (const stance of ['block_high', 'block_low'] as const) {
    it(`throws through ${stance} and knocks down`, () => {
      const { s, hits, blocks } = attackInto(70, 'throw', stance, 10);
      expect(blocks).toEqual([]);
      expect(hits).toEqual([
        { type: 'hit', tick: 3, fighter: 0, target: 1, move: 'throw', damage: 10, knockdown: true },
      ]);
      expect(s.fighters[1].health).toBe(90);
      expect(s.fighters[1].phase).toBe('knockdown');
    });
  }

  it('misses an airborne opponent', () => {
    const s = matchAt(70);
    const ev = run(s, 12, { 0: [null, 'jump_in'], 1: ['throw', null] });
    expect(ofType(ev, 'hit')).toEqual([]);
    expect(ofType(ev, 'whiff')).toEqual([expect.objectContaining({ fighter: 0, move: 'throw' })]);
  });
});

describe('an uppercut beats a jump-in', () => {
  it('the uppercut is invulnerable while the kick is out and hits the airborne jumper', () => {
    const s = matchAt(200);
    const ev = run(s, 60, { 0: ['jump_in', null], 25: [null, 'uppercut'] });
    expect(ofType(ev, 'hit')).toEqual([
      {
        type: 'hit',
        tick: 28,
        fighter: 1,
        target: 0,
        move: 'uppercut',
        damage: 10,
        knockdown: false,
      },
    ]);
    expect(s.fighters[1].health).toBe(100);
    expect(s.fighters[0].health).toBe(90);
  });

  it('without the uppercut the same jump-in lands', () => {
    const s = matchAt(200);
    const ev = run(s, 60, { 0: ['jump_in', null] });
    expect(ofType(ev, 'hit')).toEqual([expect.objectContaining({ fighter: 0, move: 'jump_in' })]);
  });

  it('a grounded jab does not reach an airborne jumper', () => {
    const s = matchAt(200);
    const ev = run(s, 60, { 0: ['jump_in', null], 24: [null, 'jab'] });
    expect(ofType(ev, 'hit')).toEqual([expect.objectContaining({ fighter: 0, move: 'jump_in' })]);
  });
});

describe('a sweep beats block_high', () => {
  it('hits low through block_high and knocks down for 40 ticks, untouchable', () => {
    const { s, hits } = attackInto(100, 'sweep', 'block_high', 12);
    expect(hits).toEqual([
      { type: 'hit', tick: 7, fighter: 0, target: 1, move: 'sweep', damage: 7, knockdown: true },
    ]);
    expect(s.fighters[1].phase).toBe('knockdown');
    // Untouchable on the floor: a jab during knockdown whiffs.
    const ev = run(s, 30, { 0: [null, null], 20: ['jab', null] });
    expect(ofType(ev, 'hit')).toEqual([]);
    expect(s.fighters[1].health).toBe(93);
  });

  it('gets up after 40 ticks standing (not blocking)', () => {
    const s = matchAt(100);
    const phases: Phase[] = [];
    run(s, 60, { 0: ['sweep', 'block_high'] }, () => phases.push(s.fighters[1].phase));
    expect(phases.filter((p) => p === 'knockdown')).toHaveLength(41);
    expect(phases[48]).toBe('idle');
    expect(s.fighters[1].action).toBe('stand');
  });
});

describe('a jump-in beats block_low', () => {
  it('the overhead kick hits through block_low', () => {
    const { s, hits } = attackInto(200, 'jump_in', 'block_low');
    expect(hits).toEqual([
      expect.objectContaining({ fighter: 0, target: 1, move: 'jump_in', damage: 8 }),
    ]);
    expect(s.fighters[1].health).toBe(92);
  });
});

describe('jumping over a fireball beats it', () => {
  it('the jumper is never hit, the kick lands, and the fireball despawns at the wall', () => {
    const s = matchAt(200);
    const ev = run(s, 200, { 0: ['fireball', 'jump_in'] });
    const hits = ofType(ev, 'hit');
    expect(hits).toEqual([expect.objectContaining({ fighter: 1, target: 0, move: 'jump_in' })]);
    expect(s.fighters[1].health).toBe(100);
    expect(s.projectiles).toEqual([]);
  });
});

/** Fighter 0 whiffs; returns the hits on fighter 0 and its phase on the tick before each. */
function whiffPunish(units: number, script: Script, ticks = 70) {
  const s = matchAt(units);
  let prev: Phase = s.fighters[0].phase;
  const punished: { move: MoveId; phaseBefore: Phase }[] = [];
  const ev = run(s, ticks, script, (_, events) => {
    for (const e of ofType(events, 'hit')) {
      if (e.target === 0) punished.push({ move: e.move, phaseBefore: prev });
    }
    prev = s.fighters[0].phase;
  });
  return { punished, whiffs: ofType(ev, 'whiff'), s };
}

describe('every whiffed move can be punished', () => {
  it('jab', () => {
    // 125 apart: out of the jab's reach (120), inside the heavy's (130).
    const r = whiffPunish(125, { 0: ['jab', 'heavy_punch'] });
    expect(r.whiffs).toContainEqual(expect.objectContaining({ fighter: 0, move: 'jab' }));
    expect(r.punished).toEqual([{ move: 'heavy_punch', phaseBefore: 'recovery' }]);
  });

  it('heavy_punch (walk in and sweep)', () => {
    const r = whiffPunish(165, {
      0: ['heavy_punch', null],
      13: [null, 'walk_forward'],
      18: [null, 'sweep'],
    });
    expect(r.whiffs).toContainEqual(expect.objectContaining({ fighter: 0, move: 'heavy_punch' }));
    expect(r.punished).toEqual([{ move: 'sweep', phaseBefore: 'recovery' }]);
  });

  it('sweep (walk in and heavy_punch)', () => {
    // Whiffed at 155 (reach 150); 9 ticks of walking bring the opponent to 128, inside the
    // heavy's 130, which lands on tick 29 while the sweep recovers (ticks 11-30).
    const r = whiffPunish(155, {
      0: ['sweep', null],
      11: [null, 'walk_forward'],
      20: [null, 'heavy_punch'],
    });
    expect(r.whiffs).toContainEqual(expect.objectContaining({ fighter: 0, move: 'sweep' }));
    expect(r.punished).toEqual([{ move: 'heavy_punch', phaseBefore: 'recovery' }]);
  });

  it('fireball (jumped over)', () => {
    const r = whiffPunish(200, { 0: ['fireball', 'jump_in'] });
    expect(r.punished).toEqual([{ move: 'jump_in', phaseBefore: 'recovery' }]);
  });

  it('uppercut', () => {
    const r = whiffPunish(100, { 0: ['uppercut', null], 1: [null, 'heavy_punch'] });
    expect(r.whiffs).toContainEqual(expect.objectContaining({ fighter: 0, move: 'uppercut' }));
    expect(r.punished).toEqual([{ move: 'heavy_punch', phaseBefore: 'recovery' }]);
  });

  it('throw', () => {
    const r = whiffPunish(100, { 0: ['throw', null], 3: [null, 'jab'] });
    expect(r.whiffs).toContainEqual(expect.objectContaining({ fighter: 0, move: 'throw' }));
    expect(r.punished).toEqual([{ move: 'jab', phaseBefore: 'recovery' }]);
  });

  it('jump_in (landing recovery)', () => {
    const r = whiffPunish(320, { 0: ['jump_in', null], 33: [null, 'heavy_punch'] });
    expect(r.whiffs).toContainEqual(expect.objectContaining({ fighter: 0, move: 'jump_in' }));
    expect(r.punished).toEqual([{ move: 'heavy_punch', phaseBefore: 'recovery' }]);
  });
});
