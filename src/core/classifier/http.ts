/**
 * The one place deciders talk HTTP. Request headers carry API keys, so this module never logs
 * them and never returns them: the result holds only the response's status, headers and body.
 */

export interface PostJsonOptions {
  /** Request headers (auth included). Sent, never logged or returned. */
  headers: Record<string, string>;
  signal?: AbortSignal;
  /** Aborts with a `TimeoutError` after this many ms. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface PostJsonResult {
  status: number;
  ok: boolean;
  /** 429 and 5xx: the caller may back off and try again. */
  retryable: boolean;
  /** Response headers only. */
  headers: Record<string, string>;
  /** Parsed JSON, or the raw text if the body isn't JSON. */
  body: unknown;
  /** `performance.now()` around the whole request, including reading the body. */
  latencyMs: number;
}

export function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

/** POST `body` as JSON. Rejects on network failure, caller abort or timeout. */
export async function postJson(
  url: string,
  body: unknown,
  { headers, signal, timeoutMs, fetchImpl = fetch }: PostJsonOptions,
): Promise<PostJsonResult> {
  const signals: AbortSignal[] = [];
  if (signal) signals.push(signal);
  if (timeoutMs !== undefined) signals.push(AbortSignal.timeout(timeoutMs));
  const combined = signals.length > 0 ? AbortSignal.any(signals) : undefined;

  const start = performance.now();
  const init: RequestInit = {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  };
  if (combined) init.signal = combined;
  const res = await fetchImpl(url, init);
  const text = await res.text();
  const latencyMs = performance.now() - start;

  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    // keep the text
  }
  const responseHeaders: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    responseHeaders[key] = value;
  });
  return {
    status: res.status,
    ok: res.ok,
    retryable: isRetryableStatus(res.status),
    headers: responseHeaders,
    body: parsed,
    latencyMs,
  };
}

/** True for a caller abort or a `timeoutMs` expiry. */
export function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
}
