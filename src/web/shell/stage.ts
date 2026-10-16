import type { FrameInfo, GameRenderer } from '../games/index.js';
import { resolvedAt, type Cadence } from './frames.js';
import { drawCompactPanel } from './compact-panel.js';
import { drawPanel, PANELS_H, panelModel, type PanelHeader, type PanelModel } from './panel.js';
import { layoutKind, renderLayout, type RenderSize } from './render-layout.js';

/**
 * The canvas every page draws a match into: the game's stage on top (`renderer.draw`) and the
 * decision panel under it, at a logical `stage.width × (stage.height + PANELS_H)` (the fighter:
 * 1920 × 1760), scaled to fit the element (letterboxed) at the device pixel ratio. A frame depends
 * only on (frame, panel header): no clock.
 */

export interface StageSize {
  width: number;
  height: number;
}

/**
 * The tick the panel is drawn at: the frame's, or later if the frame already holds a decision
 * resolved after it. The panel then shows exactly `frame.decisions`, so a turn game's timeline
 * can land a seat's answer at its latency, before the turn is played (Clue Clash). Real-time
 * frames never hold a later decision, so for them this is `frame.tick`.
 */
export function panelTick(frame: Pick<FrameInfo, 'tick' | 'decisions'>, cadence: Cadence): number {
  const at = resolvedAt(cadence);
  return frame.decisions.reduce((t, d) => Math.max(t, at(d)), frame.tick);
}

/** The logical canvas: the stage plus the panel area under it. */
export function stageSize(renderer: Pick<GameRenderer, 'stage'>): StageSize {
  return { width: renderer.stage.width, height: renderer.stage.height + PANELS_H };
}

export interface StageCanvasOptions {
  /** Default: window.devicePixelRatio. */
  devicePixelRatio?: () => number;
}

export interface StageCanvas {
  readonly size: StageSize;
  /** Draw `frame`; `header` null draws neutral empty panels. Returns the panel drawn. */
  draw(frame: FrameInfo, header: PanelHeader | null): PanelModel | null;
}

/** The panel for `frame`: its decisions at `panelTick`, its own tick and its requests in flight. */
export function framePanel(
  frame: FrameInfo,
  header: PanelHeader,
  renderer: Pick<GameRenderer, 'optionLabel' | 'probabilityBars' | 'headline' | 'droppedLabel'>,
): PanelModel {
  const headline = renderer.headline?.bind(renderer);
  const droppedLabel = renderer.droppedLabel?.bind(renderer);
  return panelModel(
    frame.decisions,
    panelTick(frame, header.cadence),
    header,
    {
      optionLabel: (id) => renderer.optionLabel(id),
      ...(renderer.probabilityBars === undefined ? {} : { bars: renderer.probabilityBars }),
      ...(headline === undefined ? {} : { headline }),
      ...(droppedLabel === undefined ? {} : { droppedLabel }),
    },
    {
      playedTick: frame.tick,
      ...(frame.inFlight === undefined ? {} : { inFlight: frame.inFlight }),
    },
  );
}

export function createStageCanvas(
  canvas: HTMLCanvasElement,
  renderer: GameRenderer,
  opts: StageCanvasOptions = {},
): StageCanvas {
  const ctxOrNull = canvas.getContext('2d');
  if (ctxOrNull === null) throw new Error('2D canvas not supported');
  const ctx = ctxOrNull;
  const dprOf = opts.devicePixelRatio ?? (() => window.devicePixelRatio || 1);
  const size = stageSize(renderer);
  const { width: W, height: H } = size;
  const stageH = renderer.stage.height;

  function fit(): { scale: number; ox: number; oy: number; cssScale: number } {
    const dpr = dprOf();
    const cssW = canvas.clientWidth || W;
    const cssH = canvas.clientHeight || H;
    const w = Math.max(1, Math.round(cssW * dpr));
    const h = Math.max(1, Math.round(cssH * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const scale = Math.min(w / W, h / H);
    return { scale, ox: (w - W * scale) / 2, oy: (h - H * scale) / 2, cssScale: scale / dpr };
  }

  return {
    size,
    draw(frame, header) {
      const { scale, ox, oy, cssScale } = fit();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(scale, 0, 0, scale, ox, oy);
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, W, stageH);
      ctx.clip();
      renderer.draw(ctx, frame, { cssScale });
      ctx.restore();
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, stageH, W, PANELS_H);
      ctx.clip();
      const model = header === null ? null : framePanel(frame, header, renderer);
      drawPanel(ctx, model, { x: 0, y: stageH, w: W, h: PANELS_H });
      ctx.restore();
      return model;
    },
  };
}

