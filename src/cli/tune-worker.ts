import { parentPort } from 'node:worker_threads';
import { playChunk, type Chunk } from '../games/fighter/tune.js';

/**
 * A worker thread for `pnpm tune --game fighter`: plays each chunk of offline matches it is sent
 * and posts the row back with the job id. Pure function of the chunk, so the report does not
 * depend on how chunks are spread over workers.
 */

export interface TuneJob {
  id: number;
  chunk: Chunk;
}

const port = parentPort;
if (!port) throw new Error('tune-worker must run as a worker thread');

port.on('message', (job: TuneJob) => {
  playChunk(job.chunk).then(
    (row) => {
      port.postMessage({ id: job.id, row });
    },
    (err: unknown) => {
      port.postMessage({ id: job.id, error: err instanceof Error ? err.message : String(err) });
    },
  );
});
