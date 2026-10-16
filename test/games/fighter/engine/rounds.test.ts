import { describe, expect, it } from 'vitest';
import { START_X } from '../../../../src/games/fighter/engine/constants.js';
import { runScripted } from '../../../../src/games/fighter/engine/run.js';
import { createMatch, step } from '../../../../src/games/fighter/engine/sim.js';
import type {
  EngineConfig,
  MatchState,
  StepEvent,
} from '../../../../src/games/fighter/engine/types.js';

const NONE = [null, null] as const;

function match(config: Partial<EngineConfig> = {}): MatchState {
  return createMatch(1, config);
}

function stepN(state: MatchState, n: number): StepEvent[] {
  const events: StepEvent[] = [];
  for (let i = 0; i < n; i++) events.push(...step(state, NONE));
  return events;
}

/** Set health, step once (ending the round), then sit out the pause. */
function endRoundByHealth(state: MatchState, h0: number, h1: number): StepEvent[] {
  state.fighters[0].health = h0;
  state.fighters[1].health = h1;
  const events = step(state, NONE);
  if (state.status === 'roundOver') events.push(...stepN(state, state.config.roundPauseTicks));
  return events;
}

describe('round end', () => {
  it('KO: the fighter at health <= 0 loses the round', () => {
    const s = match();
    s.fighters[1].health = 0;
    const events = step(s, NONE);
    expect(events).toContainEqual({
      type: 'roundEnd',
      tick: 0,
      round: 1,
      winner: 0,
      reason: 'ko',
    });
    expect(s.status).toBe('roundOver');
    expect(s.fighters[0].roundsWon).toBe(1);
    expect(s.roundResults).toEqual([
      { round: 1, winner: 0, reason: 'ko', endTick: 0, health: [100, 0] },
    ]);
  });

  it('negative health is a KO too', () => {
    const s = match();
    s.fighters[0].health = -7;
    step(s, NONE);
    expect(s.roundResults[0]?.winner).toBe(1);
  });

  it('double KO is a drawn round that counts for nobody', () => {
    const s = match();
    s.fighters[0].health = 0;
    s.fighters[1].health = -3;
    const events = step(s, NONE);
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'roundEnd', winner: 'draw', reason: 'doubleKo' }),
    );
    expect(s.fighters[0].roundsWon).toBe(0);
    expect(s.fighters[1].roundsWon).toBe(0);
    expect(s.status).toBe('roundOver');
  });

  it('timeout: higher health wins at roundTick === roundTicks', () => {
    const s = match({ roundTicks: 20 });
    s.fighters[0].health = 40;
    s.fighters[1].health = 41;
    const before = stepN(s, 19);
    expect(before.some((e) => e.type === 'roundEnd')).toBe(false);
    expect(s.status).toBe('fighting');
    const events = step(s, NONE);
    expect(s.roundTick).toBe(20);
    expect(events).toContainEqual({
      type: 'roundEnd',
      tick: 19,
      round: 1,
      winner: 1,
      reason: 'timeout',
    });
    expect(s.fighters[1].roundsWon).toBe(1);
  });

  it('timeout tie is a drawn round and an extra round is played', () => {
    const s = match({ roundTicks: 10, roundPauseTicks: 5 });
    stepN(s, 10);
    expect(s.roundResults).toEqual([
      { round: 1, winner: 'draw', reason: 'timeout', endTick: 9, health: [100, 100] },
    ]);
    expect(s.status).toBe('roundOver');
    stepN(s, 5);
    expect(s.status).toBe('fighting');
    expect(s.round).toBe(2);
  });
});

