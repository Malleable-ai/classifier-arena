import type { GameEstimate, TurnGame } from '../../core/game.js';
import { CLUES_BOARDS, CLUES_BOARDS_SHA256, boardAt } from './data.js';
import type { CluesBoard } from './data-build.js';
import { applyCluesTurn, cloneCluesState, cluesResult, createCluesState } from './engine/engine.js';
import { hashCluesState } from './engine/hash.js';
import { CLUES_TURNS, type CluesState } from './engine/types.js';
import { CLUES_PROMPT_CONFIG, cluesQuestion } from './prompt.js';
import { GAME_OVER_VIEW, cluesView } from './view.js';

/**
 * Clue Clash (docs/architecture/clues.md): an original reverse-dictionary duel on one 16-word
 * board. Every word is asked once, in a seeded order, its definition revealed in three steps (about
 * a third, two thirds, all of it). At every step both seats pick from all 16 words at once, and
 * every right pick scores +1, so knowing a word early is worth up to 3 points. 48 turns. Baseline:
 * the core `random`.
 */

/**
 * The board set a match draws from, by identity: the committed boards' build hash and count.
 * `create` picks one board by seed from all of them, so this is also exactly what the header
 * logs, and a replay can refuse to run against different boards.
 */
export interface CluesConfig {
  boardsSha256: string;
  boardCount: number;
}

const DEFAULT_CONFIG: CluesConfig = Object.freeze({
  boardsSha256: CLUES_BOARDS_SHA256,
  boardCount: CLUES_BOARDS.length,
});

const ALL_BOARDS: readonly number[] = CLUES_BOARDS.map((_, i) => i);

/** Throws unless `config` names the committed boards. */
function checkConfig(config: CluesConfig): void {
  if (config.boardsSha256 !== CLUES_BOARDS_SHA256 || config.boardCount !== CLUES_BOARDS.length) {
    throw new Error(
      `clue boards differ: config names ${String(config.boardCount)} boards with sha256 ` +
        `${config.boardsSha256}, data/clues/boards.json has ${String(CLUES_BOARDS.length)} with ` +
        CLUES_BOARDS_SHA256,
    );
  }
}

/** The board a match state is played on (for the view, the question and renderers). */
export function cluesBoardOf(state: CluesState): CluesBoard {
  return boardAt(state.boardIndex);
}

/** Every turn asks both seats: 48 decisions per seat in every match. */
const CLUES_ESTIMATE: GameEstimate = {
  decisionsPerSeat: { typical: CLUES_TURNS, worst: CLUES_TURNS },
  // Median input tokens per decision in the live smokes (2026-10-08): Jev 630, OpenAI 318. The
  // reveal step adds a few tokens to the state and a partial definition saves a few.
  inputTokens: { jev: 630, openai: 320 },
  fallbackInputTokens: 650,
};

export const cluesGame: TurnGame<CluesState, CluesConfig> = {
  id: 'clues',
  label: 'Clue Clash',
  // 2: three reveal steps per word, both seats asked at each (48 turns); was one turn per word.
  version: 2,
  defaultConfig: DEFAULT_CONFIG,
  promptConfig: CLUES_PROMPT_CONFIG,
  graded: true,
  baselines: [],
  estimate: CLUES_ESTIMATE,
  cadence: { kind: 'turns' },

  create(seed, config) {
    checkConfig(config);
    return createCluesState(seed, ALL_BOARDS);
  },
  clone: cloneCluesState,
  hash: hashCluesState,
  view: (state) => cluesView(state, cluesBoardOf(state)) ?? GAME_OVER_VIEW,
  question: (state) => cluesQuestion(state, cluesBoardOf(state)),
  result: cluesResult,
  /** The board set's identity, never the boards themselves. */
  logConfig: ({ boardsSha256, boardCount }) => ({ boardsSha256, boardCount }),
  configFromLog(logged) {
    const { boardsSha256, boardCount } = logged;
    if (typeof boardsSha256 !== 'string' || typeof boardCount !== 'number') {
      throw new Error(
        `clue config: expected { boardsSha256, boardCount }, got ${JSON.stringify(logged)}`,
      );
    }
    checkConfig({ boardsSha256, boardCount });
    return DEFAULT_CONFIG;
  },

  turn: (state) => state.turn,
  applyTurn: (state, answers) => applyCluesTurn(state, cluesBoardOf(state), answers),
  maxTurns: () => CLUES_TURNS,
};
