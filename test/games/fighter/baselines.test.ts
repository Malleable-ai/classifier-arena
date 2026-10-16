import { describe, expect, it } from 'vitest';
import { gameBaselines, listPlayers } from '../../../src/core/classifier/players.js';
import { PROVIDERS } from '../../../src/core/classifier/providers.js';
import {
  FIGHTER_BASELINE_IDS,
  FIGHTER_BASELINE_LABELS,
  createFighterBaseline,
} from '../../../src/games/fighter/baselines.js';
import { MOVE_IDS } from '../../../src/games/fighter/engine/types.js';
import { fighterGame } from '../../../src/games/fighter/game.js';
import type { HumanInput } from '../../../src/games/fighter/human.js';
import { FIGHTER_QUESTION } from '../../../src/games/fighter/question.js';
import { createFakeClock } from '../../core/util/fake-clock.js';
import { SAMPLE_VIEW } from './sample-view.js';

describe('fighter baselines', () => {
  const clock = createFakeClock();

  it('lists the same players as before the move: providers, then random, scripted, human', () => {
    const players = listPlayers({ OPENAI_API_KEY: 'k' }, PROVIDERS, gameBaselines(fighterGame));
    expect(players.map((p) => [p.id, p.kind, p.available, p.label])).toEqual([
      ['jev', 'provider', false, 'Jev (TypeSafe)'],
      ['openai', 'provider', true, 'OpenAI Decisions (gpt-6-luna)'],
      ['random', 'baseline', true, 'Random (uniform)'],
      ['scripted', 'baseline', true, 'Scripted bot'],
      ['human', 'baseline', true, 'Human (live mode)'],
    ]);
  });

  it('are the game’s baselines besides core random, each with a label', () => {
    expect(fighterGame.baselines).toEqual(['scripted', 'human']);
    expect(FIGHTER_BASELINE_IDS).toEqual(fighterGame.baselines);
    expect(fighterGame.baselineLabels).toBe(FIGHTER_BASELINE_LABELS);
    expect(Object.keys(FIGHTER_BASELINE_LABELS)).toEqual([...fighterGame.baselines]);
    expect(gameBaselines(fighterGame)).toEqual([
      { id: 'random', label: 'Random (uniform)' },
      { id: 'scripted', label: 'Scripted bot' },
      { id: 'human', label: 'Human (live mode)' },
    ]);
  });

  it('builds scripted through the game, honouring the delay', async () => {
    const scripted = fighterGame.createBaseline?.('scripted', { clock, delayMs: 30 });
    if (!scripted) throw new Error('no createBaseline');
    expect(scripted.player).toBe('scripted');
    const r = await scripted.decide(SAMPLE_VIEW, FIGHTER_QUESTION, new AbortController().signal);
    expect(r).toMatchObject({ status: 'ok', latencyMs: 30 });
    expect(MOVE_IDS).toContain(r.choice);
  });

  it('builds human from deps.extra.humanInput, and requires it', () => {
    const humanInput: HumanInput = { onMove: () => () => undefined };
    expect(createFighterBaseline('human', { clock, extra: { humanInput } }).player).toBe('human');
    expect(() => createFighterBaseline('human', { clock })).toThrow(/humanInput/);
    expect(() => createFighterBaseline('human', { clock, extra: { humanInput: {} } })).toThrow(
      /humanInput/,
    );
  });

  it('throws on a baseline the fighter does not have', () => {
    expect(() => createFighterBaseline('random', { clock })).toThrow(/no baseline "random"/);
    expect(() => createFighterBaseline('nope', { clock })).toThrow(/no baseline "nope"/);
  });
});
