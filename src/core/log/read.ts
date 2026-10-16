import { HOSTINGS, type Hosting } from '../classifier/hosting.js';
import { REFUSAL_ERROR, type Seat } from '../classifier/types.js';
import { GAME_ID_RE, type GameEvent } from '../game.js';
import type {
  DecisionLine,
  DecisionLineStatus,
  EventLine,
  HeaderLine,
  HeaderSeat,
  LogLine,
  MatchEndLine,
  MatchStall,
  SeatPrice,
  WarmupRecord,
} from './schema.js';
import { SCHEMA_VERSION } from './schema.js';

/**
 * Match log reader for schema v2 (docs/architecture/core.md), the same for every game. Parses a
 * JSONL log with hand-written guards, so a malformed, older or newer log fails loudly with the line
 * number and the field (`line N: seats[1].hosting must be …`) instead of replaying garbage. It
 * checks the generic fields only: game payloads (header `config`, event `game` fields) are the
 * game's to read. There is no v1 reader. Runs in Node and the browser (no Node imports).
 */

export interface MatchLog {
  header: HeaderLine;
  decisions: DecisionLine[];
  events: EventLine[];
  /** Null when the run stopped before the match ended. */
  matchEnd: MatchEndLine | null;
}

type Obj = Record<string, unknown>;

class FieldError extends Error {}

const STATUSES: readonly DecisionLineStatus[] = ['ok', 'timeout', 'error', 'dropped', 'refusal'];
const WARMUP_STATUSES: readonly WarmupRecord['status'][] = ['ok', 'timeout', 'error', 'refusal'];

function show(v: unknown): string {
  return v === undefined ? 'undefined' : JSON.stringify(v);
}

function fail(field: string, want: string, got: unknown): never {
  throw new FieldError(`${field} must be ${want}, got ${show(got)}`);
}

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const count = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;

/** `a, b or c`. */
const listOf = (values: readonly string[]): string =>
  values.length < 2
    ? values.join('')
    : `${values.slice(0, -1).join(', ')} or ${values.at(-1) ?? ''}`;

/**
 * Field readers over one object. `at` prefixes each field name in errors (`seats[1].`), so a
 * nested field reports its full path.
 */
function fields(o: Obj, at = '') {
  const name = (k: string): string => at + k;
  const str = (k: string): string => {
    const v = o[k];
    return typeof v === 'string' ? v : fail(name(k), 'a string', v);
  };
  const bool = (k: string): boolean => {
    const v = o[k];
    return typeof v === 'boolean' ? v : fail(name(k), 'a boolean', v);
  };
  const pairOf = (k: string, ok: (x: unknown) => boolean, want: string): [number, number] => {
    const v = o[k];
    if (!Array.isArray(v) || v.length !== 2 || !v.every(ok)) return fail(name(k), want, v);
    return [v[0] as number, v[1] as number];
  };
  return {
    name,
    str,
    bool,
    obj: (k: string): Obj => {
      const v = o[k];
      return isObj(v) ? v : fail(name(k), 'an object', v);
    },
    nonEmpty: (k: string): string => {
      const v = o[k];
      return typeof v === 'string' && v !== '' ? v : fail(name(k), 'a non-empty string', v);
    },
    strOrNull: (k: string): string | null => {
      const v = o[k];
      return v === null || typeof v === 'string' ? v : fail(name(k), 'a string or null', v);
    },
    num: (k: string): number => {
      const v = o[k];
      return finite(v) ? v : fail(name(k), 'a finite number', v);
    },
    numOrNull: (k: string): number | null => {
      const v = o[k];
      return v === null || finite(v) ? v : fail(name(k), 'a finite number or null', v);
    },
    count: (k: string): number => {
      const v = o[k];
      return count(v) ? v : fail(name(k), 'an integer ≥ 0', v);
    },
    countOrNull: (k: string): number | null => {
      const v = o[k];
      return v === null || count(v) ? v : fail(name(k), 'an integer ≥ 0 or null', v);
    },
    seat: (k: string): Seat => {
      const v = o[k];
      return v === 0 || v === 1 ? v : fail(name(k), '0 or 1', v);
    },
    pair: (k: string): [number, number] => pairOf(k, finite, 'a pair of finite numbers'),
    countPair: (k: string): [number, number] => pairOf(k, count, 'a pair of integers ≥ 0'),
    oneOf: <T extends string>(k: string, values: readonly T[]): T => {
      const v = o[k];
      return typeof v === 'string' && (values as readonly string[]).includes(v)
        ? (v as T)
        : fail(name(k), listOf(values), v);
    },
    /** Optional field: undefined when absent, else read with `read`. */
    opt: <T>(k: string, read: (k: string) => T): T | undefined =>
      o[k] === undefined ? undefined : read(k),
  };
}

