import { describe, expect, it } from 'vitest';
import { BASELINE_DELAY_MS } from '../../../src/core/classifier/random.js';
import type { Seat } from '../../../src/core/classifier/types.js';
import type { MatchEndLine } from '../../../src/core/log/schema.js';
import { createPrng, nextBelow } from '../../../src/core/util/prng.js';
import { MOVE_IDS } from '../../../src/games/fighter/engine/types.js';
import { buildQuestion } from '../../../src/games/fighter/question.js';
import {
  CRITERIA,
  RANDOM,
  SCRIPTED,
  TuneChunksError,
  checkReport,
  chunkName,
  createSpamDecider,
  formatFighterTuneReport,
  mergeRows,
  plannedRows,
  playPairing,
  playerName,
  seatOfA,
  seatWinRate,
  spam,
  tuneFighter,
  winRateA,
  type FighterPlayer,
  type FighterTuneReport,
  type MatchRunner,
  type PairingRow,
} from '../../../src/games/fighter/tune.js';
import { createFakeClock } from '../../core/util/fake-clock.js';
import { rotatedOrder } from './sample-view.js';

const signal = new AbortController().signal;

describe('spam decider', () => {
  it('plays its move when a fair coin says so, else a uniform pick over the question as ordered', async () => {
    const question = buildQuestion(rotatedOrder());
    const d = createSpamDecider({ move: 'sweep', prng: createPrng(9), clock: createFakeClock() });
    // A twin of its PRNG: per answer, one coin (0 = the move) and one uniform index, always both.
    const twin = createPrng(9);
    for (let i = 0; i < 500; i++) {
      const coin = nextBelow(twin, 2);
      const pick = question.options[nextBelow(twin, question.options.length)]?.id;
      const r = await d.decide({}, question, signal);
      expect(r.choice).toBe(coin === 0 ? 'sweep' : pick);
    }
  });

  it('picks its move about 1/2 + 1/22 of the time and every other move about 1/22', async () => {
    const clock = createFakeClock();
    const d = createSpamDecider({ move: 'jab', prng: createPrng(1), clock });
    expect(d.player).toBe('spam_jab');
    const question = buildQuestion(MOVE_IDS);
    const n = 11_000;
    const counts = new Map<string, number>();
    for (let i = 0; i < n; i++) {
      const r = await d.decide({}, question, signal);
      expect(r).toMatchObject({ status: 'ok', latencyMs: BASELINE_DELAY_MS, costUsd: 0 });
      if (r.choice !== null) counts.set(r.choice, (counts.get(r.choice) ?? 0) + 1);
    }
    expect(clock.sleeps).toHaveLength(n);
    expect(clock.sleeps.every((ms) => ms === BASELINE_DELAY_MS)).toBe(true);
    // Expected: jab 6,000 (sd ≈ 52), each other move 500 (sd ≈ 22); bounds are about 4 sd.
    expect(counts.get('jab')).toBeGreaterThan(5_800);
    expect(counts.get('jab')).toBeLessThan(6_200);
    for (const m of MOVE_IDS.filter((x) => x !== 'jab')) {
      expect(counts.get(m), m).toBeGreaterThan(410);
      expect(counts.get(m), m).toBeLessThan(590);
    }
  });

  it('times out when its request is aborted during the delay', async () => {
    const abort = new AbortController();
    abort.abort();
    const d = createSpamDecider({ move: 'jab', prng: createPrng(1), clock: createFakeClock() });
    expect((await d.decide({}, buildQuestion(MOVE_IDS), abort.signal)).status).toBe('timeout');
  });

  it('is a pure function of its seed', async () => {
    const run = async () => {
      const d = createSpamDecider({ move: 'jab', prng: createPrng(42), clock: createFakeClock() });
      const out: (string | null)[] = [];
      for (let i = 0; i < 50; i++)
        out.push((await d.decide({}, buildQuestion(MOVE_IDS), signal)).choice);
      return out;
    };
    expect(await run()).toEqual(await run());
  });
});

