import { describe, expect, it } from 'vitest';
import {
  NO_EXCLUSIONS,
  exclusionsOf,
  parseExcluded,
  unknownExcludedIds,
} from '../../../src/core/results/excluded.js';
import { EXCLUDED_FILE } from '../../../src/core/results/paths.js';

/** `results/excluded.json`: matches excluded by hand, each with its reason. */

const A = '20261014-031502-inbox-jev-vs-openai-1';
const B = '20261014-032210-inbox-openai-vs-jev-1';

describe('parseExcluded', () => {
  it('reads { matches: [{ id, reason }] } in file order, reasons trimmed', () => {
    expect(EXCLUDED_FILE).toBe('results/excluded.json');
    expect(parseExcluded({ matches: [] })).toEqual([]);
    expect(
      parseExcluded({
        matches: [
          { id: A, reason: ' Mac asleep mid-match ' },
          { id: B, reason: 'Mac asleep mid-match' },
        ],
      }),
    ).toEqual([
      { id: A, reason: 'Mac asleep mid-match' },
      { id: B, reason: 'Mac asleep mid-match' },
    ]);
  });

  it('is strict, so a typo fails instead of excluding nothing', () => {
    const bad: [unknown, RegExp][] = [
      [null, /must be an object/],
      [[], /must be an object/],
      [{}, /"matches" must be an array/],
      [{ matches: {} }, /"matches" must be an array/],
      [{ match: [] }, /unknown key "match"/],
      [{ matches: [], note: 'x' }, /unknown key "note"/],
      [{ matches: ['x'] }, /matches\[0\] must be an object/],
      [{ matches: [{ id: A }] }, /matches\[0\]\.reason must be a non-empty string/],
      [{ matches: [{ id: A, reason: '  ' }] }, /matches\[0\]\.reason must be a non-empty string/],
      [{ matches: [{ reason: 'x' }] }, /matches\[0\]\.id must be a match id/],
      [{ matches: [{ id: 'a/../b', reason: 'x' }] }, /matches\[0\]\.id must be a match id/],
      [{ matches: [{ id: A, reasn: 'x' }] }, /matches\[0\]: unknown key "reasn"/],
      [
        {
          matches: [
            { id: A, reason: 'x' },
            { id: A, reason: 'y' },
          ],
        },
        /matches\[1\]: ".*" is listed twice/,
      ],
    ];
    for (const [value, msg] of bad) expect(() => parseExcluded(value)).toThrow(msg);
  });
});

describe('exclusionsOf and unknownExcludedIds', () => {
  it('maps id to reason, and names the ids that match no log', () => {
    const list = [
      { id: A, reason: 'asleep' },
      { id: B, reason: 'asleep too' },
    ];
    expect(exclusionsOf(list).get(B)).toBe('asleep too');
    expect(NO_EXCLUSIONS.size).toBe(0);
    expect(unknownExcludedIds(list, [A, B, 'other'])).toEqual([]);
    expect(unknownExcludedIds(list, [A])).toEqual([B]);
  });
});
