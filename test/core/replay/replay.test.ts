import { beforeAll, describe, expect, it } from 'vitest';
import type { Seat } from '../../../src/core/classifier/types.js';
import type { TurnAnswer } from '../../../src/core/game.js';
import { parseMatchLog, type MatchLog } from '../../../src/core/log/read.js';
import type { DecisionLine } from '../../../src/core/log/schema.js';
import {
  KEYFRAME_TICKS,
  assertReplayable,
  createReplayCursor,
  replayLog,
  resolvedTick,
} from '../../../src/core/replay/replay.js';
import { counterRealtime, realtimeAnswer } from '../games/counter-realtime.js';
import { counterTurns } from '../games/counter-turns.js';
import { realtimeLines, toJsonl, turnLines } from '../log/fixtures.js';

const SEEDS = [1, 42, 20261007];

const parse = (lines: readonly unknown[]): MatchLog => parseMatchLog(toJsonl(lines));

function endOf(log: MatchLog) {
  if (log.matchEnd === null) throw new Error('no match_end');
  return log.matchEnd;
}

describe('replayLog: real-time', () => {
  it('reproduces the final hash of scheduler runs', async () => {
    for (const seed of SEEDS) {
      const log = parse(await realtimeLines({ seed }));
      const r = replayLog(log, counterRealtime);
      expect(r.hash).toBe(endOf(log).finalStateHash);
      expect(r.matches).toBe(true);
      expect(r.state.tick).toBe(endOf(log).totalTicks);
      expect(r.state.scores).toEqual(endOf(log).scores);
    }
  });

  it('creates the game from the logged config, not the default', async () => {
    const log = parse(await realtimeLines({ seed: 9, config: { windows: 5 } }));
    expect(log.header.config).toEqual({ windows: 5 });
    const r = replayLog(log, counterRealtime);
    expect(r.matches).toBe(true);
    expect(r.state.tick).toBe(150);
    expect(r.state.targets).toHaveLength(5);
  });

  it('reports a mismatch when an applied choice is changed, and without a match_end', async () => {
    const log = parse(await realtimeLines({ seed: 3 }));
    const i = log.decisions.findIndex((d) => d.status === 'ok' && d.appliedTick !== null);
    const tampered: MatchLog = {
      ...log,
      decisions: log.decisions.map((d, j) =>
        j === i ? { ...d, choice: d.choice === 'up' ? 'down' : 'up' } : d,
      ),
    };
    expect(replayLog(tampered, counterRealtime).matches).toBe(false);
    const open = replayLog({ ...log, matchEnd: null }, counterRealtime);
    expect(open.matches).toBe(false);
    expect(open.hash).toBe(endOf(log).finalStateHash);
  });

  it('feeds every line with an appliedTick, dropped ones included; the last per seat and tick wins', async () => {
    const log = parse(await realtimeLines({ seed: 4, config: { windows: 1 } }));
    const fresh = counterRealtime.create(log.header.seed, { windows: 1 });
    const right = realtimeAnswer(fresh, 0);
    const wrong = right === 'up' ? 'down' : 'up';
    const line = (seat: Seat, seq: number, choice: string, status: DecisionLine['status']) =>
      ({
        type: 'decision',
        seat,
        seq,
        questionKey: 'q0',
        sentTick: 0,
        appliedTick: 5,
        latencyMs: 10,
        choice,
        probabilities: null,
        confidence: null,
        inputTokens: null,
        costUsd: 0,
        status,
      }) satisfies DecisionLine;
    const synthetic: MatchLog = {
      header: log.header,
      decisions: [
        // Seat 0: wrong then right on the same tick: the right one (last) is fed.
        line(0, 0, wrong, 'ok'),
        line(0, 1, right, 'ok'),
        // Seat 1: a dropped line is still fed (the game decides again).
        line(1, 0, right, 'dropped'),
        // Never reached the game: skipped.
        { ...line(1, 1, right, 'timeout'), appliedTick: null },
      ],
      events: [],
      matchEnd: null,
    };
    expect(replayLog(synthetic, counterRealtime).state.scores).toEqual([1, 1]);
  });
});

