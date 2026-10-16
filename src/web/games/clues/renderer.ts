import type { MatchLog } from '../../../core/log/read.js';
import type { DecisionLine } from '../../../core/log/schema.js';
import { boardAt } from '../../../games/clues/data.js';
import { turnStep, turnWord } from '../../../games/clues/engine/engine.js';
import { CLUES_STEPS, CLUES_TURNS, type CluesState } from '../../../games/clues/engine/types.js';
import { cluesGame } from '../../../games/clues/game.js';
import { latestPerSeat, resolvedAt } from '../../shell/frames.js';
import { legibleFloor } from '../../shell/theme.js';
import type { Chapter, FrameInfo, GameRenderer, LiveFrames, SeatPair } from '../index.js';
import { drawCluesStage, STAGE_H, STAGE_W } from './draw.js';
import {
  buildScene,
  createCluesTimeline,
  END_FRAMES,
  FPS,
  linesByTurn,
  outcomeOf,
  PROMPT_FRAMES,
  REVEAL_FRAMES,
  wordLinesUpTo,
  type CluePhase,
  type CluesFrame,
  type CluesScene,
} from './timeline.js';

/**
 * Clue Clash's `GameRenderer`. Replays and render mode play the timeline (timeline.ts: each of a
 * word's three reveal steps is prompt → answers at their latency → score, at least 1.2 s, then
 * the word's reveal, 1.5 s); the stage is drawn by draw.ts. Chapters are the words' first steps.
 * Options are the board words (the id is the lemma), so an option's label is its id.
 */

/** "Jump to word n" buttons: the first frame of every word (its first reveal step). */
export function wordChapters(log: MatchLog): Chapter[] {
  return createCluesTimeline(log)
    .schedule.slots.filter((s) => s.step === 1)
    .map((s) => ({
      label: String(s.word + 1),
      title: `word ${String(s.word + 1)}`,
      frame: s.start,
    }));
}

/** Live mode: frames a played step's score stays up before the next step. */
export const LIVE_SCORE_HOLD = 36;

/** Live mode: frames turn `turn` is held once played (its score, then a third step's reveal). */
export function liveHoldFrames(turn: number): number {
  return turnStep(turn) === CLUES_STEPS ? LIVE_SCORE_HOLD + REVEAL_FRAMES : LIVE_SCORE_HOLD;
}

const msOf = (frames: number): number => (frames * 1000) / FPS;
const framesOf = (ms: number): number => Math.max(0, Math.floor((ms * FPS) / 1000));

/**
 * What live mode has on screen: a turn (a word's reveal step), its stage, and the clock time (ms)
 * the stage began. `ask`: the step's clue, then both seats thinking. `held`: its score, then (on a
 * third step) the word's reveal. `end`: the result.
 */
export interface LiveView {
  turn: number;
  stage: 'ask' | 'held' | 'end';
  since: number;
}

/**
 * Moves live mode's view on to clock time `now` (ms), in a match with `played` turns played and
 * `over` once it has finished. A turn is asked for at least PROMPT_FRAMES and until it has been
 * played (`playedAt(turn)`: when the view first saw it played); it is then held for
 * `liveHoldFrames(turn)`; then the next turn is asked or, after the last turn of a finished match,
 * the result shows. Each stage starts on the clock where the one before ended, so every hold runs
 * its full time however fast the turns come: when the match runs ahead, the view falls behind and
 * shows the played turns at this pace. Display only: the scheduler sets the match's cadence.
 */
export function advanceLive(
  view: LiveView,
  played: number,
  over: boolean,
  now: number,
  playedAt: (turn: number) => number,
): LiveView {
  let v = view;
  for (;;) {
    if (v.stage === 'end') return v;
    if (v.stage === 'ask') {
      if (played <= v.turn) return v;
      const start = Math.max(v.since + msOf(PROMPT_FRAMES), playedAt(v.turn));
      if (now < start) return v;
      v = { turn: v.turn, stage: 'held', since: start };
      continue;
    }
    const end = v.since + msOf(liveHoldFrames(v.turn));
    if (now < end) return v;
    v =
      over && v.turn >= played - 1
        ? { turn: v.turn, stage: 'end', since: end }
        : { turn: v.turn + 1, stage: 'ask', since: end };
  }
}

/** Turns whose outcome the view has shown: the turn on screen counts once it is revealed. */
export function shownTurns(view: LiveView): number {
  return view.stage === 'ask' ? view.turn : view.turn + 1;
}

const correctOf = (d: DecisionLine | null): number => (d?.correct === true ? 1 : 0);
const resolvedTurn = resolvedAt(cluesGame.cadence);

/**
 * The live scene for `view` at clock time `now`. `base` is the match as it stands (its state and
 * its played turns' lines); the view may be some turns behind it, so the scores on screen are the
 * state's minus the correct answers of the turns not yet shown. An asked turn shows its clue (and
 * the word's earlier steps' shading), then both seats thinking, since answers are only logged once
 * the turn is played.
 */
