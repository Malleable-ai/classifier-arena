import { beforeAll, describe, expect, it } from 'vitest';
import { REFUSAL_ERROR } from '../../../src/core/classifier/types.js';
import { parseMatchLog, readLogLine } from '../../../src/core/log/read.js';
import type {
  DecisionLine,
  EventLine,
  LogLine,
  MatchEndLine,
} from '../../../src/core/log/schema.js';
import { SCHEMA_VERSION } from '../../../src/core/log/schema.js';
import { realtimeLines, toJsonl, turnLines, viaJson } from './fixtures.js';

const isDecision = (l: LogLine): l is DecisionLine => l.type === 'decision';
const isEvent = (l: LogLine): l is EventLine => l.type === 'event';

let rt: LogLine[] = [];
let tn: LogLine[] = [];

beforeAll(async () => {
  rt = await realtimeLines({ seed: 20261007 });
  tn = await turnLines({ seed: 20261007 });
});

/** `lines` as JSONL with line `n` (1-based) replaced by `patch` merged into it. */
function patched(lines: readonly LogLine[], n: number, patch: Record<string, unknown>): string {
  return toJsonl(lines.map((l, i) => (i === n - 1 ? { ...l, ...patch } : l)));
}

/** `lines` with one field of line `n` (1-based) deleted. */
function without(lines: readonly LogLine[], n: number, field: string): string {
  return toJsonl(
    lines.map((l, i) =>
      i === n - 1 ? Object.fromEntries(Object.entries(l).filter(([k]) => k !== field)) : l,
    ),
  );
}

/** 1-based line number of the first line matching `pred`. */
function lineOf(lines: readonly LogLine[], pred: (l: LogLine) => boolean): number {
  const i = lines.findIndex(pred);
  if (i < 0) throw new Error('no such line');
  return i + 1;
}

describe('parseMatchLog: logs the schedulers write', () => {
  it('reads a real-time log back exactly: header, decisions, events and match_end', () => {
    const log = parseMatchLog(toJsonl(rt));
    expect(log.header).toStrictEqual(viaJson(rt[0]));
    expect(log.decisions).toStrictEqual(viaJson(rt.filter(isDecision)));
    expect(log.events).toStrictEqual(viaJson(rt.filter(isEvent)));
    expect(log.matchEnd).toStrictEqual(viaJson(rt.at(-1)));
    // The fixture covers every real-time status and both kinds of appliedTick.
    const statuses = new Set(log.decisions.map((d) => d.status));
    expect([...statuses].sort()).toEqual(['dropped', 'ok', 'timeout']);
    expect(log.decisions.some((d) => d.appliedTick === null)).toBe(true);
    expect(log.decisions.some((d) => d.costEstimated === true)).toBe(true);
    expect(log.decisions.some((d) => d.correct === false)).toBe(true);
    expect(log.header.seats[1].warmup?.status).toBe('ok');
  });

  it('reads a turn log back exactly', () => {
    const log = parseMatchLog(toJsonl(tn));
    expect(log.header).toStrictEqual(viaJson(tn[0]));
    expect(log.header.cadence).toEqual({ kind: 'turns' });
    expect(log.decisions).toStrictEqual(viaJson(tn.filter(isDecision)));
    expect(log.events).toStrictEqual(viaJson(tn.filter(isEvent)));
    expect(log.matchEnd).toStrictEqual(viaJson(tn.at(-1)));
    // Turn games log a miss with appliedTick = the turn and no choice.
    expect(log.decisions.some((d) => d.status === 'timeout' && d.appliedTick !== null)).toBe(true);
  });

  it('accepts a log without match_end (a run that stopped) and skips blank lines', () => {
    const text = `${JSON.stringify(rt[0])}\n\n${JSON.stringify(rt.find(isDecision))}\n`;
    const log = parseMatchLog(text);
    expect(log.matchEnd).toBeNull();
    expect(log.decisions).toHaveLength(1);
    expect(log.events).toEqual([]);
  });

  it('accepts probabilities whose keys include the choice', () => {
    const d = rt.findIndex((l) => isDecision(l) && l.choice === 'up') + 1;
    const text = patched(rt, d, { probabilities: { up: 0.75, down: 0.25 }, confidence: 0.75 });
    const parsed = parseMatchLog(text).decisions.find((x) => x.probabilities !== null);
    expect(parsed?.probabilities).toEqual({ up: 0.75, down: 0.25 });
  });
});

