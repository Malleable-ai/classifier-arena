import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { format, resolveConfig } from 'prettier';
import { canonicalJson } from '../core/util/hash.js';
import {
  INBOX_LABELS,
  MAX_CHARS,
  addMaskCounts,
  cleanRows,
  collectConfirmedNames,
  dedupeProcessed,
  drawSample,
  emptyMaskCounts,
  finishText,
  parseCsv,
  preprocessText,
  toSourceRows,
  type InboxLabel,
  type InboxMessage,
  type MaskCounts,
} from '../games/inbox/data-build.js';

/**
 * Build `data/inbox/messages.json`, the committed Inbox Invaders sample, from the SMS Phishing
 * Dataset CSV (Mishra & Soni 2022, CC BY 4.0). See docs/research/game-data.md, "Inbox Invaders
 * data" and "Label check", and data/NOTICE.md for every change the build makes.
 *
 *   pnpm data:inbox [--src <csv>] [--seed <n>] [--names <file>]... [--review-dir <dir>]
 *
 * Defaults resolve from the main checkout (the parent of git's common dir), so the command works
 * the same from a worktree: the CSV is `.scratchpad/data-raw/mendeley/extracted/Dataset_5971.csv`,
 * extra name lists are every `*.txt` in `.scratchpad/data-raw/names/` (one name per line, `#`
 * comments), and the review files go to `.scratchpad/inbox-review/`. None of those are committed.
 * The CSV is untrusted data: it is parsed, never executed. Prints counts only, never message text.
 */

const DEFAULT_SEED = 20261007;
const SIZES: Record<InboxLabel, number> = { legit: 300, spam: 150, smishing: 150 };
const RESERVE: Record<InboxLabel, number> = { legit: 150, spam: 100, smishing: 100 };
const OUT = 'data/inbox/messages.json';
const EXCLUDE = 'data/inbox/exclude.json';

const SOURCE = {
  title: 'SMS Phishing Dataset for Machine Learning and Pattern Recognition',
  authors: ['Sandhya Mishra', 'Devpriya Soni'],
  publisher: 'Mendeley Data, V1, 2022',
  doi: '10.17632/f45bkkt8pr.1',
  url: 'https://doi.org/10.17632/f45bkkt8pr.1',
  license: 'CC BY 4.0',
  licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
};

const ALSO_CREDITS = [
  {
    title: 'SMS Spam Collection',
    authors: ['Tiago A. Almeida', 'José M. Gómez Hidalgo'],
    publisher: 'UCI Machine Learning Repository, 2011',
    doi: '10.24432/C5CC84',
    url: 'https://doi.org/10.24432/C5CC84',
    license: 'CC BY 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
    note: 'Included in the SMS Phishing Dataset; most legit and some spam texts come from it.',
  },
];

/**
 * Hand-built list of common first names (about 380, mostly English-language plus common South
 * Asian and Arabic ones; original work, MIT). A name that's also an everyday word goes in
 * COMMON_WORDS below instead.
 */
const FIRST_NAMES = `
aaron abbey abby abdul adam adrian ahmed aidan aisha ajay alan albert alex alexander alexandra
alfie ali alice alison amanda amelia amit amy andre andrea andrew andy angela angie anil anita
anjali ann anna anne annie anthony archie arjun arthur arun ashley ashok ayesha barbara barry becky
ben benjamin beth bethany betty billy bobby brandon brenda brian brittany bruce bryan callum carl
carlos caroline carolyn catherine charles charlie charlotte chelsea cheryl chloe chris christina
christine christopher cindy claire clare colin connor courtney craig cynthia daniel danielle danny
darnell darren dave david debbie deborah debra deepak denise dennis derek diana diane divya donna
dorothy douglas dylan eddie edward eleanor elizabeth ellie emily emma eric ethan eugene evelyn
fatima fiona francis fred freddie frederick gail ganesh gareth gary gavin gemma george gerald gina
gordon graham greg gregory hannah harold harry hassan hayley heather helen henry howard hussein ian
ibrahim imran isaac isabel isabella jacob jake jamal james jamie jane janet janice jason jay jeff
jeffrey jen jenna jennifer jenny jeremy jerry jess jesse jessica jill jim jimmy joan joanna joanne
joe joel joey john johnny jon jonathan jordan jorge jose joseph josh joshua joyce judith judy julia
julie justin karen karthik kate katherine kathleen kathryn kathy katie kavita kayla keith kelly ken
kenneth kenny kerry kevin khalid kieran kim kimberly kirsty kyle laura lauren leah leanne lee leo
leon lewis liam linda lindsay lisa liz logan lorraine louis louise lucas lucy luke lynn madison
mahesh malik manoj marcus maria marie marilyn martha martin mary maryam matt matthew megan melanie
melissa mia michael michelle mike millie mohammed molly naomi natalie natasha nathan neha neil
nicholas nicola nicole nigel nina noah norman oliver olivia omar owen pamela patrick paul paula
pauline peter phil philip phillip pooja prakash priya priyanka rachel rahul raj rajesh rakesh
ramesh ravi rebecca rhys richard ricky robert robin rohit rosie ross russell ruth ryan sachin sally
samantha samuel sandeep sandra sanjay sara sarah scott sean shane sharon shaun sheila shirley simon
sneha sophia sophie stacey stephanie stephen steve steven stuart sunil suresh susan suzanne tanya
tariq taylor teresa terrell terry theresa thomas tiffany tim timothy tina toby tom tommy tony
tracey tracy trevor tyler tyrone vanessa vicky victoria vijay vikram vincent walter wayne wendy
whitney william yusuf zach zain zoe
`;

