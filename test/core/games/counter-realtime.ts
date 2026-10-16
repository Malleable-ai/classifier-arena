import { BASELINE_DELAY_MS } from '../../../src/core/classifier/random.js';
import type { Decider, QuestionOption, Seat } from '../../../src/core/classifier/types.js';
import { emptyResult } from '../../../src/core/classifier/types.js';
import type {
  BaselineDeps,
  GameEvent,
  GamePromptConfig,
  RealtimeGame,
  Settlement,
} from '../../../src/core/game.js';
import { canonicalJson, fnv1a64, utf8Bytes } from '../../../src/core/util/hash.js';
import { createPrng, nextU32 } from '../../../src/core/util/prng.js';

/**
 * A test-only real-time game (never registered in src/games). 60 Hz; one question window every 30
 * ticks. In window k each seat is asked `q<k>`: is `targets[k]` even ('up') or odd ('down')?
 * Every input settles on the tick it is applied; an input for any other key is dropped as stale.
 * Scores are correct answers. Ends at tick `windows * 30` (600 by default).
 */

export const TICK_RATE = 60;
export const WINDOW_TICKS = 30;

export interface CounterRealtimeConfig {
  windows: number;
}

export interface CounterRealtimeState {
  tick: number;
  seed: number;
  /** One seeded u32 per window. */
  targets: number[];
  scores: [number, number];
}

/** A type alias (not an interface), so it is a `JsonObject`, what `view` must return. */
export type CounterRealtimeView = {
  seat: Seat;
  tick: number;
  window: number;
  target: number | null;
};

const SEATS: readonly Seat[] = [0, 1];

const OPTIONS: readonly QuestionOption[] = [
  { id: 'up', description: 'The target is even.' },
  { id: 'down', description: 'The target is odd.' },
];

const PROMPT_CONFIG: GamePromptConfig = {
  version: 1,
  questionName: 'up_or_down',
  primer: 'Answer up if the target in the state is even and down if it is odd.',
  options: OPTIONS,
  stateFormatVersion: 1,
};

const windowOf = (tick: number): number => Math.floor(tick / WINDOW_TICKS);
const keyOf = (k: number): string => `q${String(k)}`;
const isOver = (s: CounterRealtimeState): boolean => s.tick >= s.targets.length * WINDOW_TICKS;
const parity = (target: number): 'up' | 'down' => (target % 2 === 0 ? 'up' : 'down');

/** The right answer in window `k`. */
export function realtimeAnswer(state: CounterRealtimeState, k: number): 'up' | 'down' {
  const target = state.targets[k];
  if (target === undefined) throw new RangeError(`no window ${String(k)}`);
  return parity(target);
}

/** A scripted bot that reads the target from the view, like a game's own baseline would. */
function createParityDecider({ clock, delayMs = BASELINE_DELAY_MS }: BaselineDeps): Decider {
  return {
    player: 'parity',
    async decide(state, _question, signal) {
      const start = clock.now();
      try {
        await clock.sleep(delayMs, signal);
      } catch {
        return emptyResult('timeout', clock.now() - start);
      }
      const { target } = state as CounterRealtimeView;
      if (target === null) {
        return { ...emptyResult('error', clock.now() - start), error: 'no target' };
      }
      return emptyResult('ok', clock.now() - start, parity(target));
    },
  };
}

export const counterRealtime: RealtimeGame<CounterRealtimeState, CounterRealtimeConfig> = {
  id: 'counter_realtime',
  label: 'Counter (real-time test game)',
  version: 1,
  defaultConfig: { windows: 20 },
  promptConfig: PROMPT_CONFIG,
  graded: true,
  baselines: ['parity'],
  baselineLabels: { parity: 'Parity bot' },
  createBaseline(id, deps) {
    if (id === 'parity') return createParityDecider(deps);
    throw new Error(`unknown baseline "${id}"`);
  },
  estimate: {
    decisionsPerSeat: { typical: 40, worst: 600 },
    inputTokens: {},
    fallbackInputTokens: 120,
  },
  cadence: { kind: 'realtime', tickRate: TICK_RATE },

  create(seed, { windows }) {
    if (!Number.isInteger(windows) || windows < 1) {
      throw new RangeError(`windows must be a positive integer, got ${String(windows)}`);
    }
    const prng = createPrng(seed);
    return {
      tick: 0,
      seed: seed >>> 0,
      targets: Array.from({ length: windows }, () => nextU32(prng)),
      scores: [0, 0],
    };
  },
  clone: (s) => ({
    tick: s.tick,
    seed: s.seed,
    targets: [...s.targets],
    scores: [s.scores[0], s.scores[1]],
  }),
  hash: (s) => fnv1a64(utf8Bytes(canonicalJson(s))),
  view(s, seat): CounterRealtimeView {
    const k = windowOf(s.tick);
    return { seat, tick: s.tick, window: k, target: s.targets[k] ?? null };
  },
  question(s) {
    if (isOver(s)) return null;
    return {
      key: keyOf(windowOf(s.tick)),
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
    return { over: true, winner: a > b ? 0 : b > a ? 1 : 'draw', scores };
  },
  logConfig: ({ windows }) => ({ windows }),
  configFromLog({ windows }) {
    if (typeof windows !== 'number' || !Number.isInteger(windows) || windows < 1) {
      throw new Error(
        `counter_realtime: logged windows must be a positive integer, got ${JSON.stringify(windows)}`,
      );
    }
    return { windows };
  },

  tick: (s) => s.tick,
  canAsk: () => true,
  step(s, inputs) {
    if (isOver(s)) throw new Error(`step after the game is over (tick ${String(s.tick)})`);
    const k = windowOf(s.tick);
    const key = keyOf(k);
    const answer = realtimeAnswer(s, k);
    const events: GameEvent[] = s.tick % WINDOW_TICKS === 0 ? [{ kind: 'window', k }] : [];
    const settlements: Settlement[] = [];
    for (const seat of SEATS) {
      const input = inputs[seat];
      if (!input) continue;
      if (input.questionKey !== key) {
        settlements.push({ seat, choice: input.choice, outcome: 'dropped', reason: 'stale' });
        continue;
      }
      const correct = input.choice === answer;
      if (correct) s.scores[seat] += 1;
      settlements.push({ seat, choice: input.choice, outcome: 'applied', correct });
    }
    s.tick += 1;
    return { settlements, events };
  },
  maxTicks: ({ windows }) => windows * WINDOW_TICKS,
};
