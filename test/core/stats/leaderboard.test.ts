import { describe, expect, it } from 'vitest';
import type { Seat } from '../../../src/core/classifier/types.js';
import {
  OVERALL_FORMULA,
  buildLeaderboard,
  leaderboardNotes,
  runCheckWarning,
} from '../../../src/core/stats/leaderboard.js';
import { summarizeGame } from '../../../src/core/stats/summary.js';
import { CLUES, FIGHTER, INBOX, cluesMatch, decision, fakeLog, refusal } from './helpers.js';
import { NO_EXCLUSIONS } from '../../../src/core/results/excluded.js';

/** `expect.closeTo`, typed as the number it stands in for. */
const close = (x: number, digits: number): number => expect.closeTo(x, digits) as number;
/**
 * buildLeaderboard over three hand-built game summaries: fighter (Jev 3–0–1 vs OpenAI), inbox
 * (1–0–1) and clues (no head-to-head yet).
 */

let run = 0;
/** One match of `game`; `winner` is the winning player id or 'draw'. */
const match = (game: string, players: [string, string], winner: string, valid = true) => {
  run++;
  const w: Seat | 'draw' = winner === 'draw' ? 'draw' : winner === players[0] ? 0 : 1;
  const scores: [number, number] = w === 'draw' ? [1, 1] : w === 0 ? [2, 0] : [0, 2];
  return fakeLog({ game, players, winner: w, scores, run, valid, runId: 'm-aaaaaaaaaaaa' });
};

const fighter = summarizeGame(
  FIGHTER,
  [
    match('fighter', ['jev', 'openai'], 'jev'),
    match('fighter', ['openai', 'jev'], 'jev'),
    match('fighter', ['jev', 'openai'], 'jev'),
    match('fighter', ['openai', 'jev'], 'openai'),
    match('fighter', ['openai', 'jev'], 'openai', false),
    match('fighter', ['jev', 'random'], 'jev'),
    match('fighter', ['random', 'jev'], 'draw'),
    match('fighter', ['openai', 'scripted'], 'scripted'),
    match('fighter', ['random', 'scripted'], 'scripted'),
  ],
  NO_EXCLUSIONS,
);
const inbox = summarizeGame(
  INBOX,
  [match('inbox', ['jev', 'openai'], 'jev'), match('inbox', ['openai', 'jev'], 'openai')],
  NO_EXCLUSIONS,
);
const clues = summarizeGame(CLUES, [match('clues', ['jev', 'random'], 'jev')], NO_EXCLUSIONS);
const lb = buildLeaderboard([fighter, inbox, clues]);

