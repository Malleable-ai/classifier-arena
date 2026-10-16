import { describe, expect, it } from 'vitest';
import {
  RANDOM_BASELINE,
  createPlayer,
  gameBaselines,
  listPlayers,
  type BaselineFactory,
} from '../../../src/core/classifier/players.js';
import { emptyResult, type Decider } from '../../../src/core/classifier/types.js';
import { createPrng } from '../../../src/core/util/prng.js';
import { buildQuestion } from '../../../src/games/fighter/question.js';
import { MOVE_IDS } from '../../../src/games/fighter/engine/types.js';
import { SAMPLE_VIEW, fakeFetch, readFixture } from '../../games/fighter/sample-view.js';
import { createFakeClock } from '../util/fake-clock.js';

/** A game-supplied baseline that always answers `id`. */
const constant =
  (id: string): BaselineFactory =>
  (): Decider => ({
    player: 'always',
    decide: () => Promise.resolve(emptyResult('ok', 0, id)),
  });

describe('gameBaselines', () => {
  it("lists random, then the game's own ids with the game's labels", () => {
    expect(
      gameBaselines({
        baselines: ['scripted', 'human'],
        baselineLabels: { scripted: 'Scripted bot', human: 'Human (keys)' },
      }),
    ).toEqual([
      RANDOM_BASELINE,
      { id: 'scripted', label: 'Scripted bot' },
      { id: 'human', label: 'Human (keys)' },
    ]);
    expect(gameBaselines({ baselines: [] })).toEqual([RANDOM_BASELINE]);
  });

  it('labels an id the game gives no label by the id itself, never by an inherited key', () => {
    expect(
      gameBaselines({ baselines: ['parity', 'constructor'], baselineLabels: { other: 'Other' } }),
    ).toEqual([
      RANDOM_BASELINE,
      { id: 'parity', label: 'parity' },
      { id: 'constructor', label: 'constructor' },
    ]);
    expect(gameBaselines({ baselines: ['parity'] })[1]).toEqual({ id: 'parity', label: 'parity' });
  });
});

describe('listPlayers', () => {
  it('lists providers with availability from env, then random by default', () => {
    const players = listPlayers({ OPENAI_API_KEY: 'k' });
    expect(players.map((p) => [p.id, p.kind, p.available])).toEqual([
      ['jev', 'provider', false],
      ['openai', 'provider', true],
      ['random', 'baseline', true],
    ]);
    expect(players[0]?.missingEnv).toEqual(['TYPESAFE_API_KEY']);
    expect(players[2]?.label).toBe(RANDOM_BASELINE.label);
  });

  it("lists a game's baselines in the order given", () => {
    const baselines = [RANDOM_BASELINE, { id: 'always', label: 'Always up' }];
    expect(listPlayers({}, [], baselines)).toEqual([
      { id: 'random', label: 'Random (uniform)', kind: 'baseline', available: true },
      { id: 'always', label: 'Always up', kind: 'baseline', available: true },
    ]);
  });
});

describe('createPlayer', () => {
  const clock = createFakeClock();

  it('creates a provider decider from deps.env', async () => {
    const fetchImpl = fakeFetch(200, readFixture('openai/choice-ok.json'));
    const p = createPlayer('openai', { env: { OPENAI_API_KEY: 'k' }, clock, fetchImpl });
    expect(p.player).toBe('openai');
    const res = await p.decide(SAMPLE_VIEW, buildQuestion(MOVE_IDS), new AbortController().signal);
    expect(res.choice).toBe('heavy_punch');
  });

  it('fails clearly when a provider key is missing', () => {
    expect(() => createPlayer('jev', { env: {}, clock })).toThrow(/TYPESAFE_API_KEY/);
  });

  it('creates random from core, and requires its prng', () => {
    expect(createPlayer('random', { env: {}, clock, prng: createPrng(1) }).player).toBe('random');
    expect(() => createPlayer('random', { env: {}, clock })).toThrow(/prng/);
  });

  it("creates the game's baselines from deps.baselines, passing the deps through", async () => {
    let seen: unknown = null;
    const baselines: Record<string, BaselineFactory> = {
      always: (deps) => {
        seen = deps.baselineDelayMs;
        return constant('up')(deps);
      },
    };
    const d = createPlayer('always', { env: {}, clock, baselines, baselineDelayMs: 50 });
    expect(seen).toBe(50);
    const q = { name: 'q', instructions: 'i', options: [{ id: 'up', description: 'u' }] };
    expect((await d.decide({}, q, new AbortController().signal)).choice).toBe('up');
  });

  it('knows no baseline beyond random without deps.baselines', () => {
    expect(() => createPlayer('scripted', { env: {}, clock })).toThrow(/unknown player scripted/);
  });

  it('rejects unknown ids, including object prototype keys', () => {
    const baselines = { always: constant('up') };
    for (const id of ['nobody', 'constructor', 'toString', '__proto__']) {
      expect(() => createPlayer(id, { env: {}, clock, baselines })).toThrow(/unknown player/);
    }
  });
});
