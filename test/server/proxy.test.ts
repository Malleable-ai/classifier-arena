import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { orderOptions } from '../../src/core/classifier/order.js';
import { PROVIDERS } from '../../src/core/classifier/providers.js';
import { machineRunId } from '../../src/cli/run-id.js';
import type { EstimateResponse, PlayersResponse } from '../../src/core/classifier/remote.js';
import type { Decider, Question } from '../../src/core/classifier/types.js';
import { estimateMatch, pricedSeats } from '../../src/core/estimate.js';
import type { Game } from '../../src/core/game.js';
import { parseMatchLog } from '../../src/core/log/read.js';
import type { LogLine } from '../../src/core/log/schema.js';
import { matchFile, matchIdFor, statesDir } from '../../src/core/results/paths.js';
import {
  DEFAULT_ORIGINS,
  MATCH_ID_RE,
  createProxyHandler,
  parseOrigins,
} from '../../src/server/proxy.js';
import { counterRealtime } from '../core/games/counter-realtime.js';
import { counterTurns } from '../core/games/counter-turns.js';
import { realtimeLines, toJsonl } from '../core/log/fixtures.js';

/**
 * The proxy against the test-only counter games, injected as its registry (src/games registers
 * neither). Providers are faked: no network, and the one key is a sentinel that must never leak.
 */

const SECRET = 'sk-test-SECRET-do-not-leak';
const ORIGIN = 'http://localhost:5173';
const GAMES: readonly Game[] = [counterRealtime, counterTurns];
const GAME = counterRealtime.id;

const idFor = (a: string, b: string, run: number, game = GAME): string =>
  matchIdFor({ game, a, b, when: '2026-10-07T12:00:00', run });
const MATCH = idFor('openai', 'random', 1);

let server: Server;
let port = 0;
let dir = '';
const seen: { state: unknown; question: Question; signal: AbortSignal }[] = [];

/** A provider decider that never touches the network. A state with `hang` waits for the abort. */
function fakeDecider(player: string): Decider {
  return {
    player,
    decide(state, question, signal) {
      seen.push({ state, question, signal });
      if ((state as { hang?: boolean }).hang === true) {
        return new Promise((resolve) => {
          signal.addEventListener('abort', () => {
            resolve({
              choice: null,
              probabilities: null,
              confidence: null,
              latencyMs: 1,
              inputTokens: null,
              costUsd: 0,
              status: 'timeout',
            });
          });
        });
      }
      return Promise.resolve({
        choice: question.options[0]?.id ?? null,
        probabilities: { up: 0.9, down: 0.1 },
        confidence: 0.9,
        latencyMs: 12,
        inputTokens: 120,
        costUsd: 0.000012,
        status: 'ok',
        raw: {
          request: { url: 'https://example.test', body: { q: question.name } },
          response: { ok: true },
        },
      });
    },
  };
}

type Handler = ReturnType<typeof createProxyHandler>;

const handlerFor = (p: number, extra: Partial<Parameters<typeof createProxyHandler>[0]> = {}) =>
  createProxyHandler({
    env: { OPENAI_API_KEY: SECRET },
    providers: PROVIDERS,
    games: GAMES,
    rootDir: dir,
    makeDecider: fakeDecider,
    allowedHosts: [`127.0.0.1:${String(p)}`],
    ...extra,
  });

/** Serve `make(port)` on an ephemeral port. */
async function serve(make: (port: number) => Handler): Promise<{ server: Server; port: number }> {
  let handler: Handler | null = null;
  const s = createServer((req, res) => void handler?.(req, res));
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const p = (s.address() as AddressInfo).port;
  handler = make(p);
  return { server: s, port: p };
}

interface Res {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
}

function call(
  method: string,
  path: string,
  opts: { body?: string; origin?: string | null; host?: string; port?: number } = {},
): Promise<Res> {
  const p = opts.port ?? port;
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: opts.host ?? `127.0.0.1:${String(p)}` };
    const origin = opts.origin === undefined ? ORIGIN : opts.origin;
    if (origin !== null) headers.origin = origin;
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    const req = request({ host: '127.0.0.1', port: p, method, path, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (text += c));
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text });
      });
    });
    req.on('error', reject);
    req.end(opts.body);
  });
}