function readPrice(v: unknown, at: string): SeatPrice | null {
  if (v === null) return null;
  if (!isObj(v)) return fail(at, 'an object or null', v);
  const f = fields(v, `${at}.`);
  return {
    inputPerMTokUsd: f.num('inputPerMTokUsd'),
    outputPerMTokUsd: f.num('outputPerMTokUsd'),
    asOf: f.str('asOf'),
  };
}

function readWarmup(v: unknown, at: string): WarmupRecord | null {
  if (v === null) return null;
  if (!isObj(v)) return fail(at, 'an object or null', v);
  const f = fields(v, `${at}.`);
  const w: WarmupRecord = {
    latencyMs: f.num('latencyMs'),
    status: f.oneOf('status', WARMUP_STATUSES),
    costUsd: f.num('costUsd'),
  };
  const error = f.opt('error', f.str);
  if (error !== undefined) w.error = error;
  return w;
}

function readSeat(v: unknown, seat: Seat): HeaderSeat {
  const at = `seats[${String(seat)}]`;
  if (!isObj(v)) return fail(at, 'an object', v);
  const f = fields(v, `${at}.`);
  if (v['seat'] !== seat) fail(f.name('seat'), String(seat), v['seat']);
  const hosting = v['hosting'];
  if (hosting !== null && !(typeof hosting === 'string' && HOSTINGS.includes(hosting as Hosting))) {
    fail(f.name('hosting'), listOf([...HOSTINGS, 'null']), hosting);
  }
  return {
    seat,
    player: f.str('player'),
    label: f.str('label'),
    format: f.strOrNull('format'),
    hosting: hosting as Hosting | null,
    model: f.strOrNull('model'),
    serviceTier: f.strOrNull('serviceTier'),
    modelVersion: f.strOrNull('modelVersion'),
    price: readPrice(v['price'], f.name('price')),
    warmup: readWarmup(v['warmup'], f.name('warmup')),
  };
}

function readCadence(v: unknown): HeaderLine['cadence'] {
  if (!isObj(v)) return fail('cadence', 'an object', v);
  const f = fields(v, 'cadence.');
  const kind = f.oneOf('kind', ['realtime', 'turns'] as const);
  if (kind === 'turns') return { kind };
  const tickRate = v['tickRate'];
  if (!finite(tickRate) || tickRate <= 0) fail(f.name('tickRate'), 'a number > 0', tickRate);
  return { kind, tickRate };
}

/**
 * The run id of a log written before headers had one (the field is additive, so still v2):
 * `sim` for a simulated run, else `unknown`.
 */
function legacyRunId(runLocation: string): string {
  return runLocation === 'sim' ? 'sim' : 'unknown';
}

