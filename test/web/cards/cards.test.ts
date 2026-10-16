import { describe, expect, it } from 'vitest';
import {
  cardFor,
  cardNames,
  GAME_DESCRIPTIONS,
  type CardData,
} from '../../../src/web/cards/index.js';
import { introTeaser } from '../../../src/web/cards/intro-model.js';
import { REPO_URL } from '../../../src/web/cards/outro-model.js';
import { CARD_FRAMES } from '../../../src/web/cards/timeline.js';
import { SQUARE, WIDE } from '../../../src/web/shell/render-layout.js';
import { GAMES } from '../../../src/games/index.js';
import { fixtureResults } from '../../fixtures/web/results-fixture.js';
import { fakeCtx } from './fake-ctx.js';

const games = GAMES.map((g) => ({ id: g.id, label: g.label }));
const DATA: CardData = { leaderboard: null, games };

/** Every text drawn on `frame`, fully or partly visible. */
function textsAt(name: string, frame: number, data = DATA, size = SQUARE): string[] {
  const card = cardFor(name, data);
  if (card === null) throw new Error(`no card ${name}`);
  const { ctx, texts } = fakeCtx();
  card.draw(ctx, frame, size);
  return texts.filter((t) => t.alpha > 0).map((t) => t.text);
}

describe('cards', () => {
  it('names the intro, a title per game in game order, and the outro', () => {
    expect(cardNames(['fighter', 'inbox', 'clues'])).toEqual([
      'intro',
      'title-fighter',
      'title-inbox',
      'title-clues',
      'outro',
    ]);
  });

  it('has the documented lengths and no card for an unknown name', () => {
    expect(cardFor('intro', DATA)?.frames).toBe(CARD_FRAMES.intro);
    expect(cardFor('title-inbox', DATA)?.frames).toBe(CARD_FRAMES.title);
    expect(cardFor('outro', DATA)?.frames).toBe(CARD_FRAMES.outro);
    expect(cardFor('title-nope', DATA)).toBeNull();
    expect(cardFor('credits', DATA)).toBeNull();
  });

  it('describes the decision of every registered game', () => {
    for (const g of GAMES) expect(GAME_DESCRIPTIONS[g.id], g.id).toBeTruthy();
  });

  it('intro: the matchup, its maker and "three games · same prompt for both", all on frame 0', () => {
    const texts = textsAt('intro', 0);
    expect(texts).toEqual(
      expect.arrayContaining([
        'Jev',
        'vs',
        'OpenAI Decisions',
        'Jev (TypeSafe) vs OpenAI Decisions',
        'three games · same prompt for both',
      ]),
    );
    // Whole from its first frame (the thumbnail), at full opacity.
    const { ctx, texts: drawn } = fakeCtx();
    cardFor('intro', DATA)?.draw(ctx, 0, SQUARE);
    expect(drawn.every((t) => t.alpha === 1)).toBe(true);
    expect(textsAt('intro', 120)).toEqual(texts);
    // No leaderboard: no result teaser.
    expect(texts.join(' ')).not.toContain('won');
  });

  it('intro: a result teaser computed from the leaderboard', () => {
    const lb = fixtureResults().leaderboard;
    const teaser = introTeaser(lb);
    expect(teaser).not.toBeNull();
    const texts = textsAt('intro', 0, { leaderboard: lb, games });
    expect(texts.join(' ')).toContain((teaser?.text ?? '?').split(' ').slice(0, 3).join(' '));
  });

  it('title: the game, its place in the cut and its decision', () => {
    const texts = textsAt('title-clues', 45, DATA, WIDE);
    expect(texts).toContain('Clue Clash');
    expect(texts).toContain('GAME 3 OF 3');
    expect(texts.join(' ')).toContain('definition');
  });

  it('outro: "results pending" without head-to-heads, still with the repo link', () => {
    const texts = textsAt('outro', 299);
    expect(texts).toContain('Results pending');
    expect(texts).toContain(REPO_URL);
    expect(texts).toEqual(expect.arrayContaining(['Fighter', 'Inbox Invaders', 'Clue Clash']));
  });

  it('outro: the overall and per-game numbers from a leaderboard', () => {
    const lb = fixtureResults().leaderboard;
    const texts = textsAt('outro', 299, { leaderboard: lb, games });
    expect(texts).toContain('Results');
    expect(texts).toContain('Overall');
    expect(texts.filter((t) => /^\d+\.\d%$/.test(t)).length).toBe(2 + 2 * 3);
    expect(texts.filter((t) => /^p50 \d/.test(t)).length).toBe(6);
    expect(texts).toContain(REPO_URL);
  });

  it('draws the same texts every time for a frame (deterministic)', () => {
    expect(textsAt('outro', 150)).toEqual(textsAt('outro', 150));
    expect(textsAt('intro', 33)).toEqual(textsAt('intro', 33));
  });
});
