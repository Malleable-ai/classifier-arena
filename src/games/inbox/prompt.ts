import type { Question, QuestionOption, Seat } from '../../core/classifier/types.js';
import type { AskedQuestion, GamePromptConfig } from '../../core/game.js';
import { soonest } from './engine/sim.js';
import type { InboxState } from './engine/types.js';

/**
 * Inbox Invaders' frozen prompt config (docs/architecture/inbox.md). Its hash goes in every match
 * header and is pinned in test/games/inbox/prompt.test.ts. One prompt for both models, never tuned
 * for either (RULES.md); if the game is dull, change the game, not this.
 *
 * The option descriptions are the ones the label review of data/inbox/messages.json used (AI
 * reviewer agents, Claude), so they must not change without redoing that review.
 */

/** Canonical option order; the scheduler shuffles it per message by seed (OPTION_ORDER_RULE). */
export const INBOX_OPTIONS: readonly QuestionOption[] = Object.freeze([
  Object.freeze({
    id: 'legit',
    description:
      'A normal message from a person or a real business: conversation, plans, a genuine notice or reminder. Not selling anything, not a scam.',
  }),
  Object.freeze({
    id: 'spam',
    description:
      'Unwanted bulk marketing: adverts, offers, ringtones, chat or dating services, quizzes and subscriptions that sell something openly.',
  }),
  Object.freeze({
    id: 'smishing',
    description:
      'SMS phishing: tries to trick you out of money or personal details, e.g. a fake prize, account, voicemail or delivery alert asking you to call, reply or click to claim or verify.',
  }),
]);

const PRIMER =
  "You triage text messages as they arrive in a phone's inbox. Classify the message in the " +
  'state as legit, spam or smishing. A wrong answer costs inbox health, and so does a message ' +
  'that lands before you answer; a smishing message that gets through costs three times as ' +
  'much. seconds_to_land is how long you have. Personal names, phone numbers and emails are ' +
  'masked as <name>, <phone> and <email>, and links are defanged (hxxp, [.]).';

export const INBOX_PROMPT_CONFIG: GamePromptConfig = Object.freeze({
  version: 1,
  questionName: 'classify_message',
  primer: PRIMER,
  options: INBOX_OPTIONS,
  stateFormatVersion: 1,
});

/** The one question every message asks (options in canonical order). */
export const INBOX_QUESTION: Question = Object.freeze({
  name: INBOX_PROMPT_CONFIG.questionName,
  instructions: INBOX_PROMPT_CONFIG.primer,
  options: INBOX_OPTIONS,
});

/**
 * "Classify the soonest-to-land unresolved message in your lane", keyed by the message id (keys
 * aren't option ids, so `sms-123` is fine). Null when the lane is empty or the game is over. Both
 * seats get the same question for the same message.
 */
export function inboxQuestion(s: InboxState, seat: Seat): AskedQuestion | null {
  if (s.over) return null;
  const item = soonest(s, seat);
  return item ? { key: item.id, question: INBOX_QUESTION } : null;
}
