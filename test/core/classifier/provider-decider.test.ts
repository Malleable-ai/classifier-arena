import { describe, expect, it } from 'vitest';
import {
  PROVIDERS,
  resolveProvider,
  type ProviderEntry,
} from '../../../src/core/classifier/providers.js';
import { createProviderDecider } from '../../../src/core/classifier/provider-decider.js';
import { REFUSAL_ERROR, type Question } from '../../../src/core/classifier/types.js';
import { buildQuestion } from '../../../src/games/fighter/question.js';
import { MOVE_IDS } from '../../../src/games/fighter/engine/types.js';
import { SAMPLE_VIEW, fakeFetch, readFixture } from '../../games/fighter/sample-view.js';

const jev = PROVIDERS.find((p) => p.id === 'jev');
if (!jev) throw new Error('jev missing');
const resolved = resolveProvider(jev, { TYPESAFE_API_KEY: 'sk-test-secret' });
const q = buildQuestion(MOVE_IDS);
const live = () => new AbortController().signal;

describe('createProviderDecider', () => {
  it('returns the parsed choice with cost from the entry price and latency', async () => {
    const fetchImpl = fakeFetch(200, readFixture('jev/choice-ok.json'));
    const decider = createProviderDecider(resolved, { fetchImpl });
    expect(decider.player).toBe('jev');
    const res = await decider.decide(SAMPLE_VIEW, q, live());
    expect(res).toMatchObject({
      choice: 'fireball',
      status: 'ok',
      confidence: 0.66,
      inputTokens: 1166,
      modelVersion: 'jev-1.13.0',
    });
    expect(res.costUsd).toBeCloseTo((1166 * 0.042) / 1_000_000, 12);
    expect(res.latencyMs).toBeGreaterThanOrEqual(0);
    expect(new Headers(fetchImpl.calls[0]?.init?.headers).get('authorization')).toBe(
      'Bearer sk-test-secret',
    );
  });

  it('keeps raw request/response for the snapshot writer, without auth headers', async () => {
    const fetchImpl = fakeFetch(200, readFixture('jev/choice-ok.json'));
    const res = await createProviderDecider(resolved, { fetchImpl }).decide(SAMPLE_VIEW, q, live());
    expect(res.raw?.request).toMatchObject({ url: 'https://api.typesafe.ai/v1/systemone' });
    expect((res.raw?.request as { body: unknown }).body).toEqual(
      readFixture('jev/choice-ok.request.json'),
    );
    expect((res.raw?.response as { status: number }).status).toBe(200);
    expect(JSON.stringify(res)).not.toContain('sk-test-secret');
  });

  it.each([429, 500, 503, 401])(
    'maps HTTP %i to error with the status in the message',
    async (status) => {
      const res = await createProviderDecider(resolved, {
        fetchImpl: fakeFetch(status, { error: 'x' }),
      }).decide(SAMPLE_VIEW, q, live());
      expect(res.status).toBe('error');
      expect(res.choice).toBeNull();
      expect(res.costUsd).toBe(0);
      expect(res.error).toMatch(new RegExp(`^http ${String(status)}\\b`));
    },
  );

  it.each([
    [401, 'http 401 unauthorized'],
    [403, 'http 403 forbidden'],
  ])('logs only the status for HTTP %i, never the provider message', async (status, want) => {
    const body = { error: { message: 'Incorrect API key provided: sk-te****cret' } };
    const res = await createProviderDecider(resolved, {
      fetchImpl: fakeFetch(status, body),
    }).decide(SAMPLE_VIEW, q, live());
    expect(res.status).toBe('error');
    expect(res.error).toBe(want);
    expect(res.error).not.toContain('sk-');
  });

  it('maps an invalid choice to error', async () => {
    const body = structuredClone(readFixture('jev/choice-ok.json')) as {
      answers: { next_move: { choice: string } };
    };
    body.answers.next_move.choice = 'nope';
    const res = await createProviderDecider(resolved, { fetchImpl: fakeFetch(200, body) }).decide(
      SAMPLE_VIEW,
      q,
      live(),
    );
    expect(res.status).toBe('error');
    expect(res.error).toMatch(/nope/);
  });

  it('answers a refusal with status refusal (not an error) and charges its input tokens', async () => {
    const openai = PROVIDERS.find((p) => p.id === 'openai');
    if (!openai) throw new Error('openai missing');
    const r = resolveProvider(openai, { OPENAI_API_KEY: 'sk-test-secret' });
    const res = await createProviderDecider(r, {
      fetchImpl: fakeFetch(200, readFixture('openai/choice-refusal.json')),
    }).decide(SAMPLE_VIEW, q, live());
    expect(res.status).toBe('refusal');
    // The same message refusals were logged with before the status existed.
    expect(res.error).toBe(REFUSAL_ERROR);
    expect(res.choice).toBeNull();
    // A well-formed answer: it still names the model (the header's version on a refused warm-up).
    expect(res.modelVersion).toBe('gpt-6-luna');
    expect(res.inputTokens).toBe(148);
    expect(res.costUsd).toBeCloseTo((148 * 0.1) / 1_000_000, 12);
  });

  it('maps a caller abort to timeout', async () => {
    const ctl = new AbortController();
    const fetchImpl = ((_u: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(init.signal?.reason as Error);
        });
        ctl.abort();
      })) as typeof fetch;
    const res = await createProviderDecider(resolved, { fetchImpl }).decide(
      SAMPLE_VIEW,
      q,
      ctl.signal,
    );
    expect(res.status).toBe('timeout');
    expect(res.choice).toBeNull();
  });

  it('maps its own timeoutMs to timeout', async () => {
    const fetchImpl = ((_u: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(init.signal?.reason as Error);
        });
      })) as typeof fetch;
    const res = await createProviderDecider(resolved, { fetchImpl, timeoutMs: 5 }).decide(
      SAMPLE_VIEW,
      q,
      live(),
    );
    expect(res.status).toBe('timeout');
  });

  it('maps a network failure to error', async () => {
    const fetchImpl = (() => Promise.reject(new TypeError('fetch failed'))) as typeof fetch;
    const res = await createProviderDecider(resolved, { fetchImpl }).decide(SAMPLE_VIEW, q, live());
    expect(res.status).toBe('error');
    expect(res.error).toMatch(/fetch failed/);
  });
});

