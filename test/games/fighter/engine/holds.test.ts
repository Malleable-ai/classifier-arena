import { describe, expect, it } from 'vitest';
import { createMatch } from '../../../../src/games/fighter/engine/sim.js';
import { matchAt, ofType, run } from './combat-helpers.js';

/**
 * A hold (walk/block) "lasts until the next decision arrives". A hold decided while busy is
 * never dropped: it becomes the stance as soon as the fighter is next idle.
 */
describe('a hold decided while busy', () => {
  it('becomes the stance after hitstun (no 6-tick expiry, no dropped)', () => {
    const s = matchAt(80);
    // P0 walks forward; P1's jab hits on tick 4; P0 decides block_low during hitstun.
    const ev = run(s, 40, { 0: ['walk_forward', 'jab'], 6: ['block_low', null] });
    expect(ofType(ev, 'hit')).toHaveLength(1);
    expect(ofType(ev, 'dropped')).toEqual([]);
    const applied = ofType(ev, 'applied').filter((e) => e.fighter === 0);
    expect(applied.map((e) => e.move)).toEqual(['walk_forward', 'block_low']);
    expect(s.fighters[0].action).toBe('block_low');
    expect(s.fighters[0].phase).toBe('idle');
    expect(s.fighters[0].pendingHold).toBeNull();
  });

  it('is applied on the first idle tick after hitstun', () => {
    const s = matchAt(80);
    const phases: string[] = [];
    const ev = run(s, 40, { 0: ['walk_forward', 'jab'], 6: ['block_low', null] }, () =>
      phases.push(s.fighters[0].phase),
    );
    const firstIdle = phases.findIndex((p, i) => i > 6 && p === 'idle');
    const hold = ofType(ev, 'applied').find((e) => e.move === 'block_low');
    expect(hold?.tick).toBe(firstIdle);
  });

  it('survives a knockdown', () => {
    const s = matchAt(100);
    // P1's sweep knocks P0 down (40 ticks); P0 decides block_high while down.
    const ev = run(s, 80, { 0: [null, 'sweep'], 15: ['block_high', null] });
    expect(ofType(ev, 'hit')).toEqual([expect.objectContaining({ target: 0, knockdown: true })]);
    expect(ofType(ev, 'dropped')).toEqual([]);
    expect(s.fighters[0].action).toBe('block_high');
    expect(ofType(ev, 'applied').filter((e) => e.fighter === 0)).toEqual([
      expect.objectContaining({ move: 'block_high' }),
    ]);
  });

  it('a later hold replaces it (the replaced one is dropped as superseded)', () => {
    const s = matchAt(100);
    const ev = run(s, 80, {
      0: [null, 'sweep'],
      15: ['block_high', null],
      20: ['walk_back', null],
    });
    expect(ofType(ev, 'dropped')).toEqual([
      { type: 'dropped', tick: 20, fighter: 0, move: 'block_high', reason: 'superseded' },
    ]);
    expect(s.fighters[0].action).toBe('walk_back');
  });

  it('a later one-shot supersedes it', () => {
    const s = matchAt(900);
    // Jab busy ticks 0..14; block_high at 5, then sweep at 10 (buffered) starts on tick 15.
    const ev = run(s, 50, { 0: ['jab', null], 5: ['block_high', null], 10: ['sweep', null] });
    expect(ofType(ev, 'applied').map((e) => [e.tick, e.move])).toEqual([
      [0, 'jab'],
      [15, 'sweep'],
    ]);
    expect(ofType(ev, 'dropped')).toEqual([
      { type: 'dropped', tick: 15, fighter: 0, move: 'block_high', reason: 'superseded' },
    ]);
    // The sweep had no hold after it, so the fighter stands without blocking.
    expect(s.fighters[0].action).toBe('stand');
  });

  it('a hold that arrives during a one-shot is taken after recovery (not stand)', () => {
    const s = matchAt(900);
    const ev = run(s, 30, { 0: ['jab', null], 3: ['block_high', null] });
    expect(ofType(ev, 'applied').map((e) => [e.tick, e.move])).toEqual([
      [0, 'jab'],
      [15, 'block_high'],
    ]);
    expect(ofType(ev, 'dropped')).toEqual([]);
    expect(s.fighters[0].action).toBe('block_high');
  });

  it('a one-shot with no hold during it still returns to stand', () => {
    const s = matchAt(900);
    run(s, 30, { 0: ['block_high', null], 1: ['jab', null] });
    expect(s.fighters[0].action).toBe('stand');
  });
});

describe('inputs are never lost silently', () => {
  it('a buffered one-shot replaced by a newer one-shot is dropped as superseded', () => {
    const s = matchAt(900);
    const ev = run(s, 40, { 0: ['uppercut', null], 10: ['jab', null], 12: ['sweep', null] });
    expect(ofType(ev, 'dropped')).toEqual([
      { type: 'dropped', tick: 12, fighter: 0, move: 'jab', reason: 'superseded' },
      { type: 'dropped', tick: 17, fighter: 0, move: 'sweep', reason: 'busy' },
    ]);
  });

  it('a buffered one-shot replaced by a hold is dropped as superseded', () => {
    const s = matchAt(900);
    const ev = run(s, 40, { 0: ['jab', null], 10: ['sweep', null], 12: ['block_low', null] });
    expect(ofType(ev, 'dropped')).toEqual([
      { type: 'dropped', tick: 12, fighter: 0, move: 'sweep', reason: 'superseded' },
    ]);
    expect(s.fighters[0].action).toBe('block_low');
  });

  it('a buffered one-shot replaced while idle (fireball on cooldown) is superseded', () => {
    const s = matchAt(900);
    // Fireball busy ticks 0..32; a second fireball at 40 waits on the cooldown; jab replaces it.
    const ev = run(s, 50, { 0: ['fireball', null], 40: ['fireball', null], 42: ['jab', null] });
    expect(ofType(ev, 'dropped')).toEqual([
      { type: 'dropped', tick: 42, fighter: 0, move: 'fireball', reason: 'superseded' },
    ]);
    expect(ofType(ev, 'applied').map((e) => [e.tick, e.move])).toEqual([
      [0, 'fireball'],
      [42, 'jab'],
    ]);
  });

  it('something buffered when the round ends is dropped as notFighting', () => {
    const s = createMatch(1, { roundTicks: 10 });
    // P0 sweep buffered behind a jab; P1's buffered sweep is replaced by a pending hold.
    // The round ends on tick 9 with both still busy.
    const ev = run(s, 10, {
      0: ['jab', null],
      7: [null, 'jab'],
      8: ['sweep', 'sweep'],
      9: [null, 'block_low'],
    });
    expect(ofType(ev, 'roundEnd')).toHaveLength(1);
    expect(ofType(ev, 'dropped')).toEqual([
      { type: 'dropped', tick: 9, fighter: 1, move: 'sweep', reason: 'superseded' },
      { type: 'dropped', tick: 9, fighter: 0, move: 'sweep', reason: 'notFighting' },
      { type: 'dropped', tick: 9, fighter: 1, move: 'block_low', reason: 'notFighting' },
    ]);
  });

  it('a pending hold when the round ends is dropped as notFighting', () => {
    const s = createMatch(1, { roundTicks: 10 });
    const ev = run(s, 10, { 0: ['jab', null], 8: ['block_low', null] });
    expect(ofType(ev, 'dropped')).toEqual([
      { type: 'dropped', tick: 9, fighter: 0, move: 'block_low', reason: 'notFighting' },
    ]);
  });
});
