import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Leaderboard } from '../../../src/core/stats/leaderboard.js';
import {
  OUTRO_LEGEND,
  outroModel,
  PENDING_LEGEND,
  REPO_URL,
  splitLabel,
} from '../../../src/web/cards/outro-model.js';
import { MODEL_COLORS } from '../../../src/web/shell/theme.js';
import { fixtureResults } from '../../fixtures/web/results-fixture.js';

const GAMES = [
  { id: 'fighter', label: 'Fighter' },
  { id: 'inbox', label: 'Inbox Invaders' },
  { id: 'clues', label: 'Clue Clash' },
];

describe('outroModel', () => {
  it('says results pending with no leaderboard, listing every game', () => {
    const m = outroModel(null, GAMES);
    expect(m.pending).toBe(true);
    expect(m.models).toEqual([]);
    expect(m.games.map((g) => g.label)).toEqual(['Fighter', 'Inbox Invaders', 'Clue Clash']);
    expect(m.games.every((g) => g.pending && g.cells.length === 0)).toBe(true);
    expect(m.url).toBe(REPO_URL);
    expect(m.legend).toBe(PENDING_LEGEND);
  });

  it('says results pending for a baselines-only leaderboard', () => {
    const lb = JSON.parse(readFileSync('results/leaderboard.json', 'utf8')) as Leaderboard;
    const baselinesOnly: Leaderboard = {
      ...lb,
      models: lb.models.map((r) => ({
        ...r,
        overall: null,
        games: r.games.map((g) => ({ ...g, headToHead: null })),
      })),
    };
    const m = outroModel(baselinesOnly, GAMES);
    expect(m.pending).toBe(true);
    expect(m.games.map((g) => g.id)).toEqual(lb.games.map((g) => g.id));
  });

  it('shows the committed published results', () => {
    const lb = JSON.parse(readFileSync('results/leaderboard.json', 'utf8')) as Leaderboard;
    expect(lb.models.every((r) => r.games.every((g) => g.headToHead !== null))).toBe(true);
    const m = outroModel(lb, GAMES);
    expect(m.pending).toBe(false);
    expect(m.models.map((c) => c.label)).toEqual(lb.models.slice(0, 2).map((r) => r.label));
    // Each column in its model's color, whichever order the models come in.
    expect(m.models.map((c) => c.color)).toEqual(
      lb.models.slice(0, 2).map((r) => MODEL_COLORS[r.player]),
    );
  });

  it('shows each model’s overall and per-game win rate, p50 and cost per 1k from the leaderboard', () => {
    const lb = fixtureResults().leaderboard;
    const m = outroModel(lb, GAMES);
    expect(m.pending).toBe(false);
    expect(m.legend).toBe(OUTRO_LEGEND);
    expect(m.models.map((c) => c.label)).toEqual(lb.models.slice(0, 2).map((r) => r.label));
    const [first] = lb.models;
    if (first === undefined) throw new Error('fixture has no models');
    expect(m.models[0]?.overall).toBe(`${((first.overall ?? 0) * 100).toFixed(1)}%`);
    const fighter = m.games.find((g) => g.id === 'fighter');
    const cell = first.games.find((g) => g.game === 'fighter');
    expect(fighter?.cells[0]?.winRate).toBe(
      `${((cell?.headToHead?.winRate.p ?? 0) * 100).toFixed(1)}%`,
    );
    expect(fighter?.cells[0]?.p50).toBe(`p50 ${String(Math.round(cell?.latencyMs.p50 ?? 0))} ms`);
    expect(fighter?.cells[0]?.cost).toMatch(/^\$[\d.]+ \/ 1k$/);
    // Exactly one leader per row (the two win rates sum to 1 in a two-model head-to-head).
    for (const g of m.games) expect(g.cells.filter((c) => c.lead).length).toBe(1);
    expect(m.models.filter((c) => c.lead).length).toBe(1);
  });

  it('marks a game without a head-to-head pending while others show numbers', () => {
    const lb = structuredClone(fixtureResults().leaderboard);
    for (const row of lb.models) {
      const clues = row.games.find((g) => g.game === 'clues');
      if (clues !== undefined) clues.headToHead = null;
    }
    const m = outroModel(lb, GAMES);
    expect(m.pending).toBe(false);
    const clues = m.games.find((g) => g.id === 'clues');
    expect(clues?.pending).toBe(true);
    expect(clues?.cells.map((c) => c.winRate)).toEqual(['—', '—']);
    expect(clues?.cells.some((c) => c.lead)).toBe(false);
  });
});

describe('splitLabel', () => {
  it('splits a label into its name and the parenthetical', () => {
    expect(splitLabel('OpenAI Decisions (gpt-6-luna)')).toEqual({
      name: 'OpenAI Decisions',
      detail: 'gpt-6-luna',
    });
    expect(splitLabel('Jev (TypeSafe)')).toEqual({ name: 'Jev', detail: 'TypeSafe' });
    expect(splitLabel('Scripted bot')).toEqual({ name: 'Scripted bot', detail: '' });
    expect(splitLabel('(odd)')).toEqual({ name: '(odd)', detail: '' });
  });
});
