import { describe, expect, it } from 'vitest';
import { gameIds } from '../../../../src/games/index.js';
import { inboxGame } from '../../../../src/games/inbox/game.js';
import { committedMatchIds, loadCommittedLog, resultsIndex } from '../../../../src/web/logs.js';
import { gamePath, parseRoute } from '../../../../src/web/route.js';
import {
  buildMatchList,
  defaultMatchId,
  formatDuration,
  resultText,
  withLog,
  type HistoryGame,
} from '../../../../src/web/shell/history.js';
import { NO_EXCLUSIONS } from '../../../../src/core/results/excluded.js';

/** `/inbox`: the route, the committed logs and the history list, as main.ts wires them. */

const INBOX: HistoryGame = {
  id: inboxGame.id,
  label: inboxGame.label,
  cadence: inboxGame.cadence,
  baselines: ['random', ...inboxGame.baselines],
  baselineLabels: { random: 'Random (uniform)', ...inboxGame.baselineLabels },
  gameIds: gameIds(),
};
const ids = committedMatchIds('inbox');

describe('/inbox pages', () => {
  it('routes /inbox to its history, a replay and render mode', () => {
    const [id] = ids;
    if (id === undefined) throw new Error('no inbox logs');
    expect(parseRoute('/inbox', '', gameIds())).toEqual({
      mode: 'history',
      game: 'inbox',
      matchId: null,
    });
    expect(parseRoute('/inbox', `?match=${id}`, gameIds())).toEqual({
      mode: 'history',
      game: 'inbox',
      matchId: id,
    });
    expect(parseRoute('/inbox', `?match=${id}&render=1`, gameIds())).toEqual({
      mode: 'render',
      game: 'inbox',
      matchId: id,
    });
    expect(gamePath('inbox', id)).toBe(`/inbox?match=${id}`);
    // No sandbox for the inbox: ?sandbox=1 is the plain history.
    expect(parseRoute('/inbox', '?sandbox=1', gameIds())).toMatchObject({ mode: 'history' });
  });

  it('lists the committed logs from the index: players, winner, scores, duration, valid', () => {
    expect(ids.length).toBeGreaterThanOrEqual(3);
    const index = resultsIndex();
    const rows = buildMatchList(INBOX, ids, index, NO_EXCLUSIONS);
    expect(rows.map((r) => r.id).sort()).toEqual(ids);
    const known = new Set(['jev', 'openai', 'random', 'scripted']);
    const providers = new Set(['jev', 'openai']);
    for (const r of rows) {
      const entry = index?.matches.find((m) => m.id === r.id);
      expect(r.local).toBe(false);
      expect(r.loaded).toBe(true);
      // The index re-scores validity (and applies results/excluded.json); the list follows it.
      expect(r.valid).toBe(entry?.valid);
      expect(r.players.every((p) => known.has(p))).toBe(true);
      expect(r.headToHead).toBe(r.players.every((p) => providers.has(p)));
      expect(resultText(r)).toMatch(/wins|Draw/);
      expect(formatDuration(r.totalTicks ?? 0, r.cadence)).toMatch(/^\d+:\d\d$/);
    }
    expect(defaultMatchId(rows)).toBe(rows[0]?.id);
  });

  it("agrees with each log's own header and match_end", async () => {
    const rows = buildMatchList(INBOX, ids, resultsIndex(), NO_EXCLUSIONS);
    for (const r of rows) {
      const log = await loadCommittedLog('inbox', r.id);
      const fromLog = withLog(r, log, INBOX.baselines, NO_EXCLUSIONS);
      expect(fromLog.winner).toBe(r.winner);
      expect(fromLog.scores).toEqual(r.scores);
      expect(fromLog.totalTicks).toBe(r.totalTicks);
      expect(fromLog.labels).toEqual(r.labels);
    }
  });
});
