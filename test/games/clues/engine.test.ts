import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import type { Seat } from '../../../src/core/classifier/types.js';
import type { TurnAnswer } from '../../../src/core/game.js';
import {
  applyCluesTurn,
  answerIndex,
  cloneCluesState,
  cluesResult,
  createCluesState,
  definitionTokens,
  revealedCount,
  turnStep,
  turnWord,
} from '../../../src/games/clues/engine/engine.js';
import { HASHED_KEYS, hashCluesState } from '../../../src/games/clues/engine/hash.js';
import {
  CLUES_STEPS,
  CLUES_TURNS,
  CLUES_WORDS,
  type CluesState,
} from '../../../src/games/clues/engine/types.js';

const SEED = 20261007;

/** A synthetic board: the engine only needs each word's answer id, in board order. */
const LEMMAS = Array.from({ length: CLUES_WORDS }, (_, i) => `word${String.fromCharCode(97 + i)}`);
const BOARD = { words: LEMMAS.map((lemma) => ({ lemma })) };
const POOL = [0, 1, 2, 3, 4, 5, 6, 7];

const answerOf = (s: CluesState): string => {
  const lemma = LEMMAS[answerIndex(s)];
  if (lemma === undefined) throw new Error('no answer');
  return lemma;
};
const wrongOf = (s: CluesState): string => (answerOf(s) === LEMMAS[0] ? 'wordb' : 'worda');

describe('createCluesState', () => {
  it('starts at turn 0 with no score, on a board from the pool, in a seeded order', () => {
    const s = createCluesState(SEED, POOL);
    expect(s).toMatchObject({
      seed: SEED,
      turn: 0,
      scores: [0, 0],
      correctCount: [0, 0],
      correctLatencyMs: [0, 0],
      over: false,
    });
    expect(POOL).toContain(s.boardIndex);
    expect([...s.order].sort((a, b) => a - b)).toEqual(
      Array.from({ length: CLUES_WORDS }, (_, i) => i),
    );
  });

  it('is a pure function of the seed and the pool', () => {
    expect(createCluesState(SEED, POOL)).toEqual(createCluesState(SEED, POOL));
    const orders = new Set<string>();
    const boards = new Set<number>();
    for (let seed = 0; seed < 64; seed++) {
      const s = createCluesState(seed, POOL);
      orders.add(s.order.join(','));
      boards.add(s.boardIndex);
    }
    expect(orders.size).toBe(64);
    expect(boards).toEqual(new Set(POOL));
  });

  it('picks only from the pool, and needs a non-empty one', () => {
    for (let seed = 0; seed < 20; seed++) expect(createCluesState(seed, [41]).boardIndex).toBe(41);
    expect(() => createCluesState(SEED, [])).toThrow(/no boards/);
  });
});

describe('reveal steps', () => {
  it('asks each word for three turns in a row, steps 1, 2, 3', () => {
    expect([CLUES_WORDS, CLUES_STEPS, CLUES_TURNS]).toEqual([16, 3, 48]);
    expect(Array.from({ length: 7 }, (_, t) => [turnWord(t), turnStep(t)])).toEqual([
      [0, 1],
      [0, 2],
      [0, 3],
      [1, 1],
      [1, 2],
      [1, 3],
      [2, 1],
    ]);
    expect([turnWord(47), turnStep(47)]).toEqual([15, 3]);
  });

  it('reveals ceil(n/3), ceil(2n/3), then all n tokens', () => {
    const cases: [number, [number, number, number]][] = [
      [1, [1, 1, 1]],
      [2, [1, 2, 2]],
      [3, [1, 2, 3]],
      [4, [2, 3, 4]],
      [9, [3, 6, 9]],
      [10, [4, 7, 10]],
      [11, [4, 8, 11]],
      [38, [13, 26, 38]],
    ];
    for (const [n, want] of cases) {
      expect(
        [1, 2, 3].map((step) => revealedCount(n, step)),
        `n = ${String(n)}`,
      ).toEqual(want);
      for (const step of [1, 2, 3]) {
        expect(revealedCount(n, step)).toBe(Math.ceil((n * step) / 3));
      }
    }
  });

  it('splits a definition into tokens on whitespace', () => {
    expect(definitionTokens('a slight wind (usually refreshing)')).toEqual([
      'a',
      'slight',
      'wind',
      '(usually',
      'refreshing)',
    ]);
    expect(definitionTokens('  two\twords\n ')).toEqual(['two', 'words']);
    expect(definitionTokens('')).toEqual([]);
  });
});

