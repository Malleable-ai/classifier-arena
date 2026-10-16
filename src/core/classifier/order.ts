import { fnv1a64, utf8Bytes } from '../util/hash.js';
import { createPrng, nextBelow } from '../util/prng.js';
import { validateQuestion } from './question.js';
import type { Question } from './types.js';

/** Salt so the order stream differs from a game's own PRNG stream for the same seed. */
const ORDER_SALT = 0x6f70746e;

/** Logged in every match header, so a reader can recompute any order. */
export const OPTION_ORDER_RULE =
  'sfc32((matchSeed ^ 0x6f70746e ^ low32(fnv1a64(utf8(questionKey)))) >>> 0) fisher-yates over the ' +
  "game's canonical options; same order for both seats";

/**
 * `q` with its options in the order for this match and question key: a Fisher–Yates shuffle of the
 * canonical options from its own sfc32 stream (OPTION_ORDER_RULE). There is no seat input, so both
 * seats always get the same order. Pure: returns a new Question and never touches `q`.
 * Throws if `q` fails `validateQuestion`: this is the one place questions are validated, since
 * every question passes through here on its way to a decider.
 */
export function orderOptions(q: Question, matchSeed: number, questionKey: string): Question {
  validateQuestion(q);
  const low32 = parseInt(fnv1a64(utf8Bytes(questionKey)).slice(8), 16);
  const prng = createPrng((matchSeed ^ ORDER_SALT ^ low32) >>> 0);
  const options = [...q.options];
  for (let i = options.length - 1; i > 0; i--) {
    const j = nextBelow(prng, i + 1);
    const a = options[i];
    const b = options[j];
    if (a === undefined || b === undefined) throw new Error('unreachable');
    options[i] = b;
    options[j] = a;
  }
  return { ...q, options };
}
