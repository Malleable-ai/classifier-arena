import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseExcluded } from '../../src/core/results/excluded.js';
import { EXCLUDED_FILE, INDEX_FILE, matchesDir } from '../../src/core/results/paths.js';
import { GAMES } from '../../src/games/index.js';
import {
  committedExclusions,
  committedMatchIds,
  loadCommittedLog,
  resultsIndex,
} from '../../src/web/logs.js';

/** Games with committed logs. */
const GAMES_WITH_LOGS = ['fighter', 'inbox', 'clues'] as const;

const idsOnDisk = (game: string): string[] =>
  readdirSync(matchesDir(game))
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => f.slice(0, -'.jsonl'.length))
    .sort();

describe('committed logs in the bundle', () => {
  it.each(GAMES_WITH_LOGS)('lists every results/%s/matches log by id', (game) => {
    expect(idsOnDisk(game).length).toBeGreaterThan(0);
    expect(committedMatchIds(game)).toEqual(idsOnDisk(game));
  });

  it('every registered game has committed logs', () => {
    expect(GAMES.map((g) => g.id).sort()).toEqual([...GAMES_WITH_LOGS].sort());
  });

  it('lists nothing for an unknown game', () => {
    expect(committedMatchIds('chess')).toEqual([]);
  });

  it('loads and parses one by game and id, and rejects an unknown one', async () => {
    const [id] = committedMatchIds('fighter');
    if (id === undefined) throw new Error('no logs');
    const log = await loadCommittedLog('fighter', id);
    expect(log.header.matchId).toBe(id);
    expect(log.header.game).toBe('fighter');
    await expect(loadCommittedLog('fighter', 'nope')).rejects.toThrow(
      /no committed fighter match log "nope"/,
    );
    await expect(loadCommittedLog('clues', id)).rejects.toThrow(/no committed clues match log/);
  });

  it('reads results/index.json (schema v2), which lists every committed log', () => {
    const index = resultsIndex();
    expect(index).not.toBeNull();
    expect(index).toEqual(JSON.parse(readFileSync(INDEX_FILE, 'utf8')));
    expect(index?.schemaVersion).toBe(2);
    const committed = GAMES.flatMap((g) => committedMatchIds(g.id)).sort();
    expect(index?.matches.map((m) => m.id).sort()).toEqual(committed);
    for (const m of index?.matches ?? []) {
      expect(readFileSync(join('results', m.file), 'utf8')).toContain(`"matchId":"${m.id}"`);
    }
  });

  it('reads results/excluded.json, whose every id names a committed log', () => {
    const file = parseExcluded(JSON.parse(readFileSync(EXCLUDED_FILE, 'utf8')));
    const exclusions = committedExclusions();
    expect([...exclusions.entries()]).toEqual(file.map((e) => [e.id, e.reason]));
    const committed = new Set(GAMES.flatMap((g) => committedMatchIds(g.id)));
    for (const id of exclusions.keys()) expect(committed.has(id)).toBe(true);
    // The index agrees: each excluded match is indexed invalid, with its reason.
    for (const m of resultsIndex()?.matches ?? []) {
      const reason = exclusions.get(m.id);
      if (reason !== undefined) expect(m).toMatchObject({ valid: false, excluded: reason });
      else expect(m).not.toHaveProperty('excluded');
    }
  });
});
