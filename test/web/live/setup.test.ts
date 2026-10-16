import { describe, expect, it } from 'vitest';
import { gameBaselines, listPlayers } from '../../../src/core/classifier/players.js';
import { PROVIDERS } from '../../../src/core/classifier/providers.js';
import type { EstimateResponse } from '../../../src/core/classifier/remote.js';
import { emptyResult, type Decider } from '../../../src/core/classifier/types.js';
import type { RealtimeGame, RealtimeInput, TurnGame } from '../../../src/core/game.js';
import { matchIdFor } from '../../../src/core/results/paths.js';
import { playerMeta } from '../../../src/core/sched/shared.js';
import { createRealtimeRunner } from '../../../src/core/sched/realtime.js';
import { driveRealtime } from '../../../src/core/sched/drive.js';
import { createTurnRunner } from '../../../src/core/sched/turns.js';
import { SimClock } from '../../../src/core/util/clock.js';
import { createMatch } from '../../../src/games/fighter/engine/sim.js';
import type { MoveId } from '../../../src/games/fighter/engine/types.js';
import { fighterGame } from '../../../src/games/fighter/game.js';
import { FIGHTER_QUESTION } from '../../../src/games/fighter/question.js';
import { buildView } from '../../../src/games/fighter/view.js';
import { GAMES } from '../../../src/games/index.js';
import { MATCH_ID_RE } from '../../../src/server/proxy.js';
import {
  createKeyboardHumanInput,
  createKeyState,
  keyDown,
} from '../../../src/web/games/fighter/keyboard.js';
import { fighterRenderer } from '../../../src/web/games/fighter/renderer.js';
import { rendererFor } from '../../../src/web/games/index.js';
import { decision, failure, fakeLog, type FakeMatch } from '../../core/stats/helpers.js';
import {
  createEstimateCache,
  createRunLatch,
  defaultPicks,
  driveLiveRealtime,
  driveLiveTurns,
  estimatePath,
  liveDecider,
  liveGames,
  liveInvalidNote,
  matchErrorMessage,
  playerOptions,
  playersPath,
  startGate,
  tapSteps,
  withZeroLatency,
  type LivePlayer,
} from '../../../src/web/live/setup.js';
import {
  counterRealtime,
  type CounterRealtimeConfig,
  type CounterRealtimeState,
} from '../../core/games/counter-realtime.js';
import {
  counterTurns,
  type CounterTurnsConfig,
  type CounterTurnsState,
} from '../../core/games/counter-turns.js';
import {
  COMMON,
  baselineMeta,
  fakeDecider,
  memorySink,
  settleOnSim,
} from '../../core/sched/helpers.js';

// OpenAI keys set, Jev's not. The fighter's baselines as the proxy lists them.
const FIGHTER_BASELINES = gameBaselines(fighterGame);
const players: LivePlayer[] = listPlayers(
  { OPENAI_API_KEY: 'x' },
  PROVIDERS,
  FIGHTER_BASELINES,
).map((p) => ({
  ...p,
  meta: playerMeta(p.id, PROVIDERS, FIGHTER_BASELINES),
}));
const est = (totalUsd: number): EstimateResponse => ({
  totalUsd,
  typicalUsd: totalUsd / 2,
  limitUsd: 5,
  text: '',
});

describe('game picker', () => {
  it('lists the registered games that have a renderer', () => {
    expect(liveGames(GAMES, (id) => rendererFor(id) !== null)).toEqual([
      { value: 'fighter', label: 'Fighter' },
      { value: 'inbox', label: 'Inbox Invaders' },
      { value: 'clues', label: 'Clue Clash' },
    ]);
    const games = [
      { id: 'fighter', label: 'Fighter' },
      { id: 'clues', label: 'Clue Clash' },
    ];
    expect(liveGames(games, (id) => id === 'clues')).toEqual([
      { value: 'clues', label: 'Clue Clash' },
    ]);
  });
});

