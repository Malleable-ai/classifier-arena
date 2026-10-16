import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Leaderboard } from '../../../src/core/stats/leaderboard.js';
import { introTeaser } from '../../../src/web/cards/intro-model.js';
import { fixtureResults } from '../../fixtures/web/results-fixture.js';

const published = (): Leaderboard =>
  JSON.parse(readFileSync('results/leaderboard.json', 'utf8')) as Leaderboard;

describe('introTeaser', () => {
  it('is computed from the published leaderboard: the leader’s head-to-head wins over every game', () => {
    const lb = published();
    const [top] = lb.models;
    if (top === undefined) throw new Error('no models');
    let wins = 0;
    let draws = 0;
    let matches = 0;
    for (const g of top.games) {
      wins += g.headToHead?.wins ?? 0;
      draws += g.headToHead?.draws ?? 0;
      matches += g.headToHead?.matches ?? 0;
    }
    const pct = Math.round(((wins + draws / 2) / matches) * 100);
    const t = introTeaser(lb);
    expect(t?.player).toBe(top.player);
    expect(t?.text).toContain(`won ${String(wins)}`);
    expect(t?.text).toContain(`of ${String(matches)} head-to-head matches (${String(pct)}%)`);
    expect(t?.text.startsWith(top.label.replace(/\s*\(.*\)\s*$/, ''))).toBe(true);
  });

  it('says draws when there were any, and follows the numbers it is given', () => {
    const lb = fixtureResults().leaderboard;
    const t = introTeaser(lb);
    expect(t).not.toBeNull();
    const top = lb.models[0];
    const draws = top?.games.reduce((n, g) => n + (g.headToHead?.draws ?? 0), 0) ?? 0;
    expect(t?.text.includes(' drew ')).toBe(draws > 0);
  });

  it('is null with no leaderboard, no head-to-head, or a tie at the top', () => {
    expect(introTeaser(null)).toBeNull();
    const lb = published();
    const none: Leaderboard = {
      ...lb,
      models: lb.models.map((m) => ({ ...m, overall: null })),
    };
    expect(introTeaser(none)).toBeNull();
    const tied: Leaderboard = { ...lb, models: lb.models.map((m) => ({ ...m, overall: 0.5 })) };
    expect(introTeaser(tied)).toBeNull();
  });
});