/** A match_end with only the fields `playPairing` reads. */
const end = (winner: Seat | 'draw', totalTicks = 600): MatchEndLine => ({
  type: 'match_end',
  winner,
  scores: [0, 0],
  totalTicks,
  finalStateHash: '0000000000000000',
  valid: true,
  missRates: [0, 0],
  decisions: [0, 0],
  costUsd: 0,
});

/** A stub match runner that records each match and lets `decide` pick the winner. */
function recorder(decide: (players: readonly [FighterPlayer, FighterPlayer]) => Seat | 'draw') {
  const calls: { seed: number; seats: [string, string] }[] = [];
  const run: MatchRunner = (seed, players) => {
    calls.push({ seed, seats: [playerName(players[0]), playerName(players[1])] });
    return Promise.resolve(end(decide(players)));
  };
  return { calls, run };
}

describe('side swapping', () => {
  it('puts A in seat 0 on even match indexes and seat 1 on odd ones, one seed per match', async () => {
    expect([0, 1, 2, 3].map(seatOfA)).toEqual([0, 1, 0, 1]);
    const { calls, run } = recorder(() => 0);
    await playPairing(spam('jab'), RANDOM, 4, 10, 0, run);
    expect(calls).toEqual([
      { seed: 10, seats: ['spam_jab', 'random'] },
      { seed: 11, seats: ['random', 'spam_jab'] },
      { seed: 12, seats: ['spam_jab', 'random'] },
      { seed: 13, seats: ['random', 'spam_jab'] },
    ]);
  });

  it('a chunk at an odd offset starts with A in seat 1, so chunks keep the alternation', async () => {
    const { calls, run } = recorder(() => 0);
    await playPairing(SCRIPTED, spam('throw'), 2, 1, 5, run);
    expect(calls).toEqual([
      { seed: 6, seats: ['spam_throw', 'scripted'] },
      { seed: 7, seats: ['scripted', 'spam_throw'] },
    ]);
  });

  it('a seat advantage cancels: seat 0 always winning gives A half the matches', async () => {
    const { run } = recorder(() => 0);
    const r = await playPairing(spam('jab'), RANDOM, 10, 1, 0, run);
    expect(r).toMatchObject({ matches: 10, winsA: 5, draws: 0, winsB: 5, seatWins: [10, 0] });
    expect(winRateA(r)).toBe(0.5);
  });

  it('credits wins to the player, wherever it sat, and counts draws', async () => {
    const aWins = recorder((players) => (players[0].kind === 'spam' ? 0 : 1));
    const r = await playPairing(spam('sweep'), RANDOM, 6, 1, 0, aWins.run);
    expect(r).toMatchObject({ winsA: 6, draws: 0, winsB: 0, seatWins: [3, 3] });
    const draws = recorder(() => 'draw');
    const d = await playPairing(spam('sweep'), RANDOM, 4, 1, 0, draws.run);
    expect(d).toMatchObject({ winsA: 0, draws: 4, winsB: 0, seatWins: [0, 0], totalTicks: 2_400 });
    expect(d.meanS).toBe(10);
  });
});

