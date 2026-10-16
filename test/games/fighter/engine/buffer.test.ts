import { describe, expect, it } from 'vitest';
import { matchAt, ofType, run } from './combat-helpers.js';

describe('input buffer', () => {
  it('a move during hitstun waits 6 ticks, then is dropped as busy', () => {
    const s = matchAt(100);
    // Heavy hits fighter 0 on tick 9; hitstun 22 keeps it busy well past tick 17.
    const ev = run(s, 30, { 0: [null, 'heavy_punch'], 12: ['jab', null] });
    expect(ofType(ev, 'hit')).toHaveLength(1);
    expect(ofType(ev, 'dropped')).toEqual([
      { type: 'dropped', tick: 17, fighter: 0, move: 'jab', reason: 'busy' },
    ]);
    expect(ofType(ev, 'applied').filter((e) => e.fighter === 0)).toEqual([]);
    expect(s.fighters[0].buffered).toBeNull();
  });

  it('a move buffered during recovery starts on the first free tick', () => {
    const s = matchAt(900);
    // Jab occupies ticks 0..14; fighter is free on tick 15.
    const ev = run(s, 20, { 0: ['jab', null], 12: ['sweep', null] });
    expect(ofType(ev, 'applied').map((e) => [e.tick, e.move])).toEqual([
      [0, 'jab'],
      [15, 'sweep'],
    ]);
    expect(ofType(ev, 'dropped')).toEqual([]);
  });

  it('a buffered hold is applied via applyHold once free', () => {
    const s = matchAt(900);
    const ev = run(s, 20, { 0: ['jab', null], 13: ['block_high', null] });
    expect(ofType(ev, 'applied').map((e) => [e.tick, e.move])).toEqual([
      [0, 'jab'],
      [15, 'block_high'],
    ]);
    expect(s.fighters[0].action).toBe('block_high');
  });

  it('a one-shot arriving in the air waits, then drops', () => {
    const s = matchAt(900);
    const ev = run(s, 20, { 0: ['jump_in', null], 5: ['jab', null] });
    expect(ofType(ev, 'dropped')).toEqual([
      { type: 'dropped', tick: 10, fighter: 0, move: 'jab', reason: 'busy' },
    ]);
  });
});

describe('after a one-shot the fighter stands without blocking', () => {
  it('returns to stand, so a heavy that block_high would stop now hits', () => {
    // 125 apart: out of the jab's reach (120), inside the heavy's (130).
    const s = matchAt(125);
    const actions: string[] = [];
    const ev = run(
      s,
      25,
      { 0: ['block_high', null], 1: ['jab', null], 8: [null, 'heavy_punch'] },
      () => actions.push(s.fighters[0].action),
    );
    expect(actions[15]).toBe('jab');
    expect(actions[16]).toBe('stand');
    expect(ofType(ev, 'blocked')).toEqual([]);
    expect(ofType(ev, 'hit')).toEqual([
      expect.objectContaining({ tick: 17, fighter: 1, target: 0, move: 'heavy_punch' }),
    ]);
  });

  it('control: holding block_high (no jab) blocks the same heavy', () => {
    const s = matchAt(125);
    const ev = run(s, 25, { 0: ['block_high', null], 8: [null, 'heavy_punch'] });
    expect(ofType(ev, 'hit')).toEqual([]);
    expect(ofType(ev, 'blocked')).toHaveLength(1);
  });

  it('getting hit while holding a block keeps the hold after hitstun', () => {
    const s = matchAt(100);
    run(s, 40, { 0: ['sweep', 'block_low'] });
    // block_low blocks the sweep; still holding it afterwards.
    expect(s.fighters[1].action).toBe('block_low');
    expect(s.fighters[1].phase).toBe('idle');
  });
});
