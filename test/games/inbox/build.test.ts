import { describe, expect, it } from 'vitest';
import {
  ELLIPSIS,
  badTextReason,
  cleanRows,
  collectConfirmedNames,
  dedupeProcessed,
  defangMentions,
  defangUrls,
  drawSample,
  finishText,
  maskEmails,
  maskNames,
  maskPhones,
  normaliseText,
  parseCsv,
  preprocessText,
  toSourceRows,
  trimText,
  type InboxLabel,
  type NameLists,
} from '../../../src/games/inbox/data-build.js';

// Synthetic strings only: no real message text from the dataset appears here.

describe('parseCsv', () => {
  it('parses plain fields with CRLF, LF and CR line ends', () => {
    expect(parseCsv('a,b\r\nc,d\ne,f\rg,h')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
      ['e', 'f'],
      ['g', 'h'],
    ]);
  });

  it('handles quoted fields with commas, escaped quotes and line breaks', () => {
    expect(parseCsv('x,"one, two","say ""hi""","line1\r\nline2"\r\n')).toEqual([
      ['x', 'one, two', 'say "hi"', 'line1\r\nline2'],
    ]);
  });

  it('keeps empty fields and an empty quoted field', () => {
    expect(parseCsv('a,,b\n"",c,\n')).toEqual([
      ['a', '', 'b'],
      ['', 'c', ''],
    ]);
  });

  it('drops a BOM and does not add a row for the final line break', () => {
    expect(parseCsv('\uFEFFLABEL,TEXT\r\n')).toEqual([['LABEL', 'TEXT']]);
  });

  it('keeps a quote inside an unquoted field as text', () => {
    expect(parseCsv('a 5" b,c')).toEqual([['a 5" b', 'c']]);
  });

  it('throws on an unterminated quote or text after a closing quote', () => {
    expect(() => parseCsv('a,"open\n')).toThrow(/unterminated/);
    expect(() => parseCsv('"done"x,b')).toThrow(/after a closing quote/);
  });
});

describe('toSourceRows', () => {
  it('lower-cases labels, renames ham to legit and numbers rows from 1', () => {
    const rows = toSourceRows(
      parseCsv('LABEL,TEXT,URL\nham,hello,No\nSpam,buy now,No\nSmishing,pay here,yes\n'),
    );
    expect(rows).toEqual([
      { row: 1, label: 'legit', text: 'hello' },
      { row: 2, label: 'spam', text: 'buy now' },
      { row: 3, label: 'smishing', text: 'pay here' },
    ]);
  });

  it('rejects a bad header, a short row and an unknown label', () => {
    expect(() => toSourceRows([['A', 'B']])).toThrow(/header/);
    expect(() =>
      toSourceRows([
        ['LABEL', 'TEXT', 'URL'],
        ['ham', 'x'],
      ]),
    ).toThrow(/row 1/);
    expect(() =>
      toSourceRows([
        ['LABEL', 'TEXT'],
        ['other', 'x'],
      ]),
    ).toThrow(/unknown label/);
  });
});

describe('cleaning', () => {
  it('names the reason a text is unusable', () => {
    expect(badTextReason('fine text, \u00A35 \u2013 ok\u2026')).toBeNull();
    expect(badTextReason('broken \uFFFD byte')).toBe('replacementChar');
    expect(badTextReason('stray \u0092 byte')).toBe('controlChar');
    expect(badTextReason('see you at &lt;TIME&gt;')).toBe('htmlPlaceholder');
    expect(badTextReason('garbled \u9225 text')).toBe('mojibake');
  });

  it('drops texts under two labels, folded duplicates and bad rows', () => {
    const rows: { label: InboxLabel; text: string }[] = [
      { label: 'spam', text: 'Win a prize' },
      { label: 'smishing', text: 'win  a PRIZE ' },
      { label: 'legit', text: 'See you soon' },
      { label: 'legit', text: 'see you   soon' },
      { label: 'legit', text: 'bad \uFFFD' },
      { label: 'legit', text: 'at &lt;#&gt; pm' },
      { label: 'spam', text: 'Cheap offer' },
    ];
    const result = cleanRows(rows);
    expect(result.kept.map((r) => r.text)).toEqual(['See you soon', 'Cheap offer']);
    expect(result.conflictingTexts).toBe(1);
    expect(result.dropped).toMatchObject({
      conflictingLabels: 2,
      duplicate: 1,
      replacementChar: 1,
      htmlPlaceholder: 1,
    });
  });

  it('drops texts that collide only after masking', () => {
    const items: { label: InboxLabel; text: string }[] = [
      { label: 'spam', text: 'Call <phone> now' },
      { label: 'spam', text: 'call <phone> NOW' },
      { label: 'spam', text: 'Text <phone>' },
      { label: 'smishing', text: 'text <phone>' },
    ];
    const result = dedupeProcessed(items);
    expect(result.kept.map((i) => i.text)).toEqual(['Call <phone> now']);
    expect(result.duplicates).toBe(1);
    expect(result.conflicts).toBe(2);
  });
});

