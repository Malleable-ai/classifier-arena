import type { DecisionFormat } from './types.js';
import {
  InvalidAnswer,
  checkChoice,
  isRecord,
  numberOrNull,
  probabilitiesByName,
} from './types.js';

/**
 * TypeSafe's System One format (Jev; Cloudflare's Clef is built to be compatible).
 * Request: `{ model, state, questions: { [name]: { type: 'choice', instructions, criteria } } }`,
 * where `criteria` maps option name to description in question order (object insertion order).
 * Response: `{ model, answers: { [name]: { choice, confidence, probabilities } }, usage }`.
 * Probabilities come back in a different key order, so they're mapped by name.
 */
export const systemone: DecisionFormat = {
  id: 'systemone',
  serviceTier: null,

  buildBody(state, q, model) {
    const criteria: Record<string, string> = {};
    for (const o of q.options) criteria[o.id] = o.description;
    return {
      model,
      state,
      questions: { [q.name]: { type: 'choice', instructions: q.instructions, criteria } },
    };
  },

  parseBody(body, q) {
    if (!isRecord(body) || !isRecord(body.answers)) throw new InvalidAnswer('no answers in body');
    const answer = body.answers[q.name];
    if (!isRecord(answer)) throw new InvalidAnswer(`no answer named ${q.name}`);
    const probs = answer.probabilities;
    const usage = isRecord(body.usage) ? body.usage : {};
    return {
      choice: checkChoice(answer.choice, q),
      probabilities: isRecord(probs) ? probabilitiesByName((id) => probs[id], q) : null,
      confidence: numberOrNull(answer.confidence),
      inputTokens: numberOrNull(usage.input_tokens),
      modelVersion: typeof body.model === 'string' ? body.model : null,
    };
  },

  extractShared(body) {
    if (!isRecord(body) || !isRecord(body.questions)) throw new Error('not a systemone body');
    const [question, ...rest] = Object.values(body.questions);
    if (!isRecord(question) || rest.length > 0 || !isRecord(question.criteria)) {
      throw new Error('expected exactly one choice question');
    }
    return {
      instructions: String(question.instructions),
      options: Object.entries(question.criteria).map(([id, d]) => ({ id, description: String(d) })),
      state: body.state,
    };
  },
};
