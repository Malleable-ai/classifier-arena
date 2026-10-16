import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { gameBaselines, listPlayers, type BaselineInfo } from '../core/classifier/players.js';
import { loadProviders, type Env, type ProviderEntry } from '../core/classifier/providers.js';
import { APPROVAL_LIMIT_USD, estimateMatch, pricedSeats } from '../core/estimate.js';
import { isRealtime, type Game } from '../core/game.js';
import { GAMES } from '../games/index.js';
import {
  CliError,
  checkPlayers,
  gitCommit,
  isProviderId,
  loadEnv,
  nonNegativeInt,
  playOneMatch,
  stallWarning,
  validityText,
  winnerOf,
  type MatchContext,
  type PlayedMatch,
} from './play.js';
import { runIdFor, runLocationFor } from './run-id.js';

export { CliError, type PlayedMatch } from './play.js';

/**
 * `pnpm match`: play matches of any registered game from the command line, one at a time, on the
 * game's own scheduler (real-time or turns), and write each v2 log to
 * `results/<game>/matches/<matchId>.jsonl`. Paid runs print the cost estimate first, refuse
 * anything estimated over $5 without `--approve-over-5` (RULES.md: only with the maintainer's
 * approval), and ask y/N unless `--yes`, as `pnpm tournament` does. Keys come from `.env` (or the
 * environment) and never reach a log. The single match itself is `playOneMatch` (play.ts), which
 * `pnpm tournament` shares.
 */

export const USAGE = `Usage:
  pnpm match --game <id> --a <player> --b <player> [--seed n] [--matches n] [--sim] [--yes] [--approve-over-5] [--estimate]
  pnpm match --game <id> --list

  --game            the game to play (${GAMES.map((g) => g.id).join(', ')})
  --a, --b          seat 0 and seat 1: a provider id, random, or one of the game's own baselines
  --seed            the first match's seed (match i plays seed + i); default a random seed per match
  --matches         how many matches to play, one after another (default 1)
  --sim             run on a simulated clock (baselines only; finishes in seconds)
  --estimate        print the cost estimate and exit (no API calls)
  --yes             don't ask before a paid run
  --approve-over-5  allow a run estimated over $${String(APPROVAL_LIMIT_USD)} (only with the maintainer's approval)
  --list            list the game's players and whether their keys are set`;

export interface MatchCliDeps {
  /** The games to choose from (default the registry). */
  games?: readonly Game[];
  /** Default: the built-ins plus providers.local.json. */
  providers?: readonly ProviderEntry[];
  /** API keys; default `process.env` (main loads `.env` into it first). */
  env?: Env;
  /** The folder that holds `results/` (default the working directory). */
  root?: string;
  /** Wall time for match ids and header start times. */
  now?: () => Date;
  /** A seed for a match without `--seed`. */
  randomSeed?: () => number;
  gitCommit?: () => string;
  /** The run id for the header; default `runIdFor` (this machine's id, or `sim`). */
  runId?: (sim: boolean) => string;
  print?: (line: string) => void;
  /** Asks a y/N question before a paid run; default reads stdin. */
  confirm?: (question: string) => Promise<boolean>;
}

