import { describe, expect, it } from 'vitest';
import { orderOptions } from '../../../src/core/classifier/order.js';
import { promptConfigHash } from '../../../src/core/classifier/prompt.js';
import { validateQuestion } from '../../../src/core/game.js';
import { MOVE_IDS } from '../../../src/games/fighter/engine/types.js';
import { FIGHTER_PROMPT_CONFIG } from '../../../src/games/fighter/prompt.js';
import {
  FIGHTER_QUESTION,
  FIGHTER_QUESTION_KEY,
  buildQuestion,
} from '../../../src/games/fighter/question.js';
import jevRequest from '../../fixtures/jev/choice-ok.request.json';

describe('FIGHTER_PROMPT_CONFIG', () => {
  it('has one option per move in canonical order', () => {
    expect(FIGHTER_PROMPT_CONFIG.questionName).toBe('next_move');
    expect(FIGHTER_PROMPT_CONFIG.options.map((o) => o.id)).toEqual([...MOVE_IDS]);
  });

  it('matches the wording the spike fixtures recorded', () => {
    const q = jevRequest.questions.next_move;
    expect(FIGHTER_PROMPT_CONFIG.primer).toBe(q.instructions);
    const criteria = q.criteria as Record<string, string>;
    for (const o of FIGHTER_PROMPT_CONFIG.options) expect(o.description).toBe(criteria[o.id]);
  });

  it('leaves the option-order rule to core (it is in every header instead)', () => {
    expect(Object.keys(FIGHTER_PROMPT_CONFIG).sort()).toEqual(
      ['options', 'primer', 'questionName', 'stateFormatVersion', 'version'].sort(),
    );
  });

  it('hash is pinned (the value every fighter match log records; frozen config)', () => {
    expect(FIGHTER_PROMPT_CONFIG.version).toBe(2);
    expect(promptConfigHash(FIGHTER_PROMPT_CONFIG)).toBe('d7ce85c39c9adebe');
  });

  it('v2 only dropped the order rule: as v1 with it back, the hash is the v1 one (same text)', () => {
    const v1 = {
      ...FIGHTER_PROMPT_CONFIG,
      version: 1,
      optionOrderRule:
        'sfc32(matchSeed ^ 0x6f70746e) fisher-yates over MOVE_IDS, same for both fighters',
    };
    expect(promptConfigHash(v1)).toBe('9553e0fcba75ec7d');
  });
});

describe('FIGHTER_QUESTION', () => {
  it('is next_move with 11 options in canonical order, and valid', () => {
    expect(FIGHTER_QUESTION_KEY).toBe('next_move');
    expect(FIGHTER_QUESTION.name).toBe('next_move');
    expect(FIGHTER_QUESTION.instructions).toBe(FIGHTER_PROMPT_CONFIG.primer);
    expect(FIGHTER_QUESTION.options).toEqual(FIGHTER_PROMPT_CONFIG.options);
    expect(() => {
      validateQuestion(FIGHTER_QUESTION);
    }).not.toThrow();
  });

  it('is ordered per match by the core rule under its key: a permutation, stable per seed', () => {
    const ids = (seed: number) =>
      orderOptions(FIGHTER_QUESTION, seed, FIGHTER_QUESTION_KEY).options.map((o) => o.id);
    const orders = new Set<string>();
    for (let seed = 0; seed < 50; seed++) {
      expect([...ids(seed)].sort()).toEqual([...MOVE_IDS].sort());
      orders.add(ids(seed).join(','));
    }
    expect(ids(123)).toEqual(ids(123));
    expect(orders.size).toBeGreaterThan(45);
  });
});

describe('buildQuestion', () => {
  it('is the canonical question for MOVE_IDS', () => {
    expect(buildQuestion(MOVE_IDS)).toEqual(FIGHTER_QUESTION);
  });

  it('follows the given order', () => {
    const order = [...MOVE_IDS].reverse();
    expect(buildQuestion(order).options.map((o) => o.id)).toEqual(order);
  });

  it('rejects an order that is not a permutation of MOVE_IDS', () => {
    expect(() => buildQuestion(MOVE_IDS.slice(1))).toThrow();
    expect(() => buildQuestion([...MOVE_IDS.slice(1), 'jab'])).toThrow();
  });
});
