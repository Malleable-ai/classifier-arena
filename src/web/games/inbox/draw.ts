import type { Seat } from '../../../core/classifier/types.js';
import { messageText } from '../../../games/inbox/data.js';
import { damageOf } from '../../../games/inbox/engine/sim.js';
import type { InboxConfig, InboxState } from '../../../games/inbox/engine/types.js';
import { font, hexA } from '../../shell/theme.js';
import type { FrameInfo } from '../index.js';
import {
  accuracyPct,
  accuracyTexts,
  BANNER_BAND,
  bannerText,
  CARD_H,
  CARD_HEAD_H,
  CARD_INSET,
  CARD_PAD_TOP,
  CARD_PAD_X,
  CARD_TEXT_GAP,
  CARD_TEXT_W,
  CARD_W,
  cardPose,
  formatClock,
  HEADER_ROW,
  headerLabels,
  healthDigits,
  inboxRect,
  LANE_X,
  laneCards,
  laneRect,
  laneResolutions,
  lastHit,
  messageLayout,
  openBand,
  optionLabel,
  pulseAt,
  rowVisible,
  STAGE_H,
  STAGE_W,
  textRow,
  wrapText,
  type CardPose,
  type LaneCard,
  type MessageLayout,
} from './model.js';

/**
 * Paints Inbox Invaders' 1920×1080 stage from `model.ts`: the header (player labels, inbox-health
 * meters, the clock and message count), two lanes of falling message cards above each seat's
 * inbox bar, and the game-over banner. Icons are drawn as paths (no glyph fonts, no images), and
 * every animation comes from ticks, so a frame depends only on the frame.
 */

const BG_TOP = '#0b1026';
const BG_BOTTOM = '#171433';
const TEXT = '#f1f5f9';
const MUTED = 'rgba(226, 232, 240, 0.72)';
const GREEN = '#4ade80';
const RED = '#f87171';
const GREY = '#9ca3af';
const SMISH = '#e879f9';
const HURT = '#f43f5e';
/** The game-over banner's backing: opaque. */
export const BANNER_BG = '#070816';

const CARD_STYLE = {
  falling: { fill: '#1c2238', stroke: 'rgba(203, 213, 225, 0.30)', text: TEXT },
  cleared: { fill: '#0e3b2a', stroke: GREEN, text: '#dcfce7' },
  wrong: { fill: '#4a1416', stroke: RED, text: '#fee2e2' },
  landed: { fill: '#2a2d36', stroke: GREY, text: '#a1a1aa' },
} as const;

/**
 * Raises a design size to the stage's legibility floor (shell/theme.ts legibleFloor): every text a
 * viewer must read goes through it, so the square video and phones get readable text while a
 * desktop player keeps the design sizes.
 */
type Legible = (px: number) => number;

/** Wrapped lines per (size, lines, text): measuring is the slow part, and the result never changes. */
const wrapCache = new Map<string, string[]>();

function cardLines(ctx: CanvasRenderingContext2D, id: string, m: MessageLayout): string[] {
  const key = `${String(m.px)}|${String(m.lines)}|${String(CARD_TEXT_W)}|${id}`;
  let lines = wrapCache.get(key);
  if (lines === undefined) {
    ctx.font = font(m.px, 500);
    lines = wrapText(messageText(id), CARD_TEXT_W, m.lines, (s) => ctx.measureText(s).width);
    wrapCache.set(key, lines);
  }
  return lines;
}

/** Shrink `text` with an ellipsis until it fits `maxW` at the current font. */
function fit(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxW) t = t.slice(0, -1);
  return `${t}…`;
}

/** The largest font from `maxPx` down to `minPx` that fits `text` in `maxW`; then `fit`. */
function fitShrink(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxW: number,
  maxPx: number,
  minPx: number,
  weight: number,
): string {
  let px = maxPx;
  ctx.font = font(px, weight);
  while (px > minPx && ctx.measureText(text).width > maxW) {
    px = Math.max(minPx, px - 2);
    ctx.font = font(px, weight);
  }
  return fit(ctx, text, maxW);
}