describe('replayLog: turns', () => {
  it('reproduces the final hash of scheduler runs', async () => {
    for (const seed of SEEDS) {
      const log = parse(await turnLines({ seed }));
      const r = replayLog(log, counterTurns);
      expect(r.hash).toBe(endOf(log).finalStateHash);
      expect(r.matches).toBe(true);
      expect(r.state.turn).toBe(endOf(log).totalTicks);
      expect(r.state.scores).toEqual(endOf(log).scores);
    }
  });

  it('passes ok answers with their latency and null for misses', async () => {
    const log = parse(await turnLines({ seed: 8, config: { turns: 4 } }));
    expect(replayLog(log, counterTurns).matches).toBe(true);
    // Changing a logged latency changes the state (counter_turns keeps right answers' latency).
    const i = log.decisions.findIndex((d) => d.status === 'ok' && d.correct === true);
    const slower: MatchLog = {
      ...log,
      decisions: log.decisions.map((d, j) => (j === i ? { ...d, latencyMs: d.latencyMs + 5 } : d)),
    };
    expect(replayLog(slower, counterTurns).matches).toBe(false);
    // A miss with a choice still counts as no answer.
    const miss = log.decisions.findIndex((d) => d.status === 'timeout');
    const withChoice: MatchLog = {
      ...log,
      decisions: log.decisions.map((d, j) => (j === miss ? { ...d, choice: 'a' } : d)),
    };
    expect(replayLog(withChoice, counterTurns).matches).toBe(true);
  });
});

describe('assertReplayable', () => {
  let log: MatchLog;
  beforeAll(async () => {
    log = parse(await realtimeLines({ seed: 2, config: { windows: 2 } }));
  });

  it('accepts a log recorded by this game and version', () => {
    expect(() => {
      assertReplayable(log, counterRealtime);
    }).not.toThrow();
  });

  it('refuses another game, another version or another cadence', () => {
    expect(() => {
      assertReplayable(log, counterTurns);
    }).toThrow('match log is for game "counter_realtime", not "counter_turns"');
    const v2 = { ...log, header: { ...log.header, gameVersion: 2 } };
    expect(() => replayLog(v2, counterRealtime)).toThrow(
      'match log was recorded with counter_realtime version 2, but this build runs version 1; it cannot be replayed',
    );
    expect(() => createReplayCursor(v2, counterRealtime)).toThrow(/cannot be replayed/);
    const turns = { ...log, header: { ...log.header, cadence: { kind: 'turns' as const } } };
    expect(() => replayLog(turns, counterRealtime)).toThrow(/cadence/);
    const fast = {
      ...log,
      header: { ...log.header, cadence: { kind: 'realtime' as const, tickRate: 30 } },
    };
    expect(() => replayLog(fast, counterRealtime)).toThrow(/cadence/);
  });

  it('refuses a malformed logged config (configFromLog throws)', () => {
    const bad = { ...log, header: { ...log.header, config: { windows: 'two' } } };
    expect(() => replayLog(bad, counterRealtime)).toThrow(/windows/);
  });
});

describe('resolvedTick', () => {
  const d = {
    type: 'decision',
    seat: 0,
    seq: 0,
    questionKey: 'q0',
    sentTick: 10,
    appliedTick: null,
    latencyMs: 1000,
    choice: null,
    probabilities: null,
    confidence: null,
    inputTokens: null,
    costUsd: 0,
    status: 'timeout',
  } satisfies DecisionLine;

  it('is the applied tick when there is one, else sent + latency in ticks (rounded up)', () => {
    expect(resolvedTick({ ...d, appliedTick: 14 }, 60)).toBe(14);
    expect(resolvedTick(d, 60)).toBe(70);
    expect(resolvedTick({ ...d, latencyMs: 1001 }, 60)).toBe(71);
    expect(resolvedTick({ ...d, latencyMs: 0 }, 60)).toBe(10);
  });
});

