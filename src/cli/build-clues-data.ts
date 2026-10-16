import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { canonicalJson } from '../core/util/hash.js';
import { createPrng, nextBelow } from '../core/util/prng.js';
import {
  CLUES_POS,
  buildBoards,
  type CluesBoard,
  type CluesBoardsFile,
  type CluesDropEntry,
  type CluesExcludeList,
  type CluesPos,
  type OewnData,
  type OewnEntry,
  type OewnSynset,
} from '../games/clues/data-build.js';
import { BLOCKED_WORD_HASHES } from '../games/clues/blocklist.js';

/**
 * Build `data/clues/boards.json` from Open English Wordnet 2025 (core edition, JSON release).
 *
 *   unzip english-wordnet-2025-json.zip -d <dir>
 *   pnpm data:clues --src <dir> [--seed 20261007] [--out data/clues/boards.json]
 *                   [--exclude data/clues/exclude.json] [--drop data/clues/drop.json]
 *                   [--review <sample-boards.md>]
 *
 * Only reads JSON from <dir>; nothing in it is executed. `--exclude` is the board review's list
 * of lemmas to keep off each anchor's boards (anchor synset id -> lemmas). `--drop` is the board
 * review's list of boards to leave out, `{ reason, boards: [{ anchor, lemma, drawId? }] }`,
 * each board named by its anchor and one word on it, or by its draw id once a rebuild took that
 * word off. `--review` writes 10 seeded random boards as Markdown for a reviewer to read. The board
 * review was done by AI reviewers (Claude), one board at a time (docs/research/game-data.md).
 */

const DEFAULT_SEED = 20261007;
const DEFAULT_OUT = 'data/clues/boards.json';
const DEFAULT_EXCLUDE = 'data/clues/exclude.json';
const DEFAULT_DROP = 'data/clues/drop.json';
/** The core edition has exactly this many synsets; 2025 Plus has 120,564. */
const CORE_SYNSETS = 107519;
/** Upper limits per part of speech. Nouns stop where the filters run out (about 110 boards). */
const QUOTA: Record<CluesPos, number> = { noun: 120, verb: 25, adjective: 55 };
const REVIEW_BOARDS = 10;

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function loadOewn(dir: string): OewnData {
  if (!statSync(dir).isDirectory()) throw new Error(`--src must be a directory: ${dir}`);
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort();
  const synsets: Record<string, OewnSynset> = {};
  const entries: Record<string, OewnEntry> = {};
  for (const file of files) {
    if (file === 'frames.json') continue;
    if (file.startsWith('entries-')) {
      Object.assign(entries, readJson(join(dir, file)) as Record<string, OewnEntry>);
    } else if (/^(noun|verb|adj|adv)\./.test(file)) {
      const lexfile = file.slice(0, -'.json'.length);
      const json = readJson(join(dir, file)) as Record<string, OewnSynset>;
      for (const [id, synset] of Object.entries(json)) synsets[id] = { ...synset, lexfile };
    }
  }
  const count = Object.keys(synsets).length;
  if (count !== CORE_SYNSETS) {
    throw new Error(
      `expected the OEWN 2025 core edition (${String(CORE_SYNSETS)} synsets), found ${String(count)}`,
    );
  }
  return { synsets, entries };
}

/** Reads and checks the exclude list: synset id -> distinct lower-case single-word lemmas. */
function loadExclude(path: string): CluesExcludeList {
  const json = readJson(path);
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    throw new Error(`${path}: expected an object of anchor synset id -> lemmas`);
  }
  const out: Record<string, string[]> = {};
  for (const [anchor, lemmas] of Object.entries(json as Record<string, unknown>)) {
    if (!/^\d{8}-[nvas]$/.test(anchor)) throw new Error(`${path}: bad anchor id ${anchor}`);
    if (
      !Array.isArray(lemmas) ||
      !lemmas.every((l): l is string => typeof l === 'string' && /^[a-z]+$/.test(l)) ||
      new Set(lemmas).size !== lemmas.length
    ) {
      throw new Error(`${path}: ${anchor} needs a list of distinct a-z lemmas`);
    }
    out[anchor] = lemmas;
  }
  return out;
}

