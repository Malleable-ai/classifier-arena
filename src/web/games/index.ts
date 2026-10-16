import type { Seat } from '../../core/classifier/types.js';
import type { RealtimeInput } from '../../core/game.js';
import type { MatchLog } from '../../core/log/read.js';
import type { DecisionLine, EventLine } from '../../core/log/schema.js';
import { cluesRenderer } from './clues/renderer.js';
import { fighterRenderer } from './fighter/renderer.js';
import { inboxRenderer } from './inbox/renderer.js';

/**
 * Game renderers: how the web draws each game. The shell (src/web/shell) knows no game; it plays a
 * match log through the game's `GameRenderer` (timeline → frames → `draw`), draws the generic
 * decision panel under the stage, and labels options with `optionLabel`. A renderer may import its
 * own game's engine; the shell never does.
 *
 * Methods use method syntax on purpose (bivariant parameters), so a renderer typed over its own
 * state and frame is assignable to the erased `GameRenderer` the registry holds.
 */

export type SeatPair<T> = readonly [T, T];

/**
 * A request out at a frame: the seq and question key of the decision line it becomes, and the
 * tick (or turn) it was sent. Never its answer.
 */
export interface InFlight {
  seq: number;
  questionKey: string;
  sentTick: number;
}

/** Everything one drawn frame depends on. A frame is a pure function of (log, frame index). */
export interface FrameInfo<S = unknown> {
  /** The frame index (0-based). Real-time games: the tick. */
  frame: number;
  /** Real-time: ticks simulated so far (`state` is the state before tick `tick`). Turns: turns played. */
  tick: number;
  /** The game state at this frame. Read it, don't mutate it. */
  state: S;
  /** Both seats' plain-text labels, seat 0 first (from the log header). No logos (RULES.md). */
  labels: SeatPair<string>;
  /**
   * Both seats' colors, seat 0 first: each player's model color (Jev teal, OpenAI Decisions amber,
   * whichever seat it sits in), a neutral one for a baseline (shell/theme.ts `playerColors`).
   */
  colors: SeatPair<string>;
  /** Decision lines resolved by this frame, ordered by when they resolved (log order breaks ties). */
  decisions: readonly DecisionLine[];
  /** The latest of `decisions` per seat (null before a seat's first). */
  latestDecisions: SeatPair<DecisionLine | null>;
  /**
   * Each seat's request in flight at this frame (`inFlightAt` in shell/frames.ts), or null. Set by
   * `frameBase` from the log, so replays and render mode have it; live mode's frames have no
   * future lines, so nothing there. A renderer that lands a line in `decisions` early (a turn
   * game showing an answer at its latency) may leave this as is: the panel treats a request whose
   * line is already in `decisions` as answered. A turn game's timeline that keeps a played turn on
   * screen (a score or reveal hold, where `tick` already counts the turn and `frameBase` calls the
   * next turn's request out) sets it itself: Clue Clash's `stepInFlight`.
   */
  inFlight?: SeatPair<InFlight | null>;
  /** Game events logged before this frame, in log order. */
  events: readonly EventLine[];
  /** A short status line the stage may show (e.g. "PAUSED", "WARMING UP"). */
  note?: string;
}

/** A match as frames at 60 fps. Real-time games: frame = tick. */
export interface Timeline<F extends FrameInfo = FrameInfo> {
  /** Frame count: frames 0 … frames − 1. */
  readonly frames: number;
  /** Frame `n`, clamped to the timeline. Seeking backwards or far ahead re-simulates. */
  at(frame: number): F;
  /** The game state's hash at the last frame `at` returned. */
  hash(): string;
}

/** A jump point under the player (the fighter's round starts). */
export interface Chapter {
  /** Button text, e.g. "R2". */
  label: string;
  /** Spelled out, e.g. "round 2" (the button's title is "Jump to round 2"). */
  title: string;
  frame: number;
}