describe('tuning harness', () => {
  it('plans 11 spam-vs-random rows, 11 scripted-vs-spam rows and random vs random', () => {
    const rows = plannedRows();
    expect(rows).toHaveLength(23);
    expect(rows.filter((r) => r.section === 'spamVsRandom').map((r) => playerName(r.a))).toEqual(
      MOVE_IDS.map((m) => `spam_${m}`),
    );
    expect(rows.filter((r) => r.section === 'spamVsRandom').every((r) => r.b === RANDOM)).toBe(
      true,
    );
    expect(rows.filter((r) => r.section === 'scriptedVsSpam').map((r) => playerName(r.b))).toEqual(
      MOVE_IDS.map((m) => `spam_${m}`),
    );
    expect(rows.filter((r) => r.section === 'scriptedVsSpam').every((r) => r.a === SCRIPTED)).toBe(
      true,
    );
    expect(rows.at(-1)).toEqual({ section: 'randomVsRandom', a: RANDOM, b: RANDOM });
  });

  it('a failed chunk does not stop the others: every chunk plays, then each failure is listed', async () => {
    const played: string[] = [];
    const play = async (c: Parameters<typeof chunkName>[0]): Promise<PairingRow> => {
      played.push(chunkName(c));
      await Promise.resolve();
      if (c.row.section === 'scriptedVsSpam' && c.offset === 1) throw new Error('worker died');
      return playPairing(c.row.a, c.row.b, c.n, c.firstSeed, c.offset);
    };
    const run = tuneFighter(2, { moves: ['jab'], firstSeed: 7, chunkMatches: 1, play });
    await expect(run).rejects.toBeInstanceOf(TuneChunksError);
    await expect(run).rejects.toThrow(
      '1 of 6 chunks failed (the others finished):\n  scripted vs spam_jab, seeds 8–8: worker died',
    );
    // All six chunks (three rows × two matches) were played, not just those before the failure.
    expect(played).toHaveLength(6);
    const [first] = plannedRows(['jab']);
    if (!first) throw new Error('no rows');
    expect(chunkName({ row: first, n: 50, firstSeed: 1, offset: 50 })).toBe(
      'spam_jab vs random, seeds 51–100',
    );
  });

  it('a small run is deterministic for a fixed seed, and chunks merge into the whole row', async () => {
    const a = await tuneFighter(2, { moves: ['jab'], firstSeed: 7, chunkMatches: 1 });
    const b = await tuneFighter(2, { moves: ['jab'], firstSeed: 7 });
    expect(a).toEqual(b);
    expect(a.spamVsRandom).toHaveLength(1);
    expect(a.scriptedVsSpam).toHaveLength(1);
    for (const row of [...a.spamVsRandom, ...a.scriptedVsSpam, a.randomVsRandom]) {
      expect(row.matches).toBe(2);
      expect(row.winsA + row.draws + row.winsB).toBe(2);
      expect(row.seatWins[0] + row.seatWins[1] + row.draws).toBe(2);
      expect(row.meanS).toBeGreaterThan(0);
    }
    const whole = await playPairing(spam('jab'), RANDOM, 2, 7);
    expect(whole).toEqual(a.spamVsRandom[0]);
  });
});

const row = (over: Partial<PairingRow>): PairingRow => ({
  a: 'a',
  b: 'b',
  matches: 10,
  winsA: 5,
  draws: 0,
  winsB: 5,
  seatWins: [5, 5],
  totalTicks: 18_000,
  meanS: 30,
  ...over,
});

