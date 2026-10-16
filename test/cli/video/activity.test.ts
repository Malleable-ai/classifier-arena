import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { activityOf, scoreSignal } from '../../../src/cli/video/activity.js';
import { parseMatchLog } from '../../../src/core/log/read.js';
import { rendererFor } from '../../../src/web/games/index.js';

function firstLog(game: string) {
  const dir = `results/${game}/matches`;
  const file =
    readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .sort()[0] ?? '';
  return parseMatchLog(readFileSync(`${dir}/${file}`, 'utf8'));
}

describe('activityOf', () => {
  for (const game of ['fighter', 'inbox', 'clues']) {
    it(`${game}: one entry per frame of the video timeline, every decision counted once`, () => {
      const log = firstLog(game);
      const a = activityOf(log);
      const timeline = rendererFor(game)?.timeline(log);
      expect(a.frames).toBe(timeline?.frames);
      expect(a.decisions).toHaveLength(a.frames);
      expect(a.scores).toHaveLength(a.frames);
      const total = a.decisions.reduce((n, d) => n + d, 0);
      // Every line that resolves on screen by the last frame (all but a dropped tail at most).
      expect(total).toBe(timeline?.at(a.frames - 1).decisions.length);
      expect(total).toBeGreaterThan(0);
      if (log.header.cadence.kind === 'turns') {
        expect(a.bounds?.[0]).toBe(0);
        expect(a.bounds?.at(-1)).toBe(a.frames);
        expect(a.bounds).toHaveLength(17);
      } else expect(a.bounds).toBeNull();
    });
  }

  it('counts score changes: fighter hits, inbox health, clue points', () => {
    const fighter = activityOf(firstLog('fighter'));
    expect(fighter.scores.reduce((n, s) => n + s, 0)).toBeGreaterThan(5);
    const clues = firstLog('clues');
    const points = (clues.matchEnd?.scores ?? [0, 0]).reduce((n, s) => n + s, 0);
    expect(activityOf(clues).scores.reduce((n, s) => n + s, 0)).toBe(points);
    expect(scoreSignal('chess', {})).toEqual([]);
  });
});
