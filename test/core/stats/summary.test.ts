import { describe, expect, it } from 'vitest';
import { parseMatchLog, type MatchLog } from '../../../src/core/log/read.js';
import { MAX_MISS_RATE } from '../../../src/core/sched/validity.js';
import { summarizeGame, type GameSummary } from '../../../src/core/stats/summary.js';
import { summaryMarkdown } from '../../../src/core/stats/markdown.js';
import {
  CLUES,
  FIGHTER,
  INBOX,
  cluesMatch,
  decision,
  failure,
  fakeLog,
  refusal,
  toJsonl,
} from './helpers.js';
import { NO_EXCLUSIONS } from '../../../src/core/results/excluded.js';

/** `expect.closeTo`, typed as the number it stands in for. */
const close = (x: number, digits: number): number => expect.closeTo(x, digits) as number;
/**
 * summarizeGame over hand-built logs. Every expected number below is worked out by hand from the
 * logs in `inboxLogs()`; the comments show the arithmetic.
 */

const legit = (seat: 0 | 1, latencyMs: number, correct: boolean, costUsd = 0) =>
  decision(seat, { latencyMs, correct, costUsd });

/**
 * M1–M5 are Jev vs OpenAI (M4 invalid), M6 Jev vs random, M7/M8 random vs scripted, M9 random vs
 * random, M10 unfinished.
 */
function inboxLogs(): Record<string, MatchLog> {
  return {
    // Jev (seat 0) wins.
    m1: fakeLog({
      players: ['jev', 'openai'],
      winner: 0,
      scores: [40, 10],
      totalTicks: 3000,
      runId: 'm-aaaaaaaaaaaa',
    }),
    // OpenAI (seat 0) wins: a Jev loss.
    m2: fakeLog({
      players: ['openai', 'jev'],
      winner: 0,
      scores: [30, 25],
      totalTicks: 3000,
      runId: 'm-aaaaaaaaaaaa',
    }),
    // A draw, margin 0: the featured match.
    m3: fakeLog({
      players: ['jev', 'openai'],
      winner: 'draw',
      scores: [20, 20],
      totalTicks: 2000,
      run: 2,
      runId: 'm-aaaaaaaaaaaa',
    }),
    // Invalid (Jev's one decision is a transport failure): excluded everywhere except the invalid
    // counts, even its decisions and run id.
    m4: fakeLog({
      players: ['openai', 'jev'],
      winner: 1,
      scores: [0, 50],
      valid: false,
      run: 2,
      runId: 'm-bbbbbbbbbbbb',
      decisions: [failure(1, { latencyMs: 9999, costUsd: 1 })],
    }),
    // Jev (seat 0) wins.
    m5: fakeLog({
      players: ['jev', 'openai'],
      winner: 0,
      scores: [12, 9],
      run: 3,
      runId: 'm-aaaaaaaaaaaa',
    }),
    // Jev vs random, with Jev's decisions worked out by hand.
    m6: fakeLog({
      players: ['jev', 'random'],
      winner: 0,
      scores: [60, 0],
      runId: 'm-aaaaaaaaaaaa',
      warmupCostUsd: [0.002, 0],
      decisions: [
        legit(0, 100, true, 0.001),
        legit(0, 200, true, 0.001),
        legit(0, 300, false, 0.001),
        legit(0, 400, true, 0.001),
        decision(0, {
          status: 'dropped',
          error: 'dropped: landed',
          latencyMs: 500,
          costUsd: 0.001,
        }),
        // A refusal: billed, a decision, not a miss, and it leaves the match valid.
        refusal(0, { latencyMs: 180, costUsd: 0.001 }),
        // Still in flight at the end: billed, but not a decision (validity.ts).
        decision(0, { status: 'dropped', error: 'matchOver', latencyMs: 50, costUsd: 0.001 }),
        legit(1, 200, true),
        legit(1, 200, false),
      ],
    }),
    m7: fakeLog({
      players: ['random', 'scripted'],
      winner: 1,
      scores: [0, 8],
      decisions: [legit(0, 200, false), legit(1, 200, true)],
    }),
    m8: fakeLog({ players: ['scripted', 'random'], winner: 0, scores: [5, 0] }),
    // A mirror pairing: its record is seat 0's.
    m9: fakeLog({
      players: ['random', 'random'],
      winner: 1,
      scores: [1, 3],
      decisions: [legit(0, 200, true), legit(1, 200, true)],
    }),
    m10: fakeLog({
      players: ['jev', 'random'],
      winner: null,
      scores: [0, 0],
      run: 2,
      finished: false,
      decisions: [legit(0, 100, true, 0.5)],
    }),
  };
}

