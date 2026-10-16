import { describe, expect, it } from 'vitest';
import { OVERALL_FORMULA, buildLeaderboard } from '../../../src/core/stats/leaderboard.js';
import { summarizeGame } from '../../../src/core/stats/summary.js';
import { GAMES } from '../../../src/games/index.js';
import { leaderboardView, type LeaderboardPageGame } from '../../../src/web/shell/leaderboard.js';
import { CLUES, FIGHTER, INBOX, cluesMatch, decision, fakeLog } from '../../core/stats/helpers.js';
import { fixtureResults } from '../../fixtures/web/results-fixture.js';
import { NO_EXCLUSIONS } from '../../../src/core/results/excluded.js';

/** The leaderboard page's model (DOM-free): what `/` shows for a given leaderboard. */

const PAGE_GAMES: LeaderboardPageGame[] = [
  { id: 'fighter', label: 'Fighter', replays: 3, playable: true },
  { id: 'inbox', label: 'Inbox Invaders', replays: 1, playable: true },
  { id: 'clues', label: 'Clue Clash', replays: 0, playable: false },
];

const baselinesOnly = buildLeaderboard([
  summarizeGame(
    FIGHTER,
    [
      fakeLog({
        game: 'fighter',
        players: ['scripted', 'random'],
        winner: 0,
        scores: [2, 0],
        decisions: [decision(0), decision(1)],
      }),
    ],
    NO_EXCLUSIONS,
  ),
  summarizeGame(INBOX, [], NO_EXCLUSIONS),
  summarizeGame(CLUES, [], NO_EXCLUSIONS),
]);

describe('leaderboardView: before any head-to-head', () => {
  const v = leaderboardView({ leaderboard: baselinesOnly, games: PAGE_GAMES });

  it('is not published: no overall rows, and says so', () => {
    expect(v.published).toBe(false);
    expect(v.overall).toEqual([]);
    expect(v.columns).toEqual(['Fighter', 'Inbox Invaders', 'Clue Clash']);
  });

  it('still lists every game, linked to its history, with its replays', () => {
    expect(v.sections.map((s) => [s.label, s.href, s.replays, s.status])).toEqual([
      ['Fighter', '/fighter', '3 replays', 'No published runs yet.'],
      ['Inbox Invaders', '/inbox', '1 replay', 'No published runs yet.'],
      ['Clue Clash', null, 'no replays yet', 'No published runs yet.'],
    ]);
  });

  it('shows the baselines’ own numbers', () => {
    expect(v.sections[0]?.baselines.map((b) => [b.label, b.matches, b.p50])).toEqual([
      ['Random (uniform)', '1', '100 ms'],
      ['Scripted bot', '1', '100 ms'],
    ]);
  });

  it('states the formula and the notes', () => {
    expect(v.formula).toBe(OVERALL_FORMULA);
    expect(v.notes.join(' ')).toMatch(/API-reported/);
    expect(v.notes.join(' ')).toMatch(/no provider runs yet/);
  });

  it('works without a leaderboard file at all', () => {
    const none = leaderboardView({ leaderboard: null, games: PAGE_GAMES });
    expect(none.published).toBe(false);
    expect(none.sections.map((s) => s.id)).toEqual(['fighter', 'inbox', 'clues']);
    expect(none.formula).toBe(OVERALL_FORMULA);
  });
});

describe('leaderboardView: with head-to-head results (fixture)', () => {
  const { leaderboard } = fixtureResults();
  const games = GAMES.map((g) => ({ id: g.id, label: g.label, replays: 61, playable: true }));
  const v = leaderboardView({ leaderboard, games, fixture: true });

  it('one overall row per model, with each game’s win rate, interval and n', () => {
    expect(v.published).toBe(true);
    expect(v.fixture).toBe(true);
    expect(v.overall.map((r) => r.label)).toEqual(leaderboard.models.map((m) => m.label));
    const first = v.overall[0];
    const model = leaderboard.models[0];
    expect(first?.overall).toBe(`${((model?.overall ?? 0) * 100).toFixed(1)}%`);
    expect(first?.cells).toHaveLength(3);
    expect(first?.cells[0]?.rate).toMatch(/^\d+\.\d%$/);
    expect(first?.cells[0]?.detail).toMatch(/^\d+\.\d–\d+\.\d% · n=50$/);
  });

  it('per game: the models’ head-to-head, accuracy, latency and cost, and the baselines', () => {
    const inbox = v.sections.find((s) => s.id === 'inbox');
    expect(inbox?.status).toBe('50 valid head-to-head matches · 1 invalid');
    expect(inbox?.rows).toHaveLength(2);
    expect(inbox?.rows[0]).toMatchObject({
      winRate: expect.stringMatching(/%$/) as string,
      accuracy: expect.stringMatching(/%$/) as string,
      p50: expect.stringMatching(/ ms$/) as string,
      cost: expect.stringMatching(/^\$/) as string,
    });
    // Each model against random and the game's scripted bot.
    expect(inbox?.baselineRecords.map((r) => r.opponent)).toEqual([
      'Random (uniform)',
      'Always legit',
      'Random (uniform)',
      'Always legit',
    ]);
    expect(inbox?.featuredHref).toMatch(/^\/inbox\?match=/);
  });

  it('shows each model’s refusal rate per game', () => {
    const inbox = v.sections.find((s) => s.id === 'inbox');
    for (const row of inbox?.rows ?? []) expect(row.refusals).toMatch(/^\d+\.\d%$/);
    const rate = (label: string | undefined) =>
      inbox?.rows.find((r) => r.label === label)?.refusals;
    const cell = (player: string) =>
      leaderboard.models.find((m) => m.player === player)?.games.find((g) => g.game === 'inbox');
    const openai = leaderboard.models.find((m) => m.player === 'openai');
    const jev = leaderboard.models.find((m) => m.player === 'jev');
    // The fixture's OpenAI refuses now and then; its Jev never does.
    expect(cell('openai')?.refusals).toBeGreaterThan(0);
    expect(rate(openai?.label)).toBe(`${((cell('openai')?.refusalRate ?? 0) * 100).toFixed(1)}%`);
    expect(rate(jev?.label)).toBe('0.0%');
  });

  it('an ungraded game says so instead of an accuracy', () => {
    const fighter = v.sections.find((s) => s.id === 'fighter');
    expect(fighter?.graded).toBe(false);
    expect(fighter?.rows[0]?.accuracy).toBe('not graded');
  });

  it('names the machine latency was measured from, by run id', () => {
    expect(v.notes.join(' ')).toMatch(/one machine \(run id m-fixture\)/);
  });
});

