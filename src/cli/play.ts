import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  createPlayer,
  gameBaselines,
  type BaselineFactory,
  type BaselineInfo,
} from '../core/classifier/players.js';
import type { Env, ProviderEntry } from '../core/classifier/providers.js';
import { randomDeciderSeed } from '../core/classifier/random.js';
import type { Decider, Seat } from '../core/classifier/types.js';
import { isRealtime, type Game } from '../core/game.js';
import type { DecisionLine, HeaderLine, MatchEndLine } from '../core/log/schema.js';
import { createMatchLog } from '../core/log/writer.js';
import { NO_EXCLUSIONS } from '../core/results/excluded.js';
import { matchFile, matchIdFor, statesDir } from '../core/results/paths.js';
import { driveRealtime, driveTurns } from '../core/sched/drive.js';
import { createRealtimeRunner } from '../core/sched/realtime.js';
import { WarmupError, playerMeta, type MatchOptions } from '../core/sched/shared.js';
import { createTurnRunner } from '../core/sched/turns.js';
import {
  invalidReasonText,
  invalidReasonsOfLog,
  type InvalidReason,
} from '../core/sched/validity.js';
import { SimClock, realClock, type Clock } from '../core/util/clock.js';
import { createPrng } from '../core/util/prng.js';

/**
 * What `pnpm match` and `pnpm tournament` share: checking the players, and playing one match of
 * any game on its own scheduler (real-time or turns) into `results/<game>/matches/<id>.jsonl`.
 * Neither CLI plays matches any other way, so both get the same seats, warm-up and log.
 */

/** A usage or guard failure: the message is for the user, and nothing was run. */
export class CliError extends Error {
  override name = 'CliError';
}

/** One finished match. */
export interface PlayedMatch {
  matchId: string;
  /** The log, relative to `root`. */
  path: string;
  seed: number;
  end: MatchEndLine;
  /**
   * Why the match is invalid, by the rule that wrote `end.valid` (validity.ts); empty when valid.
   * Omitted (tests' fakes): only `end.stalls` is known.
   */
  invalid?: InvalidReason[];
}