describe('applyCluesTurn', () => {
  it('asks every board word exactly once, three steps each, in the seeded order, over 48 turns', () => {
    const s = createCluesState(SEED, POOL);
    const asked: number[] = [];
    while (!s.over) {
      asked.push(answerIndex(s));
      applyCluesTurn(s, BOARD, [null, null]);
    }
    expect(asked).toEqual(createCluesState(SEED, POOL).order.flatMap((i) => [i, i, i]));
    expect(s.turn).toBe(CLUES_TURNS);
    expect(() => answerIndex(s)).toThrow(/over/);
  });

  it('gives +1 to each right seat at every step (both can score), and null for no answer', () => {
    const s = createCluesState(SEED, POOL);
    const answer = answerOf(s);
    const both = applyCluesTurn(s, BOARD, [
      { choice: answer, latencyMs: 120.4 },
      { choice: answer, latencyMs: 99.5 },
    ]);
    expect(both.correct).toEqual([true, true]);
    expect(s.scores).toEqual([1, 1]);

    // Step 2 of the same word.
    expect(answerOf(s)).toBe(answer);
    const one = applyCluesTurn(s, BOARD, [{ choice: wrongOf(s), latencyMs: 50 }, null]);
    expect(one.correct).toEqual([false, null]);
    expect(one.events).toEqual([
      { kind: 'clue', turn: 1, word: 0, step: 2, correct: [false, false] },
    ]);

    // Step 3: right again for seat 1; the word's reveal follows its clue event.
    const three = applyCluesTurn(s, BOARD, [
      { choice: null, latencyMs: 300 },
      { choice: answer, latencyMs: 200 },
    ]);
    expect(three.correct).toEqual([null, true]);
    expect(three.events).toEqual([
      { kind: 'clue', turn: 2, word: 0, step: 3, correct: [false, true] },
      { kind: 'reveal', turn: 2, word: 0, answer },
    ]);

    expect(s).toMatchObject({
      turn: 3,
      scores: [1, 2],
      correctCount: [1, 2],
      // Math.round per correct answer: 120.4 -> 120, 99.5 -> 100, + 200.
      correctLatencyMs: [120, 300],
      over: false,
    });
    expect(answerOf(s)).not.toBe(answer);
  });

  it('scores up to 3 for a word known from its first step', () => {
    const s = createCluesState(SEED, POOL);
    for (let step = 0; step < CLUES_STEPS; step++) {
      applyCluesTurn(s, BOARD, [
        { choice: answerOf(s), latencyMs: 10 },
        { choice: step === 2 ? answerOf(s) : wrongOf(s), latencyMs: 10 },
      ]);
    }
    expect(s.scores).toEqual([3, 1]);
  });

  it('emits a clue event every step and one reveal per word, after its third step', () => {
    const s = createCluesState(SEED, POOL);
    const kinds: string[] = [];
    while (!s.over) {
      for (const e of applyCluesTurn(s, BOARD, [null, null]).events) kinds.push(e.kind);
    }
    expect(kinds.filter((k) => k === 'clue')).toHaveLength(CLUES_TURNS);
    expect(kinds.filter((k) => k === 'reveal')).toHaveLength(CLUES_WORDS);
    expect(kinds.slice(0, 7)).toEqual(['clue', 'clue', 'clue', 'reveal', 'clue', 'clue', 'clue']);
  });

  it('ends after 48 turns and refuses another', () => {
    const s = createCluesState(SEED, POOL);
    for (let t = 0; t < CLUES_TURNS; t++) {
      expect(s.over).toBe(false);
      applyCluesTurn(s, BOARD, [null, null]);
    }
    expect(s.over).toBe(true);
    expect(() => applyCluesTurn(s, BOARD, [null, null])).toThrow(/over/);
  });

  it('rejects a board that is not 16 words', () => {
    const s = createCluesState(SEED, POOL);
    expect(() => applyCluesTurn(s, { words: BOARD.words.slice(1) }, [null, null])).toThrow(
      /16 words/,
    );
  });
});

