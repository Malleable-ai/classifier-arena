import { describe, expect, it } from 'vitest';
import { promptConfigHash } from '../../../src/core/classifier/prompt.js';
import { QUESTION_ID_RE } from '../../../src/core/classifier/question.js';
import { cluesGame } from '../../../src/games/clues/game.js';
import { CLUES_PRIMER, CLUES_PROMPT_CONFIG, wordOption } from '../../../src/games/clues/prompt.js';

/**
 * FAIRNESS: one frozen prompt for both seats, hashed into every match header. Changing anything in
 * it changes this hash: say so in the PR and rerun the affected results (RULES.md).
 * 929114d4d17ea7e9 → 6417698321204bea (2026-10-12): state format 2, the three-step reveal. The
 * primer, question name and option template are unchanged.
 */
const PINNED_PROMPT_CONFIG_HASH = '6417698321204bea';

describe('CLUES_PROMPT_CONFIG', () => {
  it('is the frozen, neutral reverse-dictionary prompt', () => {
    expect(CLUES_PROMPT_CONFIG).toEqual({
      version: 2,
      questionName: 'which_word',
      primer:
        'Reverse dictionary: the state gives a definition and its part of speech. Pick the one ' +
        'word on the board that this definition defines. The board words are close in meaning, ' +
        'so read the definition carefully. Exactly one option is correct.',
      options: 'per-question',
      optionTemplate: 'The word "<lemma>".',
      stateFormatVersion: 2,
    });
    expect(CLUES_PROMPT_CONFIG.primer).toBe(CLUES_PRIMER);
    expect(Object.isFrozen(CLUES_PROMPT_CONFIG)).toBe(true);
    expect(cluesGame.promptConfig).toBe(CLUES_PROMPT_CONFIG);
  });

  it('has a pinned hash', () => {
    expect(promptConfigHash(CLUES_PROMPT_CONFIG)).toBe(PINNED_PROMPT_CONFIG_HASH);
  });

  it('names neither model', () => {
    expect(CLUES_PRIMER).not.toMatch(/jev|typesafe|openai|gpt|claude/i);
  });
});

describe('wordOption', () => {
  it('uses the lemma as the id and a fixed description', () => {
    expect(wordOption('meadow')).toEqual({ id: 'meadow', description: 'The word "meadow".' });
    expect(wordOption('meadow').id).toMatch(QUESTION_ID_RE);
  });
});
