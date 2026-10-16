import { fitShrink } from '../shell/panel.js';
import type { RenderSize } from '../shell/render-layout.js';
import { font, hexA, MODEL_COLORS, playerColor } from '../shell/theme.js';
import type { IntroTeaser } from './intro-model.js';
import type { OutroModel } from './outro-model.js';
import {
  CARD_FRAMES,
  cardOpacity,
  outroTimes,
  PART_FRAMES,
  ramp,
  TITLE_TIMES,
} from './timeline.js';

/**
 * Drawing for the video cards: a dark field, centered captions sized from the shorter side, and
 * the models' colors (theme.ts: Jev teal, OpenAI Decisions amber, the same as in every game,
 * whichever seat) for their names and a thin accent. Text only, no logos, model names in plain
 * text (RULES.md). Each function draws one whole frame.
 */

const BG = '#07080f';
const FG = '#f1f5f9';
const MUTED = 'rgba(203, 213, 225, 0.72)';
const JEV = MODEL_COLORS['jev'] ?? FG;
const OPENAI = MODEL_COLORS['openai'] ?? FG;

/** Words of `text` wrapped into lines no wider than `maxW` at the current font. */
export function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter((w) => w !== '')) {
    const next = line === '' ? word : `${line} ${word}`;
    if (line !== '' && ctx.measureText(next).width > maxW) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line !== '') lines.push(line);
  return lines;
}

/**
 * `text` on one line if it fits `maxW`, else on two lines broken at the word that makes them most
 * even ("Jev won 130 of 160" / "head-to-head matches (81%)").
 */
export function balancedLines(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  if (ctx.measureText(text).width <= maxW) return [text];
  const words = text.split(' ');
  let best: string[] = [text];
  let bestW = Number.POSITIVE_INFINITY;
  for (let i = 1; i < words.length; i++) {
    const pair = [words.slice(0, i).join(' '), words.slice(i).join(' ')];
    const w = Math.max(...pair.map((l) => ctx.measureText(l).width));
    if (w < bestW) {
      bestW = w;
      best = pair;
    }
  }
  return best;
}

/** `text` wrapped at its " · " separators into lines no wider than `maxW` (else at words). */
export function wrapSegments(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const seg of text.split(' · ')) {
    const next = line === '' ? seg : `${line} · ${seg}`;
    if (line !== '' && ctx.measureText(next).width > maxW) {
      lines.push(line);
      line = seg;
    } else line = next;
  }
  if (line !== '') lines.push(line);
  return lines.flatMap((l) => (ctx.measureText(l).width > maxW ? wrapLines(ctx, l, maxW) : [l]));
}

interface Frame {
  ctx: CanvasRenderingContext2D;
  W: number;
  H: number;
  /** Output px per design px (the design is 1080 on the shorter side). */
  u: number;
  frame: number;
}

function begin(ctx: CanvasRenderingContext2D, size: RenderSize, frame: number): Frame {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, size.width, size.height);
  return {
    ctx,
    W: size.width,
    H: size.height,
    u: Math.min(size.width, size.height) / 1080,
    frame,
  };
}

/** A part fading in and rising into place from `start`. Returns the y offset to draw it at. */
function partIn(f: Frame, start: number, card: number): number {
  const a = ramp(f.frame, start, PART_FRAMES);
  f.ctx.globalAlpha = a * card;
  return (1 - a) * 18 * f.u;
}

function centered(
  f: Frame,
  text: string,
  y: number,
  px: number,
  weight: number,
  color: string,
  maxW = f.W - 160 * f.u,
): void {
  const { ctx } = f;
  const t = fitShrink(ctx, text, maxW, px, px * 0.6, weight);
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(t.text, f.W / 2, y);
}

/** Two short bars in the models' colors (Jev's, then OpenAI Decisions'), centered at y. */
function accentBar(f: Frame, y: number, w: number): void {
  const { ctx, u } = f;
  const h = 8 * u;
  const gap = 10 * u;
  ctx.fillStyle = JEV;
  ctx.fillRect(f.W / 2 - gap / 2 - w / 2, y - h / 2, w / 2, h);
  ctx.fillStyle = OPENAI;
  ctx.fillRect(f.W / 2 + gap / 2, y - h / 2, w / 2, h);
}

function kicker(f: Frame, text: string, y: number): void {
  const { ctx } = f;
  ctx.save();
  ctx.font = font(34 * f.u, 700);
  ctx.letterSpacing = `${String(6 * f.u)}px`;
  ctx.fillStyle = MUTED;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text.toUpperCase(), f.W / 2, y);
  ctx.restore();
}

/** The intro's maker line, under the matchup. */
export const INTRO_MAKER = 'Jev (TypeSafe) vs OpenAI Decisions';
export const INTRO_TAGLINE = 'three games · same prompt for both';
export const INTRO_NOTE = 'Same state, options, order and timing for both models';

/**
 * Intro, 4 s: "Jev vs OpenAI Decisions", the maker line, "three games · same prompt for both" and
 * the result teaser (introTeaser, from the leaderboard; none before any head-to-head). Whole from
 * its first frame (no fade in: that frame is the video's thumbnail); it fades out at its end.
 */
