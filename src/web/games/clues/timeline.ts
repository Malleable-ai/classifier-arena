import type { Seat } from '../../../core/classifier/types.js';
import type { MatchLog } from '../../../core/log/read.js';
import type { DecisionLine } from '../../../core/log/schema.js';
import { createReplayCursor } from '../../../core/replay/replay.js';
import { boardAt } from '../../../games/clues/data.js';
import type { CluesBoard, CluesPos } from '../../../games/clues/data-build.js';
import {
  cluesResult,
  definitionTokens,
  revealedCount,
  turnStep,
  turnWord,
} from '../../../games/clues/engine/engine.js';
import {
  CLUES_STEPS,
  CLUES_TURNS,
  CLUES_WORDS,
  type CluesState,
} from '../../../games/clues/engine/types.js';
import { cluesGame } from '../../../games/clues/game.js';
import { END_HOLD_FRAMES, frameBase, latestPerSeat } from '../../shell/frames.js';
import type { FrameInfo, InFlight, SeatPair, Timeline } from '../index.js';

/**
 * Clue Clash as frames at 60 fps. A turn game has no ticks, so the timeline makes its own. A turn
 * is one reveal step of a word (three per word, 48 a match): the step's new words appear
 * (PROMPT), each seat's answer lands on its board at that seat's logged latency shown in real time
 * (1 ms of latency is 1 ms on screen, capped at 1 s), then the step is scored and held (SCORE: the
 * score ticks up, the pick is marked) so that a step lasts at least STEP_MIN_FRAMES. After a
 * word's third step the right word is revealed (REVEAL). After the last turn the result holds for
 * END_FRAMES (2.5 s). At typical latencies a word takes 5.1 s and a match about 82 s.
 *
 * `FrameInfo.tick` is the number of turns played, as the shell expects for turn games, and
 * `state` is the game state after that many turns: during turn t it is t until the step is scored,
 * then t + 1. So `window.__arena.turn` and `__arena.state.scores` always match the scores on
 * screen, and the last frame's hash is the log's final hash. The turn on screen is `scene.turn`.
 * A seat's line for the turn on screen joins `decisions` (and the panel, see shell/stage.ts) the
 * frame its answer lands on its board, before the turn is played. `inFlight` holds a seat's request
 * for the step on screen from the step's prompt until that answer lands, and nothing in the score
 * phase, the reveal or the end hold (`stepInFlight`), so the panel says "thinking…" exactly while
 * the stage waits on that seat.
 */

export const FPS = 60;
/** The step's new words fade in: 0.3 s. */
export const PROMPT_FRAMES = 18;
/** Answers land at their latency, at most 1 s after the prompt. */
export const ANSWER_CAP_FRAMES = 60;
/** Once both answers are in, the step is scored and held at least 0.4 s. */
export const SCORE_MIN_FRAMES = 24;
/** A step (prompt, answers, score) lasts at least 1.2 s, so a viewer can read it. */
export const STEP_MIN_FRAMES = 72;
/** After a word's third step, the right word is shown and held: 1.5 s. */
export const REVEAL_FRAMES = 90;
/** The result after the last turn: every game's end hold, 2.5 s. */
export const END_FRAMES = END_HOLD_FRAMES;
/** A seat's tiles shift to the step's shading over 0.2 s once its answer lands. */
export const SHADE_FRAMES = 12;
/** The score pops (and its "+1" rises) over the first 0.5 s of the score phase. */
export const POP_FRAMES = 30;
/** The step's new words fade in over 0.2 s. */
export const TEXT_FADE_FRAMES = 12;
/** Frames the reveal border takes to grow in. */
export const REVEAL_RAMP_FRAMES = 8;

export type CluePhase = 'prompt' | 'answer' | 'score' | 'reveal' | 'end';

