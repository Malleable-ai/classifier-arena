import messagesFile from '../../../data/inbox/messages.json' with { type: 'json' };
import { INBOX_LABELS, type InboxLabel, type InboxMessage } from './data-build.js';

/**
 * The committed Inbox Invaders messages (data/inbox/messages.json, built by `pnpm data:inbox`;
 * CC BY 4.0, see data/NOTICE.md), checked once at load. test/games/inbox/data.test.ts pins the
 * file's content hash and counts.
 */

function load(raw: unknown): readonly InboxMessage[] {
  const fail = (why: string): never => {
    throw new Error(`data/inbox/messages.json: ${why}`);
  };
  if (typeof raw !== 'object' || raw === null || !('messages' in raw)) fail('no messages');
  const list = (raw as { messages: unknown }).messages;
  if (!Array.isArray(list)) return fail('messages is not an array');
  return Object.freeze(
    list.map((m: unknown, i): InboxMessage => {
      const { id, label, text } = (m ?? {}) as Record<string, unknown>;
      if (typeof id !== 'string' || typeof text !== 'string') fail(`message ${String(i)} is bad`);
      if (!INBOX_LABELS.includes(label as InboxLabel)) fail(`message ${String(i)} has a bad label`);
      return Object.freeze({ id: id as string, label: label as InboxLabel, text: text as string });
    }),
  );
}

export const INBOX_MESSAGES: readonly InboxMessage[] = load(messagesFile);

/**
 * The `build.sha256` the data build recorded for these messages (pinned in data.test.ts). Match
 * headers log it as `config.dataSha256`, and a replay refuses a log made with other messages.
 */
export const INBOX_DATA_SHA256: string = messagesFile.build.sha256;

const TEXT_BY_ID: ReadonlyMap<string, string> = new Map(INBOX_MESSAGES.map((m) => [m.id, m.text]));

/** The processed text of message `id`. Throws on an unknown id. */
export function messageText(id: string): string {
  const text = TEXT_BY_ID.get(id);
  if (text === undefined) throw new Error(`inbox: unknown message ${JSON.stringify(id)}`);
  return text;
}
