import type { CluesBoard, CluesPos } from './data-build.js';
import { answerIndex, definitionTokens, revealedCount, turnStep } from './engine/engine.js';
import { CLUES_STEPS, type CluesState } from './engine/types.js';

/**
 * What both seats are sent each turn (state format version 2): the definition of the word being
 * asked as revealed so far, the board's part of speech, and the reveal step. The definition grows
 * over three steps (`revealedCount`): its first ceil(n/3) words, then ceil(2n/3), then all n, with
 * a trailing " …" while part of it is hidden. Nothing else: no board words (they are the options),
 * no board id, no score, no turn number. The same for both seats.
 */
export type CluesView = {
  definition: string;
  part_of_speech: CluesPos;
  /** "1/3", "2/3" or "3/3". */
  reveal_step: string;
};

/** What `cluesGame.view` returns once the game is over. It is never sent: nothing is asked then. */
export const GAME_OVER_VIEW: CluesView = {
  definition: '',
  part_of_speech: 'noun',
  reveal_step: `${String(CLUES_STEPS)}/${String(CLUES_STEPS)}`,
};

/** The definition as step `step` shows it: the revealed words, then " …" if any are hidden. */
export function partialDefinition(definition: string, step: number): string {
  const tokens = definitionTokens(definition);
  const shown = revealedCount(tokens.length, step);
  const text = tokens.slice(0, shown).join(' ');
  return shown < tokens.length ? `${text} …` : text;
}

/** The current turn's view, or null once the game is over. */
export function cluesView(state: CluesState, board: CluesBoard): CluesView | null {
  if (state.over) return null;
  const index = answerIndex(state);
  const word = board.words[index];
  if (word === undefined) throw new Error(`board ${board.id} has no word ${String(index)}`);
  const step = turnStep(state.turn);
  return {
    definition: partialDefinition(word.definition, step),
    part_of_speech: board.pos,
    reveal_step: `${String(step)}/${String(CLUES_STEPS)}`,
  };
}