describe('parseMatchLog: schema version', () => {
  it('rejects a v1 log with a clear message', () => {
    const v1 = { type: 'header', schemaVersion: 1, matchId: 'x', fighters: [] };
    expect(() => parseMatchLog(toJsonl([v1]))).toThrow(
      'line 1: schema v1 logs are no longer readable; regenerate them with this build (schema v2)',
    );
  });

  it('rejects any other version, or none', () => {
    expect(() => parseMatchLog(patched(rt, 1, { schemaVersion: SCHEMA_VERSION + 1 }))).toThrow(
      'line 1: match log schema version 3 is not supported (this build reads version 2)',
    );
    expect(() => parseMatchLog(without(rt, 1, 'schemaVersion'))).toThrow(
      /line 1: match log schema version undefined is not supported/,
    );
  });
});

describe('parseMatchLog: structure', () => {
  it('rejects an empty log, a missing header and a second header', () => {
    expect(() => parseMatchLog('')).toThrow(/empty/);
    expect(() => parseMatchLog('\n\n')).toThrow(/empty/);
    expect(() => parseMatchLog(toJsonl(rt.slice(1)))).toThrow(/^line 1: expected a header/);
    expect(() => parseMatchLog(toJsonl([rt[0], rt[0]]))).toThrow(/^line 2: a second header/);
  });

  it('rejects bad JSON, non-objects and unknown line types with the line number', () => {
    expect(() => parseMatchLog(`${JSON.stringify(rt[0])}\n{nope`)).toThrow(/^line 2: invalid JSON/);
    expect(() => parseMatchLog(`${JSON.stringify(rt[0])}\n[1,2]`)).toThrow(
      /^line 2: expected a JSON object/,
    );
    expect(() => parseMatchLog(toJsonl([rt[0], { type: 'round_end' }]))).toThrow(
      /^line 2: unknown line type "round_end"/,
    );
  });

  it('rejects lines after match_end', () => {
    const end = rt.at(-1);
    expect(() => parseMatchLog(toJsonl([rt[0], end, rt.find(isDecision)]))).toThrow(
      /^line 3: unexpected line after match_end/,
    );
  });
});

