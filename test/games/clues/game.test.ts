import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { orderOptions } from '../../../src/core/classifier/order.js';
import type { Seat } from '../../../src/core/classifier/types.js';
import { validateQuestion, type Game } from '../../../src/core/game.js';
import { CLUES_BOARDS, CLUES_BOARDS_SHA256, boardAt } from '../../../src/games/clues/data.js';
import type { CluesBoardsFile } from '../../../src/games/clues/data-build.js';
import { cluesBoardOf, cluesGame, type CluesConfig } from '../../../src/games/clues/game.js';
import { turnStep, turnWord } from '../../../src/games/clues/engine/engine.js';
import { CLUES_TURNS, CLUES_WORDS } from '../../../src/games/clues/engine/types.js';
import { CLUES_PROMPT_CONFIG } from '../../../src/games/clues/prompt.js';
import { GAME_OVER_VIEW, partialDefinition } from '../../../src/games/clues/view.js';
import { GAMES, getGame } from '../../../src/games/index.js';

const g = cluesGame;
const SEED = 20261007;
const SEATS: readonly Seat[] = [0, 1];
const jsonRoundTrip = (v: unknown): unknown => JSON.parse(JSON.stringify(v));

/** The current turn's answer (option id), read from the board. */
function answerOf(s: ReturnType<typeof g.create>): string {
  const index = s.order[turnWord(s.turn)];
  const lemma = index === undefined ? undefined : cluesBoardOf(s).words[index]?.lemma;
  if (lemma === undefined) throw new Error('no answer');
  return lemma;
}

describe('data', () => {
  it('loads every committed board, with the build sha256', () => {
    const file = JSON.parse(readFileSync('data/clues/boards.json', 'utf8')) as CluesBoardsFile;
    expect(CLUES_BOARDS).toEqual(file.boards);
    expect(CLUES_BOARDS_SHA256).toBe(file.build.sha256);
  });

  it('finds boards by index, and rejects a missing one', () => {
    expect(boardAt(0).id).toBe('b001');
    expect(boardAt(28).id).toBe('b029');
    expect(() => boardAt(CLUES_BOARDS.length)).toThrow(/no clue board/);
  });
});

describe('cluesGame identity', () => {
  it('is the turn game "clues", graded, with only the core random baseline', () => {
    expect(g).toMatchObject({
      id: 'clues',
      label: 'Clue Clash',
      version: 2,
      cadence: { kind: 'turns' },
      graded: true,
      baselines: [],
    });
    expect('createBaseline' in g).toBe(false);
    expect(g.promptConfig).toBe(CLUES_PROMPT_CONFIG);
    expect(g.maxTurns(g.defaultConfig)).toBe(48);
  });

  it('estimates 48 decisions per seat (16 words × 3 steps) and the measured input tokens', () => {
    expect(g.estimate).toEqual({
      decisionsPerSeat: { typical: 48, worst: 48 },
      inputTokens: { jev: 630, openai: 320 },
      fallbackInputTokens: 650,
    });
  });

  it('is registered in GAMES', () => {
    const erased: Game = g;
    expect(GAMES).toContain(erased);
    expect(getGame('clues')).toBe(g);
  });
});