/**
 * Plays all 48 turns: seat i is right on the turns in `right[i]` (wrong otherwise) with latency
 * `latency[i]`.
 */
function play(
  right: readonly [readonly number[], readonly number[]],
  latency: readonly [number, number],
): CluesState {
  const s = createCluesState(SEED, POOL);
  while (!s.over) {
    const t = s.turn;
    const answer = (seat: Seat): TurnAnswer => ({
      choice: right[seat].includes(t) ? answerOf(s) : wrongOf(s),
      latencyMs: latency[seat],
    });
    applyCluesTurn(s, BOARD, [answer(0), answer(1)]);
  }
  return s;
}

describe('cluesResult', () => {
  it('has no winner while the game runs', () => {
    const s = createCluesState(SEED, POOL);
    applyCluesTurn(s, BOARD, [{ choice: answerOf(s), latencyMs: 5 }, null]);
    expect(cluesResult(s)).toEqual({ over: false, winner: null, scores: [1, 0] });
  });

  it('gives the win to the higher score, however slow', () => {
    expect(cluesResult(play([[0, 1, 2], [0]], [900, 10]))).toEqual({
      over: true,
      winner: 0,
      scores: [3, 1],
    });
    expect(cluesResult(play([[4], [5, 6]], [10, 900])).winner).toBe(1);
  });

  it('breaks a tie on the lower mean latency over correct answers', () => {
    expect(
      cluesResult(
        play(
          [
            [0, 1],
            [3, 4],
          ],
          [300, 299],
        ),
      ).winner,
    ).toBe(1);
    expect(
      cluesResult(
        play(
          [
            [0, 1],
            [3, 4],
          ],
          [200, 201],
        ),
      ).winner,
    ).toBe(0);
  });

  it('compares means with integers after rounding each latency', () => {
    // 200.4 and 200.2 both round to 200: equal means, a draw.
    expect(cluesResult(play([[5], [6]], [200.4, 200.2])).winner).toBe('draw');
    // 200.5 rounds to 201, 200.4 to 200.
    expect(cluesResult(play([[5], [6]], [200.5, 200.4])).winner).toBe(1);
  });

  it('draws on equal scores and equal means, and when nobody is right', () => {
    expect(
      cluesResult(
        play(
          [
            [0, 9],
            [4, 7],
          ],
          [150, 150],
        ),
      ).winner,
    ).toBe('draw');
    expect(cluesResult(play([[], []], [10, 20]))).toEqual({
      over: true,
      winner: 'draw',
      scores: [0, 0],
    });
  });

  it('lets any correct answer beat none on the latency tie-break', () => {
    // Unreachable through play (scores equal correct counts) but defined: a seat with no correct
    // answer has no mean latency and loses the tie-break to one that has.
    const s = play([[], []], [10, 10]);
    s.scores = [2, 2];
    s.correctCount = [0, 2];
    s.correctLatencyMs = [0, 900];
    expect(cluesResult(s).winner).toBe(1);
    s.correctCount = [2, 0];
    s.correctLatencyMs = [900, 0];
    expect(cluesResult(s).winner).toBe(0);
  });
});

describe('cloneCluesState', () => {
  it('copies every field and shares no arrays', () => {
    const s = play([[1], [2]], [100, 200]);
    const c = cloneCluesState(s);
    expect(c).toEqual(s);
    expect(c.order).not.toBe(s.order);
    expect(c.scores).not.toBe(s.scores);
    expect(c.correctCount).not.toBe(s.correctCount);
    expect(c.correctLatencyMs).not.toBe(s.correctLatencyMs);
  });
});