describe('parseMatchLog: header fields', () => {
  const bad: [string, Record<string, unknown>, RegExp][] = [
    ['game', { game: 'Fighter' }, /^line 1: game must be a game id/],
    ['game', { game: 3 }, /^line 1: game must be a game id/],
    ['gameVersion', { gameVersion: 1.5 }, /^line 1: gameVersion must be an integer ≥ 0/],
    ['matchId', { matchId: '' }, /^line 1: matchId must be a non-empty string/],
    ['seed', { seed: -1 }, /^line 1: seed must be an integer ≥ 0/],
    ['startTime', { startTime: null }, /^line 1: startTime must be a string/],
    ['cadence', { cadence: { kind: 'weekly' } }, /^line 1: cadence\.kind must be/],
    [
      'cadence.tickRate',
      { cadence: { kind: 'realtime' } },
      /^line 1: cadence\.tickRate must be a number > 0/,
    ],
    ['timing', { timing: { floorMs: 100 } }, /^line 1: timing\.timeoutMs must be a finite number/],
    ['config', { config: [] }, /^line 1: config must be an object/],
    ['seats', { seats: [] }, /^line 1: seats must be an array of two seats/],
    ['promptConfigHash', { promptConfigHash: 7 }, /^line 1: promptConfigHash must be a string/],
    ['runId', { runId: '' }, /^line 1: runId must be a non-empty string/],
    ['runId', { runId: 7 }, /^line 1: runId must be a non-empty string/],
  ];
  for (const [field, patch, msg] of bad) {
    it(`reports a bad ${field}`, () => {
      expect(() => parseMatchLog(patched(rt, 1, patch))).toThrow(msg);
    });
  }

  it('reports a missing field', () => {
    expect(() => parseMatchLog(without(rt, 1, 'seed'))).toThrow(
      /^line 1: seed must be an integer ≥ 0, got undefined/,
    );
    expect(() => parseMatchLog(without(rt, 1, 'optionOrderRule'))).toThrow(
      /^line 1: optionOrderRule must be a string/,
    );
  });

  it('reads the run id of a new header', () => {
    const log = parseMatchLog(patched(rt, 1, { runId: 'm-0123456789ab', runLocation: 'sim' }));
    expect(log.header.runId).toBe('m-0123456789ab');
    expect(log.header.schemaVersion).toBe(2);
  });

  it('reads an older v2 header without a run id as unknown, or sim for a simulated run', () => {
    const old = without(rt, 1, 'runId');
    expect(old.split('\n')[0]).not.toContain('runId');
    expect(parseMatchLog(old).header).toMatchObject({ runId: 'unknown', runLocation: 'test' });
    const oldSim = without(
      rt.map((l, i) => (i === 0 ? { ...l, runLocation: 'sim' } : l)),
      1,
      'runId',
    );
    expect(parseMatchLog(oldSim).header).toMatchObject({ runId: 'sim', runLocation: 'sim' });
  });

  it('checks each seat, naming it', () => {
    const header = rt[0];
    if (header?.type !== 'header') throw new Error('no header');
    const [s0, s1] = header.seats;
    const withSeats = (a: unknown, b: unknown): string => patched(rt, 1, { seats: [a, b] });
    expect(() => parseMatchLog(withSeats(s0, { ...s1, seat: 0 }))).toThrow(
      /^line 1: seats\[1\]\.seat must be 1/,
    );
    expect(() => parseMatchLog(withSeats(s0, { ...s1, hosting: 'cloud' }))).toThrow(
      /^line 1: seats\[1\]\.hosting must be vendor-api, edge, local or null/,
    );
    expect(() => parseMatchLog(withSeats({ ...s0, player: null }, s1))).toThrow(
      /^line 1: seats\[0\]\.player must be a string/,
    );
    expect(() => parseMatchLog(withSeats(s0, { ...s1, price: { inputPerMTokUsd: 'x' } }))).toThrow(
      /^line 1: seats\[1\]\.price\.inputPerMTokUsd must be a finite number/,
    );
    expect(() =>
      parseMatchLog(withSeats(s0, { ...s1, warmup: { ...s1.warmup, status: 'dropped' } })),
    ).toThrow(/^line 1: seats\[1\]\.warmup\.status must be ok, timeout, error or refusal/);
  });
});

