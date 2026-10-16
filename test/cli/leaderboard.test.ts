import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rebuildResults } from '../../src/cli/leaderboard.js';
import type { MatchLog } from '../../src/core/log/read.js';
import type { ResultsIndex } from '../../src/core/replay/results-index.js';
import {
  EXCLUDED_FILE,
  FEATURED_FILE,
  INDEX_FILE,
  LEADERBOARD_FILES,
  matchFile,
  summaryFiles,
} from '../../src/core/results/paths.js';
import { buildLeaderboard } from '../../src/core/stats/leaderboard.js';
import { leaderboardMarkdown, summaryMarkdown } from '../../src/core/stats/markdown.js';
import { summarizeGame } from '../../src/core/stats/summary.js';
import {
  CLUES,
  FIGHTER,
  INBOX,
  decision,
  fakeLog,
  refusal,
  toJsonl,
} from '../core/stats/helpers.js';
import { NO_EXCLUSIONS } from '../../src/core/results/excluded.js';

/** `pnpm leaderboard` against a temp results tree: summaries, leaderboard, featured, index. */

let root = '';
const GAMES = [FIGHTER, INBOX, CLUES];

const write = (log: MatchLog): string => {
  const path = join(root, matchFile(log.header.game, log.header.matchId));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, toJsonl(log));
  return log.header.matchId;
};
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8');
const writeExcluded = (matches: { id: string; reason: string }[]): void => {
  writeFileSync(join(root, EXCLUDED_FILE), JSON.stringify({ matches }));
};
const readJson = (rel: string): unknown => JSON.parse(read(rel));

