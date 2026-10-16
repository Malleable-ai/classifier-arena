import type { Seat } from '../../core/classifier/types.js';
import {
  badgeOf,
  badgeWidth,
  drawBadge,
  drawVerdictDot,
  fit,
  fitShrink,
  noteTexts,
  shortLabel,
  STATUS_COLOR,
  TICKER_MAX,
} from './panel.js';
import type { PanelModel, SeatPanel, TickerEntry } from './panel.js';
import type { Rect, RenderLayout } from './render-layout.js';
import { font, hexA, NEUTRAL_COLORS } from './theme.js';

/**
 * The decision panel for the video layouts (render-layout.ts): the same `PanelModel` as the
 * viewer's panel, drawn at output pixels into one card per seat (label, the headline choice with
 * its badge, the note of a skipped answer, the answer's latency, the API-reported probabilities)
 * in the player's color (its model's, whichever seat). No running cost: beside a latency it read
 * as a per-answer price; the outro gives the cost per 1,000 decisions. And,
 * when the layout has room, the ticker of the latest decisions. Every text a viewer must read is at
 * least CARD_MIN_TEXT output px (about 10 CSS px when the square video plays 390 px wide on a
 * phone); a taller card spreads its rows out. Deterministic: draws only from the model.
 */

/** Probability rows a card shows at most. */
export const CARD_BARS_MAX = 3;
/** The smallest text on a card, in output px. */
export const CARD_MIN_TEXT = 28;

/**
 * Row heights (output px) at scale 1, top to bottom: label, headline, note, stats, caption, and
 * one per probability bar. The card scales them by `cardScale` (fonts never under CARD_MIN_TEXT).
 */
export const CARD_ROWS = { label: 34, big: 64, note: 28, stats: 40, caption: 28, bar: 40 } as const;
const CARD_PAD = 16;
/** The headline shrinks to this before it is cut (a long answer beside its badge). */
const BIG_MIN_PX = 36;
/** A badge's word is 0.62–0.67 of its height: this keeps it at CARD_MIN_TEXT or more. */
const BADGE_MIN_H = Math.ceil(CARD_MIN_TEXT / 0.62);
const CARD_GAPS = 5;
const CARD_GAP = 9;

/** Natural height of a card's rows at scale 1, pads and gaps included (`noteRow`: with a note). */
export function cardNaturalH(noteRow: boolean): number {
  return (
    2 * CARD_PAD +
    CARD_ROWS.label +
    CARD_ROWS.big +
    (noteRow ? CARD_ROWS.note : 0) +
    CARD_ROWS.stats +
    CARD_ROWS.caption +
    CARD_BARS_MAX * CARD_ROWS.bar +
    CARD_GAPS * CARD_GAP
  );
}

/** How much a card's rows are scaled: by its height, between 0.9 and 1.15. */
export function cardScale(r: Pick<Rect, 'h'>, noteRow = true): number {
  return Math.min(1.15, Math.max(0.9, r.h / cardNaturalH(noteRow)));
}

export interface CompactPanelOptions {
  /** Labels for empty cards (no model). Default P1, P2. */
  labels?: readonly [string, string];
  /**
   * Keep a row under the headline for its note (a game with a headline filter: the fighter's
   * dropped moves). Without it the other rows get that height.
   */
  noteRow?: boolean;
}

/** A row's font size: its height at the card's scale, never under CARD_MIN_TEXT. */
function px(row: number, s: number): number {
  return Math.max(CARD_MIN_TEXT, row * s);
}

function emptySeat(seat: Seat, label: string): SeatPanel {
  return {
    seat,
    label,
    color: NEUTRAL_COLORS[seat],
    choice: null,
    choiceLabel: null,
    status: null,
    statusText: null,
    verdict: null,
    latencyMs: null,
    perSecond: null,
    bars: null,
    costUsd: 0,
    flash: 0,
    thinking: false,
    previous: null,
    note: null,
  };
}

/** 'P2 · OpenAI Decisions (gpt-6-luna)', then without the model id, then 'P2 · OpenAI'. */
function labelVariants(label: string): string[] {
  const m = /^(P\d · )?(.*)$/.exec(label);
  const tag = m?.[1] ?? '';
  const name = m?.[2] ?? label;
  const bare = name.replace(/\s*\(.*\)\s*$/, '');
  return [label, `${tag}${bare}`, `${tag}${shortLabel(name)}`].filter(
    (l, i, all) => l !== '' && all.indexOf(l) === i,
  );
}