/** A question with `n` options `o0…o(n-1)`. */
function questionOf(n: number): Question {
  return {
    name: 'pick',
    instructions: 'Pick one.',
    options: Array.from({ length: n }, (_, i) => ({ id: `o${String(i)}`, description: 'x' })),
  };
}

describe('maxOptions, checked per question', () => {
  const openai = PROVIDERS.find((p) => p.id === 'openai');
  if (!openai) throw new Error('openai missing');
  const small: ProviderEntry = { ...openai, capabilities: { probabilities: true, maxOptions: 3 } };
  const env = { OPENAI_API_KEY: 'sk-test-secret' };

  it('answers error with cost 0 and sends no request when a question has too many options', async () => {
    const fetchImpl = fakeFetch(200, readFixture('openai/choice-ok.json'));
    const res = await createProviderDecider(resolveProvider(small, env), { fetchImpl }).decide(
      { any: 'state' },
      questionOf(4),
      live(),
    );
    expect(res).toMatchObject({
      status: 'error',
      error: 'too many options: 4 > 3',
      choice: null,
      costUsd: 0,
      inputTokens: null,
    });
    expect(fetchImpl.calls).toHaveLength(0);
  });

  it("uses each provider's own limit: openai takes 11 (and up to 16), not 17", async () => {
    const fetchImpl = fakeFetch(200, readFixture('openai/choice-ok.json'));
    const decider = createProviderDecider(resolveProvider(openai, env), { fetchImpl });
    expect((await decider.decide(SAMPLE_VIEW, q, live())).status).toBe('ok');
    const res = await decider.decide(SAMPLE_VIEW, questionOf(17), live());
    expect(res.error).toBe('too many options: 17 > 16');
    expect(fetchImpl.calls).toHaveLength(1);
  });

  it('sends a question with exactly maxOptions options', async () => {
    const fetchImpl = fakeFetch(200, { answers: [] });
    const res = await createProviderDecider(resolveProvider(small, env), { fetchImpl }).decide(
      {},
      questionOf(3),
      live(),
    );
    expect(fetchImpl.calls).toHaveLength(1);
    // Sent and parsed (the fake answer is empty): the option count was not the problem.
    expect(res.error).toBe('invalid answer: no answer named pick');
  });
});