/**
 * The first of `texts` (longest first) that fits `maxW` at a size from `maxPx` down to `minPx`,
 * with that font set; else the last one, ellipsized at `minPx`.
 */
function fitFirst(
  ctx: CanvasRenderingContext2D,
  texts: readonly string[],
  maxW: number,
  maxPx: number,
  minPx: number,
  weight: number,
): { text: string; fits: boolean } {
  for (const text of texts) {
    for (let px = maxPx; px >= minPx; px -= 2) {
      ctx.font = font(px, weight);
      if (ctx.measureText(text).width <= maxW) return { text, fits: true };
    }
  }
  ctx.font = font(minPx, weight);
  return { text: fit(ctx, texts[texts.length - 1] ?? '', maxW), fits: false };
}

// --- icons (paths, centred on (cx, cy), size s) ----------------------------------------------

function checkIcon(ctx: CanvasRenderingContext2D, cx: number, cy: number, s: number, c: string) {
  ctx.save();
  ctx.strokeStyle = c;
  ctx.lineWidth = s * 0.2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(cx - s * 0.42, cy + s * 0.02);
  ctx.lineTo(cx - s * 0.12, cy + s * 0.32);
  ctx.lineTo(cx + s * 0.44, cy - s * 0.32);
  ctx.stroke();
  ctx.restore();
}

function crossIcon(ctx: CanvasRenderingContext2D, cx: number, cy: number, s: number, c: string) {
  ctx.save();
  ctx.strokeStyle = c;
  ctx.lineWidth = s * 0.2;
  ctx.lineCap = 'round';
  const r = s * 0.32;
  ctx.beginPath();
  ctx.moveTo(cx - r, cy - r);
  ctx.lineTo(cx + r, cy + r);
  ctx.moveTo(cx + r, cy - r);
  ctx.lineTo(cx - r, cy + r);
  ctx.stroke();
  ctx.restore();
}

function downIcon(ctx: CanvasRenderingContext2D, cx: number, cy: number, s: number, c: string) {
  ctx.save();
  ctx.strokeStyle = c;
  ctx.lineWidth = s * 0.17;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(cx, cy - s * 0.4);
  ctx.lineTo(cx, cy + s * 0.22);
  ctx.moveTo(cx - s * 0.3, cy - s * 0.04);
  ctx.lineTo(cx, cy + s * 0.26);
  ctx.lineTo(cx + s * 0.3, cy - s * 0.04);
  ctx.moveTo(cx - s * 0.4, cy + s * 0.44);
  ctx.lineTo(cx + s * 0.4, cy + s * 0.44);
  ctx.stroke();
  ctx.restore();
}

/** The smishing badge: a small warning triangle. */
function warnIcon(ctx: CanvasRenderingContext2D, cx: number, cy: number, s: number, c: string) {
  ctx.save();
  ctx.strokeStyle = c;
  ctx.fillStyle = c;
  ctx.lineWidth = s * 0.1;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(cx, cy - s * 0.42);
  ctx.lineTo(cx + s * 0.46, cy + s * 0.38);
  ctx.lineTo(cx - s * 0.46, cy + s * 0.38);
  ctx.closePath();
  ctx.stroke();
  ctx.fillRect(cx - s * 0.05, cy - s * 0.16, s * 0.1, s * 0.3);
  ctx.fillRect(cx - s * 0.05, cy + s * 0.2, s * 0.1, s * 0.09);
  ctx.restore();
}

