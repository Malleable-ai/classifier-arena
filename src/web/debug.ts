import type { DecisionLine, EventLine } from '../core/log/schema.js';
import type { FrameInfo, InFlight, SeatPair } from './games/index.js';
import type { PanelModel } from './shell/panel.js';

/**
 * `window.__arena`: a read-only view of whatever match the page shows (a replay, render mode, live
 * mode or the fighter sandbox), for agents and tests. Installed only in dev builds
 * (`import.meta.env.DEV`). Every getter returns a fresh deep-frozen copy, so callers can never
 * mutate the live state.
 */

/** Pause and step whatever drives the page (absent in pages nothing drives, e.g. live mode). */
export interface ArenaControls {
  readonly paused: boolean;
  pause(): void;
  resume(): void;
  /** Advance n frames now (also while paused) and redraw. */
  stepFrames(n: number): void;
  /** Jump to frame n (clamped) and redraw. Replays only. */
  seek?(frame: number): void;
}

export interface ArenaDebugSource {
  game: string;
  /** Real-time games expose `tick`, turn games `turn`. */
  cadence: 'realtime' | 'turns';
  /** The frame on screen now. */
  frame(): FrameInfo;
  /** The game state's hash (the game's own `hash`). */
  hash(): string;
  /** The decision panel drawn with the frame (replays and render mode). */
  panel?(): PanelModel | null;
  controls?: ArenaControls;
}

export interface ArenaDebug {
  readonly game: string;
  /** Real-time games: ticks simulated. */
  readonly tick?: number;
  /** Turn games: turns played. */
  readonly turn?: number;
  readonly frame: number;
  /** The game state (a deep-frozen copy). */
  readonly state: unknown;
  /** The latest resolved decision line per seat, seat 0 first. */
  readonly latestDecisions: SeatPair<DecisionLine | null>;
  /** Each seat's request in flight (seq, question key, sent tick), or null. Replays only. */
  readonly inFlight: SeatPair<InFlight | null>;
  /**
   * The decision panel on screen (what each seat's panel and the ticker say: choice, status,
   * verdict, thinking, previous answer), or null where the page draws none or isn't a replay.
   */
  readonly panel: PanelModel | null;
  /** Game events logged so far. */
  readonly events: readonly EventLine[];
  readonly paused: boolean;
  hash(): string;
  pause(): void;
  resume(): void;
  stepFrames(n: number): void;
  seek(frame: number): void;
}

export function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

function frozenCopy<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

export function createArenaDebug(source: ArenaDebugSource): ArenaDebug {
  const c = source.controls;
  const debug = {
    get game() {
      return source.game;
    },
    get frame() {
      return source.frame().frame;
    },
    get state() {
      return frozenCopy(source.frame().state);
    },
    get latestDecisions() {
      return frozenCopy(source.frame().latestDecisions);
    },
    get inFlight(): SeatPair<InFlight | null> {
      return frozenCopy(source.frame().inFlight ?? [null, null]);
    },
    get panel() {
      return frozenCopy(source.panel?.() ?? null);
    },
    get events() {
      return frozenCopy(source.frame().events);
    },
    get paused() {
      return c?.paused ?? false;
    },
    hash: () => source.hash(),
    pause: () => c?.pause(),
    resume: () => c?.resume(),
    stepFrames: (n: number) => c?.stepFrames(n),
    seek: (frame: number) => c?.seek?.(frame),
  };
  Object.defineProperty(debug, source.cadence === 'realtime' ? 'tick' : 'turn', {
    enumerable: true,
    get: () => source.frame().tick,
  });
  return Object.freeze(debug);
}

/** Sets `window.__arena` (call only under `import.meta.env.DEV`). */
export function installArenaDebug(source: ArenaDebugSource): void {
  window.__arena = createArenaDebug(source);
}
