import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../../../src/core/util/hash.js';
import {
  BOARD_SIZE,
  CLUES_POS,
  blockedWordsIn,
  blocklistHash,
  boardProblems,
  glossProblem,
  mentionsWord,
  truncatedDefinition,
  type CluesBoardsFile,
  type CluesDropEntry,
  type CluesExcludeList,
  type CluesPos,
} from '../../../src/games/clues/data-build.js';
import { BLOCKED_WORD_HASHES } from '../../../src/games/clues/blocklist.js';
import { originalityTermIn } from '../../../src/games/clues/originality.js';

const file = JSON.parse(readFileSync('data/clues/boards.json', 'utf8')) as CluesBoardsFile;
const { boards } = file;
const exclude = JSON.parse(readFileSync('data/clues/exclude.json', 'utf8')) as CluesExcludeList;
const drop = JSON.parse(readFileSync('data/clues/drop.json', 'utf8')) as {
  reason: string;
  boards: CluesDropEntry[];
};

/**
 * The board set that passed the board review by AI reviewers (docs/research/game-data.md, "Clue
 * Clash board review"): 29 of the 32 boards round 4 passed, unchanged, after the code review of
 * the build dropped three for their glosses. A rebuild that changes it needs a new review.
 */
const REVIEWED_SHA256 = '4efe9f058ff9309ea2f86a439998a146e02f42186037b3acb980bf555c3fee5f';
const REVIEWED_COUNTS = { boards: 29, byPos: { noun: 29, verb: 0, adjective: 0 } };

/** Synset id suffixes per board part of speech (`s` is a satellite adjective). */
const SUFFIXES: Record<CluesPos, readonly string[]> = {
  noun: ['n'],
  verb: ['v'],
  adjective: ['a', 's'],
};