describe('hashCluesState', () => {
  it('is 16 hex chars, stable, and the same for a clone', () => {
    const s = createCluesState(SEED, POOL);
    expect(hashCluesState(s)).toMatch(/^[0-9a-f]{16}$/);
    expect(hashCluesState(createCluesState(SEED, POOL))).toBe(hashCluesState(s));
    expect(hashCluesState(cloneCluesState(s))).toBe(hashCluesState(s));
  });

  it('pins the hash of a fixed state (the encoding must not drift silently)', () => {
    const s: CluesState = {
      seed: 7,
      boardIndex: 3,
      order: Array.from({ length: CLUES_WORDS }, (_, i) => CLUES_WORDS - 1 - i),
      turn: 5,
      scores: [2, 1],
      correctCount: [2, 1],
      correctLatencyMs: [400, 180],
      over: false,
    };
    // Encoding version 2 (game version 2); version 1 hashed this state to 325b8beb8023eb00.
    expect(hashCluesState(s)).toBe('dbc78d0ed4f4f59f');
  });

  it('covers every key of the state', () => {
    const s = play([[1, 2], [2]], [100, 250]);
    s.over = false;
    expect([...HASHED_KEYS].sort()).toEqual(Object.keys(s).sort());
    const base = hashCluesState(s);
    const mutations: Record<keyof CluesState, (x: CluesState) => void> = {
      seed: (x) => (x.seed += 1),
      boardIndex: (x) => (x.boardIndex += 1),
      order: (x) => {
        const [a = 0, b = 0] = x.order;
        x.order[0] = b;
        x.order[1] = a;
      },
      turn: (x) => (x.turn -= 1),
      scores: (x) => (x.scores[1] += 1),
      correctCount: (x) => (x.correctCount[0] += 1),
      correctLatencyMs: (x) => (x.correctLatencyMs[1] += 1),
      over: (x) => (x.over = !x.over),
    };
    for (const key of HASHED_KEYS) {
      const c = cloneCluesState(s);
      mutations[key](c);
      expect(hashCluesState(c), key).not.toBe(base);
    }
    // Swapping the two seats' values is a different state too.
    const swapped = cloneCluesState(s);
    swapped.correctLatencyMs = [s.correctLatencyMs[1], s.correctLatencyMs[0]];
    expect(hashCluesState(swapped)).not.toBe(base);
  });

  it('throws on a non-integer number rather than hash it lossily', () => {
    const s = createCluesState(SEED, POOL);
    s.correctLatencyMs[0] = 1.5;
    expect(() => hashCluesState(s)).toThrow(/integer/);
  });

  it('gives the same final hash for the same answers, and another for others', () => {
    const a = play(
      [
        [0, 3, 8],
        [3, 9],
      ],
      [250, 180],
    );
    const b = play(
      [
        [0, 3, 8],
        [3, 9],
      ],
      [250, 180],
    );
    expect(hashCluesState(b)).toBe(hashCluesState(a));
    expect(
      hashCluesState(
        play(
          [
            [0, 3],
            [3, 9],
          ],
          [250, 180],
        ),
      ),
    ).not.toBe(hashCluesState(a));
  });
});

describe('engine purity', () => {
  it('bans nondeterministic globals in src/games/*/engine', async () => {
    const eslint = new ESLint({ overrideConfig: tseslint.configs.disableTypeChecked });
    const code = [
      'export const a = Math.random();',
      'export const b = Date.now();',
      'export const c = performance.now();',
      'export const d = window.innerWidth;',
      'export const e = document.title;',
      '',
    ].join('\n');
    const [result] = await eslint.lintText(code, {
      filePath: 'src/games/clues/engine/__lint_probe__.ts',
    });
    const restricted = (result?.messages ?? []).filter(
      (m) => m.ruleId === 'no-restricted-globals' || m.ruleId === 'no-restricted-properties',
    );
    expect(restricted).toHaveLength(5);
  }, 30_000);
});