function bubbleIcon(ctx: CanvasRenderingContext2D, cx: number, cy: number, s: number, c: string) {
  ctx.save();
  ctx.fillStyle = c;
  ctx.beginPath();
  ctx.roundRect(cx - s * 0.5, cy - s * 0.38, s, s * 0.62, s * 0.18);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(cx - s * 0.28, cy + s * 0.2);
  ctx.lineTo(cx - s * 0.36, cy + s * 0.44);
  ctx.lineTo(cx - s * 0.05, cy + s * 0.22);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function heartIcon(ctx: CanvasRenderingContext2D, cx: number, cy: number, s: number, c: string) {
  ctx.save();
  ctx.fillStyle = c;
  ctx.beginPath();
  ctx.moveTo(cx, cy + s * 0.42);
  ctx.bezierCurveTo(cx - s * 0.6, cy + s * 0.02, cx - s * 0.5, cy - s * 0.46, cx, cy - s * 0.18);
  ctx.bezierCurveTo(cx + s * 0.5, cy - s * 0.46, cx + s * 0.6, cy + s * 0.02, cx, cy + s * 0.42);
  ctx.fill();
  ctx.restore();
}

function trayIcon(ctx: CanvasRenderingContext2D, cx: number, cy: number, s: number, c: string) {
  ctx.save();
  ctx.strokeStyle = c;
  ctx.lineWidth = s * 0.12;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(cx - s * 0.5, cy);
  ctx.lineTo(cx - s * 0.18, cy);
  ctx.lineTo(cx - s * 0.1, cy + s * 0.16);
  ctx.lineTo(cx + s * 0.1, cy + s * 0.16);
  ctx.lineTo(cx + s * 0.18, cy);
  ctx.lineTo(cx + s * 0.5, cy);
  ctx.lineTo(cx + s * 0.5, cy + s * 0.38);
  ctx.lineTo(cx - s * 0.5, cy + s * 0.38);
  ctx.closePath();
  ctx.moveTo(cx - s * 0.5, cy);
  ctx.lineTo(cx - s * 0.32, cy - s * 0.38);
  ctx.lineTo(cx + s * 0.32, cy - s * 0.38);
  ctx.lineTo(cx + s * 0.5, cy);
  ctx.stroke();
  ctx.restore();
}

// --- stage ----------------------------------------------------------------------------------

function drawBackground(ctx: CanvasRenderingContext2D): void {
  const g = ctx.createLinearGradient(0, 0, 0, STAGE_H);
  g.addColorStop(0, BG_TOP);
  g.addColorStop(1, BG_BOTTOM);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, STAGE_W, STAGE_H);
}

function drawLaneFrame(ctx: CanvasRenderingContext2D, seat: Seat, color: string): void {
  const r = laneRect(seat);
  ctx.beginPath();
  ctx.roundRect(r.x, r.y, r.w, r.h, 26);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.035)';
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = hexA(color, 0.4);
  ctx.stroke();
}