describe('summarizeGame', () => {
  const logs = inboxLogs();
  const s: GameSummary = summarizeGame(INBOX, Object.values(logs), NO_EXCLUSIONS);
  const id = (k: keyof ReturnType<typeof inboxLogs>): string => logs[k]?.header.matchId ?? '';

  it('names the game and counts valid, invalid and unfinished matches separately', () => {
    expect(s).toMatchObject({
      schemaVersion: 5,
      game: 'inbox',
      label: 'Inbox Invaders',
      graded: true,
      gameVersion: 1,
      matches: { total: 10, valid: 8, invalid: 1, excluded: 0, unfinished: 1, olderVersion: 0 },
      // Jev's one decision failed and took 9,999 ms, past the 1 s timeout plus 250 ms: a stall the
      // log shows. OpenAI made no decisions, and Jev's every decision was an error.
      invalidMatches: [
        {
          id: id('m4'),
          reason:
            'stall (from the log); OpenAI Decisions (seat 0) made no decisions; Jev (seat 1) had ' +
            'transport errors on 100.0% of its decisions (limit 2%)',
        },
      ],
      excluded: [],
      olderVersion: [],
      // Every log's own match_end.valid agrees with the current rule.
      rescored: [],
    });
  });

  it('collects the run ids of the valid provider matches (the invalid one is not counted)', () => {
    expect(s.runIds).toEqual(['m-aaaaaaaaaaaa']);
  });

  it('collects every distinct run id, sorted; baselines-only matches add none', () => {
    const ids = summarizeGame(
      INBOX,
      [
        fakeLog({ players: ['jev', 'openai'], winner: 0, scores: [2, 1], runId: 'm-222222222222' }),
        fakeLog({
          players: ['openai', 'jev'],
          winner: 0,
          scores: [2, 1],
          run: 2,
          runId: 'm-111111111111',
          runLocation: 'a label that does not matter',
        }),
        fakeLog({
          players: ['jev', 'random'],
          winner: 0,
          scores: [2, 1],
          run: 3,
          runId: 'm-222222222222',
        }),
        fakeLog({ players: ['random', 'scripted'], winner: 0, scores: [2, 1], runId: 'sim' }),
      ],
      NO_EXCLUSIONS,
    ).runIds;
    expect(ids).toEqual(['m-111111111111', 'm-222222222222']);
  });

  it('totals the spend of every log, valid or not: decisions plus warm-ups', () => {
    // m4: 1; m6: 7 × 0.001 + 0.002 warm-up; m10 (unfinished): 0.5.
    expect(s.totalCostUsd).toBeCloseTo(1 + 0.009 + 0.5, 12);
  });

  it('head to head: draws count ½ and the invalid match is left out', () => {
    const h2h = s.pairings[0];
    // m1 W, m2 L, m3 D, m5 W (from Jev's side): (2 + ½) / 4.
    expect(h2h).toMatchObject({
      players: ['jev', 'openai'],
      labels: ['Jev (TypeSafe)', 'OpenAI Decisions (gpt-6-luna)'],
      headToHead: true,
      matches: 4,
      invalid: 1,
      wins: 2,
      draws: 1,
      losses: 1,
    });
    expect(h2h?.winRate.p).toBe(0.625);
    expect(h2h?.winRate.low).toBeCloseTo(0.2194, 4);
    expect(h2h?.winRate.high).toBeCloseTo(0.9081, 4);
  });

  it('lists head to head first, then the other pairings by player id', () => {
    expect(s.pairings.map((p) => [p.players, p.headToHead, p.matches, p.wins, p.losses])).toEqual([
      [['jev', 'openai'], true, 4, 2, 1],
      [['jev', 'random'], false, 1, 1, 0],
      // A mirror pairing's record is seat 0's: m9 seat 1 won.
      [['random', 'random'], false, 1, 0, 1],
      // Both scripted wins are random's losses (players[0] is random).
      [['random', 'scripted'], false, 2, 0, 2],
    ]);
    const vsScripted = s.pairings[3];
    expect(vsScripted?.winRate).toEqual({ p: 0, low: 0, high: close(0.6576, 4) });
  });

  it('per player: decisions, misses, refusals, accuracy, latency and cost from valid matches only', () => {
    const jev = s.players.find((p) => p.player === 'jev');
    expect(jev).toEqual({
      player: 'jev',
      label: 'Jev (TypeSafe)',
      kind: 'provider',
      model: 'jev-latest',
      hosting: 'vendor-api',
      // m1, m2, m3, m5, m6 (m4 is invalid, m10 unfinished).
      matches: 5,
      // m1–m5's default ok line each (4), then m6: 4 ok + 1 dropped + 1 refusal; the matchOver
      // line is not a decision.
      decisions: 10,
      // A refusal is not a miss.
      misses: 0,
      missRate: 0,
      refusals: 1,
      refusalRate: 1 / 10,
      dropped: 1,
      // 3 of the 4 m6 ok lines with a `correct` field (the default lines are ungraded).
      graded: 4,
      correct: 3,
      accuracy: 0.75,
      // ok and dropped: [100 × 5, 200, 300, 400, 500] → ranks ⌈4.5⌉ = 5 and ⌈8.55⌉ = 9.
      latencyMs: { p50: 100, p95: 500, n: 9 },
      // 7 m6 lines × $0.001 (the matchOver one too: it was billed) + the $0.002 warm-up.
      costUsd: close(0.009, 12),
      // $0.009 / 10 decisions × 1000.
      costPer1000: close(0.9, 12),
    });
  });

  it('a mirror match counts once for matches and both seats for decisions', () => {
    const random = s.players.find((p) => p.player === 'random');
    expect(random).toMatchObject({
      kind: 'baseline',
      label: 'Random (uniform)',
      model: null,
      // m6, m7, m8, m9.
      matches: 4,
      // m6: 2, m7: 1, m9: 2.
      decisions: 5,
      graded: 5,
      // m6: 1, m7: 0, m9: 2.
      correct: 3,
      accuracy: 0.6,
      latencyMs: { p50: 200, p95: 200, n: 5 },
      costUsd: 0,
      costPer1000: 0,
    });
  });

  it('a player with no decisions has no accuracy, latency or cost rate', () => {
    // Only a baseline can: a real-time provider seat with no decisions makes a match invalid.
    const quiet = summarizeGame(
      INBOX,
      [fakeLog({ players: ['scripted', 'random'], winner: 0, scores: [5, 0] })],
      NO_EXCLUSIONS,
    );
    expect(quiet.matches.valid).toBe(1);
    expect(quiet.players.find((p) => p.player === 'scripted')).toMatchObject({
      matches: 1,
      decisions: 0,
      missRate: 0,
      graded: 0,
      accuracy: null,
      latencyMs: { p50: null, p95: null, n: 0 },
      costPer1000: null,
    });
  });

  it('lists providers first, then baselines, each by id', () => {
    expect(s.players.map((p) => p.player)).toEqual(['jev', 'openai', 'random', 'scripted']);
    expect(s.players.find((p) => p.player === 'scripted')).toMatchObject({
      label: 'Scripted bot',
      accuracy: 1,
    });
  });

  it('features the valid head-to-head with the smallest score margin', () => {
    expect(s.featured).toEqual({
      id: id('m3'),
      players: ['jev', 'openai'],
      winner: 'draw',
      scores: [20, 20],
      margin: 0,
      totalTicks: 2000,
    });
  });

  it('ignores logs of other games', () => {
    const other = fakeLog({
      game: 'fighter',
      players: ['jev', 'openai'],
      winner: 0,
      scores: [2, 0],
    });
    expect(summarizeGame(INBOX, [...Object.values(logs), other], NO_EXCLUSIONS)).toEqual(s);
  });
});

