import type { SeatMeta } from '../sched/shared.js';
import type { PlayerInfo } from './players.js';
import type { Decider, DecisionResult, Question, Seat } from './types.js';
import { emptyResult } from './types.js';

/**
 * Live mode's browser side of the proxy (src/server/proxy.ts). The proxy holds the API keys; the
 * browser only ever sees `DecisionResult`s (without `raw`). Local only: this file is never part of
 * the replay-only web build.
 */

/** Where `pnpm live` serves the proxy. Loopback only. */
export const PROXY_URL = 'http://127.0.0.1:8787';

/**
 * `POST /decide/:player` body. `state` is the seat's view of the game and `question` the scheduler's
 * question (options already ordered), both passed through as is.
 */
export interface DecideRequest {
  /** The game id (e.g. 'fighter'). */
  game: string;
  state: unknown;
  question: Question;
  /**
   * Where the proxy writes the full request/response
   * (`results/states/<game>/<matchId>/<seat>-<seq>.json`). The match id must name `game`.
   */
  snapshot?: { matchId: string; seat: Seat; seq: number };
}

/**
 * `GET /players[?game=]`: what each player is, whether its keys are set (never the keys
 * themselves). Providers always; with a game, also its baselines.
 */
export interface PlayersResponse {
  players: (PlayerInfo & { meta: SeatMeta })[];
  gitCommit: string;
  runLocation: string;
  /** The proxy machine's run id (src/cli/run-id.ts), written into every live log header. */
  runId: string;
}

/** `GET /estimate?game=&a=&b=`: worst case (the $5 guard uses it) and typical, in USD. */
export interface EstimateResponse {
  totalUsd: number;
  typicalUsd: number;
  limitUsd: number;
  text: string;
}

export interface RemoteDeciderOptions {
  player: string;
  /** The game id sent with every request. */
  game: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Extra cap on top of the caller's signal (the controller already times out at 1 s). */
  timeoutMs?: number;
  /**
   * Ask the proxy to write snapshots for this match and seat, named by the scheduler's seq
   * (`DecideContext`). A call without one (the warm-up) is not saved.
   */
  snapshot?: { matchId: string; seat: Seat };
  now?: () => number;
}

function isAbort(err: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (err instanceof Error && err.name === 'AbortError');
}

/**
 * A Decider that asks the proxy. Latency is measured here, around the whole proxy call, the same
 * way for every provider (README, fairness), so it includes the hop to localhost.
 */
export function createRemoteDecider(opts: RemoteDeciderOptions): Decider {
  const base = opts.baseUrl ?? PROXY_URL;
  const now = opts.now ?? (() => performance.now());
  return {
    player: opts.player,
    async decide(state, question, signal, ctx) {
      const start = now();
      const signals = [signal];
      if (opts.timeoutMs !== undefined) signals.push(AbortSignal.timeout(opts.timeoutMs));
      const combined = signals.length === 1 ? signal : AbortSignal.any(signals);
      const body: DecideRequest = { game: opts.game, state, question };
      if (opts.snapshot && ctx !== undefined) body.snapshot = { ...opts.snapshot, seq: ctx.seq };
      const fail = (status: 'timeout' | 'error', error: string): DecisionResult => ({
        ...emptyResult(status, now() - start),
        error,
      });
      try {
        const res = await (opts.fetchImpl ?? fetch)(`${base}/decide/${opts.player}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: combined,
        });
        const json = (await res.json()) as Partial<DecisionResult> & { error?: string };
        if (!res.ok) return fail('error', `proxy ${String(res.status)}: ${json.error ?? ''}`);
        const result = json as DecisionResult;
        delete result.raw;
        return { ...result, latencyMs: now() - start };
      } catch (err) {
        if (isAbort(err, combined)) return fail('timeout', 'timeout');
        return fail(
          'error',
          `proxy unreachable: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  };
}