function drawHeader(
  ctx: CanvasRenderingContext2D,
  state: InboxState,
  seat: Seat,
  color: string,
  labels: readonly string[],
  pulse: number,
  damage: number,
  lg: Legible,
): void {
  const lane = state.lanes[seat];
  const max = state.config.health;
  const frac = Math.max(0, Math.min(1, lane.health / max));
  const barW = 700;
  const barH = 50;
  const outer = seat === 0 ? 60 : STAGE_W - 60;
  const x0 = seat === 0 ? outer : outer - barW;
  const barY = 98;
  const inner = seat === 0 ? x0 + barW : x0;

  // Label (outer-aligned) and the health number with a heart (inner end), above the bar. The
  // label's space is fixed, sized for the widest health number (the starting health), so it is
  // cut the same way whatever the health is now.
  ctx.textBaseline = 'alphabetic';
  ctx.font = font(54, 800);
  const num = String(lane.health);
  const numW = ctx.measureText(num).width;
  const numMaxW = ctx.measureText('8'.repeat(healthDigits(max))).width;
  ctx.fillStyle = color;
  ctx.textAlign = seat === 0 ? 'left' : 'right';
  const labelText = fitFirst(ctx, labels, barW - numMaxW - 100, lg(48), lg(36), 800).text;
  ctx.fillText(labelText, outer, 78);

  ctx.textAlign = seat === 0 ? 'right' : 'left';
  ctx.font = font(54, 800);
  const hurt = pulse > 0 ? mix('#ffffff', HURT, pulse) : '#ffffff';
  ctx.fillStyle = hurt;
  ctx.fillText(num, inner, 80);
  const heartX = seat === 0 ? inner - numW - 30 : inner + numW + 30;
  heartIcon(ctx, heartX, 62, 38, pulse > 0 ? HURT : '#fb7185');

  // Bar: track, fill anchored at the outer edge (draining toward the centre), pulse outline.
  ctx.beginPath();
  ctx.roundRect(x0 - 4, barY - 4, barW + 8, barH + 8, 12);
  ctx.fillStyle = '#0d0f1c';
  ctx.fill();
  ctx.fillStyle = '#3b1420';
  ctx.fillRect(x0, barY, barW, barH);
  const fillW = barW * frac;
  // The seat's colour at any health, so who is who still reads when it matters most; low health
  // shows as a red outline instead.
  ctx.fillStyle = color;
  ctx.fillRect(seat === 0 ? x0 : x0 + barW - fillW, barY, fillW, barH);
  if (frac <= 0.3 && lane.health > 0 && pulse <= 0) {
    ctx.lineWidth = 6;
    ctx.strokeStyle = hexA(HURT, 0.9);
    ctx.beginPath();
    ctx.roundRect(x0 - 4, barY - 4, barW + 8, barH + 8, 12);
    ctx.stroke();
  }
  if (pulse > 0) {
    ctx.fillStyle = hexA(HURT, 0.45 * pulse);
    ctx.fillRect(x0, barY, barW, barH);
    ctx.lineWidth = 4 + 8 * pulse;
    ctx.strokeStyle = hexA(HURT, pulse);
    ctx.beginPath();
    ctx.roundRect(x0 - 4, barY - 4, barW + 8, barH + 8, 12);
    ctx.stroke();
    // The damage, rising off the bar's inner end.
    ctx.font = font(lg(44), 800);
    ctx.textAlign = seat === 0 ? 'right' : 'left';
    ctx.textBaseline = 'middle';
    ctx.globalAlpha = pulse;
    ctx.fillStyle = '#ffffff';
    const dx = seat === 0 ? inner - 14 : inner + 14;
    ctx.fillText(`−${String(damage)}`, dx, barY + barH / 2 + 2 - (1 - pulse) * 14);
    ctx.globalAlpha = 1;
  }
}

/** `a` blended toward `b` by t (both `#rrggbb`). */
function mix(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const ch = (shift: number): number =>
    Math.round(((pa >> shift) & 255) * (1 - t) + ((pb >> shift) & 255) * t);
  return `rgb(${String(ch(16))}, ${String(ch(8))}, ${String(ch(0))})`;
}

function drawClock(
  ctx: CanvasRenderingContext2D,
  state: InboxState,
  lg: Legible,
  note?: string,
): void {
  // Wide enough for the message count at the legibility floor (at most the gap between the bars).
  ctx.font = font(lg(40), 700);
  const count = `${String(state.next)} / ${String(state.stream.length)} msgs`;
  const w = Math.min(390, Math.max(300, ctx.measureText(count).width + 40));
  const x = STAGE_W / 2 - w / 2;
  ctx.beginPath();
  ctx.roundRect(x, 14, w, 140, 22);
  ctx.fillStyle = 'rgba(5, 6, 18, 0.6)';
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
  ctx.stroke();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ffffff';
  ctx.font = font(74, 800);
  ctx.fillText(formatClock(state.tick), STAGE_W / 2, 64);
  ctx.font = font(lg(40), 700);
  ctx.fillStyle = MUTED;
  ctx.fillText(fit(ctx, count, w - 16), STAGE_W / 2, 124);
  if (note !== undefined) {
    ctx.font = font(lg(36), 700);
    ctx.fillStyle = '#fde68a';
    ctx.fillText(note, STAGE_W / 2, 186);
  }
}