describe('match end', () => {
  it('best of 3 ends when a fighter reaches 2 round wins', () => {
    const s = match({ roundPauseTicks: 3 });
    endRoundByHealth(s, 100, 0);
    expect(s.status).toBe('fighting');
    endRoundByHealth(s, 0, 100);
    expect(s.status).toBe('fighting');
    expect(s.round).toBe(3);
    s.fighters[0].health = 0;
    const events = step(s, NONE);
    expect(s.status).toBe('matchOver');
    expect(s.winner).toBe(1);
    expect(events.map((e) => e.type)).toEqual(['roundEnd', 'matchEnd']);
    expect(events[1]).toEqual({ type: 'matchEnd', tick: s.tick - 1, winner: 1 });
  });

  it('2-0 ends the match after two rounds', () => {
    const s = match({ roundPauseTicks: 3 });
    endRoundByHealth(s, 100, 0);
    endRoundByHealth(s, 100, -5);
    expect(s.status).toBe('matchOver');
    expect(s.winner).toBe(0);
    expect(s.roundResults).toHaveLength(2);
  });

  it('drawn rounds do not count toward the win', () => {
    const s = match({ roundPauseTicks: 2 });
    endRoundByHealth(s, 100, 0);
    endRoundByHealth(s, 0, 0);
    endRoundByHealth(s, 0, 0);
    expect(s.status).toBe('fighting');
    expect(s.fighters[0].roundsWon).toBe(1);
    endRoundByHealth(s, 50, 0);
    expect(s.status).toBe('matchOver');
    expect(s.winner).toBe(0);
  });

  it('5 drawn rounds make the match a draw', () => {
    const { state, events } = runScripted(3, [], {
      config: { roundTicks: 30, roundPauseTicks: 4 },
    });
    expect(state.status).toBe('matchOver');
    expect(state.winner).toBe('draw');
    expect(state.roundResults).toHaveLength(5);
    expect(state.roundResults.every((r) => r.winner === 'draw' && r.reason === 'timeout')).toBe(
      true,
    );
    expect(events.filter((e) => e.type === 'matchEnd')).toEqual([
      { type: 'matchEnd', tick: 5 * 30 + 4 * 4 - 1, winner: 'draw' },
    ]);
  });

  it('after maxRounds without a match winner (1-1 plus draws) the match is a draw', () => {
    const s = match({ roundPauseTicks: 1 });
    endRoundByHealth(s, 100, 0);
    endRoundByHealth(s, 0, 100);
    endRoundByHealth(s, 0, 0);
    endRoundByHealth(s, 0, 0);
    endRoundByHealth(s, 0, 0);
    expect(s.status).toBe('matchOver');
    expect(s.winner).toBe('draw');
  });

  it('step is a no-op after the match ends', () => {
    const s = match();
    s.fighters[1].health = 0;
    step(s, NONE);
    s.fighters[1].health = 0;
    stepN(s, s.config.roundPauseTicks);
    s.fighters[1].health = 0;
    step(s, NONE);
    expect(s.status).toBe('matchOver');
    const tick = s.tick;
    expect(step(s, ['jab', 'jab'])).toEqual([]);
    expect(s.tick).toBe(tick);
  });
});