function readHeader(o: Obj): HeaderLine {
  const version = o['schemaVersion'];
  if (version === 1) {
    throw new FieldError(
      'schema v1 logs are no longer readable; regenerate them with this build ' +
        `(schema v${String(SCHEMA_VERSION)})`,
    );
  }
  if (version !== SCHEMA_VERSION) {
    throw new FieldError(
      `match log schema version ${show(version)} is not supported ` +
        `(this build reads version ${String(SCHEMA_VERSION)})`,
    );
  }
  const f = fields(o);
  const game = o['game'];
  if (typeof game !== 'string' || !GAME_ID_RE.test(game)) {
    fail('game', `a game id (${String(GAME_ID_RE)})`, game);
  }
  const timing = fields(f.obj('timing'), 'timing.');
  const seats = o['seats'];
  if (!Array.isArray(seats) || seats.length !== 2) fail('seats', 'an array of two seats', seats);
  const runLocation = f.str('runLocation');
  return {
    type: 'header',
    schemaVersion: SCHEMA_VERSION,
    game,
    gameVersion: f.count('gameVersion'),
    matchId: f.nonEmpty('matchId'),
    startTime: f.str('startTime'),
    gitCommit: f.str('gitCommit'),
    seed: f.count('seed'),
    runLocation,
    runId: f.opt('runId', f.nonEmpty) ?? legacyRunId(runLocation),
    cadence: readCadence(o['cadence']),
    timing: { floorMs: timing.num('floorMs'), timeoutMs: timing.num('timeoutMs') },
    promptConfigHash: f.str('promptConfigHash'),
    optionOrderRule: f.str('optionOrderRule'),
    config: f.obj('config'),
    seats: [readSeat(seats[0], 0), readSeat(seats[1], 1)],
  };
}

function readProbabilities(v: unknown): Record<string, number> | null {
  if (v === null) return null;
  if (!isObj(v)) return fail('probabilities', 'an object or null', v);
  for (const [k, p] of Object.entries(v)) {
    if (!finite(p)) fail(`probabilities.${k}`, 'a finite number', p);
  }
  return v as Record<string, number>;
}

function readDecision(o: Obj): DecisionLine {
  const f = fields(o);
  const line: DecisionLine = {
    type: 'decision',
    seat: f.seat('seat'),
    seq: f.count('seq'),
    questionKey: f.str('questionKey'),
    sentTick: f.count('sentTick'),
    appliedTick: f.countOrNull('appliedTick'),
    latencyMs: f.num('latencyMs'),
    choice: f.strOrNull('choice'),
    probabilities: readProbabilities(o['probabilities']),
    confidence: f.numOrNull('confidence'),
    inputTokens: f.numOrNull('inputTokens'),
    costUsd: f.num('costUsd'),
    status: f.oneOf('status', STATUSES),
  };
  const { choice, probabilities } = line;
  if (line.status === 'ok' && choice === null) fail('choice', 'a string when status is ok', null);
  if (o['costEstimated'] !== undefined) {
    if (o['costEstimated'] !== true) fail('costEstimated', 'true when present', o['costEstimated']);
    line.costEstimated = true;
  }
  const partial = o['probabilitiesPartial'];
  if (partial !== undefined) {
    if (partial !== true) fail('probabilitiesPartial', 'true when present', partial);
    line.probabilitiesPartial = true;
  }
  if (
    choice !== null &&
    probabilities !== null &&
    !Object.hasOwn(probabilities, choice) &&
    partial !== true
  ) {
    fail('choice', 'a key of probabilities (or probabilitiesPartial true)', choice);
  }
  const error = f.opt('error', f.str);
  if (error !== undefined) line.error = error;
  // Logs written before the `refusal` status (2026-10-12) logged a refusal as an error with this
  // exact message. Read it as what it was, so validity and the stats treat every refusal alike.
  if (line.status === 'error' && error === REFUSAL_ERROR) line.status = 'refusal';
  const correct = f.opt('correct', f.bool);
  if (correct !== undefined) line.correct = correct;
  return line;
}

function readEvent(o: Obj): EventLine {
  const f = fields(o);
  const game = f.obj('game');
  fields(game, 'game.').str('kind');
  return { type: 'event', tick: f.count('tick'), game: game as GameEvent };
}