/**
 * Reads and checks the drop list: a reason and distinct (anchor, lemma) pairs, one per board, with
 * the board's draw id where the lemma no longer names it.
 */
function loadDrop(path: string): { reason: string; boards: CluesDropEntry[] } {
  const json = readJson(path) as { reason?: unknown; boards?: unknown } | null;
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    throw new Error(`${path}: expected { reason, boards: [{ anchor, lemma }] }`);
  }
  const { reason, boards } = json;
  if (typeof reason !== 'string' || reason === '') throw new Error(`${path}: needs a reason`);
  if (!Array.isArray(boards)) throw new Error(`${path}: boards must be a list`);
  const seen = new Set<string>();
  const out: CluesDropEntry[] = [];
  for (const entry of boards as unknown[]) {
    const { anchor, lemma, drawId } = (entry ?? {}) as {
      anchor?: unknown;
      lemma?: unknown;
      drawId?: unknown;
    };
    if (typeof anchor !== 'string' || !/^\d{8}-[nvas]$/.test(anchor)) {
      throw new Error(`${path}: bad anchor id in ${JSON.stringify(entry)}`);
    }
    if (typeof lemma !== 'string' || !/^[a-z]+$/.test(lemma)) {
      throw new Error(`${path}: bad lemma in ${JSON.stringify(entry)}`);
    }
    if (drawId !== undefined && (typeof drawId !== 'string' || !/^b\d{3}$/.test(drawId))) {
      throw new Error(`${path}: bad drawId in ${JSON.stringify(entry)}`);
    }
    const key = `${anchor} ${lemma}`;
    if (seen.has(key)) throw new Error(`${path}: ${key} is listed twice`);
    seen.add(key);
    out.push(drawId === undefined ? { anchor, lemma } : { anchor, lemma, drawId });
  }
  return { reason, boards: out };
}

/** One word per line keeps the file small and diffs readable. */
function formatFile(file: CluesBoardsFile): string {
  const boards = file.boards.map((b) => {
    const head = {
      id: b.id,
      pos: b.pos,
      ...(b.anchor === undefined ? {} : { anchor: b.anchor }),
      ...(b.hypernym === undefined ? {} : { hypernym: b.hypernym }),
    };
    const words = b.words.map((w) => `      ${JSON.stringify(w)}`).join(',\n');
    return `    ${JSON.stringify(head).slice(0, -1)},"words":[\n${words}\n    ]}`;
  });
  return (
    '{\n' +
    `  "source": ${JSON.stringify(file.source)},\n` +
    `  "build": ${JSON.stringify(file.build)},\n` +
    `  "boards": [\n${boards.join(',\n')}\n  ]\n}\n`
  );
}

function reviewMarkdown(boards: readonly CluesBoard[], seed: number): string {
  const prng = createPrng(seed ^ 0x5eed);
  const picked = new Set<number>();
  while (picked.size < Math.min(REVIEW_BOARDS, boards.length)) {
    picked.add(nextBelow(prng, boards.length));
  }
  const lines = [
    '# Clue Clash: sample boards',
    '',
    `${String(picked.size)} boards picked at random from \`data/clues/boards.json\` (seed ${String(seed)}).`,
    '',
  ];
  for (const i of [...picked].sort((a, b) => a - b)) {
    const b = boards[i];
    if (b === undefined) continue;
    lines.push(
      `## ${b.id} (${b.pos}${b.hypernym ? `, under "${b.hypernym}"` : ''}, anchor ${b.anchor ?? '?'})`,
      '',
    );
    lines.push(`Words: ${b.words.map((w) => w.lemma).join(', ')}`, '');
    lines.push('| Word | Definition |', '|---|---|');
    for (const w of b.words) lines.push(`| ${w.lemma} | ${w.definition.replace(/\|/g, '\\|')} |`);
    lines.push('');
  }
  return lines.join('\n');
}