describe('normaliseText', () => {
  it('unescapes &amp;, straightens quotes and dashes and collapses whitespace', () => {
    expect(normaliseText('  a &amp; b\t\u2018c\u2019 \u201Cd\u201D \u2013 e\r\n f\u00A0g ')).toBe(
      'a & b \'c\' "d" - e f g',
    );
  });
});

describe('maskEmails', () => {
  it('masks addresses and counts them', () => {
    expect(maskEmails('mail me at first.last+tag@example.co.uk or x_y@test.org.')).toEqual({
      text: 'mail me at <email> or <email>.',
      count: 2,
    });
  });

  it('leaves a bare @ alone', () => {
    expect(maskEmails('meet @ 5').count).toBe(0);
  });

  it('needs a letter TLD, so rates and prices after an @ stay', () => {
    expect(maskEmails('Loan Against Property@10.5% and Car@9.25').count).toBe(0);
    expect(maskEmails('2 for 1@3.50 each').count).toBe(0);
    expect(maskEmails('reply to x@10.5.example.com.')).toEqual({
      text: 'reply to <email>.',
      count: 1,
    });
    expect(maskEmails('a@b.c1 or a@b.com1').count).toBe(0);
  });
});

describe('defangUrls', () => {
  const defang = (s: string) => defangUrls(s).text;

  it('defangs schemes and host dots, keeping paths and case', () => {
    expect(defang('go to http://www.example.com/a.b?c=d now')).toBe(
      'go to hxxp://www[.]example[.]com/a.b?c=d now',
    );
    expect(defang('HTTPS://Shop.Example.CO.UK')).toBe('HXXPS://Shop[.]Example[.]CO[.]UK');
    expect(defang('ftp://files.example.org/x')).toBe('fxp://files[.]example[.]org/x');
  });

  it('handles malformed schemes and scheme-only hosts', () => {
    expect(defang('http//www.example.net')).toBe('hxxp//www[.]example[.]net');
    expect(defang('http:/short.example/abc')).toBe('hxxp:/short[.]example/abc');
    expect(defang('http:10.0.0.1')).toBe('hxxp:10[.]0[.]0[.]1');
    expect(defang('visithttp://example.biz')).toBe('visithxxp://example[.]biz');
  });

  it('defangs bare www hosts, common TLDs and short TLDs with a path', () => {
    expect(defang('see www.example.xyz today')).toBe('see www[.]example[.]xyz today');
    expect(defang('text.www.example.tk')).toBe('text[.]www[.]example[.]tk');
    expect(defang('reply to example.com.')).toBe('reply to example[.]com.');
    expect(defang('use short.do/abc')).toBe('use short[.]do/abc');
  });

  it('leaves sentences joined by a dot and decimals alone', () => {
    expect(defang('ok.so we go.in later, it costs 1.50')).toBe(
      'ok.so we go.in later, it costs 1.50',
    );
  });

  it('counts hosts and never leaves www. or a scheme', () => {
    const r = defangUrls('http://a.example.com and www.b.example.org and www.');
    expect(r.count).toBe(3);
    expect(r.text).not.toMatch(/https?:|www\./i);
  });

  it('defangs a bare www. only at the start of a word', () => {
    expect(defangUrls('Awww. Thanks')).toEqual({ text: 'Awww. Thanks', count: 0 });
    expect(defangUrls('wwww. no')).toEqual({ text: 'wwww. no', count: 0 });
    expect(defangUrls('go to www. or (www. or _www.')).toEqual({
      text: 'go to www[.] or (www[.] or _www[.]',
      count: 3,
    });
  });

  it('is idempotent', () => {
    const once = defang('http://www.example.com/x and example.net');
    expect(defang(once)).toBe(once);
  });
});