describe('summarizeGame: accuracy needs a graded game', () => {
  it('reports no accuracy for an ungraded game even if a line carries `correct`', () => {
    const s = summarizeGame(
      FIGHTER,
      [
        fakeLog({
          game: 'fighter',
          players: ['jev', 'scripted'],
          winner: 0,
          scores: [2, 1],
          decisions: [decision(0, { correct: true, choice: 'punch' })],
        }),
      ],
      NO_EXCLUSIONS,
    );
    expect(s.graded).toBe(false);
    expect(s.players.find((p) => p.player === 'jev')).toMatchObject({
      decisions: 1,
      graded: 0,
      correct: 0,
      accuracy: null,
    });
  });
});

describe('summarizeGame: the featured match', () => {
  const h2h = (
    players: [string, string],
    scores: [number, number],
    totalTicks: number,
    time: string,
    extra: { valid?: boolean } = {},
  ) =>
    fakeLog({
      players,
      winner: scores[0] === scores[1] ? 'draw' : scores[0] > scores[1] ? 0 : 1,
      scores,
      totalTicks,
      time,
      ...extra,
    });

  it('ties on margin go to the longer match, then the earliest id', () => {
    const a = h2h(['jev', 'openai'], [5, 4], 1000, '12:00:00');
    const b = h2h(['openai', 'jev'], [3, 4], 2000, '12:00:05');
    const c = h2h(['jev', 'openai'], [7, 8], 2000, '12:00:01');
    const d = h2h(['jev', 'openai'], [9, 2], 9000, '11:00:00');
    expect(summarizeGame(INBOX, [a, b, c, d], NO_EXCLUSIONS).featured?.id).toBe(c.header.matchId);
    expect(summarizeGame(INBOX, [a, b, d], NO_EXCLUSIONS).featured?.id).toBe(b.header.matchId);
    expect(summarizeGame(INBOX, [a, d], NO_EXCLUSIONS).featured?.id).toBe(a.header.matchId);
  });

  it('only a valid match between two different providers can be featured', () => {
    const invalid = h2h(['jev', 'openai'], [4, 4], 3000, '12:00:00', { valid: false });
    const baseline = h2h(['jev', 'random'], [3, 3], 3000, '12:00:01');
    const mirror = h2h(['jev', 'jev'], [2, 2], 3000, '12:00:02');
    expect(summarizeGame(INBOX, [invalid, baseline, mirror], NO_EXCLUSIONS).featured).toBeNull();
    const ok = h2h(['openai', 'jev'], [10, 1], 100, '12:00:03');
    expect(summarizeGame(INBOX, [invalid, baseline, mirror, ok], NO_EXCLUSIONS).featured?.id).toBe(
      ok.header.matchId,
    );
  });

  it('no logs: an empty summary', () => {
    expect(summarizeGame(INBOX, [], NO_EXCLUSIONS)).toMatchObject({
      matches: { total: 0, valid: 0, invalid: 0, excluded: 0, unfinished: 0, olderVersion: 0 },
      players: [],
      pairings: [],
      featured: null,
      runIds: [],
      totalCostUsd: 0,
    });
  });
});