/** A logged latency as frames after the prompt, 1:1 in time: ms × 60 / 1000, capped at 1 s. */
export function latencyFrames(latencyMs: number | null): number {
  if (latencyMs === null || !Number.isFinite(latencyMs)) return ANSWER_CAP_FRAMES;
  return Math.min(ANSWER_CAP_FRAMES, Math.max(0, Math.round((latencyMs * FPS) / 1000)));
}

/** One turn's frames. Every bound is a frame index; `end` is exclusive (the next turn's start). */
export interface TurnSlot {
  turn: number;
  /** The word (index into the seeded order) and the reveal step (1..3) the turn asks. */
  word: number;
  step: number;
  start: number;
  answerStart: number;
  /** The frame each seat's answer lands (shown from this frame on). */
  arrive: SeatPair<number>;
  /** Both answers are in (the later arrival): the step is scored. */
  scoreStart: number;
  /** The word's reveal, after its third step; null on steps 1 and 2. */
  revealStart: number | null;
  end: number;
}

export interface Schedule {
  slots: TurnSlot[];
  /** Frame count, the end hold included. */
  frames: number;
}

/**
 * Lays out the turns from each seat's logged latency per turn (null: no line, or one that
 * never answered in time, which lands at the cap).
 */
export function scheduleTurns(latencies: readonly SeatPair<number | null>[]): Schedule {
  const slots: TurnSlot[] = [];
  let at = 0;
  for (const [turn, pair] of latencies.entries()) {
    const step = turnStep(turn);
    const answerStart = at + PROMPT_FRAMES;
    const arrive: SeatPair<number> = [
      answerStart + latencyFrames(pair[0]),
      answerStart + latencyFrames(pair[1]),
    ];
    const scoreStart = Math.max(arrive[0], arrive[1]);
    const scoreEnd = Math.max(scoreStart + SCORE_MIN_FRAMES, at + STEP_MIN_FRAMES);
    const revealStart = step === CLUES_STEPS ? scoreEnd : null;
    const end = revealStart === null ? scoreEnd : revealStart + REVEAL_FRAMES;
    slots.push({
      turn,
      word: turnWord(turn),
      step,
      start: at,
      answerStart,
      arrive,
      scoreStart,
      revealStart,
      end,
    });
    at = end;
  }
  return { slots, frames: at + END_FRAMES };
}

export interface FramePosition {
  /** The frame, clamped to the schedule. */
  frame: number;
  /** The turn on screen (the last one during the end hold; 0 when there are no turns). */
  turn: number;
  phase: CluePhase;
  /** Frames into the phase (0-based). */
  phaseFrame: number;
  /** The phase's length in frames. */
  phaseFrames: number;
  /** The turn's slot; null in a schedule with no turns. */
  slot: TurnSlot | null;
}

/** Which turn and phase frame `n` falls in (clamped to the schedule). */
export function locateFrame(schedule: Schedule, n: number): FramePosition {
  const { slots, frames } = schedule;
  const frame = Math.max(0, Math.min(frames - 1, Math.floor(n)));
  const last = slots.at(-1);
  if (last === undefined || frame >= last.end) {
    const endStart = last?.end ?? 0;
    return {
      frame,
      turn: Math.max(0, slots.length - 1),
      phase: 'end',
      phaseFrame: frame - endStart,
      phaseFrames: END_FRAMES,
      slot: last ?? null,
    };
  }
  // Binary search for the slot with start <= frame < end.
  let lo = 0;
  let hi = slots.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((slots[mid]?.start ?? 0) <= frame) lo = mid;
    else hi = mid - 1;
  }
  const slot = slots[lo] ?? last;
  const scoreEnd = slot.revealStart ?? slot.end;
  const bounds: [CluePhase, number, number][] = [
    ['prompt', slot.start, slot.answerStart],
    ['answer', slot.answerStart, slot.scoreStart],
    ['score', slot.scoreStart, scoreEnd],
    ['reveal', scoreEnd, slot.end],
  ];
  const [phase, from, to] = bounds.find(([, f, t]) => frame >= f && frame < t) ?? [
    'score',
    slot.scoreStart,
    scoreEnd,
  ];
  return { frame, turn: slot.turn, phase, phaseFrame: frame - from, phaseFrames: to - from, slot };
}

