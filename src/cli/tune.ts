import { availableParallelism } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Worker } from 'node:worker_threads';
import {
  checkReport,
  chunkName,
  formatFighterTuneReport,
  tuneFighter,
  type Chunk,
  type PairingRow,
} from '../games/fighter/tune.js';
import { gameIds } from '../games/index.js';
import { formatTuneReport, tuneInbox } from '../games/inbox/tune.js';
import type { TuneJob } from './tune-worker.js';

/** Matches per row when `--matches` is not given. */
const DEFAULT_MATCHES: Readonly<Record<string, number>> = { inbox: 20, fighter: 2000 };

const USAGE = `Usage:
  pnpm tune --game <id> [--matches n] [--first-seed n] [--workers n]

  Offline tuning matches on a simulated clock: no network, no keys, no cost.
  --game inbox     Inbox Invaders: survival and head-to-head for simulated players
  --game fighter   Fighter: spam bots vs random, scripted vs spam bots, random vs random
                   (exits 1 when a pass criterion fails)
  --matches n      matches per row (default ${String(DEFAULT_MATCHES.inbox)} for inbox, ${String(DEFAULT_MATCHES.fighter)} for fighter)
  --first-seed n   fighter only: seeds n … n + matches − 1 (default 1); a second seed range
                   checks the rates are stable
  --workers n      fighter only: worker threads (default: cores − 1; 0 plays in this thread)`;

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

/**
 * A pool of worker threads that play fighter chunks (src/cli/tune-worker.ts). Failures stay with
 * their job: a chunk that throws rejects that job alone, and a worker that dies mid-job (an
 * `error` or a non-zero exit) rejects only the job it was playing, naming its chunk, and is
 * replaced, so every other job still runs. Only when no worker is left are the queued jobs failed.
 */
export function workerPool(
  size: number,
  spawn: () => Worker = () => new Worker(new URL('./tune-worker.ts', import.meta.url)),
): { play: (chunk: Chunk) => Promise<PairingRow>; close(): void } {
  const workers = new Set<Worker>();
  const idle: Worker[] = [];
  /** The job each busy worker is playing. */
  const running = new Map<Worker, TuneJob>();
  /** The last error a worker reported before it exited. */
  const crashes = new Map<Worker, Error>();
  const queue: TuneJob[] = [];
  const pending = new Map<
    number,
    { resolve: (r: PairingRow) => void; reject: (e: Error) => void }
  >();
  let nextId = 0;
  let closed = false;
  /** Why the last worker died, for jobs that find no worker left. */
  let lastCrash = '';
  /** Chunks by job id, so a failure names its chunk. */
  const chunks = new Map<number, Chunk>();
  const chunkNameOf = (id: number): string => {
    const c = chunks.get(id);
    return c === undefined ? `job ${String(id)}` : chunkName(c);
  };

  const settle = (id: number, outcome: PairingRow | Error): void => {
    const p = pending.get(id);
    pending.delete(id);
    if (!p) return;
    if (outcome instanceof Error) p.reject(outcome);
    else p.resolve(outcome);
  };

  const dispatch = (): void => {
    for (;;) {
      if (closed || idle.length === 0 || queue.length === 0) return;
      const worker = idle.shift();
      const job = queue.shift();
      if (!worker || !job) return;
      running.set(worker, job);
      worker.postMessage(job);
    }
  };

  const add = (): void => {
    const worker = spawn();
    workers.add(worker);
    worker.on('message', (msg: { id: number; row?: PairingRow; error?: string }) => {
      running.delete(worker);
      idle.push(worker);
      settle(
        msg.id,
        msg.row ?? new Error(`${chunkNameOf(msg.id)}: ${msg.error ?? 'worker failed'}`),
      );
      dispatch();
    });
    worker.on('error', (err: Error) => {
      crashes.set(worker, err);
    });
    worker.on('exit', (code: number) => {
      workers.delete(worker);
      const at = idle.indexOf(worker);
      if (at >= 0) idle.splice(at, 1);
      const job = running.get(worker);
      running.delete(worker);
      const crash = crashes.get(worker);
      crashes.delete(worker);
      if (closed) return;
      const why = crash?.message ?? `worker exited with code ${String(code)}`;
      lastCrash = why;
      if (job) {
        settle(job.id, new Error(`${chunkName(job.chunk)}: ${why}`));
        add(); // a job's crash costs that job only: keep the pool at its size for the rest
      } else if (workers.size === 0) {
        // Idle workers dying with no worker left: nothing can play the queue, so fail it.
        for (const queued of queue.splice(0)) {
          settle(queued.id, new Error(`${chunkName(queued.chunk)}: no worker left (${why})`));
        }
      }
      dispatch();
    });
    idle.push(worker);
  };
  for (let i = 0; i < size; i++) add();
  return {
    play(chunk) {
      return new Promise<PairingRow>((resolve, reject) => {
        if (workers.size === 0) {
          reject(new Error(`${chunkName(chunk)}: no worker left (${lastCrash})`));
          return;
        }
        const id = nextId++;
        chunks.set(id, chunk);
        pending.set(id, {
          resolve: (r) => {
            chunks.delete(id);
            resolve(r);
          },
          reject: (e) => {
            chunks.delete(id);
            reject(e);
          },
        });
        queue.push({ id, chunk });
        dispatch();
      });
    },
    close() {
      closed = true;
      for (const w of workers) void w.terminate();
    },
  };
}

async function tuneFighterCli(matches: number, firstSeed: number, workers: number): Promise<void> {
  const pool = workers > 0 ? workerPool(workers) : null;
  try {
    const report = await tuneFighter(
      matches,
      pool ? { firstSeed, play: pool.play } : { firstSeed },
    );
    console.log(formatFighterTuneReport(report));
    if (!checkReport(report).pass) process.exitCode = 1;
  } catch (err) {
    // TuneChunksError lists every failed chunk; the others were played to the end.
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  } finally {
    pool?.close();
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((a) => a !== '--'),
    options: {
      game: { type: 'string' },
      matches: { type: 'string' },
      'first-seed': { type: 'string' },
      workers: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  const game = values.game;
  if (game === undefined) fail(USAGE);
  if (game !== 'inbox' && game !== 'fighter') {
    fail(`unknown game "${game}" (tunable: inbox, fighter; known: ${gameIds().join(', ')})`);
  }
  const matches = Number(values.matches ?? DEFAULT_MATCHES[game]);
  if (!Number.isInteger(matches) || matches < 1) fail(`--matches must be a positive integer`);
  const workers = Number(values.workers ?? Math.max(0, availableParallelism() - 1));
  if (!Number.isInteger(workers) || workers < 0) fail(`--workers must be a non-negative integer`);
  const firstSeed = Number(values['first-seed'] ?? 1);
  if (!Number.isInteger(firstSeed) || firstSeed < 0 || firstSeed + matches - 1 > 0xffffffff) {
    fail(`--first-seed must be an integer from 0 with the last seed under 2^32`);
  }

  const start = performance.now();
  if (game === 'inbox') console.log(formatTuneReport(await tuneInbox(matches)));
  else await tuneFighterCli(matches, firstSeed, workers);
  console.log(`\n(${((performance.now() - start) / 1000).toFixed(1)} s)`);
}

const entry = process.argv[1];
if (entry !== undefined && resolve(entry) === fileURLToPath(import.meta.url)) await main();