describe('summarizeGame: the run-level miss check', () => {
  /** `n` turn decisions for `seat`, the first `misses` of them timeouts. */
  const turns = (seat: 0 | 1, n: number, misses: number) =>
    Array.from({ length: n }, (_, t) =>
      t < misses
        ? decision(seat, {
            sentTick: t,
            appliedTick: t,
            status: 'timeout',
            error: 'timeout',
            choice: null,
            latencyMs: 1000,
          })
        : decision(seat, { sentTick: t, appliedTick: t, correct: true }),
    );
  /** A valid Jev vs OpenAI Clue Clash match: 16 turns each, with these misses. */
  const match = (
    misses: [number, number],
    run: number,
    seats: [string, string] = ['jev', 'openai'],
  ) =>
    fakeLog({
      game: 'clues',
      players: seats,
      winner: 0,
      scores: [10, 9],
      totalTicks: 16,
      run,
      decisions: [...turns(0, 16, misses[0]), ...turns(1, 16, misses[1])],
    });

  it('passes when every player misses at most 2% over the run, seats pooled', () => {
    // OpenAI misses 1 of 64 decisions over four matches (1.6%), though one match alone is 6.3%.
    const s = summarizeGame(
      CLUES,
      [
        match([0, 1], 1),
        match([0, 0], 2, ['openai', 'jev']),
        match([0, 0], 3),
        match([0, 0], 4, ['openai', 'jev']),
      ],
      NO_EXCLUSIONS,
    );
    expect(s.runCheck).toEqual({ maxMissRate: MAX_MISS_RATE, passed: true, failing: [] });
  });

  it('fails with the rate of each player over 2%, worst first', () => {
    // OpenAI: 2 of 32 (6.25%); Jev: 1 of 32 (3.125%), in seat 1 of the second match.
    const s = summarizeGame(
      CLUES,
      [match([0, 2], 1), match([0, 1], 2, ['openai', 'jev'])],
      NO_EXCLUSIONS,
    );
    expect(s.runCheck).toEqual({
      maxMissRate: 0.02,
      passed: false,
      failing: [
        {
          player: 'openai',
          label: 'OpenAI Decisions (gpt-6-luna)',
          decisions: 32,
          misses: 2,
          missRate: 2 / 32,
        },
        { player: 'jev', label: 'Jev (TypeSafe)', decisions: 32, misses: 1, missRate: 1 / 32 },
      ],
    });
  });

  it('counts the published (valid) matches only, and errors as misses like timeouts', () => {
    // Invalid by OpenAI's transport failure; Jev's 16 timeouts (no count in a turn game) are not
    // in the run-level check either.
    const invalid = fakeLog({
      game: 'clues',
      players: ['jev', 'openai'],
      winner: 1,
      scores: [0, 16],
      valid: false,
      decisions: [...turns(0, 16, 16), failure(1)],
    });
    // Valid: OpenAI's one error in 50 is the 2% the match allows. With its one timeout, it
    // misses 2 of 50 (4%) over the run; its refusals are not misses.
    const withError = fakeLog({
      game: 'clues',
      players: ['jev', 'openai'],
      winner: 0,
      scores: [1, 0],
      run: 2,
      decisions: [
        ...turns(0, 50, 0),
        decision(1, { status: 'error', error: 'http 503', choice: null, appliedTick: 0 }),
        refusal(1, { sentTick: 1, appliedTick: 1 }),
        refusal(1, { sentTick: 2, appliedTick: 2 }),
        ...turns(1, 47, 1).map((d) => ({ ...d, sentTick: d.sentTick + 3 })),
      ],
    });
    const s = summarizeGame(CLUES, [invalid, withError], NO_EXCLUSIONS);
    expect(s.matches).toMatchObject({ valid: 1, invalid: 1 });
    expect(s.runCheck.failing.map((f) => [f.player, f.misses, f.decisions])).toEqual([
      ['openai', 2, 50],
    ]);
    expect(s.players.find((p) => p.player === 'openai')).toMatchObject({
      refusals: 2,
      refusalRate: 2 / 50,
    });
  });

  it('never counts refusals in the run-level check', () => {
    // OpenAI refuses 5 of its 16 asks in every match (31%): the check still passes.
    const refusing = (run: number) =>
      fakeLog({
        game: 'clues',
        players: ['jev', 'openai'],
        winner: 0,
        scores: [16, 11],
        run,
        decisions: [
          ...turns(0, 16, 0),
          ...turns(1, 16, 0).map((d, t) =>
            t < 5 ? refusal(1, { sentTick: t, appliedTick: t }) : d,
          ),
        ],
      });
    const s = summarizeGame(CLUES, [refusing(1), refusing(2)], NO_EXCLUSIONS);
    expect(s.matches.valid).toBe(2);
    expect(s.runCheck).toEqual({ maxMissRate: MAX_MISS_RATE, passed: true, failing: [] });
    expect(s.players.find((p) => p.player === 'openai')).toMatchObject({
      misses: 0,
      refusals: 10,
      refusalRate: 10 / 32,
    });
  });

  it('exactly 2% passes (the limit is "at most", as for one match)', () => {
    const fifty = (run: number) =>
      fakeLog({
        game: 'clues',
        players: ['jev', 'openai'],
        winner: 0,
        scores: [1, 0],
        run,
        decisions: [...turns(0, 50, 0), ...turns(1, 50, run === 1 ? 2 : 0)],
      });
    expect(summarizeGame(CLUES, [fifty(1), fifty(2)], NO_EXCLUSIONS).runCheck.passed).toBe(true);
  });

  it('checks real-time games too: their timeouts no longer make a match invalid either', () => {
    // OpenAI times out on 10 of 50 requests: the match is valid (and scored), and the run fails.
    const heavy = fakeLog({
      players: ['jev', 'openai'],
      winner: 0,
      scores: [1, 0],
      decisions: [...turns(0, 50, 0), ...turns(1, 50, 10)],
    });
    const s = summarizeGame(INBOX, [heavy], NO_EXCLUSIONS);
    expect(s.matches.valid).toBe(1);
    expect(s.runCheck).toEqual({
      maxMissRate: 0.02,
      passed: false,
      failing: [
        {
          player: 'openai',
          label: 'OpenAI Decisions (gpt-6-luna)',
          decisions: 50,
          misses: 10,
          missRate: 0.2,
        },
      ],
    });
    for (const game of [FIGHTER, INBOX, CLUES]) {
      expect(summarizeGame(game, [], NO_EXCLUSIONS).runCheck).toEqual({
        maxMissRate: 0.02,
        passed: true,
        failing: [],
      });
    }
  });
});

