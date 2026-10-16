import type { Seat } from '../../../core/classifier/types.js';
import type { RealtimeGame } from '../../../core/game.js';
import type { MatchLog } from '../../../core/log/read.js';
import type { DecisionLine } from '../../../core/log/schema.js';
import { createReplayCursor, type ReplayCursor } from '../../../core/replay/replay.js';
import { cloneState } from '../../../games/fighter/engine/sim.js';
import type { EngineConfig, MatchState, StepEvent } from '../../../games/fighter/engine/types.js';
import { fighterGame, stepFighter } from '../../../games/fighter/game.js';
import { END_HOLD_FRAMES, frameBase } from '../../shell/frames.js';
import { legibleFloor } from '../../shell/theme.js';
import type {
  Chapter,
  FrameInfo,
  GameRenderer,
  HumanControls,
  LiveFrames,
  SeatPair,
  Timeline,
} from '../index.js';
import { displayName, drawFighterStage, LOGICAL_W, STAGE_H, uiScale } from './canvas.js';
import { settledState } from './settle.js';
import type { Effect } from './effects.js';
import { DUST_DELAY, EFFECT_TICKS, effectsFromEvents, pruneEffects } from './effects.js';
import { attachKeys, createKeyboardHumanInput, createKeyState } from './keyboard.js';

/**
 * The fighter's `GameRenderer`: a frame is a tick. The log keeps only `round_end` events, so the
 * timeline replays the engine itself (`stepFighter`, the same step the contract runs) to get the
 * hits, blocks and clashes its effects are drawn from. Effects depend on the ticks just before a
 * frame, so a jump re-simulates that window: jumping to a tick draws exactly what playing up to
 * it does.
 *
 * After a round ends the stage shows `settledState` (settle.ts): the K.O.'d fighter falls and stays
 * down while the engine's state stands still. A finished match then holds for END_HOLD_FRAMES
 * frames past its last tick: `tick` and `state` stay the final ones (the panel and the hash don't
 * move), while `shown` plays the fall out under the result banner.
 */

export interface FighterFrame extends FrameInfo<MatchState> {
  effects: readonly Effect[];
  /** The state the stage draws: `state`, or after a round ends its settled look (settle.ts). */
  shown: MatchState;
}

/** Effects started up to this many ticks back can still be on screen, so re-sim that window. */
export const EFFECT_WINDOW = Math.max(...Object.values(EFFECT_TICKS)) + DUST_DELAY;
/** Engine events the timeline keeps for the debug handle. */
export const RECENT_EVENTS_MAX = 20;

export const CONTROLS_HELP =
  'Keys: A / D walk · S block low · Shift block high · W jump-in · J jab · K heavy · L sweep · ' +
  'U uppercut · I fireball · O throw · no key held = high guard. Your inputs go through the same ' +
  'request cadence as the models (one at a time, 100 ms floor, 1 s timeout).';

export interface FighterTimeline extends Timeline<FighterFrame> {
  readonly cursor: ReplayCursor<MatchState>;
  readonly effects: readonly Effect[];
  /** The last engine events stepped through (at most RECENT_EVENTS_MAX), oldest first. */
  readonly recentEvents: readonly StepEvent[];
  /** Move to tick n (clamped) and rebuild the effects that lead up to it. Returns the tick. */
  goTo(n: number): number;
}

/**
 * The square video's stage: narrower than the 1920 × 1080 arena, so the stage takes 61% of the
 * square instead of 56%, and the fighters fill it through the camera (canvas.ts `cameraFor`).
 */
export const SQUARE_STAGE = { width: 1768, height: STAGE_H } as const;

/** "walk_forward" → "walk forward". */
export function moveLabel(id: string): string {
  return id.replaceAll('_', ' ');
}

/** 'P1 · Jev (TypeSafe)', or just 'P1' without a label. */
export function seatLabel(seat: Seat, label: string): string {
  const p = `P${String(seat + 1)}`;
  return label === '' ? p : `${p} · ${label}`;
}

/**
 * What the stage draws for `state`, `extra` ticks past it (the end hold): the state itself while a
 * round is fought; after a round ends, its settled look that many ticks after the deciding tick.
 */
export function shownState(state: MatchState, extra = 0): MatchState {
  const r = state.roundResults[state.roundResults.length - 1];
  if (state.status === 'fighting' || r === undefined) return state;
  // The round was decided on tick r.endTick; the state after it is the one at r.endTick + 1.
  const since = state.tick - (r.endTick + 1) + extra;
  return since <= 0 ? state : settledState({ ...state, tick: r.endTick + 1 }, since);
}