const fighterBaseline = fakeLog({
  game: 'fighter',
  players: ['scripted', 'random'],
  winner: 0,
  scores: [2, 0],
});
const inboxClose = fakeLog({
  game: 'inbox',
  players: ['jev', 'openai'],
  winner: 0,
  scores: [10, 9],
  run: 1,
});
const inboxWide = fakeLog({
  game: 'inbox',
  players: ['openai', 'jev'],
  winner: 0,
  scores: [50, 0],
  run: 1,
});
const inboxInvalid = fakeLog({
  game: 'inbox',
  players: ['jev', 'openai'],
  winner: 'draw',
  scores: [3, 3],
  run: 2,
  valid: false,
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'arena-leaderboard-'));
  for (const log of [fighterBaseline, inboxClose, inboxWide, inboxInvalid]) write(log);
  // Fighter's featured match is a baseline one; it has no head-to-head to replace it.
  writeFileSync(
    join(root, FEATURED_FILE),
    JSON.stringify({ fighter: fighterBaseline.header.matchId }),
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('pnpm leaderboard (rebuildResults)', () => {
  it('writes every game’s summary.json and summary.md from the logs alone', () => {
    rebuildResults({ root, games: GAMES });
    const inbox = summarizeGame(INBOX, [inboxClose, inboxWide, inboxInvalid], NO_EXCLUSIONS);
    expect(readJson(summaryFiles('inbox').json)).toEqual(inbox);
    expect(read(summaryFiles('inbox').md)).toBe(summaryMarkdown(inbox));
    // A game with no logs still gets an (empty) summary.
    expect(readJson(summaryFiles('clues').json)).toMatchObject({
      game: 'clues',
      matches: { total: 0 },
    });
  });

  it('writes results/leaderboard.json and .md over every game, in registry order', () => {
    const out = rebuildResults({ root, games: GAMES });
    const summaries = [
      summarizeGame(FIGHTER, [fighterBaseline], NO_EXCLUSIONS),
      summarizeGame(INBOX, [inboxClose, inboxWide, inboxInvalid], NO_EXCLUSIONS),
      summarizeGame(CLUES, [], NO_EXCLUSIONS),
    ];
    const lb = buildLeaderboard(summaries);
    expect(readJson(LEADERBOARD_FILES.json)).toEqual(lb);
    expect(read(LEADERBOARD_FILES.md)).toBe(leaderboardMarkdown(lb));
    expect(out.leaderboard).toEqual(lb);
    expect(out.files).toEqual([
      summaryFiles('fighter').json,
      summaryFiles('fighter').md,
      summaryFiles('inbox').json,
      summaryFiles('inbox').md,
      summaryFiles('clues').json,
      summaryFiles('clues').md,
      LEADERBOARD_FILES.json,
      LEADERBOARD_FILES.md,
    ]);
  });

  it('features the closest head-to-head where there is one, and keeps the rest', () => {
    rebuildResults({ root, games: GAMES });
    expect(readJson(FEATURED_FILE)).toEqual({
      fighter: fighterBaseline.header.matchId,
      inbox: inboxClose.header.matchId,
    });
  });

  it('then rebuilds the index: every log, invalid ones marked, never removed', () => {
    rebuildResults({ root, games: GAMES });
    const index = readJson(INDEX_FILE) as ResultsIndex;
    expect(index.matches.map((m) => [m.id, m.valid, m.featured]).sort()).toEqual(
      [
        [fighterBaseline.header.matchId, true, true],
        [inboxClose.header.matchId, true, true],
        [inboxWide.header.matchId, true, false],
        [inboxInvalid.header.matchId, false, false],
      ].sort(),
    );
    expect(existsSync(join(root, matchFile('inbox', inboxInvalid.header.matchId)))).toBe(true);
  });

  it('is deterministic: a second run writes the same bytes', () => {
    rebuildResults({ root, games: GAMES });
    const first = [LEADERBOARD_FILES.json, LEADERBOARD_FILES.md, INDEX_FILE, FEATURED_FILE].map(
      read,
    );
    rebuildResults({ root, games: GAMES });
    expect(
      [LEADERBOARD_FILES.json, LEADERBOARD_FILES.md, INDEX_FILE, FEATURED_FILE].map(read),
    ).toEqual(first);
  });

  it('re-scores a log written invalid only because of refusals: scored, listed, valid in the index', () => {
    // As the fighter logs before 2026-10-12 recorded it: refusals as errors, match_end invalid.
    const oks = (seat: 0 | 1, n: number) =>
      Array.from({ length: n }, (_, i) => decision(seat, { sentTick: i, choice: 'jab' }));
    const refused = fakeLog({
      game: 'fighter',
      players: ['openai', 'jev'],
      winner: 0,
      scores: [2, 1],
      valid: false,
      run: 3,
      decisions: [
        ...oks(0, 90),
        ...Array.from({ length: 10 }, () => refusal(0, {}, true)),
        ...oks(1, 100),
      ],
    });
    write(refused);
    expect(read(matchFile('fighter', refused.header.matchId))).toContain(
      '"status":"error","error":"invalid answer: refusal"',
    );
    const out = rebuildResults({ root, games: GAMES });
    const fighter = out.summaries.find((s) => s.game === 'fighter');
    expect(fighter?.matches).toMatchObject({ valid: 2, invalid: 0 });
    expect(fighter?.rescored).toEqual([
      { id: refused.header.matchId, loggedValid: false, valid: true },
    ]);
    expect(fighter?.players.find((p) => p.player === 'openai')).toMatchObject({
      misses: 0,
      refusals: 10,
      refusalRate: 0.1,
    });
    expect(read(summaryFiles('fighter').md)).toContain(`- \`${refused.header.matchId}\``);
    expect(read(summaryFiles('fighter').md)).toContain('Re-scored valid');
    // It is the fighter's only head-to-head, so it is featured too.
    expect(readJson(FEATURED_FILE)).toMatchObject({ fighter: refused.header.matchId });
    const index = readJson(INDEX_FILE) as ResultsIndex;
    expect(index.matches.find((m) => m.id === refused.header.matchId)).toMatchObject({
      valid: true,
      featured: true,
    });
    // The log itself is untouched: match_end.valid stays the historical record.
    expect(read(matchFile('fighter', refused.header.matchId))).toContain('"valid":false');
  });

  it('honours results/excluded.json: invalid everywhere, listed with its reason', () => {
    const reason = 'The Mac slept mid-match (before stall detection)';
    writeExcluded([{ id: inboxClose.header.matchId, reason }]);
    const out = rebuildResults({ root, games: GAMES });
    const inbox = out.summaries.find((s) => s.game === 'inbox');
    expect(inbox?.matches).toEqual({
      total: 3,
      valid: 1,
      invalid: 2,
      excluded: 1,
      unfinished: 0,
      olderVersion: 0,
    });
    expect(inbox?.excluded).toEqual([{ id: inboxClose.header.matchId, reason }]);
    expect(inbox?.invalidMatches.map((m) => m.id)).toEqual([inboxInvalid.header.matchId]);
    // The closest head-to-head was excluded, so the other one is featured.
    expect(readJson(FEATURED_FILE)).toMatchObject({ inbox: inboxWide.header.matchId });
    const index = readJson(INDEX_FILE) as ResultsIndex;
    expect(index.matches.find((m) => m.id === inboxClose.header.matchId)).toMatchObject({
      valid: false,
      excluded: reason,
      featured: false,
    });
    expect(index.matches.find((m) => m.id === inboxWide.header.matchId)).not.toHaveProperty(
      'excluded',
    );
    expect(read(summaryFiles('inbox').md)).toContain(
      `## Excluded by hand\n\nKept but not scored: an infrastructure failure the log can’t show ` +
        `(listed in \`results/excluded.json\`).\n\n- \`${inboxClose.header.matchId}\`: ${reason}`,
    );
    const lb = readJson(LEADERBOARD_FILES.json) as { games: { id: string; excluded: unknown }[] };
    expect(lb.games.find((g) => g.id === 'inbox')?.excluded).toEqual([
      { id: inboxClose.header.matchId, reason },
    ]);
    expect(read(LEADERBOARD_FILES.md)).toContain(`- \`${inboxClose.header.matchId}\`: ${reason}`);
    // The log itself is untouched.
    expect(read(matchFile('inbox', inboxClose.header.matchId))).toContain('"valid":true');
  });

  it('refuses an excluded id that names no log, or a malformed file, writing nothing', () => {
    const typo = inboxClose.header.matchId.replace('-1', '-7');
    writeExcluded([
      { id: inboxWide.header.matchId, reason: 'asleep' },
      { id: typo, reason: 'asleep' },
    ]);
    expect(() => rebuildResults({ root, games: GAMES })).toThrow(
      `results/excluded.json: no match "${typo}" in results/*/matches/ (check the id; nothing ` +
        'was written)',
    );
    expect(existsSync(join(root, LEADERBOARD_FILES.json))).toBe(false);
    expect(existsSync(join(root, INDEX_FILE))).toBe(false);
    writeFileSync(join(root, EXCLUDED_FILE), JSON.stringify({ matches: [{ id: typo }] }));
    expect(() => rebuildResults({ root, games: GAMES })).toThrow(
      'results/excluded.json: matches[0].reason must be a non-empty string',
    );
    writeFileSync(join(root, EXCLUDED_FILE), '{');
    expect(() => rebuildResults({ root, games: GAMES })).toThrow(/^results\/excluded\.json: /);
    expect(existsSync(join(root, summaryFiles('inbox').json))).toBe(false);
  });

  it('drops a stale featured pick: a game with no valid head-to-head has no featured match', () => {
    // Fighter's pick is now invalid (its one decision failed); the game has no head-to-head.
    const broken = fakeLog({
      game: 'fighter',
      players: ['random', 'scripted'],
      winner: 1,
      scores: [0, 2],
      run: 2,
      valid: false,
    });
    write(broken);
    writeFileSync(join(root, FEATURED_FILE), JSON.stringify({ fighter: broken.header.matchId }));
    const out = rebuildResults({ root, games: GAMES });
    expect(readJson(FEATURED_FILE)).toEqual({ inbox: inboxClose.header.matchId });
    expect(out.featured).toEqual([
      { game: 'fighter', id: null, how: 'none', dropped: broken.header.matchId },
      { game: 'inbox', id: inboxClose.header.matchId, how: 'head-to-head', dropped: null },
      { game: 'clues', id: null, how: 'none', dropped: null },
    ]);
    const index = readJson(INDEX_FILE) as ResultsIndex;
    expect(index.matches.filter((m) => m.featured).map((m) => m.id)).toEqual([
      inboxClose.header.matchId,
    ]);
    // A pick naming no log at all is stale too.
    writeFileSync(join(root, FEATURED_FILE), JSON.stringify({ fighter: 'gone' }));
    rebuildResults({ root, games: GAMES });
    expect(readJson(FEATURED_FILE)).toEqual({ inbox: inboxClose.header.matchId });
  });

  it('keeps a still-valid pick, and replaces any pick once there is a head-to-head', () => {
    const out = rebuildResults({ root, games: GAMES });
    expect(out.featured[0]).toEqual({
      game: 'fighter',
      id: fighterBaseline.header.matchId,
      how: 'kept',
      dropped: null,
    });
    const h2h = fakeLog({ game: 'fighter', players: ['jev', 'openai'], winner: 0, scores: [2, 1] });
    write(h2h);
    rebuildResults({ root, games: GAMES });
    expect(readJson(FEATURED_FILE)).toMatchObject({ fighter: h2h.header.matchId });
  });

  it('checks everything before writing anything: a bad featured id or a newer log version', () => {
    // A featured id for a game outside `games` is kept as is, and checked by the index.
    writeFileSync(
      join(root, FEATURED_FILE),
      JSON.stringify({ fighter: fighterBaseline.header.matchId, counter_turns: 'no-such-match' }),
    );
    expect(() => rebuildResults({ root, games: GAMES })).toThrow(
      'pnpm leaderboard (featured): featured match "no-such-match" is not among the indexed matches',
    );
    for (const f of [summaryFiles('fighter').json, LEADERBOARD_FILES.json, INDEX_FILE]) {
      expect(existsSync(join(root, f))).toBe(false);
    }
    expect(readJson(FEATURED_FILE)).toMatchObject({ counter_turns: 'no-such-match' });

    writeFileSync(join(root, FEATURED_FILE), JSON.stringify({}));
    const future = fakeLog({
      game: 'inbox',
      players: ['jev', 'openai'],
      winner: 0,
      scores: [1, 0],
      run: 9,
      gameVersion: 2,
    });
    write(future);
    expect(() => rebuildResults({ root, games: GAMES })).toThrow(
      `${future.header.matchId}: game version 2 is newer than inbox's current version 1`,
    );
    expect(existsSync(join(root, summaryFiles('fighter').json))).toBe(false);
    expect(existsSync(join(root, INDEX_FILE))).toBe(false);
  });

  it('works on an empty tree', () => {
    const empty = mkdtempSync(join(tmpdir(), 'arena-leaderboard-empty-'));
    try {
      const out = rebuildResults({ root: empty, games: GAMES });
      expect(out.leaderboard.models).toEqual([]);
      expect(existsSync(join(empty, LEADERBOARD_FILES.json))).toBe(true);
      expect(existsSync(join(empty, INDEX_FILE))).toBe(true);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
