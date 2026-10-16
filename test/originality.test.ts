import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fnv1a64, utf8Bytes } from '../src/core/util/hash.js';
import { boardProblems, type CluesBoard } from '../src/games/clues/data-build.js';
import { ORIGINALITY_TERM_HASHES, originalityTermIn } from '../src/games/clues/originality.js';

/**
 * The originality rule (docs/architecture/clues.md, "Originality"): Clue Clash is an original
 * reverse-dictionary duel and must not borrow from Codenames. Neither that name nor its terms may
 * appear anywhere in the repo's code, docs, data or art, and the build fails if they do.
 *
 * The same scan enforces RULES.md's "no Capcom anything" for the fighter: the publisher, its
 * fighting-game series and its best-known names, outside the few citations allowed below.
 *
 * This file is the one place that spells the terms out, so it is the only file exempt. The board
 * build filters the same terms from board words and definitions by hash
 * (src/games/clues/originality.ts); the last tests here check those hashes against the plain list.
 */

/**
 * Banned everywhere: the game's name and its distinctive terms, in any case. Code and data files
 * (`CODE_FILE`) are matched on substrings, so identifiers like `isAssassin` or `codeNameFor` are
 * caught; other files (docs, config) on whole words. "code name" may be spelled closed, open,
 * hyphenated or with an underscore.
 */
const REPO_WORDS = /\b(code[\s_-]?names?|spymasters?|assassins?)\b/gi;
const REPO_SUBSTRINGS = /code[\s_-]?name|spymaster|assassin/gi;

/**
 * "agent" is ordinary English, so it is only banned in the clue game's files (any path with a
 * "clue" or "clues" segment) and in docs (Markdown) that mention Clue Clash: as a substring in
 * code and data (`agentTile`), as a whole word elsewhere.
 */
const AGENT_WORDS = /\bagents?\b/gi;
const AGENT_SUBSTRING = /agent/gi;
const CLUE_PATH = /\bclues?\b/i;
const CLUE_DOC = /clue clash/i;

const CODE_FILE = /\.(ts|js|mjs|json|jsonl|html|css)$/;

/** Names that contain a term but aren't one: the spam filter the inbox research cites. */
const EXEMPT_NAMES = /spamassassin/gi;

/** Files that state the rule itself. */
const ALLOWLIST = new Set(['test/originality.test.ts']);

/**
 * Banned everywhere: another studio's names (RULES.md: no Capcom anything), in any case, as whole
 * words in every file. "Street Fighter" and "Chun-Li" may be spelled closed, open, hyphenated or
 * with an underscore.
 */
const STUDIO_WORDS = /\b(capcom|street[\s_-]?fighter|hadouken|shoryuken|chun[\s_-]?li)\b/gi;

/**
 * The only places one of those names may appear, each for one name: RULES.md states the rule, and
 * the prior-art section of the API research cites projects built on the series (llm-colosseum
 * plays Street Fighter III). `section` limits an entry to the lines under that Markdown heading.
 */
const STUDIO_CITATIONS: readonly { path: string; section?: string; name: RegExp }[] = [
  { path: 'RULES.md', name: /^capcom$/i },
  { path: 'docs/research/decision-apis.md', section: 'Prior art', name: /^street fighter$/i },
];

/** Every hit in one file's text, as `path:line: term`. */
function scanText(path: string, text: string): string[] {
  const code = CODE_FILE.test(path);
  const markdown = path.endsWith('.md');
  const clue = CLUE_PATH.test(path) || (markdown && CLUE_DOC.test(text));
  const patterns = [code ? REPO_SUBSTRINGS : REPO_WORDS];
  if (clue) patterns.push(code ? AGENT_SUBSTRING : AGENT_WORDS);
  const citations = STUDIO_CITATIONS.filter((c) => c.path === path);
  const hits: string[] = [];
  let section = '';
  text.split('\n').forEach((line, i) => {
    const heading = markdown ? /^#{1,6}\s+(.*?)\s*$/.exec(line) : null;
    if (heading) section = heading[1] ?? '';
    const kept = line.replace(EXEMPT_NAMES, '');
    for (const re of patterns) {
      for (const m of kept.matchAll(re)) hits.push(`${path}:${String(i + 1)}: ${m[0]}`);
    }
    for (const m of line.matchAll(STUDIO_WORDS)) {
      const cited = citations.some(
        (c) => (c.section === undefined || c.section === section) && c.name.test(m[0]),
      );
      if (!cited) hits.push(`${path}:${String(i + 1)}: ${m[0]}`);
    }
  });
  return hits;
}