function drawInbox(
  ctx: CanvasRenderingContext2D,
  state: InboxState,
  seat: Seat,
  color: string,
  landPulse: number,
  lg: Legible,
): void {
  const r = inboxRect(seat);
  const lane = state.lanes[seat];
  ctx.beginPath();
  ctx.roundRect(r.x, r.y, r.w, r.h, 18);
  // Opaque, so a landed card sinks out of sight behind it.
  ctx.fillStyle = mix('#1a1d36', '#6b1426', landPulse);
  ctx.fill();
  ctx.lineWidth = 3 + 5 * landPulse;
  ctx.strokeStyle = landPulse > 0 ? hexA(HURT, 0.6 + 0.4 * landPulse) : hexA(color, 0.55);
  ctx.stroke();

  const cy = r.y + r.h / 2;
  trayIcon(ctx, r.x + 54, cy, 52, color);
  ctx.font = font(lg(42), 800);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = color;
  ctx.fillText('INBOX', r.x + 98, cy + 2);
  const labelEnd = r.x + 98 + ctx.measureText('INBOX').width;

  // Counters, right-aligned: cleared, wrong, landed (icon + number each).
  const items = [
    { n: lane.cleared, icon: checkIcon, c: GREEN },
    { n: lane.wrong, icon: crossIcon, c: RED },
    { n: lane.landed, icon: downIcon, c: GREY },
  ];
  ctx.font = font(lg(44), 800);
  let x = r.x + r.w - 26;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it === undefined) continue;
    const t = String(it.n);
    const tw = ctx.measureText(t).width;
    ctx.textAlign = 'right';
    ctx.fillStyle = TEXT;
    ctx.fillText(t, x, cy + 2);
    x -= tw + 30;
    it.icon(ctx, x, cy, 40, it.c);
    x -= 52;
  }
  // The accuracy between the label and the counters: "92% right", smaller, or just "92%" once
  // the counters grow; never over either.
  const acc = accuracyPct(lane);
  if (acc !== null) {
    const right = x - 6;
    const shown = fitFirst(ctx, accuracyTexts(acc), right - (labelEnd + 24), lg(40), lg(32), 600);
    if (shown.fits) {
      ctx.fillStyle = MUTED;
      ctx.textAlign = 'right';
      ctx.fillText(shown.text, right, cy + 2);
    }
  }
}

/** The card's verdict row: icon, choice (and the true class when wrong or landed), damage. */
function drawVerdict(
  ctx: CanvasRenderingContext2D,
  card: LaneCard,
  x: number,
  cy: number,
  damage: number,
  lg: Legible,
): void {
  let tx = x;
  const right = x + CARD_TEXT_W;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  if (card.phase === 'cleared') {
    checkIcon(ctx, tx + 20, cy, 44, GREEN);
    tx += 52;
    ctx.font = font(lg(44), 800);
    ctx.fillStyle = '#bbf7d0';
    ctx.fillText(optionLabel(card.choice ?? '').toUpperCase(), tx, cy + 2);
  } else {
    const wrong = card.phase === 'wrong';
    if (wrong) crossIcon(ctx, tx + 20, cy, 44, RED);
    else downIcon(ctx, tx + 20, cy, 42, '#e5e7eb');
    tx += 52;
    ctx.font = font(lg(44), 800);
    ctx.fillStyle = wrong ? '#fecaca' : '#e5e7eb';
    const head = wrong ? optionLabel(card.choice ?? '').toUpperCase() : 'LANDED';
    ctx.fillText(head, tx, cy + 2);
    tx += ctx.measureText(head).width + 14;
    ctx.font = font(lg(40), 600);
    ctx.fillStyle = wrong ? '#fca5a5' : '#d4d4d8';
    ctx.fillText(`· was ${optionLabel(card.label)}`, tx, cy + 2);
  }

  // Right side: the damage taken, and the smishing badge left of it.
  let rx = right;
  if (card.phase !== 'cleared') {
    ctx.font = font(lg(40), 800);
    const t = `−${String(damage)}`;
    const w = ctx.measureText(t).width + 30;
    const h = Math.max(48, lg(40) + 8);
    ctx.beginPath();
    ctx.roundRect(rx - w, cy - h / 2, w, h, h / 2);
    ctx.fillStyle = card.phase === 'wrong' ? '#b91c1c' : '#52525b';
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.fillText(t, rx - w / 2, cy + 2);
    rx -= w + 14;
  }
  if (card.label === 'smishing') warnIcon(ctx, rx - 22, cy, 42, SMISH);
}

