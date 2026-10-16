/**
 * Builds Clue Clash boards from Open English Wordnet 2025 (core edition, the JSON release).
 *
 * Pure: takes the parsed OEWN JSON and returns boards plus rejection counts. All file I/O lives
 * in `src/cli/build-clues-data.ts`. The same seed and the same OEWN files give the same boards.
 *
 * A board is 16 single-word lemmas of one part of speech, close in meaning:
 * - nouns and verbs: the children and grandchildren of one hypernym (the anchor), topped up with
 *   the two levels below those and with its cousins (the children of the anchor's siblings), all
 *   from the anchor's lexicographer file so the board stays on one topic;
 * - adjectives: the satellites of a head adjective ("similar to"), topped up with the satellites
 *   of its antonym and "see also" heads.
 * Each word gets one sense, one of its two most common (three for adjectives), and its
 * definition is that synset's first gloss (OEWN keeps examples separate, so none are included).
 *
 * Filters, in order: OEWN usage labels and offensive glosses, blocked topics, technical domains,
 * category words, definition length (and glosses cut off at "e.g."), the originality terms
 * (`originality.ts`, always applied) and blocklisted words in the definition, then per lemma:
 * shape (a-z only, 3–12 letters), the originality terms, the hand-built blocklist, commonness,
 * sense rank, and a definition that names the word (`namesOwnWord`). A board then rejects pairs
 * of words that share a synset or stem, are synonyms, are a kind of one another, have
 * near-duplicate definitions, or where one definition names the other word.
 *
 * After the seeded draw, a repair step (`repairBoards`) takes off every word whose gloss can't
 * stand alone as a clue (`glossProblem`: OEWN keeps some glosses that are only a usage note or
 * the differentia of the hypernym, like "cultivated in temperate regions" for peach), every word
 * whose definition gives it away by the full test (`definitionGivesAway`, give-away rule v3: also
 * derived, Latin and compound forms, and any definition word that shares one of the word's
 * morphemes, like "architectural" for architecture or "basswood" for cottonwood), every word
 * whose definition may hold an inflected form of a blocklisted word (`blockedWordsIn`; the draft
 * only checks whole words) and every word the board review (AI reviewers, Claude) excluded for
 * that board's anchor (`data/clues/exclude.json`), then refills the gaps from the same
 * neighbourhood with a near-synonym guard. Last, the boards the board review dropped
 * (`data/clues/drop.json`) are left out, which changes no other board.
 */
import { fnv1a64, utf8Bytes } from '../../core/util/hash.js';
import { createPrng, nextBelow, type PrngState } from '../../core/util/prng.js';
import { originalityTermIn } from './originality.js';

// ---------------------------------------------------------------------------------------------
// Raw OEWN JSON (english-wordnet-2025-json.zip)
// ---------------------------------------------------------------------------------------------

export interface OewnExample {
  text: string;
  source?: string;
}

/** One synset from `noun.*.json`, `verb.*.json`, `adj.*.json` or `adv.all.json`. */
export interface OewnSynset {
  definition: string[];
  members: string[];
  /** n, v, a (head adjective), s (satellite adjective) or r (adverb). */
  partOfSpeech: string;
  example?: (string | OewnExample)[];
  hypernym?: string[];
  similar?: string[];
  also?: string[];
  /** Usage labels: points at synsets such as "disparagement", "obscenity" or "slang". */
  exemplifies?: string[];
  domain_topic?: string[];
  /** Lexicographer file (`noun.animal`, `verb.motion`...). Not in the JSON: the loader adds it. */
  lexfile?: string;
}

export interface OewnSense {
  id: string;
  synset: string;
  antonym?: string[];
  exemplifies?: string[];
  derivation?: string[];
}

export interface OewnEntryPos {
  sense: OewnSense[];
  form?: string[];
  pronunciation?: unknown[];
}

/** One lemma from `entries-*.json`: part-of-speech key (n, v, a, n-1, ...) to its senses. */
export type OewnEntry = Record<string, OewnEntryPos>;

export interface OewnData {
  synsets: Readonly<Record<string, OewnSynset>>;
  entries: Readonly<Record<string, OewnEntry>>;
}

// ---------------------------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------------------------

export type CluesPos = 'noun' | 'verb' | 'adjective';
export const CLUES_POS: readonly CluesPos[] = ['noun', 'verb', 'adjective'];

export interface CluesWord {
  id: string;
  lemma: string;
  synset: string;
  definition: string;
}

export interface CluesBoard {
  id: string;
  pos: CluesPos;
  /**
   * The synset the board is built around (the hypernym or head adjective). Stable across
   * rebuilds, unlike `id`, so `data/clues/exclude.json` and `data/clues/drop.json` are keyed by
   * it. Always set by the build.
   */
  anchor?: string;
  hypernym?: string;
  words: CluesWord[];
}

/** Anchor synset id -> lemmas never put on that anchor's boards (`data/clues/exclude.json`). */
export type CluesExcludeList = Readonly<Record<string, readonly string[]>>;

/**
 * One board the board review dropped (`data/clues/drop.json`): its anchor and one word on it. A
 * wide anchor can have several boards, and those never share a word, so the pair names one board.
 */
export interface CluesDropEntry {
  anchor: string;
  lemma: string;
  /**
   * Set only when a later rebuild took `lemma` off the board (say, its definition gave it away),
   * so the pair no longer names it: the board's draw id (`BoardRepair.drawId`). Only the seed and
   * the drafts decide the draw, so the id keeps naming the same board; the anchor must match too.
   */
  drawId?: string;
}

export interface CluesBoardsFile {
  source: { title: string; url: string; edition: string; license: string };
  build: {
    seed: number;
    counts: { boards: number; byPos: Record<CluesPos, number> };
    sha256: string;
  };
  boards: CluesBoard[];
}

export const BOARD_SIZE = 16;

// ---------------------------------------------------------------------------------------------
// Text checks: the stemmer and the "does this text name that word" test
// ---------------------------------------------------------------------------------------------

/** Lower-case runs of a–z. Hyphens, digits and punctuation split words. */
export function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z]+/g) ?? [];
}

/** [suffix, replacement, shortest stem allowed]. Longest suffixes first; one is stripped. */
const SUFFIX_RULES: readonly (readonly [string, string, number])[] = [
  ['iness', 'i', 2],
  ['ingly', '', 3],
  ['edly', '', 3],
  ['ness', '', 3],
  ['ings', '', 3],
  ['iest', 'i', 2],
  ['ing', '', 3],
  ['ied', 'i', 2],
  ['ies', 'i', 2],
  ['ier', 'i', 2],
  ['ily', 'i', 2],
  ['ers', '', 3],
  ['est', '', 4],
  ['ed', '', 3],
  ['er', '', 3],
  ['es', '', 3],
  ['ly', '', 3],
  ['s', '', 3],
];

const VOWELS = new Set(['a', 'e', 'i', 'o', 'u']);
/** Doubled finals that belong to the root (glass, bell, buzz, staff), so they stay doubled. */
const KEEP_DOUBLE = new Set(['s', 'l', 'z', 'f']);

/**
 * A small suffix-stripping stemmer. It strips one inflectional or common derivational suffix,
 * then drops a final `e`, turns a final `y` into `i` and undoubles a doubled final consonant, so
 * dance/dancing/danced/dancer, happy/happily/happiness, try/tries and run/running/runner meet.
 * Over-matching is fine here: a false match only rejects a candidate word.
 */
export function stem(word: string): string {
  let w = word.toLowerCase();
  for (const [suffix, replacement, minStem] of SUFFIX_RULES) {
    if (!w.endsWith(suffix)) continue;
    const base = w.slice(0, w.length - suffix.length);
    if (base.length < minStem) continue;
    // A word ending in -ss, -us or -is isn't a plural (glass, cactus, iris).
    if (suffix === 's' && /[sui]$/.test(base)) continue;
    w = base + replacement;
    break;
  }
  if (w.length > 3 && w.endsWith('e')) w = w.slice(0, -1);
  if (w.length >= 3 && w.endsWith('y')) w = w.slice(0, -1) + 'i';
  const last = w.at(-1);
  if (
    w.length > 3 &&
    last !== undefined &&
    last === w.at(-2) &&
    !VOWELS.has(last) &&
    !KEEP_DOUBLE.has(last)
  ) {
    w = w.slice(0, -1);
  }
  return w;
}

/** Regular inflections of a lemma: plurals, past forms, participles, comparatives, -ly, -ness. */
export function inflections(lemma: string): Set<string> {
  const w = lemma.toLowerCase();
  const out = new Set<string>([w]);
  for (const suffix of ['s', 'es', 'd', 'ed', 'ing', 'ly', 'ness']) out.add(w + suffix);
  // Plain -er/-est on a three-letter word is usually another word (for: forest); short
  // consonant-vowel-consonant words double instead (big: bigger), handled below.
  if (w.length >= 4 || /[wxy]$/.test(w)) {
    for (const suffix of ['er', 'ers', 'est']) out.add(w + suffix);
  }
  if (w.endsWith('e')) {
    const base = w.slice(0, -1);
    for (const suffix of ['ing', 'ed', 'er', 'est', 'ion']) out.add(base + suffix);
  }
  if (/[^aeiou]y$/.test(w)) {
    const base = w.slice(0, -1);
    for (const suffix of ['ies', 'ied', 'ier', 'iest', 'ily', 'iness']) out.add(base + suffix);
  }
  // Consonant-vowel-consonant: stop -> stopped, stopping, stopper.
  if (/[^aeiou][aeiou][b-df-hj-np-tvz]$/.test(w)) {
    const last = w.slice(-1);
    for (const suffix of ['ed', 'ing', 'er', 'ers', 'est']) out.add(w + last + suffix);
  }
  return out;
}

/**
 * True if `text` names `lemma`: the lemma itself, a listed form (OEWN's irregular forms), a
 * regular inflection, any word with the same stem, or (for lemmas of 4+ letters) a compound
 * that starts or ends with it ("boathouse" names "boat"). Matching is whole-word.
 */
export function mentionsWord(text: string, lemma: string, forms: readonly string[] = []): boolean {
  const lem = lemma.toLowerCase();
  const exact = inflections(lem);
  const stems = new Set<string>([stem(lem)]);
  for (const form of forms) {
    const f = form.toLowerCase();
    exact.add(f);
    stems.add(stem(f));
  }
  for (const token of tokenize(text)) {
    if (exact.has(token) || stems.has(stem(token))) return true;
    if (
      lem.length >= 4 &&
      token.length > lem.length &&
      (token.startsWith(lem) || token.endsWith(lem))
    ) {
      return true;
    }
  }
  return false;
}

/** Length of the longest common prefix of two words. */
function commonPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/** A word with each run of one repeated letter cut to one letter: albizzia -> albizia. */
export function collapseDoubles(word: string): string {
  return word.replace(/([a-z])\1+/g, '$1');
}

/**
 * True if `text` contains a word of 4+ letters (or its stem) that the compound `lemma` starts or
 * ends with: "spoon" in the definition of "spoonbill", "books" in that of "bookstore". Such a
 * definition gives half the answer away, so a word is never shown with one.
 */
export function sharesCompoundPart(text: string, lemma: string): boolean {
  const lem = lemma.toLowerCase();
  for (const token of tokenize(text)) {
    for (const part of new Set([token, stem(token)])) {
      if (part.length < 4 || part.length >= lem.length) continue;
      if (lem.startsWith(part) || lem.endsWith(part)) return true;
    }
  }
  return false;
}

/**
 * The compound parts `sharesCompoundPart` misses because the stemmer cuts them short or changes
 * their last letter. A word whose stem is under four letters counts when the word itself shares
 * four or more letters with the start of the lemma and its stem starts the lemma: "fires" (stem
 * "fir") for "fireman". A part of 4+ letters counts when the lemma's own stem ends with it:
 * "berries" (stem "berri") for "raspberry" (stem "raspberri"), "stripes" for "pinstripe".
 */
export function sharesCompoundForm(text: string, lemma: string): boolean {
  const lem = lemma.toLowerCase();
  const lemStem = stem(lem);
  for (const token of tokenize(text)) {
    const tokenStem = stem(token);
    if (
      tokenStem.length < lem.length &&
      lem.startsWith(tokenStem) &&
      commonPrefix(token, lem) >= 4
    ) {
      return true;
    }
    for (const part of new Set([token, tokenStem])) {
      if (part.length >= 4 && part.length < lem.length && lemStem.endsWith(part)) return true;
    }
  }
  return false;
}

/**
 * Letters a definition word must share with the start of the lemma to give it away: five, or four
 * for lemmas of five letters or fewer (viola: violin). Never fewer than four, so three-letter
 * lemmas are left to `mentionsWord`.
 */
export function sharedPrefixLength(lemma: string): number {
  return Math.max(4, Math.min(5, lemma.length - 1));
}

