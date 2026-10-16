import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createMemoryLog } from '../../../src/core/log/memory.js';
import { parseMatchLog } from '../../../src/core/log/read.js';
import type { LogLine } from '../../../src/core/log/schema.js';
import { createMatchLog, writeSnapshot } from '../../../src/core/log/writer.js';
import { matchFile, statesDir } from '../../../src/core/results/paths.js';
import { createTurnRunner } from '../../../src/core/sched/turns.js';
import { counterTurns } from '../games/counter-turns.js';
import { COMMON, SimClock, baselineMeta, fakeDecider, settleOnSim } from '../sched/helpers.js';
import { realtimeLines, toJsonl } from './fixtures.js';

let dir = '';
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

const EVENT_A: LogLine = { type: 'event', tick: 3, game: { kind: 'window', k: 0 } };
const EVENT_B: LogLine = { type: 'event', tick: 33, game: { kind: 'window', k: 1 } };

describe('createMatchLog (JSONL file sink)', () => {
  it('appends one JSON line per write and keeps the lines', () => {
    dir = mkdtempSync(join(tmpdir(), 'arena-log-'));
    const path = join(dir, 'results', 'counter_realtime', 'matches', 'x.jsonl');
    const log = createMatchLog(path);
    log.write(EVENT_A);
    log.write(EVENT_B);
    expect(log.path).toBe(path);
    expect(log.lines).toEqual([EVENT_A, EVENT_B]);
    expect(readFileSync(path, 'utf8')).toBe(toJsonl([EVENT_A, EVENT_B]));
  });

  it('creates no file until the first line is written', () => {
    dir = mkdtempSync(join(tmpdir(), 'arena-log-'));
    const path = join(dir, 'deep', 'never.jsonl');
    createMatchLog(path);
    expect(existsSync(path)).toBe(false);
  });

  it('records a whole scheduler run that parses back as written', async () => {
    dir = mkdtempSync(join(tmpdir(), 'arena-log-'));
    const id = '20261007-120000-counter_realtime-random-vs-fake_provider-1';
    const path = join(dir, matchFile('counter_realtime', id));
    const file = createMatchLog(path);
    const lines = await realtimeLines({ seed: 5, matchId: id, sink: file });
    expect(readFileSync(path, 'utf8')).toBe(toJsonl(lines));
    expect(parseMatchLog(readFileSync(path, 'utf8')).header.matchId).toBe(id);
  });

  it('round-trips an answer whose probabilities lack its choice (probabilitiesPartial)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'arena-log-'));
    const id = '20261007-120000-counter_turns-fake-vs-fake-1';
    const path = join(dir, matchFile('counter_turns', id));
    const clock = new SimClock();
    // Always answers `a`, with probabilities over the other options only.
    const partial = { latencyMs: 5, choice: 'a', probabilities: { b: 0.6, c: 0.4 } };
    const runner = createTurnRunner({
      ...COMMON,
      matchId: id,
      game: counterTurns,
      seed: 9,
      config: { turns: 2 },
      seats: [baselineMeta(), baselineMeta()],
      deciders: [fakeDecider(clock, () => partial), fakeDecider(clock, () => ({ latencyMs: 5 }))],
      clock,
      sink: createMatchLog(path),
    });
    await settleOnSim(clock, runner.run());
    const log = parseMatchLog(readFileSync(path, 'utf8'));
    const seat0 = log.decisions.filter((d) => d.seat === 0);
    expect(seat0).toHaveLength(2);
    for (const d of seat0) {
      expect(d).toMatchObject({ choice: 'a', probabilities: { b: 0.6, c: 0.4 } });
      expect(d.probabilitiesPartial).toBe(true);
    }
    const seat1 = log.decisions.filter((d) => d.seat === 1);
    expect(seat1.every((d) => !('probabilitiesPartial' in d))).toBe(true);
  });

  it('writes snapshots under the snapshot dir as <seat>-<seq>.json when one is given', () => {
    dir = mkdtempSync(join(tmpdir(), 'arena-snap-'));
    const snaps = join(dir, statesDir('counter_turns', 'm-1'));
    const log = createMatchLog(join(dir, 'm.jsonl'), { snapshotDir: snaps });
    log.snapshot?.(1, 7, { request: { a: 1 }, response: null });
    const path = join(dir, 'results', 'states', 'counter_turns', 'm-1', '1-7.json');
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ request: { a: 1 }, response: null });
    expect('snapshot' in createMatchLog(join(dir, 'n.jsonl'))).toBe(false);
  });
});

describe('writeSnapshot', () => {
  it('writes <dir>/<seat>-<seq>.json and returns its path', () => {
    dir = mkdtempSync(join(tmpdir(), 'arena-snap-'));
    const path = writeSnapshot(`${dir}/a/b`, 0, 12, { request: 'q', response: { ok: true } });
    expect(path).toBe(`${dir}/a/b/0-12.json`);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      request: 'q',
      response: { ok: true },
    });
  });
});

describe('createMemoryLog', () => {
  it('keeps every line in order', () => {
    const log = createMemoryLog();
    log.write(EVENT_A);
    log.write(EVENT_B);
    expect(log.lines).toEqual([EVENT_A, EVENT_B]);
  });
});
