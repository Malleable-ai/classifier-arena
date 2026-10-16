import { describe, expect, it } from 'vitest';
import { summarizeGame } from '../../../src/core/stats/summary.js';
import { historySummaryView, type MatchRow } from '../../../src/web/shell/history.js';
import { FIGHTER, INBOX, decision, fakeLog } from '../../core/stats/helpers.js';
import { NO_EXCLUSIONS } from '../../../src/core/results/excluded.js';

/** The summary header on `/<game>`: the head-to-head record, per-player numbers, featured match. */

const row = (id: string, featured: boolean, labels: [string, string]): MatchRow => ({
  id,
  game: 'inbox',
  date: '2026-10-08',
  time: '12:00:00',
  players: ['scripted', 'random'],
  labels,
  local: false,
  featured,
  headToHead: false,
  valid: true,
  excluded: null,
  winner: 0,
  scores: [8, 0],
  totalTicks: 600,
  cadence: { kind: 'realtime', tickRate: 60 },
  finished: true,
  loaded: true,
});

describe('historySummaryView', () => {
  const h2hA = fakeLog({
    players: ['jev', 'openai'],
    winner: 0,
    scores: [40, 10],
    decisions: [
      decision(0, { latencyMs: 180, correct: true }),
      decision(1, { latencyMs: 420, correct: false }),
    ],
  });
  const h2hB = fakeLog({
    players: ['openai', 'jev'],
    winner: 'draw',
    scores: [9, 9],
    decisions: [decision(0, { latencyMs: 420 }), decision(1, { latencyMs: 180 })],
  });
  const summary = summarizeGame(INBOX, [h2hA, h2hB], NO_EXCLUSIONS);

  it('gives the head-to-head record and win rate', () => {
    const v = historySummaryView(summary, []);
    expect(v.headline).toBe('Jev 1–1–0 OpenAI Decisions');
    expect(v.detail).toMatch(
      /^Jev wins 75\.0% \(\d+\.\d–\d+\.\d%\) of 2 valid head-to-head matches/,
    );
  });

  it('lists each player’s accuracy and latency', () => {
    const v = historySummaryView(summary, []);
    expect(v.graded).toBe(true);
    expect(v.players).toEqual([
      { label: 'Jev', accuracy: '100.0%', p50: '180 ms', p95: '180 ms', matches: '2' },
      { label: 'OpenAI Decisions', accuracy: '0.0%', p50: '420 ms', p95: '420 ms', matches: '2' },
    ]);
  });

  it('marks the featured match: the closest valid head-to-head', () => {
    const v = historySummaryView(summary, []);
    expect(v.featured).toEqual({
      id: h2hB.header.matchId,
      text: 'Featured: OpenAI Decisions vs Jev, Draw 9–9, the closest valid head-to-head',
    });
  });

  it('says a featured win on equal scores was won on the tiebreak', () => {
    const tiebreak = fakeLog({
      players: ['openai', 'jev'],
      winner: 1,
      scores: [9, 9],
      decisions: [decision(0, { latencyMs: 420 }), decision(1, { latencyMs: 180 })],
    });
    const v = historySummaryView(summarizeGame(INBOX, [tiebreak], NO_EXCLUSIONS), []);
    expect(v.featured?.text).toBe(
      'Featured: OpenAI Decisions vs Jev, Jev wins on the tiebreak (9–9), the closest valid ' +
        'head-to-head',
    );
  });

  it('without a head-to-head, says so and features the index’s pick', () => {
    const base = summarizeGame(
      INBOX,
      [
        fakeLog({
          players: ['scripted', 'random'],
          winner: 0,
          scores: [8, 0],
          decisions: [decision(0, { correct: true }), decision(1, { correct: false })],
        }),
      ],
      NO_EXCLUSIONS,
    );
    const rows = [
      row('a', false, ['Always legit', 'Random (uniform)']),
      row('b', true, ['Always legit', 'Random (uniform)']),
    ];
    const v = historySummaryView(base, rows);
    expect(v.headline).toBe('No published head-to-head results yet.');
    expect(v.detail).toBeNull();
    expect(v.players.map((p) => [p.label, p.accuracy])).toEqual([
      ['Random', '0.0%'],
      // The helper labels every `scripted` seat "Scripted bot".
      ['Scripted bot', '100.0%'],
    ]);
    expect(v.featured).toEqual({ id: 'b', text: 'Featured: Always legit vs Random' });
  });

  it('an ungraded game has no accuracy column', () => {
    const v = historySummaryView(
      summarizeGame(
        FIGHTER,
        [fakeLog({ game: 'fighter', players: ['scripted', 'random'], winner: 0, scores: [2, 0] })],
        NO_EXCLUSIONS,
      ),
      [],
    );
    expect(v.graded).toBe(false);
    expect(v.players.every((p) => p.accuracy === null)).toBe(true);
  });

  it('no summary at all: nothing to show but the featured row', () => {
    const v = historySummaryView(null, [row('b', true, ['Always legit', 'Random (uniform)'])]);
    expect(v.headline).toBe('No published head-to-head results yet.');
    expect(v.players).toEqual([]);
    expect(v.featured?.id).toBe('b');
  });

  it('a listed head-to-head that is not in the published results (a local log) is not one yet', () => {
    const local: MatchRow = {
      ...row('l', false, ['Jev (TypeSafe)', 'OpenAI Decisions (gpt-6-luna)']),
      players: ['jev', 'openai'],
      local: true,
      headToHead: true,
    };
    const v = historySummaryView(summarizeGame(INBOX, [], NO_EXCLUSIONS), [local]);
    expect(v.headline).toBe('No published head-to-head results yet.');
    expect(v.headline).not.toMatch(/runs/);
  });
});
