import { describe, expect, it } from 'vitest';
import { orderOptions } from '../../src/core/classifier/order.js';
import type { Question, QuestionOption, Seat } from '../../src/core/classifier/types.js';
import {
  isRealtime,
  isTurns,
  validateQuestion,
  type Game,
  type GameEvent,
  type RealtimeInput,
  type Settlement,
  type TurnAnswer,
} from '../../src/core/game.js';
import { createPrng, nextBelow } from '../../src/core/util/prng.js';
import { FIGHTER_QUESTION, FIGHTER_QUESTION_KEY } from '../../src/games/fighter/question.js';
import { GAMES, gameIds, getGame } from '../../src/games/index.js';
import {
  counterRealtime,
  realtimeAnswer,
  type CounterRealtimeState,
} from './games/counter-realtime.js';
import { counterTurns, turnAnswer, type CounterTurnsState } from './games/counter-turns.js';
import { createFakeClock } from './util/fake-clock.js';

const SEATS: readonly Seat[] = [0, 1];
const SEED = 20261007;

/** Both test games, through the erased registry type: this line is the assignability check. */
const TEST_GAMES: readonly Game[] = [counterRealtime, counterTurns];

/** One tick with no inputs, or one turn both seats miss. */
function advance(game: Game, state: unknown): void {
  if (isRealtime(game)) game.step(state, [null, null]);
  else game.applyTurn(state, [null, null]);
}

/** maxTicks or maxTurns for the default config. */
function limitOf(game: Game): number {
  return isRealtime(game) ? game.maxTicks(game.defaultConfig) : game.maxTurns(game.defaultConfig);
}

function progressOf(game: Game, state: unknown): number {
  return isRealtime(game) ? game.tick(state) : game.turn(state);
}

const jsonRoundTrip = (v: unknown): unknown => JSON.parse(JSON.stringify(v));

describe('isRealtime / isTurns', () => {
  it('tell the two cadences apart', () => {
    expect(isRealtime(counterRealtime)).toBe(true);
    expect(isTurns(counterRealtime)).toBe(false);
    expect(isTurns(counterTurns)).toBe(true);
    expect(isRealtime(counterTurns)).toBe(false);
  });

  it('narrow an erased Game to its cadence', () => {
    const kinds = TEST_GAMES.map((g) =>
      isRealtime(g) ? `realtime@${String(g.cadence.tickRate)}` : g.cadence.kind,
    );
    expect(kinds).toEqual(['realtime@60', 'turns']);
  });
});

