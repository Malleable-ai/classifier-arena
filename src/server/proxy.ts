import { execSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { UNSPECIFIED_LOCATION, runIdFor, runLocationFor } from '../cli/run-id.js';
import {
  createPlayer,
  gameBaselines,
  listPlayers,
  type BaselineInfo,
} from '../core/classifier/players.js';
import { loadProviders, type Env, type ProviderEntry } from '../core/classifier/providers.js';
import type { EstimateResponse, PlayersResponse } from '../core/classifier/remote.js';
import type { Decider, DecisionResult, Question, Seat } from '../core/classifier/types.js';
import { APPROVAL_LIMIT_USD, estimateMatch, pricedSeats } from '../core/estimate.js';
import { validateQuestion, type Game, type JsonObject } from '../core/game.js';
import { readLogLine } from '../core/log/read.js';
import { writeSnapshot } from '../core/log/writer.js';
import { matchFile, parseMatchId, statesDir } from '../core/results/paths.js';
import { WARMUP_TIMEOUT_MS, playerMeta } from '../core/sched/shared.js';
import { realClock } from '../core/util/clock.js';
import { GAMES } from '../games/index.js';

/**
 * Live mode's local proxy (`pnpm live`). It holds the API keys (from `.env`, loaded at runtime)
 * and runs provider deciders server-side, so the browser never sees a key. Loopback only, and only
 * the allowed origins (ARENA_ORIGINS, default the Vite dev server) may call it. It knows no game:
 * games come from the registry (src/games), and state and questions pass through untouched.
 *
 *   GET  /players[?game=]       providers (ids, labels, header metadata, whether keys are set, never
 *                               keys); with a game, also its baselines (`random` + its own)
 *   GET  /estimate?game=&a=&b=  cost estimate for a pairing from that game's estimate
 *   POST /decide/:player        { game, state, question, snapshot? } → DecisionResult without `raw`
 *   POST /log/:matchId          v2 JSONL lines appended to results/<game>/matches/<matchId>.jsonl
 *                               (only to logs whose header this process accepted)
 */

export const PROXY_HOST = '127.0.0.1';
export const PROXY_PORT = 8787;
/** The Vite dev server, when ARENA_ORIGINS is unset. */
export const DEFAULT_ORIGINS: readonly string[] = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
];
const MAX_BODY_BYTES = 1_000_000;
const MAX_MATCH_ID_LENGTH = 120;
/**
 * Any match id: lowercase segments of letters, digits and `_`, at least three, joined by `-`. No
 * dots or slashes, so no traversal. The CLI's `<yyyymmdd>-<hhmmss>-<game>-<a>-vs-<b>-<n>` fits.
 */
export const MATCH_ID_RE = /^[a-z0-9_]+(?:-[a-z0-9_]+){2,}$/;
const LINE_TYPES = new Set(['header', 'decision', 'event', 'match_end']);

export interface ProxyOptions {
  env: Env;
  providers: readonly ProviderEntry[];
  /** The games served. Default the registry (src/games); tests pass the counter games. */
  games?: readonly Game[];
  /** What `results/…` paths resolve against. Default the working directory (the repo root). */
  rootDir?: string;
  fetchImpl?: typeof fetch;
  /** Tests inject fake providers here (no network). */
  makeDecider?: (player: string) => Decider;
  gitCommit?: string;
  /** Default `unspecified`; `main` reads RUN_LOCATION. */
  runLocation?: string;
  /** Default this machine's run id (src/cli/run-id.ts). */
  runId?: string;
  /** Browser origins allowed to call. Default DEFAULT_ORIGINS; `main` reads ARENA_ORIGINS. */
  allowedOrigins?: readonly string[];
  /** Hosts the Host header may name (DNS-rebinding guard). Default the proxy's own address. */
  allowedHosts?: readonly string[];
  log?: (line: string) => void;
}

/**
 * ARENA_ORIGINS: comma-separated origins (`http://localhost:5173,http://127.0.0.1:5173`). Unset or
 * blank means DEFAULT_ORIGINS. Throws on anything that is not a bare origin (no `*`, no path).
 */
export function parseOrigins(value: string | undefined): readonly string[] {
  if (value === undefined || value.trim() === '') return DEFAULT_ORIGINS;
  const origins = value
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o !== '');
  if (origins.length === 0) throw new Error('ARENA_ORIGINS lists no origins');
  for (const o of origins) {
    let origin: string | null = null;
    try {
      origin = new URL(o).origin;
    } catch {
      // Not a URL.
    }
    if (origin !== o) {
      throw new Error(
        `ARENA_ORIGINS: ${JSON.stringify(o)} is not an origin (scheme://host[:port])`,
      );
    }
  }
  return origins;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