/**
 * True if a word in `text` starts like `lemma`: they share its first `sharedPrefixLength(lemma)`
 * letters, as written or with doubled letters collapsed. This catches derived and Latin forms the
 * stemmer can't: "architectural" (architecture), "shaken" (shaker), "precipitation"
 * (precipitator), "Geraniaceae" (geranium), "Albizia" (albizzia), "Lupinus" (lupine).
 */
export function sharesPrefix(text: string, lemma: string): boolean {
  const lem = lemma.toLowerCase();
  const k = sharedPrefixLength(lem);
  const lemCollapsed = collapseDoubles(lem);
  for (const token of tokenize(text)) {
    if (commonPrefix(token, lem) >= k) return true;
    if (commonPrefix(collapseDoubles(token), lemCollapsed) >= k) return true;
  }
  return false;
}

/** Endings of Latin genus and family names and the adjectives made from them, longest first. */
const LATIN_ENDINGS = [
  'aceous',
  'oideae',
  'aceae',
  'ineae',
  'idae',
  'inae',
  'ales',
  'ium',
  'ius',
  'ia',
  'us',
  'um',
  'is',
  'ae',
  'a',
  'e',
  'y',
  'i',
];

/** A word with doubled letters collapsed and one Latin (or final e/y) ending taken off. */
export function latinRoot(word: string): string {
  const w = collapseDoubles(word.toLowerCase());
  for (const ending of LATIN_ENDINGS) {
    if (w.endsWith(ending) && w.length - ending.length >= 3) return w.slice(0, -ending.length);
  }
  return w;
}

/**
 * True if `text` names the lemma's genus or family: a capitalised word (OEWN capitalises taxon
 * names) or an "-aceous" adjective whose Latin root and the lemma's share a start of at least
 * three letters, one root inside the other. "Thymus" for thyme, "Rosa" for rose, "Lilium" and
 * "liliaceous" for lily.
 */
export function namesLatinForm(text: string, lemma: string): boolean {
  const lemRoot = latinRoot(lemma);
  for (const match of text.matchAll(/[A-Za-z]+/g)) {
    const word = match[0];
    const lower = word.toLowerCase();
    if (!/^[A-Z][a-z]+$/.test(word) && !lower.endsWith('aceous')) continue;
    const root = latinRoot(lower);
    const shorter = Math.min(root.length, lemRoot.length);
    if (shorter >= 3 && commonPrefix(root, lemRoot) === shorter) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// Give-away rule v3: the lemma's morphemes against every definition word
// ---------------------------------------------------------------------------------------------

/**
 * Irregular forms, word -> forms, for when OEWN's own lists (its `form` fields, the same data as
 * the WNDB `*.exc` exception files) aren't at hand. The build merges both.
 */
export const IRREGULAR_FORMS: Readonly<Record<string, readonly string[]>> = {
  bear: ['bore', 'borne'],
  begin: ['began', 'begun'],
  bend: ['bent'],
  bind: ['bound'],
  bite: ['bitten'],
  bleed: ['bled'],
  blow: ['blew', 'blown'],
  break: ['broke', 'broken'],
  breed: ['bred'],
  bring: ['brought'],
  build: ['built'],
  buy: ['bought'],
  catch: ['caught'],
  child: ['children'],
  choose: ['chose', 'chosen'],
  cling: ['clung'],
  creep: ['crept'],
  deal: ['dealt'],
  dig: ['dug'],
  draw: ['drew', 'drawn'],
  drink: ['drank', 'drunk'],
  drive: ['drove', 'driven'],
  eat: ['ate', 'eaten'],
  fall: ['fell', 'fallen'],
  feed: ['fed'],
  feel: ['felt'],
  fight: ['fought'],
  find: ['found'],
  fly: ['flew', 'flown'],
  foot: ['feet'],
  freeze: ['froze', 'frozen'],
  give: ['gave', 'given'],
  goose: ['geese'],
  grind: ['ground'],
  grow: ['grew', 'grown'],
  hang: ['hung'],
  hide: ['hid', 'hidden'],
  hold: ['held'],
  keep: ['kept'],
  knife: ['knives'],
  know: ['knew', 'known'],
  lead: ['led'],
  leaf: ['leaves'],
  lend: ['lent'],
  louse: ['lice'],
  man: ['men'],
  mean: ['meant'],
  meet: ['met'],
  mouse: ['mice'],
  pay: ['paid'],
  ride: ['rode', 'ridden'],
  ring: ['rang', 'rung'],
  rise: ['rose', 'risen'],
  run: ['ran'],
  seek: ['sought'],
  sell: ['sold'],
  send: ['sent'],
  shake: ['shook', 'shaken'],
  shoot: ['shot'],
  sing: ['sang', 'sung'],
  sink: ['sank', 'sunk'],
  sleep: ['slept'],
  speak: ['spoke', 'spoken'],
  spend: ['spent'],
  spin: ['spun'],
  stand: ['stood'],
  steal: ['stole', 'stolen'],
  sting: ['stung'],
  strike: ['struck'],
  sweep: ['swept'],
  swim: ['swam', 'swum'],
  swing: ['swung'],
  take: ['took', 'taken'],
  teach: ['taught'],
  tear: ['tore', 'torn'],
  tell: ['told'],
  think: ['thought'],
  throw: ['threw', 'thrown'],
  tooth: ['teeth'],
  weave: ['wove', 'woven'],
  weep: ['wept'],
  wife: ['wives'],
  wolf: ['wolves'],
  woman: ['women'],
  write: ['wrote', 'written'],
};

/** The draft's stopwords: left out when comparing the content words of two glosses. */
const STOPWORDS: ReadonlySet<string> = new Set(
  (
    'a an the of or and to in on for with by as at from that which who whom whose is are be ' +
    'been being was were it its this these those any some something someone one ones especially ' +
    'usually often very more most than into out up not no such other e g etc used use having has ' +
    'have'
  ).split(' '),
);

/**
 * Definition words too common to count as a leak, and words never taken as a morpheme: the
 * draft's stopwords plus more function words ("over" in remover, "for" in forest).
 */
const LEAK_STOPWORDS: ReadonlySet<string> = new Set([
  ...STOPWORDS,
  ...(
    'about above after again all also among another around because before below between both ' +
    'but can could did does doing done down each either even ever every few had her here hers ' +
    'him his how however its just less like made make many may might much must nor now off ' +
    'once only onto our over own per same shall she should since so still them then there ' +
    'they thus too two under until upon via was way well what when where whether while why ' +
    'will within without would yet you your'
  ).split(' '),
]);

/**
 * Suffixes stripped to find a word's root, longest first. -ology and -ography leave both roots
 * ("socio" and "soci" for sociology); -onics leaves "tect" for tectonics; -th leaves "slo" for
 * sloth (slow), "grow" for growth.
 */
const ROOT_SUFFIXES = [
  'ography',
  'graphy',
  'ology',
  'onics',
  'logy',
  'ness',
  'ment',
  'ics',
  'ing',
  'ism',
  'ist',
  'ion',
  'ity',
  'ous',
  'al',
  'er',
  'ic',
  'es',
  'ed',
  'th',
  'y',
  's',
];

/** Inflections: stripped only from the word itself, never from a root (chess: ches, not che). */
const INFLECTIONS = new Set(['es', 'ed', 's']);

/**
 * Clippings and blends whose sources spelling can't recover: word -> the words it was cut or
 * blended from. Each source counts as a morpheme of the word.
 */
export const WORD_SOURCES: Readonly<Record<string, readonly string[]>> = {
  avionics: ['aviation', 'electronics'],
  bionics: ['biology', 'electronics'],
  brunch: ['breakfast', 'lunch'],
  bus: ['omnibus'],
  flu: ['influenza'],
  motel: ['motor', 'hotel'],
  sang: ['ginseng'],
  smog: ['smoke', 'fog'],
  van: ['caravan'],
  wig: ['periwig'],
};

/** Morphemes shorter than this are too short to mean anything. */
const MIN_MORPHEME = 3;

/**
 * `record[key]` if the record has that key as its own, else an empty list. A plain lookup would
 * find the built-in properties every object has: `WORD_SOURCES.constructor` is a function.
 */
function listedFor(
  record: Readonly<Record<string, readonly string[]>>,
  key: string,
): readonly string[] {
  return Object.hasOwn(record, key) ? (record[key] ?? []) : [];
}

/** Context for `definitionGivesAway`: the dictionary for compound parts, and irregular forms. */
export interface GiveAwayContext {
  /** True for a dictionary word: the build passes OEWN's single-word lemmas. */
  isWord?: (word: string) => boolean;
  /** Irregular forms of a word (OEWN's `form` lists); `IRREGULAR_FORMS` is always added. */
  formsOf?: (word: string) => readonly string[];
}

/**
 * The roots of a word: what's left, if 3+ letters, after one of `ROOT_SUFFIXES` comes off, and
 * then one more that isn't an inflection (teaching: teach; naturalism: natural, natur;
 * tectonics: tect, tecton, tectonic). A root that ends in a doubled consonant gives the root
 * with it undone too (lottery: lott, lot; swimmer: swimm, swim), except the doubles the stemmer
 * keeps (`KEEP_DOUBLE`: seller gives sell, not sel).
 */
export function wordRoots(word: string): string[] {
  const out = new Set<string>();
  let frontier = [word.toLowerCase()];
  for (let level = 0; level < 2; level++) {
    const next: string[] = [];
    for (const w of frontier) {
      for (const suffix of ROOT_SUFFIXES) {
        if (!w.endsWith(suffix) || (level > 0 && INFLECTIONS.has(suffix))) continue;
        const root = w.slice(0, -suffix.length);
        if (root.length < MIN_MORPHEME || out.has(root)) continue;
        out.add(root);
        next.push(root);
        const last = root.at(-1) ?? '';
        if (
          root.length > MIN_MORPHEME &&
          last === root.at(-2) &&
          !VOWELS.has(last) &&
          !KEEP_DOUBLE.has(last)
        ) {
          out.add(root.slice(0, -1));
        }
      }
    }
    frontier = next;
  }
  return [...out].sort();
}

/**
 * The parts a compound is built from: a start or end piece of 3+ letters that is a dictionary word
 * and whose other piece is a dictionary word of 2+ letters too (bay + berry, wind + fall, bar +
 * tender, re + mover), or a piece of 5+ letters whatever is left (huckle + berry). A start piece
 * of 3+ letters that is a word with its last letter doubled, before a word of 3+ letters, counts
 * as that word, and the rest as a part too: compounds that drop a doubled letter at the joint
 * (bel(l) + fry, chil(l) + blain). Stopwords are left out. Requiring a real compound keeps "lea"
 * out of flea and "pro" out of projectile. A bigger dictionary only ever finds more parts.
 */
export function compoundParts(word: string, isWord: (w: string) => boolean): string[] {
  const w = word.toLowerCase();
  const out = new Set<string>();
  for (let i = 1; i < w.length; i++) {
    const pieces = [
      [w.slice(0, i), w.slice(i)],
      [w.slice(i), w.slice(0, i)],
    ] as const;
    for (const [part, rest] of pieces) {
      if (part.length < MIN_MORPHEME || LEAK_STOPWORDS.has(part) || !isWord(part)) continue;
      if (part.length >= 5 || (rest.length >= 2 && isWord(rest))) out.add(part);
    }
    const start = w.slice(0, i);
    const rest = w.slice(i);
    const doubled = start + start.slice(-1);
    if (
      start.length >= MIN_MORPHEME &&
      rest.length >= MIN_MORPHEME &&
      isWord(doubled) &&
      isWord(rest)
    ) {
      for (const part of [doubled, rest]) if (!LEAK_STOPWORDS.has(part)) out.add(part);
    }
  }
  return [...out].sort();
}

/** The words in `base` with the roots (`wordRoots`) and stem of each: 3+ letters, no stopwords. */
function withRoots(base: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const word of base) {
    const m = word.toLowerCase();
    if (!/^[a-z]+$/.test(m)) continue;
    out.add(m);
    for (const root of wordRoots(m)) out.add(root);
    const s = stem(m);
    if (s.length >= 4) out.add(s);
  }
  for (const m of out) if (m.length < MIN_MORPHEME || LEAK_STOPWORDS.has(m)) out.delete(m);
  return out;
}

/**
 * The morphemes of a lemma, for `leaksMorpheme`: the lemma, its sources (`WORD_SOURCES`) and its
 * compound parts (`compoundParts`, when a dictionary is given), with the roots (`wordRoots`) and
 * stem of each. All 3+ letters, no stopwords, sorted.
 */
export function lemmaMorphemes(lemma: string, isWord?: (w: string) => boolean): string[] {
  const lem = lemma.toLowerCase();
  return [
    ...withRoots([
      lem,
      ...listedFor(WORD_SOURCES, lem),
      ...(isWord === undefined ? [] : compoundParts(lem, isWord)),
    ]),
  ].sort();
}

/** Length of the longest run of letters two words share. */
export function longestCommonSubstring(a: string, b: string): number {
  let best = 0;
  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const row = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        const n = (prev[j - 1] ?? 0) + 1;
        row[j] = n;
        if (n > best) best = n;
      }
    }
    prev = row;
  }
  return best;
}