/**
 * One card at `pose`. `rows(row)` says whether a row of it is clear of the cards in front (and
 * inside the lane): the header row and each text line are drawn whole or not at all.
 */
function drawCard(
  ctx: CanvasRenderingContext2D,
  card: LaneCard,
  pose: CardPose,
  seat: Seat,
  config: InboxConfig,
  rows: (row: { top: number; bottom: number }) => boolean,
  lg: Legible,
  message: MessageLayout,
): void {
  if (pose.alpha <= 0) return;
  const style = CARD_STYLE[card.phase];
  const { x, y } = pose;
  ctx.save();
  if (pose.swiping) {
    // Swiping out: only inside the card column, so nothing of it shows in the lane's margin. The
    // outward edge is the column's own; the inward side keeps room for the stroke and shadow.
    const col = LANE_X[seat] + CARD_INSET;
    const left = seat === 0 ? col : col - 4;
    const right = seat === 0 ? col + CARD_W + 8 : col + CARD_W;
    ctx.beginPath();
    ctx.rect(left, 0, right - left, STAGE_H);
    ctx.clip();
  }
  ctx.globalAlpha = pose.alpha;

  // Drop shadow so stacked cards separate.
  ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
  ctx.beginPath();
  ctx.roundRect(x + 4, y + 8, CARD_W, CARD_H, 22);
  ctx.fill();

  ctx.beginPath();
  ctx.roundRect(x, y, CARD_W, CARD_H, 22);
  ctx.fillStyle = style.fill;
  ctx.fill();
  ctx.lineWidth = card.phase === 'falling' ? 3 : 6;
  ctx.strokeStyle = style.stroke;
  ctx.stroke();
  if (pose.flash > 0) {
    ctx.fillStyle = `rgba(255, 255, 255, ${(0.35 * pose.flash).toFixed(3)})`;
    ctx.fill();
  }

  ctx.globalAlpha = pose.alpha * pose.textAlpha;
  if (ctx.globalAlpha <= 0) {
    ctx.restore();
    return;
  }
  const tx = x + CARD_PAD_X;
  const headCy = y + CARD_PAD_TOP + CARD_HEAD_H / 2;
  if (!rows(HEADER_ROW)) {
    // Covered (a pile, or a verdict held over it): no header.
  } else if (card.phase === 'falling') {
    bubbleIcon(ctx, tx + 18, headCy, 36, 'rgba(203, 213, 225, 0.55)');
    ctx.font = font(lg(38), 700);
    ctx.fillStyle = MUTED;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(`#${String(card.index + 1)}`, tx + 50, headCy + 2);

    // Seconds to land, in a pill on the right; it warms up as the message nears the inbox.
    const s = card.secondsToLand;
    const t = `${s.toFixed(1)} s`;
    ctx.font = font(lg(40), 800);
    const w = ctx.measureText(t).width + 34;
    const px = x + CARD_W - CARD_PAD_X - w;
    const hot = s <= 0.7 ? RED : s <= 1.5 ? '#fb923c' : null;
    const ph = Math.max(48, lg(40) + 8);
    ctx.beginPath();
    ctx.roundRect(px, headCy - ph / 2, w, ph, ph / 2);
    ctx.fillStyle = hot === null ? 'rgba(255, 255, 255, 0.1)' : hexA(hot, 0.22);
    ctx.fill();
    ctx.fillStyle = hot ?? '#e2e8f0';
    ctx.textAlign = 'center';
    ctx.fillText(t, px + w / 2, headCy + 2);
  } else {
    drawVerdict(ctx, card, tx, headCy, damageOf(config, card.label), lg);
  }

  // The message text, line by line (larger, on fewer lines, at a raised legibility floor).
  const lines = cardLines(ctx, card.id, message);
  const { px: mpx, lineH } = message;
  ctx.font = font(mpx, 500);
  ctx.fillStyle = style.text;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  const top = y + CARD_PAD_TOP + CARD_HEAD_H + CARD_TEXT_GAP;
  for (const [i, line] of lines.entries()) {
    if (!rows(textRow(i, lineH))) continue;
    ctx.fillText(line, tx, top + i * lineH + Math.max(0, (lineH - mpx) / 2 - 1));
  }
  ctx.restore();
}

