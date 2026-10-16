import { describe, expect, it } from 'vitest';
import { promptConfigHash } from '../../../src/core/classifier/prompt.js';
import type { Seat } from '../../../src/core/classifier/types.js';
import { validateQuestion, type RealtimeInput } from '../../../src/core/game.js';
import { ENGINE_VERSION } from '../../../src/games/fighter/engine/constants.js';
import { hashState } from '../../../src/games/fighter/engine/hash.js';
import { defaultMaxTicks, runScripted } from '../../../src/games/fighter/engine/run.js';
import { DEFAULT_CONFIG, createMatch } from '../../../src/games/fighter/engine/sim.js';
import type { AppliedDecision, EngineConfig } from '../../../src/games/fighter/engine/types.js';
import { MOVE_IDS } from '../../../src/games/fighter/engine/types.js';
import { fighterEstimate } from '../../../src/games/fighter/estimate.js';
import { fighterGame } from '../../../src/games/fighter/game.js';
import { FIGHTER_PROMPT_CONFIG } from '../../../src/games/fighter/prompt.js';
import { FIGHTER_QUESTION, FIGHTER_QUESTION_KEY } from '../../../src/games/fighter/question.js';
import { buildView } from '../../../src/games/fighter/view.js';
import { GAMES, getGame } from '../../../src/games/index.js';
import { createPrng, nextBelow } from '../../../src/core/util/prng.js';

const g = fighterGame;
const SEATS: readonly Seat[] = [0, 1];
const input = (choice: string, questionKey = FIGHTER_QUESTION_KEY): RealtimeInput => ({
  choice,
  questionKey,
});
const jsonRoundTrip = (v: unknown): unknown => JSON.parse(JSON.stringify(v));

describe('fighterGame identity', () => {
  it('is the registered real-time fighter at 60 ticks/s, versioned by the engine', () => {
    expect(GAMES).toContain(g);
    expect(getGame('fighter')).toBe(g);
    expect(g).toMatchObject({
      id: 'fighter',
      label: 'Fighter',
      version: ENGINE_VERSION,
      cadence: { kind: 'realtime', tickRate: 60 },
      graded: false,
      baselines: ['scripted', 'human'],
    });
    expect(g.defaultConfig).toEqual(DEFAULT_CONFIG);
    expect(g.promptConfig).toBe(FIGHTER_PROMPT_CONFIG);
    expect(promptConfigHash(g.promptConfig)).toBe('d7ce85c39c9adebe');
    expect(g.estimate).toBe(fighterEstimate);
    expect(g.maxTicks(DEFAULT_CONFIG)).toBe(defaultMaxTicks(DEFAULT_CONFIG));
  });
});

describe('fighterGame config logging', () => {
  const custom: EngineConfig = {
    maxHealth: 50,
    roundTicks: 600,
    roundsToWin: 3,
    maxRounds: 7,
    bufferTicks: 0,
    roundPauseTicks: 0,
  };

  it('logs every EngineConfig field (the old header config, plus maxHealth)', () => {
    expect(g.logConfig(DEFAULT_CONFIG)).toEqual({
      maxHealth: 100,
      roundTicks: 3600,
      roundsToWin: 2,
      maxRounds: 5,
      bufferTicks: 6,
      roundPauseTicks: 90,
    });
  });

  it.each([
    ['the default', DEFAULT_CONFIG],
    ['a custom', custom],
  ])('round-trips %s config through JSON (configFromLog inverts logConfig)', (_name, config) => {
    const logged = jsonRoundTrip(g.logConfig(config)) as Record<string, unknown>;
    expect(g.configFromLog(logged)).toEqual(config);
    // The rebuilt config creates the same match.
    expect(hashState(g.create(9, g.configFromLog(logged)))).toBe(hashState(createMatch(9, config)));
  });

  it.each([
    ['empty', {}, /fighter: logged config maxHealth must be an integer/],
    ['a missing field', { ...DEFAULT_CONFIG, bufferTicks: undefined }, /bufferTicks must be/],
    ['a fraction', { ...DEFAULT_CONFIG, roundTicks: 60.5 }, /roundTicks must be an integer/],
    ['a string', { ...DEFAULT_CONFIG, maxRounds: '5' }, /maxRounds must be an integer ≥ 1/],
    ['zero rounds', { ...DEFAULT_CONFIG, roundsToWin: 0 }, /roundsToWin must be an integer ≥ 1/],
    ['a negative pause', { ...DEFAULT_CONFIG, roundPauseTicks: -1 }, /roundPauseTicks/],
    ['an unknown field', { ...DEFAULT_CONFIG, tickRate: 60 }, /unknown field "tickRate"/],
  ])('rejects %s logged config, naming the game', (_name, logged, why) => {
    expect(() => g.configFromLog(logged as Record<string, unknown>)).toThrow(why);
  });
});

