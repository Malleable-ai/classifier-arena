import type { QuestionOption, Seat } from '../../../src/core/classifier/types.js';
import type { GamePromptConfig, TurnGame } from '../../../src/core/game.js';
import { canonicalJson, fnv1a64, utf8Bytes } from '../../../src/core/util/hash.js';
import { createPrng, nextU32 } from '../../../src/core/util/prng.js';

/**
 * A test-only turn game (never registered in src/games). 10 turns by default; each turn asks both
 * seats `t<turn>` with options a–d, exactly one right (`targets[turn] % 4`, from the seeded PRNG).
 * +1 per right answer. Winner: higher score, then lower mean latency over right answers (rounded
 * to whole ms), then a draw. No baselines of its own.
 */

export interface CounterTurnsConfig {
  turns: number;
}

export interface CounterTurnsState {
  turn: number;
  seed: number;
  /** One seeded u32 per turn; the right option is index `target % 4`. */
  targets: number[];
  scores: [number, number];
  /** Math.round(latencyMs) of each right answer, per seat. */
  correctLatencyMs: [number[], number[]];
}

/** A type alias (not an interface), so it is a `JsonObject`, what `view` must return. */
export type CounterTurnsView = {
  seat: Seat;
  turn: number;
  turns: number;
  target: number | null;
};

const SEATS: readonly Seat[] = [0, 1];
const OPTION_IDS = ['a', 'b', 'c', 'd'] as const;

const OPTIONS: readonly QuestionOption[] = OPTION_IDS.map((id, i) => ({
  id,
  description: `Option ${id}: right when the target mod 4 is ${String(i)}.`,
}));

const PROMPT_CONFIG: GamePromptConfig = {
  version: 1,
  questionName: 'pick_option',
  primer: 'Pick the option whose index (a = 0, b = 1, c = 2, d = 3) is the target mod 4.',
  options: OPTIONS,
  stateFormatVersion: 1,
};

const isOver = (s: CounterTurnsState): boolean => s.turn >= s.targets.length;

/** The right option for the current turn. */
export function turnAnswer(state: CounterTurnsState): string {
  const target = state.targets[state.turn];
  const id = target === undefined ? undefined : OPTION_IDS[target % 4];
  if (id === undefined) throw new RangeError(`no turn ${String(state.turn)}`);
  return id;
}

/** Equal scores mean equal counts, but compare means exactly anyway (cross-multiplied). */
function fasterSeat([l0, l1]: [number[], number[]]): Seat | 'draw' {
  const sum = (xs: number[]): number => xs.reduce((t, x) => t + x, 0);
  const a = sum(l0) * l1.length;
  const b = sum(l1) * l0.length;
  return a < b ? 0 : b < a ? 1 : 'draw';
}

export const counterTurns: TurnGame<CounterTurnsState, CounterTurnsConfig> = {
  id: 'counter_turns',
  label: 'Counter (turn test game)',
  version: 1,
  defaultConfig: { turns: 10 },
  promptConfig: PROMPT_CONFIG,
  graded: true,
  baselines: [],
  estimate: {
    decisionsPerSeat: { typical: 10, worst: 10 },
    inputTokens: {},
    fallbackInputTokens: 100,
  },
  cadence: { kind: 'turns' },

  create(seed, { turns }) {
    if (!Number.isInteger(turns) || turns < 1) {
      throw new RangeError(`turns must be a positive integer, got ${String(turns)}`);
    }
    const prng = createPrng(seed);
    return {
      turn: 0,
      seed: seed >>> 0,
      targets: Array.from({ length: turns }, () => nextU32(prng)),
      scores: [0, 0],
      correctLatencyMs: [[], []],
    };
  },
  clone: (s) => ({
    turn: s.turn,
    seed: s.seed,
    targets: [...s.targets],
    scores: [s.scores[0], s.scores[1]],
    correctLatencyMs: [[...s.correctLatencyMs[0]], [...s.correctLatencyMs[1]]],
  }),
  hash: (s) => fnv1a64(utf8Bytes(canonicalJson(s))),
  view(s, seat): CounterTurnsView {
    return { seat, turn: s.turn, turns: s.targets.length, target: s.targets[s.turn] ?? null };
  },
  question(s) {
    if (isOver(s)) return null;
    return {
      key: `t${String(s.turn)}`,
      question: {
        name: PROMPT_CONFIG.questionName,
        instructions: PROMPT_CONFIG.primer,
        options: OPTIONS,
      },
    };
  },
  result(s) {
    const scores: [number, number] = [s.scores[0], s.scores[1]];
    if (!isOver(s)) return { over: false, winner: null, scores };
    const [a, b] = scores;
    if (a !== b) return { over: true, winner: a > b ? 0 : 1, scores };
    return { over: true, winner: a === 0 ? 'draw' : fasterSeat(s.correctLatencyMs), scores };
  },
  logConfig: ({ turns }) => ({ turns }),
  configFromLog({ turns }) {
    if (typeof turns !== 'number' || !Number.isInteger(turns) || turns < 1) {
      throw new Error(
        `counter_turns: logged turns must be a positive integer, got ${JSON.stringify(turns)}`,
      );
    }
    return { turns };
  },

  turn: (s) => s.turn,
  applyTurn(s, answers) {
    if (isOver(s)) throw new Error(`turn after the game is over (turn ${String(s.turn)})`);
    const answer = turnAnswer(s);
    const correct: [boolean | null, boolean | null] = [null, null];
    for (const seat of SEATS) {
      const a = answers[seat];
      if (!a || a.choice === null) continue;
      const right = a.choice === answer;
      correct[seat] = right;
      if (right) {
        s.scores[seat] += 1;
        s.correctLatencyMs[seat].push(Math.round(a.latencyMs));
      }
    }
    const events = [{ kind: 'turn', turn: s.turn, answer }];
    s.turn += 1;
    return { correct, events };
  },
  maxTurns: ({ turns }) => turns,
};