describe('parseMatchLog: decision fields', () => {
  let d = 0;
  let missLine = 0;
  beforeAll(() => {
    d = lineOf(rt, (l) => isDecision(l) && l.status === 'ok');
    missLine = lineOf(rt, (l) => isDecision(l) && l.status === 'timeout');
  });

  const bad: [string, Record<string, unknown>, RegExp][] = [
    ['seat', { seat: 2 }, /seat must be 0 or 1, got 2/],
    ['seq', { seq: -1 }, /seq must be an integer ≥ 0/],
    ['questionKey', { questionKey: 4 }, /questionKey must be a string/],
    ['sentTick', { sentTick: 'soon' }, /sentTick must be an integer ≥ 0/],
    ['appliedTick (fraction)', { appliedTick: 1.5 }, /appliedTick must be an integer ≥ 0 or null/],
    ['appliedTick (negative)', { appliedTick: -1 }, /appliedTick must be an integer ≥ 0 or null/],
    ['latencyMs', { latencyMs: 'fast' }, /latencyMs must be a finite number/],
    ['choice', { choice: 3 }, /choice must be a string or null/],
    ['probabilities (array)', { probabilities: [0.5] }, /probabilities must be an object or null/],
    [
      'probabilities (value)',
      { probabilities: { up: null } },
      /probabilities\.up must be a finite number/,
    ],
    ['confidence', { confidence: 'high' }, /confidence must be a finite number or null/],
    ['inputTokens', { inputTokens: '12' }, /inputTokens must be a finite number or null/],
    ['costUsd', { costUsd: null }, /costUsd must be a finite number/],
    ['costEstimated', { costEstimated: false }, /costEstimated must be true when present/],
    [
      'probabilitiesPartial',
      { probabilitiesPartial: false },
      /probabilitiesPartial must be true when present/,
    ],
    ['status', { status: 'great' }, /status must be ok, timeout, error, dropped or refusal/],
    ['error', { error: 404 }, /error must be a string/],
    ['correct', { correct: 'yes' }, /correct must be a boolean/],
  ];
  for (const [field, patch, msg] of bad) {
    it(`reports a bad ${field} with its line number`, () => {
      const re = new RegExp(`^line ${String(d)}: ${msg.source}`);
      expect(() => parseMatchLog(patched(rt, d, patch))).toThrow(re);
    });
  }

  it('reports a choice that is not a key of probabilities, unless probabilitiesPartial is set', () => {
    const patch = { choice: 'up', probabilities: { down: 0.6, left: 0.4 } };
    expect(() => parseMatchLog(patched(rt, d, patch))).toThrow(
      new RegExp(
        `^line ${String(d)}: choice must be a key of probabilities ` +
          `\\(or probabilitiesPartial true\\), got "up"`,
      ),
    );
    const log = parseMatchLog(patched(rt, d, { ...patch, probabilitiesPartial: true }));
    const line = log.decisions.find((x) => x.probabilitiesPartial === true);
    expect(line).toMatchObject({ choice: 'up', probabilities: { down: 0.6, left: 0.4 } });
  });

  it('reports an ok decision without a choice', () => {
    expect(() => parseMatchLog(patched(rt, d, { choice: null }))).toThrow(
      new RegExp(`^line ${String(d)}: choice must be a string when status is ok`),
    );
  });

  it('allows a miss without a choice, and a missing optional field', () => {
    const log = parseMatchLog(without(rt, missLine, 'costEstimated'));
    expect(log.decisions.find((x) => x.status === 'timeout')?.choice).toBeNull();
  });

  const refusalPatch = (status: string, error: string) => ({
    status,
    error,
    choice: null,
    appliedTick: null,
    probabilities: null,
  });

  it('reads a refusal line (status refusal, no choice)', () => {
    const log = parseMatchLog(patched(rt, missLine, refusalPatch('refusal', REFUSAL_ERROR)));
    const line = log.decisions.find((x) => x.status === 'refusal');
    expect(line).toMatchObject({ status: 'refusal', error: REFUSAL_ERROR, choice: null });
  });

  it('reads an older log’s refusal (status error, exactly REFUSAL_ERROR) as a refusal', () => {
    // How every log written before 2026-10-12 recorded an OpenAI refusal.
    expect(REFUSAL_ERROR).toBe('invalid answer: refusal');
    const log = parseMatchLog(patched(rt, missLine, refusalPatch('error', REFUSAL_ERROR)));
    const target = rt[missLine - 1] as DecisionLine;
    const line = log.decisions.find((x) => x.seat === target.seat && x.seq === target.seq);
    expect(line).toMatchObject({ status: 'refusal', error: REFUSAL_ERROR, choice: null });
    expect(readLogLine({ ...rt[missLine - 1], ...refusalPatch('error', REFUSAL_ERROR) })).toEqual(
      expect.objectContaining({ status: 'refusal' }),
    );
    // Any other error stays an error, near misses included.
    for (const error of ['invalid answer: refusal ', 'refusal', 'http 503: refusal', 'network']) {
      const other = parseMatchLog(patched(rt, missLine, refusalPatch('error', error)));
      expect(other.decisions.some((x) => x.status === 'refusal')).toBe(false);
      expect(other.decisions.find((x) => x.error === error)?.status).toBe('error');
    }
  });
});

