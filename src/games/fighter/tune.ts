/**
 * Offline tuning for the fighter (`pnpm tune --game fighter [--matches N] [--first-seed S]`;
 * docs/architecture/fighter.md, "Tuning"). Whole matches run through the real-time scheduler
 * (`createRealtimeRunner`, the one `pnpm match` uses) on a SimClock: no network, no keys. Every
 * player answers after the baselines' 200 ms (`BASELINE_DELAY_MS`) under the scheduler's floor and
 * timeout, so the cadence is the one `random` and `scripted` play at in the committed logs.
 *
 * Players: core's `random`, the fighter's `scripted` bot, and one spam bot per move, which picks
 * its move with probability 1/2 and a uniformly random option otherwise (so its move about 55% of
 * the time), from its own seeded PRNG.
 *
 * Rows (seeds firstSeed … firstSeed + N − 1; the first player sits in seat 0 on even match
 * indexes and seat 1 on odd ones, so seats swap every match; a draw counts as half a win):
 *   (a) each spam bot against `random`: the spam bot's win rate, pass at ≤ 65%
 *   (b) `scripted` against each spam bot: scripted's win rate, pass at ≥ 55%
 *   (c) `random` against `random`: seat 0's and seat 1's win rates, pass at 45–55% each
 * A rate is within ±3 points at 95% from 1,068 matches a row (1.96 × √(0.25 / n) ≤ 0.03); the CLI
 * plays 2,000 (±2.2) by default.
 */
import {
  BASELINE_DELAY_MS,
  createRandomDecider,
  randomDeciderSeed,
} from '../../core/classifier/random.js';
import type { Decider, Seat } from '../../core/classifier/types.js';
import { emptyResult } from '../../core/classifier/types.js';
import type { MatchEndLine } from '../../core/log/schema.js';
import { driveRealtime } from '../../core/sched/drive.js';
import { createRealtimeRunner } from '../../core/sched/realtime.js';
import type { SeatMeta } from '../../core/sched/shared.js';
import { SimClock, type Clock } from '../../core/util/clock.js';
import { createPrng, nextBelow, type PrngState } from '../../core/util/prng.js';
import { ENGINE_VERSION, TICK_RATE } from './engine/constants.js';
import { MOVE_IDS, type MoveId } from './engine/types.js';
import { fighterGame } from './game.js';

export type FighterPlayer =
  { kind: 'random' } | { kind: 'scripted' } | { kind: 'spam'; move: MoveId };

export const RANDOM: FighterPlayer = { kind: 'random' };
export const SCRIPTED: FighterPlayer = { kind: 'scripted' };
export const spam = (move: MoveId): FighterPlayer => ({ kind: 'spam', move });

export const playerName = (p: FighterPlayer): string =>
  p.kind === 'spam' ? `spam_${p.move}` : p.kind;

/** Salt for a spam bot's PRNG, so its stream is not `random`'s for the same seat. */
const SPAM_SALT = 0x5be4b075;

export interface SpamDeciderOptions {
  move: MoveId;
  prng: PrngState;
  clock: Clock;
  delayMs?: number;
}

/**
 * A spam bot: after `delayMs`, `move` with probability 1/2, otherwise a uniform pick over the
 * question's options. Two PRNG draws per answer, whatever the outcome.
 */
export function createSpamDecider({
  move,
  prng,
  clock,
  delayMs = BASELINE_DELAY_MS,
}: SpamDeciderOptions): Decider {
  return {
    player: `spam_${move}`,
    async decide(_state, question, signal) {
      const start = clock.now();
      try {
        await clock.sleep(delayMs, signal);
      } catch {
        return emptyResult('timeout', clock.now() - start);
      }
      const spamNow = nextBelow(prng, 2) === 0;
      const pick = question.options[nextBelow(prng, question.options.length)]?.id ?? move;
      return emptyResult('ok', clock.now() - start, spamNow ? move : pick);
    },
  };
}

function deciderFor(spec: FighterPlayer, seat: Seat, seed: number, clock: Clock): Decider {
  const seatSeed = randomDeciderSeed(seed, seat);
  switch (spec.kind) {
    case 'random':
      return createRandomDecider({ prng: createPrng(seatSeed), clock });
    case 'scripted': {
      const d = fighterGame.createBaseline?.('scripted', { clock });
      if (!d) throw new Error('fighter tune: no scripted baseline');
      return d;
    }
    case 'spam':
      return createSpamDecider({
        move: spec.move,
        prng: createPrng((seatSeed ^ SPAM_SALT) >>> 0),
        clock,
      });
  }
}

const meta = (player: string): SeatMeta => ({
  kind: 'baseline',
  player,
  label: player,
  format: null,
  hosting: null,
  model: null,
  serviceTier: null,
  price: null,
});