describe('proxy URLs', () => {
  it('always name the game', () => {
    expect(playersPath('fighter')).toBe('/players?game=fighter');
    expect(estimatePath('fighter', 'jev', 'random')).toBe('/estimate?game=fighter&a=jev&b=random');
    const url = new URL(estimatePath('clue_clash', 'a b', 'c&d'), 'http://x');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      game: 'clue_clash',
      a: 'a b',
      b: 'c&d',
    });
  });
});

describe('player options', () => {
  it('disables providers without keys and marks paid ones', () => {
    const opts = Object.fromEntries(playerOptions(players).map((o) => [o.value, o]));
    expect(opts.jev?.disabled).toBe(true);
    expect(opts.jev?.label).toContain('keys not set: TYPESAFE_API_KEY');
    expect(opts.openai?.disabled).toBe(false);
    expect(opts.openai?.label).toContain('paid');
    expect(opts.human?.disabled).toBe(false);
  });

  it('picks human vs scripted where the game has them, else random', () => {
    expect(defaultPicks(players)).toEqual(['human', 'scripted']);
    const randomOnly = players.filter((p) => p.kind === 'provider' || p.id === 'random');
    expect(defaultPicks(randomOnly)).toEqual(['random', 'random']);
  });
});

describe('start gate', () => {
  it('lets baselines and human start for free', () => {
    expect(startGate(players, 'human', 'random', null, false)).toMatchObject({
      canStart: true,
      paid: false,
    });
  });

  it('blocks unavailable providers and human vs human', () => {
    expect(startGate(players, 'jev', 'random', null, true).canStart).toBe(false);
    expect(startGate(players, 'human', 'human', null, true).canStart).toBe(false);
  });

  it('needs the estimate, then an explicit confirm, for a paid provider', () => {
    expect(startGate(players, 'openai', 'human', null, true)).toMatchObject({
      canStart: false,
      paid: true,
    });
    const unconfirmed = startGate(players, 'openai', 'human', est(0.06), false);
    expect(unconfirmed).toMatchObject({ canStart: false, needsConfirm: true });
    expect(unconfirmed.message).toContain('$0.0600 worst case');
    expect(startGate(players, 'openai', 'human', est(0.06), true).canStart).toBe(true);
  });

  it('refuses anything estimated over $5, even confirmed', () => {
    const g = startGate(players, 'openai', 'random', est(5.01), true);
    expect(g).toMatchObject({ canStart: false, needsConfirm: false });
    expect(g.message).toContain('over the $5 limit');
    expect(startGate(players, 'openai', 'random', est(5), true).canStart).toBe(true);
  });
});

describe('live match id', () => {
  it('uses the CLI format, with the game', () => {
    const when = new Date(2026, 9, 7, 9, 5, 3);
    expect(matchIdFor({ game: 'fighter', a: 'human', b: 'openai', when, run: 1 })).toBe(
      '20261007-090503-fighter-human-vs-openai-1',
    );
  });

  it('produces only ids the proxy accepts, and refuses player ids it would reject', () => {
    const when = new Date(2026, 9, 7, 9, 5, 3);
    const id = (a: string, b: string) => matchIdFor({ game: 'fighter', a, b, when, run: 12 });
    expect(MATCH_ID_RE.test(id('clef_flash', 'openai'))).toBe(true);
    for (const bad of ['my.clef', 'Clef', 'clef-flash', '', 'a/b']) {
      expect(() => id(bad, 'openai')).toThrow(/player id/);
      expect(() => id('openai', bad)).toThrow(/player id/);
    }
  });
});