/**
 * Tracked files plus untracked ones git doesn't ignore (so a new file is checked before its
 * first commit). Deleted-but-tracked files are skipped, and so are symlinks: git stores only the
 * link, and a target in the repo (RULES.md for CLAUDE.md and AGENTS.md) is scanned at its own path.
 */
function repoFiles(): string[] {
  const out = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  return [...new Set(out.split('\0').filter((p) => p !== ''))].sort();
}

/** Git's own test: a NUL byte in the first 8,000 bytes means binary. */
function isBinary(bytes: Buffer): boolean {
  return bytes.subarray(0, 8000).includes(0);
}

describe('originality check', () => {
  it('finds no banned term in any tracked text file outside the allowlist', () => {
    const hits: string[] = [];
    let scanned = 0;
    for (const path of repoFiles()) {
      if (ALLOWLIST.has(path)) continue;
      if (!existsSync(path) || !lstatSync(path).isFile()) continue;
      const bytes = readFileSync(path);
      if (isBinary(bytes)) continue;
      scanned++;
      hits.push(...scanText(path, bytes.toString('utf8')));
    }
    expect(scanned).toBeGreaterThan(100);
    expect(hits).toEqual([]);
  });

  it('really scans the board data and the clue game sources', () => {
    const files = repoFiles();
    expect(files).toContain('data/clues/boards.json');
    expect(files).toContain('src/games/clues/game.ts');
    expect(files).toContain('test/originality.test.ts');
  });

  it('matches the terms in any case, as whole words in docs, with file and line', () => {
    expect(scanText('docs/x.md', 'fine\nA CodeNames clone\nthe Spymaster and an assassin')).toEqual(
      ['docs/x.md:2: CodeNames', 'docs/x.md:3: Spymaster', 'docs/x.md:3: assassin'],
    );
    expect(scanText('README.md', 'code names; a codename; assassins')).toEqual([
      'README.md:1: code names',
      'README.md:1: codename',
      'README.md:1: assassins',
    ]);
    expect(scanText('README.md', 'assassination, codenamed, spymastering')).toEqual([]);
  });

  it('catches the open, hyphenated and underscored spellings of "code name"', () => {
    expect(scanText('docs/x.md', 'a code-name; Code Name; code_names')).toEqual([
      'docs/x.md:1: code-name',
      'docs/x.md:1: Code Name',
      'docs/x.md:1: code_names',
    ]);
    expect(scanText('src/core/x.ts', 'const codeNameFor = 1; // code-names')).toEqual([
      'src/core/x.ts:1: codeName',
      'src/core/x.ts:1: code-name',
    ]);
  });

  it('matches substrings in code and data files, so identifiers are caught', () => {
    expect(scanText('src/web/x.ts', 'function isAssassin() {}')).toEqual([
      'src/web/x.ts:1: Assassin',
    ]);
    expect(scanText('src/core/x.css', '.spymasterBox {}')).toEqual(['src/core/x.css:1: spymaster']);
    expect(scanText('data/x.json', '"assassination"')).toEqual(['data/x.json:1: assassin']);
    expect(scanText('docs/x.md', 'isAssassin')).toEqual([]);
  });

  it('exempts the name SpamAssassin, in any case, and nothing else on the line', () => {
    expect(scanText('docs/x.md', 'the SpamAssassin corpus')).toEqual([]);
    expect(scanText('src/x.ts', "const url = 'https://spamassassin.apache.org';")).toEqual([]);
    expect(scanText('src/x.ts', 'SpamAssassin, then an assassin')).toEqual([
      'src/x.ts:1: assassin',
    ]);
  });

  it('bans "agent" only in clue game files and docs that mention Clue Clash', () => {
    expect(scanText('src/games/clues/x.ts', 'const agentTile = an Agent')).toEqual([
      'src/games/clues/x.ts:1: agent',
      'src/games/clues/x.ts:1: Agent',
    ]);
    expect(scanText('src/cli/build-clues-data.ts', 'isAgent')).toEqual([
      'src/cli/build-clues-data.ts:1: Agent',
    ]);
    expect(scanText('data/clues/boards.json', '"a secret agent"')).toEqual([
      'data/clues/boards.json:1: agent',
    ]);
    // Code is matched on substrings, so even "reagent" counts there.
    expect(scanText('test/games/clues/a.test.ts', 'reagent agency')).toEqual([
      'test/games/clues/a.test.ts:1: agent',
    ]);
    expect(
      scanText('docs/research/game-data.md', 'Clue Clash\nan agent; reagent, agentic'),
    ).toEqual(['docs/research/game-data.md:2: agent']);
    expect(scanText('src/core/x.ts', 'a user agent, agentTile')).toEqual([]);
    expect(scanText('docs/research/decision-apis.md', 'agentic agents')).toEqual([]);
    expect(scanText('RULES.md', 'Agent instructions go in a RULES.md')).toEqual([]);
  });

  it("bans another studio's names in any case, as whole words, in every file", () => {
    expect(scanText('test/x.test.ts', "body.choice = 'hadouken';")).toEqual([
      'test/x.test.ts:1: hadouken',
    ]);
    expect(scanText('docs/x.md', 'fine\na Street Fighter-style fight\nCAPCOM, Shoryuken')).toEqual([
      'docs/x.md:2: Street Fighter',
      'docs/x.md:3: CAPCOM',
      'docs/x.md:3: Shoryuken',
    ]);
    expect(scanText('src/x.ts', 'streetFighter, street_fighter; Chun-Li, chun li')).toEqual([
      'src/x.ts:1: streetFighter',
      'src/x.ts:1: street_fighter',
      'src/x.ts:1: Chun-Li',
      'src/x.ts:1: chun li',
    ]);
    expect(scanText('docs/x.md', 'a street-fighting game; a fighter on the street')).toEqual([]);
  });

  it('allows a studio name only in its cited place, and only that name', () => {
    expect(scanText('RULES.md', '- no Capcom anything')).toEqual([]);
    expect(scanText('RULES.md', 'no Capcom, no hadouken')).toEqual(['RULES.md:1: hadouken']);
    const research = 'docs/research/decision-apis.md';
    expect(
      scanText(
        research,
        '## Prior art\n\n- LLMs fight in Street Fighter III\n- a "Street Fighter-style roster"',
      ),
    ).toEqual([]);
    expect(scanText(research, '## Prior art\nCapcom; a hadouken')).toEqual([
      `${research}:2: Capcom`,
      `${research}:2: hadouken`,
    ]);
    expect(scanText(research, '## Prior art\nStreet Fighter\n## Sources\nStreet Fighter')).toEqual([
      `${research}:4: Street Fighter`,
    ]);
    expect(scanText('README.md', 'llm-colosseum plays Street Fighter III')).toEqual([
      'README.md:1: Street Fighter',
    ]);
  });
});