/** Turns played at a position: the turn on screen counts once it is scored. */
export function turnsPlayed(pos: FramePosition, turns: number): number {
  if (pos.phase === 'end') return turns;
  return pos.phase === 'score' || pos.phase === 'reveal' ? pos.turn + 1 : pos.turn;
}

/**
 * The frame's decisions: the lines of the turns played, then the lines of the turn on screen
 * whose answers have landed by `frame` (earlier arrival first, seat 0 first on a tie).
 */
export function landedDecisions(
  played: readonly DecisionLine[],
  current: SeatPair<DecisionLine | null>,
  arrive: SeatPair<number>,
  frame: number,
): DecisionLine[] {
  const landed = ([0, 1] as const)
    .filter((seat) => current[seat] !== null && frame >= arrive[seat])
    .sort((a, b) => arrive[a] - arrive[b] || a - b)
    .map((seat) => current[seat])
    .filter((d): d is DecisionLine => d !== null && !played.includes(d));
  return [...played, ...landed];
}

/**
 * Each seat's request for the step on screen, from the step's prompt until that seat's answer
 * lands; null in the score phase, the reveal and the end hold. `generic` is `frameBase`'s
 * `inFlight` at the frame's tick, which can't tell these phases apart: the score phase counts the
 * turn as played (tick t + 1), the same tick as the next step's prompt, so it would call the next
 * step's request out while this step's answers and marks are on screen. During the prompt and
 * answer phases the tick is t and `generic` holds this step's requests (seq, question key and sent
 * turn, never an answer).
 */
export function stepInFlight(
  generic: SeatPair<InFlight | null>,
  pos: FramePosition,
  slot: TurnSlot,
): SeatPair<InFlight | null> {
  const asking = pos.phase === 'prompt' || pos.phase === 'answer';
  const out = (seat: Seat): InFlight | null =>
    asking && pos.frame < slot.arrive[seat] ? generic[seat] : null;
  return [out(0), out(1)];
}

// ---------------------------------------------------------------------------------------------
// The scene: everything the stage draws for one frame, from the board, the turn and its lines.

/** How a seat did on one step: a right pick (+1), a wrong pick, or no answer. */
export type StepMark = 'right' | 'wrong' | 'miss';

export interface SeatTurn {
  /** This seat's decision line for the turn (null: none, yet or at all). */
  line: DecisionLine | null;
  /** Its answer (or miss) is on the board by this frame. */
  arrived: boolean;
  /** 0 → 1 over SHADE_FRAMES once it arrived: the shading shifts from the last step's to this. */
  shade: number;
  /** The pick (an option id, the lemma) once arrived; null for a miss. */
  choice: string | null;
  /** API-reported probability per option id, once arrived; null when none were reported. */
  probabilities: Readonly<Record<string, number>> | null;
  /** The same word's previous step's probabilities (null on step 1 or after a miss). */
  prevProbabilities: Readonly<Record<string, number>> | null;
  /** Arrived without an answer (timeout, error): the board shows "no answer". */
  miss: boolean;
  /** Per step of the word on screen (index = step − 1): its mark once scored, else null. */
  marks: readonly (StepMark | null)[];
}

export interface MatchOutcome {
  winner: Seat | 'draw' | null;
  scores: SeatPair<number>;
  /** Equal scores, decided by the lower mean latency on correct answers. */
  onSpeed: boolean;
  /** Each seat's mean latency (ms) over its correct answers (the tiebreak); null with none. */
  meanCorrectMs: SeatPair<number | null>;
}