describe('estimate cache', () => {
  const deferred = () => {
    let resolve!: (e: EstimateResponse) => void;
    let reject!: (err: Error) => void;
    const promise = new Promise<EstimateResponse>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };

  it('keys estimates by game and pair, so a late answer never blocks or replaces another', async () => {
    const calls: Record<string, ReturnType<typeof deferred>> = {};
    const cache = createEstimateCache((g, a, b) => {
      const d = deferred();
      calls[`${g}:${a}+${b}`] = d;
      return d.promise;
    });
    const loadA = cache.load('fighter', 'openai', 'random');
    const loadB = cache.load('fighter', 'openai', 'scripted');
    const loadC = cache.load('clues', 'openai', 'random');
    // Back to A while all are in flight: no second fetch, the same promise.
    expect(cache.load('fighter', 'openai', 'random')).toBe(loadA);
    expect(Object.keys(calls)).toHaveLength(3);
    calls['fighter:openai+random']?.resolve(est(1));
    await loadA;
    expect(cache.get('fighter', 'openai', 'random')?.totalUsd).toBe(1);
    expect(cache.get('fighter', 'openai', 'scripted')).toBeNull();
    expect(cache.get('clues', 'openai', 'random')).toBeNull();
    calls['fighter:openai+scripted']?.resolve(est(2));
    calls['clues:openai+random']?.resolve(est(3));
    await Promise.all([loadB, loadC]);
    expect(cache.get('fighter', 'openai', 'random')?.totalUsd).toBe(1);
    expect(cache.get('fighter', 'openai', 'scripted')?.totalUsd).toBe(2);
    expect(cache.get('clues', 'openai', 'random')?.totalUsd).toBe(3);
    // Cached: no new fetch.
    await cache.load('fighter', 'openai', 'random');
    expect(Object.keys(calls)).toHaveLength(3);
  });

  it('forgets a failed fetch so the pair can be retried', async () => {
    let n = 0;
    const cache = createEstimateCache(() => {
      n += 1;
      return n === 1 ? Promise.reject(new Error('down')) : Promise.resolve(est(1));
    });
    await expect(cache.load('fighter', 'openai', 'random')).rejects.toThrow('down');
    expect(cache.get('fighter', 'openai', 'random')).toBeNull();
    await cache.load('fighter', 'openai', 'random');
    expect(cache.get('fighter', 'openai', 'random')?.totalUsd).toBe(1);
    expect(n).toBe(2);
  });
});

describe('run latch', () => {
  it('lets only one match start until it is released', () => {
    const latch = createRunLatch();
    expect(latch.busy).toBe(false);
    expect(latch.tryEnter()).toBe(true);
    expect(latch.busy).toBe(true);
    expect(latch.tryEnter()).toBe(false);
    latch.leave();
    expect(latch.busy).toBe(false);
    expect(latch.tryEnter()).toBe(true);
  });
});

describe('seat deciders', () => {
  const base = {
    game: fighterGame,
    players,
    seed: 7,
    matchId: '20261007-090503-fighter-openai-vs-random-1',
    clock: new SimClock(),
  };

  it('builds random, the game baselines and the keyboard human', () => {
    expect(liveDecider({ ...base, id: 'random', seat: 0 }).player).toBe('random');
    expect(liveDecider({ ...base, id: 'scripted', seat: 1 }).player).toBe('scripted');
    const keys = createKeyState();
    const input = createKeyboardHumanInput(keys).input;
    expect(liveDecider({ ...base, id: 'human', seat: 0, humanInput: input }).player).toBe('human');
    expect(() => liveDecider({ ...base, id: 'human', seat: 0 })).toThrow(/humanInput/);
    expect(() => liveDecider({ ...base, id: 'nobody', seat: 0 })).toThrow(/unknown player/);
  });

  it('sends providers to the proxy with the game id (never in-process)', () => {
    const asked: [string, number][] = [];
    const fake: Decider = { player: 'openai', decide: () => Promise.resolve(emptyResult('ok', 1)) };
    const d = liveDecider({
      ...base,
      id: 'openai',
      seat: 1,
      remote: (player, seat) => {
        asked.push([player, seat]);
        return fake;
      },
    });
    expect(d).toBe(fake);
    expect(asked).toEqual([['openai', 1]]);
    // The default is the proxy's remote decider, which names the game in every request.
    const remote = liveDecider({ ...base, id: 'openai', seat: 1 });
    expect(remote.player).toBe('openai');
  });
});

