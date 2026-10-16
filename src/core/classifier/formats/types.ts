import type { Question } from '../types.js';

export type FormatId = 'systemone' | 'openai-decisions';

export const FORMAT_IDS: readonly FormatId[] = ['systemone', 'openai-decisions'];

/** What a response says, in format-neutral terms. `choice` is always the API's top pick. */
export interface ParsedAnswer {
  choice: string;
  /** Keyed by option id, in question order. */
  probabilities: Record<string, number> | null;
  confidence: number | null;
  inputTokens: number | null;
  modelVersion: string | null;
}

/** What a request body carries, pulled back out. The conformance suite compares these. */
export interface SharedPayload {
  instructions: string;
  options: { id: string; description: string }[];
  state: unknown;
}

/** One API wire format. Adapters only reshape; they never change content or order. */
export interface DecisionFormat {
  id: FormatId;
  /**
   * The service tier requests in this format run on, for the log header: a tier name, or null
   * when the format has no tiers. Logged so a faster paid tier would show up (fairness).
   */
  serviceTier: string | null;
  /** `state` is the game's state JSON for this seat, sent as is. */
  buildBody(state: unknown, q: Question, model: string): unknown;
  /** Throws InvalidAnswer if the body has no valid answer to `q`. */
  parseBody(body: unknown, q: Question): ParsedAnswer;
  extractShared(body: unknown): SharedPayload;
}

/** The response has no usable answer, or picks something that isn't one of the options. */
export class InvalidAnswer extends Error {
  override name = 'InvalidAnswer';
}

/**
 * The API declined to answer the question (OpenAI's `{ type: 'refusal' }`). The decider logs it
 * with status `refusal`: the model's own no-answer, which never counts toward match validity.
 */
export class Refusal extends InvalidAnswer {
  override name = 'Refusal';

  constructor() {
    super('refusal');
  }
}

export function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

export function numberOrNull(x: unknown): number | null {
  return typeof x === 'number' && Number.isFinite(x) ? x : null;
}

/** The choice must be one of the question's options; anything else is rejected, never sampled. */
export function checkChoice(choice: unknown, q: Question): string {
  const match = q.options.find((o) => o.id === choice);
  if (!match) throw new InvalidAnswer(`choice ${JSON.stringify(choice)} is not one of the options`);
  return match.id;
}

/** Keeps the question's options in question order; ignores names the question doesn't have. */
export function probabilitiesByName(
  lookup: (id: string) => unknown,
  q: Question,
): Record<string, number> | null {
  const out: Record<string, number> = {};
  let any = false;
  for (const { id } of q.options) {
    const p = numberOrNull(lookup(id));
    if (p !== null) {
      out[id] = p;
      any = true;
    }
  }
  return any ? out : null;
}