describe('summarizeGame: validity is re-scored from the decisions', () => {
  /** `n` ok decisions for `seat` in a real-time game. */
  const oks = (seat: 0 | 1, n: number) =>
    Array.from({ length: n }, (_, i) => decision(seat, { sentTick: i, choice: 'punch' }));

  /**
   * A fighter match logged invalid when it was played, only because OpenAI refused 11 of its 226
   * decisions (4.9%; the old rule counted refusals as errors). Its refusals are in the older form
   * (status error, REFUSAL_ERROR) and go through the reader, as the committed logs do.
   */
  const refusedOnly = (): MatchLog =>
    parseMatchLog(
      toJsonl(
        fakeLog({
          game: 'fighter',
          players: ['openai', 'jev'],
          winner: 0,
          scores: [2, 1],
          valid: false,
          time: '21:09:39',
          decisions: [
            ...oks(0, 215),
            ...Array.from({ length: 11 }, (_, i) =>
              refusal(0, { sentTick: 300 + i, costUsd: 0.00001 }, true),
            ),
            ...oks(1, 233),
          ],
        }),
      ),
    );

  it('counts a match logged invalid only because of refusals as valid, and says so', () => {
    const log = refusedOnly();
    expect(log.matchEnd?.valid).toBe(false);
    // The reader reads the older refusals as refusals.
    expect(log.decisions.filter((d) => d.status === 'refusal')).toHaveLength(11);
    const s = summarizeGame(FIGHTER, [log], NO_EXCLUSIONS);
    expect(s.matches).toEqual({
      total: 1,
      valid: 1,
      invalid: 0,
      excluded: 0,
      unfinished: 0,
      olderVersion: 0,
    });
    expect(s.invalidMatches).toEqual([]);
    expect(s.rescored).toEqual([{ id: log.header.matchId, loggedValid: false, valid: true }]);
    // Its result counts, and is the featured head-to-head.
    expect(s.pairings[0]).toMatchObject({ players: ['jev', 'openai'], matches: 1, invalid: 0 });
    expect(s.featured?.id).toBe(log.header.matchId);
    expect(s.players.find((p) => p.player === 'openai')).toMatchObject({
      decisions: 226,
      misses: 0,
      missRate: 0,
      refusals: 11,
      refusalRate: 11 / 226,
    });
    expect(s.players.find((p) => p.player === 'jev')).toMatchObject({ refusals: 0, misses: 0 });
  });

  it('classifies the older refusal lines without the reader too', () => {
    const raw = fakeLog({
      game: 'fighter',
      players: ['openai', 'jev'],
      winner: 0,
      scores: [2, 1],
      valid: false,
      decisions: [...oks(0, 40), refusal(0, {}, true), refusal(0, {}, true), ...oks(1, 40)],
    });
    const s = summarizeGame(FIGHTER, [raw], NO_EXCLUSIONS);
    expect(s.matches.valid).toBe(1);
    expect(s.players.find((p) => p.player === 'openai')).toMatchObject({ misses: 0, refusals: 2 });
  });

  it('keeps a match invalid when its transport errors pass 2%, refusals or not', () => {
    const log = fakeLog({
      game: 'fighter',
      players: ['jev', 'openai'],
      winner: 0,
      scores: [2, 0],
      valid: false,
      decisions: [
        ...oks(0, 100),
        ...oks(1, 95),
        failure(1, { error: 'network: fetch failed' }),
        failure(1, { error: 'network: fetch failed' }),
        failure(1, { error: 'network: fetch failed' }),
        refusal(1),
        refusal(1),
      ],
    });
    const s = summarizeGame(FIGHTER, [log], NO_EXCLUSIONS);
    expect(s.matches).toMatchObject({ valid: 0, invalid: 1 });
    expect(s.invalidMatches).toEqual([
      {
        id: log.header.matchId,
        reason:
          'OpenAI Decisions (seat 1) had transport errors on 3.0% of its decisions (limit 2%)',
      },
    ]);
    expect(s.rescored).toEqual([]);
  });

  it('lists a match logged valid that the current rule finds invalid, and leaves it out', () => {
    const log = fakeLog({
      game: 'fighter',
      players: ['jev', 'openai'],
      winner: 0,
      scores: [2, 0],
      decisions: [...oks(0, 10), ...oks(1, 8), failure(1), failure(1)],
    });
    expect(log.matchEnd?.valid).toBe(true);
    const s = summarizeGame(FIGHTER, [log], NO_EXCLUSIONS);
    expect(s.matches).toMatchObject({ valid: 0, invalid: 1 });
    expect(s.rescored).toEqual([{ id: log.header.matchId, loggedValid: true, valid: false }]);
    expect(s.featured).toBeNull();
  });

  it('real-time games: misses are timeouts and transport errors; refusals are counted apart', () => {
    const log = fakeLog({
      game: 'fighter',
      players: ['openai', 'scripted'],
      winner: 0,
      scores: [2, 0],
      decisions: [
        ...oks(0, 96),
        decision(0, { status: 'timeout', error: 'timeout', choice: null, appliedTick: null }),
        failure(0),
        refusal(0),
        refusal(0),
        ...oks(1, 10),
      ],
    });
    const s = summarizeGame(FIGHTER, [log], NO_EXCLUSIONS);
    // 2 misses in 100 decisions: exactly the 2% a match allows.
    expect(s.matches.valid).toBe(1);
    expect(s.players.find((p) => p.player === 'openai')).toMatchObject({
      decisions: 100,
      misses: 2,
      missRate: 0.02,
      refusals: 2,
      refusalRate: 0.02,
    });
  });
});

