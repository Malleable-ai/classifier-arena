import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PlayedMatch } from '../../src/cli/play.js';
import { isHostnameRunId, machineRunId } from '../../src/cli/run-id.js';
import {
  MAX_RERUNS,
  runTournamentCli,
  type TournamentDeps,
  type TournamentMatchSpec,
} from '../../src/cli/tournament.js';
import { PROVIDERS } from '../../src/core/classifier/providers.js';
import type { Seat } from '../../src/core/classifier/types.js';
import { parseMatchLog } from '../../src/core/log/read.js';
import type { ResultsIndex } from '../../src/core/replay/results-index.js';
import {
  INDEX_FILE,
  LEADERBOARD_FILES,
  matchFile,
  matchIdFor,
  summaryFiles,
} from '../../src/core/results/paths.js';
import { counterRealtime } from '../core/games/counter-realtime.js';
import { counterTurns } from '../core/games/counter-turns.js';
import { decision, failure, fakeLog, toJsonl } from '../core/stats/helpers.js';

/**
 * `pnpm tournament` against a temp results tree. Real matches are baselines on a SimClock
 * (`--sim`); everything about paid runs (guards, confirmation, reruns, ordering) runs through an
 * injected `play` that never calls an API (fetch is blocked in tests anyway).
 */

let root = '';
let out: string[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'arena-tournament-'));
  out = [];
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const GAMES = [counterRealtime, counterTurns];
/** counter_turns priced so that one paid match is over $5 worst case. */
const EXPENSIVE = {
  ...counterTurns,
  estimate: {
    decisionsPerSeat: { typical: 1_000, worst: 1_000_000 },
    inputTokens: {},
    fallbackInputTokens: 1_000,
  },
};

const deps = (extra: Partial<TournamentDeps> = {}): TournamentDeps => ({
  root,
  env: {},
  games: GAMES,
  providers: PROVIDERS,
  now: () => new Date(2026, 9, 8, 12, 0, 0),
  gitCommit: () => 'abc123',
  print: (line) => out.push(line),
  confirm: () => Promise.reject(new Error('confirm should not be asked')),
  ...extra,
});

const PAID = ['--game', 'counter_turns', '--a', 'jev', '--b', 'openai'];
const LOCATED = { RUN_LOCATION: 'test-bench' };
const RUN_ID_LINE = isHostnameRunId(machineRunId())
  ? `  Run id: ${machineRunId()} (from the host name: no machine id was readable, so it can change)`
  : `  Run id: ${machineRunId()} (this machine; the same in every log it writes)`;

/**
 * A fake match: writes nothing unless `writeLog`, finishes after a few real macrotasks, and is
 * valid unless `invalid(spec)` says otherwise. Records every spec and any overlap.
 */
function fakePlay(
  opts: {
    invalid?: (spec: TournamentMatchSpec) => boolean;
    /** The machine paused during this match: a recorded stall makes it invalid. */
    stalled?: (spec: TournamentMatchSpec) => boolean;
    writeLog?: boolean;
  } = {},
) {
  const specs: TournamentMatchSpec[] = [];
  let active = 0;
  let maxActive = 0;
  let firstCallAt = -1;
  const play = async (spec: TournamentMatchSpec): Promise<PlayedMatch> => {
    if (firstCallAt === -1) firstCallAt = out.length;
    active++;
    maxActive = Math.max(maxActive, active);
    specs.push(spec);
    await new Promise((r) => setTimeout(r, 2));
    await new Promise((r) => setTimeout(r, 2));
    active--;
    const valid = !(opts.invalid?.(spec) ?? false);
    const winner: Seat = spec.seed % 2 === 0 ? 0 : 1;
    const log = fakeLog({
      game: 'counter_turns',
      players: [spec.a, spec.b],
      winner,
      scores: winner === 0 ? [3, 1] : [1, 3],
      valid,
      run: specs.length,
      // An invalid fake carries the transport failure that makes it invalid: the index
      // recomputes validity from the decisions. A valid one has a decision per seat.
      decisions: valid ? [decision(0), decision(1)] : [failure(0)],
      warmupCostUsd: [0.001, 0.002],
    });
    const matchId = matchIdFor({
      game: 'counter_turns',
      a: spec.a,
      b: spec.b,
      when: '2026-10-08T12:00:00',
      run: specs.length,
    });
    log.header.matchId = matchId;
    log.header.seed = spec.seed;
    const path = matchFile('counter_turns', matchId);
    if (opts.writeLog) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), toJsonl(log));
    }
    if (log.matchEnd === null) throw new Error('unfinished');
    if (opts.stalled?.(spec) === true) {
      log.matchEnd.valid = false;
      log.matchEnd.stalls = [{ atTick: 1560, gapMs: 26_400 }];
    }
    return { matchId, path, seed: spec.seed, end: log.matchEnd };
  };
  return {
    play,
    specs,
    maxActive: () => maxActive,
    firstCallAt: () => firstCallAt,
  };
}