describe('rates, criteria and the report', () => {
  it('count a draw as half a win', () => {
    const r = row({ winsA: 4, draws: 2, winsB: 4, seatWins: [5, 3] });
    expect(winRateA(r)).toBe(0.5);
    expect(seatWinRate(r, 0)).toBe(0.6);
    expect(seatWinRate(r, 1)).toBe(0.4);
  });

  it('merge chunks by summing counts and ticks, then the mean length from the ticks', () => {
    const m = mergeRows([
      row({ matches: 2, winsA: 2, winsB: 0, seatWins: [1, 1], totalTicks: 1_200, meanS: 10 }),
      row({ matches: 6, winsA: 1, draws: 1, winsB: 4, seatWins: [3, 2], totalTicks: 10_800 }),
    ]);
    expect(m).toMatchObject({
      matches: 8,
      winsA: 3,
      draws: 1,
      winsB: 4,
      seatWins: [4, 3],
      totalTicks: 12_000,
    });
    expect(m.meanS).toBe(25);
    expect(() => mergeRows([row({}), row({ b: 'c' })])).toThrow(/two pairings/);
  });

  /** A spam bot's wins against random, scripted's wins against it, and seat 0's random wins. */
  const report = (
    spamWins: number,
    scriptedWins: number,
    seat0: number,
    draws = 0,
  ): FighterTuneReport => ({
    matches: 100,
    firstSeed: 1,
    engineVersion: 1,
    spamVsRandom: [
      row({
        a: 'spam_jab',
        b: 'random',
        matches: 100,
        winsA: spamWins,
        draws,
        winsB: 100 - spamWins - draws,
      }),
      row({ a: 'spam_sweep', b: 'random', matches: 100, winsA: 50, winsB: 50 }),
    ],
    scriptedVsSpam: [
      row({
        a: 'scripted',
        b: 'spam_jab',
        matches: 100,
        winsA: scriptedWins,
        draws,
        winsB: 100 - scriptedWins - draws,
      }),
      row({ a: 'scripted', b: 'spam_sweep', matches: 100, winsA: 80, winsB: 20 }),
    ],
    randomVsRandom: row({ a: 'random', b: 'random', matches: 100, seatWins: [seat0, 100 - seat0] }),
  });

  it('pass exactly at the thresholds and fail just past them', () => {
    expect(CRITERIA).toEqual({
      spamVsRandomMax: 0.65,
      scriptedVsSpamMin: 0.55,
      randomSeatMin: 0.45,
      randomSeatMax: 0.55,
    });
    expect(checkReport(report(65, 55, 45))).toEqual({
      spamVsRandom: true,
      scriptedVsSpam: true,
      randomVsRandom: true,
      pass: true,
    });
    expect(checkReport(report(65, 55, 55)).pass).toBe(true);
    expect(checkReport(report(66, 55, 50))).toMatchObject({ spamVsRandom: false, pass: false });
    expect(checkReport(report(50, 54, 50))).toMatchObject({ scriptedVsSpam: false, pass: false });
    expect(checkReport(report(50, 60, 56))).toMatchObject({ randomVsRandom: false, pass: false });
    expect(checkReport(report(50, 60, 44))).toMatchObject({ randomVsRandom: false, pass: false });
  });

  it('one failing row fails its criterion', () => {
    const r = report(50, 60, 50);
    expect(checkReport(r).pass).toBe(true);
    const spamRow = r.spamVsRandom[1];
    const scriptedRow = r.scriptedVsSpam[1];
    if (!spamRow || !scriptedRow) throw new Error('report has two rows per section');
    expect(
      checkReport({
        ...r,
        spamVsRandom: [r.spamVsRandom[0] ?? spamRow, { ...spamRow, winsA: 70, winsB: 30 }],
      }),
    ).toMatchObject({ spamVsRandom: false, scriptedVsSpam: true, pass: false });
    expect(
      checkReport({
        ...r,
        scriptedVsSpam: [
          r.scriptedVsSpam[0] ?? scriptedRow,
          { ...scriptedRow, winsA: 40, winsB: 60 },
        ],
      }),
    ).toMatchObject({ spamVsRandom: true, scriptedVsSpam: false, pass: false });
  });

  it('judge with draws as half a win', () => {
    // 60 wins + 10 draws = 65%: passes; 61 + 10 = 66%: fails.
    expect(checkReport(report(60, 60, 50, 10)).spamVsRandom).toBe(true);
    expect(checkReport(report(61, 60, 50, 10)).spamVsRandom).toBe(false);
    // 50 wins + 10 draws = 55%: passes; 49 + 10 = 54%: fails.
    expect(checkReport(report(50, 50, 50, 10)).scriptedVsSpam).toBe(true);
    expect(checkReport(report(50, 49, 50, 10)).scriptedVsSpam).toBe(false);
  });

  it('format every section with its verdict', () => {
    const text = formatFighterTuneReport(report(70, 60, 50));
    expect(text).toContain('100 matches per row');
    expect(text).toMatch(/spam_jab\s+70\.0%.*FAIL/);
    expect(text).toMatch(/spam_sweep\s+50\.0%.*ok/);
    expect(text).toMatch(/vs spam_jab\s+60\.0%.*ok/);
    expect(text).toContain('seat 0 50.0%');
    expect(text).toContain('FAIL: see the rows marked FAIL.');
    expect(formatFighterTuneReport(report(60, 60, 50))).toContain('PASS');
  });
});