describe('config', () => {
  it('names the committed board set, and the match draws from every board in it', () => {
    expect(g.defaultConfig).toEqual({
      boardsSha256: CLUES_BOARDS_SHA256,
      boardCount: CLUES_BOARDS.length,
    });
    const seen = new Set<number>();
    for (let seed = 0; seed < 2000; seed++) seen.add(g.create(seed, g.defaultConfig).boardIndex);
    // Seeded, so deterministic: 2,000 seeds reach every committed board.
    expect(seen.size).toBe(CLUES_BOARDS.length);
  });

  it('refuses a config for other boards', () => {
    const other: CluesConfig = { ...g.defaultConfig, boardsSha256: '0'.repeat(64) };
    expect(() => g.create(SEED, other)).toThrow(/clue boards differ/);
    expect(() => g.create(SEED, { ...g.defaultConfig, boardCount: 3 })).toThrow(/differ/);
  });

  it('logs the board set identity, never the boards themselves', () => {
    const logged = g.logConfig(g.defaultConfig);
    expect(logged).toEqual({ boardsSha256: CLUES_BOARDS_SHA256, boardCount: CLUES_BOARDS.length });
    expect(jsonRoundTrip(logged)).toEqual(logged);
    expect(JSON.stringify(logged).length).toBeLessThan(200);
  });

  it('round-trips through the log: configFromLog(logConfig(c)) replays the same match', () => {
    const logged = jsonRoundTrip(g.logConfig(g.defaultConfig)) as Record<string, unknown>;
    const config = g.configFromLog(logged);
    expect(config).toEqual(g.defaultConfig);
    expect(g.logConfig(config)).toEqual(logged);
    for (const seed of [0, 1, SEED, 0xffffffff]) {
      expect(g.hash(g.create(seed, config))).toBe(g.hash(g.create(seed, g.defaultConfig)));
    }
  });

  it('configFromLog throws for other boards or a malformed config', () => {
    const logged = g.logConfig(g.defaultConfig);
    expect(() => g.configFromLog({ ...logged, boardsSha256: 'f'.repeat(64) })).toThrow(
      /clue boards differ/,
    );
    expect(() => g.configFromLog({ ...logged, boardCount: CLUES_BOARDS.length - 1 })).toThrow(
      /clue boards differ/,
    );
    expect(() => g.configFromLog({ boardCount: CLUES_BOARDS.length })).toThrow(/expected/);
    expect(() => g.configFromLog({})).toThrow(/expected/);
  });
});

describe('contract', () => {
  it('creates the same state for the same seed and another for another seed', () => {
    const a = g.create(SEED, g.defaultConfig);
    expect(g.hash(a)).toMatch(/^[0-9a-f]{16}$/);
    expect(g.hash(g.create(SEED, g.defaultConfig))).toBe(g.hash(a));
    expect(g.hash(g.create(SEED + 1, g.defaultConfig))).not.toBe(g.hash(a));
    expect(g.turn(a)).toBe(0);
  });

  it('keeps the hash across clone, and a clone is independent', () => {
    const s = g.create(SEED, g.defaultConfig);
    for (let i = 0; i < 3; i++) g.applyTurn(s, [null, null]);
    const before = g.hash(s);
    const c = g.clone(s);
    expect(c).not.toBe(s);
    expect(g.hash(c)).toBe(before);
    g.applyTurn(c, [{ choice: answerOf(c), latencyMs: 100 }, null]);
    expect(g.hash(c)).not.toBe(before);
    expect(g.hash(s)).toBe(before);
  });

  it('runs 48 turns with no answers to a 0-0 draw, then stops asking', () => {
    const s = g.create(SEED, g.defaultConfig);
    let turns = 0;
    while (!g.result(s).over) {
      expect(g.result(s).winner).toBeNull();
      g.applyTurn(s, [null, null]);
      turns++;
    }
    expect(turns).toBe(CLUES_TURNS);
    expect(g.result(s)).toEqual({ over: true, winner: 'draw', scores: [0, 0] });
    for (const seat of SEATS) {
      expect(g.question(s, seat)).toBeNull();
      expect(g.view(s, seat)).toEqual(GAME_OVER_VIEW);
    }
    expect(() => g.applyTurn(s, [null, null])).toThrow(/over/);
  });
});