async function askOnStdin(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

function listing(env: Env, providers: readonly ProviderEntry[], baselines: BaselineInfo[]) {
  return listPlayers(env, providers, baselines).map((p) => {
    const keys =
      p.kind === 'baseline'
        ? 'no keys needed'
        : p.available
          ? 'keys set'
          : `missing ${(p.missingEnv ?? []).join(', ')}`;
    return `${p.id.padEnd(10)} ${p.kind.padEnd(9)} ${keys.padEnd(28)} ${p.label}`;
  });
}

/**
 * Parse `argv` (without the node and script paths) and play. Returns the matches played (none for
 * `--help`, `--list` or `--estimate`). Throws CliError on bad arguments, a refused estimate or a
 * failed warm-up (no log is written then).
 */
export async function runMatchCli(
  argv: readonly string[],
  deps: MatchCliDeps = {},
): Promise<PlayedMatch[]> {
  const print =
    deps.print ??
    ((line: string) => {
      console.log(line);
    });
  const { values } = parseArgs({
    args: argv.filter((a) => a !== '--'),
    options: {
      game: { type: 'string' },
      a: { type: 'string' },
      b: { type: 'string' },
      seed: { type: 'string' },
      matches: { type: 'string' },
      sim: { type: 'boolean', default: false },
      list: { type: 'boolean', default: false },
      yes: { type: 'boolean', default: false },
      'approve-over-5': { type: 'boolean', default: false },
      estimate: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) {
    print(USAGE);
    return [];
  }
  const games = deps.games ?? GAMES;
  if (values.game === undefined) throw new CliError(`--game is required.\n${USAGE}`);
  const game = games.find((g) => g.id === values.game);
  if (!game) {
    throw new CliError(
      `unknown game "${values.game}". Games: ${games.map((g) => g.id).join(', ')}`,
    );
  }
  const env = deps.env ?? process.env;
  const providers = deps.providers ?? (await loadProviders());
  const baselines = gameBaselines(game);

  if (values.list) {
    for (const line of listing(env, providers, baselines)) print(line);
    return [];
  }

  const { a, b } = values;
  if (a === undefined || b === undefined) throw new CliError(USAGE);
  const ids = [a, b] as const;
  const isProvider = (id: string): boolean => isProviderId(providers, id);
  checkPlayers(game, providers, ids);
  const matches = nonNegativeInt('matches', values.matches) ?? 1;
  if (matches < 1) throw new CliError('--matches must be at least 1');
  const firstSeed = nonNegativeInt('seed', values.seed);

  if (ids.some(isProvider)) {
    const est = estimateMatch(game.estimate, pricedSeats(ids, providers), { matches });
    print(est.text);
    if (values.estimate) return [];
    if (values.sim) {
      throw new CliError('--sim is for baselines only: provider latency is real time');
    }
    if (est.totalUsd > APPROVAL_LIMIT_USD && !values['approve-over-5']) {
      throw new CliError(
        [
          `Estimated $${est.totalUsd.toFixed(2)} is over the $${String(APPROVAL_LIMIT_USD)} ` +
            'approval limit (RULES.md). Nothing was run.',
          `The maintainer must approve: ${String(matches)} ${game.id} ${matches === 1 ? 'match' : 'matches'}, ` +
            `${a} vs ${b}: estimated $${est.totalUsd.toFixed(2)}, typical ` +
            `$${est.typicalUsd.toFixed(2)}. Once they have, rerun with --approve-over-5.`,
        ].join('\n'),
      );
    }
    if (!values.yes) {
      const confirm = deps.confirm ?? askOnStdin;
      const ok = await confirm(
        `Run ${String(matches)} ${game.id} ${matches === 1 ? 'match' : 'matches'}, ${a} vs ${b}, ` +
          `estimated $${est.totalUsd.toFixed(4)}? [y/N] `,
      );
      if (!ok) throw new CliError('Not confirmed; nothing was run.');
    }
  } else if (values.estimate) {
    print('Cost estimate: $0 (baselines only)');
    return [];
  }

  const root = deps.root ?? '.';
  const now = deps.now ?? (() => new Date());
  const randomSeed = deps.randomSeed ?? (() => Math.floor(Math.random() * 2 ** 32));
  const ctx: MatchContext = {
    game,
    providers,
    env,
    root,
    now,
    gitCommit: (deps.gitCommit ?? (() => gitCommit(root)))(),
    runLocation: runLocationFor(env, values.sim),
    runId: (deps.runId ?? runIdFor)(values.sim),
    sim: values.sim,
    baselines,
  };
  const played: PlayedMatch[] = [];

  for (let i = 0; i < matches; i++) {
    const seed = firstSeed === undefined ? randomSeed() >>> 0 : (firstSeed + i) >>> 0;
    const started = performance.now();
    const m = await playOneMatch(ctx, a, b, seed);
    const { end } = m;
    const unit = isRealtime(game) ? 'ticks' : 'turns';
    const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
    const secs = ((performance.now() - started) / 1000).toFixed(1);
    const tiebreak =
      winnerOf(ids, end) !== 'draw' && end.scores[0] === end.scores[1] ? ' on the tiebreak' : '';
    print(
      `${game.id}: ${a} vs ${b} seed ${String(seed)}: winner ${winnerOf(ids, end)}${tiebreak} ` +
        `(${String(end.scores[0])}-${String(end.scores[1])}), ${String(end.totalTicks)} ${unit}, ` +
        `decisions ${String(end.decisions[0])}/${String(end.decisions[1])}, ` +
        `misses ${pct(end.missRates[0])}/${pct(end.missRates[1])}, ` +
        (end.refusalRates === undefined
          ? ''
          : `refusals ${pct(end.refusalRates[0])}/${pct(end.refusalRates[1])}, `) +
        `${validityText(m, ids)}, $${end.costUsd.toFixed(4)}, ${secs} s -> ${m.path}`,
    );
    const paused = stallWarning(end, m.invalid);
    if (paused !== null) print(paused);
    played.push(m);
  }
  return played;
}

const entry = process.argv[1];
if (entry !== undefined && resolve(entry) === fileURLToPath(import.meta.url)) {
  loadEnv();
  runMatchCli(process.argv.slice(2)).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