export function drawIntro(
  ctx: CanvasRenderingContext2D,
  size: RenderSize,
  frame: number,
  teaser: IntroTeaser | null,
): void {
  const f = begin(ctx, size, frame);
  ctx.globalAlpha = cardOpacity(frame, CARD_FRAMES.intro, 0);
  const { u, H, W } = f;
  const top = H / 2 - (teaser === null ? 300 : 360) * u;

  kicker(f, 'Classifier Arena', top);
  centered(f, 'Jev', top + 118 * u, 128 * u, 800, JEV);
  centered(f, 'vs', top + 218 * u, 54 * u, 600, MUTED);
  centered(f, 'OpenAI Decisions', top + 318 * u, 112 * u, 800, OPENAI);
  accentBar(f, top + 410 * u, 220 * u);
  centered(f, INTRO_MAKER, top + 478 * u, 46 * u, 600, FG);
  centered(f, INTRO_TAGLINE, top + 552 * u, 54 * u, 800, FG);

  let y = top + 640 * u;
  if (teaser !== null) {
    // The result, in the leader's color, on one or two lines in a pill.
    const px = 50 * u;
    ctx.font = font(px, 800);
    const maxW = Math.min(W - 160 * u, 1400 * u);
    const lines = balancedLines(ctx, teaser.text, maxW - 60 * u);
    const lineH = px * 1.22;
    const boxW = Math.min(
      W - 80 * u,
      Math.max(...lines.map((l) => ctx.measureText(l).width)) + 72 * u,
    );
    const boxH = lines.length * lineH + 34 * u;
    const color = playerColor(teaser.player, 0);
    ctx.beginPath();
    ctx.roundRect(W / 2 - boxW / 2, y - 26 * u, boxW, boxH, 24 * u);
    ctx.fillStyle = hexA(color, 0.14);
    ctx.fill();
    ctx.lineWidth = 3 * u;
    ctx.strokeStyle = color;
    ctx.stroke();
    ctx.fillStyle = FG;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const [i, line] of lines.entries()) {
      ctx.fillText(line, W / 2, y - 26 * u + 17 * u + lineH * (i + 0.5));
    }
    y += boxH + 22 * u;
  }
  centered(f, INTRO_NOTE, y + 10 * u, 34 * u, 600, MUTED);
  ctx.globalAlpha = 1;
}

/** A game's title card, 1.5 s: "Game n of 3", its name and the decision it asks for. */
export function drawTitle(
  ctx: CanvasRenderingContext2D,
  size: RenderSize,
  frame: number,
  game: { label: string; description: string; position: number; count: number },
): void {
  const f = begin(ctx, size, frame);
  const card = cardOpacity(frame, CARD_FRAMES.title, 10, 10);
  const { u, H, W } = f;
  const mid = H / 2;

  let dy = partIn(f, TITLE_TIMES.name, card);
  kicker(f, `Game ${String(game.position)} of ${String(game.count)}`, mid - 190 * u + dy);
  centered(f, game.label, mid - 70 * u + dy, 132 * u, 800, FG);
  accentBar(f, mid + 40 * u + dy, 200 * u);

  dy = partIn(f, TITLE_TIMES.description, card);
  ctx.font = font(54 * u, 600);
  const maxW = Math.min(W - 160 * u, 940 * u);
  const lines = wrapLines(ctx, game.description, maxW).slice(0, 3);
  ctx.fillStyle = FG;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const [i, line] of lines.entries()) {
    ctx.fillText(line, W / 2, mid + 130 * u + i * 70 * u + dy);
  }
  ctx.globalAlpha = 1;
}

/**
 * The outro, 7.5 s: the leaderboard in short (each model's column in its color), or "results
 * pending", the legend on up to two lines, and the repo link, all whole on screen from about
 * 2.3 s to the end.
 */
