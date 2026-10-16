import { parseRenderSize, WIDE, type RenderSize } from './shell/render-layout.js';

/**
 * Route parsing (docs/architecture/core.md, "Routes"). Pure: the caller passes `location.pathname`,
 * `location.search` and the registered game ids.
 *
 * - `/`                                   home: the games, each linking to its page
 * - `/<game>`                             that game's match history
 * - `/<game>?match=<id>`                  the history with that replay playing
 * - `/<game>?match=<id>&render=1`         render mode: one log drawn frame by frame (tests, video);
 *                                         `size=<W>x<H>` draws it in a video layout of exactly that
 *                                         many pixels; `log=<url>` (dev builds only, for `pnpm
 *                                         render` of a log outside results/) fetches the log there
 * - `/?card=<name>&render=1`              render mode for a video card (src/web/cards): `size`,
 *                                         and `fixture=1` (dev builds only) for fake results
 * - `/live`                               live mode (dev builds only; main.ts drops it from `--mode web`)
 * - `/fighter?sandbox=1`                  the fighter's dev sandbox: `p1=random` (random vs random,
 *                                         no keyboard), `seed=<u32>`
 * - anything else                         not found
 */

export type PlayerKind = 'human' | 'random';

export interface HomeRoute {
  mode: 'home';
}

export interface HistoryRoute {
  mode: 'history';
  game: string;
  /** The match to pick and play, or null for the page's default. */
  matchId: string | null;
}

export interface RenderRoute {
  mode: 'render';
  game: string;
  matchId: string;
  /** A video size (`size=1080x1080`); absent: the viewer's tall layout. */
  size?: RenderSize;
  /** `log=<url>`: where to fetch the log instead of the committed ones (main.ts: dev builds only). */
  log?: string;
}

export interface CardRoute {
  mode: 'card';
  card: string;
  /** Default: 1920 × 1080. */
  size: RenderSize;
  /** `fixture=1`: fake results (main.ts: dev builds only). */
  fixture: boolean;
}

export interface LiveRoute {
  mode: 'live';
}

export interface SandboxRoute {
  mode: 'sandbox';
  game: string;
  p1: PlayerKind;
  seed: number;
}

export interface NotFoundRoute {
  mode: 'not-found';
}

export type Route =
  HomeRoute | HistoryRoute | RenderRoute | CardRoute | LiveRoute | SandboxRoute | NotFoundRoute;

export const DEFAULT_SEED = 1;
/** Games with a dev sandbox. */
export const SANDBOX_GAMES: readonly string[] = ['fighter'];

/** The URL of a game's page, or of one replay on it. */
export function gamePath(game: string, matchId?: string | null): string {
  const base = `/${encodeURIComponent(game)}`;
  return matchId === undefined || matchId === null
    ? base
    : `${base}?match=${encodeURIComponent(matchId)}`;
}

export function parseRoute(pathname: string, search: string, gameIds: readonly string[]): Route {
  // One trailing slash is fine (`/fighter/`); the path is otherwise taken as is.
  const path = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  const params = new URLSearchParams(search);
  if (path === '' || path === '/') {
    const card = params.get('card')?.trim() ?? '';
    if (card === '' || params.get('render') !== '1') return { mode: 'home' };
    return {
      mode: 'card',
      card,
      size: parseRenderSize(params.get('size') ?? '') ?? { ...WIDE },
      fixture: params.get('fixture') === '1',
    };
  }
  if (path === '/live') return { mode: 'live' };
  const game = path.slice(1);
  if (!gameIds.includes(game)) return { mode: 'not-found' };

  if (params.get('sandbox') === '1' && SANDBOX_GAMES.includes(game)) {
    const p1: PlayerKind = params.get('p1') === 'random' ? 'random' : 'human';
    const raw = params.get('seed');
    const n = raw === null || raw.trim() === '' ? NaN : Number(raw);
    const seed = Number.isInteger(n) && n >= 0 && n <= 0xffffffff ? n : DEFAULT_SEED;
    return { mode: 'sandbox', game, p1, seed };
  }
  const matchId = params.get('match')?.trim() ?? '';
  if (matchId === '') return { mode: 'history', game, matchId: null };
  if (params.get('render') === '1') {
    const route: RenderRoute = { mode: 'render', game, matchId };
    const size = parseRenderSize(params.get('size') ?? '');
    if (size !== null) route.size = size;
    const log = params.get('log')?.trim() ?? '';
    if (log !== '') route.log = log;
    return route;
  }
  return { mode: 'history', game, matchId };
}