describe('fighterGame state', () => {
  it('creates the engine match for the seed and config; hash and clone are the engine’s', () => {
    const s = g.create(5, DEFAULT_CONFIG);
    expect(hashState(s)).toBe(hashState(createMatch(5)));
    expect(g.hash(s)).toBe(hashState(s));
    expect(g.hash(g.create(6, DEFAULT_CONFIG))).not.toBe(g.hash(s));
    g.step(s, [input('walk_forward'), null]);
    const c = g.clone(s);
    expect(c).not.toBe(s);
    expect(g.hash(c)).toBe(g.hash(s));
    g.step(c, [null, null]);
    expect(g.tick(c)).toBe(2);
    expect(g.tick(s)).toBe(1);
  });

  it('asks both seats next_move in canonical order, each with its own view', () => {
    const s = g.create(5, DEFAULT_CONFIG);
    for (const seat of SEATS) {
      expect(g.question(s, seat)).toEqual({ key: 'next_move', question: FIGHTER_QUESTION });
      expect(g.view(s, seat)).toEqual(buildView(s, seat));
      expect(jsonRoundTrip(g.view(s, seat))).toEqual(g.view(s, seat));
    }
    const asked = g.question(s, 0);
    if (!asked) throw new Error('no question');
    validateQuestion(asked.question);
    expect(asked.question.name).toBe(g.promptConfig.questionName);
    expect(asked.question.instructions).toBe(g.promptConfig.primer);
    expect(asked.question.options).toEqual(g.promptConfig.options);
  });

  it('can ask only while fighting, and has no question once the match is over', () => {
    const s = g.create(5, { ...DEFAULT_CONFIG, roundTicks: 3, maxRounds: 1 });
    expect(g.canAsk(s, 0)).toBe(true);
    g.step(s, [null, null]);
    g.step(s, [null, null]);
    g.step(s, [null, null]);
    expect(s.status).toBe('matchOver');
    expect(g.canAsk(s, 0)).toBe(false);
    for (const seat of SEATS) expect(g.question(s, seat)).toBeNull();

    const paused = g.create(5, { ...DEFAULT_CONFIG, roundTicks: 3 });
    for (let i = 0; i < 3; i++) g.step(paused, [null, null]);
    expect(paused.status).toBe('roundOver');
    expect(SEATS.map((seat) => g.canAsk(paused, seat))).toEqual([false, false]);
    expect(g.question(paused, 0)).not.toBeNull();
  });

  it('with no answers, every round times out drawn and the match is a draw within maxTicks', () => {
    const s = g.create(5, DEFAULT_CONFIG);
    const limit = g.maxTicks(DEFAULT_CONFIG);
    while (!g.result(s).over) {
      expect(g.result(s).winner).toBeNull();
      g.step(s, [null, null]);
      if (g.tick(s) > limit) throw new Error('ran past maxTicks');
    }
    const { roundTicks, roundPauseTicks, maxRounds } = DEFAULT_CONFIG;
    expect(g.tick(s)).toBe(maxRounds * roundTicks + (maxRounds - 1) * roundPauseTicks);
    expect(g.tick(s)).toBeLessThanOrEqual(limit);
    expect(g.result(s)).toEqual({ over: true, winner: 'draw', scores: [0, 0] });
  });
});

