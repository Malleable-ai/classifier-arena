/**
 * Offline tuning for Inbox Invaders (`pnpm tune --game inbox [--matches N]`;
 * docs/architecture/inbox.md). Simulated players run whole matches through the real-time scheduler
 * (`createRealtimeRunner`) on a SimClock: no network, no keys, seconds per match. A simulated
 * player sleeps a fixed latency on the injected clock, then answers right with probability
 * `accuracy` (it looks the true label up from the dataset by the message text: a test harness,
 * never a real player) and otherwise picks one of the two wrong options uniformly.
 *
 * Reported per player: survival (seconds until its health reaches 0) against a never-dying
 * opponent (0 ms, always right; it is never overloaded because the floor caps it at one request
 * per 100 ms and spawns never come faster than that), mean over N seeds; then head-to-head
 * outcomes for the pairings below. Seats alternate by seed.
 *
 * Tuning targets: 180 ms @ 90% lasts 2–3 min; 300 ms @ 90% falls behind noticeably
 * sooner (≥ 20% shorter, loses most head-to-heads); `random` dies within about 30 s; `scripted`
 * (always legit) loses to 180 ms @ 90% and dies early.
 *
 * Results for INBOX_CONFIG (game version 1; health 100, damage 1, smishing ×3, 600 messages; the
 * spawn interval ramps linearly from 20 ticks toward 7 and the fall from 240 ticks toward 90 over
 * 180 s, reaching 10 and 117 when the stream ends at 148 s), `pnpm tune --game inbox --matches 40`,
 * seeds 1–40:
 *
 *   Survival against the never-dying opponent   mean      min      max    died
 *     180ms@90%                               142.9 s  110.2 s  147.8 s   39/40
 *     300ms@90%                                73.5 s   70.4 s   77.7 s   40/40
 *     random                                   31.8 s   25.6 s   39.9 s   40/40
 *     scripted (always legit)                  33.1 s   26.9 s   40.1 s   40/40
 *     (the opponent stayed at 100/100)
 *
 *   Head to head                  A wins  draws  B wins  mean length
 *     180ms@90% vs 300ms@90%          40      0       0       73.9 s
 *     180ms@90% vs random             40      0       0       32.4 s
 *     180ms@90% vs scripted           40      0       0       33.1 s
 *     random vs scripted              14      0      26       30.8 s
 *
 * Why these numbers: a 90% player takes 0.15 × damage per message on average and random (or
 * always-legit) takes 1 × damage, so accuracy alone can't separate a 2–3 min player from a 30 s
 * one with any damage above 1. Speed does it instead: one request in flight per seat, so a seat
 * clears about one message per latency + 1–2 ticks (≈ 12 ticks at 180 ms, ≈ 19 at 300 ms). Spawns
 * start at the 300 ms player's limit and pass the 180 ms player's at about 110 s; past its limit a
 * seat falls behind, messages land, and it dies within about half a minute.
 */
import { createRandomDecider, randomDeciderSeed } from '../../core/classifier/random.js';
import type { Decider, Seat } from '../../core/classifier/types.js';
import { emptyResult } from '../../core/classifier/types.js';
import type { LogLine, MatchEndLine } from '../../core/log/schema.js';
import { driveRealtime } from '../../core/sched/drive.js';
import { createRealtimeRunner } from '../../core/sched/realtime.js';
import type { SeatMeta } from '../../core/sched/shared.js';
import { SimClock, type Clock } from '../../core/util/clock.js';
import { createPrng, nextBelow, type PrngState } from '../../core/util/prng.js';
import { INBOX_MESSAGES } from './data.js';
import type { InboxConfig, InboxLabel, InboxState } from './engine/types.js';
import { INBOX_CONFIG, TICK_RATE, inboxGame } from './game.js';
import { fitText, type InboxView } from './view.js';

export type PlayerSpec =
  | { kind: 'sim'; id: string; latencyMs: number; accuracy: number }
  | { kind: 'random' }
  | { kind: 'scripted' };

export const FAST: PlayerSpec = { kind: 'sim', id: '180ms@90%', latencyMs: 180, accuracy: 0.9 };
export const SLOW: PlayerSpec = { kind: 'sim', id: '300ms@90%', latencyMs: 300, accuracy: 0.9 };
export const RANDOM: PlayerSpec = { kind: 'random' };
export const SCRIPTED: PlayerSpec = { kind: 'scripted' };
/** The never-dying opponent for survival runs. */
export const ORACLE: PlayerSpec = { kind: 'sim', id: 'oracle', latencyMs: 0, accuracy: 1 };

export const playerName = (p: PlayerSpec): string => (p.kind === 'sim' ? p.id : p.kind);

