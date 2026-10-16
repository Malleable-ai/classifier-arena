/**
 * Pure helpers for the Inbox Invaders data build (`pnpm data:inbox`, src/cli/build-inbox-data.ts):
 * CSV parsing, cleaning, masking, URL defanging, trimming and the seeded stratified sample. No
 * Node or DOM APIs here, so every step is unit-testable with synthetic strings. The source CSV is
 * untrusted data: it is parsed, never executed.
 */
import { createPrng, nextBelow, type PrngState } from '../../core/util/prng.js';

export type InboxLabel = 'legit' | 'spam' | 'smishing';
export const INBOX_LABELS: readonly InboxLabel[] = ['legit', 'spam', 'smishing'];

/** Longest message text before trimming; a trimmed text is this plus one `…`. */
export const MAX_CHARS = 240;
export const ELLIPSIS = '\u2026';

export interface InboxMessage {
  id: string;
  label: InboxLabel;
  text: string;
}

/** One data row of the source CSV. `row` is 1-based and excludes the header. */
export interface SourceRow {
  row: number;
  label: InboxLabel;
  text: string;
}

// ---------------------------------------------------------------------------------------------
// CSV (RFC 4180)

/**
 * Parse RFC 4180 CSV: comma separators, CRLF, LF or CR line ends, double-quoted fields with `""`
 * escapes and embedded line breaks. A leading BOM is dropped. A final line break doesn't add an
 * empty row. Throws on an unterminated quoted field or text after a closing quote.
 */
