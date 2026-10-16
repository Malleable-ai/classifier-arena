import { afterEach, describe, expect, it, vi } from 'vitest';
import { isRetryableStatus, postJson } from '../../../src/core/classifier/http.js';
import { fakeFetch } from '../../games/fighter/sample-view.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('postJson', () => {
  it('posts JSON and returns status, response headers, parsed body and latency', async () => {
    const fetchImpl = fakeFetch(200, { ok: 1 }, { 'content-type': 'application/json', 'x-a': 'b' });
    const res = await postJson(
      'https://example.test/v1',
      { hello: 'world' },
      { headers: { authorization: 'Bearer sk-secret' }, fetchImpl },
    );
    expect(res.status).toBe(200);
    expect(res.ok).toBe(true);
    expect(res.retryable).toBe(false);
    expect(res.body).toEqual({ ok: 1 });
    expect(res.headers['x-a']).toBe('b');
    expect(res.latencyMs).toBeGreaterThanOrEqual(0);
    const call = fetchImpl.calls[0];
    expect(call?.init?.method).toBe('POST');
    expect(call?.init?.body).toBe('{"hello":"world"}');
    const sent = new Headers(call?.init?.headers);
    expect(sent.get('content-type')).toBe('application/json');
    expect(sent.get('authorization')).toBe('Bearer sk-secret');
  });

  it('never returns or logs request headers', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    const res = await postJson(
      'https://example.test/v1',
      {},
      { headers: { authorization: 'Bearer sk-secret' }, fetchImpl: fakeFetch(500, 'boom') },
    );
    expect(JSON.stringify(res)).not.toContain('sk-secret');
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it('keeps a non-JSON body as text', async () => {
    const res = await postJson(
      'https://x.test',
      {},
      { headers: {}, fetchImpl: fakeFetch(502, 'bad gateway') },
    );
    expect(res.body).toBe('bad gateway');
    expect(res.retryable).toBe(true);
  });

  it('rejects when the caller aborts', async () => {
    const ctl = new AbortController();
    ctl.abort();
    const fetchImpl = ((_u: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        if (init?.signal?.aborted) reject(init.signal.reason as Error);
      })) as typeof fetch;
    await expect(
      postJson('https://x.test', {}, { headers: {}, signal: ctl.signal, fetchImpl }),
    ).rejects.toThrow();
  });

  it('rejects with a TimeoutError after timeoutMs', async () => {
    const fetchImpl = ((_u: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(init.signal?.reason as Error);
        });
      })) as typeof fetch;
    await expect(
      postJson('https://x.test', {}, { headers: {}, timeoutMs: 5, fetchImpl }),
    ).rejects.toMatchObject({ name: 'TimeoutError' });
  });
});

describe('isRetryableStatus', () => {
  it('treats 429 and 5xx as retryable', () => {
    expect([429, 500, 503, 599].map(isRetryableStatus)).toEqual([true, true, true, true]);
    expect([200, 400, 401, 404, 422].map(isRetryableStatus)).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
  });
});