describe('defangMentions', () => {
  it('breaks @handles so they are not GitHub mentions', () => {
    expect(defangMentions('follow @someone or pay @150p, meet @ 5')).toEqual({
      text: 'follow @ someone or pay @ 150p, meet @ 5',
      count: 2,
    });
  });
});

describe('maskPhones', () => {
  const mask = (s: string) => maskPhones(s).text;

  it('masks long digit runs and grouped phone numbers', () => {
    expect(mask('call 08001234567 now')).toBe('call <phone> now');
    expect(mask('call 0800 123 4567.')).toBe('call <phone>.');
    expect(mask('ring +44 (0)20 7946 0000 today')).toBe('ring <phone> today');
    expect(mask('dial 011-4306-5228')).toBe('dial <phone>');
    expect(mask('code abc1234567x')).toBe('code abc<phone>x');
  });

  it('masks the source’s blanked numbers', () => {
    expect(mask('your mobile 07xxxxxxxxx won')).toBe('your mobile <phone> won');
    expect(mask('user 0712 XXXXXX today')).toBe('user <phone> today');
    expect(mask('statement for <fone no> shows')).toBe('statement for <phone> shows');
    expect(mask('love you xxxx')).toBe('love you xxxx');
    expect(mask('see u 2 xxxx')).toBe('see u 2 xxxx');
  });

  it('keeps short numbers, prices, dates and neighbouring numbers', () => {
    expect(mask('£1.50 per msg, 2 for 1, box 12345')).toBe('£1.50 per msg, 2 for 1, box 12345');
    expect(mask('£1.50 08001234567 apply')).toBe('£1.50 <phone> apply');
    expect(mask('call 0800 123 4567 16+ only')).toBe('call <phone> 16+ only');
    expect(mask('on 21-09-2005 at 10.30')).toBe('on 21-09-2005 at 10.30');
    expect(mask('£2,000,000 prize')).toBe('£2,000,000 prize');
  });

  it('leaves no run of 7 digits and counts masks', () => {
    const r = maskPhones('a 1234567 b 7654321 c 12 34 56 78 d 1-2-3');
    expect(r.text).not.toMatch(/\d{7}/);
    expect(r.count).toBe(2);
  });
});

describe('maskNames', () => {
  const lists: NameLists = {
    names: new Set(['alice', 'bob', 'carol', 'dan', 'will', 'eve']),
    common: new Set(['will']),
    confirmed: new Set(['alice']),
  };
  const mask = (s: string) => maskNames(s, lists).text;

  it('masks Title Case names mid-sentence and lower-case names', () => {
    expect(mask('I saw Bob and carol at the shop')).toBe('I saw <name> and <name> at the shop');
    expect(mask("tell Dan's sister")).toBe("tell <name>'s sister");
  });

  it('never masks common words that are also names', () => {
    expect(mask('I Will see. will you come')).toBe('I Will see. will you come');
  });

  it('masks sentence-initial names only with evidence, a greeting comma or a sign-off', () => {
    expect(mask('Bob is late. Eve went home')).toBe('Bob is late. Eve went home');
    expect(mask('Alice is late')).toBe('<name> is late');
    expect(mask('Bob, are you there?')).toBe('<name>, are you there?');
    expect(mask('See you soon. Bob.')).toBe('See you soon. <name>.');
    expect(mask('Ask Dr.Dan today')).toBe('Ask Dr.<name> today');
  });

  it('masks all-caps names only when confirmed', () => {
    expect(mask('HI ALICE AND BOB')).toBe('HI <name> AND BOB');
  });

  it('skips URLs, masks and words joined to digits, and splits CamelCase', () => {
    expect(mask('see hxxp://bob[.]example/Alice')).toBe('see hxxp://bob[.]example/Alice');
    expect(mask('send to <email> bob2 Bob_x')).toBe('send to <email> bob2 Bob_x');
    expect(mask('From: AliceSize: 2KB')).toBe('From: <name>Size: 2KB');
  });

  it('counts masks', () => {
    expect(maskNames('I met Bob, carol and Dan', lists).count).toBe(3);
  });
});

describe('collectConfirmedNames', () => {
  it('keeps names seen in Title Case mid-sentence, not at sentence start or in common words', () => {
    const confirmed = collectConfirmedNames(
      ['Bob is here', 'I met Carol. Dan left', 'we Will go', 'call eve'],
      { names: new Set(['bob', 'carol', 'dan', 'will', 'eve']), common: new Set(['will']) },
    );
    expect([...confirmed].sort()).toEqual(['carol']);
  });
});