describe('summarizeGame: matches excluded by hand (results/excluded.json)', () => {
  // Two Jev vs OpenAI matches, both valid by the rule: the closer one is excluded by hand.
  const kept = fakeLog({ players: ['jev', 'openai'], winner: 0, scores: [30, 10] });
  const slept = fakeLog({
    players: ['openai', 'jev'],
    winner: 0,
    scores: [12, 11],
    run: 2,
    runId: 'm-cccccccccccc',
  });
  const broken = fakeLog({
    players: ['jev', 'openai'],
    winner: 1,
    scores: [0, 9],
    run: 3,
    valid: false,
  });
  const reason = 'The Mac slept mid-match (before stall detection)';
  const excluded = new Map([[slept.header.matchId, reason]]);

  it('does not count an excluded valid match, and lists it apart with its reason', () => {
    const plain = summarizeGame(INBOX, [kept, slept, broken], NO_EXCLUSIONS);
    expect(plain.matches).toEqual({
      total: 3,
      valid: 2,
      invalid: 1,
      excluded: 0,
      unfinished: 0,
      olderVersion: 0,
    });
    expect(plain.featured?.id).toBe(slept.header.matchId);

    const s = summarizeGame(INBOX, [kept, slept, broken], excluded);
    // Counted with the invalid matches (and as excluded), never scored.
    expect(s.matches).toEqual({
      total: 3,
      valid: 1,
      invalid: 2,
      excluded: 1,
      unfinished: 0,
      olderVersion: 0,
    });
    expect(s.excluded).toEqual([{ id: slept.header.matchId, reason }]);
    // Listed apart: not among the matches invalid by the rule, nor re-scored.
    expect(s.invalidMatches.map((m) => m.id)).toEqual([broken.header.matchId]);
    expect(s.rescored).toEqual([]);
    // Not in the record, the player numbers, the run ids or the featured choice.
    expect(s.pairings[0]).toMatchObject({ matches: 1, invalid: 2, wins: 1, losses: 0 });
    expect(s.players.find((p) => p.player === 'jev')).toMatchObject({ matches: 1, decisions: 1 });
    expect(s.runIds).toEqual(['sim']);
    expect(s.featured?.id).toBe(kept.header.matchId);
  });

  it('leaves the run-level check out of an excluded turn match', () => {
    // A Clue Clash match whose timeouts would fail the run-level check, excluded by hand.
    const timeouts = cluesMatch([0, 4], 1);
    const fine = cluesMatch([0, 0], 2);
    expect(summarizeGame(CLUES, [timeouts, fine], NO_EXCLUSIONS).runCheck.passed).toBe(false);
    const s = summarizeGame(CLUES, [timeouts, fine], new Map([[timeouts.header.matchId, reason]]));
    expect(s.runCheck.passed).toBe(true);
    expect(s.excluded).toEqual([{ id: timeouts.header.matchId, reason }]);
  });

  it('ignores exclusions of other games’ matches', () => {
    const other = new Map([['20261008-120000-fighter-jev-vs-openai-1', reason]]);
    expect(summarizeGame(INBOX, [kept, slept], other)).toEqual(
      summarizeGame(INBOX, [kept, slept], NO_EXCLUSIONS),
    );
  });
});