describe('leaderboardView: a turn game that failed its run-level miss check', () => {
  // Jev vs OpenAI in Clue Clash; OpenAI times out on 1 of 16 turns (6.3%, over the 2% limit).
  const lb = buildLeaderboard([
    summarizeGame(FIGHTER, [], NO_EXCLUSIONS),
    summarizeGame(INBOX, [], NO_EXCLUSIONS),
    summarizeGame(CLUES, [cluesMatch([0, 1])], NO_EXCLUSIONS),
  ]);
  const games = PAGE_GAMES.map((g) => ({ ...g, playable: true }));
  const v = leaderboardView({ leaderboard: lb, games });

  it('warns in the game’s section, with the rate', () => {
    const clues = v.sections.find((s) => s.id === 'clues');
    expect(clues?.warning).toMatch(
      /^Run-level miss check failed: OpenAI Decisions \(gpt-6-luna\) missed 6\.3% of its decisions \(1 of 16\)/,
    );
    expect(v.sections.filter((s) => s.warning !== null).map((s) => s.id)).toEqual(['clues']);
  });

  it('marks that game’s cell in the overall table, and only that one', () => {
    expect(v.published).toBe(true);
    for (const row of v.overall) {
      expect(row.cells.map((c) => c.warning)).toEqual([false, false, true]);
    }
  });

  it('passing: no warning anywhere', () => {
    const ok = leaderboardView({
      leaderboard: buildLeaderboard([summarizeGame(CLUES, [cluesMatch([0, 0])], NO_EXCLUSIONS)]),
      games: [{ id: 'clues', label: 'Clue Clash', replays: 1, playable: true }],
    });
    expect(ok.sections[0]?.warning).toBeNull();
    expect(ok.overall.every((r) => r.cells.every((c) => !c.warning))).toBe(true);
    expect(ok.notes.join(' ')).toMatch(/Every game also checks the 2% limit/);
  });
});

describe('leaderboardView: matches excluded by hand', () => {
  const kept = fakeLog({ players: ['jev', 'openai'], winner: 0, scores: [30, 10] });
  const slept = fakeLog({ players: ['openai', 'jev'], winner: 0, scores: [12, 11], run: 2 });
  const reason = 'The machine slept mid-match (before stall detection existed).';
  const lb = buildLeaderboard([
    summarizeGame(INBOX, [kept, slept], new Map([[slept.header.matchId, reason]])),
  ]);

  it('lists each excluded match with its reason in the game’s section, as the note says', () => {
    const v = leaderboardView({
      leaderboard: lb,
      games: [{ id: 'inbox', label: 'Inbox Invaders', replays: 2, playable: true }],
    });
    expect(v.sections[0]?.excluded).toEqual([
      { id: slept.header.matchId, reason, href: `/inbox?match=${slept.header.matchId}` },
    ]);
    expect(v.notes.join(' ')).toContain('each listed with its reason under its game');
    // A game the web can't play yet lists them without a link.
    const unplayable = leaderboardView({
      leaderboard: lb,
      games: [{ id: 'inbox', label: 'Inbox Invaders', replays: 2, playable: false }],
    });
    expect(unplayable.sections[0]?.excluded[0]?.href).toBeNull();
  });

  it('lists none when nothing is excluded', () => {
    const v = leaderboardView({
      leaderboard: buildLeaderboard([summarizeGame(INBOX, [kept], NO_EXCLUSIONS)]),
      games: [{ id: 'inbox', label: 'Inbox Invaders', replays: 1, playable: true }],
    });
    expect(v.sections[0]?.excluded).toEqual([]);
  });
});