/**
 * Two spellings of a word with every vowel written as "a": doubled letters collapsed first, so
 * trefoil and trifoliate or caper and Capparis start alike, and then collapsed again, so a run of
 * vowels counts as one and pheasant and Phasianidae ("ea" and "a") start alike too. Test (e) of
 * `morphemeLeak` passes on either: collapsing again can also shorten a shared start ("visaal"
 * and "visaan", vision and visual, become "visal" and "visan").
 */
function vowelBlind(word: string): readonly [string, string] {
  const once = collapseDoubles(word).replace(/[aeiou]/g, 'a');
  return [once, collapseDoubles(once)];
}

export type MorphemeTest = 'a' | 'b' | 'c' | 'd' | 'e' | 'f';

/** Endings that make a 3-letter morpheme's inflected forms: bars, barred, tinny. */
const SHORT_ENDINGS = new Set(['s', 'es', 'ed', 'ing', 'er', 'ers', 'y']);

/**
 * True if `token` is the 3-letter morpheme `m` at its start: m itself, m plus one letter (a root
 * that lost a letter: slow for sloth's "slo", type for typist's "typ"), an inflected form (bars,
 * barred) or a compound of m and a dictionary word of 3+ letters (barroom, tinplate). Not
 * "barely" or "embark".
 */
function shortMorphemeAtStart(token: string, m: string, isWord?: (w: string) => boolean): boolean {
  if (!token.startsWith(m)) return false;
  const rest = token.slice(m.length);
  if (rest.length <= 1 || SHORT_ENDINGS.has(rest)) return true;
  if (rest.startsWith(m.slice(-1)) && SHORT_ENDINGS.has(rest.slice(1))) return true;
  return rest.length >= 3 && isWord !== undefined && isWord(rest);
}

/**
 * Which test, if any, says the definition word `token` gives away the morpheme `m` (both
 * lower-case). A 3-letter m counts only at the token's start (`shortMorphemeAtStart`, which needs
 * `isWord` for compounds), as (a). Otherwise: (a) the token contains m; (b) m contains the token,
 * a token of 4+ letters; (c) they start with the same 4 letters; (d) they share a run of 5+
 * letters; (e) they start with the same 5 letters when vowels count as one letter and doubled
 * letters as one, with or without a run of vowels as one (`vowelBlind`: trefoil: trifoliate,
 * japonica: Japan, caper: Capparis, pheasant: Phasianidae); (f), given `isWord`, one of the
 * token's compound parts (`compoundParts`) starts with the same 4 letters as m (manuscript: manu
 * + script, for scribe).
 */
export function morphemeLeak(
  token: string,
  m: string,
  isWord?: (w: string) => boolean,
): MorphemeTest | null {
  if (m.length < MIN_MORPHEME) return null;
  if (m.length === MIN_MORPHEME) return shortMorphemeAtStart(token, m, isWord) ? 'a' : null;
  if (token.includes(m)) return 'a';
  if (token.length >= 4 && m.includes(token)) return 'b';
  if (commonPrefix(token, m) >= 4) return 'c';
  if (longestCommonSubstring(token, m) >= 5) return 'd';
  const [tokenOnce, tokenTwice] = vowelBlind(token);
  const [mOnce, mTwice] = vowelBlind(m);
  if (commonPrefix(tokenOnce, mOnce) >= 5 || commonPrefix(tokenTwice, mTwice) >= 5) return 'e';
  if (isWord !== undefined && compoundParts(token, isWord).some((p) => commonPrefix(p, m) >= 4)) {
    return 'f';
  }
  return null;
}

/**
 * The words a root may be the base of, for looking up irregular forms: the root, with a final e
 * put back (writ: write), a doubled final letter undone (swimm: swim) or a final i back to y
 * (fli: fly).
 */
function baseForms(root: string): string[] {
  const out = [root, `${root}e`];
  if (root.length > 3 && root.at(-1) === root.at(-2)) out.push(root.slice(0, -1));
  if (root.endsWith('i')) out.push(`${root.slice(0, -1)}y`);
  return out;
}

/**
 * True if a word of `text` gives away one of the lemma's morphemes (`lemmaMorphemes`): by
 * `morphemeLeak` (on the word or, for morphemes of 4+ letters, its stem), or as an irregular form
 * of a morpheme (taught for teaching: `IRREGULAR_FORMS` and `context.formsOf`). A 3-letter lemma
 * counts at the start of any word, since short words are often cut from longer ones (pub: public,
 * lit: literature), and a 3-letter compound part at the end of any word too (human for mankind).
 * The lemma's listed and derivationally related forms (`forms`), with their roots, count by
 * tests (a) to (c) only, on the word or its stem ("gametes", stem "gamet", for agamic's agamete):
 * derived forms end in suffixes unrelated words share ("ethical" and "philosophical",
 * "indentation" and "authentication"). Stopwords never count.
 */
export function leaksMorpheme(
  text: string,
  lemma: string,
  forms: readonly string[] = [],
  context: GiveAwayContext = {},
): boolean {
  const { isWord } = context;
  const lem = lemma.toLowerCase();
  const own = lemmaMorphemes(lem, isWord);
  const derived = [...withRoots(forms)].filter((m) => !own.includes(m)).sort();
  const irregular = new Set<string>();
  for (const m of [...own, ...derived]) {
    for (const base of baseForms(m)) {
      for (const f of listedFor(IRREGULAR_FORMS, base)) irregular.add(f);
      for (const f of context.formsOf?.(base) ?? []) irregular.add(f.toLowerCase());
    }
  }
  const shortParts =
    isWord === undefined ? [] : compoundParts(lem, isWord).filter((p) => p.length === MIN_MORPHEME);
  const strict = new Set<MorphemeTest>(['a', 'b', 'c']);
  for (const token of tokenize(text)) {
    if (LEAK_STOPWORDS.has(token)) continue;
    if (irregular.has(token)) return true;
    if (lem.length === MIN_MORPHEME && token.startsWith(lem)) return true;
    if (shortParts.some((p) => token.length > p.length && token.endsWith(p))) return true;
    const stemmed = stem(token);
    /** The tests the word and, for morphemes of 4+ letters, its stem pass against `m`. */
    const leaks = (m: string): MorphemeTest[] => {
      const out = [morphemeLeak(token, m, isWord)];
      if (m.length > MIN_MORPHEME && stemmed !== token) out.push(morphemeLeak(stemmed, m, isWord));
      return out.filter((t): t is MorphemeTest => t !== null);
    };
    if (own.some((m) => leaks(m).length > 0)) return true;
    if (derived.some((m) => leaks(m).some((t) => strict.has(t)))) return true;
  }
  return false;
}

/**
 * The draft's test for a definition that gives its word away: it names the word or a listed form
 * (`mentionsWord`) or holds half of a compound (`sharesCompoundPart`). The draw only sees the
 * drafts, so this stays as it was when the board set was drawn and reviewed; widening it would
 * reshuffle every board. The repair step applies the full `definitionGivesAway`.
 */
export function namesOwnWord(
  definition: string,
  lemma: string,
  forms: readonly string[] = [],
): boolean {
  return mentionsWord(definition, lemma, forms) || sharesCompoundPart(definition, lemma);
}

/**
 * True if a word's own definition gives it away (the game's rule: a definition never contains its
 * answer or a form of it; docs/research/game-data.md). Give-away rule v3: `namesOwnWord`, a
 * compound part the stemmer hid (`sharesCompoundForm`), a word that starts like it
 * (`sharesPrefix`), its genus or family (`namesLatinForm`), or any definition word that gives away
 * one of its morphemes (`leaksMorpheme`: the word, its compound parts, roots, sources and irregular
 * forms). `forms` are the lemma's listed and derivationally related forms; `context` brings the
 * dictionary for compound parts and more irregular forms. Over-matching only costs a candidate
 * word.
 */
export function definitionGivesAway(
  definition: string,
  lemma: string,
  forms: readonly string[] = [],
  context: GiveAwayContext = {},
): boolean {
  return (
    namesOwnWord(definition, lemma, forms) ||
    sharesCompoundForm(definition, lemma) ||
    sharesPrefix(definition, lemma) ||
    namesLatinForm(definition, lemma) ||
    leaksMorpheme(definition, lemma, forms, context)
  );
}

/** The first gloss, tidied: single spaces, no trailing punctuation. */
export function cleanDefinition(gloss: string): string {
  return gloss
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[;:,\s]+$/, '');
}

/**
 * True for a gloss cut off at an example marker ("of metal e.g."): OEWN moved the example out and
 * left the marker, so the definition no longer says what the word means.
 */
export function truncatedDefinition(definition: string): boolean {
  return /\b(e\.g|i\.e)\.?$/i.test(definition.trim());
}

/** A gloss needs this many words to stand alone as a clue ("very small" doesn't). */
export const MIN_GLOSS_WORDS = 4;

/** Adverbs skipped before a noun gloss's first real word ("often grown as a houseplant"). */
const LEADING_ADVERBS = new Set(
  (
    'often usually widely commonly mostly chiefly mainly especially sometimes typically ' +
    'generally originally formerly also now'
  ).split(' '),
);

/**
 * First words of a noun gloss that is only the differentia, written to follow the hypernym
 * ("having a long tail", "resembling lac", "when dried yields...").
 */
const NOUN_FRAGMENT_OPENERS = new Set(
  'used having resembling like than when where from with by at as'.split(' '),
);

/** Fragment openers only before a preposition: "native to", "found in"; not "native Eurasian tree". */
const NOUN_FRAGMENT_BEFORE_PREPOSITION = new Set(['native', 'found', 'similar', 'related']);

/** Prepositions that open a fragment unless a comma closes a context phrase ("in chess, ..."). */
const CONTEXT_OPENERS = new Set(['in', 'of', 'for', 'on']);

/** After a past participle these make a noun gloss a fragment ("caught along", "considered best"). */
const AFTER_PARTICIPLE = new Set(
  (
    'in on at along for by as from with to into near throughout since under over about within ' +
    'among between across around after before during through beyond upon onto best chiefly ' +
    'especially mainly widely primarily usually often only mostly locally commercially'
  ).split(' '),
);

/** A gloss that is only a note about the word: "a Scottish word", "informal terms for dogs". */
const REGISTER_NOTE =
  /^(?:(?:an?|the|or|and|chiefly|especially|informal|formal|archaic|obsolete|old|former|dated|scottish|scots|british|american|irish|dialect|dialectal|regional|colloquial|slang|nonstandard|child's|children's|poetic|literary|humorous)\s+)+(?:word|words|term|terms|usage|intensifiers?|slang|expressions?|spelling|variant)\b/i;

/**
 * True for a noun gloss that is a fragment rather than a definition. OEWN keeps some Princeton
 * glosses that were only the differentia, meant to be read after the hypernym: "cultivated in
 * temperate regions" (peach), "caught along the Atlantic coast..." (striper). After any leading
 * adverbs, the gloss opens with a fragment word, with "in/of/for/on" and no comma-closed context
 * phrase, or with a past participle (`isParticiple`) or "native/found/similar/related" followed
 * by a preposition or adverb.
 */
function nounFragment(definition: string, isParticiple: (word: string) => boolean): boolean {
  const firstClause = definition.split(';')[0] ?? '';
  const tokens = tokenize(firstClause);
  let i = 0;
  while (i < tokens.length - 1 && LEADING_ADVERBS.has(tokens[i] ?? '')) i++;
  const first = tokens[i];
  if (first === undefined) return true;
  if (NOUN_FRAGMENT_OPENERS.has(first)) return true;
  if (CONTEXT_OPENERS.has(first) && !firstClause.includes(',')) return true;
  const next = tokens[i + 1];
  const participle = isParticiple(first) || NOUN_FRAGMENT_BEFORE_PREPOSITION.has(first);
  return participle && (next === undefined || AFTER_PARTICIPLE.has(next));
}

/**
 * Why a gloss can't stand alone as a clue, or null if it can. A leading qualifier in parentheses
 * ("(of persons) ...", "(used of boats) ...") is set aside, then the rest must not be a usage note
 * ("used of a height or viewpoint"), must have at least `MIN_GLOSS_WORDS` words, must not be a
 * register note about the word ("a Scottish word") and, for nouns, must not be a fragment that
 * leans on the hypernym ("considered best for fruit"). `isParticiple` says which words are past
 * participles; the build passes the past forms of OEWN's verbs.
 */
