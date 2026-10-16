import type { QuestionOption } from '../../core/classifier/types.js';
import type { AskedQuestion, GamePromptConfig } from '../../core/game.js';
import type { CluesBoard } from './data-build.js';
import { turnWord } from './engine/engine.js';
import type { CluesState } from './engine/types.js';

/**
 * The Clue Clash prompt. FAIRNESS: one frozen prompt for both seats, hashed into every match
 * header (the hash is pinned in test/games/clues/prompt.test.ts). It is neutral and is never
 * tuned for either model; any change to it is called out in its PR and reruns the results.
 */
export const CLUES_PRIMER =
  'Reverse dictionary: the state gives a definition and its part of speech. Pick the one word on ' +
  'the board that this definition defines. The board words are close in meaning, so read the ' +
  'definition carefully. Exactly one option is correct.';

/** Every option's description, with `<lemma>` replaced by the board word. */
const OPTION_TEMPLATE = 'The word "<lemma>".';

export const CLUES_PROMPT_CONFIG: GamePromptConfig & { optionTemplate: string } = Object.freeze({
  // Version 2 adds `optionTemplate` so the hash covers the option text too. The text itself is
  // unchanged from version 1, so models see exactly the same prompt and options.
  version: 2,
  questionName: 'which_word',
  primer: CLUES_PRIMER,
  /** The 16 options come from the match's board. */
  options: 'per-question',
  optionTemplate: OPTION_TEMPLATE,
  // State format 2 (game version 2): the definition is revealed in three steps, and the state
  // adds `reveal_step`. The primer, question name and options are unchanged.
  stateFormatVersion: 2,
});

/** One board word as an option: the id is the lemma (a–z only, so a valid option id). */
export function wordOption(lemma: string): QuestionOption {
  return { id: lemma, description: CLUES_PROMPT_CONFIG.optionTemplate.replace('<lemma>', lemma) };
}

/**
 * The turn's question, the same for both seats: key `t<word>` (the word's place in the seeded
 * order, 0..15), all 16 board words in board order (w01..w16). The scheduler shuffles them per key
 * with the core order rule, so both seats see the same order, and all three reveal steps of a word
 * share its key and so its order (the core accepts a key asked again with the same content). Null
 * once the game is over.
 */
export function cluesQuestion(state: CluesState, board: CluesBoard): AskedQuestion | null {
  if (state.over) return null;
  return {
    key: `t${String(turnWord(state.turn))}`,
    question: {
      name: CLUES_PROMPT_CONFIG.questionName,
      instructions: CLUES_PROMPT_CONFIG.primer,
      options: board.words.map((w) => wordOption(w.lemma)),
    },
  };
}