describe('board build term filter (src/games/clues/originality.ts)', () => {
  /** The terms no board word or definition may contain. */
  const BUILD_TERMS = [
    'agent',
    'agents',
    'assassin',
    'assassins',
    'codename',
    'codenames',
    'spymaster',
    'spymasters',
  ];

  it('holds exactly the hashes of the plain term list', () => {
    const hashes = new Set(BUILD_TERMS.map((t) => fnv1a64(utf8Bytes(t))));
    expect(new Set(ORIGINALITY_TERM_HASHES)).toEqual(hashes);
  });

  it('flags a text that contains a term as a whole word, in any case', () => {
    for (const term of BUILD_TERMS) {
      expect(originalityTermIn(`one ${term} here`), term).toBe(true);
      expect(originalityTermIn(`ONE ${term.toUpperCase()}.`), term).toBe(true);
    }
    expect(originalityTermIn('a double-agent')).toBe(true);
    expect(originalityTermIn("the agent's car")).toBe(true);
  });

  it('lets other words through', () => {
    expect(originalityTermIn('a reagent used by a travel agency')).toBe(false);
    expect(originalityTermIn('an assassination; a codenamed plan')).toBe(false);
    expect(originalityTermIn('')).toBe(false);
  });

  it('makes boardProblems report a term as a board word or in a definition', () => {
    const words =
      'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike oscar papa quebec'.split(
        ' ',
      );
    const board: CluesBoard = {
      id: 'b999',
      pos: 'noun',
      words: words.map((lemma, i) => ({
        id: `w${String(i + 1).padStart(2, '0')}`,
        lemma,
        synset: `0000000${String(i)}-n`,
        definition: `definition number ${String(i)}`,
      })),
    };
    expect(boardProblems(board)).toEqual([]);
    const [w1, w2] = board.words;
    if (!w1 || !w2) throw new Error('unreachable');
    w1.lemma = 'spymaster';
    w2.definition = 'a secret agent';
    expect(boardProblems(board)).toEqual([
      'b999/w01: originality term',
      'b999/w02: originality term',
    ]);
  });
});