/**
 * Names that are also everyday English words (or month names). Never masked; the reviewer agents
 * (Claude) read every sampled message for names the heuristic misses.
 */
const COMMON_WORDS = `
amber april art august bill bob chance chase chuck crystal daisy dawn dean don drew faith frank
gene grace grant guy holly hope ivy jack jade joy june lily mark max may nick pat pearl ray rich
rob rose ruby sky summer sunny sue will
`;

function wordSet(text: string): Set<string> {
  return new Set(
    text
      .split('\n')
      .map((line) => line.replace(/#.*/, ''))
      .flatMap((line) => line.split(/\s+/))
      .map((w) => w.trim().toLowerCase())
      .filter((w) => w !== ''),
  );
}

/** The main checkout: the parent of git's common dir (works from a worktree too). */
function mainCheckout(): string {
  try {
    const common = execFileSync(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    ).trim();
    return dirname(common);
  } catch {
    return process.cwd();
  }
}

function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

interface ExcludeFile {
  ids: string[];
  reasons: Record<string, string>;
}

function readExclude(path: string): ExcludeFile {
  if (!existsSync(path)) return { ids: [], reasons: {} };
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<ExcludeFile>;
  const ids = parsed.ids ?? [];
  if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string' && /^sms-\d+$/.test(id))) {
    throw new Error(`${path}: "ids" must be an array of "sms-<row>" strings`);
  }
  return { ids, reasons: parsed.reasons ?? {} };
}

function jsonl(items: readonly object[]): string {
  return items.map((item) => JSON.stringify(item)).join('\n') + '\n';
}

function countLabels(items: readonly { label: InboxLabel }[]): Record<InboxLabel, number> {
  const counts: Record<InboxLabel, number> = { legit: 0, spam: 0, smishing: 0 };
  for (const item of items) counts[item.label]++;
  return counts;
}

interface Processed extends InboxMessage {
  original: string;
  counts: MaskCounts;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((a) => a !== '--'),
    options: {
      src: { type: 'string' },
      seed: { type: 'string' },
      names: { type: 'string', multiple: true },
      'review-dir': { type: 'string' },
    },
  });
  const root = mainCheckout();
  const src = resolve(
    values.src ?? join(root, '.scratchpad/data-raw/mendeley/extracted/Dataset_5971.csv'),
  );
  const seed = values.seed === undefined ? DEFAULT_SEED : Number(values.seed);
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error('bad --seed');
  const reviewDir = resolve(values['review-dir'] ?? join(root, '.scratchpad/inbox-review'));
  const namesDir = join(root, '.scratchpad/data-raw/names');
  const nameFiles =
    values.names ??
    (existsSync(namesDir)
      ? readdirSync(namesDir)
          .filter((f) => f.endsWith('.txt'))
          .sort()
          .map((f) => join(namesDir, f))
      : []);

  // Read and clean.
  const raw = readFileSync(src);
  const rows = toSourceRows(parseCsv(raw.toString('utf8')));
  const clean = cleanRows(rows);
  console.log(`${basename(src)}: ${String(rows.length)} rows`, countLabels(rows));
  console.log(`dropped: ${String(clean.conflictingTexts)} texts under two labels`, clean.dropped);

  // Name lists.
  const names = wordSet(FIRST_NAMES);
  const builtIn = names.size;
  const common = wordSet(COMMON_WORDS);
  const extraNames = new Set<string>();
  const extra = nameFiles.map((f) => {
    const text = readFileSync(f, 'utf8');
    const set = wordSet(text);
    for (const n of set) {
      names.add(n);
      extraNames.add(n);
    }
    return { file: basename(f), names: set.size, sha256: sha256(text) };
  });

  // Mask, defang and trim every clean row, then drop texts that collide after masking.
  const pre = clean.kept.map((r) => ({ row: r, ...preprocessText(r.text) }));
  // Names in the local lists were found by AI reviewer agents reading the sample, so they count as
  // confirmed.
  const confirmed = collectConfirmedNames(
    pre.map((p) => p.text),
    { names, common },
  );
  for (const n of extraNames) if (!common.has(n)) confirmed.add(n);
  const processed: Processed[] = pre.map((p) => {
    const done = finishText(p.text, { names, common, confirmed }, MAX_CHARS);
    return {
      id: `sms-${String(p.row.row)}`,
      label: p.row.label,
      text: done.text,
      original: p.row.text,
      counts: addMaskCounts(p.counts, done.counts),
    };
  });
  const deduped = dedupeProcessed(processed.filter((p) => p.text !== ''));
  const pool = deduped.kept;
  console.log(
    `after masking: ${String(deduped.duplicates)} duplicates and ${String(deduped.conflicts)} ` +
      `cross-label collisions dropped; pool`,
    countLabels(pool),
  );

  // Sample.
  const exclude = readExclude(EXCLUDE);
  const excludeSet = new Set(exclude.ids);
  const poolIds = new Set(pool.map((p) => p.id));
  const unknown = exclude.ids.filter((id) => !poolIds.has(id));
  if (unknown.length > 0) console.warn(`exclude ids not in the pool: ${unknown.join(', ')}`);
  const sample = drawSample(pool, { seed, sizes: SIZES, reserve: RESERVE, exclude: excludeSet });

  const messages: InboxMessage[] = sample.messages.map(({ id, label, text }) => ({
    id,
    label,
    text,
  }));
  const counts = countLabels(messages);
  const maskTotals = sample.messages.reduce(
    (acc, m) => addMaskCounts(acc, m.counts),
    emptyMaskCounts(),
  );
  const poolTotals = pool.reduce((acc, m) => addMaskCounts(acc, m.counts), emptyMaskCounts());

  const output = {
    source: SOURCE,
    alsoCredits: ALSO_CREDITS,
    build: {
      seed,
      maxChars: MAX_CHARS,
      counts,
      excludedCount: sample.excludedCount,
      sha256: sha256(canonicalJson(messages)),
      sha256Of: 'canonical JSON (sorted keys, no whitespace) of `messages`',
      sourceFile: basename(src),
      sourceSha256: sha256(raw),
      ids: 'sms-<n>: n is the 1-based data row of the source CSV (header excluded)',
      nameList: {
        source: 'Hand-built list of common first names in src/cli/build-inbox-data.ts',
        license: 'MIT (original work)',
        builtInNames: builtIn,
        commonWordsNeverMasked: common.size,
        extraLocalLists: extra,
        // The names in these lists were found by AI reviewer agents (Claude) reading the sample, not
        // by a person. The wording below is what the committed messages.json says; it stays as is.
        extraNote:
          'Uncommitted lists in .scratchpad/data-raw/names/ of names found by hand in the sample',
      },
      masked: {
        names: maskTotals.names,
        phones: maskTotals.phones,
        emails: maskTotals.emails,
        urlsDefanged: maskTotals.urls,
        mentionsDefanged: maskTotals.mentions,
        trimmed: maskTotals.trimmed,
      },
    },
    messages,
  };

  const config = (await resolveConfig(OUT)) ?? {};
  const json = await format(JSON.stringify(output), { ...config, parser: 'json' });
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, json);

  const byId = new Map(sample.messages.map((m) => [m.id, m]));
  const review = (m: Processed): object => ({
    id: m.id,
    label: m.label,
    text: m.text,
    original: m.original,
  });
  mkdirSync(reviewDir, { recursive: true });
  writeFileSync(
    join(reviewDir, 'sample.jsonl'),
    jsonl(messages.map((m) => review(byId.get(m.id) as Processed))),
  );
  writeFileSync(
    join(reviewDir, 'reserve.jsonl'),
    jsonl(INBOX_LABELS.flatMap((label) => sample.reserve[label].map(review))),
  );

  console.log(
    `${OUT}: ${String(messages.length)} messages`,
    counts,
    `${String(json.length)} bytes`,
  );
  console.log('masked in the sample:', output.build.masked);
  console.log('masked in the whole pool:', poolTotals);
  console.log(
    `names: ${String(names.size)} (${String(confirmed.size)} seen mid-sentence), ` +
      `extra lists: ${extra.map((e) => e.file).join(', ') || 'none'}`,
  );
  console.log(
    `review files: ${join(reviewDir, 'sample.jsonl')} (${String(messages.length)}), ` +
      join(reviewDir, 'reserve.jsonl'),
    countLabels(INBOX_LABELS.flatMap((l) => sample.reserve[l])),
  );
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