/** Message text as a seat sees it → its true label. Throws if one text has two labels. */
export function labelsByText(config: InboxConfig): ReadonlyMap<string, InboxLabel> {
  const map = new Map<string, InboxLabel>();
  for (const m of INBOX_MESSAGES) {
    const text = fitText(m.text, config.maxChars);
    const seen = map.get(text);
    if (seen !== undefined && seen !== m.label) {
      throw new Error(`inbox tune: text of ${m.id} also appears with label ${seen}`);
    }
    map.set(text, m.label);
  }
  return map;
}

/** Fixed-point accuracy draws: right when nextBelow(1e6) < round(accuracy × 1e6). */
const SCALE = 1_000_000;

export interface SimulatedPlayerOptions {
  player: string;
  clock: Clock;
  latencyMs: number;
  accuracy: number;
  prng: PrngState;
  labels: ReadonlyMap<string, InboxLabel>;
}

/** A simulated player (see the header). Two PRNG draws per answer, whatever the outcome. */
export function createSimulatedPlayer(opts: SimulatedPlayerOptions): Decider {
  const { clock, latencyMs, prng, labels } = opts;
  const threshold = Math.round(opts.accuracy * SCALE);
  return {
    player: opts.player,
    async decide(state, question, signal) {
      const start = clock.now();
      try {
        await clock.sleep(latencyMs, signal);
      } catch {
        return emptyResult('timeout', clock.now() - start);
      }
      const label = labels.get((state as InboxView).text);
      if (label === undefined) {
        return { ...emptyResult('error', clock.now() - start), error: 'unknown text' };
      }
      const right = nextBelow(prng, SCALE) < threshold;
      const wrong = question.options.filter((o) => o.id !== label);
      const pick = wrong[nextBelow(prng, wrong.length)]?.id ?? label;
      return emptyResult('ok', clock.now() - start, right ? label : pick);
    },
  };
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

function deciderFor(
  spec: PlayerSpec,
  seat: Seat,
  seed: number,
  clock: Clock,
  labels: ReadonlyMap<string, InboxLabel>,
): Decider {
  if (spec.kind === 'random') {
    return createRandomDecider({ prng: createPrng(randomDeciderSeed(seed, seat)), clock });
  }
  if (spec.kind === 'scripted') return inboxGame.createBaseline?.('scripted', { clock }) as Decider;
  return createSimulatedPlayer({
    player: spec.id,
    clock,
    latencyMs: spec.latencyMs,
    accuracy: spec.accuracy,
    prng: createPrng((randomDeciderSeed(seed, seat) ^ 0x7e57ab1e) >>> 0),
    labels,
  });
}

export interface MatchRun {
  end: MatchEndLine;
  lines: LogLine[];
  state: InboxState;
}

/** One offline match on a SimClock, logged to memory. */
export async function runInboxMatch(
  seed: number,
  players: readonly [PlayerSpec, PlayerSpec],
  config: InboxConfig = INBOX_CONFIG,
): Promise<MatchRun> {
  const clock = new SimClock();
  const lines: LogLine[] = [];
  const labels = labelsByText(config);
  const runner = createRealtimeRunner({
    game: inboxGame,
    seed,
    config,
    matchId: `tune-${String(seed)}`,
    seats: [meta(playerName(players[0])), meta(playerName(players[1]))],
    deciders: [
      deciderFor(players[0], 0, seed, clock, labels),
      deciderFor(players[1], 1, seed, clock, labels),
    ],
    clock,
    sink: { write: (line) => lines.push(line) },
    gitCommit: 'offline',
    runLocation: 'offline',
    runId: 'offline',
    startTime: () => '1970-01-01T00:00:00.000Z',
  });
  await driveRealtime(runner, clock);
  const end = runner.result;
  if (!end) throw new Error('inbox tune: match did not end');
  return { end, lines, state: runner.state };
}

const seeds = (n: number): number[] => Array.from({ length: n }, (_, i) => i + 1);

export interface SurvivalRow {
  player: string;
  /** Seconds until health reached 0; a player that outlived the stream counts its match length. */
  meanS: number;
  minS: number;
  maxS: number;
  /** Matches in which it died (the rest outlived the stream). */
  died: number;
  matches: number;
  /** Lowest health the never-dying opponent ever had (should stay at full health). */
  oracleMinHealth: number;
}

export async function survival(
  spec: PlayerSpec,
  n: number,
  config: InboxConfig = INBOX_CONFIG,
): Promise<SurvivalRow> {
  const times: number[] = [];
  let died = 0;
  let oracleMinHealth = config.health;
  for (const seed of seeds(n)) {
    const seat: Seat = seed % 2 === 0 ? 0 : 1;
    const players: [PlayerSpec, PlayerSpec] = seat === 0 ? [spec, ORACLE] : [ORACLE, spec];
    const { end, state } = await runInboxMatch(seed, players, config);
    times.push(end.totalTicks / TICK_RATE);
    if (state.lanes[seat].health <= 0) died++;
    oracleMinHealth = Math.min(oracleMinHealth, state.lanes[seat === 0 ? 1 : 0].health);
  }
  return {
    player: playerName(spec),
    meanS: times.reduce((a, b) => a + b, 0) / times.length,
    minS: Math.min(...times),
    maxS: Math.max(...times),
    died,
    matches: n,
    oracleMinHealth,
  };
}

export interface HeadToHeadRow {
  a: string;
  b: string;
  winsA: number;
  draws: number;
  winsB: number;
  meanS: number;
}

export async function headToHead(
  a: PlayerSpec,
  b: PlayerSpec,
  n: number,
  config: InboxConfig = INBOX_CONFIG,
): Promise<HeadToHeadRow> {
  const row = { a: playerName(a), b: playerName(b), winsA: 0, draws: 0, winsB: 0 };
  let total = 0;
  for (const seed of seeds(n)) {
    const aSeat: Seat = seed % 2 === 0 ? 0 : 1;
    const players: [PlayerSpec, PlayerSpec] = aSeat === 0 ? [a, b] : [b, a];
    const { end } = await runInboxMatch(seed, players, config);
    total += end.totalTicks / TICK_RATE;
    if (end.winner === 'draw' || end.winner === null) row.draws++;
    else if (end.winner === aSeat) row.winsA++;
    else row.winsB++;
  }
  return { ...row, meanS: total / n };
}

export interface TuneReport {
  matches: number;
  config: InboxConfig;
  survival: SurvivalRow[];
  headToHead: HeadToHeadRow[];
}

export const SURVIVAL_PLAYERS: readonly PlayerSpec[] = [FAST, SLOW, RANDOM, SCRIPTED];
export const PAIRINGS: readonly (readonly [PlayerSpec, PlayerSpec])[] = [
  [FAST, SLOW],
  [FAST, RANDOM],
  [FAST, SCRIPTED],
  [RANDOM, SCRIPTED],
];

export async function tuneInbox(
  matches: number,
  config: InboxConfig = INBOX_CONFIG,
): Promise<TuneReport> {
  const rows: SurvivalRow[] = [];
  for (const p of SURVIVAL_PLAYERS) rows.push(await survival(p, matches, config));
  const h2h: HeadToHeadRow[] = [];
  for (const [a, b] of PAIRINGS) h2h.push(await headToHead(a, b, matches, config));
  return { matches, config, survival: rows, headToHead: h2h };
}

const s1 = (x: number): string => `${x.toFixed(1)} s`;

export function formatTuneReport(r: TuneReport): string {
  const out: string[] = [];
  out.push(
    `Inbox Invaders tuning: ${String(r.matches)} matches per row, seeds 1..${String(r.matches)}`,
  );
  out.push(`config ${JSON.stringify(r.config)}`);
  out.push('');
  out.push('Survival against a never-dying opponent (0 ms, always right):');
  out.push(
    `  ${'player'.padEnd(12)}${'mean'.padStart(9)}${'min'.padStart(9)}${'max'.padStart(9)}` +
      'died'.padStart(8),
  );
  for (const row of r.survival) {
    out.push(
      `  ${row.player.padEnd(12)}${s1(row.meanS).padStart(9)}${s1(row.minS).padStart(9)}` +
        `${s1(row.maxS).padStart(9)}${`${String(row.died)}/${String(row.matches)}`.padStart(8)}`,
    );
  }
  const oracleMin = Math.min(...r.survival.map((row) => row.oracleMinHealth));
  out.push(`  (the opponent's lowest health: ${String(oracleMin)}/${String(r.config.health)})`);
  out.push('');
  out.push('Head to head (seats alternate):');
  out.push(
    `  ${'A vs B'.padEnd(26)}${'A wins'.padStart(8)}${'draws'.padStart(7)}${'B wins'.padStart(8)}` +
      'mean length'.padStart(13),
  );
  for (const h of r.headToHead) {
    out.push(
      `  ${`${h.a} vs ${h.b}`.padEnd(26)}${String(h.winsA).padStart(8)}` +
        `${String(h.draws).padStart(7)}${String(h.winsB).padStart(8)}${s1(h.meanS).padStart(13)}`,
    );
  }
  return out.join('\n');
}