describe('keyboard human input', () => {
  it('hands a pressed one-shot to a waiting request and stays quiet without one', () => {
    const keys = createKeyState();
    const h = createKeyboardHumanInput(keys);
    const state = createMatch(1);
    state.status = 'fighting';
    const got: MoveId[] = [];
    keyDown(keys, 'KeyJ');
    h.pump(state, 0); // nobody listening: the press stays queued
    expect(keys.queued).toEqual(['jab']);
    const off = h.input.onMove((m) => got.push(m));
    h.pump(state, 0);
    off();
    expect(got).toEqual(['jab']);
  });

  it('drops queued presses between rounds', () => {
    const keys = createKeyState();
    const h = createKeyboardHumanInput(keys);
    const state = createMatch(1);
    state.status = 'roundOver';
    keyDown(keys, 'KeyK');
    h.pump(state, 1);
    expect(keys.queued).toEqual([]);
  });

  it('is offered by the fighter renderer, with its help text', () => {
    const controls = fighterRenderer.human?.();
    expect(controls?.help).toContain('J jab');
    expect(controls?.input).toBeDefined();
  });

  it('logs human decisions with latency 0, passing the seq through', async () => {
    const seqs: (number | undefined)[] = [];
    const slow: Decider = {
      player: 'human',
      decide: (_state, _question, _signal, ctx) => {
        seqs.push(ctx?.seq);
        return Promise.resolve(emptyResult('ok', 850, 'jab'));
      },
    };
    const view = buildView(createMatch(1), 0);
    const r = await withZeroLatency(slow).decide(
      view,
      FIGHTER_QUESTION,
      new AbortController().signal,
      { seq: 7 },
    );
    expect(r).toMatchObject({ choice: 'jab', latencyMs: 0 });
    expect(seqs).toEqual([7]);
  });
});

describe('tapSteps', () => {
  it('reports every step with the state before it, and leaves the match unchanged', async () => {
    const run = async (tap: boolean) => {
      const clock = new SimClock();
      const sink = memorySink();
      const seen: { before: number; after: number; inputs: unknown }[] = [];
      const parity = (delayMs: number) =>
        counterRealtime.createBaseline?.('parity', { clock, delayMs });
      const a = parity(130);
      const b = parity(170);
      if (!a || !b) throw new Error('no parity baseline');
      const game = tap
        ? tapSteps(counterRealtime, (before, inputs, after) => {
            seen.push({ before: before.tick, after: after.tick, inputs });
          })
        : counterRealtime;
      const runner = createRealtimeRunner({
        game,
        seed: 3,
        config: counterRealtime.defaultConfig,
        seats: [baselineMeta('parity'), baselineMeta('parity')],
        deciders: [a, b],
        clock,
        sink,
        ...COMMON,
      });
      await driveRealtime(runner, clock);
      return { lines: sink.lines, seen };
    };
    const plain = await run(false);
    const tapped = await run(true);
    expect(JSON.stringify(tapped.lines)).toBe(JSON.stringify(plain.lines));
    const end = plain.lines.at(-1);
    if (end?.type !== 'match_end') throw new Error('no match_end');
    expect(tapped.seen).toHaveLength(end.totalTicks);
    expect(tapped.seen.every((s, i) => s.before === i && s.after === i + 1)).toBe(true);
    const fed = tapped.seen.filter((s) =>
      (s.inputs as readonly (RealtimeInput | null)[]).some((x) => x !== null),
    );
    expect(fed.length).toBeGreaterThan(0);
  });
});