function drawLaneCards(
  ctx: CanvasRenderingContext2D,
  frame: FrameInfo<InboxState>,
  seat: Seat,
  lg: Legible,
  message: MessageLayout,
) {
  const { state, tick } = frame;
  const r = laneRect(seat);
  const cards = laneCards(state, seat, laneResolutions(frame.decisions, seat), tick);
  const poses = cards.map((c) => cardPose(c, seat));
  // Each card's top edge, or null for one not drawn: what covers the cards behind it.
  const tops = poses.map((p) => (p.alpha > 0 ? p.y : null));
  const open = openBand(seat);
  // Once the game is over its banner covers a band of the lane: no row is drawn cut by it.
  const hidden = bannerText(state, frame.labels) === null ? [] : [BANNER_BAND];
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(r.x, r.y, r.w, r.h, 26);
  ctx.clip();
  for (const [i, card] of cards.entries()) {
    const pose = poses[i];
    if (pose === undefined) continue;
    drawCard(
      ctx,
      card,
      pose,
      seat,
      state.config,
      (row) => rowVisible(tops, i, row, open, hidden),
      lg,
      message,
    );
  }
  ctx.restore();
}

function drawBanner(
  ctx: CanvasRenderingContext2D,
  frame: FrameInfo<InboxState>,
  lg: Legible,
): void {
  const b = bannerText(frame.state, frame.labels);
  if (b === null) return;
  // Below the top of the lanes, so the last verdicts stay readable above it. Opaque, so no card
  // text shows through the title.
  const y = BANNER_BAND.top;
  const h = BANNER_BAND.bottom - BANNER_BAND.top;
  ctx.fillStyle = BANNER_BG;
  ctx.fillRect(0, y, STAGE_W, h);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.18)';
  ctx.fillRect(0, y, STAGE_W, 3);
  ctx.fillRect(0, y + h - 3, STAGE_W, 3);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // The winner in its player's color (its model's, whichever seat).
  ctx.fillStyle = b.winner === null ? '#ffffff' : frame.colors[b.winner];
  const title = fitShrink(ctx, b.title, STAGE_W - 160, 88, 56, 800);
  ctx.fillText(title, STAGE_W / 2, y + h * 0.4);
  ctx.fillStyle = '#fde68a';
  const sub = fitShrink(ctx, b.sub, STAGE_W - 160, lg(46), lg(36), 600);
  ctx.fillText(sub, STAGE_W / 2, y + h * 0.76);
}

/**
 * Draws the whole stage for `frame` into (0,0)–(1920,1080). `minText` is the smallest logical px
 * for text a viewer must read (shell/theme.ts legibleFloor); 0 keeps the design sizes.
 */
export function drawInboxStage(
  ctx: CanvasRenderingContext2D,
  frame: FrameInfo<InboxState>,
  minText = 0,
): void {
  const { state, tick } = frame;
  const lg: Legible = (px) => Math.max(px, Math.round(minText));
  const message = messageLayout(minText);
  ctx.save();
  drawBackground(ctx);
  for (const seat of [0, 1] as const) {
    const hit = lastHit(frame.events, seat);
    const pulse = pulseAt(hit, tick);
    // The player's color (its model's, whichever seat it sits in).
    const color = frame.colors[seat];
    drawLaneFrame(ctx, seat, color);
    const labels = headerLabels(seat, frame.labels[seat]);
    drawHeader(ctx, state, seat, color, labels, pulse, hit?.damage ?? 0, lg);
    drawLaneCards(ctx, frame, seat, lg, message);
    // Over the cards: a landed card sinks into it.
    drawInbox(ctx, state, seat, color, hit?.cause === 'landed' ? pulse : 0, lg);
  }
  drawClock(ctx, state, lg, frame.note);
  drawBanner(ctx, frame, lg);
  ctx.restore();
}
