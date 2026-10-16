import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OPTION_ORDER_RULE, orderOptions } from '../../../src/core/classifier/order.js';
import { createRandomDecider, randomDeciderSeed } from '../../../src/core/classifier/random.js';
import type { Seat } from '../../../src/core/classifier/types.js';
import { parseMatchLog } from '../../../src/core/log/read.js';
import type { HeaderLine } from '../../../src/core/log/schema.js';
import { createMatchLog } from '../../../src/core/log/writer.js';
import { replayLog } from '../../../src/core/replay/replay.js';
import { driveRealtime } from '../../../src/core/sched/drive.js';
import { createRealtimeRunner } from '../../../src/core/sched/realtime.js';
import { MATCH_OVER } from '../../../src/core/sched/validity.js';
import { SimClock } from '../../../src/core/util/clock.js';
import { createPrng } from '../../../src/core/util/prng.js';
import { createScriptedDecider } from '../../../src/games/fighter/baselines.js';
import { runScripted } from '../../../src/games/fighter/engine/run.js';
import type { MoveId } from '../../../src/games/fighter/engine/types.js';
import { fighterGame } from '../../../src/games/fighter/game.js';
import { FIGHTER_QUESTION, FIGHTER_QUESTION_KEY } from '../../../src/games/fighter/question.js';
import { buildView } from '../../../src/games/fighter/view.js';
import {
  COMMON,
  baselineMeta,
  fakeDecider,
  providerMeta,
  type FakeDecider,
  type FakeStep,
} from '../../core/sched/helpers.js';
import { fighterHarness } from './helpers.js';

/**
 * The fighter on the core real-time scheduler (src/core/sched/realtime.ts): the fighter-specific
 * behaviour the old fighter-only runner was tested for, now through `fighterGame`.
 */

const idle = (clock: SimClock) =>
  fakeDecider(clock, () => ({ latencyMs: 10, choice: 'block_high' }));

/** A decider that answers `moves[n]` after 10 ms, then hangs (times out) once they run out. */
const scripted =
  (moves: readonly MoveId[], latencyMs = 10) =>
  (clock: SimClock) =>
    fakeDecider(clock, (n): FakeStep => {
      const move = moves[n];
      return move ? { latencyMs, choice: move } : { latencyMs: 5000 };
    });