/** The first of `texts` that fits `maxW` at a size from `maxPx` down to `minPx` (font set). */
function fitFirst(
  ctx: CanvasRenderingContext2D,
  texts: readonly string[],
  maxW: number,
  maxPx: number,
  minPx: number,
  weight: number,
): { text: string; px: number } {
  for (const t of texts) {
    for (let size = maxPx; size >= minPx; size -= 2) {
      ctx.font = font(size, weight);
      if (ctx.measureText(t).width <= maxW) return { text: t, px: size };
    }
  }
  ctx.font = font(minPx, weight);
  return { text: fit(ctx, texts[texts.length - 1] ?? '', maxW), px: minPx };
}

function drawSeatCard(
  ctx: CanvasRenderingContext2D,
  p: SeatPanel,
  r: Rect,
  noteRow: boolean,
): void {
  const s = cardScale(r, noteRow);
  const color = p.color;
  ctx.beginPath();
  ctx.roundRect(r.x, r.y, r.w, r.h, 16 * s);
  ctx.fillStyle = hexA(color, 0.08 + 0.18 * p.flash);
  ctx.fill();
  ctx.lineWidth = (3 + 4 * p.flash) * s;
  ctx.strokeStyle = hexA(color, 0.4 + 0.6 * p.flash);
  ctx.stroke();

  const pad = 22 * s;
  const x = r.x + pad;
  const innerW = r.w - 2 * pad;
  const rows = {
    label: CARD_ROWS.label * s,
    big: CARD_ROWS.big * s,
    note: noteRow ? CARD_ROWS.note * s : 0,
    stats: CARD_ROWS.stats * s,
    caption: CARD_ROWS.caption * s,
    bar: CARD_ROWS.bar * s,
  };
  const used =
    2 * CARD_PAD * s +
    rows.label +
    rows.big +
    rows.note +
    rows.stats +
    rows.caption +
    CARD_BARS_MAX * rows.bar;
  // What is left spreads the rows out (a tall card), or tightens them (never under 3 px).
  const gap = Math.max(3, (r.h - used) / CARD_GAPS);
  let y = r.y + CARD_PAD * s;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';

  // Seat and model label.
  const labelPx = px(CARD_ROWS.label, s);
  const label = fitFirst(ctx, labelVariants(p.label), innerW, labelPx, CARD_MIN_TEXT, 700);
  ctx.fillStyle = color;
  ctx.fillText(label.text, x, y + rows.label / 2);
  y += rows.label + gap;

  // Headline, large, with its badge (a non-ok status, or a graded answer's verdict).
  const badge = p.thinking ? null : badgeOf(p.status, p.verdict, p.statusText);
  // Tall enough that the badge's word is at least CARD_MIN_TEXT (it is 0.62 of the height).
  const badgeH = Math.max(BADGE_MIN_H, rows.big * 0.66);
  const chipW = badge === null ? 0 : badgeWidth(ctx, badge, badgeH) + 14 * s;
  const big = p.thinking
    ? 'thinking…'
    : p.status === null
      ? 'waiting…'
      : (p.choiceLabel ?? 'no answer');
  const bigPx = px(CARD_ROWS.big, s);
  let choice = fitShrink(ctx, big.toUpperCase(), innerW - chipW, bigPx, BIG_MIN_PX, 800);
  // A long answer would be cut beside a verdict badge ("SUBMERSIB…"): the badge shrinks to its
  // round ✓/✗ instead.
  const compact = badge?.kind === 'verdict' && choice.text.endsWith('…');
  if (compact) {
    choice = fitShrink(ctx, big.toUpperCase(), innerW - badgeH - 14 * s, bigPx, BIG_MIN_PX, 800);
  }
  ctx.fillStyle =
    p.thinking || p.status === null
      ? 'rgba(255,255,255,0.45)'
      : p.status === 'dropped'
        ? '#cbd5e1'
        : '#ffffff';
  ctx.fillText(choice.text, x, y + rows.big / 2 + 2);
  if (badge !== null) {
    const cx = x + ctx.measureText(choice.text).width + 14 * s;
    if (compact) {
      drawVerdictDot(ctx, badge.verdict, cx + badgeH / 2, y + rows.big / 2, badgeH);
    } else {
      drawBadge(ctx, badge, cx, y + (rows.big - badgeH) / 2, badgeH);
    }
  }
  y += rows.big + gap * 0.6;

  // A newer answer the headline skipped (the fighter's dropped moves): small and muted.
  if (noteRow && p.note !== null) {
    const nt = fitFirst(ctx, noteTexts(p.note), innerW, px(CARD_ROWS.note, s), CARD_MIN_TEXT, 600);
    ctx.fillStyle =
      p.note.status === 'dropped'
        ? 'rgba(203, 213, 225, 0.6)'
        : hexA(STATUS_COLOR[p.note.status], 0.8);
    ctx.fillText(nt.text, x, y + rows.note / 2);
  }
  if (noteRow) y += rows.note + gap * 0.6;
  else y += gap * 0.6;

  // The headline answer's latency, large. (No running cost here: see the header comment.)
  const latency = p.latencyMs === null ? '— ms' : `${String(Math.round(p.latencyMs))} ms`;
  ctx.font = font(px(CARD_ROWS.stats, s), 800);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(latency, x, y + rows.stats / 2);
  y += rows.stats + gap * 1.2;

  const captionPx = px(CARD_ROWS.caption, s);
  const bottom = r.y + r.h - CARD_PAD * s;

  // Thinking: the answer to the question before, labelled as such, instead of the bars.
  if (p.thinking) {
    if (p.previous === null) return;
    ctx.font = font(captionPx, 600);
    ctx.fillStyle = 'rgba(226,232,240,0.66)';
    ctx.fillText(fit(ctx, 'Previous answer', innerW), x, y + rows.caption / 2);
    y += rows.caption + gap;
    const prevBadge = badgeOf(p.previous.status, p.previous.verdict, p.previous.statusText);
    const prevH = Math.max(BADGE_MIN_H, rows.bar * 0.95);
    const prevChipW = prevBadge === null ? 0 : badgeWidth(ctx, prevBadge, prevH) + 12 * s;
    const prevRow = Math.min(rows.big * 0.8, bottom - y);
    const prev = fitShrink(
      ctx,
      (p.previous.choiceLabel ?? 'no answer').toUpperCase(),
      innerW - prevChipW,
      Math.max(CARD_MIN_TEXT + 4, rows.big * 0.7),
      CARD_MIN_TEXT,
      800,
    );
    ctx.fillStyle = 'rgba(226,232,240,0.8)';
    ctx.fillText(prev.text, x, y + prevRow / 2 + 2);
    if (prevBadge !== null) {
      const pw = ctx.measureText(prev.text).width;
      drawBadge(ctx, prevBadge, x + pw + 12 * s, y + (prevRow - prevH) / 2, prevH);
    }
    return;
  }

  // API-reported probabilities.
  ctx.font = font(captionPx, 600);
  ctx.fillStyle = 'rgba(226,232,240,0.66)';
  ctx.fillText(fit(ctx, 'API-reported probabilities', innerW), x, y + rows.caption / 2);
  y += rows.caption + gap * 0.6;
  if (p.bars === null) {
    ctx.font = font(px(CARD_ROWS.bar * 0.8, s), 600);
    ctx.fillStyle = 'rgba(226,232,240,0.5)';
    ctx.fillText(p.status === null ? '' : 'n/a (none reported)', x, y + rows.bar / 2);
    return;
  }
  const bars = p.bars.slice(0, CARD_BARS_MAX);
  const rowH = Math.min(rows.bar * 1.25, (bottom - y) / Math.max(1, bars.length));
  const textPx = Math.max(CARD_MIN_TEXT, Math.min(rows.bar * 0.8, rowH * 0.78));
  const labelW = innerW * 0.44;
  ctx.font = font(textPx, 800);
  const pctW = ctx.measureText('100%').width + 14 * s;
  const trackX = x + labelW;
  const trackW = innerW - labelW - pctW;
  const inset = rowH * 0.2;
  for (const [i, bar] of bars.entries()) {
    const ry = y + i * rowH;
    const chosen = bar.id === p.choice;
    const name = fitShrink(
      ctx,
      bar.label,
      labelW - 12 * s,
      textPx,
      CARD_MIN_TEXT,
      chosen ? 800 : 600,
    );
    ctx.fillStyle = chosen ? '#ffffff' : 'rgba(226,232,240,0.82)';
    ctx.fillText(name.text, x, ry + rowH / 2);
    ctx.fillStyle = 'rgba(255,255,255,0.09)';
    ctx.fillRect(trackX, ry + inset, trackW, rowH - 2 * inset);
    ctx.fillStyle = hexA(color, chosen ? 1 : 0.5);
    ctx.fillRect(trackX, ry + inset, trackW * Math.max(0, Math.min(1, bar.p)), rowH - 2 * inset);
    ctx.font = font(textPx, 800);
    ctx.textAlign = 'right';
    ctx.fillStyle = '#e2e8f0';
    ctx.fillText(`${String(Math.round(bar.p * 100))}%`, x + innerW, ry + rowH / 2);
    ctx.textAlign = 'left';
  }
}