export function drawOutro(
  ctx: CanvasRenderingContext2D,
  size: RenderSize,
  frame: number,
  model: OutroModel,
): void {
  const f = begin(ctx, size, frame);
  const card = cardOpacity(frame, CARD_FRAMES.outro, 12, 0);
  const times = outroTimes(model.games.length);
  const { u, W, H } = f;
  // The table spans at most 1000 design px, centered.
  const tableW = Math.min(W - 100 * u, 1000 * u);
  const left = (W - tableW) / 2;
  const labelW = tableW * 0.28;
  const colW = (tableW - labelW) / 2;
  const colX = (i: number) => left + labelW + colW * i + colW / 2;
  const rowH = 164 * u;
  // The legend, wrapped to the table (one or two lines) at a size a phone can read.
  const legendPx = 34 * u;
  ctx.font = font(legendPx, 600);
  const legendLines = wrapSegments(ctx, model.legend, tableW).slice(0, 2);
  const legendH = legendLines.length * legendPx * 1.25 + 26 * u;
  // Vertical layout: heading, column heads, overall, games, legend, link; centered as a block.
  const blockH = model.pending
    ? 120 * u + 110 * u + model.games.length * rowH * 0.7 + 60 * u + legendH + 90 * u
    : 110 * u + 100 * u + 108 * u + model.games.length * rowH + legendH + 90 * u;
  let y = Math.max(24 * u, (H - blockH) / 2);

  let dy = partIn(f, times.heading, card);
  centered(f, model.pending ? 'Results pending' : 'Results', y + 46 * u + dy, 84 * u, 800, FG);
  y += model.pending ? 120 * u : 110 * u;

  if (model.pending) {
    dy = partIn(f, times.overall, card);
    centered(f, 'Head-to-head runs not published yet', y + 20 * u + dy, 42 * u, 600, MUTED);
    y += 110 * u;
    for (const [i, g] of model.games.entries()) {
      dy = partIn(f, times.games[i] ?? 0, card);
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      ctx.font = font(52 * u, 800);
      ctx.fillStyle = FG;
      ctx.fillText(g.label, left + 40 * u, y + rowH * 0.35 + dy);
      ctx.textAlign = 'right';
      ctx.font = font(44 * u, 600);
      ctx.fillStyle = MUTED;
      ctx.fillText('pending', left + tableW - 40 * u, y + rowH * 0.35 + dy);
      ctx.fillStyle = 'rgba(148, 163, 184, 0.18)';
      ctx.fillRect(left, y + rowH * 0.7 + dy, tableW, 2 * u);
      y += rowH * 0.7;
    }
    y += 60 * u;
  } else {
    // Column heads: each model's name, its model id under it.
    dy = partIn(f, times.heading, card);
    for (const [i, m] of model.models.entries()) {
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'center';
      const name = fitShrink(ctx, m.name, colW - 24 * u, 42 * u, 28 * u, 800);
      ctx.fillStyle = m.color;
      ctx.fillText(name.text, colX(i), y + 22 * u + dy);
      if (m.detail !== '') {
        const detail = fitShrink(ctx, m.detail, colW - 24 * u, 30 * u, 24 * u, 600);
        ctx.fillStyle = MUTED;
        ctx.fillText(detail.text, colX(i), y + 64 * u + dy);
      }
    }
    y += 100 * u;

    // Overall.
    dy = partIn(f, times.overall, card);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = font(40 * u, 800);
    ctx.fillStyle = FG;
    ctx.fillText('Overall', left, y + 34 * u + dy);
    for (const [i, m] of model.models.entries()) {
      ctx.textAlign = 'center';
      ctx.font = font(72 * u, 800);
      // The leader's number in its model's color.
      ctx.fillStyle = m.lead ? m.color : FG;
      ctx.fillText(m.overall, colX(i), y + 34 * u + dy);
    }
    ctx.fillStyle = 'rgba(148, 163, 184, 0.3)';
    ctx.fillRect(left, y + 86 * u + dy, tableW, 2 * u);
    y += 108 * u;

    for (const [gi, g] of model.games.entries()) {
      dy = partIn(f, times.games[gi] ?? 0, card);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      const t = fitShrink(ctx, g.label, labelW - 16 * u, 44 * u, 30 * u, 800);
      ctx.fillStyle = FG;
      ctx.fillText(t.text, left, y + 40 * u + dy);
      for (const [i, c] of g.cells.entries()) {
        const cx = colX(i);
        ctx.textAlign = 'center';
        ctx.font = font(56 * u, 800);
        ctx.fillStyle = c.lead ? (model.models[i]?.color ?? FG) : g.pending ? MUTED : FG;
        ctx.fillText(c.winRate, cx, y + 32 * u + dy);
        ctx.font = font(34 * u, 600);
        ctx.fillStyle = MUTED;
        ctx.fillText(c.p50, cx, y + 84 * u + dy);
        ctx.fillText(c.cost, cx, y + 122 * u + dy);
      }
      ctx.fillStyle = 'rgba(148, 163, 184, 0.18)';
      ctx.fillRect(left, y + rowH - 16 * u + dy, tableW, 2 * u);
      y += rowH;
    }
  }

  dy = partIn(f, times.url - 8, card);
  for (const [i, line] of legendLines.entries()) {
    centered(f, line, y + 14 * u + i * legendPx * 1.25 + dy, legendPx, 600, MUTED, tableW);
  }
  y += legendH;
  dy = partIn(f, times.url, card);
  ctx.font = font(40 * u, 800);
  const url = model.url;
  const urlW = Math.min(ctx.measureText(url).width + 60 * u, W - 60 * u);
  ctx.beginPath();
  ctx.roundRect(W / 2 - urlW / 2, y + 10 * u + dy, urlW, 72 * u, 36 * u);
  ctx.fillStyle = 'rgba(226, 232, 240, 0.1)';
  ctx.fill();
  ctx.lineWidth = 3 * u;
  ctx.strokeStyle = 'rgba(226, 232, 240, 0.85)';
  ctx.stroke();
  centered(f, url, y + 46 * u + dy, 40 * u, 800, FG, urlW - 40 * u);
  ctx.globalAlpha = 1;
}
