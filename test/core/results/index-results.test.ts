import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_OUT, indexResults, readFeatured } from '../../../src/cli/index-results.js';
import { createMatchLog } from '../../../src/core/log/writer.js';
import type { ResultsIndex } from '../../../src/core/replay/results-index.js';
import {
  EXCLUDED_FILE,
  FEATURED_FILE,
  INDEX_FILE,
  matchFile,
  matchIdFor,
} from '../../../src/core/results/paths.js';
import { realtimeLines, turnLines } from '../log/fixtures.js';

/** The index CLI, run against a temp results tree. It writes results/index.json by default. */

const id = (game: string, run: number): string =>
  matchIdFor({ game, a: 'random', b: 'fake_provider', when: '2026-10-07T12:00:00Z', run });

const RT = id('counter_realtime', 1);
const RT2 = id('counter_realtime', 2);
const TN = id('counter_turns', 1);

let root = '';

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'arena-results-'));
  await realtimeLines({
    seed: 1,
    matchId: RT,
    sink: createMatchLog(join(root, matchFile('counter_realtime', RT))),
  });
  await realtimeLines({
    seed: 2,
    matchId: RT2,
    sink: createMatchLog(join(root, matchFile('counter_realtime', RT2))),
  });
  await turnLines({
    seed: 3,
    matchId: TN,
    sink: createMatchLog(join(root, matchFile('counter_turns', TN))),
  });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const readIndex = (path = DEFAULT_OUT): ResultsIndex =>
  JSON.parse(readFileSync(join(root, path), 'utf8')) as ResultsIndex;

const featuredIds = (): string[] =>
  readIndex()
    .matches.filter((m) => m.featured)
    .map((m) => m.id);

const writeFeatured = (featured: Record<string, string>): void => {
  writeFileSync(join(root, FEATURED_FILE), JSON.stringify(featured));
};

