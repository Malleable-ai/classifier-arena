import { describe, expect, it } from 'vitest';
import { FORMATS } from '../../../../src/core/classifier/formats/index.js';
import { openaiDecisions } from '../../../../src/core/classifier/formats/openai-decisions.js';
import { InvalidAnswer, Refusal } from '../../../../src/core/classifier/formats/types.js';
import { orderOptions } from '../../../../src/core/classifier/order.js';
import {
  FIGHTER_QUESTION,
  FIGHTER_QUESTION_KEY,
  buildQuestion,
} from '../../../../src/games/fighter/question.js';
import { MOVE_IDS } from '../../../../src/games/fighter/engine/types.js';
import { SAMPLE_VIEW, readFixture } from '../../../games/fighter/sample-view.js';

const q = buildQuestion(MOVE_IDS);

describe('openai-decisions format', () => {
  it('builds the recorded request body for the sample view', () => {
    const body = openaiDecisions.buildBody(SAMPLE_VIEW, q, 'gpt-6-luna');
    expect(body).toEqual(readFixture('openai/choice-ok.request.json'));
  });

  it('never sends service_tier (the endpoint rejects it with 400)', () => {
    const body = openaiDecisions.buildBody(SAMPLE_VIEW, q, 'gpt-6-luna') as object;
    expect(body).not.toHaveProperty('service_tier');
    expect(JSON.stringify(body)).not.toContain('service_tier');
    const rejected = readFixture('openai/service-tier-error-400.json') as {
      error: { param: string };
    };
    expect(rejected.error.param).toBe('service_tier');
  });

  it('keeps the question option order in choices', () => {
    const ordered = orderOptions(FIGHTER_QUESTION, 7, FIGHTER_QUESTION_KEY);
    const order = ordered.options.map((o) => o.id);
    const body = openaiDecisions.buildBody(SAMPLE_VIEW, ordered, 'm') as {
      questions: { choices: { value: string }[] }[];
    };
    expect(body.questions[0]?.choices.map((c) => c.value)).toEqual(order);
  });

  it('round-trips through extractShared', () => {
    const shared = openaiDecisions.extractShared(openaiDecisions.buildBody(SAMPLE_VIEW, q, 'm'));
    expect(shared).toEqual({
      instructions: q.instructions,
      options: q.options.map((o) => ({ id: o.id, description: o.description })),
      state: SAMPLE_VIEW,
    });
  });

  it('parses the recorded answer, converting probabilities to a record', () => {
    const parsed = openaiDecisions.parseBody(readFixture('openai/choice-ok.json'), q);
    expect(parsed.choice).toBe('heavy_punch');
    expect(parsed.confidence).toBe(0.41);
    expect(parsed.inputTokens).toBe(782);
    expect(parsed.modelVersion).toBe('gpt-6-luna');
    expect(parsed.probabilities?.heavy_punch).toBe(0.46);
    expect(parsed.probabilities?.throw).toBe(0);
    expect(Object.keys(parsed.probabilities ?? {})).toHaveLength(11);
  });

  it('reports a refusal answer (recorded in a live match) as a Refusal', () => {
    const parse = () => openaiDecisions.parseBody(readFixture('openai/choice-refusal.json'), q);
    expect(parse).toThrow(Refusal);
    expect(parse).toThrow(InvalidAnswer);
    expect(parse).toThrow(/^refusal$/);
  });

  it('rejects the recorded 400 error bodies', () => {
    for (const f of ['openai/choice-error-400.json', 'openai/service-tier-error-400.json']) {
      expect(() => openaiDecisions.parseBody(readFixture(f), q)).toThrow(InvalidAnswer);
    }
  });

  it('rejects a choice outside the 11 options', () => {
    const body = structuredClone(readFixture('openai/choice-ok.json')) as {
      answers: { choice: string }[];
    };
    if (body.answers[0]) body.answers[0].choice = 'not_a_move';
    expect(() => openaiDecisions.parseBody(body, q)).toThrow(InvalidAnswer);
  });

  it('ignores answers to other question names', () => {
    const body = { model: 'm', answers: [{ type: 'choice', name: 'other', choice: 'jab' }] };
    expect(() => openaiDecisions.parseBody(body, q)).toThrow(InvalidAnswer);
  });
});

describe('FORMATS', () => {
  it('registers both formats under their ids', () => {
    expect(Object.keys(FORMATS).sort()).toEqual(['openai-decisions', 'systemone']);
    for (const [id, format] of Object.entries(FORMATS)) expect(format.id).toBe(id);
  });
});
