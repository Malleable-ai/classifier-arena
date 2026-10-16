import { gameBaselines } from '../core/classifier/baselines.js';
import { GAMES } from '../games/index.js';
import { rendererFor } from './games/index.js';
import { mountSandbox } from './games/fighter/sandbox.js';
import type { Leaderboard } from '../core/stats/leaderboard.js';
import type { GameSummary } from '../core/stats/summary.js';
import { committedLeaderboard, committedMatchIds, committedSummary } from './logs.js';
import { mountCardRenderMode } from './cards/mount.js';
import { mountRenderMode } from './render-mode.js';
import { parseRoute } from './route.js';
import { mountHistory } from './shell/history.js';
import { mountLeaderboard, mountNotFound } from './shell/leaderboard.js';

/**
 * Web entry: reads the route (route.ts) and mounts the page. `/` is the leaderboard, `/<game>` a
 * game's match history and player, `?render=1` is render mode (`/?card=<name>&render=1` a video
 * card), `/fighter?sandbox=1` the fighter's dev sandbox. `/live` (dev only, `pnpm live`) runs
 * matches through the local key proxy; `--mode web` (the replay-only Vercel build) drops it
 * entirely.
 *
 * Dev builds only: `?fixture=1` on `/`, `/<game>` or a card shows fake results from a test
 * fixture (test/fixtures/web/results-fixture.ts), to see the tables filled before any published
 * run. `import.meta.env.DEV` is false in a plain `vite build`, so the fixture never ships
 * (`pnpm render` builds in development mode on purpose, for local renders only).
 */

interface Results {
  leaderboard: Leaderboard | null;
  summary: (game: string) => GameSummary | null;
  fixture: boolean;
}

async function results(): Promise<Results> {
  const committed: Results = {
    leaderboard: committedLeaderboard(),
    summary: committedSummary,
    fixture: false,
  };
  if (!import.meta.env.DEV) return committed;
  // Also the outro card's `fixture=1` (route.ts), so the dev fixture is read in one place.
  if (new URLSearchParams(window.location.search).get('fixture') !== '1') return committed;
  const { fixtureResults } = await import('../../test/fixtures/web/results-fixture.js');
  const fx = fixtureResults();
  return {
    leaderboard: fx.leaderboard,
    summary: (game) => fx.summaries[game] ?? null,
    fixture: true,
  };
}

const root = document.getElementById('app');
if (root !== null) {
  const gameIds = GAMES.map((g) => g.id);
  const route = parseRoute(window.location.pathname, window.location.search, gameIds);
  const gameOf = (id: string) => GAMES.find((g) => g.id === id);
  // MODE is replaced at build time, so `build:web` tree-shakes the live chunk away.
  if (import.meta.env.MODE !== 'web' && route.mode === 'live') {
    void import('./live/live.js').then((m) => m.mountLive(root));
  } else if (route.mode === 'home') {
    void results().then((r) => {
      mountLeaderboard(root, {
        leaderboard: r.leaderboard,
        games: GAMES.map((g) => ({
          id: g.id,
          label: g.label,
          replays: committedMatchIds(g.id).length,
          playable: rendererFor(g.id) !== null,
        })),
        fixture: r.fixture,
      });
    });
  } else if (route.mode === 'render') {
    void mountRenderMode(root, route);
  } else if (route.mode === 'card') {
    void results().then((r) => {
      mountCardRenderMode(root, route, {
        leaderboard: r.leaderboard,
        games: GAMES.map((g) => ({ id: g.id, label: g.label })),
      });
    });
  } else if (route.mode === 'sandbox') {
    mountSandbox(root, route);
  } else if (route.mode === 'history') {
    const game = gameOf(route.game);
    if (game === undefined) mountNotFound(root, window.location.pathname);
    else {
      const baselines = gameBaselines(game);
      const matchId = route.matchId;
      void results().then((r) => {
        mountHistory(
          root,
          {
            id: game.id,
            label: game.label,
            cadence: game.cadence,
            baselines: baselines.map((b) => b.id),
            baselineLabels: Object.fromEntries(baselines.map((b) => [b.id, b.label])),
            gameIds,
          },
          matchId,
          r.summary(game.id),
        );
      });
    }
  } else {
    mountNotFound(root, window.location.pathname);
  }
}