describe('createReplayCursor: real-time', () => {
  // 50 windows = 1500 ticks: keyframes at 0, 600 and 1200.
  const hashes: string[] = [];
  let log: MatchLog;
  beforeAll(async () => {
    const lines = await realtimeLines({
      seed: 77,
      config: { windows: 50 },
      beforeStep: (before) => (hashes[before.tick] = counterRealtime.hash(before)),
    });
    log = parse(lines);
    hashes[endOf(log).totalTicks] = endOf(log).finalStateHash;
  });

  it('starts at tick 0 and knows the last tick', () => {
    const c = createReplayCursor(log, counterRealtime);
    expect(c.tick).toBe(0);
    expect(c.lastTick).toBe(1500);
    expect(c.hash()).toBe(hashes[0]);
  });

  it('gives the same state at tick n as the straight (live) run, seeking both ways', () => {
    const c = createReplayCursor(log, counterRealtime);
    const targets = [KEYFRAME_TICKS + 37, 5, 2 * KEYFRAME_TICKS - 1, KEYFRAME_TICKS, 1, 0, 1500];
    for (const t of targets) {
      c.seek(t);
      expect(c.tick).toBe(t);
      expect(c.hash()).toBe(hashes[t]);
    }
    for (const t of [1499, 1201, 900, 300]) {
      c.stepTo(t);
      expect(c.tick).toBe(t);
      expect(c.hash()).toBe(hashes[t]);
    }
  });

  it('clamps past the end and below zero, and step() is a no-op at the end', () => {
    const c = createReplayCursor(log, counterRealtime);
    c.seek(5000);
    expect(c.tick).toBe(1500);
    expect(c.hash()).toBe(endOf(log).finalStateHash);
    expect(c.step()).toEqual([]);
    expect(c.tick).toBe(1500);
    c.seek(-5);
    expect(c.tick).toBe(0);
  });

  it('step() advances one tick and returns its events', () => {
    const c = createReplayCursor(log, counterRealtime);
    c.seek(29);
    expect(c.step()).toEqual([]);
    expect(c.step()).toEqual([{ kind: 'window', k: 1 }]);
    expect(c.tick).toBe(31);
    expect(c.hash()).toBe(hashes[31]);
  });

  it('decisionsUpTo(n) lists the lines resolved by tick n, in log order', () => {
    const c = createReplayCursor(log, counterRealtime);
    expect(c.decisionsUpTo(0)).toEqual([]);
    const upTo = c.decisionsUpTo(KEYFRAME_TICKS);
    expect(upTo.length).toBeGreaterThan(0);
    expect(upTo).toEqual(log.decisions.filter((d) => resolvedTick(d, 60) <= KEYFRAME_TICKS));
    expect(c.decisionsUpTo(c.lastTick)).toHaveLength(
      log.decisions.filter((d) => resolvedTick(d, 60) <= c.lastTick).length,
    );
  });

  it('works without a match_end: the last tick is where the re-sim stops', () => {
    const c = createReplayCursor({ ...log, matchEnd: null }, counterRealtime);
    expect(c.lastTick).toBe(1500);
    c.seek(c.lastTick);
    expect(c.hash()).toBe(hashes[1500]);
  });
});

describe('createReplayCursor: turns', () => {
  let log: MatchLog;
  /** Hash after n turns, from a straight run fed from the log by hand. */
  const hashes: string[] = [];
  beforeAll(async () => {
    log = parse(await turnLines({ seed: 31 }));
    const s = counterTurns.create(log.header.seed, { turns: 10 });
    hashes.push(counterTurns.hash(s));
    for (let t = 0; t < 10; t++) {
      const answers: [TurnAnswer | null, TurnAnswer | null] = [null, null];
      for (const d of log.decisions) {
        if (d.appliedTick === t && d.status === 'ok' && d.choice !== null) {
          answers[d.seat] = { choice: d.choice, latencyMs: d.latencyMs };
        }
      }
      counterTurns.applyTurn(s, answers);
      hashes.push(counterTurns.hash(s));
    }
  });

  it('gives the same state at turn n as a straight run', () => {
    const c = createReplayCursor(log, counterTurns);
    expect(c.lastTick).toBe(10);
    for (const n of [7, 0, 10, 3, 9, 1]) {
      c.seek(n);
      expect(c.tick).toBe(n);
      expect(c.hash()).toBe(hashes[n]);
    }
    expect(c.hash()).toBe(hashes[1]);
    c.stepTo(10);
    expect(c.hash()).toBe(endOf(log).finalStateHash);
  });

  it('step() plays one turn and returns its events', () => {
    const c = createReplayCursor(log, counterTurns);
    const events = c.step();
    expect(events).toEqual([expect.objectContaining({ kind: 'turn', turn: 0 })]);
    expect(c.tick).toBe(1);
  });

  it('decisionsUpTo(n) lists the lines of the turns played before n', () => {
    const c = createReplayCursor(log, counterTurns);
    expect(c.decisionsUpTo(0)).toEqual([]);
    expect(c.decisionsUpTo(3)).toEqual(
      log.decisions.filter((d) => d.appliedTick !== null && d.appliedTick < 3),
    );
    expect(c.decisionsUpTo(10)).toEqual(log.decisions);
  });
});
