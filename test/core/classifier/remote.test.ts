import { describe, expect, it } from 'vitest';
import { createRemoteDecider, type DecideRequest } from '../../../src/core/classifier/remote.js';
import { orderOptions } from '../../../src/core/classifier/order.js';
import { FIGHTER_QUESTION, FIGHTER_QUESTION_KEY } from '../../../src/games/fighter/question.js';
import { buildView } from '../../../src/games/fighter/view.js';
import { createMatch } from '../../../src/games/fighter/engine/sim.js';

const view = buildView(createMatch(7), 1);
const question = orderOptions(FIGHTER_QUESTION, 7, FIGHTER_QUESTION_KEY);

interface Sent {
  url: string;
  body: DecideRequest;
  signal: AbortSignal | null;
}

/** A fake fetch: answers after `delayMs` (or never, if null), honoring the request's signal. */
function fakeFetch(
  delayMs: number | null,
  payload: unknown = { choice: 'jab', status: 'ok' },
  status = 200,
) {
  const sent: Sent[] = [];
  const impl: typeof fetch = (input, init) => {
    const signal = init?.signal ?? null;
    sent.push({
      url: input as string,
      body: JSON.parse(init?.body as string) as DecideRequest,
      signal,
    });
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        reject(new DOMException('aborted', 'AbortError'));
      };
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      if (delayMs !== null) {
        setTimeout(() => {
          resolve(new Response(JSON.stringify(payload), { status }));
        }, delayMs);
      }
    });
  };
  return { impl, sent };
}

const ok = {
  choice: 'sweep',
  probabilities: { sweep: 0.7 },
  confidence: 0.7,
  latencyMs: 3,
  inputTokens: 800,
  costUsd: 0.00008,
  status: 'ok',
  raw: { request: 'should be dropped', response: null },
};

describe('remote decider', () => {
  it('posts game, state and the question to /decide/:player and measures latency itself', async () => {
    const f = fakeFetch(5, ok);
    let t = 100;
    const d = createRemoteDecider({
      player: 'openai',
      game: 'fighter',
      baseUrl: 'http://proxy.test',
      fetchImpl: f.impl,
      now: () => (t += 40),
    });
    const r = await d.decide(view, question, new AbortController().signal);
    expect(f.sent[0]?.url).toBe('http://proxy.test/decide/openai');
    expect(f.sent[0]?.body).toEqual({ game: 'fighter', state: view, question });
    expect(r).toMatchObject({ choice: 'sweep', status: 'ok', costUsd: 0.00008, latencyMs: 40 });
    expect(r.raw).toBeUndefined();
  });

  it('returns a timeout when the caller aborts', async () => {
    const f = fakeFetch(null);
    const d = createRemoteDecider({ player: 'jev', game: 'fighter', fetchImpl: f.impl });
    const abort = new AbortController();
    const p = d.decide(view, question, abort.signal);
    abort.abort();
    expect(await p).toMatchObject({ status: 'timeout', choice: null, costUsd: 0 });
  });

  it('times out on its own cap too', async () => {
    const f = fakeFetch(null);
    const d = createRemoteDecider({
      player: 'jev',
      game: 'fighter',
      fetchImpl: f.impl,
      timeoutMs: 20,
    });
    expect(await d.decide(view, question, new AbortController().signal)).toMatchObject({
      status: 'timeout',
    });
  });

  it('turns proxy errors and an unreachable proxy into error results', async () => {
    const bad = fakeFetch(1, { error: 'no keys' }, 400);
    const d = createRemoteDecider({ player: 'jev', game: 'fighter', fetchImpl: bad.impl });
    expect(await d.decide(view, question, new AbortController().signal)).toMatchObject({
      status: 'error',
      error: 'proxy 400: no keys',
    });
    const down: typeof fetch = () => Promise.reject(new TypeError('fetch failed'));
    const d2 = createRemoteDecider({ player: 'jev', game: 'fighter', fetchImpl: down });
    const r = await d2.decide(view, question, new AbortController().signal);
    expect(r.status).toBe('error');
    expect(r.error).toMatch(/^proxy unreachable/);
  });

  it("names snapshots by the scheduler's seq; a call without one (the warm-up) is not saved", async () => {
    const f = fakeFetch(0, ok);
    const d = createRemoteDecider({
      player: 'openai',
      game: 'fighter',
      fetchImpl: f.impl,
      snapshot: { matchId: 'm', seat: 1 },
    });
    const signal = (): AbortSignal => new AbortController().signal;
    await d.decide(view, question, signal());
    // Seqs come from the log, gaps included (a turn seat's backoff miss sends nothing).
    for (const seq of [0, 1, 4]) await d.decide(view, question, signal(), { seq });
    expect(f.sent.map((s) => s.body.snapshot?.seq ?? null)).toEqual([null, 0, 1, 4]);
    expect(f.sent[3]?.body.snapshot).toEqual({ matchId: 'm', seat: 1, seq: 4 });
  });

  it('sends no snapshot without a snapshot target, seq or not', async () => {
    const f = fakeFetch(0, ok);
    const d = createRemoteDecider({ player: 'openai', game: 'fighter', fetchImpl: f.impl });
    await d.decide(view, question, new AbortController().signal, { seq: 3 });
    expect(f.sent[0]?.body.snapshot).toBeUndefined();
  });
});