/** Plays one match of a row: its seed and the players in seat order. */
export type MatchRunner = (
  seed: number,
  players: readonly [FighterPlayer, FighterPlayer],
) => Promise<MatchEndLine>;

/** One offline match on a SimClock; nothing is logged. */
export async function runFighterMatch(
  seed: number,
  players: readonly [FighterPlayer, FighterPlayer],
): Promise<MatchEndLine> {
  const clock = new SimClock();
  const runner = createRealtimeRunner({
    game: fighterGame,
    seed,
    config: fighterGame.defaultConfig,
    matchId: `tune-${String(seed)}`,
    seats: [meta(playerName(players[0])), meta(playerName(players[1]))],
    deciders: [deciderFor(players[0], 0, seed, clock), deciderFor(players[1], 1, seed, clock)],
    clock,
    sink: { write: () => undefined },
    gitCommit: 'offline',
    runLocation: 'offline',
    runId: 'offline',
    startTime: () => '1970-01-01T00:00:00.000Z',
  });
  await driveRealtime(runner, clock);
  const end = runner.result;
  if (!end) throw new Error('fighter tune: match did not end');
  return end;
}

export interface PairingRow {
  a: string;
  b: string;
  matches: number;
  winsA: number;
  draws: number;
  winsB: number;
  /** Wins by seat, whoever sat there. */
  seatWins: [number, number];
  /** Ticks over every match, kept as an integer so merged chunks equal the whole row. */
  totalTicks: number;
  /** Mean match length in seconds of fight time (totalTicks / matches / 60). */
  meanS: number;
}

/** A's seat in match `i` of a row: seat 0 on even indexes, seat 1 on odd ones. */
export const seatOfA = (i: number): Seat => (i % 2 === 0 ? 0 : 1);

/**
 * Matches `offset` … `offset + n − 1` of A against B. Match `i` plays seed `firstSeed + i` with
 * A in `seatOfA(i)`, so a row split into chunks and merged (`mergeRows`) equals the whole row.
 * `run` plays each match (tests pass a stub).
 */
export async function playPairing(
  a: FighterPlayer,
  b: FighterPlayer,
  n: number,
  firstSeed = 1,
  offset = 0,
  run: MatchRunner = runFighterMatch,
): Promise<PairingRow> {
  const row: PairingRow = {
    a: playerName(a),
    b: playerName(b),
    matches: n,
    winsA: 0,
    draws: 0,
    winsB: 0,
    seatWins: [0, 0],
    totalTicks: 0,
    meanS: 0,
  };
  for (let i = offset; i < offset + n; i++) {
    const aSeat = seatOfA(i);
    const players: [FighterPlayer, FighterPlayer] = aSeat === 0 ? [a, b] : [b, a];
    const end = await run((firstSeed + i) >>> 0, players);
    row.totalTicks += end.totalTicks;
    const w = end.winner;
    if (w === 0 || w === 1) {
      row.seatWins[w]++;
      if (w === aSeat) row.winsA++;
      else row.winsB++;
    } else {
      row.draws++;
    }
  }
  row.meanS = meanSeconds(row.totalTicks, n);
  return row;
}

const meanSeconds = (ticks: number, matches: number): number =>
  matches === 0 ? 0 : ticks / matches / TICK_RATE;

/** Sum chunks of one pairing (same A and B) into one row. */
export function mergeRows(chunks: readonly PairingRow[]): PairingRow {
  const first = chunks[0];
  if (!first) throw new Error('fighter tune: nothing to merge');
  const out: PairingRow = {
    ...first,
    matches: 0,
    winsA: 0,
    draws: 0,
    winsB: 0,
    seatWins: [0, 0],
    totalTicks: 0,
  };
  for (const c of chunks) {
    if (c.a !== first.a || c.b !== first.b) throw new Error('fighter tune: merging two pairings');
    out.matches += c.matches;
    out.winsA += c.winsA;
    out.draws += c.draws;
    out.winsB += c.winsB;
    out.seatWins[0] += c.seatWins[0];
    out.seatWins[1] += c.seatWins[1];
    out.totalTicks += c.totalTicks;
  }
  out.meanS = meanSeconds(out.totalTicks, out.matches);
  return out;
}

/** A's win rate with draws as half a win. */
export const winRateA = (r: PairingRow): number => (r.winsA + r.draws / 2) / r.matches;
/** Seat `seat`'s win rate with draws as half a win. */
export const seatWinRate = (r: PairingRow, seat: Seat): number =>
  (r.seatWins[seat] + r.draws / 2) / r.matches;

