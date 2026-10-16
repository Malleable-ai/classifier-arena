import type { MatchLog } from '../../core/log/read.js';
import { installArenaDebug, type ArenaControls } from '../debug.js';
import type { Chapter, FrameInfo, GameRenderer, Timeline } from '../games/index.js';
import { advanceAccumulator, FRAME_MS, FRAME_RATE } from './accumulator.js';
import { panelHeaderOf, type PanelModel } from './panel.js';
import type { RenderSize } from './render-layout.js';
import { mountRenderCanvas, mountStageCanvas } from './stage.js';

/**
 * Plays one match log through its game's renderer. `mountReplayStage` is the canvas and the frame
 * drawer (render mode drives it frame by frame through `window.renderFrame`); `mountPlayer` adds
 * play/pause, 0.5x/1x/2x and the renderer's chapters (the fighter's rounds) under it. The drawn
 * frame depends only on the frame index; rAF time only decides which frame to show.
 */

export const SPEEDS = [0.5, 1, 2] as const;
export type Speed = (typeof SPEEDS)[number];

export interface ReplayStage {
  readonly timeline: Timeline;
  /** The frame drawn last. */
  readonly current: FrameInfo;
  /** The decision panel drawn with it. */
  readonly panel: PanelModel | null;
  /** Draw frame n (clamped); returns the frame reached. */
  renderFrame(n: number): number;
}

export function showError(root: HTMLElement, message: string): void {
  root.innerHTML = '';
  const p = document.createElement('p');
  p.setAttribute('role', 'alert');
  p.textContent = message;
  root.append(p);
}

/**
 * Canvas plus the frame drawer for one log. Draws frame 0. With `size` (render mode's video
 * sizes) the canvas is exactly that many pixels in the video layout (render-layout.ts); without
 * it, the viewer's stage-plus-panel canvas scaled to fit.
 */
export function mountReplayStage(
  parent: HTMLElement,
  log: MatchLog,
  renderer: GameRenderer,
  size?: RenderSize,
): ReplayStage {
  const label = `Replay of ${log.header.matchId}`;
  const stage =
    size === undefined
      ? mountStageCanvas(parent, renderer, label)
      : mountRenderCanvas(parent, renderer, size, label);
  const timeline = renderer.timeline(log);
  const header = panelHeaderOf(log.header);
  let current = timeline.at(0);
  let panel: PanelModel | null = null;
  const renderFrame = (n: number): number => {
    current = timeline.at(n);
    panel = stage.draw(current, header);
    return current.frame;
  };
  renderFrame(0);
  return {
    timeline,
    get current() {
      return current;
    },
    get panel() {
      return panel;
    },
    renderFrame,
  };
}

/** `window.__arena` for a replay (dev builds only). */
export function exposeReplayDebug(log: MatchLog, rs: ReplayStage, controls: ArenaControls): void {
  if (!import.meta.env.DEV) return;
  installArenaDebug({
    game: log.header.game,
    cadence: log.header.cadence.kind,
    frame: () => rs.current,
    panel: () => rs.panel,
    hash: () => rs.timeline.hash(),
    controls,
  });
}

export interface PlayerOptions {
  /** Start playing at once; otherwise wait on frame 0 for the Play button. */
  autoplay: boolean;
}

export interface Player {
  destroy(): void;
}

/** Replay player: canvas, play/pause, speeds and chapter buttons, for one loaded log. */
export function mountPlayer(
  parent: HTMLElement,
  log: MatchLog,
  renderer: GameRenderer,
  opts: PlayerOptions,
): Player {
  const rs = mountReplayStage(parent, log, renderer);
  const playback = mountPlayback(parent, rs, renderer.chapters(log), opts);
  exposeReplayDebug(log, rs, playback);
  playback.start();
  return {
    destroy: () => {
      playback.stop();
    },
  };
}

function formatSeconds(frames: number): string {
  return `${(frames / FRAME_RATE).toFixed(1)} s`;
}