describe('index-results (v2)', () => {
  it('indexes results/*/matches/*.jsonl into results/index.json', () => {
    expect(DEFAULT_OUT).toBe(INDEX_FILE);
    expect(DEFAULT_OUT).toBe('results/index.json');
    const summary = indexResults({ root });
    const idx = readIndex();
    expect(idx.schemaVersion).toBe(2);
    expect(idx.matches.map((m) => [m.game, m.id])).toEqual([
      ['counter_realtime', RT],
      ['counter_realtime', RT2],
      ['counter_turns', TN],
    ]);
    expect(idx.matches.every((m) => !m.featured)).toBe(true);
    expect(summary).toMatchObject({ matches: 3, skipped: 0, featured: [] });
    expect(readFileSync(join(root, DEFAULT_OUT), 'utf8')).toBe(JSON.stringify(idx, null, 2) + '\n');
    expect(summary.path).toBe(join(root, DEFAULT_OUT));
  });

  it('writes to --out instead, and leaves the default index alone', () => {
    const out = 'results/other-index.json';
    writeFileSync(join(root, DEFAULT_OUT), '{"untouched":true}\n');
    const summary = indexResults({ root, out });
    expect(summary.path).toBe(join(root, out));
    expect(readIndex(out).matches).toHaveLength(3);
    expect(readFileSync(join(root, DEFAULT_OUT), 'utf8')).toBe('{"untouched":true}\n');
  });

  it('ignores folders without matches/ (states/, the legacy flat results/matches/)', () => {
    mkdirSync(join(root, 'results', 'states', 'counter_turns', TN), { recursive: true });
    mkdirSync(join(root, 'results', 'matches'), { recursive: true });
    writeFileSync(join(root, 'results', 'matches', 'old.jsonl'), '{"schemaVersion":1}\n');
    expect(indexResults({ root }).matches).toBe(3);
  });

  it('features the match results/featured.json names for each game, every time it regenerates', () => {
    expect(FEATURED_FILE).toBe('results/featured.json');
    writeFeatured({ counter_turns: TN });
    expect(indexResults({ root }).featured).toEqual([TN]);
    expect(featuredIds()).toEqual([TN]);
    // The choice lives in the file, not the index: a fresh index features it again.
    rmSync(join(root, DEFAULT_OUT));
    indexResults({ root });
    expect(featuredIds()).toEqual([TN]);
    // The file is only read.
    expect(readFileSync(join(root, FEATURED_FILE), 'utf8')).toBe('{"counter_turns":"' + TN + '"}');
    writeFeatured({ counter_realtime: RT2, counter_turns: TN });
    expect(indexResults({ root }).featured).toEqual([RT2, TN]);
    expect(featuredIds()).toEqual([RT2, TN]);
  });

  it('--featured sets that game in results/featured.json, keeping the other games', () => {
    writeFeatured({ counter_turns: TN });
    expect(indexResults({ root, featured: [RT] }).featured).toEqual([RT, TN]);
    expect(featuredIds()).toEqual([RT, TN]);
    expect(readFileSync(join(root, FEATURED_FILE), 'utf8')).toBe(
      JSON.stringify({ counter_realtime: RT, counter_turns: TN }, null, 2) + '\n',
    );
    indexResults({ root, featured: [RT2] });
    expect(readFeatured(root)).toEqual({ counter_realtime: RT2, counter_turns: TN });
    indexResults({ root });
    expect(featuredIds()).toEqual([RT2, TN]);
  });

  it('refuses two --featured matches of one game or an unknown one, writing nothing', () => {
    expect(() => indexResults({ root, featured: [RT, RT2] })).toThrow(
      '--featured: two counter_realtime matches; one per game',
    );
    expect(() => indexResults({ root, featured: ['20261007-120000-nope-a-vs-b-1'] })).toThrow(
      /--featured: no match "20261007-120000-nope-a-vs-b-1"/,
    );
    expect(existsSync(join(root, FEATURED_FILE))).toBe(false);
    expect(existsSync(join(root, DEFAULT_OUT))).toBe(false);
  });

  it('refuses a featured file that names a missing match or is malformed, naming the file', () => {
    writeFeatured({ counter_turns: id('counter_turns', 7) });
    expect(() => indexResults({ root })).toThrow(
      `results/featured.json: featured match "${id('counter_turns', 7)}" is not among the indexed matches`,
    );
    writeFeatured({ counter_realtime: TN });
    expect(() => indexResults({ root })).toThrow(
      /^results\/featured\.json: featured match .* is a counter_turns match, not counter_realtime$/,
    );
    writeFileSync(join(root, FEATURED_FILE), '["x"]');
    expect(() => indexResults({ root })).toThrow(
      'results/featured.json: must be an object of game id to match id',
    );
    writeFileSync(join(root, FEATURED_FILE), '{');
    expect(() => indexResults({ root })).toThrow(/^results\/featured\.json: /);
    expect(existsSync(join(root, DEFAULT_OUT))).toBe(false);
  });

  it('indexes a match on results/excluded.json as invalid, with its reason', () => {
    indexResults({ root });
    const before = new Map(readIndex().matches.map((m) => [m.id, m]));
    // The turn fixture is valid by the rule (its timeouts don't count).
    expect(before.get(TN)).toMatchObject({ valid: true });
    writeFileSync(
      join(root, EXCLUDED_FILE),
      JSON.stringify({ matches: [{ id: TN, reason: 'machine asleep' }] }),
    );
    indexResults({ root });
    const byId = new Map(readIndex().matches.map((m) => [m.id, m]));
    expect(byId.get(TN)).toMatchObject({ valid: false, excluded: 'machine asleep' });
    expect(byId.get(RT)).toEqual(before.get(RT));
    expect(byId.get(RT)).not.toHaveProperty('excluded');
  });

  it('refuses to feature an excluded match, and an excluded id that names no log', () => {
    writeFileSync(
      join(root, EXCLUDED_FILE),
      JSON.stringify({ matches: [{ id: RT2, reason: 'machine asleep' }] }),
    );
    writeFeatured({ counter_realtime: RT2 });
    expect(() => indexResults({ root })).toThrow(
      `results/featured.json: featured match "${RT2}" is excluded (machine asleep)`,
    );
    writeFeatured({});
    const missing = id('counter_realtime', 8);
    writeFileSync(
      join(root, EXCLUDED_FILE),
      JSON.stringify({ matches: [{ id: missing, reason: 'machine asleep' }] }),
    );
    expect(() => indexResults({ root })).toThrow(
      `results/excluded.json: no match "${missing}" in results/*/matches/`,
    );
    expect(existsSync(join(root, DEFAULT_OUT))).toBe(false);
  });

  it('skips unfinished logs and counts them', () => {
    const open = id('counter_turns', 9);
    const path = join(root, matchFile('counter_turns', open));
    const text = readFileSync(join(root, matchFile('counter_turns', TN)), 'utf8');
    const head = text.replace(TN, open).split('\n').slice(0, 3);
    writeFileSync(path, head.join('\n') + '\n');
    expect(indexResults({ root })).toMatchObject({ matches: 3, skipped: 1 });
  });

  it('names the file when a log is unreadable (a v1 log, for one)', () => {
    const bad = join(root, 'results', 'counter_turns', 'matches', 'old.jsonl');
    writeFileSync(bad, '{"type":"header","schemaVersion":1}\n');
    expect(() => indexResults({ root })).toThrow(
      /results\/counter_turns\/matches\/old\.jsonl: line 1: schema v1 logs are no longer readable/,
    );
  });

  it('refuses a log filed under the wrong game or file name', () => {
    const text = readFileSync(join(root, matchFile('counter_turns', TN)), 'utf8');
    const wrongGame = join(root, matchFile('counter_realtime', TN));
    writeFileSync(wrongGame, text);
    expect(() => indexResults({ root })).toThrow(/header\.game is "counter_turns"/);
    rmSync(wrongGame);
    writeFileSync(join(root, matchFile('counter_turns', id('counter_turns', 5))), text);
    expect(() => indexResults({ root })).toThrow(/header\.matchId is/);
  });
});
