import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadProviders } from '../core/classifier/providers.js';
import { APPROVAL_LIMIT_USD, estimateMatch, pricedSeats } from '../core/estimate.js';
import { formatResult } from '../core/stats/format.js';
import { summaryMarkdown } from '../core/stats/markdown.js';
import { GAMES } from '../games/index.js';
import { rebuildResults, type RebuildResult } from './leaderboard.js';
import type { MatchCliDeps } from './match.js';
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
  type MatchContext,
  type PlayedMatch,
} from './play.js';
import { SIM_RUN_ID, isHostnameRunId, runIdFor, runLocationFor } from './run-id.js';

/**
 * `pnpm tournament` (docs/architecture/core.md, "Tournament"): `n` matches of one game between two
 * players, for the published results. In order:
 *
 *   1. **Estimate first.** The worst case for the whole run (`n` matches plus up to MAX_RERUNS
 *      reruns) from the game's measured tokens per decision, before anything runs, and the run id
 *      every log will carry (run-id.ts: this machine's, so the published runs can show they came
 *      from one machine without saying where it is; `sim` for `--sim`).
 *   2. **Guards for paid runs** (a provider in either seat): a worst case over $5 needs
 *      `--approve-over-5`, which the lead passes only with the maintainer's approval (RULES.md);
 *      then a y/N on stdin unless `--yes`. Baselines-only runs cost nothing and need none of this.
 *   3. **Seats swap every match** (a, b, a, b, …), seeds `seed-base + k`. Matches run strictly one
 *      at a time, never concurrently.
 *   4. **Reruns.** Each invalid match (by the `match_end.valid` the scheduler wrote, validity.ts)
 *      is rerun after the scheduled ones, in the same seats with a new seed, up to MAX_RERUNS
 *      extra in total. Only transport failures over 2%, stalls and empty real-time provider seats
 *      make a match invalid: a timeout or a refusal is the model's own miss and is never rerun
 *      away. Invalid logs stay in `results/`, marked invalid in the index; nothing is deleted. Each
 *      invalid result line names its reasons, and a stall (sleep, suspend: an infrastructure
 *      failure) also gets a warning line.
 *   5. **Afterwards** `pnpm leaderboard`: the summaries, the leaderboard, the featured matches and
 *      the index. Then the game's summary table and this run's spend, from the logs.
 */

/** Extra matches allowed in total to replace invalid ones. */
export const MAX_RERUNS = 10;

export const USAGE = `Usage:
  pnpm tournament --game <id> --a <player> --b <player> --matches <n> [--seed-base n] [--sim] [--yes] [--approve-over-5]

  --game            the game (${GAMES.map((g) => g.id).join(', ')})
  --a, --b          the two players; they swap seats every match (a, b, a, b, …)
  --matches         how many matches to play (plus up to ${String(MAX_RERUNS)} reruns of invalid ones)
  --seed-base       match k plays seed seed-base + k (reruns continue after the last); default random
  --sim             run on a simulated clock (baselines only)
  --yes             don't ask before a paid run
  --approve-over-5  allow a worst case over $${String(APPROVAL_LIMIT_USD)} (only with the maintainer's approval)

Every log records this machine's run id (printed with the estimate); RUN_LOCATION adds an optional label.`;

/** One match the tournament asks for. */
export interface TournamentMatchSpec {
  /** Seat 0 and seat 1. */
  a: string;
  b: string;
  seed: number;
  /** The scheduled match this plays (0 … n − 1); a rerun keeps its slot, so its seats. */
  slot: number;
  /** Attempt number over the whole run, from 0. */
  attempt: number;
  rerun: boolean;
}

export interface TournamentDeps extends MatchCliDeps {
  /** Asks a y/N question; default reads stdin. */
  confirm?: (question: string) => Promise<boolean>;
  /** Plays one match; default `playOneMatch`. Tests inject a fake. */
  play?: (spec: TournamentMatchSpec) => Promise<PlayedMatch>;
  /** Rebuilds summaries, leaderboard and index afterwards; default `rebuildResults`. */
  rebuild?: (root: string) => RebuildResult | undefined;
}

export interface TournamentResult {
  /** Every match played, in order, invalid ones and reruns included. */
  played: PlayedMatch[];
  valid: number;
  invalid: number;
  reruns: number;
  /** Scheduled matches that never got a valid result. */
  stillInvalid: number;
  /** Spend over every match played, from each log's match_end. */
  costUsd: number;
}