describe('between rounds', () => {
  it('the pause lasts exactly roundPauseTicks (90 by default) ticks', () => {
    const s = match();
    expect(s.config.roundPauseTicks).toBe(90);
    s.fighters[1].health = 0;
    step(s, NONE);
    const endTick = s.tick - 1;
    expect(s.pauseTicksLeft).toBe(90);
    stepN(s, 89);
    expect(s.status).toBe('roundOver');
    expect(s.round).toBe(1);
    step(s, NONE);
    expect(s.status).toBe('fighting');
    expect(s.round).toBe(2);
    expect(s.tick).toBe(endTick + 1 + 90);
  });

  it('the round clock is frozen during the pause', () => {
    const s = match({ roundPauseTicks: 10 });
    stepN(s, 5);
    s.fighters[0].health = 0;
    step(s, NONE);
    expect(s.roundTick).toBe(6);
    stepN(s, 9);
    expect(s.roundTick).toBe(6);
  });

  it('resets positions, health, projectiles, cooldowns, buffer and lastMoves; keeps roundsWon', () => {
    const s = match({ roundPauseTicks: 5 });
    step(s, ['walk_forward', 'walk_back']);
    stepN(s, 10);
    const [a, b] = s.fighters;
    a.health = 0;
    b.health = 37;
    a.fireballCooldown = 50;
    b.fireballCooldown = 12;
    a.invulnTicks = 4;
    b.buffered = { move: 'jab', ticksLeft: 3 };
    a.lastMoves = ['jab', 'sweep', 'throw'];
    s.projectiles.push({ owner: 1, x: 40000, vx: -500, active: true });
    expect(a.x).not.toBe(START_X[0]);
    step(s, NONE);
    stepN(s, 5);

    expect(s.status).toBe('fighting');
    expect(s.round).toBe(2);
    expect(s.roundTick).toBe(0);
    expect(s.projectiles).toEqual([]);
    for (const side of [0, 1] as const) {
      const f = s.fighters[side];
      expect(f.x).toBe(START_X[side]);
      expect(f.y).toBe(0);
      expect(f.vx).toBe(0);
      expect(f.health).toBe(100);
      expect(f.fireballCooldown).toBe(0);
      expect(f.invulnTicks).toBe(0);
      expect(f.buffered).toBeNull();
      expect(f.lastMoves).toEqual([]);
      expect(f.action).toBe('stand');
      expect(f.phase).toBe('idle');
    }
    expect(s.fighters[1].roundsWon).toBe(1);
    expect(s.fighters[0].roundsWon).toBe(0);
  });

  it('inputs during the pause are dropped and have no effect', () => {
    const s = match({ roundPauseTicks: 4 });
    s.fighters[0].health = 0;
    step(s, NONE);
    const events = step(s, ['walk_forward', 'jab']);
    expect(events).toEqual([
      {
        type: 'dropped',
        tick: s.tick - 1,
        fighter: 0,
        move: 'walk_forward',
        reason: 'notFighting',
      },
      { type: 'dropped', tick: s.tick - 1, fighter: 1, move: 'jab', reason: 'notFighting' },
    ]);
    stepN(s, 3);
    expect(s.status).toBe('fighting');
    expect(s.fighters[0].action).toBe('stand');
    expect(s.fighters[0].lastMoves).toEqual([]);
    expect(s.fighters[1].lastMoves).toEqual([]);
    stepN(s, 5);
    expect(s.fighters[0].x).toBe(START_X[0]);
  });

  it('a pause of 0 starts the next round on the same tick', () => {
    const s = match({ roundPauseTicks: 0 });
    s.fighters[0].health = 0;
    step(s, NONE);
    expect(s.status).toBe('fighting');
    expect(s.round).toBe(2);
    expect(s.fighters[0].health).toBe(100);
  });
});

describe('runScripted', () => {
  it('feeds decisions on their appliedTick, sorting stably', () => {
    const { events } = runScripted(
      1,
      [
        { fighter: 1, appliedTick: 5, move: 'walk_back' },
        { fighter: 0, appliedTick: 2, move: 'walk_forward' },
      ],
      { maxTicks: 10 },
    );
    const applied = events.filter((e) => e.type === 'applied');
    expect(applied).toEqual([
      { type: 'applied', tick: 2, fighter: 0, move: 'walk_forward' },
      { type: 'applied', tick: 5, fighter: 1, move: 'walk_back' },
    ]);
  });

  it('the last decision wins when a fighter has several on one tick', () => {
    const { events } = runScripted(
      1,
      [
        { fighter: 0, appliedTick: 3, move: 'walk_forward' },
        { fighter: 0, appliedTick: 3, move: 'block_low' },
      ],
      { maxTicks: 5 },
    );
    expect(events.filter((e) => e.type === 'applied')).toEqual([
      { type: 'applied', tick: 3, fighter: 0, move: 'block_low' },
    ]);
  });

  it('stops at maxTicks', () => {
    const { state } = runScripted(1, [], { maxTicks: 42 });
    expect(state.tick).toBe(42);
    expect(state.status).toBe('fighting');
  });

  it('rejects a negative or fractional appliedTick', () => {
    expect(() => runScripted(1, [{ fighter: 0, appliedTick: -1, move: 'jab' }])).toThrow();
    expect(() => runScripted(1, [{ fighter: 0, appliedTick: 1.5, move: 'jab' }])).toThrow();
  });
});
