import { describe, expect, it } from 'vitest';
import { promptConfigHash } from '../../../src/core/classifier/prompt.js';
import { validateQuestion } from '../../../src/core/game.js';
import { stepInbox } from '../../../src/games/inbox/engine/sim.js';
import {
  INBOX_OPTIONS,
  INBOX_PROMPT_CONFIG,
  INBOX_QUESTION,
  inboxQuestion,
} from '../../../src/games/inbox/prompt.js';
import { answer, itemAt, small } from './fixtures.js';

/**
 * The frozen prompt (RULES.md, fairness). If this hash changes, the prompt changed: say so in the
 * PR, bump INBOX_PROMPT_CONFIG.version, and rerun every Inbox Invaders result.
 */
const PINNED_HASH = '4e73962f4f519949';

/** Used for the label review of data/inbox/messages.json (AI reviewer agents); must never change. */
const REVIEWED_DESCRIPTIONS = {
  legit:
    'A normal message from a person or a real business: conversation, plans, a genuine notice or reminder. Not selling anything, not a scam.',
  spam: 'Unwanted bulk marketing: adverts, offers, ringtones, chat or dating services, quizzes and subscriptions that sell something openly.',
  smishing:
    'SMS phishing: tries to trick you out of money or personal details, e.g. a fake prize, account, voicemail or delivery alert asking you to call, reply or click to claim or verify.',
};

const PRIMER =
  "You triage text messages as they arrive in a phone's inbox. Classify the message in the state as legit, spam or smishing. A wrong answer costs inbox health, and so does a message that lands before you answer; a smishing message that gets through costs three times as much. seconds_to_land is how long you have. Personal names, phone numbers and emails are masked as <name>, <phone> and <email>, and links are defanged (hxxp, [.]).";

describe('INBOX_PROMPT_CONFIG', () => {
  it('hashes to the pinned value', () => {
    expect(promptConfigHash(INBOX_PROMPT_CONFIG)).toBe(PINNED_HASH);
  });

  it('is exactly this config', () => {
    expect(INBOX_PROMPT_CONFIG).toEqual({
      version: 1,
      questionName: 'classify_message',
      primer: PRIMER,
      options: [
        { id: 'legit', description: REVIEWED_DESCRIPTIONS.legit },
        { id: 'spam', description: REVIEWED_DESCRIPTIONS.spam },
        { id: 'smishing', description: REVIEWED_DESCRIPTIONS.smishing },
      ],
      stateFormatVersion: 1,
    });
  });

  it('keeps the option descriptions the label review used, in canonical order', () => {
    expect(INBOX_OPTIONS.map((o) => o.id)).toEqual(['legit', 'spam', 'smishing']);
    for (const o of INBOX_OPTIONS) {
      expect(o.description).toBe(REVIEWED_DESCRIPTIONS[o.id as keyof typeof REVIEWED_DESCRIPTIONS]);
    }
  });

  it('is frozen', () => {
    expect(Object.isFrozen(INBOX_PROMPT_CONFIG)).toBe(true);
    expect(Object.isFrozen(INBOX_OPTIONS)).toBe(true);
    for (const o of INBOX_OPTIONS) expect(Object.isFrozen(o)).toBe(true);
    expect(Object.isFrozen(INBOX_QUESTION)).toBe(true);
  });
});

describe('inboxQuestion', () => {
  it('asks about the soonest-to-land message, keyed by its id, with the frozen question', () => {
    const s = small();
    const q = inboxQuestion(s, 0);
    expect(q).toEqual({ key: itemAt(s, 0).id, question: INBOX_QUESTION });
    expect(q?.question).toBe(INBOX_QUESTION);
    expect(INBOX_QUESTION).toEqual({
      name: 'classify_message',
      instructions: PRIMER,
      options: INBOX_OPTIONS,
    });
    expect(() => {
      validateQuestion(INBOX_QUESTION);
    }).not.toThrow();
  });

  it('gives both seats the same question for the same message', () => {
    const s = small();
    expect(inboxQuestion(s, 1)).toEqual(inboxQuestion(s, 0));
  });

  it('is null for an empty lane and once the game is over', () => {
    const s = small({ health: 10 });
    const item = itemAt(s, 0);
    stepInbox(s, [answer(item), null]);
    expect(inboxQuestion(s, 0)).toBeNull();
    expect(inboxQuestion(s, 1)?.key).toBe(item.id);
    s.over = true;
    expect(inboxQuestion(s, 1)).toBeNull();
  });
});
