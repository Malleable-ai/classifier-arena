import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseMatchLog } from '../../src/core/log/read.js';
import { replayLog } from '../../src/core/replay/replay.js';
import { RESULTS_DIR, matchesDir } from '../../src/core/results/paths.js';
import { GAMES, getGame } from '../../src/games/index.js';

/** Every committed match log of every game replays to its recorded `match_end` hash in Node. */

const jsonl = (dir: string): string[] =>
  readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .sort();

const logs = readdirSync(RESULTS_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && GAMES.some((g) => g.id === d.name))
  .flatMap((d) => jsonl(matchesDir(d.name)).map((f) => [d.name, f] as const));

describe('committed match logs replay with the core replay', () => {
  it.each(['fighter', 'inbox', 'clues'])('has at least one committed %s log', (id) => {
    expect(logs.some(([game]) => game === id)).toBe(true);
  });

  it('keeps no logs outside results/<game>/matches/', () => {
    const stray = readdirSync(RESULTS_DIR).filter((f) => f.endsWith('.jsonl'));
    expect(stray).toEqual([]);
    expect(readdirSync(RESULTS_DIR)).not.toContain('matches');
  });

  it.each(logs)('%s/%s replays to its match_end hash', (game, f) => {
    const log = parseMatchLog(readFileSync(join(matchesDir(game), f), 'utf8'));
    expect(log.header.game).toBe(game);
    expect(`${log.header.matchId}.jsonl`).toBe(f);
    const end = log.matchEnd;
    if (end === null) throw new Error(`${f} has no match_end`);
    const r = replayLog(log, getGame(game));
    expect(r.hash).toBe(end.finalStateHash);
    expect(r.matches).toBe(true);
  });
});