describe('buildLeaderboard', () => {
  it('lists the games in the order given, with their head-to-head counts and featured match', () => {
    expect(lb.games.map((g) => [g.id, g.label, g.graded, g.matches, g.featured !== null])).toEqual([
      ['fighter', 'Fighter', false, { valid: 8, invalid: 1, excluded: 0, headToHead: 4 }, true],
      ['inbox', 'Inbox Invaders', true, { valid: 2, invalid: 0, excluded: 0, headToHead: 2 }, true],
      ['clues', 'Clue Clash', true, { valid: 1, invalid: 0, excluded: 0, headToHead: 0 }, false],
    ]);
  });

  it('has one row per provider model, best overall first', () => {
    expect(lb.models.map((m) => [m.player, m.label, m.model])).toEqual([
      ['jev', 'Jev (TypeSafe)', 'jev-latest'],
      ['openai', 'OpenAI Decisions (gpt-6-luna)', 'gpt-6-luna'],
    ]);
  });

  it('overall = the mean of the per-game head-to-head win rates; a game with none is left out', () => {
    const [jev, openai] = lb.models;
    // fighter 3/4 = 0.75, inbox 1/2 = 0.5, clues: no head-to-head. (0.75 + 0.5) / 2.
    expect(jev?.overall).toBe(0.625);
    expect(jev?.overallGames).toEqual(['fighter', 'inbox']);
    // fighter 1/4, inbox 1/2: (0.25 + 0.5) / 2.
    expect(openai?.overall).toBe(0.375);
    expect(openai?.overallGames).toEqual(['fighter', 'inbox']);
  });

  it('a cell per game: head to head with its interval, or null for a game without one', () => {
    const jev = lb.models[0];
    expect(jev?.games.map((c) => c.game)).toEqual(['fighter', 'inbox', 'clues']);
    expect(jev?.games[0]?.headToHead).toEqual({
      opponents: ['openai'],
      matches: 4,
      wins: 3,
      draws: 0,
      losses: 1,
      winRate: { p: 0.75, low: close(0.3006, 4), high: close(0.9544, 4) },
    });
    expect(jev?.games[2]?.headToHead).toBeNull();
    // The other side of the same pairing: 1 − p, bounds flipped.
    const openaiFighter = lb.models[1]?.games[0]?.headToHead;
    expect(openaiFighter).toMatchObject({ wins: 1, draws: 0, losses: 3 });
    expect(openaiFighter?.winRate.p).toBe(0.25);
    expect(openaiFighter?.winRate.low).toBeCloseTo(1 - 0.9544, 4);
  });

  it('copies accuracy, latency and cost per 1,000 decisions from the game summary', () => {
    const cell = lb.models[0]?.games[1];
    const player = inbox.players.find((p) => p.player === 'jev');
    expect(cell).toMatchObject({
      accuracy: player?.accuracy,
      latencyMs: player?.latencyMs,
      costPer1000: player?.costPer1000,
      decisions: player?.decisions,
      missRate: player?.missRate,
      refusals: player?.refusals,
      refusalRate: player?.refusalRate,
    });
  });

  it('reports each model’s refusals per game, in matches that refusals no longer invalidate', () => {
    const oks = (seat: Seat, n: number) =>
      Array.from({ length: n }, (_, i) => decision(seat, { sentTick: i, choice: 'jab' }));
    const refused = fakeLog({
      game: 'fighter',
      players: ['openai', 'jev'],
      winner: 0,
      scores: [2, 1],
      valid: false,
      runId: 'm-aaaaaaaaaaaa',
      decisions: [...oks(0, 45), ...[0, 1, 2, 3, 4].map(() => refusal(0)), ...oks(1, 50)],
    });
    const board = buildLeaderboard([summarizeGame(FIGHTER, [refused], NO_EXCLUSIONS)]);
    expect(board.schemaVersion).toBe(5);
    expect(board.games[0]?.matches).toEqual({ valid: 1, invalid: 0, excluded: 0, headToHead: 1 });
    const cell = (player: string) => board.models.find((m) => m.player === player)?.games[0];
    expect(cell('openai')).toMatchObject({ decisions: 50, missRate: 0, refusals: 5 });
    expect(cell('openai')?.refusalRate).toBeCloseTo(0.1, 12);
    expect(cell('jev')).toMatchObject({ refusals: 0, refusalRate: 0 });
    expect(cell('openai')?.headToHead).toMatchObject({ matches: 1, wins: 1 });
  });

  it('baseline reference rows: each model’s record against each baseline, per game', () => {
    expect(
      lb.baselineRecords.map((r) => [
        r.game,
        r.player,
        r.opponent,
        r.matches,
        r.wins,
        r.draws,
        r.losses,
        r.winRate.p,
      ]),
    ).toEqual([
      ['fighter', 'jev', 'random', 2, 1, 1, 0, 0.75],
      ['fighter', 'openai', 'scripted', 1, 0, 0, 1, 0],
      ['clues', 'jev', 'random', 1, 1, 0, 0, 1],
    ]);
    expect(lb.baselineRecords[1]?.opponentLabel).toBe('Scripted bot');
  });

  it('baseline rows: each baseline’s own accuracy and latency, per game', () => {
    expect(lb.baselines.map((b) => [b.game, b.player, b.label, b.matches])).toEqual([
      ['fighter', 'random', 'Random (uniform)', 3],
      ['fighter', 'scripted', 'Scripted bot', 2],
      ['clues', 'random', 'Random (uniform)', 1],
    ]);
  });

  it('states the formula, and which machine provider latency was measured from', () => {
    expect(lb.formula).toBe(OVERALL_FORMULA);
    expect(OVERALL_FORMULA).toMatch(/mean of .* head-to-head win rates/);
    expect(OVERALL_FORMULA).toMatch(/weighted equally/);
    expect(OVERALL_FORMULA).toMatch(/draw counts as half a win/);
    expect(OVERALL_FORMULA).toMatch(/left out of the mean/);
    expect(lb.runIds).toEqual(['m-aaaaaaaaaaaa']);
    const notes = leaderboardNotes(lb).join('\n');
    expect(notes).toMatch(/API-reported/);
    expect(notes).toContain(
      'Latency is wall time per request, measured from one machine (run id m-aaaaaaaaaaaa), the ' +
        'same for both models; it includes each provider’s network path from that machine.',
    );
    expect(notes).toMatch(/hosted differently/);
    expect(notes).toMatch(/A refusal \(the model declining to answer\) is not a miss/);
    expect(notes).toMatch(/Validity is recomputed from the logs with the current rule/);
  });

  it('collects run ids over every game, and says so when there is more than one', () => {
    const two = buildLeaderboard([
      summarizeGame(
        FIGHTER,
        [
          fakeLog({
            game: 'fighter',
            players: ['jev', 'openai'],
            winner: 0,
            scores: [2, 0],
            runId: 'm-bbbbbbbbbbbb',
          }),
        ],
        NO_EXCLUSIONS,
      ),
      summarizeGame(
        INBOX,
        [
          fakeLog({
            players: ['jev', 'openai'],
            winner: 0,
            scores: [2, 0],
            runId: 'm-aaaaaaaaaaaa',
          }),
          fakeLog({
            players: ['openai', 'jev'],
            winner: 0,
            scores: [2, 0],
            run: 2,
            runId: 'm-bbbbbbbbbbbb',
          }),
        ],
        NO_EXCLUSIONS,
      ),
    ]);
    expect(two.runIds).toEqual(['m-aaaaaaaaaaaa', 'm-bbbbbbbbbbbb']);
    expect(leaderboardNotes(two).join('\n')).toMatch(
      /The logs carry run ids m-aaaaaaaaaaaa, m-bbbbbbbbbbbb: ids from before 2026-10-15/,
    );
  });

  it('with no head-to-head anywhere: no overall, games and baselines still listed', () => {
    const only = buildLeaderboard([
      summarizeGame(FIGHTER, [match('fighter', ['random', 'scripted'], 'scripted')], NO_EXCLUSIONS),
      summarizeGame(CLUES, [], NO_EXCLUSIONS),
    ]);
    expect(only.models).toEqual([]);
    expect(only.baselineRecords).toEqual([]);
    expect(only.games.map((g) => [g.id, g.matches.headToHead])).toEqual([
      ['fighter', 0],
      ['clues', 0],
    ]);
    expect(only.baselines.map((b) => [b.game, b.player])).toEqual([
      ['fighter', 'random'],
      ['fighter', 'scripted'],
    ]);
    expect(only.runIds).toEqual([]);
    expect(leaderboardNotes(only).join('\n')).toMatch(/no provider runs yet/);
  });

  it('a model with no head-to-head in any game has no overall', () => {
    const solo = buildLeaderboard([
      summarizeGame(CLUES, [match('clues', ['jev', 'random'], 'jev')], NO_EXCLUSIONS),
    ]);
    expect(solo.models).toHaveLength(1);
    expect(solo.models[0]).toMatchObject({ player: 'jev', overall: null, overallGames: [] });
  });
});