describe('driving a live match', () => {
  it('drives a real-time match to its end on the schedule it is given', async () => {
    const clock = new SimClock();
    const parity = counterRealtime.createBaseline?.('parity', { clock, delayMs: 120 });
    if (!parity) throw new Error('no parity baseline');
    const runner = createRealtimeRunner({
      ...COMMON,
      game: counterRealtime,
      seed: 4,
      config: { windows: 2 },
      seats: [baselineMeta('parity'), baselineMeta('parity')],
      deciders: [parity, parity],
      clock,
      sink: memorySink(),
    });
    await runner.start();
    const queue: (() => void)[] = [];
    const outcome: string[] = [];
    let pumped = 0;
    driveLiveRealtime(runner, {
      now: () => clock.now(),
      schedule: (fn) => queue.push(fn),
      beforeAdvance: () => pumped++,
      onDone: () => {
        outcome.push('done');
      },
      onError: () => {
        outcome.push('error');
      },
    });
    for (let fn = queue.shift(); fn; fn = queue.shift()) {
      await clock.advanceTo(runner.nextTickDueMs());
      fn();
    }
    expect(outcome).toEqual(['done']);
    expect(runner.result?.totalTicks).toBe(60);
    expect(pumped).toBeGreaterThan(0);
  });

  it('stops a real-time match whose runner throws: no more ticks, requests aborted, onError once', async () => {
    const clock = new SimClock();
    // A game bug: on tick 40 it settles an input nobody sent.
    const buggy: RealtimeGame<CounterRealtimeState, CounterRealtimeConfig> = {
      ...counterRealtime,
      step(s, inputs) {
        const tick = s.tick;
        const out = counterRealtime.step(s, inputs);
        if (tick === 40) out.settlements.push({ seat: 0, choice: 'up', outcome: 'applied' });
        return out;
      },
    };
    // Both seats are still waiting on their first answer (900 ms) when tick 40 throws.
    const a = fakeDecider(clock, () => ({ latencyMs: 900 }));
    const b = fakeDecider(clock, () => ({ latencyMs: 900 }));
    const sink = memorySink();
    const runner = createRealtimeRunner({
      ...COMMON,
      game: buggy,
      seed: 4,
      config: counterRealtime.defaultConfig,
      seats: [baselineMeta(), baselineMeta()],
      deciders: [a, b],
      clock,
      sink,
    });
    await runner.start();
    const queue: (() => void)[] = [];
    const errors: unknown[] = [];
    let done = 0;
    driveLiveRealtime(runner, {
      now: () => clock.now(),
      schedule: (fn) => queue.push(fn),
      onDone: () => done++,
      onError: (err) => errors.push(err),
    });
    for (let fn = queue.shift(); fn; fn = queue.shift()) {
      await clock.advanceTo(runner.nextTickDueMs());
      fn();
    }
    expect(done).toBe(0);
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toMatch(/settlement for seat 0 \(up\) matches no waiting answer/);
    expect(queue).toEqual([]);
    const erroredAt = (40 * 1000) / 60;
    expect(a.calls[0]?.abortedAt).toBeCloseTo(erroredAt);
    expect(b.calls[0]?.abortedAt).toBeCloseTo(erroredAt);
    expect(runner.controllers.every((c) => !c.inFlight)).toBe(true);
    expect(sink.lines.some((l) => l.type === 'match_end')).toBe(false);
  });

  it('reports a turn match whose run() rejects, aborting the request still in flight', async () => {
    const clock = new SimClock();
    // A game bug: seat 1's view throws on turn 1 (seat 1 is asked first on odd turns, so seat 0's
    // request is still in flight when the run fails).
    const buggy: TurnGame<CounterTurnsState, CounterTurnsConfig> = {
      ...counterTurns,
      view(s, seat) {
        if (s.turn === 1 && seat === 1) throw new Error('view bug');
        return counterTurns.view(s, seat);
      },
    };
    const a = fakeDecider(clock, () => ({ latencyMs: 500 }));
    const b = fakeDecider(clock, () => ({ latencyMs: 5 }));
    const runner = createTurnRunner({
      ...COMMON,
      game: buggy,
      seed: 4,
      config: { turns: 3 },
      seats: [baselineMeta(), baselineMeta()],
      deciders: [a, b],
      clock,
      sink: memorySink(),
    });
    const outcome = new Promise<string>((resolve) => {
      driveLiveTurns(runner, {
        onDone: () => {
          resolve('done');
        },
        onError: (err) => {
          resolve(`error: ${err instanceof Error ? err.message : String(err)}`);
        },
      });
    });
    expect(await settleOnSim(clock, outcome)).toBe('error: view bug');
    const turn1 = a.calls[1];
    expect(turn1?.signal.aborted).toBe(true);
    expect(turn1?.abortedAt).toBe(turn1?.at);
  });

  it('calls onDone once a turn match ends', async () => {
    const clock = new SimClock();
    const runner = createTurnRunner({
      ...COMMON,
      game: counterTurns,
      seed: 4,
      config: { turns: 2 },
      seats: [baselineMeta(), baselineMeta()],
      deciders: [
        fakeDecider(clock, () => ({ latencyMs: 5 })),
        fakeDecider(clock, () => ({ latencyMs: 5 })),
      ],
      clock,
      sink: memorySink(),
    });
    const outcome = new Promise<string>((resolve) => {
      driveLiveTurns(runner, {
        onDone: () => {
          resolve('done');
        },
        onError: () => {
          resolve('error');
        },
      });
    });
    expect(await settleOnSim(clock, outcome)).toBe('done');
  });

  it('words a failure for the page', () => {
    expect(matchErrorMessage(new Error('settlement matches no waiting answer'))).toBe(
      'Match stopped: settlement matches no waiting answer. The log was kept without a match_end.',
    );
    expect(matchErrorMessage('odd')).toBe(
      'Match stopped: odd. The log was kept without a match_end.',
    );
    expect(matchErrorMessage(new Error('x'), 'log not saved: 409')).toBe(
      'Match stopped: x. The log was kept without a match_end. log not saved: 409.',
    );
  });
});

