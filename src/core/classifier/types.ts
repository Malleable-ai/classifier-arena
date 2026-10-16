/**
 * Classifier core types. A decider sees a game's state (opaque JSON here) and a `Question`; it
 * answers with one of the question's option ids. Nothing in src/core knows any game's view, moves
 * or rules, so every game and every provider goes through the same code (RULES.md, fairness).
 */

export type Seat = 0 | 1;

export interface QuestionOption {
  id: string;
  description: string;
}

/** One choice question. Option order is part of the question (see order.ts). */
export interface Question {
  name: string;
  instructions: string;
  options: readonly QuestionOption[];
}

/**
 * `refusal`: the API answered but declined the question (no choice). It is the model's own
 * no-answer, not a transport failure: it never counts toward match validity (validity.ts).
 * 'dropped' is added later by the scheduler.
 */
export type DecisionStatus = 'ok' | 'timeout' | 'error' | 'refusal';

/**
 * The `error` a refusal is logged with. Logs written before the `refusal` status existed
 * (2026-10-12) have `status: 'error'` with exactly this message; the log reader reads those lines
 * as refusals.
 */
export const REFUSAL_ERROR = 'invalid answer: refusal';

export interface DecisionResult {
  /** One of the question's option ids, or null when there is no answer. */
  choice: string | null;
  /** Keyed by option id, in question order. */
  probabilities: Record<string, number> | null;
  confidence: number | null;
  latencyMs: number;
  inputTokens: number | null;
  costUsd: number;
  /** True when `costUsd` is an estimate (the request was sent but never answered). */
  costEstimated?: boolean;
  status: DecisionStatus;
  error?: string;
  modelVersion?: string;
  raw?: { request: unknown; response: unknown };
}

/**
 * Player ids go into match ids and file names (`<stamp>-<a>-vs-<b>-<n>`), so only lowercase
 * letters, digits and `_`: no dots, slashes, capitals, or hyphens that would blur the `-vs-` split.
 */
export const PLAYER_ID_RE = /^[a-z0-9_]+$/;

/** A provider id from the registry, or a baseline id. */
export type PlayerId = string;

/** What a scheduler tells a decider about one request. Absent for the warm-up. */
export interface DecideContext {
  /**
   * This seat's decision seq: the `seq` of the log line this request becomes. Anything named per
   * decision (the proxy's snapshots) uses it, so names match the log even when a seq passes with
   * no request (a turn seat's backoff miss).
   */
  seq: number;
}

export interface Decider {
  player: PlayerId;
  /** `question` comes from the scheduler, which controls option order (the same for both seats). */
  decide(
    state: unknown,
    question: Question,
    signal: AbortSignal,
    ctx?: DecideContext,
  ): Promise<DecisionResult>;
}

/** A result with no cost (baseline answers, timeouts and errors). */
export function emptyResult(
  status: DecisionStatus,
  latencyMs: number,
  choice: string | null = null,
): DecisionResult {
  return {
    choice,
    probabilities: null,
    confidence: null,
    latencyMs,
    inputTokens: null,
    costUsd: 0,
    status,
  };
}