for (const game of TEST_GAMES) {
  describe(`contract: ${game.id}`, () => {
    it('has a well-formed identity, prompt config, estimate and log config', () => {
      expect(game.id).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(game.label.length).toBeGreaterThan(0);
      expect(Number.isInteger(game.version)).toBe(true);
      expect(game.promptConfig.questionName).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(game.promptConfig.primer.length).toBeGreaterThan(0);
      expect(game.baselines).not.toContain('random');
      // Labels only for the game's own baselines, never blank.
      for (const [id, label] of Object.entries(game.baselineLabels ?? {})) {
        expect(game.baselines).toContain(id);
        expect(label.trim().length).toBeGreaterThan(0);
      }
      const { typical, worst } = game.estimate.decisionsPerSeat;
      expect(typical).toBeGreaterThan(0);
      expect(worst).toBeGreaterThanOrEqual(typical);
      expect(game.estimate.fallbackInputTokens).toBeGreaterThan(0);
      const logged = game.logConfig(game.defaultConfig);
      expect(jsonRoundTrip(logged)).toEqual(logged);
    });

    it('rebuilds its config from the logged one (configFromLog inverts logConfig)', () => {
      const logged = jsonRoundTrip(game.logConfig(game.defaultConfig)) as Record<string, unknown>;
      expect(game.configFromLog(logged)).toEqual(game.defaultConfig);
      expect(() => game.configFromLog({})).toThrow(game.id);
    });

    it('creates the same state for the same seed and a different one for another seed', () => {
      const a = game.create(SEED, game.defaultConfig);
      const b = game.create(SEED, game.defaultConfig);
      const c = game.create(SEED + 1, game.defaultConfig);
      expect(game.hash(a)).toMatch(/^[0-9a-f]{16}$/);
      expect(game.hash(b)).toBe(game.hash(a));
      expect(game.hash(c)).not.toBe(game.hash(a));
      expect(progressOf(game, a)).toBe(0);
    });

    it('keeps the hash stable across clone, and a clone is independent', () => {
      const s = game.create(SEED, game.defaultConfig);
      for (let i = 0; i < 3; i++) advance(game, s);
      const before = game.hash(s);
      const c = game.clone(s);
      expect(c).not.toBe(s);
      expect(game.hash(c)).toBe(before);
      expect(game.hash(game.clone(c))).toBe(before);
      advance(game, c);
      expect(game.hash(c)).not.toBe(before);
      expect(game.hash(s)).toBe(before);
      advance(game, s);
      expect(game.hash(s)).toBe(game.hash(c));
    });

    it('asks both seats the same valid question under the same key', () => {
      const s = game.create(SEED, game.defaultConfig);
      const [q0, q1] = SEATS.map((seat) => game.question(s, seat));
      if (!q0 || !q1) throw new Error('no question at the start');
      expect(q1.key).toBe(q0.key);
      expect(q1.question).toEqual(q0.question);
      expect(() => {
        validateQuestion(q0.question);
      }).not.toThrow();
      expect(q0.question.name).toBe(game.promptConfig.questionName);
      expect(q0.question.instructions).toBe(game.promptConfig.primer);
      if (game.promptConfig.options !== 'per-question') {
        expect(q0.question.options).toEqual(game.promptConfig.options);
      }
    });

    it('gives each seat a JSON-safe view', () => {
      const s = game.create(SEED, game.defaultConfig);
      for (const seat of SEATS) {
        const v = game.view(s, seat);
        expect(jsonRoundTrip(v)).toEqual(v);
      }
    });

    it('runs to its limit with no answers, draws 0-0, then stops asking', () => {
      const s = game.create(SEED, game.defaultConfig);
      const limit = limitOf(game);
      let steps = 0;
      while (!game.result(s).over) {
        expect(game.result(s).winner).toBeNull();
        advance(game, s);
        steps++;
        if (steps > limit) throw new Error('ran past its limit');
      }
      expect(steps).toBe(limit);
      expect(progressOf(game, s)).toBe(limit);
      expect(game.result(s)).toEqual({ over: true, winner: 'draw', scores: [0, 0] });
      for (const seat of SEATS) expect(game.question(s, seat)).toBeNull();
      expect(() => {
        advance(game, s);
      }).toThrow(/over/);
    });
  });
}