describe('fighterGame.step', () => {
  it('settles each input with the engine’s applied event', () => {
    const s = g.create(5, DEFAULT_CONFIG);
    const out = g.step(s, [input('walk_back'), input('jab')]);
    expect(out).toEqual({
      settlements: [
        { seat: 0, choice: 'walk_back', outcome: 'applied' },
        { seat: 1, choice: 'jab', outcome: 'applied' },
      ],
      events: [],
    });
  });

  it('keeps a hold that arrives while busy as pendingHold, settling it only when it applies', () => {
    const s = g.create(5, DEFAULT_CONFIG);
    g.step(s, [input('heavy_punch'), null]);
    expect(g.step(s, [input('walk_back'), null]).settlements).toEqual([]);
    expect(s.fighters[0].pendingHold).toBe('walk_back');
    const later: unknown[] = [];
    while (s.fighters[0].pendingHold !== null) later.push(...g.step(s, [null, null]).settlements);
    expect(later).toEqual([{ seat: 0, choice: 'walk_back', outcome: 'applied' }]);
  });

  it('reports the engine’s drop reasons: superseded, busy, notFighting', () => {
    const s = g.create(5, DEFAULT_CONFIG);
    g.step(s, [input('uppercut'), null]);
    g.step(s, [input('walk_back'), null]);
    expect(g.step(s, [input('walk_forward'), null]).settlements).toEqual([
      { seat: 0, choice: 'walk_back', outcome: 'dropped', reason: 'superseded' },
    ]);
    const busy = g.create(5, DEFAULT_CONFIG);
    g.step(busy, [input('uppercut'), null]);
    g.step(busy, [input('jab'), null]);
    const dropped: unknown[] = [];
    for (let i = 0; i < 10; i++) dropped.push(...g.step(busy, [null, null]).settlements);
    expect(dropped).toEqual([{ seat: 0, choice: 'jab', outcome: 'dropped', reason: 'busy' }]);

    const paused = g.create(5, { ...DEFAULT_CONFIG, roundTicks: 3 });
    for (let i = 0; i < 3; i++) g.step(paused, [null, null]);
    expect(g.step(paused, [null, input('jab')]).settlements).toEqual([
      { seat: 1, choice: 'jab', outcome: 'dropped', reason: 'notFighting' },
    ]);
  });

  it('drops a stale key or an unknown move without touching the engine', () => {
    const s = g.create(5, DEFAULT_CONFIG);
    const before = g.hash(g.clone(s));
    const out = g.step(s, [input('jab', 'other_question'), input('dance')]);
    expect(out.settlements).toEqual([
      { seat: 0, choice: 'jab', outcome: 'dropped', reason: 'stale' },
      { seat: 1, choice: 'dance', outcome: 'dropped', reason: 'unknown_move' },
    ]);
    const idle = g.create(5, DEFAULT_CONFIG);
    g.step(idle, [null, null]);
    expect(g.hash(s)).toBe(g.hash(idle));
    expect(g.hash(s)).not.toBe(before);
  });

  it('reports each round end as a round_end event with both healths, and scores rounds won', () => {
    const s = g.create(5, { ...DEFAULT_CONFIG, roundTicks: 3, roundPauseTicks: 0 });
    g.step(s, [null, null]);
    g.step(s, [null, null]);
    expect(g.step(s, [null, null]).events).toEqual([
      { kind: 'round_end', round: 1, winner: 'draw', reason: 'timeout', health: [100, 100] },
    ]);
    expect(g.result(s)).toEqual({ over: false, winner: null, scores: [0, 0] });
  });

  it('plays a seeded decision list to the same hash as the engine’s scripted runner', () => {
    const seed = 11;
    const prng = createPrng(99);
    const decisions: AppliedDecision[] = [];
    for (let tick = 0; tick < 4000; tick += 4) {
      const fighter = (tick / 4) % 2 === 0 ? 0 : 1;
      const move = MOVE_IDS[nextBelow(prng, MOVE_IDS.length)];
      if (move) decisions.push({ fighter, appliedTick: tick, move });
    }
    const s = g.create(seed, DEFAULT_CONFIG);
    const byTick = new Map(decisions.map((d) => [d.appliedTick, d]));
    let rounds = 0;
    while (!g.result(s).over && g.tick(s) < g.maxTicks(DEFAULT_CONFIG)) {
      const d = byTick.get(g.tick(s));
      const inputs: [RealtimeInput | null, RealtimeInput | null] = [null, null];
      if (d) inputs[d.fighter] = input(d.move);
      rounds += g.step(s, inputs).events.length;
    }
    const want = runScripted(seed, decisions);
    expect(g.hash(s)).toBe(want.hash);
    expect(rounds).toBe(want.state.roundResults.length);
    expect(g.result(s)).toEqual({
      over: true,
      winner: want.state.winner,
      scores: [want.state.fighters[0].roundsWon, want.state.fighters[1].roundsWon],
    });
  });
});