export function gitCommit(cwd: string): string {
  try {
    return execSync('git rev-parse HEAD', { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return 'unknown';
  }
}

export function nonNegativeInt(flag: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) {
    throw new CliError(`--${flag} must be a non-negative integer, got ${value}`);
  }
  return Number(value);
}

/** Load `.env` into `process.env` when there is one (keys may come from the environment too). */
export function loadEnv(): void {
  try {
    process.loadEnvFile();
  } catch {
    // No .env: keys may come from the environment, and baselines need none.
  }
}

/** A player id is a provider when the registry has it (anything else is a baseline). */
export function isProviderId(providers: readonly ProviderEntry[], id: string): boolean {
  return providers.some((p) => p.id === id);
}

/**
 * Throws a CliError for a player that is neither a provider nor one of the game's baselines, and
 * for `human` (the browser plays it). `command` names the CLI in the hint.
 */
export function checkPlayers(
  game: Game,
  providers: readonly ProviderEntry[],
  ids: readonly string[],
  command = 'match',
): void {
  const baselines = gameBaselines(game);
  for (const id of ids) {
    if (!isProviderId(providers, id) && !baselines.some((x) => x.id === id)) {
      throw new CliError(
        `unknown player "${id}" for ${game.id}. Try: pnpm match --game ${game.id} --list`,
      );
    }
    if (id === 'human') {
      throw new CliError(`human plays in the browser (pnpm live), not from pnpm ${command}`);
    }
  }
}

/** The first free `<stamp>-<game>-<a>-vs-<b>-<n>` under `root` for `when`. */
function freshMatchId(root: string, game: string, a: string, b: string, when: Date): string {
  for (let run = 1; ; run++) {
    const id = matchIdFor({ game, a, b, when, run });
    if (!existsSync(join(root, matchFile(game, id)))) return id;
  }
}

/**
 * The game's own baselines as `createPlayer` factories (`random` is core's). A baseline gets the
 * seat's own PRNG (the one `random` would use), never the game's.
 */
function baselineFactories(game: Game): Record<string, BaselineFactory> {
  return Object.fromEntries(
    game.baselines.map((id): [string, BaselineFactory] => [
      id,
      (deps) => {
        if (!game.createBaseline) throw new Error(`${game.id} cannot build baseline "${id}"`);
        return game.createBaseline(id, {
          clock: deps.clock,
          ...(deps.baselineDelayMs === undefined ? {} : { delayMs: deps.baselineDelayMs }),
          ...(deps.prng === undefined ? {} : { prng: deps.prng }),
        });
      },
    ]),
  );
}

/** Everything a match needs besides its seats and seed. */
export interface MatchContext {
  game: Game;
  providers: readonly ProviderEntry[];
  env: Env;
  /** The folder that holds `results/`. */
  root: string;
  /** Wall time for match ids and header start times. */
  now: () => Date;
  gitCommit: string;
  /** `runLocationFor` (run-id.ts). */
  runLocation: string;
  /** `runIdFor` (run-id.ts): this machine's id, or `sim`. */
  runId: string;
  /** Run on a SimClock (baselines only). */
  sim: boolean;
  /** The game's baselines (default `gameBaselines(game)`). */
  baselines?: readonly BaselineInfo[];
}

/**
 * Play one match, `a` in seat 0 and `b` in seat 1, and write its log. Throws a CliError when a
 * provider's warm-up fails (the match never starts and no log is written).
 */
export async function playOneMatch(
  ctx: MatchContext,
  a: string,
  b: string,
  seed: number,
): Promise<PlayedMatch> {
  const { game, providers, env, root } = ctx;
  const ids = [a, b] as const;
  const baselines = ctx.baselines ?? gameBaselines(game);
  const seats = [playerMeta(a, providers, baselines), playerMeta(b, providers, baselines)] as const;
  const clock: Clock = ctx.sim ? new SimClock() : realClock;
  const deciders = ([0, 1] as const).map((seat: Seat) =>
    createPlayer(ids[seat], {
      env,
      clock,
      providers,
      prng: createPrng(randomDeciderSeed(seed, seat)),
      baselines: baselineFactories(game),
    }),
  ) as [Decider, Decider];
  const matchId = freshMatchId(root, game.id, a, b, ctx.now());
  const path = matchFile(game.id, matchId);
  const sink = createMatchLog(join(root, path), {
    snapshotDir: join(root, statesDir(game.id, matchId)),
  });
  const common: MatchOptions<unknown> = {
    seed,
    config: game.defaultConfig,
    matchId,
    seats,
    deciders,
    clock,
    sink,
    gitCommit: ctx.gitCommit,
    runLocation: ctx.runLocation,
    runId: ctx.runId,
    startTime: () => ctx.now().toISOString(),
  };
  let end: MatchEndLine | null;
  try {
    if (isRealtime(game)) {
      const runner = createRealtimeRunner({ ...common, game });
      await driveRealtime(runner, clock);
      end = runner.result;
    } else {
      end = await driveTurns(createTurnRunner({ ...common, game }), clock);
    }
  } catch (err) {
    // The log file is created with the header, after the warm-up, so there is none.
    if (err instanceof WarmupError) throw new CliError(`${err.message}. No match log written.`);
    throw err;
  }
  if (!end) throw new Error(`${matchId}: the match did not finish`);
  const header = sink.lines.find((l): l is HeaderLine => l.type === 'header');
  const decisions = sink.lines.filter((l): l is DecisionLine => l.type === 'decision');
  const invalid =
    end.valid || header === undefined
      ? []
      : invalidReasonsOfLog({ header, decisions, matchEnd: end }, NO_EXCLUSIONS);
  return { matchId, path, seed, end, invalid };
}

/** "valid", or "INVALID (stall)" with every reason the match is invalid (seats by player id). */
export function validityText(
  m: Pick<PlayedMatch, 'end' | 'invalid'>,
  ids: readonly [string, string],
): string {
  if (m.end.valid) return 'valid';
  const reasons = m.invalid ?? [];
  return reasons.length === 0
    ? 'INVALID'
    : `INVALID (${reasons.map((r) => invalidReasonText(r, ids)).join('; ')})`;
}

/**
 * The one-line warning for a match that stalled, or null: the machine paused mid-match, most
 * likely asleep, so the match is invalid. The stall is the one the scheduler recorded
 * (`match_end.stalls`), else one the decision lines show (`invalid`, validity.ts `logStalls`).
 */
export function stallWarning(
  end: MatchEndLine,
  invalid: readonly InvalidReason[] = [],
): string | null {
  const fromLog = invalid.find((r) => r.kind === 'stall')?.stalls ?? [];
  const stalls = (end.stalls ?? []).length > 0 ? (end.stalls ?? []) : fromLog;
  if (stalls.length === 0) return null;
  const longest = Math.max(...stalls.map((s) => s.gapMs));
  return (
    `  Warning: the machine paused mid-match (longest ${(longest / 1000).toFixed(1)} s), likely ` +
    'sleep; keep it awake and on power. The match is invalid.'
  );
}

/** The winning player id, or `draw`. */
export function winnerOf(ids: readonly [string, string], end: MatchEndLine): string {
  const w = end.winner;
  return w === 0 || w === 1 ? ids[w] : 'draw';
}