function drawTicker(ctx: CanvasRenderingContext2D, ticker: readonly TickerEntry[], r: Rect): void {
  const cols = 2;
  const rows = Math.ceil(TICKER_MAX / cols);
  const g = r.h * 0.08;
  const colW = (r.w - g * (cols + 1)) / cols;
  const rowH = (r.h - 2 * g) / rows;
  const px = Math.min(44, rowH * 0.5);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  for (const [i, e] of ticker.entries()) {
    // Column-major, newest first: the left column holds the most recent.
    const col = Math.floor(i / rows);
    const row = i % rows;
    const x = r.x + g + col * (colW + g);
    const cy = r.y + g + row * rowH + rowH / 2;
    const faded = e.status === 'dropped';
    ctx.globalAlpha = faded ? 0.5 : 1;
    ctx.fillStyle = e.color;
    ctx.beginPath();
    ctx.arc(x + px * 0.25, cy, px * 0.22, 0, Math.PI * 2);
    ctx.fill();
    const suffix = e.status === 'ok' || e.choice === null ? '' : ` · ${e.statusText}`;
    const dot = px * 0.8;
    const room = e.verdict === null ? 0 : dot + px * 0.4;
    const maxW = colW - px - room;
    const shown = fitShrink(ctx, e.text + suffix, maxW, px, px * 0.75, i === 0 ? 800 : 600);
    ctx.fillText(shown.text, x + px * 0.7, cy + 1);
    if (faded) {
      const w = Math.min(ctx.measureText(e.text).width, maxW);
      ctx.fillRect(x + px * 0.7, cy + 1, w, 3);
    }
    if (e.verdict !== null) {
      const tw = ctx.measureText(shown.text).width;
      drawVerdictDot(ctx, e.verdict, x + px * 0.7 + tw + px * 0.3 + dot / 2, cy + 1, dot);
    }
    ctx.globalAlpha = 1;
  }
}