describe('counter-realtime', () => {
  const g = counterRealtime;

  /** A realtime input for the window that `tick` falls in. */
  const inputAt = (tick: number, choice: string): RealtimeInput => ({
    choice,
    questionKey: `q${String(Math.floor(tick / 30))}`,
  });

  it('runs at 60 Hz for 600 ticks and asks q<k> with k = floor(tick / 30)', () => {
    expect(g.cadence).toEqual({ kind: 'realtime', tickRate: 60 });
    expect(g.maxTicks(g.defaultConfig)).toBe(600);
    const s = g.create(SEED, g.defaultConfig);
    expect(s.targets).toHaveLength(20);
    const keys = new Map<number, string | undefined>();
    for (let t = 0; t < 600; t++) {
      expect(g.tick(s)).toBe(t);
      for (const seat of SEATS) expect(g.canAsk(s, seat)).toBe(true);
      keys.set(t, g.question(s, 0)?.key);
      g.step(s, [null, null]);
    }
    expect([keys.get(0), keys.get(29), keys.get(30), keys.get(599)]).toEqual([
      'q0',
      'q0',
      'q1',
      'q19',
    ]);
  });

  it('asks up (target even) or down (target odd)', () => {
    const s = g.create(SEED, g.defaultConfig);
    const q = g.question(s, 0);
    expect(q?.question.options.map((o) => o.id)).toEqual(['up', 'down']);
    for (let k = 0; k < s.targets.length; k++) {
      expect(realtimeAnswer(s, k)).toBe((s.targets[k] ?? 0) % 2 === 0 ? 'up' : 'down');
    }
    const answers = new Set(s.targets.map((_, k) => realtimeAnswer(s, k)));
    expect(answers).toEqual(new Set(['up', 'down']));
  });

  it('settles every input on its tick: current key applied with `correct`, stale key dropped', () => {
    const s = g.create(SEED, g.defaultConfig);
    const right = realtimeAnswer(s, 0);
    const wrong = right === 'up' ? 'down' : 'up';
    const first = g.step(s, [inputAt(0, right), inputAt(0, wrong)]);
    expect(first.settlements).toEqual<Settlement[]>([
      { seat: 0, choice: right, outcome: 'applied', correct: true },
      { seat: 1, choice: wrong, outcome: 'applied', correct: false },
    ]);
    expect(g.result(s).scores).toEqual([1, 0]);

    while (g.tick(s) < 30) g.step(s, [null, null]);
    const stale = g.step(s, [inputAt(0, right), { choice: right, questionKey: 'q7' }]);
    expect(stale.settlements).toEqual<Settlement[]>([
      { seat: 0, choice: right, outcome: 'dropped', reason: 'stale' },
      { seat: 1, choice: right, outcome: 'dropped', reason: 'stale' },
    ]);
    expect(g.result(s).scores).toEqual([1, 0]);

    const none = g.step(s, [null, null]);
    expect(none.settlements).toEqual([]);
  });

  it('emits { kind: "window", k } every 30 ticks', () => {
    const s = g.create(SEED, g.defaultConfig);
    const seen: { tick: number; event: GameEvent }[] = [];
    while (!g.result(s).over) {
      const tick = g.tick(s);
      for (const event of g.step(s, [null, null]).events) seen.push({ tick, event });
    }
    expect(seen).toHaveLength(20);
    seen.forEach(({ tick, event }, k) => {
      expect(tick).toBe(k * 30);
      expect(event).toEqual({ kind: 'window', k });
    });
  });

  /**
   * A fixed input list from a seeded PRNG: each seat answers every 5–9 ticks, sometimes with the
   * previous window's key (stale), with a random choice.
   */
  function script(seed: number): Map<number, [RealtimeInput | null, RealtimeInput | null]> {
    const prng = createPrng(seed);
    const out = new Map<number, [RealtimeInput | null, RealtimeInput | null]>();
    for (const seat of SEATS) {
      for (let t = nextBelow(prng, 5); t < 600; t += 5 + nextBelow(prng, 5)) {
        const k = Math.floor(t / 30) - (nextBelow(prng, 4) === 0 ? 1 : 0);
        const choice = nextBelow(prng, 2) === 0 ? 'up' : 'down';
        const input = { choice, questionKey: `q${String(k)}` };
        const pair = out.get(t) ?? [null, null];
        pair[seat] = input;
        out.set(t, pair);
      }
    }
    return out;
  }

  function play(
    s: CounterRealtimeState,
    inputs: Map<number, [RealtimeInput | null, RealtimeInput | null]>,
  ): Settlement[] {
    const settled: Settlement[] = [];
    while (!g.result(s).over) {
      settled.push(...g.step(s, inputs.get(g.tick(s)) ?? [null, null]).settlements);
    }
    return settled;
  }

  it('plays a fixed input list to the same final hash twice, and from a mid-match clone', () => {
    const inputs = script(7);
    const a = g.create(SEED, g.defaultConfig);
    const b = g.create(SEED, g.defaultConfig);
    const settledA = play(a, inputs);
    const settledB = play(b, inputs);
    expect(g.hash(b)).toBe(g.hash(a));
    expect(settledB).toEqual(settledA);
    expect(settledA.some((x) => x.outcome === 'dropped')).toBe(true);
    expect(settledA.some((x) => x.correct === true)).toBe(true);
    expect(settledA.some((x) => x.correct === false)).toBe(true);

    const c = g.create(SEED, g.defaultConfig);
    while (g.tick(c) < 300) g.step(c, inputs.get(g.tick(c)) ?? [null, null]);
    const resumed = g.clone(c);
    play(resumed, inputs);
    expect(g.hash(resumed)).toBe(g.hash(a));
    expect(g.result(resumed)).toEqual(g.result(a));

    const other = g.create(SEED, g.defaultConfig);
    play(other, script(8));
    expect(g.hash(other)).not.toBe(g.hash(a));
  });

  it('scores correct answers and names the winner', () => {
    const s = g.create(SEED, g.defaultConfig);
    while (!g.result(s).over) {
      const t = g.tick(s);
      const k = Math.floor(t / 30);
      // Seat 0 answers right at the start of every window, seat 1 only in even windows.
      const pair: [RealtimeInput | null, RealtimeInput | null] =
        t % 30 === 0
          ? [
              inputAt(t, realtimeAnswer(s, k)),
              k % 2 === 0 ? inputAt(t, realtimeAnswer(s, k)) : null,
            ]
          : [null, null];
      g.step(s, pair);
    }
    expect(g.result(s)).toEqual({ over: true, winner: 0, scores: [20, 10] });
  });

  it('offers a parity baseline that answers from the view', async () => {
    expect(g.baselines).toEqual(['parity']);
    expect(g.baselineLabels).toEqual({ parity: 'Parity bot' });
    if (!g.createBaseline) throw new Error('no createBaseline');
    const clock = createFakeClock();
    const bot = g.createBaseline('parity', { clock, delayMs: 50 });
    expect(bot.player).toBe('parity');
    const s = g.create(SEED, g.defaultConfig);
    const asked = g.question(s, 1);
    if (!asked) throw new Error('no question');
    const r = await bot.decide(g.view(s, 1), asked.question, new AbortController().signal);
    expect(r).toMatchObject({ status: 'ok', choice: realtimeAnswer(s, 0), latencyMs: 50 });
    expect(clock.sleeps).toEqual([50]);
    expect(() => g.createBaseline?.('nope', { clock })).toThrow(/unknown baseline/);
  });
});