export interface CluesScene {
  /** The turn on screen, 0-based. */
  turn: number;
  turns: number;
  /** The word on screen (0-based, "Word word + 1 / wordCount") and its reveal step (1-based). */
  word: number;
  wordCount: number;
  step: number;
  steps: number;
  phase: CluePhase;
  phaseFrame: number;
  phaseFrames: number;
  pos: CluesPos;
  /** The whole definition, split into words; the first `shownTokens` are revealed. */
  tokens: readonly string[];
  shownTokens: number;
  /** Words the previous step had revealed (0 on step 1): the rest of `shownTokens` are new. */
  prevShownTokens: number;
  /** 0 → 1 as the step's new words fade in; 1 after the prompt. */
  textFade: number;
  /** The 16 board words (option ids, the lemmas) in board order, w01..w16. */
  words: readonly string[];
  /** The word the definition defines. */
  answer: string;
  seats: SeatPair<SeatTurn>;
  /** 0 before the reveal, ramping to 1 over its first frames, then 1. */
  reveal: number;
  /** The scores the boards show (before the score phase: the turn's starting scores). */
  scores: SeatPair<number>;
  /** Seats that scored on this step. */
  scored: SeatPair<boolean>;
  /** 0 → 1 over POP_FRAMES from the start of the score phase; 0 before it, 1 after. */
  scoreTick: number;
  /** The result, during the end hold only. */
  outcome: MatchOutcome | null;
}

export interface CluesFrame extends FrameInfo<CluesState> {
  scene: CluesScene;
}

/** The outcome of a finished state (`cluesResult`), with whether speed broke a tie. */
export function outcomeOf(state: CluesState): MatchOutcome {
  const r = cluesResult(state);
  const mean = (seat: Seat): number | null => {
    const n = state.correctCount[seat];
    return n > 0 ? state.correctLatencyMs[seat] / n : null;
  };
  return {
    winner: r.winner,
    scores: r.scores,
    onSpeed: r.over && r.scores[0] === r.scores[1] && r.winner !== 'draw',
    meanCorrectMs: [mean(0), mean(1)],
  };
}

export interface SceneInput {
  board: CluesBoard;
  /** The turn on screen and the board word it asks (index into `board.words`). */
  turn: number;
  wordIndex: number;
  /**
   * The lines of the word's steps up to the turn on screen (index = step − 1), so the last is
   * this turn's (null for a seat with no line, or none yet).
   */
  wordLines: readonly SeatPair<DecisionLine | null>[];
  phase: CluePhase;
  phaseFrame: number;
  phaseFrames: number;
  /** Frames since each seat's answer landed (negative: not yet). */
  sinceArrival: SeatPair<number>;
  scoresBefore: SeatPair<number>;
  scoresAfter: SeatPair<number>;
  outcome: MatchOutcome | null;
}

/** A line's mark: right, wrong, or no answer (no line, a timeout, an error). */
export function markOf(line: DecisionLine | null): StepMark {
  if (line === null || line.status !== 'ok' || line.choice === null) return 'miss';
  return line.correct === true ? 'right' : 'wrong';
}

const okProbabilities = (line: DecisionLine | null): Readonly<Record<string, number>> | null =>
  line !== null && line.status === 'ok' && line.choice !== null ? line.probabilities : null;

function seatTurn(
  seat: Seat,
  input: SceneInput,
  step: number,
  since: number,
  scored: boolean,
): SeatTurn {
  const line = input.wordLines[step - 1]?.[seat] ?? null;
  const prev = step > 1 ? (input.wordLines[step - 2]?.[seat] ?? null) : null;
  const arrived = since >= 0;
  const ok = line !== null && line.status === 'ok' && line.choice !== null;
  const marks = Array.from({ length: CLUES_STEPS }, (_, k): StepMark | null => {
    if (k + 1 > step || (k + 1 === step && !scored)) return null;
    return markOf(input.wordLines[k]?.[seat] ?? null);
  });
  return {
    line,
    arrived,
    shade: arrived ? Math.min(1, (since + 1) / SHADE_FRAMES) : 0,
    choice: arrived && ok ? line.choice : null,
    probabilities: arrived && ok ? line.probabilities : null,
    prevProbabilities: okProbabilities(prev),
    miss: arrived && !ok,
    marks,
  };
}