describe('pnpm tournament: baselines on a SimClock', () => {
  it('swaps seats every match, with seeds seed-base, seed-base + 1, …', async () => {
    const result = await runTournamentCli(
      [
        '--game',
        'counter_realtime',
        '--a',
        'random',
        '--b',
        'parity',
        '--matches',
        '4',
        '--seed-base',
        '10',
        '--sim',
      ],
      deps(),
    );
    expect(result?.played.map((m) => [m.matchId, m.seed])).toEqual([
      ['20261008-120000-counter_realtime-random-vs-parity-1', 10],
      ['20261008-120000-counter_realtime-parity-vs-random-1', 11],
      ['20261008-120000-counter_realtime-random-vs-parity-2', 12],
      ['20261008-120000-counter_realtime-parity-vs-random-2', 13],
    ]);
    for (const m of result?.played ?? []) {
      const log = parseMatchLog(readFileSync(join(root, m.path), 'utf8'));
      expect(log.header.runLocation).toBe('sim');
      expect(log.header.runId).toBe('sim');
      expect(log.header.seed).toBe(m.seed);
    }
    expect(result).toMatchObject({ valid: 4, invalid: 0, reruns: 0, costUsd: 0 });
  });

  it('prints the $0 estimate first, a line per match, then rebuilds the summary and leaderboard', async () => {
    await runTournamentCli(
      ['--game', 'counter_turns', '--a', 'random', '--b', 'random', '--matches', '2', '--sim'],
      deps({ randomSeed: () => 500 }),
    );
    expect(out[0]).toBe('Cost estimate: $0 (baselines only)');
    expect(out[1]).toBe('  Run id: sim (simulated clock)');
    expect(out.join('\n')).toContain('Seeds 500–501');
    const progress = out.filter((l) => /^\[\d+\/2\]/.test(l));
    expect(progress).toHaveLength(2);
    expect(progress[0]).toMatch(
      /^\[1\/2\] 20261008-120000-counter_turns-random-vs-random-1: (random wins|draw) \d+–\d+, valid, \$0\.0000 \(run total \$0\.0000\)$/,
    );
    expect(existsSync(join(root, summaryFiles('counter_turns').json))).toBe(true);
    expect(existsSync(join(root, LEADERBOARD_FILES.json))).toBe(true);
    const index = JSON.parse(readFileSync(join(root, INDEX_FILE), 'utf8')) as ResultsIndex;
    expect(index.matches).toHaveLength(2);
    // The game's summary table, then the run's spend from the logs.
    expect(out.join('\n')).toContain('| Pairing | Valid matches |');
    expect(out.at(-1)).toBe(
      'This run: 2 matches (2 valid, 0 invalid, 0 reruns), cost $0.0000 from the logs.',
    );
  });

  it('writes the run id it printed into every log header, beside RUN_LOCATION', async () => {
    const result = await runTournamentCli(
      ['--game', 'counter_turns', '--a', 'random', '--b', 'random', '--matches', '2', '--sim'],
      deps({ env: LOCATED, runId: () => 'm-0123456789ab' }),
    );
    expect(out[1]).toBe('  Run id: m-0123456789ab (this machine; the same in every log it writes)');
    for (const m of result?.played ?? []) {
      const log = parseMatchLog(readFileSync(join(root, m.path), 'utf8'));
      expect(log.header).toMatchObject({ runId: 'm-0123456789ab', runLocation: 'test-bench' });
    }
    expect(result?.played).toHaveLength(2);
  });

  it('says when the run id fell back to the host name (h-), which can change', async () => {
    await runTournamentCli(
      ['--game', 'counter_turns', '--a', 'random', '--b', 'random', '--matches', '1', '--sim'],
      deps({ env: LOCATED, runId: () => 'h-0123456789ab' }),
    );
    expect(out[1]).toBe(
      '  Run id: h-0123456789ab (from the host name: no machine id was readable, so it can change)',
    );
  });

  it('needs no RUN_LOCATION and no confirmation for a baselines-only run', async () => {
    const result = await runTournamentCli(
      ['--game', 'counter_turns', '--a', 'random', '--b', 'random', '--matches', '1'],
      deps({ env: {} }),
    );
    expect(result?.played).toHaveLength(1);
    // Off the SimClock, the log carries this machine's run id; the location label is optional.
    const m = result?.played[0];
    const log = parseMatchLog(readFileSync(join(root, m?.path ?? 'missing'), 'utf8'));
    expect(log.header).toMatchObject({ runId: machineRunId(), runLocation: 'unspecified' });
    expect(out[1]).toBe(RUN_ID_LINE);
  });
});