describe('liveInvalidNote', () => {
  const log = (over: Partial<FakeMatch> = {}) =>
    fakeLog({ players: ['jev', 'openai'], winner: 0, scores: [3, 1], ...over });
  const linesOf = (l: ReturnType<typeof log>) => [l.header, ...l.decisions];

  it('says nothing for a valid match, even one where a seat timed out a lot', () => {
    const l = log({
      decisions: [
        decision(0),
        decision(1, { status: 'timeout', error: 'timeout', choice: null, latencyMs: 1000 }),
      ],
    });
    if (!l.matchEnd) throw new Error('unfinished');
    expect(liveInvalidNote(linesOf(l), l.matchEnd)).toBe('');
  });

  it('warns about a stall: the tab went to the background or the machine paused', () => {
    const l = log({ valid: false, decisions: [decision(0), decision(1)] });
    if (!l.matchEnd) throw new Error('unfinished');
    l.matchEnd.stalls = [
      { atTick: 40, gapMs: 1200 },
      { atTick: 90, gapMs: 3400 },
    ];
    expect(liveInvalidNote(linesOf(l), l.matchEnd)).toBe(
      ' · invalid: the match stalled (longest 3.4 s): the tab went to the background or the ' +
        'machine paused. Keep this tab in front and the machine awake.',
    );
    // A stall only the decision lines show (a request far past its timeout) warns the same way.
    const slow = log({
      valid: false,
      decisions: [
        decision(0),
        decision(1, { status: 'dropped', error: 'matchOver', latencyMs: 9000 }),
      ],
    });
    if (!slow.matchEnd) throw new Error('unfinished');
    expect(liveInvalidNote(linesOf(slow), slow.matchEnd)).toMatch(
      /^ · invalid: the match stalled \(longest 8\.0 s\)/,
    );
  });

  it('gives the real reason otherwise', () => {
    const l = log({ valid: false, decisions: [decision(0), decision(1), failure(1)] });
    if (!l.matchEnd) throw new Error('unfinished');
    expect(liveInvalidNote(linesOf(l), l.matchEnd)).toBe(
      ' · invalid: OpenAI Decisions (gpt-6-luna) (seat 1) had transport errors on 50.0% of its ' +
        'decisions (limit 2%)',
    );
  });
});
