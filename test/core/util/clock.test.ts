import { describe, expect, it } from 'vitest';
import { SimClock } from '../../../src/core/util/clock.js';

describe('SimClock', () => {
  it('wakes sleepers in due order and sets now() to each due time', async () => {
    const clock = new SimClock();
    const woke: [string, number][] = [];
    void clock.sleep(30).then(() => woke.push(['b', clock.now()]));
    void clock.sleep(10).then(() => woke.push(['a', clock.now()]));
    void clock.sleep(30).then(() => woke.push(['c', clock.now()]));
    await clock.advance(25);
    expect(woke).toEqual([['a', 10]]);
    expect(clock.now()).toBe(25);
    await clock.advance(5);
    expect(woke).toEqual([
      ['a', 10],
      ['b', 30],
      ['c', 30],
    ]);
  });

  it('rejects a sleeper whose signal aborts, and never wakes it', async () => {
    const clock = new SimClock();
    const ac = new AbortController();
    const p = clock.sleep(10, ac.signal);
    ac.abort(new Error('stop'));
    await expect(p).rejects.toThrow('stop');
    expect(clock.nextDue()).toBeNull();
  });
});