/** The pass criteria (docs/architecture/fighter.md, "Tuning"). */
export const CRITERIA = {
  spamVsRandomMax: 0.65,
  scriptedVsSpamMin: 0.55,
  randomSeatMin: 0.45,
  randomSeatMax: 0.55,
} as const;

/** One row to play: which pairing, and which section of the report it belongs to. */
export interface PlannedRow {
  section: 'spamVsRandom' | 'scriptedVsSpam' | 'randomVsRandom';
  a: FighterPlayer;
  b: FighterPlayer;
}

/** Every row of a tuning run, in report order. */
export function plannedRows(moves: readonly MoveId[] = MOVE_IDS): PlannedRow[] {
  return [
    ...moves.map((m): PlannedRow => ({ section: 'spamVsRandom', a: spam(m), b: RANDOM })),
    ...moves.map((m): PlannedRow => ({ section: 'scriptedVsSpam', a: SCRIPTED, b: spam(m) })),
    { section: 'randomVsRandom', a: RANDOM, b: RANDOM },
  ];
}

export interface FighterTuneReport {
  matches: number;
  firstSeed: number;
  engineVersion: number;
  spamVsRandom: PairingRow[];
  scriptedVsSpam: PairingRow[];
  randomVsRandom: PairingRow;
}

/** Assemble played rows (in `plannedRows` order) into a report. */
export function buildReport(
  planned: readonly PlannedRow[],
  rows: readonly PairingRow[],
  matches: number,
  firstSeed: number,
): FighterTuneReport {
  const of = (section: PlannedRow['section']): PairingRow[] =>
    rows.filter((_, i) => planned[i]?.section === section);
  const rr = of('randomVsRandom')[0];
  if (!rr) throw new Error('fighter tune: no random vs random row');
  return {
    matches,
    firstSeed,
    engineVersion: ENGINE_VERSION,
    spamVsRandom: of('spamVsRandom'),
    scriptedVsSpam: of('scriptedVsSpam'),
    randomVsRandom: rr,
  };
}

/** Matches per chunk: a row is played in chunks so they can run in parallel. */
export const CHUNK_MATCHES = 50;

/** One chunk of a row: matches `offset` … `offset + n − 1`. */
export interface Chunk {
  row: PlannedRow;
  n: number;
  firstSeed: number;
  offset: number;
}

export const playChunk = (c: Chunk): Promise<PairingRow> =>
  playPairing(c.row.a, c.row.b, c.n, c.firstSeed, c.offset);

/** "spam_jab vs random, seeds 51–100": which matches a chunk plays, for error messages. */
export function chunkName(c: Chunk): string {
  const first = c.firstSeed + c.offset;
  return (
    `${playerName(c.row.a)} vs ${playerName(c.row.b)}, seeds ${String(first)}–` +
    String(first + c.n - 1)
  );
}

/** Some chunks failed; every other chunk still finished. Lists each failed chunk. */
export class TuneChunksError extends Error {
  override name = 'TuneChunksError';
  readonly failed: readonly { chunk: Chunk; error: string }[];

  constructor(failed: readonly { chunk: Chunk; error: string }[], total: number) {
    super(
      `${String(failed.length)} of ${String(total)} chunks failed (the others finished):\n` +
        failed.map((f) => `  ${chunkName(f.chunk)}: ${f.error}`).join('\n'),
    );
    this.failed = failed;
  }
}

export interface TuneOptions {
  firstSeed?: number;
  moves?: readonly MoveId[];
  chunkMatches?: number;
  /**
   * Plays one chunk; default `playChunk` in this thread. The CLI passes one that runs chunks on
   * worker threads (same seeds and seats, so the same results).
   */
  play?: (chunk: Chunk) => Promise<PairingRow>;
}

/**
 * Play every row (in chunks) and build the report. A chunk that fails doesn't stop the others:
 * every chunk is played to the end, then a TuneChunksError lists each failed one.
 */
export async function tuneFighter(
  matches: number,
  opts: TuneOptions = {},
): Promise<FighterTuneReport> {
  const firstSeed = opts.firstSeed ?? 1;
  const size = opts.chunkMatches ?? CHUNK_MATCHES;
  const play = opts.play ?? playChunk;
  const planned = plannedRows(opts.moves);
  const chunksOf = planned.map((row) => {
    const chunks: Chunk[] = [];
    for (let offset = 0; offset < matches; offset += size) {
      chunks.push({ row, n: Math.min(size, matches - offset), firstSeed, offset });
    }
    return chunks;
  });
  const settled = await Promise.all(
    chunksOf.map((chunks) => Promise.allSettled(chunks.map((c) => play(c)))),
  );
  const failed: { chunk: Chunk; error: string }[] = [];
  const played = settled.map((results, r) =>
    results.flatMap((res, i) => {
      if (res.status === 'fulfilled') return [res.value];
      const chunk = chunksOf[r]?.[i];
      const err: unknown = res.reason;
      if (chunk) failed.push({ chunk, error: err instanceof Error ? err.message : String(err) });
      return [];
    }),
  );
  if (failed.length > 0) throw new TuneChunksError(failed, chunksOf.flat().length);
  return buildReport(planned, played.map(mergeRows), matches, firstSeed);
}