/** A `.stage` box holding a canvas, appended to `parent`. */
export function mountStageCanvas(
  parent: HTMLElement,
  renderer: GameRenderer,
  ariaLabel: string,
): StageCanvas {
  const frame = document.createElement('div');
  frame.className = 'stage';
  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-label', ariaLabel);
  frame.append(canvas);
  parent.append(frame);
  setStageRatio(renderer);
  return createStageCanvas(canvas, renderer);
}

/** A canvas of exactly `size` pixels in the video layout, appended to `parent`. */
export function mountRenderCanvas(
  parent: HTMLElement,
  renderer: GameRenderer,
  size: RenderSize,
  ariaLabel: string,
): StageCanvas {
  const canvas = document.createElement('canvas');
  canvas.className = 'render-canvas';
  canvas.setAttribute('aria-label', ariaLabel);
  parent.append(canvas);
  return createRenderCanvas(canvas, renderer, size);
}

/** Sets the CSS aspect ratio of `.stage` to the renderer's logical canvas (stage plus panel). */
export function setStageRatio(renderer: Pick<GameRenderer, 'stage'>): void {
  const { width, height } = stageSize(renderer);
  document.documentElement.style.setProperty('--stage-ratio', String(width / height));
}

/** The logical stage a renderer draws in the video layout for `size`: its `squareStage` in the square. */
export function videoStage(
  renderer: Pick<GameRenderer, 'stage' | 'squareStage'>,
  size: RenderSize,
): { width: number; height: number } {
  return layoutKind(size) === 'square' && renderer.squareStage !== undefined
    ? renderer.squareStage
    : renderer.stage;
}

/**
 * Render mode's canvas for a video size (render-layout.ts): exactly `size` pixels, whatever the
 * device pixel ratio, with the stage scaled into its rect and the compact panel drawn at output
 * pixels. `size` is what `window.renderInfo` reports.
 */
export function createRenderCanvas(
  canvas: HTMLCanvasElement,
  renderer: GameRenderer,
  size: RenderSize,
): StageCanvas {
  const ctxOrNull = canvas.getContext('2d');
  if (ctxOrNull === null) throw new Error('2D canvas not supported');
  const ctx = ctxOrNull;
  const box = videoStage(renderer, size);
  const layout = renderLayout(size, box);
  canvas.width = size.width;
  canvas.height = size.height;
  canvas.style.width = `${String(size.width)}px`;
  canvas.style.height = `${String(size.height)}px`;
  const { stage, stageScale } = layout;
  return {
    size: { width: size.width, height: size.height },
    draw(frame, header) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, size.width, size.height);
      ctx.save();
      ctx.beginPath();
      ctx.rect(stage.x, stage.y, stage.w, stage.h);
      ctx.clip();
      ctx.setTransform(stageScale, 0, 0, stageScale, stage.x, stage.y);
      renderer.draw(ctx, frame, { cssScale: layout.cssScale, size: box });
      ctx.restore();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const model = header === null ? null : framePanel(frame, header, renderer);
      drawCompactPanel(ctx, model, layout, { noteRow: renderer.headline !== undefined });
      return model;
    },
  };
}
