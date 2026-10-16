import type { Decider, DecisionResult, Seat } from '../../../../src/core/classifier/types.js';
import { emptyResult } from '../../../../src/core/classifier/types.js';
import { parseMatchLog, type MatchLog } from '../../../../src/core/log/read.js';
import type { SeatMeta } from '../../../../src/core/sched/shared.js';
import { createTurnRunner } from '../../../../src/core/sched/turns.js';
import { SimClock, type Clock } from '../../../../src/core/util/clock.js';
import { createPrng, nextBelow, type PrngState } from '../../../../src/core/util/prng.js';
import { CLUES_BOARDS } from '../../../../src/games/clues/data.js';
import { cluesGame } from '../../../../src/games/clues/game.js';
import type { CluesView } from '../../../../src/games/clues/view.js';
import { memorySink, settleOnSim } from '../../../core/sched/helpers.js';

/**
 * A Clue Clash log with API-style probabilities, for renderer tests and the dev loop (the
 * committed logs are random vs random, which reports none). Two scripted seats on a SimClock:
 * seat 0 answers in 120–420 ms and grows surer as the clue grows; seat 1 answers in 300–950 ms,
 * spreads its probability wider, is often wrong on a word's first step, times out on turn 5 and
 * errors on turn 9. Never a real API call.
 */

/**
 * Which board word a (possibly partial) definition defines, among the question's options: the
 * deciders peek, the way a perfect model would.
 */
function answerFor(definition: string, ids: readonly string[]): string | null {
  const shown = definition.replace(/ …$/, '');
  for (const board of CLUES_BOARDS) {
    for (const w of board.words) {
      if (!ids.includes(w.lemma)) continue;
      if (w.definition === shown || w.definition.startsWith(`${shown} `)) return w.lemma;
    }
  }
  return null;
}

/** The reveal step (1..3) of turn `t`. */
const stepOf = (t: number): number => (t % 3) + 1;

interface SeatScript {
  latency(turn: number): number;
  /** Probability on the right word (the rest goes mostly to a few other words). */
  sureness(turn: number): number;
  /** True to pick the runner-up instead of the top word. */
  wrong(turn: number): boolean;
  miss?(turn: number): 'timeout' | 'error' | null;
}

function scriptedDecider(clock: Clock, prng: PrngState, script: SeatScript): Decider {
  let turn = 0;
  return {
    player: 'synthetic',
    async decide(state, question) {
      const t = turn++;
      const start = clock.now();
      const miss = script.miss?.(t) ?? null;
      if (miss === 'timeout') {
        await clock.sleep(1500);
        return emptyResult('timeout', clock.now() - start);
      }
      await clock.sleep(script.latency(t));
      const latencyMs = clock.now() - start;
      if (miss === 'error') return { ...emptyResult('error', latencyMs), error: 'HTTP 500' };
      const ids = question.options.map((o) => o.id);
      const answer = answerFor((state as CluesView).definition, ids) ?? ids[0] ?? '';
      // Mass: the answer gets `sure`, three other words share most of the rest, the others a sliver.
      const others = ids.filter((id) => id !== answer);
      const picks: string[] = [];
      while (picks.length < 3 && others.length > 0) {
        picks.push(others.splice(nextBelow(prng, others.length), 1)[0] ?? '');
      }
      const sure = script.sureness(t);
      const rest = 1 - sure;
      const probs: Record<string, number> = {};
      const sliver = (rest * 0.15) / Math.max(1, others.length);
      for (const id of ids) probs[id] = sliver;
      probs[answer] = sure;
      const shares = [0.5, 0.25, 0.1];
      for (const [i, id] of picks.entries()) probs[id] = rest * (shares[i] ?? 0);
      const ranked = Object.entries(probs).sort((a, b) => b[1] - a[1]);
      const choice = script.wrong(t) ? (ranked[1]?.[0] ?? answer) : (ranked[0]?.[0] ?? answer);
      const r: DecisionResult = emptyResult('ok', latencyMs, choice);
      r.probabilities = probs;
      r.confidence = probs[choice] ?? null;
      return r;
    },
  };
}

const meta = (player: string, label: string): SeatMeta => ({
  kind: 'baseline',
  player,
  label,
  format: null,
  hosting: null,
  model: null,
  serviceTier: null,
  price: null,
});

export const SYNTHETIC_PLAYERS = ['synth_a', 'synth_b'] as const;

/** The synthetic match's JSONL lines (header first, match_end last). */
export async function syntheticCluesLines(seed: number, matchId: string): Promise<string[]> {
  const clock = new SimClock();
  const sink = memorySink();
  const prng = (seat: Seat): PrngState => createPrng((seed * 31 + seat * 7 + 1) >>> 0);
  const runner = createTurnRunner({
    game: cluesGame,
    seed,
    config: cluesGame.defaultConfig,
    matchId,
    seats: [
      meta(SYNTHETIC_PLAYERS[0], 'Synthetic A (test)'),
      meta(SYNTHETIC_PLAYERS[1], 'Synthetic B (slower, longer label)'),
    ],
    deciders: [
      scriptedDecider(clock, prng(0), {
        latency: (t) => 120 + ((t * 97) % 300),
        sureness: (t) => 0.3 + 0.2 * (stepOf(t) - 1) + ((t * 37) % 25) / 100,
        wrong: (t) => (stepOf(t) === 1 ? t % 4 === 0 : t % 7 === 3),
      }),
      scriptedDecider(clock, prng(1), {
        latency: (t) => 300 + ((t * 131) % 650),
        sureness: (t) => 0.15 + 0.2 * (stepOf(t) - 1) + ((t * 53) % 30) / 100,
        wrong: (t) => (stepOf(t) === 1 ? t % 2 === 0 : stepOf(t) === 2 ? t % 3 === 1 : t % 5 === 2),
        miss: (t) => (t === 5 ? 'timeout' : t === 9 ? 'error' : null),
      }),
    ],
    clock,
    sink,
    gitCommit: 'synthetic',
    runLocation: 'sim',
    runId: 'sim',
    startTime: () => '2026-10-08T12:00:00.000Z',
  });
  await settleOnSim(clock, runner.run());
  return sink.lines.map((l) => JSON.stringify(l));
}

export async function syntheticCluesLog(seed = 7): Promise<MatchLog> {
  const lines = await syntheticCluesLines(seed, '20261008-120000-clues-synth_a-vs-synth_b-1');
  return parseMatchLog(lines.join('\n') + '\n');
}
