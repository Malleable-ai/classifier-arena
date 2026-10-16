import { describe, expect, it } from 'vitest';
import {
  INDEX_FILE,
  LEADERBOARD_FILES,
  RESULTS_DIR,
  matchFile,
  matchFileInResults,
  matchIdFor,
  matchesDir,
  parseMatchId,
  statesDir,
  summaryFiles,
} from '../../../src/core/results/paths.js';

describe('results paths', () => {
  it('lays out results/<game>/… with / separators', () => {
    expect(RESULTS_DIR).toBe('results');
    expect(INDEX_FILE).toBe('results/index.json');
    expect(LEADERBOARD_FILES).toEqual({
      json: 'results/leaderboard.json',
      md: 'results/leaderboard.md',
    });
    expect(matchesDir('fighter')).toBe('results/fighter/matches');
    expect(matchFile('fighter', '20261007-120000-fighter-jev-vs-openai-1')).toBe(
      'results/fighter/matches/20261007-120000-fighter-jev-vs-openai-1.jsonl',
    );
    expect(matchFileInResults('clue_clash', 'm-1')).toBe('clue_clash/matches/m-1.jsonl');
    expect(summaryFiles('inbox_invaders')).toEqual({
      json: 'results/inbox_invaders/summary.json',
      md: 'results/inbox_invaders/summary.md',
    });
    expect(statesDir('fighter', 'm-1')).toBe('results/states/fighter/m-1');
  });

  it('refuses game and match ids that could escape results/', () => {
    for (const game of ['', '../x', 'a/b', 'Fighter', 'fight-er', '1st']) {
      expect(() => matchesDir(game)).toThrow(/game id/);
    }
    for (const id of ['', '../x', 'a/b', 'a.b', 'A-1', '-a', 'a-']) {
      expect(() => matchFile('fighter', id)).toThrow(/match id/);
      expect(() => statesDir('fighter', id)).toThrow(/match id/);
    }
  });
});

describe('matchIdFor', () => {
  it('stamps a Date with its local date and time', () => {
    const when = new Date(2026, 9, 7, 9, 5, 3); // local time
    expect(matchIdFor({ game: 'fighter', a: 'jev', b: 'openai', when, run: 1 })).toBe(
      '20261007-090503-fighter-jev-vs-openai-1',
    );
  });

  it('takes an ISO-style string as written (no time-zone conversion)', () => {
    const id = matchIdFor({
      game: 'counter_realtime',
      a: 'random',
      b: 'fake_provider',
      when: '2026-10-07T22:23:47.877Z',
      run: 12,
    });
    expect(id).toBe('20261007-222347-counter_realtime-random-vs-fake_provider-12');
  });

  it('rejects bad parts', () => {
    const ok = { game: 'fighter', a: 'jev', b: 'openai', when: '2026-10-07T00:00:00Z', run: 1 };
    expect(() => matchIdFor({ ...ok, game: 'Fighter' })).toThrow(/game id/);
    expect(() => matchIdFor({ ...ok, a: 'gpt-4o' })).toThrow(/player id/);
    expect(() => matchIdFor({ ...ok, b: '' })).toThrow(/player id/);
    expect(() => matchIdFor({ ...ok, run: 0 })).toThrow(/run/);
    expect(() => matchIdFor({ ...ok, run: 1.5 })).toThrow(/run/);
    expect(() => matchIdFor({ ...ok, when: 'yesterday' })).toThrow(/when/);
  });
});

describe('parseMatchId', () => {
  const GAMES = ['fighter', 'counter_realtime', 'inbox_invaders', 'clue', 'clue_clash'];

  it('round-trips ids for multi-segment game ids and player ids', () => {
    const cases = [
      { game: 'counter_realtime', a: 'random', b: 'fake_provider', run: 1 },
      { game: 'inbox_invaders', a: 'gpt_5_mini', b: 'jev', run: 23 },
      { game: 'clue_clash', a: 'vs', b: 'vs', run: 2 },
      { game: 'clue', a: 'clash', b: 'jev', run: 1 },
      { game: 'fighter', a: 'human', b: 'scripted', run: 4 },
    ];
    for (const c of cases) {
      const id = matchIdFor({ ...c, when: '2026-10-07T17:38:43.000Z' });
      expect(parseMatchId(id, GAMES)).toEqual({
        date: '2026-10-07',
        time: '17:38:43',
        game: c.game,
        players: [c.a, c.b],
        run: c.run,
      });
    }
  });

  it('prefers the longest known game id', () => {
    expect(parseMatchId('20261007-173843-clue_clash-a-vs-b-1', GAMES)?.game).toBe('clue_clash');
    expect(parseMatchId('20261007-173843-clue-clash-vs-b-1', GAMES)).toMatchObject({
      game: 'clue',
      players: ['clash', 'b'],
    });
  });

  it('returns null for an unknown game or a malformed id', () => {
    expect(parseMatchId('20261007-173843-chess-a-vs-b-1', GAMES)).toBeNull();
    expect(parseMatchId('20261007-173843-jev-vs-openai-1', GAMES)).toBeNull(); // v1, no game
    expect(parseMatchId('20261007-fighter-a-vs-b-1', GAMES)).toBeNull();
    expect(parseMatchId('20261007-173843-fighter-a-b-1', GAMES)).toBeNull();
    expect(parseMatchId('20261007-173843-fighter-a-vs-b', GAMES)).toBeNull();
    expect(parseMatchId('20261007-173843-fighter-a-vs-b-1', [])).toBeNull();
  });
});