const errorOf = (res: Res): string => (JSON.parse(res.text) as { error: string }).error;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'arena-proxy-'));
  ({ server, port } = await serve((p) => handlerFor(p)));
});

afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('GET /players', () => {
  it('lists providers with availability but never key values', async () => {
    const res = await call('GET', '/players');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain(SECRET);
    const body = JSON.parse(res.text) as PlayersResponse;
    const byId = Object.fromEntries(body.players.map((p) => [p.id, p]));
    expect(byId.openai?.available).toBe(true);
    expect(byId.jev?.available).toBe(false);
    expect(byId.jev?.missingEnv).toEqual(['TYPESAFE_API_KEY']);
    expect(byId.openai?.meta).toMatchObject({ kind: 'provider', player: 'openai' });
    // No game named: providers only.
    expect(body.players.every((p) => p.kind === 'provider')).toBe(true);
    expect(res.headers['access-control-allow-origin']).toBe(ORIGIN);
  });

  it("reports the run id and location for live logs: this machine's id and unspecified by default", async () => {
    const body = JSON.parse((await call('GET', '/players')).text) as PlayersResponse;
    expect(body).toMatchObject({ runId: machineRunId(), runLocation: 'unspecified' });
    const other = await serve((p) =>
      handlerFor(p, { runId: 'm-0123456789ab', runLocation: 'nyc-home' }),
    );
    try {
      const res = await call('GET', '/players', { port: other.port });
      expect(JSON.parse(res.text)).toMatchObject({
        runId: 'm-0123456789ab',
        runLocation: 'nyc-home',
      });
    } finally {
      other.server.close();
    }
  });

  it("adds a game's baselines (random plus its own) when a game is named", async () => {
    const rt = JSON.parse((await call('GET', `/players?game=${GAME}`)).text) as PlayersResponse;
    const baselines = rt.players.filter((p) => p.kind === 'baseline');
    expect(baselines.map((p) => p.id)).toEqual(['random', 'parity']);
    expect(baselines.every((p) => p.available && p.meta.kind === 'baseline')).toBe(true);
    // Labels come from the game (`baselineLabels`), the same in the list and the header meta.
    expect(baselines.map((p) => [p.label, p.meta.label])).toEqual([
      ['Random (uniform)', 'Random (uniform)'],
      ['Parity bot', 'Parity bot'],
    ]);
    expect(baselines[1]?.meta).toMatchObject({ player: 'parity', format: null, price: null });
    expect(rt.players.filter((p) => p.kind === 'provider').map((p) => p.id)).toEqual(
      PROVIDERS.map((p) => p.id),
    );
    const turns = JSON.parse(
      (await call('GET', `/players?game=${counterTurns.id}`)).text,
    ) as PlayersResponse;
    expect(turns.players.filter((p) => p.kind === 'baseline').map((p) => p.id)).toEqual(['random']);
    expect((await call('GET', '/players?game=chess')).status).toBe(400);
  });
});

