import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CliError, runMatchCli, type MatchCliDeps } from '../../src/cli/match.js';
import { PROVIDERS } from '../../src/core/classifier/providers.js';
import { parseMatchLog } from '../../src/core/log/read.js';
import { replayLog } from '../../src/core/replay/replay.js';
import { OPTION_ORDER_RULE } from '../../src/core/classifier/order.js';
import { fighterGame } from '../../src/games/fighter/game.js';
import { counterTurns } from '../core/games/counter-turns.js';

/**
 * `pnpm match` against a temp results tree. Only baselines play; paid pairings are refused before
 * any call (and fetch is blocked in tests anyway).
 */

let root = '';
let out: string[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'arena-cli-'));
  out = [];
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const deps = (extra: Partial<MatchCliDeps> = {}): MatchCliDeps => ({
  root,
  env: {},
  providers: PROVIDERS,
  now: () => new Date(2026, 9, 7, 12, 0, 0),
  gitCommit: () => 'abc123',
  print: (line) => out.push(line),
  confirm: () => Promise.reject(new Error('confirm should not be asked')),
  ...extra,
});

const read = (path: string) => parseMatchLog(readFileSync(join(root, path), 'utf8'));

describe('pnpm match', () => {
  it('plays a baselines-only fighter match on a SimClock and writes a v2 log that replays', async () => {
    const played = await runMatchCli(
      ['--game', 'fighter', '--a', 'random', '--b', 'scripted', '--seed', '7', '--sim'],
      deps(),
    );
    expect(played).toHaveLength(1);
    const [m] = played;
    if (!m) throw new Error('no match');
    expect(m.matchId).toBe('20261007-120000-fighter-random-vs-scripted-1');
    expect(m.path).toBe(`results/fighter/matches/${m.matchId}.jsonl`);
    const log = read(m.path);
    expect(log.header).toMatchObject({
      schemaVersion: 2,
      game: 'fighter',
      gameVersion: fighterGame.version,
      matchId: m.matchId,
      seed: 7,
      gitCommit: 'abc123',
      runLocation: 'sim',
      runId: 'sim',
      optionOrderRule: OPTION_ORDER_RULE,
      config: fighterGame.logConfig(fighterGame.defaultConfig),
      cadence: { kind: 'realtime', tickRate: 60 },
    });
    // Labels come from core (random) and the game's baselineLabels (scripted).
    expect(log.header.seats.map((s) => [s.player, s.label, s.warmup])).toEqual([
      ['random', 'Random (uniform)', null],
      ['scripted', fighterGame.baselineLabels?.scripted, null],
    ]);
    expect(log.header.seats[1].label).toBe('Scripted bot');
    expect(log.matchEnd).toEqual(m.end);
    expect(m.end).toMatchObject({ valid: true, costUsd: 0 });
    expect(replayLog(log, fighterGame).matches).toBe(true);
    expect(out.at(-1)).toMatch(
      /^fighter: random vs scripted seed 7: winner (random|scripted|draw) \(\d-\d\), \d+ ticks, .* -> results\/fighter\/matches\//,
    );
    // Baselines make no requests, so no snapshots.
    expect(existsSync(join(root, 'results', 'states'))).toBe(false);
  });

  it('runs a turn game on the turn scheduler; --matches n plays seeds seed, seed + 1, …', async () => {
    const played = await runMatchCli(
      [
        '--game',
        'counter_turns',
        '--a',
        'random',
        '--b',
        'random',
        '--seed',
        '3',
        '--sim',
        '--matches',
        '2',
      ],
      deps({ games: [counterTurns] }),
    );
    expect(played.map((m) => [m.matchId, m.seed])).toEqual([
      ['20261007-120000-counter_turns-random-vs-random-1', 3],
      ['20261007-120000-counter_turns-random-vs-random-2', 4],
    ]);
    for (const m of played) {
      const log = read(m.path);
      expect(log.header.cadence).toEqual({ kind: 'turns' });
      expect(log.matchEnd?.totalTicks).toBe(counterTurns.maxTurns(counterTurns.defaultConfig));
      expect(replayLog(log, counterTurns).matches).toBe(true);
    }
    expect(out.every((l) => / turns, /.test(l))).toBe(true);
  });

  it('lists the game’s players', async () => {
    const env = { OPENAI_API_KEY: 'sk-not-a-real-key' };
    await runMatchCli(['--game', 'fighter', '--list'], deps({ env }));
    expect(out.map((l) => l.split(/\s+/).slice(0, 2).join(' '))).toEqual([
      'jev provider',
      'openai provider',
      'random baseline',
      'scripted baseline',
      'human baseline',
    ]);
    expect(out[1]).toContain('keys set');
    expect(out[3]).toMatch(/ Scripted bot$/);
    expect(out[4]).toMatch(/ Human \(live mode\)$/);
    expect(out.join('\n')).not.toContain(env.OPENAI_API_KEY);
  });

  it('prints the estimate and stops with --estimate (no calls)', async () => {
    expect(
      await runMatchCli(
        ['--game', 'fighter', '--a', 'openai', '--b', 'random', '--estimate'],
        deps(),
      ),
    ).toEqual([]);
    expect(out[0]).toMatch(/^Cost estimate \(worst case, 1 match\(es\)\):/);
    out = [];
    await runMatchCli(
      ['--game', 'fighter', '--a', 'scripted', '--b', 'random', '--estimate'],
      deps(),
    );
    expect(out).toEqual(['Cost estimate: $0 (baselines only)']);
  });

  it('refuses a paid run over $5 without --approve-over-5, after printing the estimate', async () => {
    const run = runMatchCli(
      ['--game', 'fighter', '--a', 'openai', '--b', 'jev', '--matches', '500', '--sim'],
      deps(),
    );
    // --sim with a provider is refused first; without it, the $5 guard.
    await expect(run).rejects.toThrow(/--sim is for baselines only/);
    out = [];
    const over = ['--game', 'fighter', '--a', 'openai', '--b', 'jev', '--matches', '500'];
    await expect(runMatchCli(over, deps())).rejects.toThrow(
      /over the \$5 approval limit \(RULES\.md\)\. Nothing was run\.\nThe maintainer must approve: 500 fighter matches, openai vs jev: estimated \$[\d.]+, typical \$[\d.]+\. Once they have, rerun with --approve-over-5\./,
    );
    expect(out[0]).toMatch(/^Cost estimate \(worst case, 500 match\(es\)\):/);
    // --yes no longer approves it: it only skips the y/N question.
    await expect(runMatchCli([...over, '--yes'], deps())).rejects.toThrow(/--approve-over-5/);
    expect(existsSync(join(root, 'results'))).toBe(false);
  });

  it('asks before a paid run unless --yes, and stops on no; --approve-over-5 passes the $5 guard', async () => {
    const asked: string[] = [];
    const no = (q: string) => {
      asked.push(q);
      return Promise.resolve(false);
    };
    const paid = ['--game', 'fighter', '--a', 'openai', '--b', 'jev'];
    await expect(runMatchCli(paid, deps({ confirm: no }))).rejects.toThrow(
      'Not confirmed; nothing was run.',
    );
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(
      /^Run 1 fighter match, openai vs jev, estimated \$[\d.]+\? \[y\/N\] $/,
    );
    // Over $5 with approval: still asks (no --yes), and still stops on no.
    await expect(
      runMatchCli([...paid, '--matches', '500', '--approve-over-5'], deps({ confirm: no })),
    ).rejects.toThrow('Not confirmed; nothing was run.');
    expect(asked).toHaveLength(2);
    expect(existsSync(join(root, 'results'))).toBe(false);
  });

  it.each([
    [[], /--game is required/],
    [['--game', 'chess'], /unknown game "chess". Games: fighter/],
    [['--game', 'fighter', '--a', 'random'], /Usage:/],
    [
      ['--game', 'fighter', '--a', 'nobody', '--b', 'random'],
      /unknown player "nobody" for fighter/,
    ],
    [['--game', 'fighter', '--a', 'human', '--b', 'random'], /human plays in the browser/],
    [['--game', 'fighter', '--a', 'random', '--b', 'random', '--seed', 'x'], /--seed must be/],
    [['--game', 'fighter', '--a', 'random', '--b', 'random', '--matches', '0'], /at least 1/],
  ])('refuses %j', async (argv, why) => {
    const run = runMatchCli(argv, deps());
    await expect(run).rejects.toBeInstanceOf(CliError);
    await expect(run).rejects.toThrow(why);
  });
});
