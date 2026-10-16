/**
 * Video layouts for render mode with `size=<W>x<H>` (docs/architecture/core.md, "Render mode"):
 * the canvas is exactly W × H pixels and holds the game's stage, scaled, plus a compact decision
 * panel drawn at output pixels so its text stays readable when the video plays on a phone. Pure:
 * the layout is a function of the size and the renderer's stage, so tests pin it.
 *
 * - **Square** (1080 × 1080, any size narrower than WIDE_ASPECT): the stage fills the width at the
 *   top; the two seat cards sit side by side below it. No ticker (no room). A renderer with a
 *   narrower `squareStage` (the fighter's camera) gets more of the height, up to 65%.
 * - **Wide** (1920 × 1080): the stage on the left at three quarters of the width; the two seat cards
 *   stacked in the column on its right; the ticker of the latest decisions under the stage.
 *
 * Without `size`, render mode keeps the viewer's tall layout (stage plus the full panel, the
 * fighter's 1920 × 1760).
 */

export interface RenderSize {
  width: number;
  height: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The two sizes the video uses. */
export const SQUARE: RenderSize = { width: 1080, height: 1080 };
export const WIDE: RenderSize = { width: 1920, height: 1080 };

/** Smallest and largest side accepted (H.264 with yuv420p also needs even sides). */
export const MIN_RENDER_SIDE = 240;
export const MAX_RENDER_SIDE = 3840;

/** At or above this width ÷ height the wide layout is used. */
export const WIDE_ASPECT = 1.4;
/** Square: the panel under the stage keeps at least this share of the height. */
export const SQUARE_MIN_PANEL_SHARE = 0.35;
/** Wide: the seat column's share of the width. */
export const WIDE_COLUMN_SHARE = 0.25;
/** Gap around the seat cards, as a share of the shorter side. */
export const GUTTER_SHARE = 0.02;

/**
 * The screen width (CSS px) each layout is made to be watched at, for the stage's `cssScale`: a
 * square video in a phone feed, a wide one in a desktop player. A stage that grows its text on
 * small screens (the fighter's top bar) grows it for that screen.
 */
export const VIEW_CSS_WIDTH = { square: 390, wide: 960 } as const;

export type RenderLayoutKind = keyof typeof VIEW_CSS_WIDTH;

export interface RenderLayout {
  kind: RenderLayoutKind;
  width: number;
  height: number;
  /** Where the stage lands: its logical (0, 0)–(stage.width, stage.height) maps onto this rect. */
  stage: Rect;
  /** Output px per logical stage px. */
  stageScale: number;
  /** The panel's whole area (background), under or beside the stage. */
  panel: Rect;
  /** One card per seat, seat 0 first. */
  seats: readonly [Rect, Rect];
  /** The ticker of the latest decisions, or null when the layout has no room for it. */
  ticker: Rect | null;
  /** `StageView.cssScale` for the stage: CSS px per logical px on the screen it is made for. */
  cssScale: number;
}

/** "1080x1080" → { width: 1080, height: 1080 }; null unless both sides are even and in range. */
export function parseRenderSize(text: string): RenderSize | null {
  const m = /^(\d{1,5})x(\d{1,5})$/.exec(text.trim());
  if (m === null) return null;
  const width = Number(m[1]);
  const height = Number(m[2]);
  const ok = (n: number) => n >= MIN_RENDER_SIDE && n <= MAX_RENDER_SIDE && n % 2 === 0;
  return ok(width) && ok(height) ? { width, height } : null;
}

export function formatRenderSize(size: RenderSize): string {
  return `${String(size.width)}x${String(size.height)}`;
}

export function layoutKind(size: RenderSize): RenderLayoutKind {
  return size.width / size.height >= WIDE_ASPECT ? 'wide' : 'square';
}

export function renderLayout(
  size: RenderSize,
  stage: { width: number; height: number },
): RenderLayout {
  const { width: W, height: H } = size;
  const kind = layoutKind(size);
  const g = Math.round(Math.min(W, H) * GUTTER_SHARE);

  if (kind === 'square') {
    const scale = Math.min(W / stage.width, (H * (1 - SQUARE_MIN_PANEL_SHARE)) / stage.height);
    const sw = Math.round(stage.width * scale);
    const sh = Math.round(stage.height * scale);
    const panel: Rect = { x: 0, y: sh, w: W, h: H - sh };
    const cardW = Math.floor((W - 3 * g) / 2);
    const cardH = panel.h - 2 * g;
    const card = (seat: 0 | 1): Rect => ({
      x: g + seat * (cardW + g),
      y: panel.y + g,
      w: cardW,
      h: cardH,
    });
    return {
      kind,
      width: W,
      height: H,
      stage: { x: Math.round((W - sw) / 2), y: 0, w: sw, h: sh },
      stageScale: scale,
      panel,
      seats: [card(0), card(1)],
      ticker: null,
      cssScale: (scale * VIEW_CSS_WIDTH.square) / W,
    };
  }

  const column = Math.round(W * WIDE_COLUMN_SHARE);
  const scale = Math.min((W - column) / stage.width, H / stage.height);
  const sw = Math.round(stage.width * scale);
  const sh = Math.round(stage.height * scale);
  const colX = sw;
  const cardW = W - colX - 2 * g;
  const cardH = Math.floor((H - 3 * g) / 2);
  const card = (seat: 0 | 1): Rect => ({
    x: colX + g,
    y: g + seat * (cardH + g),
    w: cardW,
    h: cardH,
  });
  const tickerH = H - sh;
  return {
    kind,
    width: W,
    height: H,
    stage: { x: 0, y: 0, w: sw, h: sh },
    stageScale: scale,
    panel: { x: colX, y: 0, w: W - colX, h: H },
    seats: [card(0), card(1)],
    ticker: tickerH >= 0.15 * H ? { x: 0, y: sh, w: sw, h: tickerH } : null,
    cssScale: (scale * VIEW_CSS_WIDTH.wide) / W,
  };
}