describe('parseMatchLog: event and match_end fields', () => {
  it('reports a bad event', () => {
    const e = lineOf(rt, isEvent);
    expect(() => parseMatchLog(patched(rt, e, { tick: -2 }))).toThrow(
      new RegExp(`^line ${String(e)}: tick must be an integer ≥ 0`),
    );
    expect(() => parseMatchLog(patched(rt, e, { game: { k: 1 } }))).toThrow(
      new RegExp(`^line ${String(e)}: game\\.kind must be a string`),
    );
    expect(() => parseMatchLog(patched(rt, e, { game: 'window' }))).toThrow(
      new RegExp(`^line ${String(e)}: game must be an object`),
    );
  });

  it('reports a bad match_end', () => {
    const n = rt.length;
    const bad: [Partial<Record<keyof MatchEndLine, unknown>>, RegExp][] = [
      [{ winner: 2 }, /winner must be 0, 1, "draw" or null/],
      [{ scores: ['a', 1] }, /scores must be a pair of finite numbers/],
      [{ scores: [1] }, /scores must be a pair of finite numbers/],
      [{ totalTicks: 1.5 }, /totalTicks must be an integer ≥ 0/],
      [{ finalStateHash: null }, /finalStateHash must be a string/],
      [{ valid: 'yes' }, /valid must be a boolean/],
      [{ missRates: null }, /missRates must be a pair of finite numbers/],
      [{ decisions: [1, -1] }, /decisions must be a pair of integers ≥ 0/],
      [{ costUsd: 'free' }, /costUsd must be a finite number/],
    ];
    for (const [patch, msg] of bad) {
      expect(() => parseMatchLog(patched(rt, n, patch))).toThrow(
        new RegExp(`^line ${String(n)}: ${msg.source}`),
      );
    }
    const log = parseMatchLog(patched(rt, n, { winner: null }));
    expect(log.matchEnd?.winner).toBeNull();
  });

  it('reads timeoutRates when present (each at most its seat’s miss rate) and allows it absent', () => {
    const n = rt.length;
    const end = rt[n - 1] as MatchEndLine;
    expect(end.timeoutRates).toEqual(expect.any(Array));
    expect(parseMatchLog(toJsonl(rt)).matchEnd?.timeoutRates).toEqual(end.timeoutRates);
    // Logs written before timeoutRates existed have none.
    expect(parseMatchLog(without(rt, n, 'timeoutRates')).matchEnd).not.toHaveProperty(
      'timeoutRates',
    );
    const withMisses = { missRates: [0.5, 0.25] };
    expect(
      parseMatchLog(patched(rt, n, { ...withMisses, timeoutRates: [0.5, 0.1] })).matchEnd
        ?.timeoutRates,
    ).toEqual([0.5, 0.1]);
    const bad: [Record<string, unknown>, RegExp][] = [
      [{ timeoutRates: null }, /timeoutRates must be a pair of finite numbers/],
      [{ timeoutRates: [0.1] }, /timeoutRates must be a pair of finite numbers/],
      [{ timeoutRates: [0.6, 0] }, /timeoutRates must be a pair of rates ≥ 0, each at most/],
      [{ timeoutRates: [0, -0.1] }, /timeoutRates must be a pair of rates ≥ 0/],
    ];
    for (const [patch, msg] of bad) {
      expect(() => parseMatchLog(patched(rt, n, { ...withMisses, ...patch }))).toThrow(
        new RegExp(`^line ${String(n)}: ${msg.source}`),
      );
    }
  });
});

