import type { Seat } from '../../../core/classifier/types.js';
import type { GameEvent, GameResult, TurnAnswer } from '../../../core/game.js';
import { createPrng, nextBelow } from '../../../core/util/prng.js';
import {
  CLUES_STEPS,
  CLUES_TURNS,
  CLUES_WORDS,
  type CluesBoardWords,
  type CluesState,
} from './types.js';

/**
 * The Clue Clash rules, pure: no wall clock, no DOM, no Math.random. The board itself is passed
 * in (the engine never loads data), so the same functions run in Node, the browser and replays.
 */

const SEATS: readonly Seat[] = [0, 1];

/** The word (index into `order`) turn `turn` asks: three turns per word. */
export function turnWord(turn: number): number {
  return Math.floor(turn / CLUES_STEPS);
}

/** The reveal step (1, 2 or 3) of turn `turn`. */
export function turnStep(turn: number): number {
  return (turn % CLUES_STEPS) + 1;
}

/** A definition's tokens: split on whitespace (the committed glosses use single spaces). */
export function definitionTokens(definition: string): string[] {
  return definition.split(/\s+/).filter((t) => t !== '');
}

/**
 * How many of a definition's `n` tokens step `step` (1..3) reveals: ceil(n/3), ceil(2n/3), n.
 * Integer math, so it is exact. A short definition may show the same text at two steps.
 */
export function revealedCount(n: number, step: number): number {
  return Math.floor((n * step + CLUES_STEPS - 1) / CLUES_STEPS);
}

/**
 * A fresh match: the board is drawn from `pool` (board indices) with the seeded PRNG, then the
 * same stream shuffles the word order (Fisher–Yates over 0..15).
 */
export function createCluesState(seed: number, pool: readonly number[]): CluesState {
  if (pool.length === 0) throw new RangeError('no boards to pick from');
  const prng = createPrng(seed);
  const boardIndex = pool[nextBelow(prng, pool.length)];
  if (boardIndex === undefined) throw new Error('unreachable');
  const order = Array.from({ length: CLUES_WORDS }, (_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = nextBelow(prng, i + 1);
    const a = order[i] ?? 0;
    order[i] = order[j] ?? 0;
    order[j] = a;
  }
  return {
    seed: seed >>> 0,
    boardIndex,
    order,
    turn: 0,
    scores: [0, 0],
    correctCount: [0, 0],
    correctLatencyMs: [0, 0],
    over: false,
  };
}

export function cloneCluesState(s: CluesState): CluesState {
  return {
    seed: s.seed,
    boardIndex: s.boardIndex,
    order: [...s.order],
    turn: s.turn,
    scores: [s.scores[0], s.scores[1]],
    correctCount: [s.correctCount[0], s.correctCount[1]],
    correctLatencyMs: [s.correctLatencyMs[0], s.correctLatencyMs[1]],
    over: s.over,
  };
}

/** Index (into the board's words) of the word this turn asks. Throws once the game is over. */
export function answerIndex(s: CluesState): number {
  const index = s.over ? undefined : s.order[turnWord(s.turn)];
  if (index === undefined)
    throw new Error(`no question: the game is over (turn ${String(s.turn)})`);
  return index;
}

/**
 * Plays one turn (one reveal step), mutating `s`: +1 for each seat whose choice is the answer
 * (both can score, at every step), and `Math.round(latencyMs)` added to that seat's
 * correct-answer latency. `correct` is null for a seat with no answer (a timeout or error scores
 * nothing). Emits a `clue` event every step and, after a word's third step, a `reveal` event.
 */
export function applyCluesTurn(
  s: CluesState,
  board: CluesBoardWords,
  answers: readonly [TurnAnswer | null, TurnAnswer | null],
): { correct: [boolean | null, boolean | null]; events: GameEvent[] } {
  if (s.over) throw new Error(`turn after the game is over (turn ${String(s.turn)})`);
  if (board.words.length !== CLUES_WORDS) {
    throw new Error(
      `a board needs ${String(CLUES_WORDS)} words, got ${String(board.words.length)}`,
    );
  }
  const answer = board.words[answerIndex(s)]?.lemma;
  if (answer === undefined) throw new Error('unreachable');
  const correct: [boolean | null, boolean | null] = [null, null];
  for (const seat of SEATS) {
    const a = answers[seat];
    if (!a || a.choice === null) continue;
    const right = a.choice === answer;
    correct[seat] = right;
    if (right) {
      s.scores[seat] += 1;
      s.correctCount[seat] += 1;
      s.correctLatencyMs[seat] += Math.round(a.latencyMs);
    }
  }
  const word = turnWord(s.turn);
  const step = turnStep(s.turn);
  const events: GameEvent[] = [
    {
      kind: 'clue',
      turn: s.turn,
      word,
      step,
      correct: [correct[0] === true, correct[1] === true],
    },
  ];
  if (step === CLUES_STEPS) events.push({ kind: 'reveal', turn: s.turn, word, answer });
  s.turn += 1;
  if (s.turn >= CLUES_TURNS) s.over = true;
  return { correct, events };
}

/**
 * The lower mean latency over correct answers, compared exactly with integers
 * (`L0 * C1` vs `L1 * C0`). A seat with no correct answer has no mean and loses to one that has;
 * two seats with none draw.
 */
function fasterSeat(s: CluesState): Seat | 'draw' {
  const [c0, c1] = s.correctCount;
  const [l0, l1] = s.correctLatencyMs;
  if (c0 === 0 && c1 === 0) return 'draw';
  if (c0 === 0) return 1;
  if (c1 === 0) return 0;
  const a = l0 * c1;
  const b = l1 * c0;
  return a < b ? 0 : b < a ? 1 : 'draw';
}

/** After 48 turns: the higher score wins, then the lower mean correct latency, then a draw. */
export function cluesResult(s: CluesState): GameResult {
  const scores: [number, number] = [s.scores[0], s.scores[1]];
  if (!s.over) return { over: false, winner: null, scores };
  const [a, b] = scores;
  if (a !== b) return { over: true, winner: a > b ? 0 : 1, scores };
  return { over: true, winner: fasterSeat(s), scores };
}