describe('trimText', () => {
  it('leaves short text alone', () => {
    expect(trimText('short', 10)).toBe('short');
    expect(trimText('exactly 10', 10)).toBe('exactly 10');
  });

  it('cuts at a word boundary and adds an ellipsis', () => {
    expect(trimText('one two three four five', 12)).toBe(`one two${ELLIPSIS}`);
    expect(trimText('alpha beta gamma', 10)).toBe(`alpha beta${ELLIPSIS}`);
  });

  it('hard-cuts when the last boundary is too early, never splitting a surrogate pair', () => {
    expect(trimText('ab abcdefghijklmnop', 10)).toBe(`ab abcdefg${ELLIPSIS}`);
    expect(trimText('abcdefghi\u{1F600}xyz', 10)).toBe(`abcdefghi${ELLIPSIS}`);
  });

  it('never exceeds max + 1 characters', () => {
    const text = 'word '.repeat(100);
    expect(trimText(text, 240).length).toBeLessThanOrEqual(241);
  });
});

describe('text pipeline', () => {
  it('masks and defangs in order, then trims', () => {
    const lists: NameLists = {
      names: new Set(['sam']),
      common: new Set(),
      confirmed: new Set(),
    };
    const pre = preprocessText(
      'Hi, mail Sam at sam@example.com or http://example.com/x &amp; 08001234567',
    );
    expect(pre.text).toBe('Hi, mail Sam at <email> or hxxp://example[.]com/x & <phone>');
    expect(pre.counts).toMatchObject({ emails: 1, urls: 1, phones: 1 });
    const done = finishText(pre.text, lists, 30);
    expect(done.text).toBe(`Hi, mail <name> at <email> or${ELLIPSIS}`);
    expect(done.counts).toMatchObject({ names: 1, trimmed: 1 });
  });

  it('masks a phone number inside a defanged host', () => {
    expect(preprocessText('see www.01234567890.com').text).toBe('see www[.]<phone>[.]com');
  });
});

describe('drawSample', () => {
  const pool = (['legit', 'spam', 'smishing'] as const).flatMap((label, k) =>
    Array.from({ length: 20 }, (_, i) => ({ id: `sms-${String(k * 100 + i + 1)}`, label })),
  );
  const spec = {
    seed: 7,
    sizes: { legit: 6, spam: 3, smishing: 3 },
    reserve: { legit: 4, spam: 2, smishing: 2 },
    exclude: new Set<string>(),
  };

  it('draws the requested counts and reserve, deterministically', () => {
    const a = drawSample(pool, spec);
    const b = drawSample(pool, spec);
    expect(a).toEqual(b);
    const counts: Record<string, number> = {};
    for (const m of a.messages) counts[m.label] = (counts[m.label] ?? 0) + 1;
    expect(counts).toEqual({ legit: 6, spam: 3, smishing: 3 });
    expect(a.reserve.legit).toHaveLength(4);
    expect(a.reserve.spam).toHaveLength(2);
    const ids = [...a.messages, ...a.reserve.legit, ...a.reserve.spam, ...a.reserve.smishing].map(
      (m) => m.id,
    );
    expect(new Set(ids).size).toBe(ids.length);
    expect(drawSample(pool, { ...spec, seed: 8 }).messages).not.toEqual(a.messages);
  });

  it('replaces an excluded item with the first reserve item of its class, in the same slot', () => {
    const base = drawSample(pool, spec);
    const victim = base.messages.find((m) => m.label === 'spam');
    if (victim === undefined) throw new Error('no spam drawn');
    const next = drawSample(pool, { ...spec, exclude: new Set([victim.id]) });
    const slot = base.messages.indexOf(victim);
    expect(next.excludedCount).toBe(1);
    expect(next.messages[slot]).toEqual(base.reserve.spam[0]);
    expect(next.messages.filter((_, i) => i !== slot)).toEqual(
      base.messages.filter((_, i) => i !== slot),
    );
    expect(next.reserve.spam[0]).toEqual(base.reserve.spam[1]);
  });

  it('throws when a class runs out', () => {
    expect(() => drawSample(pool, { ...spec, sizes: { ...spec.sizes, spam: 19 } })).toThrow(
      /reserve/,
    );
  });
});