describe('fighter on the real-time scheduler', () => {
  it('applies an answer on the next tick after it arrives, logging sentTick, appliedTick and the key', async () => {
    const h = await fighterHarness(
      (c) => fakeDecider(c, () => ({ latencyMs: 30, choice: 'walk_back' })),
      idle,
    );
    await h.runUntilTick(4);
    const [first] = h.decisions(0);
    // Sent on tick 0 (t = 0), arrives at 30 ms; tick 1 is at 16.7 ms, tick 2 at 33.3 ms.
    expect(first).toMatchObject({
      seq: 0,
      questionKey: 'next_move',
      sentTick: 0,
      appliedTick: 2,
      status: 'ok',
      choice: 'walk_back',
      latencyMs: 30,
    });
    expect(h.runner.state.fighters[0].action).toBe('walk_back');
  });

  it('logs a timeout with appliedTick null and keeps the current action', async () => {
    const h = await fighterHarness(scripted(['walk_back']), idle);
    await h.runUntilTick(80);
    const lines = h.decisions(0);
    expect(lines[0]).toMatchObject({ status: 'ok', choice: 'walk_back' });
    const timeout = lines.find((l) => l.status === 'timeout');
    expect(timeout).toMatchObject({ seq: 1, appliedTick: null, latencyMs: 1000, choice: null });
    expect(h.runner.state.fighters[0].action).toBe('walk_back');
  });

  it('logs dropped (superseded) for a waiting hold, and writes a pendingHold decision once, when it applies', async () => {
    const h = await fighterHarness(scripted(['heavy_punch', 'walk_back', 'walk_forward']), idle);
    await h.runUntilTick(20);
    expect(h.decisions(0).map((l) => [l.seq, l.status, l.error])).toEqual([
      [0, 'ok', undefined],
      [1, 'dropped', 'dropped: superseded'],
    ]);
    // walk_forward is waiting as pendingHold while the heavy punch recovers: no line yet.
    expect(h.runner.state.fighters[0].pendingHold).toBe('walk_forward');
    await h.runUntilTick(50);
    const all = h.decisions(0).filter((l) => l.seq === 2);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      status: 'ok',
      choice: 'walk_forward',
      sentTick: 12,
      appliedTick: 13,
    });
    expect(h.runner.state.fighters[0].action).toBe('walk_forward');
  });

  it('logs dropped (busy) for a one-shot that waited out the buffer, at the tick it was fed', async () => {
    // The uppercut (39 ticks) starts on tick 1; the jab arrives on tick 7 and expires 6 ticks later.
    const h = await fighterHarness(scripted(['uppercut', 'jab']), idle);
    await h.runUntilTick(30);
    expect(h.decisions(0).map((l) => [l.seq, l.status, l.appliedTick, l.error])).toEqual([
      [0, 'ok', 1, undefined],
      [1, 'dropped', 7, 'dropped: busy'],
    ]);
  });

  it('logs dropped (notFighting) for a hold still waiting at round end and an answer that lands between rounds', async () => {
    const h = await fighterHarness(
      // Seat 0: an uppercut, then a hold that waits as pendingHold until the round times out.
      scripted(['uppercut', 'walk_forward']),
      // Seat 1: a jab, then a jab sent on tick 6 that lands on tick 12, the first paused tick.
      scripted(['jab', 'jab'], 95),
      { config: { roundTicks: 12 } },
    );
    await h.runUntilTick(20);
    expect(h.decisions(0)[1]).toMatchObject({
      seq: 1,
      choice: 'walk_forward',
      status: 'dropped',
      appliedTick: 7,
      error: 'dropped: notFighting',
    });
    expect(h.decisions(1)[1]).toMatchObject({
      seq: 1,
      choice: 'jab',
      sentTick: 6,
      status: 'dropped',
      appliedTick: 12,
      error: 'dropped: notFighting',
    });
    expect(h.events()).toEqual([
      {
        type: 'event',
        tick: 11,
        game: {
          kind: 'round_end',
          round: 1,
          winner: 'draw',
          reason: 'timeout',
          health: [100, 100],
        },
      },
    ]);
  });

  it('sends nothing between rounds', async () => {
    const h = await fighterHarness(
      (c) => fakeDecider(c, () => ({ latencyMs: 20, choice: 'block_high' })),
      (c) => fakeDecider(c, () => ({ latencyMs: 20, choice: 'block_high' })),
      { config: { roundTicks: 30 } },
    );
    await h.runUntilTick(200);
    const pause = fighterGame.defaultConfig.roundPauseTicks;
    const [end] = h.events();
    if (!end) throw new Error('no round_end');
    const sent = h.decisions().map((l) => l.sentTick);
    expect(sent.some((t) => t > end.tick && t <= end.tick + pause)).toBe(false);
    expect(sent.some((t) => t > end.tick + pause)).toBe(true);
  });

  it('alternates which seat sends first by tick parity', async () => {
    const order: [number, string][] = [];
    const tag =
      (name: string) =>
      (clock: SimClock): FakeDecider => {
        // 110 ms answers: sends land on ticks 0, 7, 14, 21, ... (both parities).
        const d = fakeDecider(clock, () => ({ latencyMs: 110, choice: 'block_high' }));
        const decide = d.decide.bind(d);
        d.decide = (v, q, s) => {
          order.push([Math.round(clock.now() / (1000 / 60)), name]);
          return decide(v, q, s);
        };
        return d;
      };
    const h = await fighterHarness(tag('a'), tag('b'));
    await h.runUntilTick(60);
    const byTick = new Map<number, string>();
    for (const [tick, who] of order) byTick.set(tick, (byTick.get(tick) ?? '') + who);
    expect([...byTick.entries()].slice(0, 4)).toEqual([
      [0, 'ab'],
      [7, 'ba'],
      [14, 'ab'],
      [21, 'ba'],
    ]);
  });

  it("hands both seats the identical question object, in core's order for next_move, with their own views", async () => {
    let a: FakeDecider | undefined;
    let b: FakeDecider | undefined;
    const h = await fighterHarness(
      (c) => (a = fakeDecider(c, () => ({ latencyMs: 20 }))),
      (c) => (b = fakeDecider(c, () => ({ latencyMs: 20 }))),
      { seed: 1234 },
    );
    await h.runUntilTick(30);
    const header = h.lines[0] as HeaderLine;
    expect(header).toMatchObject({
      type: 'header',
      game: 'fighter',
      optionOrderRule: OPTION_ORDER_RULE,
    });
    const calls = [...(a?.calls ?? []), ...(b?.calls ?? [])];
    expect(calls.length).toBeGreaterThan(4);
    const [q] = calls.map((c) => c.question);
    for (const c of calls) expect(c.question).toBe(q);
    expect(q).toEqual(orderOptions(FIGHTER_QUESTION, 1234, FIGHTER_QUESTION_KEY));
    expect(q?.options.map((o) => o.id)).not.toEqual(FIGHTER_QUESTION.options.map((o) => o.id));
    expect(h.decisions().every((l) => l.questionKey === FIGHTER_QUESTION_KEY)).toBe(true);
    // Tick 0's views: each seat's own, of the state before tick 0.
    const fresh = fighterGame.create(1234, fighterGame.defaultConfig);
    expect(a?.calls[0]?.state).toEqual(buildView(fresh, 0));
    expect(b?.calls[0]?.state).toEqual(buildView(fresh, 1));
  });

  it('warms up provider seats on the ordered question before the clock starts; baselines skip it', async () => {
    let a: FakeDecider | undefined;
    let b: FakeDecider | undefined;
    const h = await fighterHarness(
      (c) => (a = fakeDecider(c, (n) => ({ latencyMs: n === 0 ? 900 : 20, costUsd: 0.001 }))),
      (c) => (b = fakeDecider(c, () => ({ latencyMs: 20 }))),
      { seats: [providerMeta(), baselineMeta()] },
    );
    const header = h.lines[0] as HeaderLine;
    expect(header.seats[0].warmup).toEqual({ latencyMs: 900, status: 'ok', costUsd: 0.001 });
    expect(header.seats[1].warmup).toBeNull();
    expect(header.seats[1].price).toBeNull();
    expect(a?.calls).toHaveLength(1);
    expect(a?.calls[0]?.question).toEqual(orderOptions(FIGHTER_QUESTION, 7, FIGHTER_QUESTION_KEY));
    expect(b?.calls).toHaveLength(0);
    // The clock starts after the warm-up: tick 0 is at 900 ms, and the warm-up never hits the engine.
    expect(h.runner.startMs).toBe(900);
    expect(h.decisions()).toHaveLength(0);
    await h.runUntilTick(1);
    expect(a?.calls[1]?.at).toBe(900);
  });

  it('logs every request still in flight at match end, with an estimated cost, outside the miss rate', async () => {
    const step = (): FakeStep => ({ latencyMs: 170, choice: 'jab', costUsd: 0.0001 });
    const h = await fighterHarness(
      (c) => fakeDecider(c, step),
      (c) => fakeDecider(c, step),
      { seed: 3, seats: [providerMeta('p0'), providerMeta('p1')] },
    );
    await h.runUntilTick(Number.POSITIVE_INFINITY);
    const decisions = h.decisions();
    const { controllers } = h.runner;
    expect(decisions).toHaveLength(controllers[0].sent + controllers[1].sent);
    const atEnd = decisions.filter((l) => l.error === MATCH_OVER && l.choice === null);
    expect(atEnd.length).toBeGreaterThan(0);
    for (const l of atEnd) {
      expect(l).toMatchObject({ status: 'dropped', costUsd: 0.0001, costEstimated: true });
    }
    const end = h.lines.at(-1);
    if (end?.type !== 'match_end') throw new Error('no match_end');
    const total = decisions.reduce((sum, l) => sum + l.costUsd, 0) + 2 * 0.0001;
    expect(end.costUsd).toBeCloseTo(total, 12);
    expect(end.missRates).toEqual([0, 0]);
  });
});

