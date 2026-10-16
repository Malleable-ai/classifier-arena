import type { LogLine, MatchLogSink } from './schema.js';

/** In-memory sink (tests, browser). DOM- and Node-free. */
export function createMemoryLog(): MatchLogSink & { lines: LogLine[] } {
  const lines: LogLine[] = [];
  return {
    lines,
    write(line) {
      lines.push(line);
    },
  };
}
