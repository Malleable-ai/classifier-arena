import { beforeAll, describe, expect, it } from 'vitest';
import { parseMatchLog, type MatchLog } from '../../../src/core/log/read.js';
import {
  FeaturedMatchError,
  buildResultsIndex,
  parseFeatured,
} from '../../../src/core/replay/results-index.js';
import { matchIdFor } from '../../../src/core/results/paths.js';
import { REFUSAL_ERROR } from '../../../src/core/classifier/types.js';
import { realtimeLines, toJsonl, turnLines } from '../log/fixtures.js';
import { NO_EXCLUSIONS } from '../../../src/core/results/excluded.js';

const WHEN = '2026-10-07T12:00:00.000Z';
const RT_ID = matchIdFor({
  game: 'counter_realtime',
  a: 'random',
  b: 'fake_provider',
  when: WHEN,
  run: 1,
});
const TN_ID = matchIdFor({
  game: 'counter_turns',
  a: 'random',
  b: 'fake_provider',
  when: WHEN,
  run: 1,
});

let rt: MatchLog;
let tn: MatchLog;

beforeAll(async () => {
  rt = parseMatchLog(toJsonl(await realtimeLines({ seed: 20261007, matchId: RT_ID })));
  tn = parseMatchLog(toJsonl(await turnLines({ seed: 20261007, matchId: TN_ID })));
});

function end(log: MatchLog) {
  if (log.matchEnd === null) throw new Error('no match_end');
  return log.matchEnd;
}