describe('the run-level miss check on the leaderboard', () => {
  it('copies each game’s check, real-time games included', () => {
    expect(lb.games.map((g) => [g.id, g.runCheck.passed])).toEqual([
      ['fighter', true],
      ['inbox', true],
      ['clues', true],
    ]);
    expect(lb.games.map((g) => g.runCheck)).toEqual([fighter, inbox, clues].map((s) => s.runCheck));
  });

  it('a failing turn game carries the players over the limit, and a warning names them', () => {
    // OpenAI misses 1 of 16 (6.3%) in the only match.
    const failing = buildLeaderboard([summarizeGame(CLUES, [cluesMatch([0, 1])], NO_EXCLUSIONS)]);
    const check = failing.games[0]?.runCheck ?? null;
    expect(check?.passed).toBe(false);
    expect(runCheckWarning(check)).toBe(
      'Run-level miss check failed: OpenAI Decisions (gpt-6-luna) missed 6.3% of its decisions ' +
        '(1 of 16) over this run’s valid matches; the limit is 2%. The results are shown but ' +
        'don’t meet the miss limit.',
    );
    expect(runCheckWarning(lb.games[2]?.runCheck ?? null)).toBeNull();
    expect(runCheckWarning(null)).toBeNull();
  });

  it('the notes explain that timeouts never invalidate a match and the run-level check', () => {
    const notes = leaderboardNotes(lb).join('\n');
    expect(notes).toContain('Every game also checks the 2% limit over the whole run');
    expect(notes).toContain('it never makes a match invalid, in any game');
    expect(notes).not.toContain('times out or errors on) more than 2% of its decisions, or');
    expect(leaderboardNotes(buildLeaderboard([fighter, inbox])).join('\n')).toContain(
      'Every game also checks the 2% limit',
    );
    // With no game there is nothing to check.
    expect(leaderboardNotes({ runIds: [] }).join('\n')).not.toContain('Every game also checks');
  });

  it('points to the “Run id” section of core.md when there are several run ids', () => {
    const notes = leaderboardNotes({ runIds: ['m-111111111111', 'm-222222222222'] }).join('\n');
    expect(notes).toContain('see the “Run id” section of docs/architecture/core.md');
    expect(notes).not.toContain('README');
  });
});
