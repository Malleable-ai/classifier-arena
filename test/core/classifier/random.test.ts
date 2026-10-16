import { describe, expect, it } from 'vitest';
import { createRandomDecider, randomDeciderSeed } from '../../../src/core/classifier/random.js';
import type { Question } from '../../../src/core/classifier/types.js';
import { createPrng } from '../../../src/core/util/prng.js';
import { orderOptions } from '../../../src/core/classifier/order.js';
import {
  FIGHTER_QUESTION_KEY,
  buildQuestion,
  FIGHTER_QUESTION,
} from '../../../src/games/fighter/question.js';
import { buildView } from '../../../src/games/fighter/view.js';
import { createMatch } from '../../../src/games/fighter/engine/sim.js';
import { MOVE_IDS } from '../../../src/games/fighter/engine/types.js';
import { createFakeClock } from '../util/fake-clock.js';

const view = buildView(createMatch(1), 0);
const question = buildQuestion(MOVE_IDS);
const signal = new AbortController().signal;

async function picks(seed: number, n: number, q: Question = question): Promise<string[]> {
  const d = createRandomDecider({ prng: createPrng(seed), clock: createFakeClock() });
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const r = await d.decide(view, q, signal);
    if (r.choice === null) throw new Error('no choice');
    out.push(r.choice);
  }
  return out;
}

describe('random decider', () => {
  it('is player "random" and waits delayMs on the injected clock', async () => {
    const clock = createFakeClock(1000);
    const d = createRandomDecider({ prng: createPrng(1), clock, delayMs: 150 });
    expect(d.player).toBe('random');
    const r = await d.decide(view, question, signal);
    expect(clock.sleeps).toEqual([150]);
    expect(r).toMatchObject({
      status: 'ok',
      latencyMs: 150,
      costUsd: 0,
      inputTokens: null,
      probabilities: null,
      confidence: null,
    });
  });

  it('defaults to a 200 ms delay', async () => {
    const clock = createFakeClock();
    await createRandomDecider({ prng: createPrng(1), clock }).decide(view, question, signal);
    expect(clock.sleeps).toEqual([200]);
  });

  it('gives the same sequence for the same seed', async () => {
    expect(await picks(9, 20)).toEqual(await picks(9, 20));
    expect(await picks(9, 20)).not.toEqual(await picks(10, 20));
  });

  it('seeds the two seats differently (formula unchanged)', () => {
    expect(randomDeciderSeed(5, 0)).not.toBe(randomDeciderSeed(5, 1));
    expect(randomDeciderSeed(5, 0)).toBe(randomDeciderSeed(5, 0));
    expect([randomDeciderSeed(1, 0), randomDeciderSeed(1, 1)]).toEqual([
      (0x9e3779b1 ^ 0x51ed270b) >>> 0,
      (0x9e3779b1 ^ 0x2545f491) >>> 0,
    ]);
  });

  it('is uniform-ish over 11k picks', async () => {
    const counts = new Map<string, number>();
    for (const m of await picks(3, 11000)) counts.set(m, (counts.get(m) ?? 0) + 1);
    expect(counts.size).toBe(11);
    for (const c of counts.values()) {
      expect(c).toBeGreaterThan(850);
      expect(c).toBeLessThan(1150);
    }
  });

  it("samples any question's options, not the fighter's moves", async () => {
    const q: Question = {
      name: 'pick',
      instructions: 'Pick one.',
      options: ['up', 'down', 'left'].map((id) => ({ id, description: id })),
    };
    const got = await picks(4, 300, q);
    expect(new Set(got)).toEqual(new Set(['up', 'down', 'left']));
  });

  it("picks by index into the question's option list, so it follows the question's order", async () => {
    const reordered = orderOptions(FIGHTER_QUESTION, 7, FIGHTER_QUESTION_KEY);
    expect(reordered.options.map((o) => o.id)).not.toEqual([...MOVE_IDS]);
    const indexIn = (q: Question) => (id: string) => q.options.findIndex((o) => o.id === id);
    const canonical = (await picks(11, 50)).map(indexIn(question));
    expect((await picks(11, 50, reordered)).map(indexIn(reordered))).toEqual(canonical);
  });

  it('returns a timeout with no choice when aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const d = createRandomDecider({ prng: createPrng(1), clock: createFakeClock() });
    const r = await d.decide(view, question, ac.signal);
    expect(r.status).toBe('timeout');
    expect(r.choice).toBeNull();
  });

  it('returns an error for a question with no options', async () => {
    const d = createRandomDecider({ prng: createPrng(1), clock: createFakeClock() });
    const r = await d.decide(view, { name: 'x', instructions: 'y', options: [] }, signal);
    expect(r).toMatchObject({ status: 'error', choice: null, error: 'question has no options' });
  });
});