describe('data/clues/boards.json', () => {
  it('matches its recorded sha256, the reviewed board set', () => {
    const sha = createHash('sha256').update(canonicalJson(boards)).digest('hex');
    expect(sha).toBe(file.build.sha256);
    expect(sha).toBe(REVIEWED_SHA256);
  });

  it('names its source: the Open English Wordnet 2025 core edition under CC BY 4.0', () => {
    expect(file.source.title).toBe('Open English Wordnet');
    expect(file.source.edition).toBe('core 2025');
    expect(file.source.license).toContain('CC BY 4.0');
  });

  it('has the 29 reviewed boards, all nouns, with counts that match the build record', () => {
    expect(file.build.counts).toEqual(REVIEWED_COUNTS);
    expect(file.build.counts.boards).toBe(boards.length);
    for (const pos of CLUES_POS) {
      const n = boards.filter((b) => b.pos === pos).length;
      expect(file.build.counts.byPos[pos], pos).toBe(n);
    }
    expect(file.build.counts.byPos.noun).toBe(boards.length);
  });

  it('has sequential board ids and word ids', () => {
    boards.forEach((b, i) => {
      expect(b.id).toBe(`b${String(i + 1).padStart(3, '0')}`);
      b.words.forEach((w, j) => {
        expect(w.id).toBe(`w${String(j + 1).padStart(2, '0')}`);
      });
    });
  });

  it('records each board anchor: a synset id of the board part of speech', () => {
    for (const b of boards) {
      expect(b.anchor, b.id).toMatch(/^\d{8}-[nva]$/);
      expect(SUFFIXES[b.pos], b.id).toContain(b.anchor?.slice(-1));
    }
  });

  it('gives every board 16 words of one part of speech', () => {
    for (const b of boards) {
      expect(b.words, b.id).toHaveLength(BOARD_SIZE);
      for (const w of b.words) {
        expect(SUFFIXES[b.pos], `${b.id}/${w.id}`).toContain(w.synset.slice(-1));
      }
    }
  });

  it('uses single lower-case words, each once per board, each with its own synset', () => {
    for (const b of boards) {
      expect(new Set(b.words.map((w) => w.lemma)).size, b.id).toBe(BOARD_SIZE);
      expect(new Set(b.words.map((w) => w.synset)).size, b.id).toBe(BOARD_SIZE);
      expect(new Set(b.words.map((w) => w.definition)).size, b.id).toBe(BOARD_SIZE);
      for (const w of b.words) expect(w.lemma).toMatch(/^[a-z]{3,12}$/);
    }
  });

  it('never shows a definition that gives its word away: the word, its stem or a form of it', () => {
    // OEWN isn't committed, so the board words stand in for its dictionary: compound parts that
    // are board words count (a subset of what the build checks), and the hand list of irregular
    // forms is always on.
    const lemmas = new Set(boards.flatMap((b) => b.words.map((w) => w.lemma)));
    const context = { isWord: (w: string) => lemmas.has(w) };
    const problems = boards.flatMap((b) => boardProblems(b, () => [], context));
    expect(problems.filter((p) => p.includes('gives away'))).toEqual([]);
  });

  it('never shows a definition that contains another word on the same board', () => {
    const hits: string[] = [];
    for (const b of boards) {
      for (const w of b.words) {
        for (const other of b.words) {
          if (other !== w && mentionsWord(w.definition, other.lemma)) {
            hits.push(`${b.id}/${w.id} names ${other.lemma}`);
          }
        }
      }
    }
    expect(hits).toEqual([]);
  });

  it('puts no blocklisted word on a board or in a definition, in any inflected form', () => {
    const blocked = (word: string) => BLOCKED_WORD_HASHES.has(blocklistHash(word));
    // OEWN isn't committed, so the board words stand in for its dictionary, plus "spice": the
    // glosses say "spices" and "spiced", and -es or -ed alone would leave a blocked word. The hand
    // list of irregular forms is always on.
    const lemmas = new Set([...boards.flatMap((b) => b.words.map((w) => w.lemma)), 'spice']);
    const context = { isWord: (w: string) => lemmas.has(w) };
    const hits = boards.flatMap((b) =>
      b.words
        .filter(
          (w) => blocked(w.lemma) || blockedWordsIn(w.definition, blocked, context).length > 0,
        )
        .map((w) => `${b.id}/${w.id}`),
    );
    expect(hits).toEqual([]);
  });

  it('has no originality term (test/originality.test.ts) as a board word or in a definition', () => {
    const hits = boards.flatMap((b) =>
      b.words
        .filter((w) => originalityTermIn(w.lemma) || originalityTermIn(w.definition))
        .map((w) => `${b.id}/${w.id}`),
    );
    expect(hits).toEqual([]);
    const problems = boards.flatMap((b) => boardProblems(b));
    expect(problems.filter((p) => p.includes('originality'))).toEqual([]);
  });

  it('keeps every lemma in data/clues/exclude.json off the boards of its anchor', () => {
    const anchors = Object.keys(exclude);
    expect(anchors.length).toBeGreaterThan(0);
    for (const anchor of anchors) {
      expect(anchor).toMatch(/^\d{8}-[nva]$/);
      for (const lemma of exclude[anchor] ?? []) expect(lemma).toMatch(/^[a-z]+$/);
    }
    const hits = boards.flatMap((b) =>
      b.words
        .filter((w) => b.anchor !== undefined && exclude[b.anchor]?.includes(w.lemma) === true)
        .map((w) => `${b.id}/${w.id} ${w.lemma}`),
    );
    expect(hits).toEqual([]);
    // The list is in use: most boards had words excluded for their anchor.
    const repaired = boards.filter((b) => b.anchor !== undefined && b.anchor in exclude);
    expect(repaired.length).toBeGreaterThan(boards.length / 2);
  });

  it('leaves out every board in data/clues/drop.json', () => {
    expect(drop.reason).toMatch(/review/);
    expect(drop.boards).toHaveLength(94);
    const keys = drop.boards.map((d) => `${d.anchor} ${d.lemma}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const d of drop.boards) {
      expect(d.anchor).toMatch(/^\d{8}-[nva]$/);
      expect(d.lemma).toMatch(/^[a-z]+$/);
      if (d.drawId !== undefined) expect(d.drawId).toMatch(/^b\d{3}$/);
    }
    // Three boards lost their listed word to the give-away test, and one to the blocklist's
    // inflected forms, so they are named by draw id too.
    expect(drop.boards.filter((d) => d.drawId !== undefined)).toEqual([
      { anchor: '01527000-n', lemma: 'catbird', drawId: 'b077' },
      { anchor: '01941146-a', lemma: 'illusive', drawId: 'b093' },
      { anchor: '04538393-n', lemma: 'tun', drawId: 'b015' },
      { anchor: '10602198-n', lemma: 'noncombatant', drawId: 'b159' },
    ]);
    const hits = drop.boards.flatMap((d) =>
      boards
        .filter((b) => b.anchor === d.anchor && b.words.some((w) => w.lemma === d.lemma))
        .map((b) => `${b.id} ${d.anchor} ${d.lemma}`),
    );
    expect(hits).toEqual([]);
    // No dropped anchor is left, except six with another board that passed the review.
    const dropped = new Set(drop.boards.map((d) => d.anchor));
    const kept = [...new Set(boards.map((b) => b.anchor))]
      .filter((a): a is string => a !== undefined && dropped.has(a))
      .sort();
    expect(kept).toEqual([
      '02916498-n',
      '03099154-n',
      '07572999-n',
      '07825344-n',
      '13124818-n',
      '13133423-n',
    ]);
  });

  it('shows only glosses that stand alone: no usage or register note, fragment or short gloss', () => {
    const hits = boards.flatMap((b) =>
      b.words
        .map((w) => [w, glossProblem(w.definition, b.pos)] as const)
        .filter(([, problem]) => problem !== null)
        .map(([w, problem]) => `${b.id}/${w.id} ${w.lemma}: ${String(problem)}`),
    );
    expect(hits).toEqual([]);
  });

  it('has no definition cut off at an example marker ("of metal e.g.")', () => {
    const hits = boards.flatMap((b) =>
      b.words.filter((w) => truncatedDefinition(w.definition)).map((w) => `${b.id}/${w.id}`),
    );
    expect(hits).toEqual([]);
  });
});
