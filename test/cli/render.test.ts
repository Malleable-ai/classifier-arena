import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseCutArgs } from '../../src/cli/cut.js';
import { checkCardName, renderPath, resolveMatchRef } from '../../src/cli/render.js';
import { UsageError } from '../../src/cli/video/args.js';

const ROOT = resolve('.');
const ID = '20261012-154624-fighter-scripted-vs-random-1';
const FILE = resolve(`results/fighter/matches/${ID}.jsonl`);

describe('resolveMatchRef', () => {
  it('finds a committed log by <game>/<id> or by its path', () => {
    expect(resolveMatchRef(`fighter/${ID}`, ROOT, ROOT)).toEqual({
      game: 'fighter',
      id: ID,
      file: FILE,
      committed: true,
    });
    expect(resolveMatchRef(`results/fighter/matches/${ID}.jsonl`, ROOT, ROOT)).toMatchObject({
      committed: true,
    });
  });

  it('takes any v2 log outside results/, marked not committed (served to the dev build)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'arena-render-test-'));
    try {
      const copy = join(dir, 'copy.jsonl');
      writeFileSync(copy, readFileSync(FILE));
      expect(resolveMatchRef(copy, ROOT, ROOT)).toEqual({
        game: 'fighter',
        id: ID,
        file: copy,
        committed: false,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses unknown games, ids and paths', () => {
    expect(() => resolveMatchRef('chess/abc-1', ROOT, ROOT)).toThrow(UsageError);
    expect(() => resolveMatchRef('fighter/nope-1', ROOT, ROOT)).toThrow(
      /no committed fighter match/,
    );
    expect(() => resolveMatchRef('nowhere.jsonl', ROOT, ROOT)).toThrow(/no such match log/);
  });
});

describe('checkCardName', () => {
  it('knows the intro, each game’s title and the outro', () => {
    for (const name of ['intro', 'title-fighter', 'title-inbox', 'title-clues', 'outro']) {
      expect(() => {
        checkCardName(name);
      }).not.toThrow();
    }
    expect(() => {
      checkCardName('credits');
    }).toThrow(/unknown card "credits" \(cards: intro, title-fighter/);
  });
});

describe('renderPath', () => {
  it('opens render mode at the size, with log= only for a log outside results/', () => {
    const size = { width: 1080, height: 1080 };
    expect(renderPath({ kind: 'match', game: 'inbox', id: 'abc-1' }, size)).toBe(
      '/inbox?match=abc-1&render=1&size=1080x1080',
    );
    expect(
      renderPath({ kind: 'match', game: 'inbox', id: 'abc-1', log: '/__render/abc-1.jsonl' }, size),
    ).toBe('/inbox?match=abc-1&render=1&size=1080x1080&log=%2F__render%2Fabc-1.jsonl');
    expect(renderPath({ kind: 'card', name: 'outro', fixture: true }, size)).toBe(
      '/?card=outro&render=1&size=1080x1080&fixture=1',
    );
  });
});

describe('parseCutArgs', () => {
  it('renders both cuts unless one is named', () => {
    expect(parseCutArgs([])).toEqual({ kinds: ['square', 'wide'], dryRun: false });
    expect(parseCutArgs(['--', '--square'])).toEqual({ kinds: ['square'], dryRun: false });
    expect(parseCutArgs(['--wide', '--dry-run'])).toEqual({ kinds: ['wide'], dryRun: true });
    expect(() => parseCutArgs(['--tall'])).toThrow(UsageError);
  });
});