describe('counter-turns', () => {
  const g = counterTurns;

  it('plays 10 turns of 4 options under keys t<turn>', () => {
    expect(g.cadence).toEqual({ kind: 'turns' });
    expect(g.maxTurns(g.defaultConfig)).toBe(10);
    expect('createBaseline' in g).toBe(false);
    expect(g.baselines).toEqual([]);
    const s = g.create(SEED, g.defaultConfig);
    const keys: string[] = [];
    const answers = new Set<string>();
    while (!g.result(s).over) {
      const q = g.question(s, 0);
      if (!q) throw new Error('no question');
      expect(q.question.options.map((o) => o.id)).toEqual(['a', 'b', 'c', 'd']);
      keys.push(q.key);
      answers.add(turnAnswer(s));
      g.applyTurn(s, [null, null]);
    }
    expect(keys).toEqual(Array.from({ length: 10 }, (_, t) => `t${String(t)}`));
    expect(answers.size).toBeGreaterThan(1);
  });

  it('gives +1 per correct seat and null for a miss', () => {
    const s = g.create(SEED, g.defaultConfig);
    const right = turnAnswer(s);
    const wrong = ['a', 'b', 'c', 'd'].find((id) => id !== right) ?? '';
    const r1 = g.applyTurn(s, [
      { choice: right, latencyMs: 120.4 },
      { choice: wrong, latencyMs: 80 },
    ]);
    expect(r1.correct).toEqual([true, false]);
    expect(r1.events).toEqual([{ kind: 'turn', turn: 0, answer: right }]);
    const r2 = g.applyTurn(s, [null, { choice: turnAnswer(s), latencyMs: 99.6 }]);
    expect(r2.correct).toEqual([null, true]);
    const r3 = g.applyTurn(s, [{ choice: null, latencyMs: 300 }, null]);
    expect(r3.correct).toEqual([null, null]);
    expect(g.result(s)).toEqual({ over: false, winner: null, scores: [1, 1] });
    expect(s.correctLatencyMs).toEqual([[120], [100]]);
  });

  /** Plays every turn: seat i is right on the turns in `right[i]`, with the given latency. */
  function playTurns(
    right: readonly [readonly number[], readonly number[]],
    latency: readonly [number, number],
  ): CounterTurnsState {
    const s = g.create(SEED, g.defaultConfig);
    while (!g.result(s).over) {
      const t = g.turn(s);
      const correct = turnAnswer(s);
      const wrong = correct === 'a' ? 'b' : 'a';
      const answer = (seat: Seat): TurnAnswer => ({
        choice: right[seat].includes(t) ? correct : wrong,
        latencyMs: latency[seat],
      });
      g.applyTurn(s, [answer(0), answer(1)]);
    }
    return s;
  }

  it('plays fixed answers to the same final hash twice', () => {
    const a = playTurns(
      [
        [0, 2, 4],
        [1, 2],
      ],
      [250, 180],
    );
    const b = playTurns(
      [
        [0, 2, 4],
        [1, 2],
      ],
      [250, 180],
    );
    expect(g.hash(b)).toBe(g.hash(a));
    expect(g.result(a)).toEqual({ over: true, winner: 0, scores: [3, 2] });
  });

  it('breaks ties: higher score, then lower mean correct latency, then a draw', () => {
    // Higher score wins even when slower.
    expect(g.result(playTurns([[0, 1, 2], [0]], [900, 10])).winner).toBe(0);
    // Equal scores: the lower mean latency over correct answers wins.
    expect(
      g.result(
        playTurns(
          [
            [0, 1],
            [3, 4],
          ],
          [300, 299],
        ),
      ).winner,
    ).toBe(1);
    expect(
      g.result(
        playTurns(
          [
            [0, 1],
            [3, 4],
          ],
          [200, 201],
        ),
      ).winner,
    ).toBe(0);
    // Latencies are rounded before the comparison, so 200.4 vs 200.2 is a tie.
    expect(g.result(playTurns([[5], [6]], [200.4, 200.2])).winner).toBe('draw');
    // Equal scores and equal means: a draw.
    expect(
      g.result(
        playTurns(
          [
            [0, 9],
            [4, 7],
          ],
          [150, 150],
        ),
      ).winner,
    ).toBe('draw');
    // Nobody right: a draw.
    expect(g.result(playTurns([[], []], [10, 20]))).toEqual({
      over: true,
      winner: 'draw',
      scores: [0, 0],
    });
  });
});

