import type { Question } from '../../core/classifier/types.js';
import type { MoveId } from './engine/types.js';
import { MOVE_IDS } from './engine/types.js';
import { FIGHTER_PROMPT_CONFIG } from './prompt.js';

/**
 * The fighter's one question, `next_move`, built from the frozen prompt config. The game asks it
 * with its options in canonical (MOVE_IDS) order under the key FIGHTER_QUESTION_KEY; the
 * scheduler orders them with core's rule (src/core/classifier/order.ts), the same for both seats.
 * The key never changes, so a match keeps one option order throughout.
 */

/** The question key (and name): the scheduler's order rule and settlement matching use it. */
export const FIGHTER_QUESTION_KEY = 'next_move';

/**
 * The `next_move` question with options in `order` (a permutation of MOVE_IDS). The game only
 * ever asks it in canonical order (FIGHTER_QUESTION); other orders are for tests and fixtures.
 */
export function buildQuestion(order: readonly MoveId[]): Question {
  if (order.length !== MOVE_IDS.length || new Set(order).size !== MOVE_IDS.length) {
    throw new Error(`option order must be a permutation of MOVE_IDS: ${order.join(',')}`);
  }
  const byId = new Map(FIGHTER_PROMPT_CONFIG.options.map((o) => [o.id, o.description]));
  return {
    name: FIGHTER_PROMPT_CONFIG.questionName,
    instructions: FIGHTER_PROMPT_CONFIG.primer,
    options: order.map((id) => {
      const description = byId.get(id);
      if (description === undefined) throw new Error(`unknown option ${id}`);
      return { id, description };
    }),
  };
}

/** The canonical question: options in MOVE_IDS order. */
export const FIGHTER_QUESTION: Question = buildQuestion(MOVE_IDS);
