import { describe, expect, it } from 'vitest';
import type { RealtimeInput } from '../../../src/core/game.js';
import type { HeaderLine, LogLine, MatchEndLine } from '../../../src/core/log/schema.js';
import { inboxGame } from '../../../src/games/inbox/game.js';
import { FAST, RANDOM, SCRIPTED, SLOW, runInboxMatch } from '../../../src/games/inbox/tune.js';

/**
 * Determinism soak: a fixed seed and seeded simulated players through the real-time scheduler on a
 * SimClock give byte-identical logs, and the log replays (decision lines fed to `step` on their
 * applied tick) to the recorded final hash. The recorded hash changes only when the engine, the
 * data, the default config or the scheduler changes; then bump the game version and say so.
 */
const SEED = 20261007;
// Re-recorded 2026-10-08 after the content sweep changed the messages (data sha256 72553834…).
const RECORDED = { finalStateHash: 'da118ec5f92d8e23', totalTicks: 4485 };

/** Rebuild the match from its log alone: header seed and config, then every applied decision. */
function replay(lines: readonly LogLine[]): { hash: string; ticks: number } {
  const header = lines.find((l): l is HeaderLine => l.type === 'header');
  if (!header) throw new Error('no header');
  const g = inboxGame;
  const state = g.create(header.seed, g.configFromLog(header.config));
  const byTick = new Map<number, [RealtimeInput | null, RealtimeInput | null]>();
  for (const l of lines) {
    if (l.type !== 'decision' || l.appliedTick === null || l.choice === null) continue;
    const pair = byTick.get(l.appliedTick) ?? [null, null];
    pair[l.seat] = { choice: l.choice, questionKey: l.questionKey };
    byTick.set(l.appliedTick, pair);
  }
  while (!g.result(state).over && g.tick(state) < g.maxTicks(state.config)) {
    g.step(state, byTick.get(g.tick(state)) ?? [null, null]);
  }
  return { hash: g.hash(state), ticks: g.tick(state) };
}

const endOf = (lines: readonly LogLine[]): MatchEndLine => {
  const end = lines.at(-1);
  if (end?.type !== 'match_end') throw new Error('no match_end');
  return end;
};

describe('Inbox Invaders determinism soak', () => {
  it('gives identical logs for the same seed and players, ending on the recorded hash', async () => {
    const one = await runInboxMatch(SEED, [FAST, SLOW]);
    const two = await runInboxMatch(SEED, [FAST, SLOW]);
    expect(JSON.stringify(two.lines)).toBe(JSON.stringify(one.lines));
    const end = endOf(one.lines);
    expect({ finalStateHash: end.finalStateHash, totalTicks: end.totalTicks }).toEqual(RECORDED);
    expect(end.winner).toBe(0);
    expect(one.lines.filter((l) => l.type === 'decision').length).toBeGreaterThan(300);

    const other = await runInboxMatch(SEED + 1, [FAST, SLOW]);
    expect(endOf(other.lines).finalStateHash).not.toBe(end.finalStateHash);
  });

  it.each([
    ['180ms@90% vs 300ms@90%', FAST, SLOW, SEED],
    ['random vs scripted', RANDOM, SCRIPTED, 11],
    ['scripted vs 180ms@90%', SCRIPTED, FAST, 12],
  ] as const)('replays %s from its log to the final hash', async (_, a, b, seed) => {
    const { lines } = await runInboxMatch(seed, [a, b]);
    const end = endOf(lines);
    expect(replay(lines)).toEqual({ hash: end.finalStateHash, ticks: end.totalTicks });
  });
});
