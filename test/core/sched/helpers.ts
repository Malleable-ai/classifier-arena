import type {
  DecideContext,
  Decider,
  DecisionResult,
  Question,
} from '../../../src/core/classifier/types.js';
import { REFUSAL_ERROR, emptyResult } from '../../../src/core/classifier/types.js';
import type { DecisionLine, LogLine, MatchLogSink } from '../../../src/core/log/schema.js';
import type { SeatMeta } from '../../../src/core/sched/shared.js';
import type { Clock } from '../../../src/core/util/clock.js';
import { SimClock } from '../../../src/core/util/clock.js';

/**
 * One scripted step: answer after `latencyMs` with `choice` (ok; default: the first option of the
 * question it was asked), or an error/refusal/throw. `choice` may read the state and question it
 * got.
 */
export interface FakeStep {
  latencyMs: number;
  choice?: string | ((state: unknown, question: Question) => string);
  error?: string;
  /** The API declines the question: status `refusal`, REFUSAL_ERROR, billed `costUsd`. */
  refusal?: boolean;
  throws?: boolean;
  costUsd?: number;
  inputTokens?: number;
  modelVersion?: string;
  /** Reported as is (it need not include the choice). */
  probabilities?: Record<string, number>;
  raw?: { request: unknown; response: unknown };
}

export interface FakeCall {
  at: number;
  state: unknown;
  question: Question;
  signal: AbortSignal;
  /** What the scheduler passed (undefined for a warm-up). */
  ctx: DecideContext | undefined;
  /** Clock time the signal aborted, if it did. */
  abortedAt: number | null;
}

export interface FakeDecider extends Decider {
  calls: FakeCall[];
}

/**
 * A decider scripted by latency and outcome on the given clock. `script(n)` gives the n-th call's
 * step (n counts from 0, warm-ups included). It does NOT honour the abort signal, so tests see
 * that the scheduler discards late answers itself.
 */
export function fakeDecider(
  clock: Clock,
  script: (n: number) => FakeStep,
  player = 'fake',
): FakeDecider {
  const calls: FakeCall[] = [];
  return {
    player,
    calls,
    async decide(state, question, signal, ctx) {
      const n = calls.length;
      const call: FakeCall = { at: clock.now(), state, question, signal, ctx, abortedAt: null };
      signal.addEventListener('abort', () => (call.abortedAt = clock.now()), { once: true });
      calls.push(call);
      const s = script(n);
      const start = clock.now();
      await clock.sleep(s.latencyMs);
      const latencyMs = clock.now() - start;
      if (s.throws) throw new Error('boom');
      if (s.refusal === true) {
        const r: DecisionResult = { ...emptyResult('refusal', latencyMs), error: REFUSAL_ERROR };
        r.costUsd = s.costUsd ?? 0;
        r.inputTokens = s.inputTokens ?? null;
        if (s.modelVersion !== undefined) r.modelVersion = s.modelVersion;
        return r;
      }
      if (s.error !== undefined) {
        const e: DecisionResult = { ...emptyResult('error', latencyMs), error: s.error };
        if (s.raw !== undefined) e.raw = s.raw;
        return e;
      }
      const choice =
        typeof s.choice === 'function'
          ? s.choice(state, question)
          : (s.choice ?? question.options[0]?.id ?? null);
      const r: DecisionResult = emptyResult('ok', latencyMs, choice);
      r.costUsd = s.costUsd ?? 0;
      r.inputTokens = s.inputTokens ?? null;
      if (s.modelVersion !== undefined) r.modelVersion = s.modelVersion;
      if (s.probabilities !== undefined) r.probabilities = s.probabilities;
      if (s.raw !== undefined) r.raw = s.raw;
      return r;
    },
  };
}

export const baselineMeta = (player = 'fake'): SeatMeta => ({
  kind: 'baseline',
  player,
  label: player,
  format: null,
  hosting: null,
  model: null,
  serviceTier: null,
  price: null,
});

export const providerMeta = (player = 'fake_provider'): SeatMeta => ({
  kind: 'provider',
  player,
  label: player,
  format: 'systemone',
  hosting: 'vendor-api',
  model: 'm',
  serviceTier: null,
  price: { inputPerMTokUsd: 1, outputPerMTokUsd: 0, asOf: '2026-10-07' },
});

export interface MemorySink extends MatchLogSink {
  lines: LogLine[];
  snapshots: { seat: number; seq: number; raw: unknown }[];
}

export function memorySink(): MemorySink {
  const lines: LogLine[] = [];
  const snapshots: MemorySink['snapshots'] = [];
  return {
    lines,
    snapshots,
    write(line) {
      lines.push(line);
    },
    snapshot(seat, seq, raw) {
      snapshots.push({ seat, seq, raw });
    },
  };
}

export const decisionsOf = (lines: readonly LogLine[], seat?: 0 | 1): DecisionLine[] =>
  lines.filter(
    (l): l is DecisionLine => l.type === 'decision' && (seat === undefined || l.seat === seat),
  );

/**
 * Await `p` while moving `clock` from one sleeper to the next, so code that sleeps on the SimClock
 * makes progress. Throws if `p` stalls with nothing left to wake.
 */
export async function settleOnSim<T>(clock: SimClock, p: Promise<T>): Promise<T> {
  let settled = false as boolean;
  const watched = p.finally(() => (settled = true));
  watched.catch(() => undefined);
  let idle = 0;
  while (!settled) {
    const due = clock.nextDue();
    if (due === null) {
      await Promise.resolve();
      if (++idle > 10_000) throw new Error('settleOnSim: promise stalled with no sleepers');
    } else {
      idle = 0;
      await clock.advanceTo(due);
    }
  }
  return watched;
}

export const COMMON = {
  matchId: 'test-match',
  gitCommit: 'abc123',
  runLocation: 'test',
  runId: 'm-test',
  startTime: () => '2026-10-07T00:00:00.000Z',
} as const;

export { SimClock };