const AFTER_ANSWERS: readonly CluePhase[] = ['score', 'reveal', 'end'];

export function buildScene(input: SceneInput): CluesScene {
  const word = input.board.words[input.wordIndex];
  if (word === undefined) {
    throw new Error(`board ${input.board.id} has no word ${String(input.wordIndex)}`);
  }
  const { phase, phaseFrame } = input;
  const step = turnStep(input.turn);
  const tokens = definitionTokens(word.definition);
  const reveal =
    phase === 'reveal'
      ? Math.min(1, (phaseFrame + 1) / REVEAL_RAMP_FRAMES)
      : phase === 'end'
        ? 1
        : 0;
  const scoreTick =
    phase === 'score'
      ? Math.min(1, (phaseFrame + 1) / POP_FRAMES)
      : phase === 'reveal' || phase === 'end'
        ? 1
        : 0;
  const after = AFTER_ANSWERS.includes(phase);
  // Once both answers are in, both seats are on the board whatever the arrival frames say.
  const since: SeatPair<number> = after
    ? [Math.max(input.sinceArrival[0], SHADE_FRAMES), Math.max(input.sinceArrival[1], SHADE_FRAMES)]
    : input.sinceArrival;
  return {
    turn: input.turn,
    turns: CLUES_TURNS,
    word: turnWord(input.turn),
    wordCount: CLUES_WORDS,
    step,
    steps: CLUES_STEPS,
    phase,
    phaseFrame,
    phaseFrames: input.phaseFrames,
    pos: input.board.pos,
    tokens,
    shownTokens: revealedCount(tokens.length, step),
    prevShownTokens: step > 1 ? revealedCount(tokens.length, step - 1) : 0,
    textFade: phase === 'prompt' ? Math.min(1, (phaseFrame + 1) / TEXT_FADE_FRAMES) : 1,
    words: input.board.words.map((w) => w.lemma),
    answer: word.lemma,
    seats: [seatTurn(0, input, step, since[0], after), seatTurn(1, input, step, since[1], after)],
    reveal,
    scores: after ? input.scoresAfter : input.scoresBefore,
    scored: [
      input.scoresAfter[0] > input.scoresBefore[0],
      input.scoresAfter[1] > input.scoresBefore[1],
    ],
    scoreTick,
    outcome: input.outcome,
  };
}

/** Per turn, each seat's line for it (the last in log order, as the replay feeds them). */
export function linesByTurn(
  decisions: readonly DecisionLine[],
  turns: number,
): SeatPair<DecisionLine | null>[] {
  const rows: [DecisionLine | null, DecisionLine | null][] = Array.from({ length: turns }, () => [
    null,
    null,
  ]);
  for (const d of decisions) {
    const row = rows[d.appliedTick ?? d.sentTick];
    if (row) row[d.seat] = d;
  }
  return rows;
}

/**
 * The lines of turn `turn`'s word, from its first step to `turn` itself (index = step − 1), out
 * of the per-turn `lines`; `current` replaces the last (live mode: not logged yet).
 */
export function wordLinesUpTo(
  lines: readonly SeatPair<DecisionLine | null>[],
  turn: number,
  current?: SeatPair<DecisionLine | null>,
): SeatPair<DecisionLine | null>[] {
  const first = turnWord(turn) * CLUES_STEPS;
  const out: SeatPair<DecisionLine | null>[] = [];
  for (let t = first; t <= turn; t++) out.push(lines[t] ?? [null, null]);
  if (current !== undefined) out[out.length - 1] = current;
  return out;
}

export interface CluesTimeline extends Timeline<CluesFrame> {
  readonly schedule: Schedule;
  /** Turns the replay plays (match_end's total, or where the re-sim stops). */
  readonly turns: number;
}

