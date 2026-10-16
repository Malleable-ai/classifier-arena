import { costUsd } from './cost.js';
import { FORMATS } from './formats/index.js';
import { Refusal, isRecord } from './formats/types.js';
import { isAbortError, postJson, type PostJsonResult } from './http.js';
import { priceOf, type ResolvedProvider } from './providers.js';
import type { Decider, DecisionResult } from './types.js';
import { REFUSAL_ERROR, emptyResult } from './types.js';

export interface ProviderDeciderOptions {
  fetchImpl?: typeof fetch;
  /** Per-request timeout on top of the caller's signal. */
  timeoutMs?: number;
}

/** Short, key-free summary of an error body for the `error` message. */
function errorSummary(body: unknown): string {
  if (isRecord(body)) {
    if (isRecord(body.error) && typeof body.error.message === 'string') return body.error.message;
    if (typeof body.error === 'string') return body.error;
  }
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return text.slice(0, 200);
}

/**
 * `http <status>: <summary>`. For 401/403 the provider's message is left out: it can echo a masked
 * fragment of the key, and the status says all there is to say.
 */
function httpError(status: number, body: unknown): string {
  if (status === 401) return 'http 401 unauthorized';
  if (status === 403) return 'http 403 forbidden';
  return `http ${String(status)}: ${errorSummary(body)}`;
}

/**
 * A Decider for one registry entry: build the body with the entry's format, POST it, unwrap the
 * envelope, parse. The choice is the API's top pick. Errors carry `http <status>` first so the
 * scheduler can back off on 429/5xx. An API that declines the question (`Refusal`) answers with
 * status `refusal` and error REFUSAL_ERROR: the model's own no-answer, not a transport failure.
 * `raw` keeps the request URL and body and the response, but never the request headers (they
 * carry the key). A question with more options than the entry's `capabilities.maxOptions` is an
 * `error` at once: nothing is sent and nothing is billed.
 */
export function createProviderDecider(
  resolved: ResolvedProvider,
  { fetchImpl, timeoutMs }: ProviderDeciderOptions = {},
): Decider {
  const { entry, url, headers } = resolved;
  const format = FORMATS[entry.format];
  const price = priceOf(entry);

  const maxOptions = entry.capabilities.maxOptions;

  return {
    player: entry.id,
    async decide(state, question, signal) {
      if (question.options.length > maxOptions) {
        const out = emptyResult('error', 0);
        out.error = `too many options: ${String(question.options.length)} > ${String(maxOptions)}`;
        return out;
      }
      const body = format.buildBody(state, question, entry.model);
      const request = { url, body };
      const start = performance.now();
      let res: PostJsonResult;
      try {
        const opts: Parameters<typeof postJson>[2] = { headers, signal };
        if (fetchImpl) opts.fetchImpl = fetchImpl;
        if (timeoutMs !== undefined) opts.timeoutMs = timeoutMs;
        res = await postJson(url, body, opts);
      } catch (err) {
        const latencyMs = performance.now() - start;
        const timedOut = signal.aborted || isAbortError(err);
        const out = emptyResult(timedOut ? 'timeout' : 'error', latencyMs);
        out.error = timedOut
          ? 'timeout'
          : `network: ${err instanceof Error ? err.message : String(err)}`;
        out.raw = { request, response: null };
        return out;
      }

      const response = { status: res.status, headers: res.headers, body: res.body };
      const fail = (message: string): DecisionResult => {
        const out = emptyResult('error', res.latencyMs);
        out.error = message;
        out.raw = { request, response };
        return out;
      };

      if (!res.ok) return fail(httpError(res.status, res.body));

      let payload = res.body;
      if (entry.responseEnvelope === 'result') {
        if (!isRecord(payload) || !('result' in payload))
          return fail('response has no result envelope');
        payload = payload.result;
      }

      try {
        const parsed = format.parseBody(payload, question);
        const result: DecisionResult = {
          choice: parsed.choice,
          probabilities: parsed.probabilities,
          confidence: parsed.confidence,
          latencyMs: res.latencyMs,
          inputTokens: parsed.inputTokens,
          costUsd: costUsd(price, parsed.inputTokens),
          status: 'ok',
          raw: { request, response },
        };
        if (parsed.modelVersion !== null) result.modelVersion = parsed.modelVersion;
        return result;
      } catch (err) {
        // The call succeeded and is billed even though the answer is unusable (e.g. an OpenAI
        // refusal), so charge its input tokens. Both formats report them as `usage.input_tokens`.
        const out: DecisionResult =
          err instanceof Refusal
            ? { ...fail(REFUSAL_ERROR), status: 'refusal' }
            : fail(`invalid answer: ${err instanceof Error ? err.message : String(err)}`);
        // A refusal is a well-formed answer: keep the model version it reports (a warm-up that
        // was refused still names the model in the header).
        if (out.status === 'refusal' && isRecord(payload) && typeof payload.model === 'string') {
          out.modelVersion = payload.model;
        }
        const usage = isRecord(payload) && isRecord(payload.usage) ? payload.usage : null;
        const tokens = usage && typeof usage.input_tokens === 'number' ? usage.input_tokens : null;
        if (tokens !== null) {
          out.inputTokens = tokens;
          out.costUsd = costUsd(price, tokens);
        }
        return out;
      }
    },
  };
}
