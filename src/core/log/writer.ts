import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Seat } from '../classifier/types.js';
import type { LogLine, MatchLogSink } from './schema.js';

/**
 * JSONL file sink. Node only: the one file in src/core that touches the file system (node:fs, and
 * node:path's `dirname` for the parent directory; the paths it is given are `/`-joined like
 * src/core/results/paths.ts). The browser uses the memory sink (memory.ts).
 *
 * Appends one JSON line per `write` (sync, so a crash keeps everything written). The file is
 * created on the first write, so a match that never starts (failed warm-up) leaves none.
 */
export interface MatchLogFile extends MatchLogSink {
  readonly path: string;
  readonly lines: LogLine[];
}

export interface CreateMatchLogOptions {
  /**
   * If set, `snapshot` writes each decision's full request/response to
   * `<snapshotDir>/<seat>-<seq>.json`; pass `statesDir(game, matchId)`.
   */
  snapshotDir?: string;
}

export function createMatchLog(path: string, opts: CreateMatchLogOptions = {}): MatchLogFile {
  const lines: LogLine[] = [];
  const log: MatchLogFile = {
    path,
    lines,
    write(line) {
      if (lines.length === 0) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, '');
      }
      lines.push(line);
      appendFileSync(path, JSON.stringify(line) + '\n');
    },
  };
  const { snapshotDir } = opts;
  if (snapshotDir !== undefined) {
    log.snapshot = (seat, seq, raw) => {
      writeSnapshot(snapshotDir, seat, seq, raw);
    };
  }
  return log;
}

/** Write one decision's full request/response to `<dir>/<seat>-<seq>.json`; returns the path. */
export function writeSnapshot(
  dir: string,
  seat: Seat,
  seq: number,
  raw: { request: unknown; response: unknown },
): string {
  const path = `${dir}/${String(seat)}-${String(seq)}.json`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(raw, null, 2) + '\n');
  return path;
}