describe('view and question', () => {
  it('shows both seats the current word’s definition as revealed so far, the part of speech and the step', () => {
    const s = g.create(SEED, g.defaultConfig);
    const board = cluesBoardOf(s);
    for (let t = 0; t < CLUES_TURNS; t++) {
      const word = board.words[s.order[turnWord(t)] ?? -1];
      if (!word) throw new Error('no word');
      const tokens = word.definition.split(' ');
      const shown = Math.ceil((tokens.length * turnStep(t)) / 3);
      const partial = shown < tokens.length;
      const expected = {
        definition: tokens.slice(0, shown).join(' ') + (partial ? ' …' : ''),
        part_of_speech: board.pos,
        reveal_step: `${String(turnStep(t))}/3`,
      };
      for (const seat of SEATS) {
        const v = g.view(s, seat);
        expect(v).toEqual(expected);
        expect(jsonRoundTrip(v)).toEqual(v);
      }
      // The third step shows the whole definition, exactly as committed.
      if (turnStep(t) === 3) expect(expected.definition).toBe(word.definition);
      g.applyTurn(s, [null, null]);
    }
  });

  it('grows the definition step by step: each step’s text starts with the last one’s words', () => {
    const definition = 'a light brief snowfall and gust of wind (or something resembling that)';
    expect(partialDefinition(definition, 1)).toBe('a light brief snowfall …');
    expect(partialDefinition(definition, 2)).toBe('a light brief snowfall and gust of wind …');
    expect(partialDefinition(definition, 3)).toBe(definition);
    // Four words: 2, then 3, then 4. Two words would show all of it at step 2, with no " …".
    expect(partialDefinition('one two three four', 1)).toBe('one two …');
    expect(partialDefinition('one two', 2)).toBe('one two');
    expect(partialDefinition('one two', 1)).toBe('one …');
  });

  it('keeps every committed definition whitespace-normalised, at least 4 words long', () => {
    for (const board of CLUES_BOARDS) {
      for (const w of board.words) {
        const tokens = w.definition.split(/\s+/).filter((x) => x !== '');
        expect(tokens.join(' ')).toBe(w.definition);
        // So steps 1 and 2 always hide part of it.
        expect(tokens.length).toBeGreaterThanOrEqual(4);
      }
    }
  });

  it('never shows the answer, the board words or the board id in the view', () => {
    const s = g.create(SEED, g.defaultConfig);
    const board = cluesBoardOf(s);
    expect(Object.keys(g.view(s, 0) as object).sort()).toEqual([
      'definition',
      'part_of_speech',
      'reveal_step',
    ]);
    expect(JSON.stringify(g.view(s, 0))).not.toContain(board.id);
  });

  it('asks both seats t<word> for all three steps, with all 16 board words in board order', () => {
    const s = g.create(SEED, g.defaultConfig);
    const board = cluesBoardOf(s);
    const keys: string[] = [];
    while (!s.over) {
      const [q0, q1] = SEATS.map((seat) => g.question(s, seat));
      if (!q0 || !q1) throw new Error('no question');
      expect(q1).toEqual(q0);
      expect(q0.question.name).toBe('which_word');
      expect(q0.question.instructions).toBe(CLUES_PROMPT_CONFIG.primer);
      expect(q0.question.options).toEqual(
        board.words.map((w) => ({ id: w.lemma, description: `The word "${w.lemma}".` })),
      );
      expect(q0.question.options.map((o) => o.id)).toContain(answerOf(s));
      keys.push(q0.key);
      g.applyTurn(s, [null, null]);
    }
    expect(keys).toEqual(
      Array.from({ length: CLUES_WORDS }, (_, w) => `t${String(w)}`).flatMap((k) => [k, k, k]),
    );
  });

  it('builds a valid question on every committed board, in canonical and match order', () => {
    for (let i = 0; i < CLUES_BOARDS.length; i++) {
      const s = g.create(SEED, g.defaultConfig);
      s.boardIndex = i;
      const asked = g.question(s, 0);
      if (!asked) throw new Error('no question');
      expect(() => {
        validateQuestion(asked.question);
        validateQuestion(orderOptions(asked.question, SEED, asked.key));
      }).not.toThrow();
      expect(asked.question.options).toHaveLength(16);
    }
  });
});

describe('applyTurn', () => {
  it('scores the answer by option id and reveals it', () => {
    const s = g.create(SEED, g.defaultConfig);
    const answer = answerOf(s);
    const wrong = cluesBoardOf(s).words.find((w) => w.lemma !== answer)?.lemma ?? '';
    const out = g.applyTurn(s, [
      { choice: wrong, latencyMs: 210 },
      { choice: answer, latencyMs: 340.6 },
    ]);
    expect(out).toEqual({
      correct: [false, true],
      events: [{ kind: 'clue', turn: 0, word: 0, step: 1, correct: [false, true] }],
    });
    expect(g.result(s).scores).toEqual([0, 1]);
    expect(s.correctLatencyMs).toEqual([0, 341]);
    g.applyTurn(s, [null, null]);
    expect(g.applyTurn(s, [null, null]).events.at(-1)).toEqual({
      kind: 'reveal',
      turn: 2,
      word: 0,
      answer,
    });
  });
});