describe('summarizeGame: the 2026-10-16 rule (timeouts never count; stalls from the log)', () => {
  const oks = (seat: 0 | 1, n: number) =>
    Array.from({ length: n }, (_, i) => decision(seat, { sentTick: i, choice: 'legit' }));
  const timeouts = (seat: 0 | 1, n: number) =>
    Array.from({ length: n }, (_, i) =>
      decision(seat, {
        sentTick: 100 + i,
        appliedTick: null,
        status: 'timeout',
        error: 'timeout',
        choice: null,
        latencyMs: 1000,
      }),
    );

  it('scores a real-time match logged invalid only because a seat timed out a lot', () => {
    const slow = fakeLog({
      players: ['jev', 'openai'],
      winner: 0,
      scores: [40, 12],
      valid: false,
      decisions: [...oks(0, 200), ...oks(1, 70), ...timeouts(1, 30)],
    });
    const s = summarizeGame(INBOX, [slow], NO_EXCLUSIONS);
    expect(s.matches).toMatchObject({ valid: 1, invalid: 0 });
    expect(s.rescored).toEqual([{ id: slow.header.matchId, loggedValid: false, valid: true }]);
    // Its result counts: the slower model's loss is no longer dropped.
    expect(s.pairings[0]).toMatchObject({ players: ['jev', 'openai'], matches: 1, wins: 1 });
    expect(s.players.find((p) => p.player === 'openai')).toMatchObject({
      decisions: 100,
      misses: 30,
    });
    expect(summaryMarkdown(s)).toContain(
      'timeouts no longer count toward validity since 2026-10-16',
    );
  });

  it('marks a log the machine slept through invalid: a line past the timeout is a stall', () => {
    const slept = fakeLog({
      players: ['openai', 'jev'],
      winner: 1,
      scores: [3, 9],
      decisions: [
        ...oks(0, 50),
        ...oks(1, 50),
        decision(0, {
          status: 'dropped',
          error: 'matchOver',
          latencyMs: 923_561.4,
          sentTick: 8748,
        }),
        decision(1, { status: 'dropped', error: 'matchOver', latencyMs: 923_562, sentTick: 8748 }),
      ],
    });
    const s = summarizeGame(INBOX, [slept], NO_EXCLUSIONS);
    expect(s.matches).toMatchObject({ valid: 0, invalid: 1 });
    expect(s.invalidMatches).toEqual([
      { id: slept.header.matchId, reason: 'stall (from the log)' },
    ]);
    expect(s.rescored).toEqual([{ id: slept.header.matchId, loggedValid: true, valid: false }]);
    const md = summaryMarkdown(s);
    expect(md).toContain(`- \`${slept.header.matchId}\`: stall (from the log)`);
    expect(md).toContain('Re-scored invalid under the current validity rule');
  });

  it('a measured stall reads "stall"', () => {
    const log = fakeLog({ players: ['jev', 'openai'], winner: 0, scores: [2, 1], valid: false });
    log.decisions = [...oks(0, 5), ...oks(1, 5)];
    if (log.matchEnd) log.matchEnd.stalls = [{ atTick: 30, gapMs: 5000 }];
    const s = summarizeGame(INBOX, [log], NO_EXCLUSIONS);
    expect(s.invalidMatches).toEqual([{ id: log.header.matchId, reason: 'stall' }]);
  });
});