export function parseCsv(input: string): string[][] {
  const text = input.startsWith('\uFEFF') ? input.slice(1) : input;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let wasQuoted = false;
  let line = 1;
  let i = 0;
  const endField = (): void => {
    row.push(field);
    field = '';
    wasQuoted = false;
  };
  const endRow = (): void => {
    endField();
    rows.push(row);
    row = [];
  };
  while (i < text.length) {
    const ch = text.charAt(i);
    if (quoted) {
      if (ch === '"') {
        if (text.charAt(i + 1) === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        const next = text.charAt(i);
        if (next !== '' && next !== ',' && next !== '\r' && next !== '\n') {
          throw new Error(`CSV line ${String(line)}: text after a closing quote`);
        }
        continue;
      }
      if (ch === '\n' || (ch === '\r' && text.charAt(i + 1) !== '\n')) line++;
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === '' && !wasQuoted) {
      quoted = true;
      wasQuoted = true;
      i++;
      continue;
    }
    if (ch === ',') {
      endField();
      i++;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      endRow();
      i += ch === '\r' && text.charAt(i + 1) === '\n' ? 2 : 1;
      line++;
      continue;
    }
    field += ch;
    i++;
  }
  if (quoted) throw new Error(`CSV line ${String(line)}: unterminated quoted field`);
  if (field !== '' || wasQuoted || row.length > 0) endRow();
  return rows;
}

/** The source label strings, case-folded, mapped to ours (`ham` becomes `legit`). */
const LABEL_MAP: Readonly<Record<string, InboxLabel>> = {
  ham: 'legit',
  spam: 'spam',
  smishing: 'smishing',
};

/**
 * Turn the parsed CSV (header `LABEL,TEXT,URL,EMAIL,PHONE`) into rows. Labels are lower-cased and
 * `ham` is renamed `legit`. The URL/EMAIL/PHONE flag columns are ignored (unreliable).
 */
export function toSourceRows(csv: readonly (readonly string[])[]): SourceRow[] {
  const [header, ...body] = csv;
  if (header?.[0]?.toUpperCase() !== 'LABEL' || header[1]?.toUpperCase() !== 'TEXT') {
    throw new Error('CSV header must start with LABEL,TEXT');
  }
  return body.map((fields, index) => {
    const row = index + 1;
    if (fields.length !== header.length) {
      throw new Error(
        `CSV row ${String(row)}: ${String(fields.length)} fields, expected ${String(header.length)}`,
      );
    }
    const raw = (fields[0] ?? '').trim().toLowerCase();
    const label = LABEL_MAP[raw];
    if (label === undefined) throw new Error(`CSV row ${String(row)}: unknown label "${raw}"`);
    return { row, label, text: fields[1] ?? '' };
  });
}

// ---------------------------------------------------------------------------------------------
// Cleaning

/** Case and whitespace folding, used to find duplicates. */
export function foldText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

export type DropReason =
  | 'conflictingLabels'
  | 'duplicate'
  | 'replacementChar'
  | 'controlChar'
  | 'htmlPlaceholder'
  | 'mojibake';

const BAD_TEXT: readonly [Exclude<DropReason, 'conflictingLabels' | 'duplicate'>, RegExp][] = [
  // A literal U+FFFD: bytes that failed to decode.
  ['replacementChar', /\uFFFD/],
  // Stray cp1252 bytes decoded as C1 controls (U+0080–U+009F).
  ['controlChar', /[\u0080-\u009F]/],
  // HTML-escaped NUS placeholders (`&lt;#&gt;`, `&lt;TIME&gt;` …). Only ham has them, so they
  // would give the label away.
  ['htmlPlaceholder', /&lt;|&gt;/i],
  // Anything outside Latin, general punctuation and currency: mis-decoded text.
  ['mojibake', /[^\t\n\r\u0020-\u007E\u00A0-\u024F\u2010-\u205E\u20A0-\u20CF]/],
];

/** Why a row's text is unusable, or null if it's fine. */
export function badTextReason(text: string): DropReason | null {
  for (const [reason, pattern] of BAD_TEXT) if (pattern.test(text)) return reason;
  return null;
}

export interface CleanResult<T> {
  kept: T[];
  dropped: Record<DropReason, number>;
  /** Distinct folded texts that appear under more than one label. */
  conflictingTexts: number;
}

function emptyDrops(): Record<DropReason, number> {
  return {
    conflictingLabels: 0,
    duplicate: 0,
    replacementChar: 0,
    controlChar: 0,
    htmlPlaceholder: 0,
    mojibake: 0,
  };
}

/**
 * Drop every text that appears under more than one label, then later duplicates of the same
 * text (after case and whitespace folding), then rows with broken characters or NUS placeholders.
 * Keeps input order.
 */
export function cleanRows<T extends { label: InboxLabel; text: string }>(
  rows: readonly T[],
  fold: (text: string) => string = foldText,
  badText: (text: string) => DropReason | null = badTextReason,
): CleanResult<T> {
  const labelsByText = new Map<string, Set<InboxLabel>>();
  for (const r of rows) {
    const key = fold(r.text);
    const set = labelsByText.get(key) ?? new Set<InboxLabel>();
    set.add(r.label);
    labelsByText.set(key, set);
  }
  let conflictingTexts = 0;
  for (const set of labelsByText.values()) if (set.size > 1) conflictingTexts++;

  const dropped = emptyDrops();
  const seen = new Set<string>();
  const kept: T[] = [];
  for (const r of rows) {
    const key = fold(r.text);
    if ((labelsByText.get(key)?.size ?? 0) > 1) {
      dropped.conflictingLabels++;
      continue;
    }
    if (seen.has(key)) {
      dropped.duplicate++;
      continue;
    }
    seen.add(key);
    const reason = badText(r.text);
    if (reason !== null) {
      dropped[reason]++;
      continue;
    }
    kept.push(r);
  }
  return { kept, dropped, conflictingTexts };
}

// ---------------------------------------------------------------------------------------------
// Text pipeline: normalise → emails → URLs → mentions → phones → names → trim

export interface MaskCounts {
  emails: number;
  urls: number;
  mentions: number;
  phones: number;
  names: number;
  trimmed: number;
}

export function emptyMaskCounts(): MaskCounts {
  return { emails: 0, urls: 0, mentions: 0, phones: 0, names: 0, trimmed: 0 };
}

export function addMaskCounts(a: MaskCounts, b: MaskCounts): MaskCounts {
  return {
    emails: a.emails + b.emails,
    urls: a.urls + b.urls,
    mentions: a.mentions + b.mentions,
    phones: a.phones + b.phones,
    names: a.names + b.names,
    trimmed: a.trimmed + b.trimmed,
  };
}

/**
 * Unescape `&amp;` (only ham has it, so it would give the label away), turn typographic quotes
 * and dashes into ASCII, collapse whitespace runs (tabs, line breaks, no-break spaces) to one
 * space and trim.
 */
export function normaliseText(text: string): string {
  return text
    .replace(/&amp;/gi, '&')
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

interface Masked {
  text: string;
  count: number;
}

/** `local@domain.tld`, where the TLD is letters: `Properties@11.5%` is a rate, not an address. */
const EMAIL = /[\w.%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g;

/** Email addresses → `<email>`. */
export function maskEmails(text: string): Masked {
  let count = 0;
  const out = text.replace(EMAIL, () => {
    count++;
    return '<email>';
  });
  return { text: out, count };
}

/** TLDs that mark a bare `name.tld` as a host even without `www.`, a scheme or a path. */
const STRONG_TLDS: ReadonlySet<string> = new Set([
  'com',
  'net',
  'org',
  'info',
  'biz',
  'uk',
  'mobi',
  'tv',
  'io',
  'ly',
  'cc',
  'ws',
  'gl',
  'gov',
  'edu',
]);

const SCHEME = /(h)(tt)(p)(s?)(?=:|\/\/)|(f)(t)(p)(?=:\/\/)/gi;
const HOST =
  /(?<![A-Za-z0-9-])[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+/g;
const AFTER_SCHEME = /(?:hxxps?|fxp):?\/*$/i;

function xx(s: string): string {
  return s.replace(/t/g, 'x').replace(/T/g, 'X');
}

/**
 * Defang URLs so nothing autolinks: `http`/`https`/`ftp` → `hxxp`/`hxxps`/`fxp` (also when the
 * colon or slashes are malformed), and every `.` in a host → `[.]`. A host is a dotted name after
 * a scheme, one with a `www` label, one ending in a common web TLD (`.com`, `.co.uk`, `.net` …),
 * or one ending in any other alphabetic TLD and followed by a path (`bit.do/x`). The domain text
 * itself is kept. Returns the number of hosts defanged.
 */
export function defangUrls(text: string): Masked {
  const schemed = text.replace(SCHEME, (m) => xx(m));
  let count = 0;
  const out = schemed.replace(HOST, (host: string, offset: number) => {
    const labels = host.split('.');
    const tld = (labels[labels.length - 1] ?? '').toLowerCase();
    const before = schemed.slice(0, offset);
    const after = schemed.charAt(offset + host.length);
    const alphaTld = /^[a-z]{2,}$/.test(tld);
    const isHost =
      AFTER_SCHEME.test(before) ||
      labels.some((l) => /^w{2,3}\d*$/i.test(l)) ||
      (alphaTld && STRONG_TLDS.has(tld)) ||
      (alphaTld && tld.length <= 6 && after === '/');
    if (!isHost) return host;
    count++;
    return labels.join('[.]');
  });
  // Safety net: a `www.` with no host after it still autolinks in GFM. Only at a word start, so
  // `Awww.` stays as it is.
  const safe = out.replace(/(?<![A-Za-z0-9])(www)\./gi, (_m, w: string) => {
    count++;
    return `${w}[.]`;
  });
  return { text: safe, count };
}

/**
 * `@word` (left after emails are masked) would be a GitHub mention, so put a space after the `@`.
 */
export function defangMentions(text: string): Masked {
  let count = 0;
  const out = text.replace(/@(?=[A-Za-z0-9])/g, () => {
    count++;
    return '@ ';
  });
  return { text: out, count };
}

/** Phone numbers already blanked in the source (`07xxxxxxxxx`, `0796 XXXXXX`, `<fone no>`). */
const PHONE_PLACEHOLDER =
  /(?<![A-Za-z0-9])(?:(?:\+\d{1,3}|0)\d{0,5} ?[xX]{3,}(?![A-Za-z0-9])|<fone no>)/gi;
/** Digit groups (optionally `+` or parenthesised) joined directly or by one space, dot or dash. */
const NUMBERISH = /(?<!\d)\+?(?:\(\d{1,5}\)|\d+)(?:[ .-]?(?:\(\d{1,5}\)|\d+))*/g;
const GROUP = /([ .-]?)(\+?\(\d{1,5}\)|\+?\d+)/g;
const DATE = /^\d{1,2}([-./])\d{1,2}\1\d{2,4}$/;

function digitCount(s: string): number {
  return s.replace(/\D/g, '').length;
}

/**
 * Split a run of digit groups into phone-like segments. A group joins the segment before it
 * when it follows directly, is in parentheses, follows a dash and has 2+ digits, or follows a
 * space or dot, has 3+ digits and the segment so far has 3+ digits (or starts with `+`). So
 * `0800 542 0825` and `+44 (0)20 7946 0000` stay whole, while `£1.50 0800…` keeps its price.
 */
function phoneSegments(run: string): string[] {
  const segments: string[] = [];
  let current = '';
  for (const m of run.matchAll(GROUP)) {
    const sep = m[1] ?? '';
    const group = m[2] ?? '';
    const digits = digitCount(group);
    const soFar = digitCount(current);
    const join =
      current !== '' &&
      (sep === '' ||
        group.startsWith('(') ||
        (sep === '-' && digits >= 2) ||
        (digits >= 3 && (soFar >= 3 || current.startsWith('+'))));
    if (join) {
      current += sep + group;
    } else {
      if (current !== '') segments.push(current);
      current = sep + group;
    }
  }
  if (current !== '') segments.push(current);
  return segments;
}

/**
 * Phone numbers and phone-like digit runs (7 or more digits in a segment, dates excepted) →
 * `<phone>`. The source's own phone placeholders become `<phone>` too. No run of 7 or more
 * digits survives.
 */
export function maskPhones(text: string): Masked {
  let count = 0;
  const placeholders = text.replace(PHONE_PLACEHOLDER, () => {
    count++;
    return '<phone>';
  });
  const out = placeholders.replace(NUMBERISH, (run) =>
    phoneSegments(run)
      .map((segment) => {
        const lead = /^[ .-]/.test(segment) ? segment.charAt(0) : '';
        const body = segment.slice(lead.length);
        if (digitCount(body) < 7 || DATE.test(body)) return segment;
        count++;
        return lead + '<phone>';
      })
      .join(''),
  );
  return { text: out, count };
}

export interface NameLists {
  /** Lower-cased first names. */
  names: ReadonlySet<string>;
  /** Lower-cased common English words that are also names (`will`, `may`, `hope` …): never masked. */
  common: ReadonlySet<string>;
  /**
   * Lower-cased names seen in Title Case mid-sentence somewhere in the corpus. Only these are
   * masked at the start of a sentence or in all caps, where capitals say nothing.
   */
  confirmed: ReadonlySet<string>;
}

type Shape = 'title' | 'caps' | 'lower';

interface NameToken {
  word: string;
  index: number;
  shape: Shape;
  initial: boolean;
  /** Followed by a comma or colon, as in a greeting ("Sam, are you …"). */
  vocative: boolean;
  /** Only punctuation follows, as in a sign-off ("… see you. Sam"). */
  final: boolean;
}

/** Words, with CamelCase joins split ("JoStewart" → "Jo", "Stewart"). */
const WORD = /\p{Lu}?\p{Ll}+|\p{Lu}+(?!\p{Ll})/gu;

function shapeOf(word: string): Shape | null {
  if (/^\p{Lu}\p{Ll}+$/u.test(word)) return 'title';
  if (/^\p{Lu}{3,}$/u.test(word)) return 'caps';
  if (/^\p{Ll}{3,}$/u.test(word)) return 'lower';
  return null;
}

/** Word tokens outside URLs and masks, with their shape and sentence position. */
function nameTokens(text: string): NameToken[] {
  const tokens: NameToken[] = [];
  for (const m of text.matchAll(WORD)) {
    const word = m[0];
    const index = m.index;
    const shape = shapeOf(word);
    if (shape === null) continue;
    const prev = text.charAt(index - 1);
    const next = text.charAt(index + word.length);
    if (/[0-9_<]/.test(prev) || /[0-9_>]/.test(next)) continue;
    const chunkStart = text.lastIndexOf(' ', index) + 1;
    const spaceAt = text.indexOf(' ', index);
    const chunk = text.slice(chunkStart, spaceAt === -1 ? text.length : spaceAt);
    if (/hxxp|fxp:|\[\.\]|\/|<email>/i.test(chunk)) continue;
    const before = text.slice(0, index).replace(/[\s"'([*-]+$/, '');
    const initial =
      before === '' || (/[.!?]$/.test(before) && !/\b(?:dr|mr|mrs|ms|mx|prof|st)\.$/i.test(before));
    const final = !/[\p{L}\p{N}<]/u.test(text.slice(index + word.length));
    tokens.push({ word, index, shape, initial, vocative: next === ',' || next === ':', final });
  }
  return tokens;
}

/**
 * Lower-cased names from `names` (minus `common`) that appear in Title Case somewhere other than
 * the start of a sentence in any of `texts`: evidence that the word is used as a name.
 */
export function collectConfirmedNames(
  texts: Iterable<string>,
  lists: Pick<NameLists, 'names' | 'common'>,
): Set<string> {
  const confirmed = new Set<string>();
  for (const text of texts) {
    for (const t of nameTokens(text)) {
      const lower = t.word.toLowerCase();
      if (t.shape !== 'title' || t.initial) continue;
      if (lists.names.has(lower) && !lists.common.has(lower)) confirmed.add(lower);
    }
  }
  return confirmed;
}

/**
 * Personal names → `<name>`. A token's lower-case form must be in `names` and not in `common`.
 * Then a Title Case token is masked mid-sentence; at the start of a sentence only if it's in
 * `confirmed`, a greeting followed by a comma or colon, or a sign-off (nothing but punctuation
 * after it). An all-caps token is masked if it's in `confirmed`. A lower-case token (SMS often
 * skips capitals) is always masked, since `common` holds the names that are also everyday words.
 */
export function maskNames(text: string, lists: NameLists): Masked {
  const hits: NameToken[] = [];
  for (const t of nameTokens(text)) {
    const lower = t.word.toLowerCase();
    if (!lists.names.has(lower) || lists.common.has(lower)) continue;
    const mask =
      t.shape === 'lower' ||
      (t.shape === 'caps' && lists.confirmed.has(lower)) ||
      (t.shape === 'title' && (!t.initial || t.vocative || t.final || lists.confirmed.has(lower)));
    if (mask) hits.push(t);
  }
  let out = text;
  for (let k = hits.length - 1; k >= 0; k--) {
    const t = hits[k] as NameToken;
    out = out.slice(0, t.index) + '<name>' + out.slice(t.index + t.word.length);
  }
  return { text: out, count: hits.length };
}

/**
 * Cut `text` to at most `max` characters at a word boundary and add `…` (so at most `max + 1`).
 * Falls back to a hard cut when the last word boundary is in the first 60%.
 */
export function trimText(text: string, max: number = MAX_CHARS): string {
  if (text.length <= max) return text;
  let cut = text.slice(0, max + 1).lastIndexOf(' ');
  if (cut < Math.floor(max * 0.6)) cut = max;
  let head = text.slice(0, cut).trimEnd();
  if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
  return head + ELLIPSIS;
}

/** Steps that don't need corpus-wide name evidence: normalise, emails, URLs, mentions, phones. */
export function preprocessText(raw: string): { text: string; counts: MaskCounts } {
  const counts = emptyMaskCounts();
  const emails = maskEmails(normaliseText(raw));
  counts.emails = emails.count;
  const urls = defangUrls(emails.text);
  counts.urls = urls.count;
  const mentions = defangMentions(urls.text);
  counts.mentions = mentions.count;
  const phones = maskPhones(mentions.text);
  counts.phones = phones.count;
  return { text: phones.text, counts };
}

/** The rest of the pipeline after `preprocessText`: names, then trim. */
export function finishText(
  pre: string,
  lists: NameLists,
  max: number = MAX_CHARS,
): { text: string; counts: MaskCounts } {
  const counts = emptyMaskCounts();
  const names = maskNames(pre, lists);
  counts.names = names.count;
  const text = trimText(names.text, max);
  counts.trimmed = text === names.text ? 0 : 1;
  return { text, counts };
}

// ---------------------------------------------------------------------------------------------
// Seeded stratified sample

/** Fisher–Yates with the seeded PRNG. Mutates and returns `items`. */
export function shuffleInPlace<T>(items: T[], prng: PrngState): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = nextBelow(prng, i + 1);
    const tmp = items[i] as T;
    items[i] = items[j] as T;
    items[j] = tmp;
  }
  return items;
}

export interface SampleSpec {
  seed: number;
  sizes: Readonly<Record<InboxLabel, number>>;
  reserve: Readonly<Record<InboxLabel, number>>;
  exclude: ReadonlySet<string>;
}

export interface SampleResult<T> {
  /** Every class's sample, in the seeded shuffled order. */
  messages: T[];
  /** Per class, the ordered replacements (the next item replaces the next exclusion). */
  reserve: Record<InboxLabel, T[]>;
  /** Excluded ids that were in a pool (so were skipped). */
  excludedCount: number;
}

/**
 * Seeded stratified sample. Each class's pool (in input order) is shuffled with one sfc32
 * stream. The first `sizes[label]` items are the class's slots; an excluded item's slot goes to
 * the next non-excluded item after the slots, and the reserve is the non-excluded items after
 * those. The same stream then shuffles the slot list, so excluding an item changes only its slot.
 * Shuffles always run over the full pools, so exclusions never change any other item's place.
 */
export function drawSample<T extends { id: string; label: InboxLabel }>(
  pool: readonly T[],
  spec: SampleSpec,
): SampleResult<T> {
  const prng = createPrng(spec.seed);
  const slots: T[] = [];
  const reserve: Record<InboxLabel, T[]> = { legit: [], spam: [], smishing: [] };
  let excludedCount = 0;
  for (const item of pool) if (spec.exclude.has(item.id)) excludedCount++;
  for (const label of INBOX_LABELS) {
    const shuffled = shuffleInPlace(
      pool.filter((m) => m.label === label),
      prng,
    );
    const size = spec.sizes[label];
    const spares = shuffled.slice(size).filter((m) => !spec.exclude.has(m.id));
    const chosen = shuffled.slice(0, size).map((m) => {
      if (!spec.exclude.has(m.id)) return m;
      const next = spares.shift();
      if (next === undefined) throw new Error(`not enough ${label} messages to replace exclusions`);
      return next;
    });
    if (chosen.length < size) {
      throw new Error(`${label}: pool has ${String(chosen.length)} messages, need ${String(size)}`);
    }
    if (spares.length < spec.reserve[label]) {
      throw new Error(
        `${label}: only ${String(spares.length)} reserve messages, need ${String(spec.reserve[label])}`,
      );
    }
    slots.push(...chosen);
    reserve[label] = spares.slice(0, spec.reserve[label]);
  }
  return { messages: shuffleInPlace(slots, prng), reserve, excludedCount };
}

/**
 * Drop items whose final text is the same (after case and whitespace folding) as an earlier
 * item's: later copies with the same label go, and texts under two labels go entirely.
 */
export function dedupeProcessed<T extends { label: InboxLabel; text: string }>(
  items: readonly T[],
): { kept: T[]; duplicates: number; conflicts: number } {
  const result = cleanRows(items, foldText, () => null);
  return {
    kept: result.kept,
    duplicates: result.dropped.duplicate,
    conflicts: result.dropped.conflictingLabels,
  };
}