export function liveScene(base: FrameInfo<CluesState>, view: LiveView, now: number): CluesScene {
  const state = base.state;
  const board = boardAt(state.boardIndex);
  const played = state.turn;
  const lines = linesByTurn(base.decisions, played);
  /** The scores once turn `k` was played (k = -1: before the first). */
  const scoresAfter = (k: number): SeatPair<number> => {
    const s: [number, number] = [state.scores[0], state.scores[1]];
    for (let j = k + 1; j < played; j++) {
      s[0] -= correctOf(lines[j]?.[0] ?? null);
      s[1] -= correctOf(lines[j]?.[1] ?? null);
    }
    return s;
  };
  const t = Math.min(view.turn, CLUES_TURNS - 1);
  const wordIndex = state.order[turnWord(t)] ?? 0;
  const elapsed = framesOf(now - view.since);
  if (view.stage === 'ask') {
    const prompt = elapsed < PROMPT_FRAMES;
    const scores = scoresAfter(t - 1);
    return buildScene({
      board,
      turn: t,
      wordIndex,
      wordLines: wordLinesUpTo(lines, t, [null, null]),
      phase: prompt ? 'prompt' : 'answer',
      phaseFrame: prompt ? elapsed : elapsed - PROMPT_FRAMES,
      phaseFrames: prompt ? PROMPT_FRAMES : Number.MAX_SAFE_INTEGER,
      sinceArrival: [-1, -1],
      scoresBefore: scores,
      scoresAfter: scores,
      outcome: null,
    });
  }
  const done = lines[t] ?? [null, null];
  const after = scoresAfter(t);
  const before: SeatPair<number> = [after[0] - correctOf(done[0]), after[1] - correctOf(done[1])];
  let phase: CluePhase = 'end';
  let phaseFrame = Math.min(elapsed, END_FRAMES - 1);
  let phaseFrames = END_FRAMES;
  if (view.stage === 'held') {
    if (elapsed < LIVE_SCORE_HOLD || turnStep(t) !== CLUES_STEPS) {
      phase = 'score';
      phaseFrame = Math.min(elapsed, LIVE_SCORE_HOLD - 1);
      phaseFrames = LIVE_SCORE_HOLD;
    } else {
      phase = 'reveal';
      phaseFrame = Math.min(elapsed - LIVE_SCORE_HOLD, REVEAL_FRAMES - 1);
      phaseFrames = REVEAL_FRAMES;
    }
  }
  return buildScene({
    board,
    turn: t,
    wordIndex,
    wordLines: wordLinesUpTo(lines, t),
    phase,
    phaseFrame,
    phaseFrames,
    sinceArrival: [elapsed, elapsed],
    scoresBefore: before,
    scoresAfter: after,
    outcome: phase === 'end' ? outcomeOf(state) : null,
  });
}

/**
 * The frame as the view shows it: `tick`, decisions and events cut back to the turns it has shown,
 * so the panel never runs ahead of the stage. `state` stays the match's.
 */
function shownFrame(base: FrameInfo<CluesState>, shown: number): FrameInfo<CluesState> {
  if (shown >= base.tick) return base;
  const decisions = base.decisions.filter((d) => resolvedTurn(d) <= shown);
  return {
    ...base,
    tick: shown,
    decisions,
    latestDecisions: latestPerSeat(decisions),
    events: base.events.filter((e) => e.tick < shown),
  };
}

/**
 * Live frames, timed by `clock` (ms; `performance.now` in the browser). `busy` is true while the
 * view still has played turns to show, or the result of a finished match, so the shell keeps
 * drawing after the match ends.
 */
export function liveFrames(
  clock: () => number = () => performance.now(),
): LiveFrames<CluesState, CluesFrame> {
  let view: LiveView | null = null;
  let played = 0;
  let over = false;
  /** Clock time each turn was first seen played. */
  const seen: number[] = [];
  return {
    frame(base) {
      const now = clock();
      played = base.state.turn;
      over = base.state.over;
      while (seen.length < played) seen.push(now);
      view = advanceLive(
        view ?? { turn: 0, stage: 'ask', since: now },
        played,
        over,
        now,
        (turn) => seen[turn] ?? now,
      );
      return { ...shownFrame(base, shownTurns(view)), scene: liveScene(base, view, now) };
    },
    busy() {
      if (view === null) return false;
      if (over) return view.stage !== 'end';
      return !(view.stage === 'ask' && view.turn >= played);
    },
  };
}

export const cluesRenderer: GameRenderer<CluesState, CluesFrame> = {
  gameId: cluesGame.id,
  stage: { width: STAGE_W, height: STAGE_H },
  timeline: createCluesTimeline,
  draw(ctx, frame, view) {
    drawCluesStage(ctx, frame.scene, {
      labels: frame.labels,
      colors: frame.colors,
      minText: legibleFloor(view.cssScale),
      ...(frame.note === undefined ? {} : { note: frame.note }),
    });
  },
  /** Option ids are the board words themselves. */
  optionLabel: (id) => id,
  chapters: wordChapters,
  // The top 3 of 16: five rows shrink the panel's text to ~8 CSS px on a 540 px wide phone, and
  // the boards already shade all 16.
  probabilityBars: 3,
  live: () => liveFrames(),
};