describe('summarizeGame: only the current game version is scored', () => {
  const v2: typeof INBOX = { ...INBOX, version: 2 };
  const current = fakeLog({
    players: ['jev', 'openai'],
    winner: 0,
    scores: [30, 10],
    gameVersion: 2,
    warmupCostUsd: [0.001, 0.001],
  });
  const old = fakeLog({
    players: ['openai', 'jev'],
    winner: 0,
    scores: [11, 10],
    run: 2,
    gameVersion: 1,
    warmupCostUsd: [0.002, 0.002],
  });

  it('lists an older version’s matches as not scored, and counts nothing else from them', () => {
    const s = summarizeGame(v2, [current, old], NO_EXCLUSIONS);
    expect(s.gameVersion).toBe(2);
    expect(s.matches).toEqual({
      total: 2,
      valid: 1,
      invalid: 0,
      excluded: 0,
      unfinished: 0,
      olderVersion: 1,
    });
    expect(s.olderVersion).toEqual([{ id: old.header.matchId, gameVersion: 1 }]);
    expect(s.invalidMatches).toEqual([]);
    expect(s.rescored).toEqual([]);
    // Not in the record, the players or the featured choice (the closer match is the old one).
    expect(s.pairings).toHaveLength(1);
    expect(s.pairings[0]).toMatchObject({ matches: 1, invalid: 0, wins: 1 });
    expect(s.players.find((p) => p.player === 'jev')?.matches).toBe(1);
    expect(s.featured?.id).toBe(current.header.matchId);
    // Its spend is still spend.
    expect(s.totalCostUsd).toBeCloseTo(0.006);
    const md = summaryMarkdown(s);
    expect(md).toContain('1 of an older version (not scored).');
    expect(md).toContain(
      `Older version, not scored (this summary scores version 2):\n\n- \`${old.header.matchId}\` (version 1)`,
    );
  });

  it('refuses a log of a newer version than the code', () => {
    expect(() => summarizeGame(INBOX, [current], NO_EXCLUSIONS)).toThrow(
      `${current.header.matchId}: game version 2 is newer than inbox's current version 1`,
    );
  });
});
