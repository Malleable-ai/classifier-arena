import { describe, expect, it } from 'vitest';
import { MOVE_IDS } from '../../../src/games/fighter/engine/types.js';
import { buildQuestion } from '../../../src/games/fighter/question.js';
import { createScriptedDecider, scriptedMove } from '../../../src/games/fighter/baselines.js';
import type { FighterView, View } from '../../../src/games/fighter/view.js';
import { createFakeClock } from '../../core/util/fake-clock.js';

const fighter = (over: Partial<FighterView> = {}): FighterView => ({
  health: 100,
  x: 400,
  airborne: false,
  action: 'stand',
  phase: 'idle',
  busy_ticks: 0,
  fireball_ready: true,
  last_moves: [],
  ...over,
});

function view(over: Partial<View> = {}, opp: Partial<FighterView> = {}): View {
  return {
    you: fighter(),
    opponent: fighter(opp),
    distance: 200,
    range: 'mid',
    opponent_fireball: null,
    your_fireball_on_screen: false,
    round: 1,
    round_clock_s: 60,
    rounds_won: { you: 0, opponent: 0 },
    ...over,
  };
}

const close = { distance: 80, range: 'close' } as const;
const far = { distance: 500, range: 'far' } as const;

describe('scriptedMove rules, in order', () => {
  it('1. jumps an incoming fireball (ticks_to_hit < 25)', () => {
    expect(scriptedMove(view({ opponent_fireball: { distance: 100, ticks_to_hit: 17 } }))).toBe(
      'jump_in',
    );
    expect(scriptedMove(view({ opponent_fireball: { distance: 150, ticks_to_hit: 25 } }))).toBe(
      'walk_forward',
    );
  });

  it('2. uppercuts a close airborne opponent', () => {
    expect(scriptedMove(view(close, { airborne: true, action: 'jump_in', phase: 'active' }))).toBe(
      'uppercut',
    );
  });

  it('3. blocks low against an incoming sweep', () => {
    expect(scriptedMove(view(close, { action: 'sweep', phase: 'startup' }))).toBe('block_low');
    expect(scriptedMove(view(close, { action: 'sweep', phase: 'active' }))).toBe('block_low');
  });

  it('4. blocks high against any other strike', () => {
    expect(scriptedMove(view(close, { action: 'jab', phase: 'startup' }))).toBe('block_high');
    expect(scriptedMove(view({}, { action: 'heavy_punch', phase: 'active' }))).toBe('block_high');
  });

  it('5. throws a close blocker', () => {
    expect(scriptedMove(view(close, { action: 'block_high' }))).toBe('throw');
    expect(scriptedMove(view(close, { action: 'block_low' }))).toBe('throw');
  });

  it('6. fireballs at far range when ready', () => {
    expect(scriptedMove(view(far))).toBe('fireball');
  });

  it('7. walks forward at mid range', () => {
    expect(scriptedMove(view())).toBe('walk_forward');
  });

  it('8. jabs at close range', () => {
    expect(scriptedMove(view(close))).toBe('jab');
  });

  it('walks forward at far range when the fireball is not ready', () => {
    expect(scriptedMove(view({ ...far, you: fighter({ fireball_ready: false }) }))).toBe(
      'walk_forward',
    );
  });
});

describe('createScriptedDecider', () => {
  it('waits delayMs on the clock and returns the rule pick', async () => {
    const clock = createFakeClock();
    const d = createScriptedDecider({ clock });
    expect(d.player).toBe('scripted');
    const r = await d.decide(view(close), buildQuestion(MOVE_IDS), new AbortController().signal);
    expect(clock.sleeps).toEqual([200]);
    expect(r).toMatchObject({ choice: 'jab', status: 'ok', latencyMs: 200, costUsd: 0 });
  });
});