describe('pnpm tournament: order and reruns (fake matches)', () => {
  it('runs strictly one match at a time', async () => {
    const fake = fakePlay();
    await runTournamentCli(
      [...PAID, '--matches', '6', '--yes'],
      deps({ env: LOCATED, play: fake.play }),
    );
    expect(fake.specs).toHaveLength(6);
    expect(fake.maxActive()).toBe(1);
  });

  it('prints the estimate (n matches + 10 reruns, worst case) before anything runs', async () => {
    const fake = fakePlay();
    await runTournamentCli(
      [...PAID, '--matches', '5', '--yes'],
      deps({ env: LOCATED, play: fake.play }),
    );
    expect(out[0]).toMatch(/^Cost estimate \(worst case, 15 match\(es\)\):/);
    expect(out.join('\n')).toContain('5 matches plus up to 10 reruns');
    expect(fake.firstCallAt()).toBeGreaterThan(0);
  });

  it('warns when the machine paused mid-match, and reruns the stalled match', async () => {
    const fake = fakePlay({ stalled: (s) => s.slot === 0 && !s.rerun });
    const result = await runTournamentCli(
      [...PAID, '--matches', '2', '--seed-base', '100', '--yes'],
      deps({ env: LOCATED, play: fake.play }),
    );
    const warning =
      '  Warning: the machine paused mid-match (longest 26.4 s), likely sleep; keep it awake ' +
      'and on power. The match is invalid.';
    expect(out.filter((l) => l === warning)).toHaveLength(1);
    // The warning follows that match's own line.
    const at = out.indexOf(warning);
    expect(out[at - 1]).toMatch(/^\[1\/2\] .*INVALID/);
    expect(result).toMatchObject({ valid: 2, invalid: 1, reruns: 1, stillInvalid: 0 });
    expect(fake.specs.at(-1)).toMatchObject({ slot: 0, rerun: true });
  });

  it('reruns an invalid match with a new seed in the same seats, then moves on', async () => {
    // The first attempt at slot 1 is invalid; its rerun is valid.
    const fake = fakePlay({ invalid: (s) => s.slot === 1 && !s.rerun, writeLog: true });
    const result = await runTournamentCli(
      [...PAID, '--matches', '3', '--seed-base', '100', '--yes'],
      deps({ env: LOCATED, play: fake.play }),
    );
    expect(fake.specs.map((s) => [s.slot, s.a, s.b, s.seed, s.rerun])).toEqual([
      [0, 'jev', 'openai', 100, false],
      [1, 'openai', 'jev', 101, false],
      [2, 'jev', 'openai', 102, false],
      // Reruns come after the scheduled matches, seeds after theirs.
      [1, 'openai', 'jev', 103, true],
    ]);
    expect(result).toMatchObject({ valid: 3, invalid: 1, reruns: 1, stillInvalid: 0 });
    // The invalid log stays, marked invalid in the index.
    const index = JSON.parse(readFileSync(join(root, INDEX_FILE), 'utf8')) as ResultsIndex;
    expect(index.matches.map((m) => m.valid).sort()).toEqual([false, true, true, true]);
    const invalid = result?.played[1];
    expect(invalid?.end.valid).toBe(false);
    expect(existsSync(join(root, invalid?.path ?? 'missing'))).toBe(true);
    expect(out.some((l) => l.startsWith('[rerun 1/10]'))).toBe(true);
  });

  it(`stops after ${String(MAX_RERUNS)} reruns in total`, async () => {
    const fake = fakePlay({ invalid: () => true });
    const result = await runTournamentCli(
      [...PAID, '--matches', '3', '--seed-base', '0', '--yes'],
      deps({ env: LOCATED, play: fake.play }),
    );
    expect(MAX_RERUNS).toBe(10);
    expect(fake.specs).toHaveLength(3 + 10);
    expect(new Set(fake.specs.map((s) => s.seed)).size).toBe(13);
    expect(fake.specs.filter((s) => s.rerun)).toHaveLength(10);
    // Seats stay balanced: every rerun keeps its slot's seating.
    for (const s of fake.specs) expect(s.a).toBe(s.slot % 2 === 0 ? 'jev' : 'openai');
    expect(result).toMatchObject({ valid: 0, invalid: 13, reruns: 10, stillInvalid: 3 });
    expect(out.join('\n')).toMatch(/3 scheduled matches are still invalid/);
  });

  it('reports the run’s cost from the logs', async () => {
    const fake = fakePlay();
    const result = await runTournamentCli(
      [...PAID, '--matches', '2', '--yes'],
      deps({ env: LOCATED, play: fake.play }),
    );
    // Each fake match spends its two warm-ups: $0.003.
    expect(result?.costUsd).toBeCloseTo(0.006, 12);
    expect(out.at(-1)).toMatch(/cost \$0\.0060 from the logs\.$/);
  });
});