export function glossProblem(
  definition: string,
  pos: CluesPos,
  isParticiple: (word: string) => boolean = () => false,
): string | null {
  const text = definition.trim();
  const body = text.replace(/^\([^)]*\)\s*/, '');
  if (/^used\b/i.test(text) || /^used\b/i.test(body)) return 'gloss: usage note';
  const words = body.split(/\s+/).filter((w) => /[a-z]/i.test(w));
  if (words.length < MIN_GLOSS_WORDS) return 'gloss: too short to stand alone';
  if (REGISTER_NOTE.test(body)) return 'gloss: register note';
  if (pos === 'noun' && nounFragment(body, isParticiple)) return 'gloss: fragment';
  return null;
}

/** Regular past forms of a verb (bake: baked, try: tried, stop: stopped) plus listed forms. */
export function pastForms(lemma: string, forms: readonly string[] = []): Set<string> {
  const w = lemma.toLowerCase();
  const out = new Set(forms.map((f) => f.toLowerCase()));
  if (w.endsWith('e')) out.add(`${w}d`);
  else if (/[^aeiou]y$/.test(w)) out.add(`${w.slice(0, -1)}ied`);
  else out.add(`${w}ed`);
  if (/[^aeiou][aeiou][b-df-hj-np-tvz]$/.test(w)) out.add(`${w}${w.slice(-1)}ed`);
  return out;
}

function contentStems(definition: string): Set<string> {
  return new Set(
    tokenize(definition)
      .filter((t) => !STOPWORDS.has(t))
      .map(stem),
  );
}

/**
 * Two definitions that say nearly the same thing: Jaccard similarity of their content-word stems
 * of 0.6 or more, or one's content words all inside the other's (with at least two of them).
 */
export function nearDuplicateDefinitions(a: string, b: string): boolean {
  const sa = contentStems(a);
  const sb = contentStems(b);
  if (sa.size === 0 || sb.size === 0) return true;
  let shared = 0;
  for (const s of sa) if (sb.has(s)) shared++;
  const union = sa.size + sb.size - shared;
  if (shared / union >= 0.6) return true;
  return shared === Math.min(sa.size, sb.size) && shared >= 2;
}

/** How many content-word stems two glosses share (stopwords dropped, crude stemming). */
export function sharedContentWords(a: string, b: string): number {
  const sb = contentStems(b);
  let shared = 0;
  for (const s of contentStems(a)) if (sb.has(s)) shared++;
  return shared;
}

/** A refill whose gloss shares this many content words with a board word's gloss is skipped. */
export const GUARD_SHARED_GLOSS_WORDS = 2;

// ---------------------------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------------------------

type ShortPos = 'n' | 'v' | 'a';

function shortPos(partOfSpeech: string): ShortPos | null {
  if (partOfSpeech === 'n') return 'n';
  if (partOfSpeech === 'v') return 'v';
  if (partOfSpeech === 'a' || partOfSpeech === 's') return 'a';
  return null;
}

/** Usage labels that drop the whole lemma, every sense: obscenity, ethnic slur, racism. */
const LEMMA_BLOCKING_LABELS = new Set(['07139048-n', '06717170-n', '01157531-n']);

/** Glosses that mark a sense as offensive, crude, slang or sexual. */
const OFFENSIVE_GLOSS =
  /\b(offensive|obscene|obscenity|vulgar|slur|derogatory|disparaging|insulting|pejorative|contemptuous|slang|informal term|sex|sexual|sexually|intercourse|chastity|erotic|genital|genitals)\b/i;

/**
 * Subtrees no board draws from: sex, bodily waste, drugs of abuse, killing, violence and crime,
 * slavery, and groups of people by race, ethnicity or religion. A synset is excluded if one of
 * these is the synset itself or among its hypernym ancestors.
 */
const BLOCKED_SUBTREES = new Set([
  '00845915-n', // sexual activity
  '07503095-n', // sexual desire
  '05521732-n', // genitalia
  '05520953-n', // sex organ
  '14878134-n', // body waste
  '13494300-n', // excretion (the bodily process)
  '03253661-n', // drug of abuse
  '00219879-n', // killing (the act)
  '00223352-n', // suicide
  '00422440-n', // torture
  '00967515-n', // violence (an act of aggression)
  '00767761-n', // crime
  '00774891-n', // rape (the crime)
  '10628841-n', // slave
  '07984596-n', // race (people)
  '07983996-n', // ethnic group
  '05955536-n', // religion (belief)
  '08098545-n', // religion (institution)
  '01326622-v', // kill (cause to die)
  '01328456-v', // kill (deprive of life)
  '02488014-v', // murder
  '01429048-v', // have sex
  '01431486-v', // copulate
  '00072742-v', // excrete
  '00071765-v', // urinate
  '00073791-v', // defecate
]);

/** `domain_topic` targets (or their hypernyms) that drop a sense: sensitive or too technical. */
const BLOCKED_TOPICS = new Set([
  '00845915-n', // sexual activity
  '00761047-n', // terrorism
  '05955536-n', // religion
  '06243034-n', // Judaism
  '08100476-n', // Roman Catholic Church
  '08458195-n', // law
  '06138021-n', // computer science
  '06094057-n', // chemistry
  '06047178-n', // biology
  '06100457-n', // physics
  '06009822-n', // mathematics
  '06076105-n', // botany
  '06027814-n', // statistics
  '06052606-n', // medicine (the specialty)
  '00613447-n', // medicine (the practice)
  '06182505-n', // linguistics
  '06085077-n', // genetics
  '06067070-n', // anatomy
  '06145709-n', // psychology
  '06125308-n', // geology
  '06184139-n', // grammar
  '06092831-n', // zoology
  '06090110-n', // physiology
  '06173467-n', // logic
  '00705558-n', // psychoanalysis
  '06070395-n', // pathology
]);

/** A gloss that opens with a technical field label, e.g. "(botany) ..." or "(of leaves) ...". */
const TECHNICAL_GLOSS =
  /^\([^)]*\b(botany|biology|zoology|anatomy|chemistry|physics|mathematics|medicine|pathology|geology|genetics|linguistics|grammar|logic|statistics|physiology|psychiatry|psychoanalysis|law|computing|computer|biochemistry|embryology|entomology|ornithology|mineralogy|astronomy|electronics|economics|leaf|leaves|leaflets|petals|botanical)\b/i;

/**
 * Noun lexicographer files whose synsets can anchor a board anywhere in the tree. `noun.body` is
 * left out: its boards were all anatomy jargon.
 */
const CONCRETE_NOUN_FILES = new Set([
  'noun.animal',
  'noun.artifact',
  'noun.food',
  'noun.object',
  'noun.person',
  'noun.plant',
  'noun.shape',
  'noun.substance',
]);

/**
 * In every other noun file (acts, states, attributes, events...) most subtrees are too abstract
 * to make a fair board, so an anchor there has to sit under one of these.
 */
const ABSTRACT_NOUN_ANCHORS = new Set([
  '00429255-n', // dancing
  '00431591-n', // game (an amusement or pastime)
  '00456623-n', // game (a contest with rules)
  '00427931-n', // diversion, recreation
  '00296527-n', // travel
  '00283971-n', // locomotion
  '04963771-n', // color
  '07051211-n', // musical composition
  '06601855-n', // publication
  '07402109-n', // noise
  '07385893-n', // sound (an audible event)
  '07495208-n', // emotion
  '11545095-n', // weather
  '11445694-n', // atmospheric phenomenon
  '11546388-n', // wind
  '08569713-n', // district
  '06854415-n', // punctuation
  '13604927-n', // unit of measurement
  '06005806-n', // discipline (a branch of knowledge)
  '05952149-n', // doctrine
  '13409418-n', // coin
  '05853859-n', // genre
  '00611221-n', // profession
]);

/**
 * Anchors dropped after the board review read their boards: too broad to share a theme, too technical
 * (anatomy, chemistry, botany, number words), or sensitive (sex, mental illness, religion).
 */
const EXCLUDED_ANCHORS = new Set([
  // adjectives
  '02138452-a', // sexy
  '02081496-a', // insane
  '02062466-a', // sacred
  '02178581-a', // compound (leaf shapes)
  '02173903-a', // simple (leaf shapes)
  '02207704-a', // ordinal (number words)
  '02191250-a', // cardinal (number words)
  '01021330-a', // unfit (mixed medical terms)
  '01176433-a', // unhealthy (mixed medical terms)
  '01173787-a', // healthy (mixed medical terms)
  '02253147-a', // rough (leaf shapes)
  '01729926-a', // passionate (sexual)
  '01553334-a', // immoral (sexual morality)
  '00989218-a', // fat (body shaming)
  // nouns: artifacts too broad to share a theme
  '03098030-n', // commodity
  '03080712-n', // commodity (goods)
  '03127399-n', // covering
  '03133774-n', // creation
  '04014270-n', // creation (product)
  '03174056-n', // decoration
  '03298959-n', // equipment
  '03319968-n', // facility
  '03396616-n', // supporting structure
  '03541528-n', // surface
  '03569147-n', // implement
  '03579967-n', // instrument
  '04572661-n', // weapon (draws in execution devices)
  '04573543-n', // weaponry
  '03931348-n', // representation
  '04083958-n', // representation (copy)
  '04366676-n', // support
  '03743963-n', // mechanism
  '03742461-n', // mechanical device
  '03705309-n', // machine
  '03745652-n', // medicine (drug classes)
  '00427931-n', // diversion (too mixed; "game" covers sports)
  '00283971-n', // locomotion (its child "locomotion" makes the better board)
  '00101073-n', // performance
  '03580409-n', // instrumentality
  '04454577-n', // instrumentality (toiletry and the like)
  '04348764-n', // structure
  '04368182-n', // supporting structure
  '04369112-n', // surface
  '03966230-n', // sheet
  '03531378-n', // opening
  '04020673-n', // protective covering
  // nouns: anatomy, chemistry and botany jargon
  '05232895-n', // body structure
  '05275047-n', // animal tissue
  '05277400-n', // bone
  '05297360-n', // skeletal muscle
  '05310901-n', // body cavity
  '14751849-n', // organic compound
  '14831008-n', // chemical
  '14842408-n', // compound (chemistry)
  '13107668-n', // plant part
  '11696293-n', // plant organ
  '13108385-n', // plant organ (reproductive)
  '13145876-n', // plant organ (vegetative)
  '05274844-n', // tissue
  '05296796-n', // muscle
  '05335315-n', // organ
  '14969026-n', // macromolecule
  '15016494-n', // plant material
  '14779983-n', // animal material
  '06046810-n', // life science
  '05305022-n', // organ (body)
  '15035270-n', // salt (chemistry)
  '14752903-n', // protein
  '01474323-n', // vertebrate (taxonomy jargon)
  '01864419-n', // mammal (taxonomy jargon)
  // nouns: people boards full of rare senses, or sensitive
  '10615055-n', // sick person
  '10625393-n', // skilled worker
  '10810861-n', // working person
  '10149362-n', // female
  '09642198-n', // woman
  '10396222-n', // adult
  '10371605-n', // negotiator
  '10062108-n', // consumer
  '10004189-n', // consumer (eater and drinker)
  '09946909-n', // spiritual leader
  '09835195-n', // assistant
  '10392072-n', // official
  '10435383-n', // performer
  // verbs too general to share a theme
  '02661230-v', // be
  '02256551-v', // give
  '02262178-v', // transfer
  '00630153-v', // think
  '00742582-v', // communicate
  '00833312-v', // inform
  '00954556-v', // tell
  '01620211-v', // make
  '01622373-v', // re-create
  '00145958-v', // change state
  '01839438-v', // travel
  '01854282-v', // move (cause to move)
  '01121587-v', // contend (war verbs)
  '02382049-v', // interact
  '02128368-v', // cause to be perceived
  '00672179-v', // evaluate
  '01208838-v', // touch (strike)
  '01402698-v', // touch (hit)
  '02622439-v', // be (relations)
]);

// ---------------------------------------------------------------------------------------------
// Lexicon: indexes over the raw data
// ---------------------------------------------------------------------------------------------

export interface LemmaInfo {
  lemma: string;
  /** Commonness proxy (see `commonness`); higher is more common. */
  score: number;
  /** Irregular forms listed in OEWN (ran, went, geese). */
  forms: string[];
  /** The irregular forms listed for the verb alone (caught, grown). */
  verbForms: string[];
  /** Single-word lemmas derivationally related to this one (stimulant: stimulate). */
  related: string[];
  /** This lemma's synsets per part of speech, in OEWN sense order (most common first). */
  senses: Record<ShortPos, string[]>;
  /** Synsets where this lemma's sense carries a usage label (slang, archaic, disparaging...). */
  labelledSenses: Set<string>;
  /** Dropped everywhere: a strongly labelled sense, or the hand-built blocklist. */
  blocked: boolean;
}

