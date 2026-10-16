import type { DecisionFormat } from './types.js';
import {
  InvalidAnswer,
  Refusal,
  checkChoice,
  isRecord,
  numberOrNull,
  probabilitiesByName,
} from './types.js';

/**
 * OpenAI's Decisions format. Request: `{ model, input: JSON.stringify(state), questions: [{ type:
 * 'choice', name, instructions, choices: [{ value, description }] }] }`. Response: `{ model,
 * answers: [{ name, choice, probabilities: [{ value, probability }], confidence }], usage }`.
 *
 * Never sends `service_tier`: the spike (2026-10-07) found `/v1/decisions` rejects it with 400
 * "Unknown parameter". Requests run on the project default tier (Standard), so OpenAI gets no
 * faster paid tier that Jev lacks.
 */
export const openaiDecisions: DecisionFormat = {
  id: 'openai-decisions',
  serviceTier: 'default',

  buildBody(state, q, model) {
    return {
      model,
      input: JSON.stringify(state),
      questions: [
        {
          type: 'choice',
          name: q.name,
          instructions: q.instructions,
          choices: q.options.map((o) => ({ value: o.id, description: o.description })),
        },
      ],
    };
  },

  parseBody(body, q) {
    if (!isRecord(body) || !Array.isArray(body.answers))
      throw new InvalidAnswer('no answers in body');
    const answers: unknown[] = body.answers;
    const answer = answers.find((a) => isRecord(a) && a.name === q.name);
    if (!isRecord(answer)) throw new InvalidAnswer(`no answer named ${q.name}`);
    // The API can decline a question: `{ type: 'refusal', name }` with no choice (seen in live
    // matches, 2026-10-07). Logged with status `refusal`: no move for that seat, and it never
    // counts toward match validity.
    if (answer.type === 'refusal') throw new Refusal();
    const byName = new Map<unknown, unknown>();
    if (Array.isArray(answer.probabilities)) {
      for (const p of answer.probabilities as unknown[]) {
        if (isRecord(p)) byName.set(p.value, p.probability);
      }
    }
    const usage = isRecord(body.usage) ? body.usage : {};
    return {
      choice: checkChoice(answer.choice, q),
      probabilities: byName.size > 0 ? probabilitiesByName((id) => byName.get(id), q) : null,
      confidence: numberOrNull(answer.confidence),
      inputTokens: numberOrNull(usage.input_tokens),
      modelVersion: typeof body.model === 'string' ? body.model : null,
    };
  },

  extractShared(body) {
    if (!isRecord(body) || !Array.isArray(body.questions) || typeof body.input !== 'string') {
      throw new Error('not an openai-decisions body');
    }
    const questions: unknown[] = body.questions;
    const [question, ...rest] = questions;
    if (!isRecord(question) || rest.length > 0 || !Array.isArray(question.choices)) {
      throw new Error('expected exactly one choice question');
    }
    const choices: unknown[] = question.choices;
    return {
      instructions: String(question.instructions),
      options: choices.map((c) => {
        if (!isRecord(c)) throw new Error('bad choice');
        return { id: String(c.value), description: String(c.description) };
      }),
      state: JSON.parse(body.input) as unknown,
    };
  },
};
