import type { ArenaDebug } from './debug.js';

declare global {
  interface Window {
    /**
     * Dev builds only (`import.meta.env.DEV`): a read-only view of the match on the page (replay,
     * render mode, live mode or the sandbox), src/web/debug.ts. Getters: game, tick (real-time) or
     * turn (turn games), frame, state (a deep-frozen copy), latestDecisions ([line | null, …]),
     * inFlight, panel (replays), events, paused. Methods: hash(), pause(), resume(),
     * stepFrames(n), seek(frame).
     */
    __arena?: ArenaDebug;
    /**
     * Render mode only (`/<game>?match=<id>&render=1`), set once the log has loaded: move to frame
     * `n` (clamped to the match), draw it synchronously, and return the frame reached.
     */
    renderFrame?: (n: number) => number;
    /** Render mode only: the frame count and the logical canvas size (stage plus panel). */
    renderInfo?: { frames: number; width: number; height: number };
  }
}

export {};