async function askOnStdin(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

/**
 * Parse `argv` (without the node and script paths) and run the tournament. Returns null for
 * `--help`. Throws CliError on bad arguments or a refused guard; nothing has run then.
 */
export async function runTournamentCli(
  argv: readonly string[],
  deps: TournamentDeps = {},
): Promise<TournamentResult | null> {
  const print =
    deps.print ??
    ((line: string) => {
      console.log(line);
    });
  const { values } = parseArgs({
    args: argv.filter((x) => x !== '--'),
    options: {
      game: { type: 'string' },
      a: { type: 'string' },
      b: { type: 'string' },
      matches: { type: 'string' },
      'seed-base': { type: 'string' },
      sim: { type: 'boolean', default: false },
      yes: { type: 'boolean', default: false },
      'approve-over-5': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) {
    print(USAGE);
    return null;
  }
  const games = deps.games ?? GAMES;
  if (values.game === undefined) throw new CliError(`--game is required.\n${USAGE}`);
  const game = games.find((g) => g.id === values.game);
  if (!game) {
    throw new CliError(
      `unknown game "${values.game}". Games: ${games.map((g) => g.id).join(', ')}`,
    );
  }
  const { a, b } = values;
  if (a === undefined || b === undefined) throw new CliError(USAGE);
  const env = deps.env ?? process.env;
  const providers = deps.providers ?? (await loadProviders());
  checkPlayers(game, providers, [a, b], 'tournament');
  if (values.matches === undefined) throw new CliError(`--matches is required.\n${USAGE}`);
  const n = nonNegativeInt('matches', values.matches) ?? 0;
  if (n < 1) throw new CliError('--matches must be at least 1');
  const seedArg = nonNegativeInt('seed-base', values['seed-base']);
  const randomSeed = deps.randomSeed ?? (() => Math.floor(Math.random() * 2 ** 32));
  const seedBase = (seedArg ?? randomSeed()) >>> 0;
  const paid = [a, b].some((id) => isProviderId(providers, id));
  const runId = (deps.runId ?? runIdFor)(values.sim);

  // 1. The estimate and the run id, before anything else happens.
  const worstMatches = n + MAX_RERUNS;
  const est = estimateMatch(game.estimate, pricedSeats([a, b], providers), {
    matches: worstMatches,
  });
  if (paid) {
    print(est.text);
    print(
      `  (${String(n)} matches plus up to ${String(MAX_RERUNS)} reruns of invalid ones: ` +
        `${String(worstMatches)} matches worst case)`,
    );
  } else {
    print('Cost estimate: $0 (baselines only)');
  }
  print(
    runId === SIM_RUN_ID
      ? `  Run id: ${runId} (simulated clock)`
      : isHostnameRunId(runId)
        ? `  Run id: ${runId} (from the host name: no machine id was readable, so it can change)`
        : `  Run id: ${runId} (this machine; the same in every log it writes)`,
  );

  // 2. Guards for paid runs.
  if (paid) {
    if (values.sim) {
      throw new CliError('--sim is for baselines only: provider latency is real time');
    }
    if (est.totalUsd > APPROVAL_LIMIT_USD && !values['approve-over-5']) {
      const command =
        `pnpm tournament --game ${game.id} --a ${a} --b ${b} --matches ${String(n)} ` +
        `--seed-base ${String(seedBase)} --approve-over-5`;
      throw new CliError(
        [
          `Worst case $${est.totalUsd.toFixed(2)} is over the $${String(APPROVAL_LIMIT_USD)} ` +
            'approval limit (RULES.md). Nothing was run.',
          `The maintainer must approve: ${String(n)} ${game.id} matches, ${a} vs ${b} ` +
            `(seats swap every match), plus up to ${String(MAX_RERUNS)} reruns: worst case ` +
            `$${est.totalUsd.toFixed(2)}, typical $${est.typicalUsd.toFixed(2)}.`,
          'Once they have, run:',
          `  ${command}`,
        ].join('\n'),
      );
    }
    if (!values.yes) {
      const confirm = deps.confirm ?? askOnStdin;
      const ok = await confirm(
        `Run ${String(n)} ${game.id} matches, ${a} vs ${b} (seats swap every match; up to ` +
          `${String(MAX_RERUNS)} reruns), worst case $${est.totalUsd.toFixed(4)}? [y/N] `,
      );
      if (!ok) throw new CliError('Not confirmed; nothing was run.');
    }
  }

  // 3. The matches, one at a time (reruns after the scheduled ones).
  const root = deps.root ?? '.';
  const ctx: MatchContext = {
    game,
    providers,
    env,
    root,
    now: deps.now ?? (() => new Date()),
    gitCommit: (deps.gitCommit ?? (() => gitCommit(root)))(),
    runLocation: runLocationFor(env, values.sim),
    runId,
    sim: values.sim,
  };
  const play =
    deps.play ?? ((spec: TournamentMatchSpec) => playOneMatch(ctx, spec.a, spec.b, spec.seed));
  print(
    `Seeds ${String(seedBase)}–${String((seedBase + n - 1) >>> 0)} ` +
      `(reruns continue from ${String((seedBase + n) >>> 0)}); run location ${ctx.runLocation}.`,
  );

  const played: PlayedMatch[] = [];
  const queue = Array.from({ length: n }, (_, slot) => ({ slot, rerun: false }));
  /** Reruns queued, and reruns played so far (for the progress tag). */
  let reruns = 0;
  let rerunsPlayed = 0;
  let attempt = 0;
  let total = 0;
  let stopped: Error | null = null;
  /** Scheduled matches with a valid result so far. */
  const validSlots = new Set<number>();
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    const [s0, s1] = next.slot % 2 === 0 ? [a, b] : [b, a];
    const spec: TournamentMatchSpec = {
      a: s0,
      b: s1,
      seed: (seedBase + attempt) >>> 0,
      slot: next.slot,
      attempt,
      rerun: next.rerun,
    };
    attempt++;
    let m: PlayedMatch;
    try {
      m = await play(spec);
    } catch (err) {
      // A failed warm-up (no log) or a crash: stop, but still rebuild what was played.
      stopped = err instanceof Error ? err : new Error(String(err));
      break;
    }
    played.push(m);
    total += m.end.costUsd;
    if (m.end.valid) validSlots.add(next.slot);
    if (next.rerun) rerunsPlayed++;
    const tag = next.rerun
      ? `[rerun ${String(rerunsPlayed)}/${String(MAX_RERUNS)}]`
      : `[${String(next.slot + 1)}/${String(n)}]`;
    print(
      `${tag} ${m.matchId}: ${formatResult([s0, s1], m.end.winner, m.end.scores)}, ` +
        `${validityText(m, [s0, s1])}, $${m.end.costUsd.toFixed(4)} ` +
        `(run total $${total.toFixed(4)})`,
    );
    const paused = stallWarning(m.end, m.invalid);
    if (paused !== null) print(paused);
    if (!m.end.valid && reruns < MAX_RERUNS) {
      reruns++;
      queue.push({ slot: next.slot, rerun: true });
    }
  }

  // 4. Summaries, leaderboard, featured and index; then the table and the spend.
  const rebuild = deps.rebuild ?? ((r: string) => rebuildResults({ root: r, games }));
  const rebuilt = rebuild(root);
  const summary = rebuilt?.summaries.find((s) => s.game === game.id);
  if (summary !== undefined) {
    print('');
    print(summaryMarkdown(summary).trimEnd());
    print('');
  }
  const valid = played.filter((m) => m.end.valid).length;
  const result: TournamentResult = {
    played,
    valid,
    invalid: played.length - valid,
    reruns,
    stillInvalid: n - validSlots.size,
    costUsd: total,
  };
  if (stopped !== null) {
    print(`Stopped after ${String(played.length)} matches: ${stopped.message}`);
    throw stopped;
  }
  if (result.stillInvalid > 0) {
    print(
      `${String(result.stillInvalid)} scheduled matches are still invalid after ` +
        `${String(reruns)} reruns; they are logged and not scored.`,
    );
  }
  print(
    `This run: ${String(played.length)} matches (${String(valid)} valid, ` +
      `${String(result.invalid)} invalid, ${String(reruns)} reruns), cost ` +
      `$${total.toFixed(4)} from the logs.`,
  );
  return result;
}

const entry = process.argv[1];
if (entry !== undefined && resolve(entry) === fileURLToPath(import.meta.url)) {
  loadEnv();
  runTournamentCli(process.argv.slice(2)).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