describe('full fighter match', () => {
  it('random vs scripted on a SimClock writes all four line types, round ends as events, and replays to its hash', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'arena-fighter-'));
    try {
      const seed = 42;
      const clock = new SimClock();
      const path = join(dir, 'm.jsonl');
      const random = (seat: Seat) =>
        createRandomDecider({ prng: createPrng(randomDeciderSeed(seed, seat)), clock });
      const runner = createRealtimeRunner({
        game: fighterGame,
        seed,
        config: fighterGame.defaultConfig,
        seats: [baselineMeta('random'), baselineMeta('scripted')],
        deciders: [random(0), createScriptedDecider({ clock })],
        clock,
        sink: createMatchLog(path),
        ...COMMON,
      });
      await driveRealtime(runner, clock);
      const text = readFileSync(path, 'utf8');
      const lines = text
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as { type: string });
      expect(new Set(lines.map((l) => l.type))).toEqual(
        new Set(['header', 'decision', 'event', 'match_end']),
      );
      const log = parseMatchLog(text);
      const { state } = runner;
      const end = log.matchEnd;
      if (!end) throw new Error('no match_end');
      expect(state.status).toBe('matchOver');
      expect(end).toMatchObject({
        totalTicks: state.tick,
        winner: state.winner,
        scores: [state.fighters[0].roundsWon, state.fighters[1].roundsWon],
        finalStateHash: fighterGame.hash(state),
        valid: true,
      });
      // One round_end event per round, on the tick it ended, with both healths.
      expect(log.events).toEqual(
        state.roundResults.map((r) => ({
          type: 'event',
          tick: r.endTick,
          game: {
            kind: 'round_end',
            round: r.round,
            winner: r.winner,
            reason: r.reason,
            health: r.health,
          },
        })),
      );
      // Every request has exactly one line per (seat, seq), one still in flight at the end too.
      const keys = log.decisions.map((l) => `${String(l.seat)}-${String(l.seq)}`);
      expect(new Set(keys).size).toBe(keys.length);
      expect(keys.length).toBe(runner.controllers[0].sent + runner.controllers[1].sent);
      expect(log.decisions.some((l) => l.status === 'dropped' && l.appliedTick !== null)).toBe(
        true,
      );
      // The core replay reproduces the final hash, and so does the engine fed directly.
      expect(replayLog(log, fighterGame).matches).toBe(true);
      const applied = log.decisions.flatMap((l) =>
        l.appliedTick !== null && l.choice !== null
          ? [{ fighter: l.seat, appliedTick: l.appliedTick, move: l.choice as MoveId }]
          : [],
      );
      expect(runScripted(seed, applied).hash).toBe(end.finalStateHash);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