/** How the stage is shown right now (not part of the match: never changes what is simulated). */
export interface StageView {
  /** CSS px per logical px on screen; a stage may grow its text when this is small (phones). */
  cssScale: number;
  /**
   * The logical area to fill, (0, 0)–(width, height): the renderer's `squareStage` in the square
   * video layout. Absent: its `stage`.
   */
  size?: { width: number; height: number };
}

/**
 * Live mode's frames for a match being played now (no log yet). Real-time games call `onStep`
 * after every simulated tick with the state before it and the inputs fed; `frame` adds whatever
 * the renderer draws besides the generic frame (the fighter's hit effects).
 */
export interface LiveFrames<S, F extends FrameInfo<S>> {
  onStep?(before: S, inputs: readonly [RealtimeInput | null, RealtimeInput | null], after: S): void;
  frame(base: FrameInfo<S>): F;
  /**
   * True while the view is still behind the match: a turn game holds each reveal its full time,
   * so it can trail a fast match. The shell keeps drawing after the match ends until it's false.
   */
  busy?(): boolean;
}

/** A keyboard player for a game whose baselines include `human` (live mode only). */
export interface HumanControls<S> {
  /** Passed to the game's `human` baseline as `deps.extra.humanInput`. */
  readonly input: unknown;
  /** Shown under the stage while a human plays. */
  readonly help: string;
  /** Called on every live loop pass with the state and the human's seat. */
  pump(state: S, seat: Seat): void;
  /** Start listening to the keyboard; returns a function that stops listening. */
  attach(target: Window): () => void;
}

export interface GameRenderer<S = unknown, F extends FrameInfo<S> = FrameInfo<S>> {
  gameId: string;
  /** Logical px of the stage; the shell draws the decision panel below it. */
  stage: { width: number; height: number };
  timeline(log: MatchLog): Timeline<F>;
  /** Draw one frame into the stage area (0,0)–(stage.width, stage.height), logical px. */
  draw(ctx: CanvasRenderingContext2D, frame: F, view: StageView): void;
  /** Plain-text label of an option id (panel bars, the latest choice, the ticker). */
  optionLabel(id: string): string;
  chapters(log: MatchLog): Chapter[];
  /**
   * Probability bars the panel shows per decision. Default: every option up to 6, else the top 5
   * (`topProbabilityCount`).
   */
  probabilityBars?: number;
  /**
   * Which decisions can be a seat's headline in the panel (the big choice, its latency and
   * probabilities). Default: every one. The fighter keeps only the moves the engine applied, so
   * the headline is what the fighter is doing; a newer answer it skips (dropped while the fighter
   * was busy) shows as the panel's small note and in the ticker.
   */
  headline?(d: DecisionLine): boolean;
  /**
   * The plain word the panel, the video cards and the tickers use for a `dropped` answer, saying
   * why the game didn't use it (from the line's logged reason): the fighter's "busy" (it arrived
   * while the fighter was mid-move), Inbox's "too late" (it arrived after the message landed).
   * Default "dropped".
   */
  droppedLabel?(d: DecisionLine): string;
  /**
   * The logical size the renderer draws its stage at in the square video layout, when not
   * `stage`. A narrower stage gets more of the square's height (render-layout.ts); `draw` is then
   * passed it as `view.size`. The fighter crops to its fighters through a camera.
   */
  squareStage?: { width: number; height: number };
  /** Live mode: frames for a running match. Absent: the generic frame is drawn as is. */
  live?(): LiveFrames<S, F>;
  /** Live mode: keyboard controls for the `human` baseline. */
  human?(): HumanControls<S>;
}

/** Every renderer. A registered game without one is listed but can't be played or watched yet. */
export const RENDERERS: readonly GameRenderer[] = [fighterRenderer, inboxRenderer, cluesRenderer];

export function rendererFor(gameId: string): GameRenderer | null {
  return RENDERERS.find((r) => r.gameId === gameId) ?? null;
}