function readMatchEnd(o: Obj): MatchEndLine {
  const f = fields(o);
  const winner = o['winner'];
  if (!(winner === null || winner === 0 || winner === 1 || winner === 'draw')) {
    fail('winner', '0, 1, "draw" or null', winner);
  }
  const missRates = f.pair('missRates');
  // Optional: logs written before 2026-10-12 have none.
  const timeoutRates = f.opt('timeoutRates', f.pair);
  if (timeoutRates?.some((r, seat) => r < 0 || r > (missRates[seat] ?? 0))) {
    fail('timeoutRates', 'a pair of rates ≥ 0, each at most its seat’s missRates', timeoutRates);
  }
  // Optional: logs written before the refusal rule (2026-10-12) have none.
  const refusalRates = f.opt('refusalRates', f.pair);
  if (refusalRates?.some((r) => r < 0 || r > 1)) {
    fail('refusalRates', 'a pair of rates from 0 to 1', refusalRates);
  }
  const valid = f.bool('valid');
  // Optional: written only when the scheduler measured a stall (since 2026-10-15).
  const stalls = o['stalls'] === undefined ? undefined : readStalls(o['stalls']);
  if (stalls !== undefined && stalls.length > 0 && valid) {
    fail('valid', 'false when stalls are recorded', valid);
  }
  return {
    type: 'match_end',
    winner,
    scores: f.pair('scores'),
    totalTicks: f.count('totalTicks'),
    finalStateHash: f.str('finalStateHash'),
    valid,
    missRates,
    ...(timeoutRates === undefined ? {} : { timeoutRates }),
    ...(refusalRates === undefined ? {} : { refusalRates }),
    decisions: f.countPair('decisions'),
    costUsd: f.num('costUsd'),
    ...(stalls === undefined ? {} : { stalls }),
  };
}

function readStalls(v: unknown): MatchStall[] {
  if (!Array.isArray(v)) return fail('stalls', 'an array', v);
  return v.map((s: unknown, i): MatchStall => {
    if (!isObj(s)) return fail(`stalls[${String(i)}]`, 'an object', s);
    const f = fields(s, `stalls[${String(i)}].`);
    const gapMs = f.num('gapMs');
    if (gapMs <= 0) fail(`stalls[${String(i)}].gapMs`, 'above 0', gapMs);
    return { atTick: f.count('atTick'), gapMs };
  });
}

/**
 * One already-parsed line of any v2 type, checked on its own (the live proxy checks lines as they
 * arrive; order is the caller's to check). Throws on a malformed or non-v2 line.
 */
export function readLogLine(value: unknown): LogLine {
  try {
    if (!isObj(value)) throw new FieldError('expected a JSON object');
    const type = value['type'];
    switch (type) {
      case 'header':
        return readHeader(value);
      case 'decision':
        return readDecision(value);
      case 'event':
        return readEvent(value);
      case 'match_end':
        return readMatchEnd(value);
      default:
        throw new FieldError(`unknown line type ${show(type)}`);
    }
  } catch (e) {
    if (e instanceof FieldError) throw new Error(e.message, { cause: e });
    throw e;
  }
}

/** Parse a v2 JSONL match log. Throws `line N: …` on the first malformed line. */
export function parseMatchLog(text: string): MatchLog {
  let header: HeaderLine | null = null;
  const decisions: DecisionLine[] = [];
  const events: EventLine[] = [];
  let matchEnd: MatchEndLine | null = null;

  for (const [i, raw] of text.split('\n').entries()) {
    const n = i + 1;
    if (raw.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new Error(`line ${String(n)}: invalid JSON`, { cause: e });
    }
    try {
      if (!isObj(parsed)) throw new FieldError('expected a JSON object');
      const type = parsed['type'];
      if (header === null) {
        if (type !== 'header') throw new FieldError(`expected a header, got ${show(type)}`);
        header = readHeader(parsed);
        continue;
      }
      if (matchEnd !== null) throw new FieldError('unexpected line after match_end');
      switch (type) {
        case 'header':
          throw new FieldError('a second header');
        case 'decision':
          decisions.push(readDecision(parsed));
          continue;
        case 'event':
          events.push(readEvent(parsed));
          continue;
        case 'match_end':
          matchEnd = readMatchEnd(parsed);
          continue;
        default:
          throw new FieldError(`unknown line type ${show(type)}`);
      }
    } catch (e) {
      if (e instanceof FieldError) throw new Error(`line ${String(n)}: ${e.message}`, { cause: e });
      throw e;
    }
  }

  if (header === null) throw new Error('match log is empty');
  return { header, decisions, events, matchEnd };
}