interface Playback extends ArenaControls {
  start(): void;
  stop(): void;
  seek(frame: number): void;
}

/** Play/pause, a speed toggle and chapter buttons. rAF time picks the frame; drawing doesn't. */
function mountPlayback(
  parent: HTMLElement,
  rs: ReplayStage,
  chapters: readonly Chapter[],
  opts: PlayerOptions,
): Playback {
  const bar = document.createElement('div');
  bar.className = 'controls playback';
  const play = document.createElement('button');
  play.type = 'button';
  play.className = 'play';
  const group = (label: string): HTMLDivElement => {
    const g = document.createElement('div');
    g.className = 'speeds';
    g.setAttribute('role', 'group');
    g.setAttribute('aria-label', label);
    return g;
  };
  const speedGroup = group('Playback speed');
  const speedButtons = SPEEDS.map((sp) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = `${String(sp)}x`;
    b.dataset.speed = String(sp);
    speedGroup.append(b);
    return b;
  });
  const chapterGroup = group('Jump to');
  chapterGroup.classList.add('rounds');
  const chapterButtons = chapters.map((c) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = c.label;
    b.title = `Jump to ${c.title}`;
    b.dataset.frame = String(c.frame);
    chapterGroup.append(b);
    return b;
  });
  const time = document.createElement('p');
  time.className = 'time';
  bar.append(play, speedGroup, chapterGroup, time);
  parent.append(bar);

  let speed: Speed = 1;
  let paused = !opts.autoplay;
  let acc = 0;
  let last: number | null = null;
  let raf: number | null = null;
  const lastFrame = rs.timeline.frames - 1;
  const at = (): number => rs.current.frame;
  const ended = (): boolean => at() >= lastFrame;
  const currentChapter = (): number => {
    let r = 0;
    for (const [i, c] of chapters.entries()) if (at() >= c.frame) r = i;
    return r;
  };

  const sync = (): void => {
    play.textContent = ended() ? 'Replay' : paused ? 'Play' : 'Pause';
    for (const b of speedButtons) {
      b.setAttribute('aria-pressed', String(Number(b.dataset.speed) === speed));
    }
    const r = currentChapter();
    for (const [i, b] of chapterButtons.entries()) b.setAttribute('aria-pressed', String(i === r));
    time.textContent = `${formatSeconds(at())} / ${formatSeconds(lastFrame)}`;
  };

  const frame = (now: number): void => {
    raf = window.requestAnimationFrame(frame);
    if (paused || ended() || last === null) {
      last = now;
      return;
    }
    // 2x runs two frames per 60 Hz frame; a long gap (hidden tab) never fast-forwards past 10.
    const r = advanceAccumulator(acc, now - last, FRAME_MS / speed, 10);
    last = now;
    acc = r.acc;
    if (r.ticks > 0) {
      rs.renderFrame(at() + r.ticks);
      sync();
    }
  };

  const ctl: Playback = {
    start() {
      sync();
      raf = window.requestAnimationFrame(frame);
    },
    stop() {
      if (raf !== null) window.cancelAnimationFrame(raf);
      raf = null;
    },
    pause() {
      paused = true;
      sync();
    },
    resume() {
      paused = false;
      acc = 0;
      sync();
    },
    stepFrames(n) {
      rs.renderFrame(at() + n);
      sync();
    },
    seek(n) {
      rs.renderFrame(n);
      acc = 0;
      sync();
    },
    get paused() {
      return paused;
    },
  };

  play.addEventListener('click', () => {
    if (ended()) {
      rs.renderFrame(0);
      ctl.resume();
    } else if (paused) ctl.resume();
    else ctl.pause();
  });
  for (const b of speedButtons) {
    b.addEventListener('click', () => {
      speed = Number(b.dataset.speed) as Speed;
      sync();
    });
  }
  for (const b of chapterButtons) {
    b.addEventListener('click', () => {
      // Seeks through the timeline's keyframes; keeps playing if it was playing.
      ctl.seek(Number(b.dataset.frame));
    });
  }
  return ctl;
}