async function readBody(req: IncomingMessage): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** A match id that is safe in a path and names `game` (`parseMatchId`). */
function isMatchIdOf(id: unknown, game: string): id is string {
  return (
    typeof id === 'string' &&
    id.length <= MAX_MATCH_ID_LENGTH &&
    MATCH_ID_RE.test(id) &&
    parseMatchId(id, [game]) !== null
  );
}

/** The untrusted question's shape, then `validateQuestion` (names, ids, at least 2 options). */
function checkQuestion(q: unknown): Question {
  if (
    !isRecord(q) ||
    typeof q.name !== 'string' ||
    typeof q.instructions !== 'string' ||
    !Array.isArray(q.options) ||
    !q.options.every(
      (o) => isRecord(o) && typeof o.id === 'string' && typeof o.description === 'string',
    )
  ) {
    throw new HttpError(
      400,
      'question needs name, instructions and options of { id, description }',
    );
  }
  const question = q as unknown as Question;
  try {
    validateQuestion(question);
  } catch (err) {
    throw new HttpError(400, err instanceof Error ? err.message : 'invalid question');
  }
  return question;
}

interface ParsedDecide {
  game: string;
  /** What every game's `view` returns: a JSON object. */
  state: JsonObject;
  question: Question;
  snapshot: { matchId: string; seat: Seat; seq: number } | null;
}

/** `{ game, state, question, snapshot? }`; `state` and `question` are passed on as parsed. */
function parseDecideBody(text: string, games: readonly Game[]): ParsedDecide {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'body is not JSON');
  }
  if (!isRecord(body)) throw new HttpError(400, 'body needs { game, state, question }');
  const { game, state } = body;
  if (typeof game !== 'string' || !games.some((g) => g.id === game)) {
    throw new HttpError(400, `unknown game ${JSON.stringify(game ?? null)}`);
  }
  if (!isRecord(state)) throw new HttpError(400, 'state must be a JSON object');
  const question = checkQuestion(body.question);
  return { game, state, question, snapshot: snapshotTarget(body.snapshot, game) };
}

/** The body is untrusted JSON: check the snapshot target before it names a path. */
function snapshotTarget(
  s: unknown,
  game: string,
): { matchId: string; seat: Seat; seq: number } | null {
  if (!isRecord(s)) return null;
  const { matchId, seat, seq } = s;
  if (
    isMatchIdOf(matchId, game) &&
    (seat === 0 || seat === 1) &&
    typeof seq === 'number' &&
    Number.isInteger(seq) &&
    seq >= 0 &&
    seq < 1_000_000
  ) {
    return { matchId, seat, seq };
  }
  return null;
}

interface ParsedLines {
  /** Each line re-serialized (one JSON object per line), as sent. */
  lines: string[];
  /** The header's game when the first line is a header. */
  headerGame: string | null;
  /** The chunk ends with a match_end. */
  ends: boolean;
}

/**
 * Every line must be a valid v2 line (core's reader); a header only first and naming this match
 * and a registered game; nothing after a match_end. Nothing is written unless all pass.
 */
function parseLogLines(text: string, matchId: string, games: readonly Game[]): ParsedLines {
  const raw = text.split('\n').filter((l) => l.trim() !== '');
  if (raw.length === 0) throw new HttpError(400, 'no lines');
  let headerGame: string | null = null;
  let ends = false;
  const lines = raw.map((l, i) => {
    const n = String(i + 1);
    let obj: unknown;
    try {
      obj = JSON.parse(l);
    } catch {
      throw new HttpError(400, `line ${n} is not JSON`);
    }
    if (!isRecord(obj) || typeof obj.type !== 'string' || !LINE_TYPES.has(obj.type)) {
      throw new HttpError(400, `line ${n} is not a v2 log line`);
    }
    if (ends) throw new HttpError(400, `line ${n} comes after match_end`);
    try {
      readLogLine(obj);
    } catch (err) {
      throw new HttpError(400, `line ${n}: ${err instanceof Error ? err.message : 'invalid'}`);
    }
    if (obj.type === 'header') {
      if (i !== 0 || obj.matchId !== matchId) {
        throw new HttpError(400, 'a header must come first and name this match');
      }
      const game = obj.game as string;
      if (!games.some((g) => g.id === game)) {
        throw new HttpError(400, `unknown game ${JSON.stringify(game)}`);
      }
      if (!isMatchIdOf(matchId, game)) {
        throw new HttpError(
          400,
          `match id does not name the header's game ${JSON.stringify(game)}`,
        );
      }
      headerGame = game;
    }
    if (obj.type === 'match_end') ends = true;
    return JSON.stringify(obj);
  });
  return { lines, headerGame, ends };
}