describe('parseMatchLog: match_end refusalRates', () => {
  it('reads refusalRates when present (each from 0 to 1) and allows it absent', () => {
    const n = rt.length;
    const end = rt[n - 1] as MatchEndLine;
    // The schedulers write it in every new log.
    expect(end.refusalRates).toEqual([0, 0]);
    expect(parseMatchLog(toJsonl(rt)).matchEnd?.refusalRates).toEqual([0, 0]);
    // Logs written before the refusal rule have none.
    expect(parseMatchLog(without(rt, n, 'refusalRates')).matchEnd).not.toHaveProperty(
      'refusalRates',
    );
    // Not part of missRates, so it may exceed them.
    const noMisses = { missRates: [0, 0], timeoutRates: [0, 0] };
    expect(
      parseMatchLog(patched(rt, n, { ...noMisses, refusalRates: [0.25, 1] })).matchEnd
        ?.refusalRates,
    ).toEqual([0.25, 1]);
    const bad: [Record<string, unknown>, RegExp][] = [
      [{ refusalRates: null }, /refusalRates must be a pair of finite numbers/],
      [{ refusalRates: [0.1, 0.2, 0.3] }, /refusalRates must be a pair of finite numbers/],
      [{ refusalRates: [-0.1, 0] }, /refusalRates must be a pair of rates from 0 to 1/],
      [{ refusalRates: [0, 1.5] }, /refusalRates must be a pair of rates from 0 to 1/],
    ];
    for (const [patch, msg] of bad) {
      expect(() => parseMatchLog(patched(rt, n, patch))).toThrow(
        new RegExp(`^line ${String(n)}: ${msg.source}`),
      );
    }
  });
});

describe('parseMatchLog: match_end stalls', () => {
  it('round-trips stalls, allows them absent (older logs), and requires valid false with them', () => {
    const n = rt.length;
    const end = rt[n - 1] as MatchEndLine;
    // A match without a stall writes no stalls field, and older logs never had one.
    expect(end).not.toHaveProperty('stalls');
    expect(parseMatchLog(toJsonl(rt)).matchEnd).not.toHaveProperty('stalls');
    const stalls = [
      { atTick: 120, gapMs: 4983 },
      { atTick: 400, gapMs: 251 },
    ];
    const read = parseMatchLog(patched(rt, n, { valid: false, stalls })).matchEnd;
    expect(read?.stalls).toEqual(stalls);
    expect(read?.valid).toBe(false);
    const bad: [Record<string, unknown>, RegExp][] = [
      [{ valid: false, stalls: null }, /stalls must be an array/],
      [{ valid: false, stalls: [7] }, /stalls\[0\] must be an object/],
      [{ valid: false, stalls: [{ atTick: -1, gapMs: 300 }] }, /stalls\[0\]\.atTick must be/],
      [{ valid: false, stalls: [{ atTick: 1 }] }, /stalls\[0\]\.gapMs must be a finite number/],
      [{ valid: false, stalls: [{ atTick: 1, gapMs: 0 }] }, /stalls\[0\]\.gapMs must be above 0/],
      [{ valid: true, stalls }, /valid must be false when stalls are recorded/],
    ];
    for (const [patch, msg] of bad) {
      expect(() => parseMatchLog(patched(rt, n, patch))).toThrow(
        new RegExp(`^line ${String(n)}: ${msg.source}`),
      );
    }
  });
});

describe('readLogLine', () => {
  it('checks one line of any v2 type on its own, as parseMatchLog would', () => {
    for (const line of [...rt, ...tn]) expect(readLogLine(viaJson(line))).toEqual(viaJson(line));
  });

  it('refuses v1 and unknown lines without a line number', () => {
    const header = rt[0];
    expect(() => readLogLine({ ...header, schemaVersion: 1 })).toThrow(/^schema v1 logs/);
    expect(() => readLogLine({ type: 'round_end', round: 1 })).toThrow(
      /^unknown line type "round_end"$/,
    );
    expect(() => readLogLine([])).toThrow(/^expected a JSON object$/);
    const decision = rt.find(isDecision);
    expect(() => readLogLine({ ...decision, status: 'maybe' })).toThrow(/^status must be/);
  });
});