describe('validateQuestion', () => {
  const opt = (id: string, description = `${id} option`): QuestionOption => ({ id, description });
  const q = (options: QuestionOption[], name = 'pick'): Question => ({
    name,
    instructions: 'Pick one.',
    options,
  });

  it('accepts the fighter question in canonical and match order', () => {
    expect(() => {
      validateQuestion(FIGHTER_QUESTION);
      validateQuestion(orderOptions(FIGHTER_QUESTION, SEED, FIGHTER_QUESTION_KEY));
    }).not.toThrow();
  });

  it("accepts both test games' questions and their ordered forms", () => {
    for (const game of TEST_GAMES) {
      const s = game.create(SEED, game.defaultConfig);
      const asked = game.question(s, 0);
      if (!asked) throw new Error('no question');
      expect(() => {
        validateQuestion(asked.question);
        validateQuestion(orderOptions(asked.question, SEED, asked.key));
      }).not.toThrow();
    }
  });

  it.each([
    ['an integer-like id', '1'],
    ['a zero-padded integer id', '01'],
    ['an id starting with a digit', '1st'],
    ['an id starting with an underscore', '_a'],
    ['a capitalised id', 'Up'],
    ['a hyphenated id', 'walk-forward'],
    ['an empty id', ''],
  ])('rejects %s (%j)', (_, id) => {
    expect(() => {
      validateQuestion(q([opt('a'), opt(id)]));
    }).toThrow(/option id/);
  });

  it('rejects duplicate ids', () => {
    expect(() => {
      validateQuestion(q([opt('a'), opt('b'), opt('a')]));
    }).toThrow(/duplicate option id "a"/);
  });

  it('rejects fewer than two options', () => {
    expect(() => {
      validateQuestion(q([opt('a')]));
    }).toThrow(/at least 2 options/);
    expect(() => {
      validateQuestion(q([]));
    }).toThrow(/at least 2 options/);
  });

  it('rejects empty or blank descriptions', () => {
    expect(() => {
      validateQuestion(q([opt('a'), opt('b', '')]));
    }).toThrow(/empty description/);
    expect(() => {
      validateQuestion(q([opt('a'), opt('b', '  ')]));
    }).toThrow(/empty description/);
  });

  it.each(['next-move', 'Next', '9lives', ''])('rejects the name %j', (name) => {
    expect(() => {
      validateQuestion(q([opt('a'), opt('b')], name));
    }).toThrow(/name/);
  });

  it('runs inside orderOptions, so no invalid question reaches a decider', () => {
    expect(() => orderOptions(q([opt('a'), opt('1')]), 1, 'k')).toThrow(/option id/);
    expect(() => orderOptions(q([opt('a')]), 1, 'k')).toThrow(/at least 2 options/);
  });
});

describe('games registry', () => {
  it('lists unique ids that getGame resolves', () => {
    expect(gameIds()).toEqual(GAMES.map((game) => game.id));
    expect(new Set(gameIds()).size).toBe(GAMES.length);
    for (const game of GAMES) expect(getGame(game.id)).toBe(game);
  });

  it('never registers the test-only games', () => {
    for (const game of TEST_GAMES) {
      expect(gameIds()).not.toContain(game.id);
      expect(() => getGame(game.id)).toThrow(`unknown game "${game.id}"`);
    }
  });

  it('throws on unknown ids', () => {
    expect(() => getGame('nope')).toThrow('unknown game "nope"');
  });
});
