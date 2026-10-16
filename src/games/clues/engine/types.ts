/**
 * Clue Clash state (docs/architecture/clues.md): one board of 16 words, each asked once, in a
 * seeded order, its definition revealed in three steps. Both seats are asked at every step, so a
 * match is 48 turns. Plain data, so it clones, hashes and serialises trivially.
 */

/** Words on a board; each is asked once. */
export const CLUES_WORDS = 16;
/** Reveal steps per word: the definition grows from about a third, to two thirds, to all of it. */
export const CLUES_STEPS = 3;
/** Turns per match: one per reveal step of every board word. */
export const CLUES_TURNS = CLUES_WORDS * CLUES_STEPS;

export interface CluesState {
  /** The match seed (u32). */
  seed: number;
  /** Index of the board in the committed board list (data/clues/boards.json). */
  boardIndex: number;
  /** A permutation of 0..15: the w-th word asked is the board word at index `order[w]`. */
  order: number[];
  /**
   * Turns played so far (0..48). Turn t asks word `floor(t / 3)` of `order` at reveal step
   * `t % 3 + 1` (`turnWord`, `turnStep`).
   */
  turn: number;
  /** +1 per correct answer, per seat. */
  scores: [number, number];
  /** Correct answers per seat (equal to `scores`; kept separately for the latency tie-break). */
  correctCount: [number, number];
  /** Sum of `Math.round(latencyMs)` over each seat's correct answers. */
  correctLatencyMs: [number, number];
  /** True once all 48 turns are played. */
  over: boolean;
}

/**
 * What the engine needs from a board: its words in board order, each with the option id that
 * answers it (the lemma). `CluesBoard` from the data build satisfies it.
 */
export interface CluesBoardWords {
  readonly words: readonly { readonly lemma: string }[];
}