/** Whether each criterion holds. */
export function checkReport(r: FighterTuneReport): {
  spamVsRandom: boolean;
  scriptedVsSpam: boolean;
  randomVsRandom: boolean;
  pass: boolean;
} {
  const spamOk = r.spamVsRandom.every((row) => winRateA(row) <= CRITERIA.spamVsRandomMax);
  const scriptedOk = r.scriptedVsSpam.every((row) => winRateA(row) >= CRITERIA.scriptedVsSpamMin);
  const s0 = seatWinRate(r.randomVsRandom, 0);
  const s1 = seatWinRate(r.randomVsRandom, 1);
  const inBand = (x: number): boolean => x >= CRITERIA.randomSeatMin && x <= CRITERIA.randomSeatMax;
  const randomOk = inBand(s0) && inBand(s1);
  return {
    spamVsRandom: spamOk,
    scriptedVsSpam: scriptedOk,
    randomVsRandom: randomOk,
    pass: spamOk && scriptedOk && randomOk,
  };
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
/** Half-width of the normal 95% interval for a rate `p` over `n` matches. */
const ci95 = (p: number, n: number): string =>
  `±${(1.96 * Math.sqrt((p * (1 - p)) / n) * 100).toFixed(1)}`;
const flag = (ok: boolean): string => (ok ? 'ok' : 'FAIL');

function rowLine(name: string, rate: number, r: PairingRow, ok: boolean): string {
  return (
    `  ${name.padEnd(20)}${pct(rate).padStart(8)}${ci95(rate, r.matches).padStart(7)}` +
    `${String(r.winsA)}/${String(r.draws)}/${String(r.winsB)}`.padStart(14) +
    `${r.meanS.toFixed(1).padStart(8)} s  ${flag(ok)}`
  );
}

export function formatFighterTuneReport(r: FighterTuneReport): string {
  const last = r.firstSeed + r.matches - 1;
  const head = `  ${'row'.padEnd(20)}${'win %'.padStart(8)}${'95%'.padStart(7)}${'W/D/L'.padStart(14)}${'length'.padStart(10)}`;
  const out: string[] = [
    `Fighter tuning (engine v${String(r.engineVersion)}): ${String(r.matches)} matches per row, ` +
      `seeds ${String(r.firstSeed)}..${String(last)}, seats swap every match, draws count ½, ` +
      `every player answers after ${String(BASELINE_DELAY_MS)} ms`,
    '',
    `(a) Spam bot vs random: the spam bot's win rate (pass ≤ ${pct(CRITERIA.spamVsRandomMax)})`,
    head,
  ];
  for (const row of r.spamVsRandom) {
    const rate = winRateA(row);
    out.push(rowLine(row.a, rate, row, rate <= CRITERIA.spamVsRandomMax));
  }
  out.push('');
  out.push(
    `(b) Scripted vs spam bot: scripted's win rate (pass ≥ ${pct(CRITERIA.scriptedVsSpamMin)})`,
  );
  out.push(head);
  for (const row of r.scriptedVsSpam) {
    const rate = winRateA(row);
    out.push(rowLine(`vs ${row.b}`, rate, row, rate >= CRITERIA.scriptedVsSpamMin));
  }
  out.push('');
  const rr = r.randomVsRandom;
  const s0 = seatWinRate(rr, 0);
  const s1 = seatWinRate(rr, 1);
  const band = (x: number): boolean => x >= CRITERIA.randomSeatMin && x <= CRITERIA.randomSeatMax;
  out.push(
    `(c) Random vs random by seat (pass ${pct(CRITERIA.randomSeatMin)}–${pct(CRITERIA.randomSeatMax)} each)`,
  );
  out.push(
    `  seat 0 ${pct(s0)} ${ci95(s0, rr.matches)}  ${flag(band(s0))}   ` +
      `seat 1 ${pct(s1)} ${ci95(s1, rr.matches)}  ${flag(band(s1))}   ` +
      `(seat 0 wins ${String(rr.seatWins[0])}, draws ${String(rr.draws)}, seat 1 wins ` +
      `${String(rr.seatWins[1])}; mean ${rr.meanS.toFixed(1)} s)`,
  );
  out.push('');
  out.push(
    checkReport(r).pass ? 'PASS: every criterion holds.' : 'FAIL: see the rows marked FAIL.',
  );
  return out.join('\n');
}
