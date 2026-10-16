import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../../../src/core/util/hash.js';
import { INBOX_DATA_SHA256, INBOX_MESSAGES } from '../../../src/games/inbox/data.js';

/** Checks the committed sample (`pnpm data:inbox` writes it), read straight from the file. */

/**
 * The content hash of the committed messages (canonical JSON of `messages`). A rebuild that
 * changes any id, label or text changes it: update it here on purpose and regenerate the committed
 * inbox match logs, which log it as `config.dataSha256` and refuse to replay against other data.
 */
const PINNED_SHA256 = '72553834d3a61c3712ffa45ce58b3cc6eb6a3bded2bf6905c9cb06b0412a3e8b';

interface MessagesFile {
  source: { title: string; doi: string; license: string };
  alsoCredits: { title: string; doi: string; license: string }[];
  build: {
    seed: number;
    maxChars: number;
    counts: Record<string, number>;
    excludedCount: number;
    sha256: string;
  };
  messages: { id: string; label: string; text: string }[];
}

const file = JSON.parse(
  readFileSync(new URL('../../../data/inbox/messages.json', import.meta.url), 'utf8'),
) as MessagesFile;
const { build, messages } = file;
const LABELS = ['legit', 'spam', 'smishing'];

describe('data/inbox/messages.json', () => {
  it('holds 300 legit, 150 spam and 150 smishing messages with unique ids', () => {
    const counts: Record<string, number> = {};
    for (const m of messages) counts[m.label] = (counts[m.label] ?? 0) + 1;
    expect(counts).toEqual({ legit: 300, spam: 150, smishing: 150 });
    expect(build.counts).toEqual(counts);
    expect(new Set(messages.map((m) => m.id)).size).toBe(messages.length);
    for (const m of messages) expect(m.id).toMatch(/^sms-\d+$/);
  });

  it('uses only the three labels', () => {
    for (const m of messages) expect(LABELS).toContain(m.label);
  });

  it('records a sha256 that matches the canonical JSON of the messages, and is pinned', () => {
    const hash = createHash('sha256').update(canonicalJson(messages)).digest('hex');
    expect(hash).toBe(PINNED_SHA256);
    expect(build.sha256).toBe(PINNED_SHA256);
    expect(INBOX_DATA_SHA256).toBe(PINNED_SHA256);
  });

  it('is what the game loads', () => {
    expect(INBOX_MESSAGES).toEqual(messages);
  });

  it('credits both CC BY 4.0 sources', () => {
    expect(file.source.doi).toBe('10.17632/f45bkkt8pr.1');
    expect(file.source.license).toBe('CC BY 4.0');
    expect(file.alsoCredits.map((c) => c.doi)).toContain('10.24432/C5CC84');
  });

  it('keeps every text non-empty and within maxChars plus the ellipsis', () => {
    expect(build.maxChars).toBe(240);
    for (const m of messages) {
      expect(m.text.trim()).not.toBe('');
      expect(m.text.length, m.id).toBeLessThanOrEqual(241);
    }
  });

  it('has no live links, email addresses or long digit runs', () => {
    for (const m of messages) {
      expect(m.text, m.id).not.toMatch(/https?:\/\//i);
      expect(m.text, m.id).not.toMatch(/www\./i);
      expect(m.text, m.id).not.toMatch(/[\w.+-]+@[\w-]+\.[\w-]+/);
      expect(m.text, m.id).not.toMatch(/\d{7}/);
    }
  });

  it('has no HTML-escaped NUS placeholders', () => {
    for (const m of messages) {
      expect(m.text, m.id).not.toMatch(/&lt;|&gt;/i);
    }
  });
});