function main(): void {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((a) => a !== '--'),
    options: {
      src: { type: 'string' },
      seed: { type: 'string' },
      out: { type: 'string' },
      exclude: { type: 'string' },
      drop: { type: 'string' },
      review: { type: 'string' },
    },
  });
  if (values.src === undefined) {
    throw new Error(
      'usage: pnpm data:clues --src <extracted OEWN JSON dir> [--seed n] [--out path] ' +
        '[--exclude path] [--drop path] [--review path]',
    );
  }
  const seed = values.seed === undefined ? DEFAULT_SEED : Number(values.seed);
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff)
    throw new Error(`bad --seed: ${String(values.seed)}`);
  const out = values.out ?? DEFAULT_OUT;

  const exclude = loadExclude(values.exclude ?? DEFAULT_EXCLUDE);
  const drop = loadDrop(values.drop ?? DEFAULT_DROP);
  const data = loadOewn(values.src);
  const result = buildBoards(data, {
    seed,
    quota: QUOTA,
    blockedWordHashes: BLOCKED_WORD_HASHES,
    exclude,
    drop: drop.boards,
  });
  const byPos = Object.fromEntries(CLUES_POS.map((p) => [p, 0])) as Record<CluesPos, number>;
  for (const b of result.boards) byPos[b.pos]++;
  const sha256 = createHash('sha256').update(canonicalJson(result.boards)).digest('hex');
  const file: CluesBoardsFile = {
    source: {
      title: 'Open English Wordnet',
      url: 'https://en-word.net',
      edition: 'core 2025',
      license: 'CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/); see data/NOTICE.md',
    },
    build: { seed, counts: { boards: result.boards.length, byPos }, sha256 },
    boards: result.boards,
  };
  mkdirSync(dirname(out), { recursive: true });
  const text = formatFile(file);
  writeFileSync(out, text);
  console.log(
    `${out}: ${String(result.boards.length)} boards ${JSON.stringify(byPos)}, ${String(Math.round(text.length / 1024))} KB`,
  );
  console.log(`feasible before sampling: ${JSON.stringify(result.feasible)}`);
  console.log('rejections:');
  for (const [reason, n] of result.rejections) console.log(`  ${String(n).padStart(8)}  ${reason}`);
  const { repair } = result;
  console.log('repair: words taken off drawn boards:');
  for (const [reason, n] of repair.removed) console.log(`  ${String(n).padStart(8)}  ${reason}`);
  console.log('repair: refill candidates passed over:');
  for (const [reason, n] of repair.skipped) console.log(`  ${String(n).padStart(8)}  ${reason}`);
  console.log(
    `repair: ${String(repair.refilled)} words refilled; the near-synonym guard skipped ` +
      `${String(repair.guard.sharedSense)} candidates for a shared or similar sense and ` +
      `${String(repair.guard.sharedGlossWords)} for shared gloss words`,
  );
  console.log(`repair: ${String(repair.dropped.length)} drawn boards dropped`);
  for (const d of repair.dropped) {
    console.log(`  ${d.drawId} ${d.pos} anchor ${d.anchor}: ${d.reason}`);
  }
  if (repair.unusedExclusions.length > 0) {
    console.log(`exclude list anchors with no drawn board: ${repair.unusedExclusions.join(', ')}`);
  }
  const repairDropped = result.listDropped.filter((d) => d.repairDropped === true).length;
  console.log(
    `drop list: ${String(result.listDropped.length - repairDropped)} boards left out, and ` +
      `${String(repairDropped)} more the repair step had already dropped (${drop.reason})`,
  );
  for (const d of result.listDropped) {
    const note = d.repairDropped === true ? ', also dropped by the repair step' : '';
    console.log(`  ${d.drawId} ${d.pos} anchor ${d.anchor} ("${d.lemma}"${note})`);
  }
  if (values.review !== undefined) {
    mkdirSync(dirname(values.review), { recursive: true });
    writeFileSync(values.review, reviewMarkdown(result.boards, seed));
    console.log(`review sample: ${values.review}`);
  }
}

try {
  main();
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