/** The request handler, separate from `listen` so tests can drive it on an ephemeral port. */
export function createProxyHandler(opts: ProxyOptions) {
  const games = opts.games ?? GAMES;
  const rootDir = opts.rootDir ?? '.';
  const origins = opts.allowedOrigins ?? DEFAULT_ORIGINS;
  const hosts = opts.allowedHosts ?? [
    `${PROXY_HOST}:${String(PROXY_PORT)}`,
    `localhost:${String(PROXY_PORT)}`,
  ];
  const say = opts.log ?? (() => undefined);
  const deciders = new Map<string, Decider>();
  /** Logs this process created (header accepted here), by match id. Only these may be appended to. */
  const created = new Map<string, { game: string; ended: boolean }>();
  const isProvider = (id: string): boolean => opts.providers.some((p) => p.id === id);

  /** `?game=`: a registered game, or null when absent. */
  const gameParam = (url: URL): Game | null => {
    const id = url.searchParams.get('game');
    if (id === null) return null;
    const game = games.find((g) => g.id === id);
    if (!game) throw new HttpError(400, `unknown game ${JSON.stringify(id)}`);
    return game;
  };

  /** `random` from core plus the game's own. */
  const baselinesOf = (game: Game): BaselineInfo[] => gameBaselines(game);

  const deciderFor = (player: string): Decider => {
    let d = deciders.get(player);
    if (!d) {
      d = opts.makeDecider
        ? opts.makeDecider(player)
        : createPlayer(player, {
            env: opts.env,
            clock: realClock,
            providers: opts.providers,
            timeoutMs: WARMUP_TIMEOUT_MS,
            ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
          });
      deciders.set(player, d);
    }
    return d;
  };

  const runId = opts.runId ?? runIdFor(false);
  const players = (url: URL): PlayersResponse => {
    const game = gameParam(url);
    const baselines = game ? baselinesOf(game) : [];
    return {
      players: listPlayers(opts.env, opts.providers, baselines).map((p) => ({
        ...p,
        meta: playerMeta(p.id, opts.providers, baselines),
      })),
      gitCommit: opts.gitCommit ?? 'unknown',
      runLocation: opts.runLocation ?? UNSPECIFIED_LOCATION,
      runId,
    };
  };

  const estimate = (url: URL): EstimateResponse => {
    const game = gameParam(url);
    if (!game) throw new HttpError(400, 'estimate needs ?game=<id>');
    const baselines = baselinesOf(game);
    const ids = [url.searchParams.get('a') ?? '', url.searchParams.get('b') ?? ''];
    for (const id of ids) {
      if (!isProvider(id) && !baselines.some((b) => b.id === id)) {
        throw new HttpError(400, `unknown player ${JSON.stringify(id)} for ${game.id}`);
      }
    }
    const est = estimateMatch(game.estimate, pricedSeats(ids, opts.providers));
    return {
      totalUsd: est.totalUsd,
      typicalUsd: est.typicalUsd,
      limitUsd: APPROVAL_LIMIT_USD,
      text: est.text,
    };
  };

  const decide = async (
    player: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<Omit<DecisionResult, 'raw'>> => {
    if (!isProvider(player)) {
      throw new HttpError(400, `"${player}" is not a provider (baselines run in the browser)`);
    }
    const info = listPlayers(opts.env, opts.providers, []).find((p) => p.id === player);
    if (!info?.available) throw new HttpError(400, `"${player}" has no keys set`);
    const body = parseDecideBody(await readBody(req), games);
    // The browser hung up (its 1 s timeout): stop the provider call too.
    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) abort.abort(new Error('client closed'));
    });
    const result = await deciderFor(player).decide(body.state, body.question, abort.signal);
    const target = body.snapshot;
    if (result.raw && target) {
      writeSnapshot(
        join(rootDir, statesDir(body.game, target.matchId)),
        target.seat,
        target.seq,
        result.raw,
      );
    }
    const rest: Omit<DecisionResult, 'raw'> & { raw?: unknown } = { ...result };
    delete rest.raw;
    return rest;
  };

  const appendLog = async (matchId: string, req: IncomingMessage): Promise<{ lines: number }> => {
    if (!MATCH_ID_RE.test(matchId) || matchId.length > MAX_MATCH_ID_LENGTH) {
      throw new HttpError(400, 'bad match id');
    }
    const { lines, headerGame, ends } = parseLogLines(await readBody(req), matchId, games);
    let path: string;
    if (headerGame !== null) {
      path = join(rootDir, matchFile(headerGame, matchId));
      if (created.has(matchId) || existsSync(path)) {
        throw new HttpError(409, 'match log already exists');
      }
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, '', { flag: 'wx' });
      created.set(matchId, { game: headerGame, ended: false });
    } else {
      const mine = created.get(matchId);
      if (!mine) {
        // Never touch a log this process didn't start: a CLI log, or one from an earlier proxy run.
        const game = parseMatchId(
          matchId,
          games.map((g) => g.id),
        )?.game;
        if (game !== undefined && existsSync(join(rootDir, matchFile(game, matchId)))) {
          throw new HttpError(409, 'match log was not started by this proxy');
        }
        throw new HttpError(404, 'no such match log (send the header first)');
      }
      if (mine.ended) throw new HttpError(409, 'match log already has its match_end');
      path = join(rootDir, matchFile(mine.game, matchId));
    }
    appendFileSync(path, lines.join('\n') + '\n');
    if (ends) {
      const mine = created.get(matchId);
      if (mine) mine.ended = true;
    }
    return { lines: lines.length };
  };

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const origin = req.headers.origin;
    const send = (status: number, body: unknown): void => {
      if (res.headersSent) return;
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        vary: 'Origin',
      };
      if (origin !== undefined && origins.includes(origin)) {
        headers['access-control-allow-origin'] = origin;
      }
      res.writeHead(status, headers);
      res.end(JSON.stringify(body));
    };
    const started = performance.now();
    const url = new URL(req.url ?? '/', `http://${PROXY_HOST}`);
    try {
      if (!hosts.includes(req.headers.host ?? '')) throw new HttpError(403, 'bad host');
      if (origin !== undefined && !origins.includes(origin)) {
        throw new HttpError(403, 'origin not allowed');
      }
      if (req.method === 'OPTIONS') {
        if (origin === undefined) throw new HttpError(403, 'origin required');
        res.writeHead(204, {
          'access-control-allow-origin': origin,
          'access-control-allow-methods': 'GET, POST',
          'access-control-allow-headers': 'content-type',
          'access-control-max-age': '600',
          vary: 'Origin',
        });
        res.end();
        return;
      }
      // Writes and paid calls only from the Vite page (a browser always sends Origin on these).
      if (req.method === 'POST' && origin === undefined)
        throw new HttpError(403, 'origin required');
      const parts = url.pathname.split('/').filter(Boolean);
      if (req.method === 'GET' && url.pathname === '/players') send(200, players(url));
      else if (req.method === 'GET' && url.pathname === '/estimate') send(200, estimate(url));
      else if (req.method === 'POST' && parts[0] === 'decide' && parts.length === 2) {
        send(200, await decide(decodeURIComponent(parts[1] ?? ''), req, res));
      } else if (req.method === 'POST' && parts[0] === 'log' && parts.length === 2) {
        send(200, await appendLog(decodeURIComponent(parts[1] ?? ''), req));
      } else throw new HttpError(404, 'not found');
      say(`${req.method} ${url.pathname} 200 ${(performance.now() - started).toFixed(0)} ms`);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      // Messages are ours (or a decider's, which never carries keys); no stack, no headers.
      const message = err instanceof Error ? err.message : 'error';
      say(`${req.method ?? '?'} ${url.pathname} ${String(status)} ${message}`);
      send(status, { error: message });
    }
  };
}