describe('pnpm tournament: guards for paid runs', () => {
  it('runs a provider run without RUN_LOCATION, printing the run id in the estimate block', async () => {
    for (const env of [{}, { RUN_LOCATION: '' }, { RUN_LOCATION: '   ' }]) {
      out = [];
      const fake = fakePlay();
      const result = await runTournamentCli(
        [...PAID, '--matches', '2', '--yes'],
        deps({ env, play: fake.play }),
      );
      expect(out[0]).toMatch(/^Cost estimate/);
      const estimateEnd = out.findIndex((l) => l.includes('matches plus up to 10 reruns'));
      expect(out[estimateEnd + 1]).toBe(RUN_ID_LINE);
      expect(out.join('\n')).toContain('run location unspecified.');
      expect(fake.specs).toHaveLength(2);
      expect(result?.played).toHaveLength(2);
    }
  });

  it('refuses --sim with a provider', async () => {
    await expect(
      runTournamentCli([...PAID, '--matches', '1', '--sim', '--yes'], deps({ env: LOCATED })),
    ).rejects.toThrow(/--sim is for baselines only/);
  });

  it('refuses a worst case over $5 without --approve-over-5, saying exactly what to approve', async () => {
    const fake = fakePlay();
    const run = runTournamentCli(
      [...PAID, '--matches', '2', '--seed-base', '7', '--yes'],
      deps({ env: LOCATED, play: fake.play, games: [EXPENSIVE] }),
    );
    await expect(run).rejects.toThrow(/over the \$5 approval limit/);
    const msg = await run.catch((e: unknown) => (e instanceof Error ? e.message : ''));
    expect(msg).toContain('The maintainer must approve: 2 counter_turns matches, jev vs openai');
    expect(msg).toContain(
      'pnpm tournament --game counter_turns --a jev --b openai --matches 2 --seed-base 7 --approve-over-5',
    );
    expect(fake.specs).toHaveLength(0);
  });

  it('runs a worst case over $5 once --approve-over-5 is given', async () => {
    const fake = fakePlay();
    await runTournamentCli(
      [...PAID, '--matches', '2', '--approve-over-5', '--yes'],
      deps({ env: LOCATED, play: fake.play, games: [EXPENSIVE] }),
    );
    expect(fake.specs).toHaveLength(2);
  });

  it('asks before a paid run unless --yes, and stops on no', async () => {
    const asked: string[] = [];
    const fake = fakePlay();
    await expect(
      runTournamentCli(
        [...PAID, '--matches', '2'],
        deps({
          env: LOCATED,
          play: fake.play,
          confirm: (q) => {
            asked.push(q);
            return Promise.resolve(false);
          },
        }),
      ),
    ).rejects.toThrow(/Not confirmed; nothing was run/);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(
      /^Run 2 counter_turns matches, jev vs openai \(seats swap every match; up to 10 reruns\), worst case \$\d+\.\d{4}\? \[y\/N\] $/,
    );
    expect(fake.specs).toHaveLength(0);

    await runTournamentCli(
      [...PAID, '--matches', '2'],
      deps({ env: LOCATED, play: fake.play, confirm: () => Promise.resolve(true) }),
    );
    expect(fake.specs).toHaveLength(2);
  });

  it.each([
    [[], /--game is required/],
    [['--game', 'chess'], /unknown game "chess"/],
    [['--game', 'counter_turns', '--a', 'random', '--b', 'random'], /--matches is required/],
    [['--game', 'counter_turns', '--a', 'random', '--b', 'random', '--matches', '0'], /at least 1/],
    [
      ['--game', 'counter_turns', '--a', 'nobody', '--b', 'random', '--matches', '1'],
      /unknown player "nobody"/,
    ],
    [
      [
        '--game',
        'counter_turns',
        '--a',
        'random',
        '--b',
        'random',
        '--matches',
        '1',
        '--seed-base',
        'x',
      ],
      /--seed-base must be/,
    ],
  ])('refuses %j', async (argv, why) => {
    await expect(runTournamentCli(argv, deps())).rejects.toThrow(why);
  });
});