export interface Lexicon {
  synsets: Readonly<Record<string, OewnSynset>>;
  synsetIds: string[];
  /** Inverse of `hypernym`, ids sorted. */
  hyponyms: Map<string, string[]>;
  /** Single-word lower-case lemmas only. */
  lemmas: Map<string, LemmaInfo>;
  /** Sense id -> synset id (for antonyms). */
  senseSynset: Map<string, string>;
  /** `${lemma} ${synsetId}` -> that sense's antonym sense ids. */
  antonyms: Map<string, string[]>;
}

const SINGLE_WORD = /^[a-z]+$/;

function exampleText(example: string | OewnExample): string {
  return typeof example === 'string' ? example : example.text;
}

/**
 * OEWN has no corpus counts (every tag count in its WNDB sense index is 0), so commonness is a
 * proxy built from OEWN itself: how often the word and its regular inflections appear in example
 * sentences (weighted most, since they're ordinary English) and in glosses, how many multi-word
 * lemmas contain it, how many senses it has, whether OEWN gives a pronunciation and how many
 * derivations its senses have.
 */
function commonness(c: {
  examples: number;
  glosses: number;
  multiword: number;
  senses: number;
  pronounced: boolean;
  derivations: number;
}): number {
  return (
    1.5 * Math.log2(1 + c.examples) +
    0.5 * Math.log2(1 + c.glosses) +
    Math.log2(1 + c.multiword) +
    1.5 * Math.log2(1 + c.senses) +
    (c.pronounced ? 1 : 0) +
    0.5 * Math.log2(1 + c.derivations)
  );
}

/** Hash of a lower-case word, as listed in `BLOCKED_WORD_HASHES` (`blocklist.ts`). */
export function blocklistHash(word: string): string {
  return fnv1a64(utf8Bytes(word.toLowerCase()));
}

/** `IRREGULAR_FORMS` turned round: an irregular form -> the words it is a form of (lice: louse). */
const IRREGULAR_BASES: ReadonlyMap<string, readonly string[]> = (() => {
  const out = new Map<string, string[]>();
  for (const [word, forms] of Object.entries(IRREGULAR_FORMS)) {
    for (const form of forms) out.set(form, [...(out.get(form) ?? []), word]);
  }
  return out;
})();

/**
 * The words a gloss word may be an inflected form of: the word with -s, -es, -ed or -ing taken
 * off, -ies and -ied turned back to -y, an -ed word with only the d taken off and -ing swapped
 * for an e (spiced, spicing: spice), and the words it is an irregular form of (`IRREGULAR_FORMS`,
 * and `baseOf` for Wordnet's own lists: lice gives louse). Bases of 2+ letters, sorted, never the
 * word itself.
 */
export function inflectionBases(
  token: string,
  baseOf?: (form: string) => readonly string[],
): string[] {
  const w = token.toLowerCase();
  const out = new Set<string>();
  const strip = (suffix: string, add = ''): void => {
    if (w.endsWith(suffix)) out.add(w.slice(0, w.length - suffix.length) + add);
  };
  strip('s');
  strip('es');
  strip('ies', 'y');
  strip('ed');
  strip('ied', 'y');
  if (w.endsWith('ed')) strip('d');
  strip('ing');
  strip('ing', 'e');
  for (const base of IRREGULAR_BASES.get(w) ?? []) out.add(base);
  for (const base of baseOf?.(w) ?? []) out.add(base.toLowerCase());
  out.delete(w);
  return [...out].filter((b) => b.length >= 2).sort();
}

/** Context for `blockedWordsIn`: the dictionary, and irregular forms turned round. */
export interface BlocklistContext {
  /** True for a dictionary word: the build passes OEWN's single-word lemmas. */
  isWord?: (word: string) => boolean;
  /** The words a form is an irregular form of (OEWN's `form` lists turned round). */
  baseOf?: (form: string) => readonly string[];
}

/**
 * The words of `text` that are blocked (`isBlocked`, a blocklist check) or may be an inflected
 * form of a blocked word (`inflectionBases`), such as a plural. A word that isn't blocked itself
 * is let through when one of the words it may come from is a dictionary word (`context.isWord`)
 * that isn't blocked: "spices" is a form of spice, though -es leaves a blocked word. Being a
 * dictionary word itself isn't enough, since some inflected forms of blocked words are Wordnet
 * lemmas. With a smaller dictionary, or none, fewer words are let through. Each word once, in
 * order.
 */