export function createFighterTimeline(log: MatchLog): FighterTimeline {
  let collecting = false;
  let effects: Effect[] = [];
  let recentEvents: StepEvent[] = [];
  // The registered game with its step routed through `stepFighter` while effects are collected,
  // so the engine events come from the very step that advances the replay. Same rules, same state.
  const game: RealtimeGame<MatchState, EngineConfig> = {
    ...fighterGame,
    step(state, inputs) {
      if (!collecting) return fighterGame.step(state, inputs);
      const prev = state.projectiles.map((p) => ({ ...p }));
      const r = stepFighter(state, inputs);
      if (r.engineEvents.length > 0) {
        recentEvents = [...recentEvents, ...r.engineEvents].slice(-RECENT_EVENTS_MAX);
        effects = pruneEffects(
          [...effects, ...effectsFromEvents(r.engineEvents, state, prev)],
          state.tick,
        );
      }
      return { settlements: r.settlements, events: r.events };
    },
  };
  const cursor = createReplayCursor(log, game);
  const [a, b] = log.header.seats;
  const labels: SeatPair<string> = [a.label, b.label];
  const players: SeatPair<string> = [a.player, b.player];

  const goTo = (n: number): number => {
    const target = Math.max(0, Math.min(cursor.lastTick, Math.floor(n)));
    // Playing forward frame by frame: keep stepping. Otherwise re-sim the effect window.
    if (!(target >= cursor.tick && target - cursor.tick <= EFFECT_WINDOW)) {
      cursor.seek(Math.max(0, target - EFFECT_WINDOW));
      effects = [];
      recentEvents = [];
    }
    collecting = true;
    try {
      cursor.stepTo(target);
    } finally {
      collecting = false;
    }
    effects = pruneEffects(effects, cursor.tick);
    return cursor.tick;
  };

  // A finished match holds its end (settled) for END_HOLD_FRAMES more frames.
  const hold = log.matchEnd === null ? 0 : END_HOLD_FRAMES;

  return {
    frames: cursor.lastTick + 1 + hold,
    cursor,
    get effects() {
      return effects;
    },
    get recentEvents() {
      return recentEvents;
    },
    goTo,
    at(frame) {
      const n = Math.max(0, Math.min(cursor.lastTick + hold, Math.floor(frame)));
      const tick = goTo(n);
      const extra = n - tick;
      const shown = shownState(cursor.state, extra);
      return {
        ...frameBase({
          frame: n,
          tick,
          state: cursor.state,
          labels,
          players,
          cadence: log.header.cadence,
          decisions: log.decisions,
          events: log.events,
        }),
        effects: extra === 0 ? effects : pruneEffects(effects, shown.tick),
        shown,
      };
    },
    hash: () => cursor.hash(),
  };
}

/**
 * Why the fighter didn't use an answer, in plain words: it arrived while the fighter was mid-move
 * ("busy": it waited and never started, or a newer answer replaced it while it waited), or after
 * the round was over ("round over").
 */
export function fighterDroppedLabel(d: DecisionLine): string {
  return d.error === 'dropped: notFighting' ? 'round over' : 'busy';
}

/** First tick of each round: 0, then each round end plus the between-rounds pause. */
export function roundStartTicks(log: MatchLog): number[] {
  const pause = fighterGame.configFromLog(log.header.config).roundPauseTicks;
  const roundEnds = log.events.filter((e) => e.game.kind === 'round_end');
  const starts = [0];
  // The last round_end closes a finished match; in a log that stopped early another round followed.
  const ends = log.matchEnd === null ? roundEnds : roundEnds.slice(0, -1);
  for (const e of ends) starts.push(e.tick + pause);
  return starts;
}

function liveFrames(): LiveFrames<MatchState, FighterFrame> {
  let effects: Effect[] = [];
  return {
    onStep(before, inputs, after) {
      // Re-run the tick on a copy of the state before it: the engine is deterministic, so this
      // gives the events the match's own step produced.
      const { engineEvents } = stepFighter(cloneState(before), inputs);
      if (engineEvents.length === 0) return;
      effects = pruneEffects(
        [...effects, ...effectsFromEvents(engineEvents, after, before.projectiles)],
        after.tick,
      );
    },
    frame(base) {
      effects = pruneEffects(effects, base.state.tick);
      return { ...base, effects, shown: shownState(base.state) };
    },
  };
}

function humanControls(): HumanControls<MatchState> {
  const keys = createKeyState();
  const human = createKeyboardHumanInput(keys);
  return {
    input: human.input,
    help: CONTROLS_HELP,
    pump: (state, seat) => {
      human.pump(state, seat);
    },
    attach: (target) => attachKeys(target, keys),
  };
}

export const fighterRenderer: GameRenderer<MatchState, FighterFrame> = {
  gameId: fighterGame.id,
  stage: { width: LOGICAL_W, height: STAGE_H },
  squareStage: SQUARE_STAGE,
  timeline: createFighterTimeline,
  draw(ctx, frame, view) {
    const overlay = {
      labels: [seatLabel(0, frame.labels[0]), seatLabel(1, frame.labels[1])] as const,
      names: [displayName(0, frame.labels[0]), displayName(1, frame.labels[1])] as const,
      colors: frame.colors,
      effects: frame.effects,
      ...(frame.note === undefined ? {} : { note: frame.note }),
    };
    drawFighterStage(ctx, frame.shown, overlay, {
      ui: uiScale(view.cssScale),
      minText: legibleFloor(view.cssScale),
      ...(view.size === undefined ? {} : { box: view.size }),
    });
  },
  optionLabel: moveLabel,
  // The headline is the move the fighter performed: an answer dropped while it was busy is the
  // panel's note, never the big move.
  headline: (d) => d.status === 'ok',
  droppedLabel: fighterDroppedLabel,
  chapters(log): Chapter[] {
    return roundStartTicks(log).map((frame, i) => ({
      label: `R${String(i + 1)}`,
      title: `round ${String(i + 1)}`,
      frame,
    }));
  },
  // Today's panel layout: the top 3 of the 11 moves (the generic default would show 5).
  probabilityBars: 3,
  live: liveFrames,
  human: humanControls,
};