/**
 * Draws the panel area of `layout`: its background, both seat cards and the ticker (if any).
 * `model` null draws the cards empty under `opts.labels`.
 */
export function drawCompactPanel(
  ctx: CanvasRenderingContext2D,
  model: PanelModel | null,
  layout: Pick<RenderLayout, 'panel' | 'seats' | 'ticker'>,
  opts: CompactPanelOptions = {},
): void {
  const labels = opts.labels ?? ['P1', 'P2'];
  ctx.save();
  ctx.fillStyle = '#090a14';
  ctx.fillRect(layout.panel.x, layout.panel.y, layout.panel.w, layout.panel.h);
  if (layout.ticker !== null) {
    const t = layout.ticker;
    ctx.fillRect(t.x, t.y, t.w, t.h);
    ctx.fillStyle = 'rgba(143, 131, 168, 0.45)';
    ctx.fillRect(t.x, t.y, t.w, 3);
  }
  ctx.fillStyle = 'rgba(143, 131, 168, 0.45)';
  if (layout.panel.y > 0) ctx.fillRect(layout.panel.x, layout.panel.y, layout.panel.w, 3);
  if (layout.panel.x > 0) ctx.fillRect(layout.panel.x, layout.panel.y, 3, layout.panel.h);
  for (const seat of [0, 1] as const) {
    const p = model?.panels[seat] ?? emptySeat(seat, labels[seat]);
    drawSeatCard(ctx, p, layout.seats[seat], opts.noteRow ?? false);
  }
  if (layout.ticker !== null) drawTicker(ctx, model?.ticker ?? [], layout.ticker);
  ctx.restore();
}