describe('POST /decide/:player', () => {
  const seed = 42;
  const state0 = counterRealtime.create(seed, counterRealtime.defaultConfig);
  const asked = counterRealtime.question(state0, 1);
  if (!asked) throw new Error('no question');
  const question = orderOptions(asked.question, seed, asked.key);
  /** The seat's view plus fields that would change if anything re-encoded or reordered them. */
  const state = {
    ...(counterRealtime.view(state0, 1) as object),
    extra: { z: 1, a: [3, 1, 2], s: 'é ☃ "q" \\', n: -5e-8, deep: { y: null, x: true } },
  };
  const stateText = JSON.stringify(state);
  const questionText = JSON.stringify(question);
  const decideBody = (fields: Record<string, unknown>): string =>
    JSON.stringify({ game: GAME, state, question, ...fields });

  it('forwards state and question byte for byte, strips raw and writes the snapshot', async () => {
    seen.length = 0;
    const snapshot = JSON.stringify({ matchId: MATCH, seat: 1, seq: 3 });
    const body = `{"game":"${GAME}","state":${stateText},"question":${questionText},"snapshot":${snapshot}}`;
    const res = await call('POST', '/decide/openai', { body });
    expect(res.status).toBe(200);
    const result = JSON.parse(res.text) as Record<string, unknown>;
    expect(result.raw).toBeUndefined();
    expect(result.choice).toBe(question.options[0]?.id);
    expect(JSON.stringify(seen[0]?.state)).toBe(stateText);
    expect(JSON.stringify(seen[0]?.question)).toBe(questionText);
    expect(res.text).not.toContain(SECRET);
    // The full request/response lands in results/states/<game>/<matchId>/<seat>-<seq>.json.
    const snap = join(dir, statesDir(GAME, MATCH), '1-3.json');
    expect(existsSync(snap)).toBe(true);
    expect(JSON.parse(readFileSync(snap, 'utf8'))).toMatchObject({ response: { ok: true } });
  });

  it('refuses an unknown or missing game', async () => {
    for (const game of ['chess', '', 7, null, undefined, 'fighter']) {
      const res = await call('POST', '/decide/openai', { body: decideBody({ game }) });
      expect(res.status).toBe(400);
      expect(errorOf(res)).toMatch(/game/);
    }
    // A game the registry has but this test didn't pick still works (counter_turns).
    const turns = counterTurns.create(1, counterTurns.defaultConfig);
    const q = counterTurns.question(turns, 0)?.question;
    const ok = await call('POST', '/decide/openai', {
      body: JSON.stringify({
        game: counterTurns.id,
        state: counterTurns.view(turns, 0),
        question: q,
      }),
    });
    expect(ok.status).toBe(200);
  });

  it('refuses a state that is not a JSON object, and the old `view` alias', async () => {
    for (const s of [[1, 2], 'state', 3, null]) {
      expect(
        (await call('POST', '/decide/openai', { body: decideBody({ state: s }) })).status,
      ).toBe(400);
    }
    const old = JSON.stringify({ game: GAME, view: state, question });
    const res = await call('POST', '/decide/openai', { body: old });
    expect(res.status).toBe(400);
    expect(errorOf(res)).toMatch(/state/);
  });

  it('refuses an invalid question (validateQuestion)', async () => {
    const opts = question.options;
    const bad: unknown[] = [
      undefined,
      'next_move',
      { ...question, name: 'Next Move' },
      { ...question, instructions: 7 },
      { ...question, options: 'up,down' },
      { ...question, options: opts.slice(0, 1) },
      { ...question, options: [opts[0], opts[0]] },
      { ...question, options: [{ id: '1up', description: 'x' }, opts[1]] },
      { ...question, options: [{ id: 'up', description: '  ' }, opts[1]] },
      { ...question, options: [{ id: 'up', description: 5 }, opts[1]] },
      { ...question, options: [null, opts[1]] },
    ];
    seen.length = 0;
    for (const q of bad) {
      const res = await call('POST', '/decide/openai', { body: decideBody({ question: q }) });
      expect(res.status).toBe(400);
      expect(errorOf(res)).toMatch(/question/);
    }
    expect(seen).toHaveLength(0);
  });

  it('ignores a snapshot target that is unsafe, malformed or uses the old `fighter` field', async () => {
    const targets = [
      { matchId: '../../evil', seat: 0, seq: 0 },
      { matchId: MATCH, fighter: 0, seq: 5 },
      { matchId: MATCH, seat: 2, seq: 6 },
      { matchId: MATCH, seat: 0, seq: -1 },
      { matchId: MATCH, seat: 0, seq: 1.5 },
      // Names another game than the request's.
      { matchId: idFor('openai', 'random', 1, counterTurns.id), seat: 0, seq: 7 },
    ];
    for (const snapshot of targets) {
      const res = await call('POST', '/decide/openai', { body: decideBody({ snapshot }) });
      expect(res.status).toBe(200);
    }
    expect(existsSync(join(dir, 'evil'))).toBe(false);
    expect(existsSync(join(dir, 'results', 'evil'))).toBe(false);
    const states = join(dir, statesDir(GAME, MATCH));
    for (const f of ['0-5.json', '2-6.json', '0--1.json', '0-1.5.json']) {
      expect(existsSync(join(states, f))).toBe(false);
    }
    expect(existsSync(join(dir, 'results', 'states', counterTurns.id))).toBe(false);
  });

  it('refuses providers without keys, baselines and unknown ids', async () => {
    const body = decideBody({});
    expect((await call('POST', '/decide/jev', { body })).status).toBe(400);
    expect((await call('POST', '/decide/random', { body })).status).toBe(400);
    expect((await call('POST', '/decide/parity', { body })).status).toBe(400);
    expect((await call('POST', '/decide/nope', { body })).status).toBe(400);
    expect((await call('POST', '/decide/openai', { body: 'not json' })).status).toBe(400);
  });

  it('aborts the provider call when the browser hangs up', async () => {
    seen.length = 0;
    await new Promise<void>((resolve) => {
      const req = request({
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/decide/openai',
        headers: {
          host: `127.0.0.1:${String(port)}`,
          origin: ORIGIN,
          'content-type': 'application/json',
        },
      });
      req.on('error', () => undefined);
      req.end(decideBody({ state: { ...state, hang: true } }));
      setTimeout(() => {
        req.destroy();
        resolve();
      }, 50);
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(seen[0]?.signal.aborted).toBe(true);
  });
});

describe('origin and host checks', () => {
  it('rejects other origins, origin-less writes and foreign Host headers', async () => {
    expect((await call('GET', '/players', { origin: 'https://evil.example' })).status).toBe(403);
    expect((await call('POST', '/decide/openai', { origin: null, body: '{}' })).status).toBe(403);
    expect(
      (await call('POST', `/log/${MATCH}`, { origin: 'https://evil.example', body: '{}' })).status,
    ).toBe(403);
    expect((await call('GET', '/players', { host: 'evil.example:8787' })).status).toBe(403);
  });

  it('answers the CORS preflight only for an allowed origin', async () => {
    const ok = await call('OPTIONS', '/decide/openai');
    expect(ok.status).toBe(204);
    expect(ok.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(
      (await call('OPTIONS', '/decide/openai', { origin: 'https://evil.example' })).status,
    ).toBe(403);
  });
});

describe('allowed origins from config (ARENA_ORIGINS)', () => {
  it('defaults to the two Vite dev origins', () => {
    expect(DEFAULT_ORIGINS).toEqual(['http://localhost:5173', 'http://127.0.0.1:5173']);
    expect(parseOrigins(undefined)).toEqual(DEFAULT_ORIGINS);
    expect(parseOrigins('  ')).toEqual(DEFAULT_ORIGINS);
  });

  it('reads a comma-separated list and refuses anything that is not a bare origin', () => {
    expect(parseOrigins(' http://a.test:3000 , https://b.test ,')).toEqual([
      'http://a.test:3000',
      'https://b.test',
    ]);
    for (const bad of ['*', 'a.test', 'http://a.test/path', 'http://a.test:3000/', ' , ']) {
      expect(() => parseOrigins(bad)).toThrow(/ARENA_ORIGINS/);
    }
  });

  it('a proxy configured with other origins allows those and no longer the defaults', async () => {
    const other = await serve((p) =>
      handlerFor(p, { allowedOrigins: parseOrigins('http://a.test:3000') }),
    );
    try {
      const ok = await call('GET', '/players', { port: other.port, origin: 'http://a.test:3000' });
      expect(ok.status).toBe(200);
      expect(ok.headers['access-control-allow-origin']).toBe('http://a.test:3000');
      expect((await call('GET', '/players', { port: other.port, origin: ORIGIN })).status).toBe(
        403,
      );
    } finally {
      other.server.close();
    }
  });
});

describe('MATCH_ID_RE', () => {
  it('is generic: lowercase segments, at least three, no dots or slashes', () => {
    for (const ok of [MATCH, 'a-b-c', '20261007-120000-clue_clash-x-vs-y-2']) {
      expect(MATCH_ID_RE.test(ok)).toBe(true);
    }
    for (const bad of ['a-b', 'a--b-c', '-a-b-c', 'a-b-c-', 'a.b-c-d', 'a/b-c-d', 'A-b-c', '']) {
      expect(MATCH_ID_RE.test(bad)).toBe(false);
    }
  });
});

describe('POST /log/:matchId', () => {
  let lines: LogLine[] = [];
  const LOG = idFor('random', 'fake_provider', 1);
  const pathOf = (id: string, game = GAME): string => join(dir, matchFile(game, id));
  const post = (id: string, body: string): Promise<Res> => call('POST', `/log/${id}`, { body });
  /** A run's lines re-stamped with another match id. */
  const linesFor = (id: string): LogLine[] =>
    lines.map((l) => (l.type === 'header' ? { ...l, matchId: id } : l));

  beforeAll(async () => {
    lines = await realtimeLines({ seed: 3, matchId: LOG });
    expect(new Set(lines.map((l) => l.type))).toEqual(
      new Set(['header', 'decision', 'event', 'match_end']),
    );
  });

  it('rejects ids that are not a generic match id (no traversal)', async () => {
    const header = JSON.stringify(lines[0]);
    for (const id of [
      '..',
      '..%2F..%2Fetc',
      'x.jsonl',
      `${LOG}.`,
      LOG.toUpperCase(),
      'a-b',
      `a-b-${'c'.repeat(120)}`,
      `..%2F${LOG}`,
    ]) {
      expect([400, 404]).toContain((await post(id, header)).status);
    }
    expect((await post(`..%2F${LOG}`, header)).status).toBe(400);
  });

  it("writes a v2 log in its game's folder: header first, then decisions, events, match_end", async () => {
    const half = Math.floor(lines.length / 2);
    expect((await post(LOG, toJsonl(lines.slice(0, 3)))).status).toBe(200);
    expect((await post(LOG, toJsonl(lines.slice(3, half)))).status).toBe(200);
    const last = await post(LOG, toJsonl(lines.slice(half)));
    expect(last.status).toBe(200);
    expect(JSON.parse(last.text)).toEqual({ lines: lines.length - half });
    const text = readFileSync(pathOf(LOG), 'utf8');
    expect(text).toBe(toJsonl(lines));
    expect(parseMatchLog(text)).toEqual(parseMatchLog(toJsonl(lines)));
  });

  it('needs the header first, never overwrites, and stops at match_end', async () => {
    const id = idFor('random', 'fake_provider', 2);
    const [header, ...rest] = linesFor(id);
    const decision = JSON.stringify(rest.find((l) => l.type === 'decision'));
    expect((await post(id, decision)).status).toBe(404);
    expect((await post(id, JSON.stringify(header))).status).toBe(200);
    expect((await post(id, JSON.stringify(header))).status).toBe(409);
    // A header anywhere but first is refused.
    expect((await post(id, `${decision}\n${JSON.stringify(header)}`)).status).toBe(400);
    expect((await post(id, toJsonl(rest))).status).toBe(200);
    const after = await post(id, decision);
    expect(after.status).toBe(409);
    expect(errorOf(after)).toMatch(/match_end/);
    // A chunk with lines after its match_end is refused whole.
    const id2 = idFor('random', 'fake_provider', 3);
    const all = linesFor(id2);
    const end = all.findIndex((l) => l.type === 'match_end');
    expect((await post(id2, toJsonl([...all.slice(0, end + 1), all[1] as LogLine]))).status).toBe(
      400,
    );
    expect(existsSync(pathOf(id2))).toBe(false);
  });

  it('refuses v1 lines and malformed v2 lines, appending nothing', async () => {
    const id = idFor('random', 'fake_provider', 4);
    const [header, ...rest] = linesFor(id);
    expect((await post(id, JSON.stringify(header))).status).toBe(200);
    const before = readFileSync(pathOf(id), 'utf8');
    const decision = rest.find((l) => l.type === 'decision');
    const bad = [
      JSON.stringify({ type: 'round_end', round: 1, winner: 0 }),
      JSON.stringify({ ...decision, status: 'maybe' }),
      JSON.stringify({ ...decision, seat: 2 }),
      JSON.stringify({ type: 'event', tick: 3, game: { no_kind: true } }),
      `${JSON.stringify(decision)}\nnot json`,
      '{"type":"evil"}',
      '[]',
      '',
    ];
    for (const body of bad) {
      const res = await post(id, body);
      expect(res.status).toBe(400);
    }
    expect(readFileSync(pathOf(id), 'utf8')).toBe(before);
    // A v1 header never creates a file.
    const v1 = idFor('random', 'fake_provider', 5);
    const v1Header = { ...header, matchId: v1, schemaVersion: 1 };
    const res = await post(v1, JSON.stringify(v1Header));
    expect(res.status).toBe(400);
    expect(errorOf(res)).toMatch(/v1/);
    expect(existsSync(pathOf(v1))).toBe(false);
  });

  it('refuses a header for another match, an unregistered game, or a game the id does not name', async () => {
    const id = idFor('random', 'fake_provider', 6);
    const header = linesFor(id)[0] as LogLine & { type: 'header' };
    const other = idFor('random', 'fake_provider', 7);
    expect((await post(other, JSON.stringify(header))).status).toBe(400);
    // `chess` is a well-formed game id but not in the registry.
    const chess = idFor('random', 'fake_provider', 1, 'chess');
    const res = await post(chess, JSON.stringify({ ...header, matchId: chess, game: 'chess' }));
    expect(res.status).toBe(400);
    expect(errorOf(res)).toMatch(/chess/);
    // The header says counter_turns (registered), the id says counter_realtime.
    const mixed = await post(id, JSON.stringify({ ...header, game: counterTurns.id }));
    expect(mixed.status).toBe(400);
    for (const g of [GAME, counterTurns.id, 'chess']) {
      expect(existsSync(pathOf(id, g))).toBe(false);
    }
    expect(existsSync(pathOf(other))).toBe(false);
  });

  it('never appends to a log this proxy process did not create (a CLI log, say)', async () => {
    const cli = idFor('jev', 'openai', 1);
    const path = pathOf(cli);
    mkdirSync(dirname(path), { recursive: true });
    const decision = JSON.stringify(lines.find((l) => l.type === 'decision'));
    writeFileSync(path, toJsonl(linesFor(cli).slice(0, 1)));
    const before = readFileSync(path, 'utf8');
    expect((await post(cli, decision)).status).toBe(409);
    expect((await post(cli, JSON.stringify(linesFor(cli)[0]))).status).toBe(409);
    expect(readFileSync(path, 'utf8')).toBe(before);
    // Nor to one another proxy process created.
    const mine = idFor('random', 'human', 1);
    expect((await post(mine, JSON.stringify(linesFor(mine)[0]))).status).toBe(200);
    const other = await serve(() => handlerFor(port));
    try {
      const res = await call('POST', `/log/${mine}`, {
        port: other.port,
        host: `127.0.0.1:${String(port)}`,
        body: decision,
      });
      expect(res.status).toBe(409);
    } finally {
      other.server.close();
    }
  });
});

describe('GET /estimate', () => {
  const get = async (q: string): Promise<{ status: number; body: EstimateResponse }> => {
    const res = await call('GET', `/estimate?${q}`);
    return { status: res.status, body: JSON.parse(res.text) as EstimateResponse };
  };

  it("estimates a pairing from that game's estimate", async () => {
    const want = estimateMatch(
      counterRealtime.estimate,
      pricedSeats(['openai', 'random'], PROVIDERS),
    );
    const { status, body } = await get(`game=${GAME}&a=openai&b=random`);
    expect(status).toBe(200);
    expect(body).toEqual({
      totalUsd: want.totalUsd,
      typicalUsd: want.typicalUsd,
      limitUsd: 5,
      text: want.text,
    });
    expect(body.typicalUsd).toBeLessThan(body.totalUsd);
    // The turn game's estimate differs (10 decisions per seat, 100 tokens).
    const turns = await get(`game=${counterTurns.id}&a=openai&b=random`);
    expect(turns.body.totalUsd).toBe(
      estimateMatch(counterTurns.estimate, pricedSeats(['openai', 'random'], PROVIDERS)).totalUsd,
    );
    expect(turns.body.totalUsd).not.toBe(body.totalUsd);
  });

  it("is free for the game's baselines", async () => {
    const { status, body } = await get(`game=${GAME}&a=random&b=parity`);
    expect(status).toBe(200);
    expect(body.totalUsd).toBe(0);
    expect(body.text).toBe('Cost estimate: $0 (no paid players)');
  });

  it('refuses an unknown or missing game and players the game does not have', async () => {
    for (const q of [
      'a=openai&b=random',
      'game=chess&a=openai&b=random',
      `game=${GAME}&a=x&b=random`,
      `game=${GAME}&a=scripted&b=random`,
      `game=${counterTurns.id}&a=parity&b=random`,
    ]) {
      expect((await get(q)).status).toBe(400);
    }
  });
});
