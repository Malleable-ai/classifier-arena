import { existsSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FORMATS } from '../../../src/core/classifier/formats/index.js';
import { createProviderDecider } from '../../../src/core/classifier/provider-decider.js';
import { PROVIDERS, resolveProvider } from '../../../src/core/classifier/providers.js';
import type { Question } from '../../../src/core/classifier/types.js';
import { FIGHTER_QUESTION, buildQuestion } from '../../../src/games/fighter/question.js';
import { MOVE_IDS } from '../../../src/games/fighter/engine/types.js';
import type { MoveId } from '../../../src/games/fighter/engine/types.js';
import {
  FIXTURES_DIR,
  SAMPLE_VIEW,
  dummyEnv,
  fakeFetch,
  readFixture,
  rotatedOrder,
} from '../../games/fighter/sample-view.js';

/**
 * Every built-in provider must pass this suite against its own recorded spike fixtures in
 * test/fixtures/<id>/. A provider without fixtures fails, so none can be registered unrecorded.
 * The recorded bodies use the fighter's canonical question (the only game so far); the 16-option
 * question below checks the shape any game's question takes on the wire.
 */

/** The fighter's canonical question (options in MOVE_IDS order), as the game asks it. */
const q: Question = FIGHTER_QUESTION;

/** A non-fighter question with 16 options and a non-fighter state. */
const Q16: Question = {
  name: 'pick_one',
  instructions: 'Pick the option that fits the state best.',
  options: Array.from({ length: 16 }, (_, i) => ({
    id: `option_${String(i).padStart(2, '0')}`,
    description: `Option number ${String(i)}: "quoted", unicode é ✓.`,
  })),
};
const STATE16 = {
  board: [
    [1, 0],
    [0, 2],
  ],
  turn: 3,
  note: 'not a fighter view',
};

/** `choice-error-<status>.json` (not the `.request.json` beside it). */
function errorFixtures(id: string): { file: string; status: number }[] {
  const dir = new URL(`${id}/`, FIXTURES_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((file) => /^choice-error-(\d{3})\.json$/.exec(file))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ file: `${id}/${m[0]}`, status: Number(m[1]) }));
}

describe('PROVIDERS', () => {
  it('has at least the two built-ins under test', () => {
    expect(PROVIDERS.length).toBeGreaterThanOrEqual(2);
  });
});

describe.each(PROVIDERS.map((p) => [p.id, p] as const))('provider %s', (id, provider) => {
  const format = FORMATS[provider.format];

  it('has recorded fixtures', () => {
    for (const f of ['choice-ok.request.json', 'choice-ok.json']) {
      expect(existsSync(new URL(`${id}/${f}`, FIXTURES_DIR)), `${id}/${f}`).toBe(true);
    }
    expect(errorFixtures(id).length, `${id}/choice-error-<status>.json`).toBeGreaterThan(0);
  });

  it('builds the recorded request body for the shared sample view', () => {
    expect(format.buildBody(SAMPLE_VIEW, q, provider.model)).toEqual(
      readFixture(`${id}/choice-ok.request.json`),
    );
  });

  it('builds the recorded request body byte for byte through the decider', async () => {
    const fetchImpl = fakeFetch(200, readFixture(`${id}/choice-ok.json`));
    const decider = createProviderDecider(resolveProvider(provider, dummyEnv(provider)), {
      fetchImpl,
    });
    await decider.decide(SAMPLE_VIEW, q, new AbortController().signal);
    expect(fetchImpl.calls[0]?.init?.body).toBe(
      JSON.stringify(readFixture(`${id}/choice-ok.request.json`)),
    );
  });

  it('parses choice-ok.json to one of MOVE_IDS through the decider', async () => {
    const decider = createProviderDecider(resolveProvider(provider, dummyEnv(provider)), {
      fetchImpl: fakeFetch(200, readFixture(`${id}/choice-ok.json`)),
    });
    const res = await decider.decide(SAMPLE_VIEW, q, new AbortController().signal);
    expect(res.status).toBe('ok');
    expect(MOVE_IDS).toContain(res.choice);
    expect(res.inputTokens).toBeGreaterThan(0);
    expect(res.costUsd).toBeGreaterThan(0);
    if (provider.capabilities.probabilities) {
      expect(Object.keys(res.probabilities ?? {}).sort()).toEqual([...MOVE_IDS].sort());
    }
  });

  it('maps its recorded error fixture to status error with the HTTP status', async () => {
    for (const { file, status } of errorFixtures(id)) {
      const decider = createProviderDecider(resolveProvider(provider, dummyEnv(provider)), {
        fetchImpl: fakeFetch(status, readFixture(file)),
      });
      const res = await decider.decide(SAMPLE_VIEW, q, new AbortController().signal);
      expect(res.status, file).toBe('error');
      expect(res.error, file).toMatch(new RegExp(`^http ${String(status)}\\b`));
    }
  });
});

const pairs = PROVIDERS.flatMap((a, i) =>
  PROVIDERS.slice(i + 1).map((b) => [a.id, b.id, a, b] as const),
);

describe.each(pairs)('fairness: %s vs %s', (_a, _b, a, b) => {
  const orders: [string, readonly MoveId[]][] = [
    ['canonical', MOVE_IDS],
    ['rotated', rotatedOrder()],
  ];

  it.each(orders)('carry identical instructions, options and state (%s order)', (_name, order) => {
    const question = buildQuestion(order);
    const sharedA = FORMATS[a.format].extractShared(
      FORMATS[a.format].buildBody(SAMPLE_VIEW, question, a.model),
    );
    const sharedB = FORMATS[b.format].extractShared(
      FORMATS[b.format].buildBody(SAMPLE_VIEW, question, b.model),
    );

    expect(sharedA.instructions).toBe(question.instructions);
    expect(sharedB.instructions).toBe(sharedA.instructions);
    expect(sharedA.options.map((o) => o.id)).toEqual([...order]);
    expect(sharedB.options).toEqual(sharedA.options);
    expect(sharedA.options).toEqual(
      question.options.map((o) => ({ id: o.id, description: o.description })),
    );
    expect(sharedA.state).toEqual(SAMPLE_VIEW);
    expect(sharedB.state).toEqual(SAMPLE_VIEW);
  });
});

describe.each(PROVIDERS.map((p) => [p.id, p] as const))('16-option question: %s', (_id, p) => {
  it('carries all 16 options in question order, with the instructions and state', () => {
    const format = FORMATS[p.format];
    const shared = format.extractShared(format.buildBody(STATE16, Q16, p.model));
    expect(shared).toEqual({
      instructions: Q16.instructions,
      options: Q16.options.map((o) => ({ id: o.id, description: o.description })),
      state: STATE16,
    });
  });
});

describe('16-option question across providers', () => {
  it('extractShared is identical for every provider', () => {
    const shared = PROVIDERS.map((p) =>
      FORMATS[p.format].extractShared(FORMATS[p.format].buildBody(STATE16, Q16, p.model)),
    );
    expect(shared.length).toBeGreaterThanOrEqual(2);
    for (const s of shared.slice(1)) expect(s).toEqual(shared[0]);
  });
});