export function blockedWordsIn(
  text: string,
  isBlocked: (word: string) => boolean,
  context: BlocklistContext = {},
): string[] {
  const out = new Set<string>();
  const plainWord = (w: string): boolean => context.isWord?.(w) === true && !isBlocked(w);
  for (const token of tokenize(text)) {
    if (isBlocked(token)) {
      out.add(token);
      continue;
    }
    const bases = inflectionBases(token, context.baseOf);
    if (bases.some(isBlocked) && !bases.some(plainWord)) out.add(token);
  }
  return [...out];
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

export function buildLexicon(data: OewnData, blockedWordHashes: ReadonlySet<string>): Lexicon {
  const synsetIds = Object.keys(data.synsets).sort();
  const hyponyms = new Map<string, string[]>();
  const glossCounts = new Map<string, number>();
  const exampleCounts = new Map<string, number>();
  for (const id of synsetIds) {
    const synset = data.synsets[id];
    if (synset === undefined) continue;
    for (const parent of synset.hypernym ?? []) {
      const list = hyponyms.get(parent);
      if (list === undefined) hyponyms.set(parent, [id]);
      else list.push(id);
    }
    for (const text of synset.definition) for (const t of tokenize(text)) bump(glossCounts, t);
    for (const example of synset.example ?? []) {
      for (const t of tokenize(exampleText(example))) bump(exampleCounts, t);
    }
  }

  const lemmaKeys = Object.keys(data.entries).sort();
  const multiwordCounts = new Map<string, number>();
  for (const lemma of lemmaKeys) {
    if (SINGLE_WORD.test(lemma)) continue;
    for (const t of new Set(tokenize(lemma))) bump(multiwordCounts, t);
  }

  const senseSynset = new Map<string, string>();
  const senseLemma = new Map<string, string>();
  const derivedSenses = new Map<string, string[]>();
  const antonyms = new Map<string, string[]>();
  const lemmas = new Map<string, LemmaInfo>();
  for (const lemma of lemmaKeys) {
    const entry = data.entries[lemma];
    if (entry === undefined) continue;
    const info: LemmaInfo = {
      lemma,
      score: 0,
      forms: [],
      verbForms: [],
      related: [],
      senses: { n: [], v: [], a: [] },
      labelledSenses: new Set(),
      blocked: blockedWordHashes.has(blocklistHash(lemma)),
    };
    let senses = 0;
    let derivations = 0;
    let pronounced = false;
    for (const posKey of Object.keys(entry).sort()) {
      const pe = entry[posKey];
      if (pe === undefined) continue;
      if (pe.pronunciation !== undefined && pe.pronunciation.length > 0) pronounced = true;
      for (const form of pe.form ?? []) {
        info.forms.push(form.toLowerCase());
        if (posKey === 'v' || posKey.startsWith('v-')) info.verbForms.push(form.toLowerCase());
      }
      for (const sense of pe.sense) {
        senseSynset.set(sense.id, sense.synset);
        senseLemma.set(sense.id, lemma);
        if (sense.derivation !== undefined) {
          derivedSenses.set(lemma, [...(derivedSenses.get(lemma) ?? []), ...sense.derivation]);
        }
        if (sense.antonym !== undefined && sense.antonym.length > 0) {
          antonyms.set(`${lemma} ${sense.synset}`, sense.antonym);
        }
        senses++;
        derivations += sense.derivation?.length ?? 0;
        const synset = data.synsets[sense.synset];
        if (synset === undefined) continue;
        const pos = shortPos(synset.partOfSpeech);
        if (pos !== null && !info.senses[pos].includes(sense.synset)) {
          info.senses[pos].push(sense.synset);
        }
        const labels = [...(sense.exemplifies ?? []), ...(synset.exemplifies ?? [])];
        if (labels.length > 0) info.labelledSenses.add(sense.synset);
        if (labels.some((l) => LEMMA_BLOCKING_LABELS.has(l))) info.blocked = true;
      }
    }
    if (!SINGLE_WORD.test(lemma)) continue;
    let glosses = 0;
    let examples = 0;
    for (const variant of inflections(lemma)) {
      glosses += glossCounts.get(variant) ?? 0;
      examples += exampleCounts.get(variant) ?? 0;
    }
    info.score = commonness({
      examples,
      glosses,
      multiword: multiwordCounts.get(lemma) ?? 0,
      senses,
      pronounced,
      derivations,
    });
    lemmas.set(lemma, info);
  }
  for (const info of lemmas.values()) {
    const related = new Set<string>();
    for (const senseId of derivedSenses.get(info.lemma) ?? []) {
      const other = senseLemma.get(senseId);
      if (other !== undefined && other !== info.lemma && SINGLE_WORD.test(other))
        related.add(other);
    }
    info.related = [...related].sort();
  }
  return { synsets: data.synsets, synsetIds, hyponyms, lemmas, senseSynset, antonyms };
}

/** Hypernym (nouns, verbs) or head adjective (satellites) parents of a synset. */
function parents(lex: Lexicon, id: string): readonly string[] {
  const synset = lex.synsets[id];
  if (synset === undefined) return [];
  if (synset.partOfSpeech === 's') return synset.similar ?? [];
  return synset.hypernym ?? [];
}

/** Ancestors up to `depth` levels up (not including `id`). */
function ancestors(lex: Lexicon, id: string, depth: number): Set<string> {
  const out = new Set<string>();
  let frontier = [id];
  for (let level = 0; level < depth && frontier.length > 0; level++) {
    const next: string[] = [];
    for (const s of frontier) {
      for (const p of parents(lex, s)) {
        if (!out.has(p)) {
          out.add(p);
          next.push(p);
        }
      }
    }
    frontier = next;
  }
  return out;
}

/** True if `id` or one of its hypernym ancestors is in `roots`. Memoised per root set. */
function underAny(
  lex: Lexicon,
  id: string,
  roots: ReadonlySet<string>,
  memo: Map<string, boolean>,
): boolean {
  const known = memo.get(id);
  if (known !== undefined) return known;
  memo.set(id, false); // cycle guard
  let hit = roots.has(id);
  if (!hit) {
    for (const p of lex.synsets[id]?.hypernym ?? []) {
      if (underAny(lex, p, roots, memo)) {
        hit = true;
        break;
      }
    }
  }
  memo.set(id, hit);
  return hit;
}

/** Shortest hypernym path to a root (a synset with no hypernym). */
function depthOf(lex: Lexicon, id: string, memo: Map<string, number>): number {
  const known = memo.get(id);
  if (known !== undefined) return known;
  memo.set(id, 0); // cycle guard
  const ps = lex.synsets[id]?.hypernym ?? [];
  const d = ps.length === 0 ? 0 : 1 + Math.min(...ps.map((p) => depthOf(lex, p, memo)));
  memo.set(id, d);
  return d;
}

/** Every synset of a lemma, any part of speech. */
function allSenses(lex: Lexicon, lemma: string): Set<string> {
  const info = lex.lemmas.get(lemma);
  return new Set(info === undefined ? [] : [...info.senses.n, ...info.senses.v, ...info.senses.a]);
}

/**
 * True if two lemmas are likely near-synonyms by OEWN's own links: in any part of speech they
 * share a synset, or a sense of one is "similar to" a sense of the other (a satellite and its
 * head adjective: stalwart and brave).
 */
export function sensesTouch(lex: Lexicon, a: string, b: string): boolean {
  const sa = allSenses(lex, a);
  const sb = allSenses(lex, b);
  for (const [from, to] of [
    [sa, sb],
    [sb, sa],
  ] as const) {
    for (const s of from) {
      if (to.has(s)) return true;
      for (const t of lex.synsets[s]?.similar ?? []) if (to.has(t)) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// Candidates and boards
// ---------------------------------------------------------------------------------------------

export interface BuildOptions {
  seed: number;
  /** Boards wanted per part of speech. */
  quota: Record<CluesPos, number>;
  /** Lemmas scoring below this are "very rare" and skipped. */
  minScore?: number;
  /** FNV-1a 64 hashes (`blocklistHash`) of hand-blocked words. */
  blockedWordHashes?: ReadonlySet<string>;
  /** Lemmas to keep off each anchor's boards (`data/clues/exclude.json`). */
  exclude?: CluesExcludeList;
  /**
   * Boards to leave out after repair (`data/clues/drop.json`). Each entry must name exactly one
   * drawn board, or the build throws. One the repair step dropped anyway is reported in
   * `listDropped` too.
   */
  drop?: readonly CluesDropEntry[];
}

/** What the repair step did to one final board. */
export interface BoardRepair {
  /** The board's id in the draw, before any board was dropped. */
  drawId: string;
  /** Words taken off: excluded for the anchor, or a gloss that can't stand alone. */
  removed: { lemma: string; reason: string }[];
  /** Refills, in the order they were chosen. */
  added: string[];
}

export interface RepairStats {
  /** Words taken off drawn boards, by reason, most first. */
  removed: [string, number][];
  /** Refill candidates passed over, by reason, most first (the guard's are counted here too). */
  skipped: [string, number][];
  /** Words put back. */
  refilled: number;
  /** Refill candidates the near-synonym guard skipped, by test. */
  guard: { sharedSense: number; sharedGlossWords: number };
  /** Drawn boards that couldn't be repaired, so aren't in `boards`. */
  dropped: { drawId: string; anchor: string; pos: CluesPos; reason: string }[];
  /** Anchors in the exclude list that no drawn board has. */
  unusedExclusions: string[];
}

export interface BuildResult {
  boards: CluesBoard[];
  /** Why candidates were rejected while drafting boards, by reason, most first. */
  rejections: [string, number][];
  /** Feasible boards found before sampling, by part of speech. */
  feasible: Record<CluesPos, number>;
  /** Final board id -> what the repair step did to it. */
  repairs: Record<string, BoardRepair>;
  repair: RepairStats;
  /**
   * Boards `options.drop` names, in draw order: left out, or already dropped by the repair step
   * (`repairDropped`).
   */
  listDropped: {
    drawId: string;
    anchor: string;
    pos: CluesPos;
    lemma: string;
    repairDropped?: true;
  }[];
}

interface Candidate {
  lemma: string;
  synset: string;
  definition: string;
  score: number;
}

interface BoardDraft {
  pos: CluesPos;
  anchor: string;
  hypernym: string | undefined;
  words: Candidate[];
  quality: number;
  /** The candidate synsets the board was filled from, best tier first. */
  tiers: readonly (readonly string[])[];
  /**
   * Repairs refill from `tiers` and then one wider tier: for nouns and verbs the families of the
   * anchor's siblings (when the parent has at most `MAX_PARENT_CHILDREN_FOR_REFILL` children),
   * for adjectives the satellites of the heads two antonym or "see also" links away.
   */
  refillTiers: readonly (readonly string[])[];
  /** Only synsets in this lexicographer file count (nouns and verbs). */
  lexfile: string | undefined;
  /** The board's label for a given set of words (cousins widen it to the anchor's parent). */
  label: (words: readonly Candidate[]) => string | undefined;
}

export const DEFAULT_MIN_SCORE = 3.5;
const MIN_LEMMA_LENGTH = 3;
/**
 * A synset with more hyponyms than this is a category ("noise", "canine"), and its gloss fits
 * the words below it too, so it never goes on a board.
 */
const MAX_CANDIDATE_HYPONYMS = 8;
const MAX_LEMMA_LENGTH = 12;
/** The draft's floor; the repair step then holds every board word to `MIN_GLOSS_WORDS`. */
const MIN_DEFINITION_WORDS = 2;
const MAX_DEFINITION_CHARS = 200;
/** A word's board sense must be among its first N senses in that part of speech. */
const MAX_SENSE_RANK: Record<ShortPos, number> = { n: 2, v: 2, a: 3 };
/** Hypernym levels checked for "one word is a kind of another". */
const RELATED_DEPTH = 3;
/**
 * Tier-1 words a board needs, so it stays centred on its anchor: descendants within two levels
 * for nouns and verbs, the head's own satellites for adjectives.
 */
const MIN_TIER1: Record<ShortPos, number> = { n: 4, v: 8, a: 4 };
/** Anchors this broad ("device", "act") make boards with nothing in common. */
const MAX_ANCHOR_CHILDREN = 100;
const MAX_ANCHOR_SPAN = 300;
/**
 * Natural-kind taxonomies (trees, flowers, fish, dishes, minerals) stay coherent however wide
 * they are, so their anchors may be broader and give more than one board each.
 */
const NATURAL_KIND_FILES = new Set(['noun.animal', 'noun.plant', 'noun.food', 'noun.substance']);
const MAX_NATURAL_ANCHOR_CHILDREN = 400;
const MAX_NATURAL_ANCHOR_SPAN = 800;
const MAX_BOARDS_PER_ANCHOR: Record<'n' | 'v', number> = { n: 3, v: 2 };
/** Shallower anchors ("artifact", "change") are too general. Verb trees are much flatter. */
const MIN_ANCHOR_DEPTH: Record<'n' | 'v', number> = { n: 5, v: 1 };
/** Cousins only come in when the anchor's parent is this specific. */
const MAX_PARENT_CHILDREN_FOR_COUSINS = 25;
/** Refills may come from the families of the anchor's siblings when the parent is this specific. */
const MAX_PARENT_CHILDREN_FOR_REFILL = 60;
/** Lemmas two boards may share, and boards one lemma may appear on. */
const MAX_SHARED_LEMMAS = 5;
const MAX_BOARDS_PER_LEMMA = 3;
/** The best `POOL_FACTOR × quota` feasible boards per part of speech go into the seeded draw. */
const POOL_FACTOR = 3;

const BLOCKED_GLOSS = 'blocklisted word in the definition';

class Rejections {
  readonly counts = new Map<string, number>();
  add(reason: string): void {
    this.counts.set(reason, (this.counts.get(reason) ?? 0) + 1);
  }
  sorted(): [string, number][] {
    return [...this.counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  }
}

class BoardBuilder {
  private readonly subtreeMemo = new Map<string, boolean>();
  private readonly topicMemo = new Map<string, boolean>();
  private readonly abstractMemo = new Map<string, boolean>();
  private readonly depthMemo = new Map<string, number>();
  private readonly candidateMemo = new Map<string, Candidate | null>();
  readonly rejections = new Rejections();

  constructor(
    private readonly lex: Lexicon,
    private readonly minScore: number,
    private readonly blockedWordHashes: ReadonlySet<string>,
  ) {}

  isBlockedTopic(id: string): boolean {
    return underAny(this.lex, id, BLOCKED_SUBTREES, this.subtreeMemo);
  }

  isAbstractAnchor(id: string): boolean {
    return underAny(this.lex, id, ABSTRACT_NOUN_ANCHORS, this.abstractMemo);
  }

  depth(id: string): number {
    return depthOf(this.lex, id, this.depthMemo);
  }

  private participles: Set<string> | undefined;

  /** True for a past form of an OEWN verb that isn't also a noun (cultivated, caught; not seed). */
  readonly isParticiple = (word: string): boolean => {
    if (this.participles === undefined) {
      const out = new Set<string>();
      for (const info of this.lex.lemmas.values()) {
        if (info.senses.v.length === 0) continue;
        for (const form of pastForms(info.lemma, info.verbForms)) {
          if ((this.lex.lemmas.get(form)?.senses.n.length ?? 0) === 0) out.add(form);
        }
      }
      this.participles = out;
    }
    return this.participles.has(word);
  };

  /** `glossProblem` for a candidate's definition, with OEWN's verbs as the participles. */
  glossProblem(c: Candidate, pos: CluesPos): string | null {
    return glossProblem(c.definition, pos, this.isParticiple);
  }

  /** The best word for one synset, or null. Each synset is judged (and counted) once. */
  candidate(synsetId: string): Candidate | null {
    if (this.candidateMemo.has(synsetId)) return this.candidateMemo.get(synsetId) ?? null;
    const result = this.computeCandidate(synsetId);
    this.candidateMemo.set(synsetId, result);
    return result;
  }

  private computeCandidate(synsetId: string): Candidate | null {
    const synset = this.lex.synsets[synsetId];
    const pos = synset === undefined ? null : shortPos(synset.partOfSpeech);
    const gloss = synset?.definition[0];
    if (synset === undefined || pos === null || gloss === undefined) return null;
    const definition = cleanDefinition(gloss);
    if ((synset.exemplifies ?? []).length > 0 || OFFENSIVE_GLOSS.test(definition)) {
      this.rejections.add('usage label or offensive gloss');
      return null;
    }
    if (this.isBlockedTopic(synsetId)) {
      this.rejections.add('blocked topic');
      return null;
    }
    if ((this.lex.hyponyms.get(synsetId)?.length ?? 0) > MAX_CANDIDATE_HYPONYMS) {
      this.rejections.add('category word (too many hyponyms)');
      return null;
    }
    const topics = synset.domain_topic ?? [];
    if (
      TECHNICAL_GLOSS.test(definition) ||
      topics.some((t) => underAny(this.lex, t, BLOCKED_TOPICS, this.topicMemo))
    ) {
      this.rejections.add('technical or sensitive domain');
      return null;
    }
    const tokens = tokenize(definition);
    if (
      tokens.length < MIN_DEFINITION_WORDS ||
      definition.length > MAX_DEFINITION_CHARS ||
      truncatedDefinition(definition)
    ) {
      this.rejections.add('definition too short or long');
      return null;
    }
    if (originalityTermIn(definition)) {
      this.rejections.add('originality term in the definition');
      return null;
    }
    // Whole words only. The draw only sees the drafts, so this stays as it was when the board set
    // was drawn and reviewed; the repair step also checks inflected forms (`blockedInDefinition`).
    if (tokens.some(this.isBlocked)) {
      this.rejections.add(BLOCKED_GLOSS);
      return null;
    }
    let best: Candidate | null = null;
    let reason = 'no single-word lemma';
    for (const member of synset.members) {
      const info = SINGLE_WORD.test(member) ? this.lex.lemmas.get(member) : undefined;
      if (info === undefined) continue;
      const why = this.lemmaProblem(info, synsetId, pos, definition);
      if (why !== null) {
        reason = why;
        continue;
      }
      if (best === null || info.score > best.score) {
        best = { lemma: member, synset: synsetId, definition, score: info.score };
      }
    }
    if (best === null) this.rejections.add(reason);
    return best;
  }

  private lemmaProblem(
    info: LemmaInfo,
    synsetId: string,
    pos: ShortPos,
    definition: string,
  ): string | null {
    if (info.lemma.length < MIN_LEMMA_LENGTH || info.lemma.length > MAX_LEMMA_LENGTH) {
      return 'lemma too short or long';
    }
    if (originalityTermIn(info.lemma)) return 'originality term as the word';
    if (info.blocked) return 'blocklist or strongly labelled lemma';
    if (info.labelledSenses.has(synsetId)) return 'usage label or offensive gloss';
    if (info.score < this.minScore) return 'rare word';
    const rank = info.senses[pos].indexOf(synsetId);
    if (rank < 0 || rank >= MAX_SENSE_RANK[pos]) return 'not a main sense of the word';
    const here = info.senses[pos].length;
    const elsewhere = Math.max(info.senses.n.length, info.senses.v.length, info.senses.a.length);
    if (here === 1 && elsewhere >= 3) return 'not a main part of speech for the word';
    if (namesOwnWord(definition, info.lemma, [...info.forms, ...info.related])) {
      return 'definition contains its own word';
    }
    return null;
  }

  private readonly giveAwayMemo = new Map<string, boolean>();

  /**
   * The full give-away test's context: OEWN's single-word lemmas as the dictionary for compound
   * parts, and OEWN's listed forms (its exception lists) as irregular forms.
   */
  readonly giveAwayContext: GiveAwayContext = {
    isWord: (word) => this.lex.lemmas.has(word),
    formsOf: (word) => this.lex.lemmas.get(word)?.forms ?? [],
  };

  /** True if a candidate's definition gives its word away by the full test (repair step). */
  givesAway(c: Candidate): boolean {
    const key = `${c.lemma} ${c.synset}`;
    const known = this.giveAwayMemo.get(key);
    if (known !== undefined) return known;
    const info = this.lex.lemmas.get(c.lemma);
    const result = definitionGivesAway(
      c.definition,
      c.lemma,
      [...(info?.forms ?? []), ...(info?.related ?? [])],
      this.giveAwayContext,
    );
    this.giveAwayMemo.set(key, result);
    return result;
  }

  /** True for a word on the hand-built blocklist. */
  readonly isBlocked = (word: string): boolean => this.blockedWordHashes.has(blocklistHash(word));

  private formBases: Map<string, string[]> | undefined;

  /**
   * The full blocklist check's context: OEWN's single-word lemmas as the dictionary, and OEWN's
   * listed forms turned round as irregular forms.
   */
  readonly blocklistContext: BlocklistContext = {
    isWord: (word) => this.lex.lemmas.has(word),
    baseOf: (form) => {
      if (this.formBases === undefined) {
        const out = new Map<string, string[]>();
        for (const info of this.lex.lemmas.values()) {
          for (const f of new Set(info.forms)) out.set(f, [...(out.get(f) ?? []), info.lemma]);
        }
        this.formBases = out;
      }
      return this.formBases.get(form) ?? [];
    },
  };

  /**
   * True if a candidate's definition holds a blocked word or may hold an inflected form of one
   * (`blockedWordsIn`; repair step).
   */
  blockedInDefinition(c: Candidate): boolean {
    return blockedWordsIn(c.definition, this.isBlocked, this.blocklistContext).length > 0;
  }

  /** Why `c` can't share a board with `d`, or null if it can. */
  conflict(c: Candidate, d: Candidate, pos: ShortPos): string | null {
    if (c.lemma === d.lemma) return 'board: same lemma twice';
    if (c.synset === d.synset) return 'board: shared synset';
    if (stem(c.lemma) === stem(d.lemma)) return 'board: same stem';
    if (c.definition.toLowerCase() === d.definition.toLowerCase()) {
      return 'board: identical definitions';
    }
    const ci = this.lex.lemmas.get(c.lemma);
    const di = this.lex.lemmas.get(d.lemma);
    if (ci === undefined || di === undefined) return 'board: unknown lemma';
    if (
      mentionsWord(c.definition, d.lemma, [...di.forms, ...di.related]) ||
      mentionsWord(d.definition, c.lemma, [...ci.forms, ...ci.related])
    ) {
      return 'board: definition names another board word';
    }
    const dSenses = new Set(di.senses[pos]);
    if (ci.senses[pos].some((s) => dSenses.has(s))) return 'board: synonyms';
    const cAnc = ancestors(this.lex, c.synset, RELATED_DEPTH);
    const dAnc = ancestors(this.lex, d.synset, RELATED_DEPTH);
    if (di.senses[pos].some((s) => cAnc.has(s)) || ci.senses[pos].some((s) => dAnc.has(s))) {
      return 'board: one word is a kind of another';
    }
    if (nearDuplicateDefinitions(c.definition, d.definition)) {
      return 'board: near-duplicate definitions';
    }
    return null;
  }

  /**
   * The candidates in each tier, most common first. A synset counts in the first tier that lists
   * it, and only synsets in `lexfile` (if given) count.
   */
  ordered(tiers: readonly (readonly string[])[], lexfile: string | undefined): Candidate[][] {
    const seen = new Set<string>();
    const ordered: Candidate[][] = [];
    for (const tier of tiers) {
      const list: Candidate[] = [];
      for (const id of tier) {
        if (seen.has(id)) continue;
        seen.add(id);
        if (lexfile !== undefined && this.lex.synsets[id]?.lexfile !== lexfile) continue;
        const c = this.candidate(id);
        if (c !== null) list.push(c);
      }
      list.sort((a, b) => b.score - a.score || (a.lemma < b.lemma ? -1 : 1));
      ordered.push(list);
    }
    return ordered;
  }

  /**
   * Greedy fill: tier 1 by commonness, then tier 2. Only synsets in `lexfile` (if given) count,
   * and lemmas in `exclude` are skipped. Returns the words and how many came from tier 1, or
   * null if 16 can't be found.
   */
  fill(
    tiers: readonly (readonly string[])[],
    pos: ShortPos,
    lexfile: string | undefined,
    exclude: ReadonlySet<string> = new Set(),
  ): { words: Candidate[]; tier1: number } | null {
    const ordered = this.ordered(tiers, lexfile).map((list) =>
      list.filter((c) => !exclude.has(c.lemma)),
    );
    if ((ordered[0]?.length ?? 0) < MIN_TIER1[pos]) return null;
    const chosen: Candidate[] = [];
    let tier1 = 0;
    for (const [t, list] of ordered.entries()) {
      for (const c of list) {
        if (chosen.length === BOARD_SIZE) break;
        let reason: string | null = null;
        for (const d of chosen) {
          reason = this.conflict(c, d, pos);
          if (reason !== null) break;
        }
        if (reason !== null) {
          this.rejections.add(reason);
          continue;
        }
        chosen.push(c);
        if (t === 0) tier1++;
      }
    }
    if (chosen.length < BOARD_SIZE || tier1 < MIN_TIER1[pos]) return null;
    return { words: chosen, tier1 };
  }
}

function firstLemma(lex: Lexicon, id: string | undefined): string | undefined {
  return id === undefined ? undefined : lex.synsets[id]?.members[0];
}

function meanScore(words: readonly Candidate[]): number {
  return words.reduce((sum, w) => sum + w.score, 0) / words.length;
}

/**
 * Nouns and verbs: the anchor's children and grandchildren first, then the two levels below
 * those and its cousins (the children of its siblings), all in the anchor's lexicographer file.
 */
function hyponymDrafts(lex: Lexicon, builder: BoardBuilder, pos: 'noun' | 'verb'): BoardDraft[] {
  const sp: 'n' | 'v' = pos === 'noun' ? 'n' : 'v';
  const kids = (ids: readonly string[]): string[] =>
    ids.flatMap((id) => lex.hyponyms.get(id) ?? []);
  const drafts: BoardDraft[] = [];
  for (const anchor of lex.synsetIds) {
    const synset = lex.synsets[anchor];
    if (synset === undefined || synset.partOfSpeech !== sp) continue;
    if (EXCLUDED_ANCHORS.has(anchor)) continue;
    const natural = pos === 'noun' && NATURAL_KIND_FILES.has(synset.lexfile ?? '');
    const children = lex.hyponyms.get(anchor) ?? [];
    const maxChildren = natural ? MAX_NATURAL_ANCHOR_CHILDREN : MAX_ANCHOR_CHILDREN;
    if (children.length === 0 || children.length > maxChildren) continue;
    const grandchildren = kids(children);
    const span = children.length + grandchildren.length;
    if (span < BOARD_SIZE || span > (natural ? MAX_NATURAL_ANCHOR_SPAN : MAX_ANCHOR_SPAN)) continue;
    // The hand-picked abstract anchors are specific enough at any depth.
    const listed = ABSTRACT_NOUN_ANCHORS.has(anchor);
    if (!listed && builder.depth(anchor) < MIN_ANCHOR_DEPTH[sp]) continue;
    if (builder.isBlockedTopic(anchor)) continue;
    if (
      pos === 'noun' &&
      !CONCRETE_NOUN_FILES.has(synset.lexfile ?? '') &&
      !builder.isAbstractAnchor(anchor)
    ) {
      continue;
    }
    const below = new Set([...children, ...grandchildren]);
    const deeper = kids(grandchildren);
    deeper.push(...kids(deeper));
    for (const g of deeper) below.add(g);
    const cousins: string[] = [];
    const wider: string[] = [];
    for (const parent of synset.hypernym ?? []) {
      const siblings = lex.hyponyms.get(parent) ?? [];
      if (EXCLUDED_ANCHORS.has(parent)) continue;
      if (builder.depth(parent) < MIN_ANCHOR_DEPTH[sp]) continue;
      if (siblings.length > MAX_PARENT_CHILDREN_FOR_REFILL) continue;
      const theirs = kids(siblings.filter((s) => s !== anchor));
      wider.push(...theirs, ...kids(theirs));
      if (siblings.length > MAX_PARENT_CHILDREN_FOR_COUSINS) continue;
      cousins.push(...theirs);
    }
    const near = [...children, ...grandchildren];
    // Cousins widen the topic to the anchor's parent; name the board after that.
    const label = (words: readonly Candidate[]): string | undefined =>
      words.some((w) => !below.has(w.synset))
        ? firstLemma(lex, synset.hypernym?.[0])
        : firstLemma(lex, anchor);
    // A wide anchor can give several boards; each later one skips the earlier ones' words and
    // stays below the anchor (no cousins), so it keeps the anchor's theme.
    const used = new Set<string>();
    for (let n = 0; n < MAX_BOARDS_PER_ANCHOR[sp]; n++) {
      const tiers = n === 0 ? [near, [...deeper, ...cousins]] : [near, deeper];
      const filled = builder.fill(tiers, sp, synset.lexfile, used);
      if (filled === null) break;
      for (const w of filled.words) used.add(w.lemma);
      drafts.push({
        pos,
        anchor,
        hypernym: label(filled.words),
        words: filled.words,
        quality: meanScore(filled.words),
        tiers,
        refillTiers: [...tiers, wider],
        lexfile: synset.lexfile,
        label,
      });
    }
  }
  return drafts;
}

/** Synsets of the antonyms of `lemma`'s sense in `synsetId`. */
function antonymSynsets(lex: Lexicon, lemma: string, synsetId: string): string[] {
  const out: string[] = [];
  for (const senseId of lex.antonyms.get(`${lemma} ${synsetId}`) ?? []) {
    const target = lex.senseSynset.get(senseId);
    if (target !== undefined) out.push(target);
  }
  return out;
}

/** Adjectives: satellites of a head, then those of its antonym and "see also" heads. */
function adjectiveDrafts(lex: Lexicon, builder: BoardBuilder): BoardDraft[] {
  const drafts: BoardDraft[] = [];
  const satellites = (head: string): string[] =>
    (lex.synsets[head]?.similar ?? []).filter((s) => lex.synsets[s]?.partOfSpeech === 's');
  for (const head of lex.synsetIds) {
    const synset = lex.synsets[head];
    if (synset === undefined || synset.partOfSpeech !== 'a') continue;
    if (EXCLUDED_ANCHORS.has(head)) continue;
    const own = satellites(head);
    if (own.length < MIN_TIER1.a) continue;
    const related = new Set<string>();
    for (const member of synset.members) {
      for (const id of antonymSynsets(lex, member, head)) related.add(id);
    }
    for (const also of synset.also ?? []) {
      if (lex.synsets[also]?.partOfSpeech === 'a') related.add(also);
    }
    related.delete(head);
    for (const r of [...related]) if (EXCLUDED_ANCHORS.has(r)) related.delete(r);
    const tier2 = [...related].sort().flatMap((r) => satellites(r));
    const tiers = [own, tier2];
    // Refills may also come from the heads related to those heads (two links away).
    const further = new Set<string>();
    for (const r of [...related].sort()) {
      const rs = lex.synsets[r];
      if (rs === undefined) continue;
      for (const member of rs.members) {
        for (const id of antonymSynsets(lex, member, r)) further.add(id);
      }
      for (const also of rs.also ?? []) {
        if (lex.synsets[also]?.partOfSpeech === 'a') further.add(also);
      }
    }
    for (const r of [...further]) {
      if (r === head || related.has(r) || EXCLUDED_ANCHORS.has(r)) further.delete(r);
    }
    const tier3 = [...further].sort().flatMap((r) => satellites(r));
    const filled = builder.fill(tiers, 'a', undefined);
    if (filled === null) continue;
    const headLemma = firstLemma(lex, head);
    drafts.push({
      pos: 'adjective',
      anchor: head,
      hypernym: headLemma,
      words: filled.words,
      quality: meanScore(filled.words),
      tiers,
      refillTiers: [...tiers, tier3],
      lexfile: undefined,
      label: () => headLemma,
    });
  }
  return drafts;
}

/** Fisher–Yates with sfc32. Mutates and returns `items`. */
function shuffle<T>(items: T[], prng: PrngState): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = nextBelow(prng, i + 1);
    const a = items[i] as T;
    items[i] = items[j] as T;
    items[j] = a;
  }
  return items;
}

const SHORT_POS: Record<CluesPos, ShortPos> = { noun: 'n', verb: 'v', adjective: 'a' };

function boardId(index: number): string {
  return `b${String(index + 1).padStart(3, '0')}`;
}

interface DrawnBoard {
  draft: BoardDraft;
  drawId: string;
  /** One slot per word in drawn word order; null once a word is taken off and until refilled. */
  slots: (Candidate | null)[];
  removed: { lemma: string; reason: string }[];
  added: string[];
  /** Why the board was dropped, or null. */
  dropped: string | null;
}

const GUARD_SENSE = 'guard: shared or similar sense';
const GUARD_GLOSS = 'guard: shared gloss words';
const GIVES_AWAY = 'definition gives its word away';

function liveWords(board: DrawnBoard): Candidate[] {
  return board.slots.filter((w): w is Candidate => w !== null);
}

/**
 * Repair the drawn boards. First each board loses the words excluded for its anchor, those whose
 * gloss can't stand alone (`glossProblem`), those whose definition gives the word away by the
 * full test (`definitionGivesAway`; the draft only applies `namesOwnWord`) and those whose
 * definition may hold an inflected form of a blocklisted word (`blockedInDefinition`; the draft
 * only checks whole words). Then, in draw order, a board with gaps refills them from its
 * `refillTiers` (its own tiers, then one wider tier), most common first, under the usual filters:
 * the candidate filters, the full give-away test, the full blocklist check, the pair conflicts
 * with every word on the board, at most `MAX_BOARDS_PER_LEMMA` boards per lemma, at most
 * `MAX_SHARED_LEMMAS` lemmas shared with any other board, and no lemma from another board of the
 * same anchor. Refills alone also pass a near-synonym guard: none that `sensesTouch` a board word
 * or shares `GUARD_SHARED_GLOSS_WORDS` content words with a board word's gloss. Kept words keep
 * their slots; refills fill the gaps in order. A board that can't reach 16, or ends with fewer
 * than `MIN_TIER1` words from its first tier, is dropped.
 */
function repairBoards(
  lex: Lexicon,
  builder: BoardBuilder,
  drawn: DrawnBoard[],
  exclude: CluesExcludeList,
): RepairStats {
  const excludeSets = new Map(Object.entries(exclude).map(([a, lemmas]) => [a, new Set(lemmas)]));
  const removed = new Rejections();
  const skipped = new Rejections();
  for (const b of drawn) {
    const ex = excludeSets.get(b.draft.anchor);
    const problem = (w: Candidate): string | null => {
      if (ex?.has(w.lemma)) return 'excluded for its anchor';
      const gloss = builder.glossProblem(w, b.draft.pos);
      if (gloss !== null) return gloss;
      if (builder.givesAway(w)) return GIVES_AWAY;
      return builder.blockedInDefinition(w) ? BLOCKED_GLOSS : null;
    };
    b.slots = b.slots.map((w) => {
      if (w === null) return null;
      const why = problem(w);
      if (why === null) return w;
      b.removed.push({ lemma: w.lemma, reason: why });
      removed.add(why);
      return null;
    });
  }

  const use = new Map<string, number>();
  for (const b of drawn) for (const w of liveWords(b)) bump(use, w.lemma);

  for (const b of drawn) {
    if (!b.slots.includes(null)) continue;
    const { pos, anchor, tiers, refillTiers, lexfile } = b.draft;
    const sp = SHORT_POS[pos];
    const ex = excludeSets.get(anchor);
    const others = drawn.filter((o) => o !== b && o.dropped === null);
    const siblings = new Set(
      others
        .filter((o) => o.draft.anchor === anchor)
        .flatMap((o) => liveWords(o).map((w) => w.lemma)),
    );
    /** Why `c` can't fill a gap next to `words`, or null. The near-synonym guard runs last. */
    const refillProblem = (c: Candidate, words: readonly Candidate[]): string | null => {
      if (words.some((d) => d.lemma === c.lemma)) return 'already on the board';
      if (ex?.has(c.lemma)) return 'excluded for its anchor';
      if (siblings.has(c.lemma)) return 'on another board of the anchor';
      const gloss = builder.glossProblem(c, pos);
      if (gloss !== null) return gloss;
      if (builder.givesAway(c)) return GIVES_AWAY;
      if (builder.blockedInDefinition(c)) return BLOCKED_GLOSS;
      for (const d of words) {
        const conflict = builder.conflict(c, d, sp);
        if (conflict !== null) return conflict;
      }
      if ((use.get(c.lemma) ?? 0) >= MAX_BOARDS_PER_LEMMA) return 'lemma on too many boards';
      const lemmas = new Set(words.map((w) => w.lemma));
      const overlaps = others.some((o) => {
        const theirs = liveWords(o).map((w) => w.lemma);
        return (
          theirs.includes(c.lemma) &&
          theirs.filter((l) => lemmas.has(l)).length + 1 > MAX_SHARED_LEMMAS
        );
      });
      if (overlaps) return 'too many lemmas shared with another board';
      if (words.some((d) => sensesTouch(lex, c.lemma, d.lemma))) return GUARD_SENSE;
      const shares = (d: Candidate) =>
        sharedContentWords(c.definition, d.definition) >= GUARD_SHARED_GLOSS_WORDS;
      return words.some(shares) ? GUARD_GLOSS : null;
    };
    for (const c of builder.ordered(refillTiers, lexfile).flat()) {
      const slot = b.slots.indexOf(null);
      if (slot < 0) break;
      const words = liveWords(b);
      const why = refillProblem(c, words);
      if (why !== null) {
        skipped.add(why);
        continue;
      }
      b.slots[slot] = c;
      b.added.push(c.lemma);
      bump(use, c.lemma);
    }
    const words = liveWords(b);
    const tier1 = new Set(tiers[0]);
    if (words.length < BOARD_SIZE) {
      b.dropped = `refilled to ${String(words.length)} of ${String(BOARD_SIZE)} words`;
    } else if (words.filter((w) => tier1.has(w.synset)).length < MIN_TIER1[sp]) {
      b.dropped = 'too few words from its first tier';
    }
    if (b.dropped !== null) for (const w of words) use.set(w.lemma, (use.get(w.lemma) ?? 1) - 1);
  }

  const drawnAnchors = new Set(drawn.map((b) => b.draft.anchor));
  return {
    removed: removed.sorted(),
    skipped: skipped.sorted(),
    refilled: drawn.reduce((n, b) => n + (b.dropped === null ? b.added.length : 0), 0),
    guard: {
      sharedSense: skipped.counts.get(GUARD_SENSE) ?? 0,
      sharedGlossWords: skipped.counts.get(GUARD_GLOSS) ?? 0,
    },
    dropped: drawn.flatMap((b) =>
      b.dropped === null
        ? []
        : [{ drawId: b.drawId, anchor: b.draft.anchor, pos: b.draft.pos, reason: b.dropped }],
    ),
    unusedExclusions: Object.keys(exclude)
      .filter((a) => !drawnAnchors.has(a))
      .sort(),
  };
}

/**
 * Build the boards in three steps.
 *
 * Draft: every anchor's greedy fill, as described at the top of this file.
 *
 * Draw: feasible drafts per part of speech are ranked by the mean commonness of their words; the
 * best `POOL_FACTOR × quota` are shuffled with the seed and taken in that order, skipping a
 * board that shares more than `MAX_SHARED_LEMMAS` lemmas with one already taken or uses a lemma
 * already on `MAX_BOARDS_PER_LEMMA` boards. Board order and word order are then shuffled with
 * the same PRNG.
 *
 * Repair (`repairBoards`): drop the words excluded for each anchor (`options.exclude`), those
 * whose gloss can't stand alone and those the full give-away and blocklist checks flag, and refill
 * from the same neighbourhood. The draw only sees the drafts, so adding exclusions or tightening
 * those checks never reshuffles the board set: unflagged words keep their boards and slots.
 *
 * Drop: leave out the repaired boards that `options.drop` names (by anchor and a word on the board,
 * or by anchor and draw id). This runs after repair, so a dropped board's words still count in
 * every other board's refill and no other board changes. Boards are numbered last, in draw order,
 * skipping dropped ones.
 */
export function buildBoards(data: OewnData, options: BuildOptions): BuildResult {
  const blocked = options.blockedWordHashes ?? new Set<string>();
  const lex = buildLexicon(data, blocked);
  const builder = new BoardBuilder(lex, options.minScore ?? DEFAULT_MIN_SCORE, blocked);
  const prng = createPrng(options.seed);

  const draftsByPos: Record<CluesPos, BoardDraft[]> = {
    noun: hyponymDrafts(lex, builder, 'noun'),
    verb: hyponymDrafts(lex, builder, 'verb'),
    adjective: adjectiveDrafts(lex, builder),
  };

  const lemmaUse = new Map<string, number>();
  const taken: BoardDraft[] = [];
  for (const pos of CLUES_POS) {
    const ranked = [...draftsByPos[pos]].sort(
      (a, b) => b.quality - a.quality || (a.anchor < b.anchor ? -1 : 1),
    );
    const pool = shuffle(ranked.slice(0, options.quota[pos] * POOL_FACTOR), prng);
    let count = 0;
    for (const draft of pool) {
      if (count === options.quota[pos]) break;
      const lemmas = new Set(draft.words.map((w) => w.lemma));
      if (draft.words.some((w) => (lemmaUse.get(w.lemma) ?? 0) >= MAX_BOARDS_PER_LEMMA)) continue;
      const overlaps = taken.some(
        (t) => t.words.filter((w) => lemmas.has(w.lemma)).length > MAX_SHARED_LEMMAS,
      );
      if (overlaps) continue;
      for (const l of lemmas) lemmaUse.set(l, (lemmaUse.get(l) ?? 0) + 1);
      taken.push(draft);
      count++;
    }
  }

  const drawn = shuffle([...taken], prng).map((draft, i): DrawnBoard => ({
    draft,
    drawId: boardId(i),
    slots: shuffle([...draft.words], prng),
    removed: [],
    added: [],
    dropped: null,
  }));
  const repair = repairBoards(lex, builder, drawn, options.exclude ?? {});

  const listed = new Map<DrawnBoard, CluesDropEntry>();
  const unmatched: string[] = [];
  for (const d of options.drop ?? []) {
    const names = (b: DrawnBoard): boolean =>
      b.draft.anchor === d.anchor &&
      (d.drawId === undefined
        ? liveWords(b).some((w) => w.lemma === d.lemma)
        : b.drawId === d.drawId);
    // A board the repair step dropped only counts when no repaired board matches.
    let hits = drawn.filter((b) => b.dropped === null && names(b));
    if (hits.length === 0) hits = drawn.filter(names);
    const [hit] = hits;
    if (hits.length !== 1 || hit === undefined) {
      const by = d.drawId === undefined ? `"${d.lemma}"` : `draw id ${d.drawId}`;
      unmatched.push(`anchor ${d.anchor} with ${by} names ${String(hits.length)} boards, not 1`);
    } else if (!listed.has(hit)) {
      listed.set(hit, d);
    }
  }
  if (unmatched.length > 0) throw new Error(`drop list:\n  ${unmatched.join('\n  ')}`);

  const boards: CluesBoard[] = [];
  const repairs: Record<string, BoardRepair> = {};
  const listDropped: BuildResult['listDropped'] = [];
  for (const b of drawn) {
    const entry = listed.get(b);
    if (entry !== undefined) {
      listDropped.push({
        drawId: b.drawId,
        anchor: b.draft.anchor,
        pos: b.draft.pos,
        lemma: entry.lemma,
        ...(b.dropped === null ? {} : { repairDropped: true as const }),
      });
    }
    if (b.dropped !== null || entry !== undefined) continue;
    const final = liveWords(b);
    const words = final.map((w, j): CluesWord => ({
      id: `w${String(j + 1).padStart(2, '0')}`,
      lemma: w.lemma,
      synset: w.synset,
      definition: w.definition,
    }));
    const board: CluesBoard = {
      id: boardId(boards.length),
      pos: b.draft.pos,
      anchor: b.draft.anchor,
      words,
    };
    const label = b.draft.label(final);
    if (label !== undefined) board.hypernym = label;
    repairs[board.id] = { drawId: b.drawId, removed: b.removed, added: b.added };
    boards.push(board);
  }

  return {
    boards,
    rejections: builder.rejections.sorted(),
    feasible: {
      noun: draftsByPos.noun.length,
      verb: draftsByPos.verb.length,
      adjective: draftsByPos.adjective.length,
    },
    repairs,
    repair,
    listDropped,
  };
}

// ---------------------------------------------------------------------------------------------
// Checks shared by the build and the tests
// ---------------------------------------------------------------------------------------------

/**
 * Problems with one board, as messages (empty if it's fine): word count, duplicate lemmas, a
 * definition that gives its own word away, one that names another word on the board, or an
 * originality term (`originality.ts`) as a word or in a definition.
 * `formsOf` gives extra (irregular) forms per lemma, if known; `context` is the give-away test's
 * dictionary and irregular forms (`definitionGivesAway`), if known.
 */
export function boardProblems(
  board: CluesBoard,
  formsOf: (lemma: string) => readonly string[] = () => [],
  context: GiveAwayContext = {},
): string[] {
  const problems: string[] = [];
  if (board.words.length !== BOARD_SIZE) {
    problems.push(`${board.id}: ${String(board.words.length)} words`);
  }
  if (new Set(board.words.map((w) => w.lemma)).size !== board.words.length) {
    problems.push(`${board.id}: duplicate lemmas`);
  }
  for (const w of board.words) {
    if (originalityTermIn(w.lemma) || originalityTermIn(w.definition)) {
      problems.push(`${board.id}/${w.id}: originality term`);
    }
    if (definitionGivesAway(w.definition, w.lemma, formsOf(w.lemma), context)) {
      problems.push(`${board.id}/${w.id}: definition gives away "${w.lemma}"`);
    }
    for (const other of board.words) {
      if (other !== w && mentionsWord(w.definition, other.lemma, formsOf(other.lemma))) {
        problems.push(`${board.id}/${w.id}: definition contains board word "${other.lemma}"`);
      }
    }
  }
  return problems;
}
