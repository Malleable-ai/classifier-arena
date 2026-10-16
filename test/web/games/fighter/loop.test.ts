import { describe, expect, it } from 'vitest';
import {
  advanceAccumulator,
  createFixedStepLoop,
  TICK_MS,
} from '../../../../src/web/games/fighter/loop.js';

describe('advanceAccumulator', () => {
  it('runs whole ticks and carries the remainder', () => {
    const r = advanceAccumulator(0, TICK_MS * 2.5);
    expect(r.ticks).toBe(2);
    expect(r.acc).toBeCloseTo(TICK_MS * 0.5);
    const r2 = advanceAccumulator(r.acc, TICK_MS * 0.6);
    expect(r2.ticks).toBe(1);
  });

  it('caps catch-up at 5 ticks and drops the backlog', () => {
    expect(advanceAccumulator(0, 1000)).toEqual({ ticks: 5, acc: 0 });
  });

  it('ignores negative time', () => {
    expect(advanceAccumulator(3, -50)).toEqual({ ticks: 0, acc: 3 });
  });
});

function fakeClock() {
  let pending: ((t: number) => void) | null = null;
  return {
    requestFrame: (cb: (t: number) => void) => {
      pending = cb;
      return 1;
    },
    cancelFrame: () => {
      pending = null;
    },
    frame(t: number) {
      const cb = pending;
      pending = null;
      cb?.(t);
    },
  };
}

describe('createFixedStepLoop', () => {
  it('runs 60 ticks per simulated second at any frame rate', () => {
    for (const fps of [30, 60, 144]) {
      const clock = fakeClock();
      let ticks = 0;
      let frames = 0;
      const loop = createFixedStepLoop({
        onTick: () => (ticks += 1),
        onFrame: () => (frames += 1),
        requestFrame: clock.requestFrame,
        cancelFrame: clock.cancelFrame,
      });
      loop.start();
      for (let i = 0; i <= fps; i++) clock.frame((i * 1000) / fps);
      expect(ticks, `fps ${String(fps)}`).toBeGreaterThanOrEqual(59);
      expect(ticks).toBeLessThanOrEqual(60);
      expect(frames).toBe(fps + 1);
      loop.stop();
    }
  });

  it('caps a long stall at 5 ticks', () => {
    const clock = fakeClock();
    let ticks = 0;
    const loop = createFixedStepLoop({
      onTick: () => (ticks += 1),
      onFrame: () => undefined,
      requestFrame: clock.requestFrame,
      cancelFrame: clock.cancelFrame,
    });
    loop.start();
    clock.frame(0);
    clock.frame(5000);
    expect(ticks).toBe(5);
  });

  it('pauses ticks but keeps drawing; stepTicks runs exact ticks', () => {
    const clock = fakeClock();
    let ticks = 0;
    let frames = 0;
    const loop = createFixedStepLoop({
      onTick: () => (ticks += 1),
      onFrame: () => (frames += 1),
      requestFrame: clock.requestFrame,
      cancelFrame: clock.cancelFrame,
    });
    loop.start();
    clock.frame(0);
    loop.pause();
    clock.frame(100);
    clock.frame(200);
    expect(ticks).toBe(0);
    expect(frames).toBe(3);
    loop.stepTicks(7);
    expect(ticks).toBe(7);
    loop.resume();
    clock.frame(200 + TICK_MS * 1.5);
    expect(ticks).toBe(8);
  });
});
