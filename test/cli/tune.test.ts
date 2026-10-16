import { EventEmitter } from 'node:events';
import type { Worker } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';
import { workerPool } from '../../src/cli/tune.js';
import type { TuneJob } from '../../src/cli/tune-worker.js';
import { RANDOM, plannedRows, type Chunk, type PairingRow } from '../../src/games/fighter/tune.js';

/**
 * `pnpm tune --game fighter`'s worker pool, on fake workers: a failure stays with its job, and a
 * worker that dies is replaced so the other jobs still run.
 */

/** A fake worker thread: records the jobs it is sent; the test answers or crashes it. */
class FakeWorker extends EventEmitter {
  readonly jobs: TuneJob[] = [];
  terminated = false;
  postMessage(job: TuneJob): void {
    this.jobs.push(job);
  }
  terminate(): Promise<number> {
    this.terminated = true;
    this.emit('exit', 1);
    return Promise.resolve(1);
  }
  answer(job: TuneJob): void {
    const row: PairingRow = {
      a: 'random',
      b: 'random',
      matches: job.chunk.n,
      winsA: job.chunk.n,
      draws: 0,
      winsB: 0,
      seatWins: [job.chunk.n, 0],
      totalTicks: 0,
      meanS: 1,
    };
    this.emit('message', { id: job.id, row });
  }
  crash(message: string): void {
    this.emit('error', new Error(message));
    this.emit('exit', 1);
  }
}

const row = plannedRows([]).find((r) => r.a === RANDOM);
if (!row) throw new Error('no random row');
const chunk = (offset: number): Chunk => ({ row, n: 10, firstSeed: 1, offset });

function pool(size: number) {
  const workers: FakeWorker[] = [];
  const p = workerPool(size, () => {
    const w = new FakeWorker();
    workers.push(w);
    return w as unknown as Worker;
  });
  return { p, workers };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('tune worker pool', () => {
  it('a worker that dies fails only its own job, and a fresh worker plays the rest', async () => {
    const { p, workers } = pool(2);
    const results = [0, 10, 20, 30].map((o) =>
      p.play(chunk(o)).then(
        (r) => ({ ok: r.matches }),
        (e: unknown) => ({ error: (e as Error).message }),
      ),
    );
    expect(workers).toHaveLength(2);
    const [w0, w1] = workers as [FakeWorker, FakeWorker];
    // Each worker took one job; w0 crashes mid-job.
    w0.crash('out of memory');
    await flush();
    // A replacement started and took the next queued job; w1 is still busy with its own.
    expect(workers).toHaveLength(3);
    const w2 = workers[2] as FakeWorker;
    expect(w2.jobs).toHaveLength(1);
    w1.answer(w1.jobs[0] as TuneJob);
    await flush();
    w2.answer(w2.jobs[0] as TuneJob);
    await flush();
    const last = [w1, w2].find((w) => w.jobs.length === 2) as FakeWorker;
    last.answer(last.jobs[1] as TuneJob);
    expect(await Promise.all(results)).toEqual([
      { error: 'random vs random, seeds 1–10: out of memory' },
      { ok: 10 },
      { ok: 10 },
      { ok: 10 },
    ]);
    p.close();
    expect(workers.every((w) => w.terminated || w === w0)).toBe(true);
  });

  it('a chunk that throws in the worker rejects that job alone, naming the chunk', async () => {
    const { p, workers } = pool(1);
    const a = p.play(chunk(0)).catch((e: unknown) => (e as Error).message);
    const b = p.play(chunk(10));
    const w = workers[0] as FakeWorker;
    w.emit('message', { id: (w.jobs[0] as TuneJob).id, error: 'engine assertion' });
    await flush();
    w.answer(w.jobs[1] as TuneJob);
    expect(await a).toBe('random vs random, seeds 1–10: engine assertion');
    expect((await b).matches).toBe(10);
    expect(workers).toHaveLength(1);
    p.close();
  });

  it('fails the queue only when no worker is left', async () => {
    const { p, workers } = pool(1);
    const w = workers[0] as FakeWorker;
    // The worker dies before it was given anything (no job of its own).
    const idle = w.jobs.length;
    expect(idle).toBe(0);
    w.emit('error', new Error('failed to load'));
    w.emit('exit', 1);
    await flush();
    await expect(p.play(chunk(0))).rejects.toThrow(
      'random vs random, seeds 1–10: no worker left (failed to load)',
    );
    p.close();
  });
});
