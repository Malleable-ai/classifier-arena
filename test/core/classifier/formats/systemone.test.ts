import { describe, expect, it } from 'vitest';
import { systemone } from '../../../../src/core/classifier/formats/systemone.js';
import { InvalidAnswer } from '../../../../src/core/classifier/formats/types.js';
import { orderOptions } from '../../../../src/core/classifier/order.js';
import {
  FIGHTER_QUESTION,
  FIGHTER_QUESTION_KEY,
  buildQuestion,
} from '../../../../src/games/fighter/question.js';
import { MOVE_IDS } from '../../../../src/games/fighter/engine/types.js';
import { SAMPLE_VIEW, readFixture } from '../../../games/fighter/sample-view.js';

const q = buildQuestion(MOVE_IDS);

describe('systemone format', () => {
  it('builds the recorded request body for the sample view', () => {
    const body = systemone.buildBody(SAMPLE_VIEW, q, 'jev-latest');
    expect(body).toEqual(readFixture('jev/choice-ok.request.json'));
  });

  it('keeps the question option order in criteria', () => {
    const ordered = orderOptions(FIGHTER_QUESTION, 7, FIGHTER_QUESTION_KEY);
    const order = ordered.options.map((o) => o.id);
    const body = systemone.buildBody(SAMPLE_VIEW, ordered, 'm') as {
      questions: Record<string, { criteria: Record<string, string> }>;
    };
    expect(Object.keys(body.questions.next_move?.criteria ?? {})).toEqual(order);
  });

  it('round-trips through extractShared', () => {
    const shared = systemone.extractShared(systemone.buildBody(SAMPLE_VIEW, q, 'm'));
    expect(shared).toEqual({
      instructions: q.instructions,
      options: q.options.map((o) => ({ id: o.id, description: o.description })),
      state: SAMPLE_VIEW,
    });
  });

  it('parses the recorded answer, mapping probabilities by option name', () => {
    const parsed = systemone.parseBody(readFixture('jev/choice-ok.json'), q);
    expect(parsed.choice).toBe('fireball');
    expect(parsed.confidence).toBe(0.66);
    expect(parsed.inputTokens).toBe(1166);
    expect(parsed.modelVersion).toBe('jev-1.13.0');
    expect(Object.keys(parsed.probabilities ?? {})).toEqual([...MOVE_IDS]);
    expect(parsed.probabilities?.block_high).toBe(0.07);
    expect(parsed.probabilities?.fireball).toBeCloseTo(0.69);
  });

  it('rejects the recorded 422 error body', () => {
    expect(() => systemone.parseBody(readFixture('jev/choice-error-422.json'), q)).toThrow(
      InvalidAnswer,
    );
  });

  it('rejects a choice outside the 11 options and never samples', () => {
    const body = structuredClone(readFixture('jev/choice-ok.json')) as {
      answers: { next_move: { choice: string } };
    };
    body.answers.next_move.choice = 'not_a_move';
    expect(() => systemone.parseBody(body, q)).toThrow(InvalidAnswer);
  });

  it('allows a missing probabilities/usage block', () => {
    const parsed = systemone.parseBody(
      { model: 'x', answers: { next_move: { type: 'choice', choice: 'jab' } } },
      q,
    );
    expect(parsed).toEqual({
      choice: 'jab',
      probabilities: null,
      confidence: null,
      inputTokens: null,
      modelVersion: 'x',
    });
  });
});