export function createProxyServer(opts: ProxyOptions): Server {
  const handler = createProxyHandler(opts);
  return createServer((req, res) => {
    void handler(req, res);
  });
}

function gitCommit(): string {
  try {
    return execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return 'unknown';
  }
}

async function main(): Promise<void> {
  try {
    process.loadEnvFile();
  } catch {
    // No .env: baselines and human still work.
  }
  const providers = await loadProviders();
  const allowedOrigins = parseOrigins(process.env.ARENA_ORIGINS);
  const server = createProxyServer({
    env: process.env,
    providers,
    allowedOrigins,
    gitCommit: gitCommit(),
    runLocation: runLocationFor(process.env, false),
    runId: runIdFor(false),
    log: (line) => {
      console.log(line);
    },
  });
  server.listen(PROXY_PORT, PROXY_HOST, () => {
    const ready = listPlayers(process.env, providers)
      .filter((p) => p.kind === 'provider')
      .map((p) => `${p.id} ${p.available ? 'ready' : 'no keys'}`)
      .join(', ');
    console.log(`live proxy on http://${PROXY_HOST}:${String(PROXY_PORT)} (${ready})`);
    console.log(`allowed origins: ${allowedOrigins.join(', ')}`);
    console.log('open http://localhost:5173/live');
  });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