const pair = <T>(a: readonly T[]): SeatPair<T> => [a[0] as T, a[1] as T];

export function createCluesTimeline(log: MatchLog): CluesTimeline {
  // Every state, turn by turn, from the core replay (the same answers the scheduler applied).
  const cursor = createReplayCursor(log, cluesGame);
  const states: CluesState[] = [];
  for (let k = 0; k <= cursor.lastTick; k++) {
    cursor.stepTo(k);
    states.push(cluesGame.clone(cursor.state));
  }
  const first = states[0];
  if (first === undefined) throw new Error('unreachable: a replay has a first state');
  const turns = states.length - 1;
  const board = boardAt(first.boardIndex);
  const lines = linesByTurn(log.decisions, turns);
  const schedule = scheduleTurns(
    lines.map(([a, b]) => [a?.latencyMs ?? null, b?.latencyMs ?? null]),
  );
  const [a, b] = log.header.seats;
  const labels: SeatPair<string> = [a.label, b.label];
  const players: SeatPair<string> = [a.player, b.player];
  const finalOutcome = outcomeOf(states[turns] ?? first);
  let current: CluesState = first;

  const at = (n: number): CluesFrame => {
    const pos = locateFrame(schedule, n);
    const played = turnsPlayed(pos, turns);
    const state = states[played] ?? first;
    current = state;
    const base = frameBase({
      frame: pos.frame,
      tick: played,
      state,
      labels,
      players,
      cadence: log.header.cadence,
      decisions: log.decisions,
      events: log.events,
    });
    if (turns === 0 || pos.slot === null) {
      return { ...base, scene: emptyScene(board, finalOutcome) };
    }
    const t = pos.turn;
    const before = states[t] ?? first;
    const after = states[t + 1] ?? before;
    const slot = pos.slot;
    const turnLines = lines[t] ?? [null, null];
    const decisions = landedDecisions(base.decisions, turnLines, slot.arrive, pos.frame);
    const inFlight = stepInFlight(base.inFlight ?? [null, null], pos, slot);
    const scene = buildScene({
      board,
      turn: t,
      wordIndex: before.order[turnWord(t)] ?? 0,
      wordLines: wordLinesUpTo(lines, t),
      phase: pos.phase,
      phaseFrame: pos.phaseFrame,
      phaseFrames: pos.phaseFrames,
      sinceArrival: [pos.frame - slot.arrive[0], pos.frame - slot.arrive[1]],
      scoresBefore: pair(before.scores),
      scoresAfter: pair(after.scores),
      outcome: pos.phase === 'end' ? finalOutcome : null,
    });
    return {
      ...base,
      decisions,
      latestDecisions: latestPerSeat(decisions),
      inFlight,
      scene,
    };
  };

  return {
    frames: schedule.frames,
    schedule,
    turns,
    at,
    hash: () => cluesGame.hash(current),
  };
}

/** A board with no turn to show (a log that stopped before its first turn). */
function emptyScene(board: CluesBoard, outcome: MatchOutcome): CluesScene {
  const none = (): SeatTurn => ({
    line: null,
    arrived: false,
    shade: 0,
    choice: null,
    probabilities: null,
    prevProbabilities: null,
    miss: false,
    marks: [null, null, null],
  });
  return {
    turn: 0,
    turns: CLUES_TURNS,
    word: 0,
    wordCount: CLUES_WORDS,
    step: 1,
    steps: CLUES_STEPS,
    phase: 'end',
    phaseFrame: 0,
    phaseFrames: END_FRAMES,
    pos: board.pos,
    tokens: [],
    shownTokens: 0,
    prevShownTokens: 0,
    textFade: 1,
    words: board.words.map((w) => w.lemma),
    answer: '',
    seats: [none(), none()],
    reveal: 0,
    scores: outcome.scores,
    scored: [false, false],
    scoreTick: 1,
    outcome,
  };
}