describe('buildResultsIndex', () => {
  it('has one entry per finished match with every field, sorted by id', () => {
    const idx = buildResultsIndex([tn, rt], { featured: {}, excluded: NO_EXCLUSIONS });
    expect(idx.schemaVersion).toBe(2);
    expect(idx.matches.map((m) => m.id)).toEqual([RT_ID, TN_ID].sort());
    const e = idx.matches.find((m) => m.id === RT_ID);
    const m = end(rt);
    const winnerSeat = m.winner === 0 || m.winner === 1 ? m.winner : null;
    expect(e).toStrictEqual({
      id: RT_ID,
      game: 'counter_realtime',
      file: `counter_realtime/matches/${RT_ID}.jsonl`,
      players: ['random', 'fake_provider'],
      labels: ['random', 'fake_provider'],
      winner: winnerSeat === null ? 'draw' : (['random', 'fake_provider'] as const)[winnerSeat],
      winnerSeat,
      scores: m.scores,
      valid: m.valid,
      featured: false,
      seed: 20261007,
      startTime: '2026-10-07T00:00:00.000Z',
      totalTicks: 600,
      finalStateHash: m.finalStateHash,
      costUsd: m.costUsd,
    });
    expect(idx.matches.find((x) => x.id === TN_ID)).toMatchObject({
      game: 'counter_turns',
      file: `counter_turns/matches/${TN_ID}.jsonl`,
      totalTicks: 10,
      scores: end(tn).scores,
    });
  });

  it('names the winner by player id, or "draw" (also for a match_end without a winner)', () => {
    const won = (winner: 0 | 1 | 'draw' | null): MatchLog => ({
      ...rt,
      matchEnd: { ...end(rt), winner },
    });
    const one = (log: MatchLog) =>
      buildResultsIndex([log], { featured: {}, excluded: NO_EXCLUSIONS }).matches[0];
    expect(one(won(0))).toMatchObject({ winner: 'random', winnerSeat: 0 });
    expect(one(won(1))).toMatchObject({ winner: 'fake_provider', winnerSeat: 1 });
    expect(one(won('draw'))).toMatchObject({ winner: 'draw', winnerSeat: null });
    expect(one(won(null))).toMatchObject({ winner: 'draw', winnerSeat: null });
  });

  it("marks each game's featured match and only those", () => {
    const idx = buildResultsIndex([rt, tn], {
      featured: { counter_turns: TN_ID },
      excluded: NO_EXCLUSIONS,
    });
    expect(idx.matches.filter((m) => m.featured).map((m) => m.id)).toEqual([TN_ID]);
    const both = buildResultsIndex([rt, tn], {
      featured: { counter_realtime: RT_ID, counter_turns: TN_ID },
      excluded: NO_EXCLUSIONS,
    });
    expect(both.matches.filter((m) => m.featured).map((m) => m.id)).toEqual([RT_ID, TN_ID]);
  });

  it('rejects a featured id that is not indexed (including an unfinished match)', () => {
    expect(() =>
      buildResultsIndex([rt], { featured: { counter_realtime: 'zzz' }, excluded: NO_EXCLUSIONS }),
    ).toThrow(new FeaturedMatchError('featured match "zzz" is not among the indexed matches'));
    expect(() =>
      buildResultsIndex([{ ...rt, matchEnd: null }], {
        featured: { counter_realtime: RT_ID },
        excluded: NO_EXCLUSIONS,
      }),
    ).toThrow(FeaturedMatchError);
  });

  it("rejects a featured match filed under another game's key", () => {
    expect(() =>
      buildResultsIndex([rt, tn], {
        featured: { counter_realtime: TN_ID },
        excluded: NO_EXCLUSIONS,
      }),
    ).toThrow(`featured match "${TN_ID}" is a counter_turns match, not counter_realtime`);
  });

  it('marks validity under the current rule, recomputed from the decisions', () => {
    const one = (log: MatchLog) =>
      buildResultsIndex([log], { featured: {}, excluded: NO_EXCLUSIONS }).matches[0];
    // Logged invalid, but its only no-answers are refusals (older form): valid in the index.
    const refusedOnly: MatchLog = {
      ...tn,
      decisions: tn.decisions.map((d) =>
        d.status === 'ok' ? d : { ...d, status: 'error', error: REFUSAL_ERROR },
      ),
      matchEnd: { ...end(tn), valid: false },
    };
    expect(refusedOnly.decisions.some((d) => d.error === REFUSAL_ERROR)).toBe(true);
    expect(one(refusedOnly)?.valid).toBe(true);
    // Logged valid, but a transport failure in 11 decisions is over 2%: invalid in the index.
    const last = tn.decisions.at(-1);
    if (last === undefined) throw new Error('no decisions');
    const failed: MatchLog = {
      ...tn,
      decisions: [
        ...tn.decisions,
        { ...last, seq: last.seq + 1, status: 'error', error: 'http 503: x', choice: null },
      ],
      matchEnd: { ...end(tn), valid: true },
    };
    expect(one(failed)?.valid).toBe(false);
  });

  it('skips logs without a match_end', () => {
    const idx = buildResultsIndex([rt, { ...tn, matchEnd: null }], {
      featured: {},
      excluded: NO_EXCLUSIONS,
    });
    expect(idx.matches.map((m) => m.id)).toEqual([RT_ID]);
  });

  it('rejects two logs with the same match id', () => {
    expect(() => buildResultsIndex([rt, rt], { featured: {}, excluded: NO_EXCLUSIONS })).toThrow(
      /twice/,
    );
  });
});

describe('parseFeatured', () => {
  it('accepts an object of game id to match id', () => {
    expect(parseFeatured({ fighter: 'a-b-c', clues: 'd-e-f' })).toEqual({
      fighter: 'a-b-c',
      clues: 'd-e-f',
    });
    expect(parseFeatured({})).toEqual({});
  });

  it('rejects anything else, naming the bad entry', () => {
    for (const bad of [null, [], 'fighter', 3]) {
      expect(() => parseFeatured(bad)).toThrow('must be an object of game id to match id');
    }
    expect(() => parseFeatured({ Fighter: 'x' })).toThrow('"Fighter" is not a game id');
    expect(() => parseFeatured({ fighter: 7 })).toThrow('"fighter" must name a match id, got 7');
    expect(() => parseFeatured({ fighter: '' })).toThrow('"fighter" must name a match id');
  });
});
