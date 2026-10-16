import { describe, expect, it } from 'vitest';
import { distance, matchAt, ofType, run } from './combat-helpers.js';

describe('trades', () => {
  it('same-tick hits: both fighters take the damage', () => {
    const s = matchAt(100);
    const ev = run(s, 10, { 0: ['jab', 'jab'] });
    const hits = ofType(ev, 'hit');
    expect(hits).toHaveLength(2);
    expect(hits.every((h) => h.tick === 4)).toBe(true);
    expect(s.fighters[0].health).toBe(96);
    expect(s.fighters[1].health).toBe(96);
  });

  it('same-tick hits of different moves both land', () => {
    const s = matchAt(100);
    const ev = run(s, 15, { 0: ['heavy_punch', null], 5: [null, 'jab'] });
    expect(ofType(ev, 'hit').map((h) => [h.tick, h.move])).toEqual([
      [9, 'heavy_punch'],
      [9, 'jab'],
    ]);
    expect(s.fighters[0].health).toBe(96);
    expect(s.fighters[1].health).toBe(91);
  });

  it('throw tech: two throws on the same tick cancel and push 40 units apart', () => {
    const s = matchAt(70);
    const ev = run(s, 4, { 0: ['throw', 'throw'] });
    expect(ofType(ev, 'throwTech')).toEqual([{ type: 'throwTech', tick: 3 }]);
    expect(ofType(ev, 'hit')).toEqual([]);
    expect(ofType(ev, 'whiff')).toEqual([]);
    expect(distance(s)).toBe(110);
    expect(s.fighters[0].health).toBe(100);
    expect(s.fighters[1].health).toBe(100);
  });

  it('a throw loses to a strike that is already active', () => {
    const s = matchAt(70);
    const ev = run(s, 10, { 0: [null, 'jab'], 1: ['throw', null] });
    expect(ofType(ev, 'hit')).toEqual([
      { type: 'hit', tick: 4, fighter: 1, target: 0, move: 'jab', damage: 4, knockdown: false },
    ]);
    expect(s.fighters[1].health).toBe(100);
  });

  it('a throw beats a strike still in startup', () => {
    const s = matchAt(70);
    const ev = run(s, 10, { 0: ['throw', 'heavy_punch'] });
    expect(ofType(ev, 'hit')).toEqual([expect.objectContaining({ fighter: 0, move: 'throw' })]);
    expect(s.fighters[0].health).toBe(100);
  });

  it('fireball clash: two fireballs cancel, nobody is hit', () => {
    const s = matchAt(300);
    const ev = run(s, 60, { 0: ['fireball', 'fireball'] });
    expect(ofType(ev, 'fireballClash')).toHaveLength(1);
    expect(s.projectiles).toEqual([]);
    expect(s.fighters[0].health).toBe(100);
    expect(s.fighters[1].health).toBe(100);
  });

  it('90-tick cooldown from spawn', () => {
    // At 300 apart the first fireball hits fighter 1 long before tick 102.
    const s = matchAt(300);
    const ev = run(s, 120, {
      0: ['fireball', null],
      40: ['fireball', null],
      102: ['fireball', null],
    });
    expect(ofType(ev, 'dropped')).toEqual([
      { type: 'dropped', tick: 45, fighter: 0, move: 'fireball', reason: 'busy' },
    ]);
    expect(ofType(ev, 'applied').map((e) => e.tick)).toEqual([0, 102]);
  });

  it('one fireball per fighter on screen, even off cooldown', () => {
    // At 900 apart the first fireball is still travelling on tick 102.
    const s = matchAt(900);
    const ev = run(s, 120, { 0: ['fireball', null], 102: ['fireball', null] });
    expect(s.projectiles).toHaveLength(1);
    expect(ofType(ev, 'dropped')).toEqual([
      { type: 'dropped', tick: 107, fighter: 0, move: 'fireball', reason: 'busy' },
    ]);
  });
});
