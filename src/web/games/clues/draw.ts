import type { Seat } from '../../../core/classifier/types.js';
import { shortLabel } from '../../shell/panel.js';
import { font, hexA, NEUTRAL_COLORS } from '../../shell/theme.js';
import type { SeatPair } from '../index.js';
import {
  shadeAlpha,
  darkTextOn,
  fitWord,
  wordSizes,
  wrapText,
  type WordFit,
  type WordSizes,
} from './tiles.js';
import type { CluesScene, MatchOutcome, SeatTurn, StepMark } from './timeline.js';

/**
 * Draws the Clue Clash stage (1920 × 1080 logical px) from a scene. The look is a dictionary
 * entry with its headword hidden: the definition in a serif band on top, its unrevealed words
 * blacked out until their step, the headword box filled in on the reveal, and a "Clue n / 3"
 * marker. Under it, one 4 × 4 probability map per seat: every tile is a board word, shaded in that
 * player's color (its model's, whichever seat) by the API-reported probability for the step on
 * screen (shifting from the last step's as each answer lands). Each board's head marks the seat's
 * three steps on this word and pops "+1" when a step scores. A pure function of the scene.
 *
 * At a raised legibility floor (the square video, a phone: `cluesLayout`) the stage switches to
 * its tall layout: a taller band with the definition large and white (about 40 px of the 1080
 * frame) and wider tiles, so every board word fits on one line.
 */

export const STAGE_W = 1920;
export const STAGE_H = 1080;

const SERIF = 'Georgia, "Times New Roman", Times, serif';
const INK = '#f4efe2';
const MUTED = '#9aa0b4';
const GREEN = '#22c55e';
/** The "+1" and a right step's mark: bright, so it reads on the dark stage. */
const PLUS_GREEN = '#4ade80';
const RED = '#ef4444';
const LAVENDER = '#c4b5fd';
const TILE_BASE = '#1a2038';

// Layout (logical px).
const PAD_X = 48;
const HEAD_H = 76;

/** Where everything goes on the stage (logical px): `cluesLayout`. */
export interface CluesLayout {
  /** The phone layout: a taller band with a large definition, wider tiles. */
  tall: boolean;
  bandH: number;
  /** The definition's area starts here (under the headword row) … */
  defTop: number;
  /** … at the largest size from `defMax` down to `defMin` whose wrap fits (else smaller). */
  defMax: number;
  defMin: number;
  defInk: string;
  margin: number;
  midGap: number;
  boardW: number;
  boardTop: number;
  gridTop: number;
  gridH: number;
  gap: number;
  tileW: number;
  tileH: number;
  /** Room left and right of a tile's word. */
  tilePad: number;
  legendY: number;
}

/** From this legibility floor up (logical px; the square video's is about 49) the tall layout. */
export const TALL_FLOOR = 40;

function layoutOf(
  tall: boolean,
  bandH: number,
  defTop: number,
  margin: number,
  midGap: number,
  gap: number,
  tilePad: number,
  legendY: number,
): CluesLayout {
  const boardW = (STAGE_W - 2 * margin - midGap) / 2;
  const boardTop = bandH + 18;
  const gridTop = boardTop + HEAD_H + 6;
  const gridH = legendY - 16 - gridTop;
  return {
    tall,
    bandH,
    defTop,
    defMax: tall ? 84 : 62,
    defMin: tall ? 70 : 36,
    defInk: tall ? '#ffffff' : INK,
    margin,
    midGap,
    boardW,
    boardTop,
    gridTop,
    gridH,
    gap,
    tileW: (boardW - 3 * gap) / 4,
    tileH: (gridH - 3 * gap) / 4,
    tilePad,
    legendY,
  };
}

/** The desktop layout: the design. */
export const DESIGN_LAYOUT = layoutOf(false, 312, 128, 36, 56, 12, 13, 1012);
/**
 * The tall layout: the band holds four lines of the definition at 70 px (about 40 px of the 1080
 * square), and narrower gaps give each tile about 10% more width for its word.
 */
export const TALL_LAYOUT = layoutOf(true, 450, 120, 20, 36, 10, 8, 1020);

/** The layout for a legibility floor (shell/theme.ts legibleFloor, logical px). */
export function cluesLayout(floor: number): CluesLayout {
  return floor >= TALL_FLOOR ? TALL_LAYOUT : DESIGN_LAYOUT;
}

const boardX = (L: CluesLayout, seat: Seat): number => L.margin + seat * (L.boardW + L.midGap);
/** How strongly the last step's shading shows while the next step is asked. */
const PREV_SHADE = 0.55;

function serifFont(px: number, style = '', weight = 400): string {
  return `${style} ${String(weight)} ${String(Math.round(px))}px ${SERIF}`.trim();
}

export interface DrawOptions {
  labels: SeatPair<string>;
  /** Each seat's player color (FrameInfo.colors). Default: the neutral colors. */
  colors?: SeatPair<string>;
  /** A status line from live mode ("WARMING UP"). */
  note?: string;
  /**
   * The smallest logical px for text a viewer must read (shell/theme.ts legibleFloor). Text under
   * it is raised to it (tile words may go a little under on two lines); 0 keeps the design sizes.
   */
  minText?: number;
}

/** Raises a design size to the floor. */
type Legible = (px: number) => number;

/** What every part of a frame's drawing shares. */
interface Draw {
  ctx: CanvasRenderingContext2D;
  scene: CluesScene;
  L: CluesLayout;
  lg: Legible;
  colors: SeatPair<string>;
}

export function drawCluesStage(
  ctx: CanvasRenderingContext2D,
  scene: CluesScene,
  opts: DrawOptions,
): void {
  const floor = Math.round(opts.minText ?? 0);
  const d: Draw = {
    ctx,
    scene,
    L: cluesLayout(floor),
    lg: (px) => Math.max(px, floor),
    colors: opts.colors ?? NEUTRAL_COLORS,
  };
  ctx.save();
  const bg = ctx.createLinearGradient(0, 0, 0, STAGE_H);
  bg.addColorStop(0, '#0d1122');
  bg.addColorStop(1, '#070911');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, STAGE_W, STAGE_H);
  drawBand(d, opts);
  const sizes = wordSizes(floor);
  for (const seat of [0, 1] as const) drawBoard(d, seat, opts.labels[seat], sizes);
  ctx.restore();
}

// ---------------------------------------------------------------------------------------------
// The definition band.

function drawBand(d: Draw, opts: DrawOptions): void {
  const { ctx, scene, L, lg } = d;
  const band = ctx.createLinearGradient(0, 0, 0, L.bandH);
  band.addColorStop(0, '#161b38');
  band.addColorStop(1, '#11152b');
  ctx.fillStyle = band;
  ctx.fillRect(0, 0, STAGE_W, L.bandH);
  ctx.fillStyle = 'rgba(143, 131, 168, 0.5)';
  ctx.fillRect(0, L.bandH - 3, STAGE_W, 3);

  if (scene.outcome !== null) {
    drawOutcome(d, opts.labels);
  } else {
    drawEntry(d);
  }
  if (opts.note !== undefined) {
    ctx.font = font(lg(36), 800);
    const w = ctx.measureText(opts.note).width + 48;
    ctx.beginPath();
    ctx.roundRect((STAGE_W - w) / 2, 28, w, 56, 28);
    ctx.fillStyle = 'rgba(253, 230, 138, 0.16)';
    ctx.fill();
    ctx.fillStyle = '#fde68a';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(opts.note, STAGE_W / 2, 57);
  }
}

/**
 * The dictionary entry: [headword] part of speech, then "Word n / 16" and the clue step on the
 * right; under them the definition, its unrevealed words as faint bars.
 */
function drawEntry(d: Draw): void {
  const { ctx, scene, lg } = d;
  const rowY = 64;

  // Headword box: a fixed-size blank (never the answer's length) until the reveal.
  const revealed = scene.reveal > 0;
  ctx.font = font(52, 800);
  const answerW = revealed ? ctx.measureText(scene.answer).width : 0;
  const boxW = Math.max(300, answerW + 64);
  const boxH = 78;
  const boxX = PAD_X;
  const boxY = rowY - boxH / 2;
  ctx.beginPath();
  ctx.roundRect(boxX, boxY, boxW, boxH, 14);
  if (revealed) {
    ctx.fillStyle = hexA(GREEN, 0.18 * scene.reveal);
    ctx.fill();
    ctx.lineWidth = 5;
    ctx.strokeStyle = hexA(GREEN, scene.reveal);
    ctx.setLineDash([]);
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.globalAlpha = scene.reveal;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(scene.answer, boxX + boxW / 2, rowY + 2);
    ctx.globalAlpha = 1;
  } else {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.04)';
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(154, 160, 180, 0.7)';
    ctx.setLineDash([14, 10]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(230, 232, 240, 0.75)';
    ctx.font = font(52, 800);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('?', boxX + boxW / 2, rowY + 2);
  }

  // Part of speech, italic, like a dictionary entry.
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.font = serifFont(50, 'italic');
  ctx.fillStyle = LAVENDER;
  ctx.fillText(scene.pos, boxX + boxW + 28, rowY + 2);

  // Right: "Word n / 16", then the clue step as a pill with one segment per step.
  const pillRight = STAGE_W - PAD_X;
  const pillW = drawStepPill(ctx, scene, pillRight, rowY, lg);
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.font = font(lg(40), 800);
  ctx.fillStyle = MUTED;
  ctx.fillText(
    `Word ${String(scene.word + 1)} / ${String(scene.wordCount)}`,
    pillRight - pillW - 28,
    rowY + 2,
  );

  drawDefinition(d);
}

/** "Clue 2 / 3" and three segments, right-aligned at `right`. Returns its width. */
function drawStepPill(
  ctx: CanvasRenderingContext2D,
  scene: CluesScene,
  right: number,
  midY: number,
  lg: Legible,
): number {
  const text = `Clue ${String(scene.step)} / ${String(scene.steps)}`;
  const px = lg(46);
  ctx.font = font(px, 900);
  const textW = ctx.measureText(text).width;
  const seg = Math.round(px * 0.56);
  const segGap = 10;
  const segsW = scene.steps * seg + (scene.steps - 1) * segGap;
  const padX = 26;
  const w = padX + textW + 22 + segsW + padX;
  const h = Math.max(72, px + 24);
  const x = right - w;
  ctx.beginPath();
  ctx.roundRect(x, midY - h / 2, w, h, h / 2);
  ctx.fillStyle = 'rgba(196, 181, 253, 0.16)';
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(196, 181, 253, 0.75)';
  ctx.stroke();
  ctx.fillStyle = '#ede9fe';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + padX, midY + 2);
  const sx = x + padX + textW + 22;
  for (let k = 0; k < scene.steps; k++) {
    ctx.beginPath();
    ctx.roundRect(sx + k * (seg + segGap), midY - seg / 2, seg, seg, 7);
    if (k < scene.step) {
      ctx.fillStyle = LAVENDER;
      ctx.fill();
    } else {
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(196, 181, 253, 0.45)';
      ctx.stroke();
    }
  }
  return w;
}

/**
 * The definition's sizes to try, largest first, each with its line pitch: from the layout's
 * largest down to its smallest (the floor, if higher), then lines a little closer, and only for a
 * definition too long for that, smaller still (down to 36 px; the tall layout's to 52).
 */
export function definitionSizes(L: CluesLayout, floor: number): { px: number; lead: number }[] {
  const min = Math.max(L.defMin, Math.min(L.defMax, floor));
  const least = L.tall ? 52 : 36;
  const sizes: { px: number; lead: number }[] = [];
  for (let p = L.defMax; p >= min; p -= 2) sizes.push({ px: p, lead: L.tall ? 1.12 : 1.18 });
  sizes.push({ px: min, lead: 1.06 });
  for (let p = min - 2; p >= least; p -= 2) sizes.push({ px: p, lead: 1.06 });
  return sizes;
}

/**
 * The definition, laid out once for all its words (the largest serif size whose wrap fits the
 * band), so revealed words never move as the clue grows. Words revealed by this step fade in;
 * words still hidden are faint rounded bars their own width.
 */
function drawDefinition(d: Draw): void {
  const { ctx, scene, L } = d;
  const top = L.defTop;
  const maxW = STAGE_W - 2 * PAD_X;
  const maxH = L.bandH - top - 20;
  const text = scene.tokens.join(' ');
  let px = 36;
  let lead = 1.06;
  let lines: string[] = [];
  for (const sz of definitionSizes(L, d.lg(0))) {
    ctx.font = serifFont(sz.px);
    lines = wrapText(text, maxW, (s) => ctx.measureText(s).width);
    px = sz.px;
    lead = sz.lead;
    if (lines.length * sz.px * sz.lead <= maxH) break;
  }
  const lineH = px * lead;
  ctx.font = serifFont(px);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  const space = ctx.measureText(' ').width;
  // Centered in the space under the headword row.
  const y0 = top + Math.max(0, (maxH - lines.length * lineH) / 2);
  let index = 0;
  for (const [i, line] of lines.entries()) {
    let x = PAD_X;
    const y = y0 + i * lineH;
    for (const word of line.split(' ')) {
      const w = ctx.measureText(word).width;
      if (index < scene.shownTokens) {
        // A word new at this step fades in (from a quarter) and rises into place.
        const fresh = index >= scene.prevShownTokens;
        const a = fresh ? 0.25 + 0.75 * scene.textFade : 1;
        ctx.globalAlpha = a;
        ctx.fillStyle = L.defInk;
        ctx.fillText(word, x, y + (fresh ? (1 - scene.textFade) * 16 : 0));
        ctx.globalAlpha = 1;
      } else {
        const barH = Math.round(px * 0.5);
        ctx.beginPath();
        ctx.roundRect(x, y + px * 0.34, w, barH, barH / 2);
        ctx.fillStyle = 'rgba(154, 160, 180, 0.17)';
        ctx.fill();
      }
      x += w + space;
      index++;
    }
  }
}

/**
 * The result's words: a headline naming the winner (its variants, longest first, for the room
 * there is) and the lines under it. A tie on points decided by the tiebreak says so: "wins on
 * faster correct answers", then the tied score and both mean latencies on correct answers, the
 * winner's first.
 */
export function outcomeText(
  o: MatchOutcome,
  labels: SeatPair<string>,
): { headlines: string[]; sub: string[] } {
  if (o.winner === 0 || o.winner === 1) {
    const w = o.winner;
    const names = [labels[w], labels[w].replace(/\s*\(.*\)\s*$/, ''), shortLabel(labels[w])]
      .filter((l, i, all) => l !== '' && all.indexOf(l) === i)
      .map((l) => `P${String(w + 1)} · ${l}`);
    if (o.onSpeed) {
      const ms = (seat: Seat): string => {
        const v = o.meanCorrectMs[seat];
        return v === null ? '—' : `${String(Math.round(v))} ms`;
      };
      const who = (seat: Seat): string => shortLabel(labels[seat]) || `P${String(seat + 1)}`;
      const l = w === 0 ? 1 : 0;
      return {
        headlines: names.map((n) => `${n} wins on faster correct answers`),
        sub: [
          `Tied ${String(o.scores[0])} – ${String(o.scores[1])} on points`,
          `mean latency on correct answers: ${who(w)} ${ms(w)} vs ${who(l)} ${ms(l)}`,
        ],
      };
    }
    // The winner's score first: "wins 2 – 1".
    const score = `${String(o.scores[w])} – ${String(o.scores[w === 0 ? 1 : 0])}`;
    return {
      headlines: names.map((n) => `${n} wins ${score}`),
      sub: ['One point per right pick, at each of a word’s three clues.'],
    };
  }
  return {
    headlines: [`Draw ${String(o.scores[0])} – ${String(o.scores[1])}`],
    sub: ['Same score and the same mean latency on correct answers.'],
  };
}

/** After the last turn: who won and the final score (and how a tie on points was broken). */
function drawOutcome(d: Draw, labels: SeatPair<string>): void {
  const { ctx, scene, L, lg } = d;
  const o = scene.outcome;
  if (o === null) return;
  const maxW = STAGE_W - 2 * PAD_X;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.font = font(lg(40), 800);
  ctx.fillStyle = MUTED;
  ctx.fillText('Match over', PAD_X, 64);
  ctx.textAlign = 'right';
  ctx.fillText(
    `${String(scene.wordCount)} words · ${String(scene.turns)} clues`,
    STAGE_W - PAD_X,
    64,
  );

  const text = outcomeText(o, labels);
  const color = o.winner === 0 || o.winner === 1 ? d.colors[o.winner] : INK;
  // The headline: the longest variant that fits at 64 px or more, else the shortest, smaller.
  const maxPx = L.tall ? 100 : 84;
  let headline: string | null = null;
  let px = 60;
  pick: for (const h of text.headlines) {
    for (let size = maxPx; size >= 64; size -= 4) {
      ctx.font = font(size, 800);
      if (ctx.measureText(h).width <= maxW) {
        headline = h;
        px = size;
        break pick;
      }
    }
  }
  if (headline === null) {
    headline = text.headlines.at(-1) ?? '';
    ctx.font = font(px, 800);
    while (px > 40 && ctx.measureText(headline).width > maxW) {
      px -= 4;
      ctx.font = font(px, 800);
    }
  }
  ctx.font = font(px, 800);
  ctx.textAlign = 'left';
  ctx.fillStyle = color;
  ctx.fillText(headline, PAD_X, L.tall ? 190 : 168);

  if (L.tall) {
    // Large, plain and light, a line each: the tiebreak is what the result is about.
    ctx.fillStyle = '#e2e8f0';
    for (const [i, line] of text.sub.slice(0, 2).entries()) {
      let subPx = lg(60);
      ctx.font = font(subPx, 700);
      while (subPx > lg(0) && ctx.measureText(line).width > maxW) {
        subPx -= 2;
        ctx.font = font(subPx, 700);
      }
      ctx.fillText(line, PAD_X, 300 + i * lg(60) * 1.2);
    }
    return;
  }
  const sub = text.sub.join(' · ');
  let subPx = lg(44);
  ctx.font = serifFont(subPx, 'italic');
  ctx.fillStyle = MUTED;
  while (subPx > 36 && ctx.measureText(sub).width > maxW) {
    subPx -= 2;
    ctx.font = serifFont(subPx, 'italic');
  }
  ctx.fillText(sub, PAD_X, 250);
}

// ---------------------------------------------------------------------------------------------
// The boards.

function drawBoard(d: Draw, seat: Seat, label: string, sizes: WordSizes): void {
  const { ctx, scene, L } = d;
  const x0 = boardX(L, seat);
  const color = d.colors[seat];
  const st = scene.seats[seat];
  const winner = scene.outcome?.winner === seat;

  if (winner) {
    ctx.beginPath();
    const inset = Math.min(14, L.midGap / 2 - 4, L.margin - 4);
    ctx.roundRect(x0 - inset, L.boardTop - 10, L.boardW + 2 * inset, STAGE_H - L.boardTop + 2, 22);
    ctx.lineWidth = 6;
    ctx.strokeStyle = hexA(color, 0.9);
    ctx.stroke();
  }

  drawBoardHead(d, seat, label, x0);

  for (const [i, word] of scene.words.entries()) {
    const col = i % 4;
    const row = Math.floor(i / 4);
    drawTile(ctx, scene, st, word, {
      x: x0 + col * (L.tileW + L.gap),
      y: L.gridTop + row * (L.tileH + L.gap),
      color,
      sizes,
      L,
    });
  }

  if (st.miss) drawMiss(d, st, x0);
  drawLegend(ctx, st, color, x0, L);
}

function drawBoardHead(d: Draw, seat: Seat, label: string, x0: number): void {
  const { ctx, scene, L, lg } = d;
  const color = d.colors[seat];
  const st = scene.seats[seat];
  const midY = L.boardTop + HEAD_H / 2;
  const right = x0 + L.boardW - 8;

  // Score, right; it pops (up to SCORE_POP times its size) when the step scores. Its slot is sized
  // for two digits at the popped size, so neither the "+1" beside it nor the label moves or
  // overlaps as it grows.
  const scored = scene.scored[seat] && scene.phase === 'score';
  const pop = scored ? Math.sin(Math.PI * scene.scoreTick) : 0;
  const scoreText = String(scene.scores[seat]);
  ctx.save();
  ctx.translate(right, midY + 4);
  ctx.scale(1 + (SCORE_POP - 1) * pop, 1 + (SCORE_POP - 1) * pop);
  ctx.font = font(80, 900);
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = scored ? '#dcfce7' : '#ffffff';
  ctx.fillText(scoreText, 0, 0);
  ctx.restore();
  ctx.font = font(80, 900);
  const scoreSlot =
    Math.max(ctx.measureText(scoreText).width, ctx.measureText('48').width) * SCORE_POP;

  // "+1" left of the score, for the whole score phase: bright green with a dark outline, rising
  // and popping as the score ticks up.
  ctx.font = font(60, 900);
  const plusW = ctx.measureText('+1').width;
  // A clear gap even at both peaks ("+1" pops to 1.3x about its centre).
  const plusRight = right - scoreSlot - 16 - plusW * 0.15;
  if (scored) {
    const s = 1 + 0.3 * Math.sin(Math.PI * scene.scoreTick);
    ctx.save();
    ctx.translate(plusRight - plusW / 2, midY - 2 - 14 * scene.scoreTick);
    ctx.scale(s, s);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 10;
    ctx.strokeStyle = '#03150a';
    ctx.strokeText('+1', 0, 0);
    ctx.fillStyle = PLUS_GREEN;
    ctx.fillText('+1', 0, 0);
    ctx.restore();
  }

  // This word's three steps for this seat: right, wrong or no answer once scored. Not on the
  // result, which is about the whole match.
  const markR = Math.max(MARK_R, lg(0) * 0.42);
  const marksRight = plusRight - plusW * 1.3 - 20;
  const marksW = drawMarks(ctx, scene, st, color, marksRight, midY, markR);

  // Status chip: thinking…, the latency once the answer lands, or no answer.
  let chip: { text: string; fg: string; bg: string } | null = null;
  if (scene.outcome === null) {
    if (st.miss) {
      chip = { text: 'no answer', fg: '#fecaca', bg: hexA(RED, 0.22) };
    } else if (st.arrived && st.line !== null) {
      chip = {
        text: `${String(Math.round(st.line.latencyMs))} ms`,
        fg: color,
        bg: hexA(color, 0.14),
      };
    } else if (scene.phase === 'answer') {
      const dots = '.'.repeat(1 + (Math.floor(scene.phaseFrame / 10) % 3));
      chip = { text: `thinking${dots}`, fg: MUTED, bg: 'rgba(154, 160, 180, 0.12)' };
    }
  }
  // The chip's slot is always kept, so the label doesn't change size when a chip comes and goes.
  const chipPx = lg(34);
  ctx.font = font(chipPx, 700);
  const chipSlot = Math.max(ctx.measureText('thinking...').width, 140) + 32;

  // Label, left, between the edge and the chip: the full label if it fits at 34 px or more, else
  // without its parenthetical ("OpenAI Decisions"), else the short name; the last resort shrinks
  // and is cut with an ellipsis. Where even the short name won't fit beside the chip at the
  // legibility floor (the square video), the chip goes: the panel under the stage says the same.
  const tag = `P${String(seat + 1)}`;
  const variants = [label, label.replace(/\s*\(.*\)\s*$/, ''), shortLabel(label)]
    .filter((l, i, all) => l !== '' && all.indexOf(l) === i)
    .map((l) => `${tag} · ${l}`);
  const labelRoom = (withChip: boolean): number =>
    marksRight - marksW - 20 - (withChip ? chipSlot + 16 : 0) - (x0 + 4);
  ctx.font = font(lg(34), 800);
  const shortest = ctx.measureText(variants.at(-1) ?? tag).width;
  const chipFits = shortest <= labelRoom(true);
  const maxW = labelRoom(chipFits);
  let shown = variants.at(-1) ?? tag;
  let px = lg(30);
  pick: for (const v of variants) {
    for (let size = lg(44); size >= lg(34); size -= 2) {
      ctx.font = font(size, 800);
      if (ctx.measureText(v).width <= maxW) {
        shown = v;
        px = size;
        break pick;
      }
    }
  }
  ctx.font = font(px, 800);
  while (shown.length > 1 && ctx.measureText(shown).width > maxW) shown = shown.slice(0, -2) + '…';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = color;
  ctx.fillText(shown, x0 + 4, midY + 2);

  if (chip !== null && chipFits) {
    const cx = x0 + 4 + ctx.measureText(shown).width + 16;
    const ch = Math.max(50, chipPx + 16);
    ctx.beginPath();
    ctx.roundRect(cx, midY - ch / 2, chipSlot, ch, ch / 2);
    ctx.fillStyle = chip.bg;
    ctx.fill();
    ctx.font = font(chipPx, 700);
    ctx.fillStyle = chip.fg;
    ctx.textAlign = 'left';
    ctx.fillText(chip.text, cx + 16, midY + 2);
  }
}

const MARK_R = 18;
const MARK_GAP = 10;
/** The score grows to this many times its size as it pops. */
const SCORE_POP = 1.45;

/**
 * The seat's marks for the word on screen, one disc per step, right-aligned at `right`: ✓ on
 * green (+1), ✗ on red (wrong pick), – (no answer), an outline in the seat color for the step
 * being asked, a faint outline for steps to come. None on the result. Returns the width.
 */
function drawMarks(
  ctx: CanvasRenderingContext2D,
  scene: CluesScene,
  st: SeatTurn,
  color: string,
  right: number,
  midY: number,
  r = MARK_R,
): number {
  const n = st.marks.length;
  const w = n * 2 * r + (n - 1) * MARK_GAP;
  if (scene.outcome !== null) return w;
  const x = right - w;
  for (const [k, mark] of st.marks.entries()) {
    const cx = x + r + k * (2 * r + MARK_GAP);
    if (mark === null) {
      const current = k + 1 === scene.step;
      ctx.beginPath();
      ctx.arc(cx, midY, r - 1.5, 0, Math.PI * 2);
      ctx.lineWidth = current ? 4 : 2.5;
      ctx.strokeStyle = current ? color : 'rgba(154, 160, 180, 0.45)';
      ctx.stroke();
      continue;
    }
    drawMarkDisc(ctx, cx, midY, mark, r);
  }
  return w;
}

function drawMarkDisc(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  mark: StepMark,
  r = MARK_R,
): void {
  const k = r / MARK_R;
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = mark === 'right' ? GREEN : mark === 'wrong' ? '#b91c1c' : '#4b5163';
  ctx.fill();
  ctx.beginPath();
  if (mark === 'right') {
    ctx.moveTo(cx - 8 * k, cy + 1 * k);
    ctx.lineTo(cx - 2 * k, cy + 7 * k);
    ctx.lineTo(cx + 8 * k, cy - 6 * k);
  } else if (mark === 'wrong') {
    ctx.moveTo(cx - 6 * k, cy - 6 * k);
    ctx.lineTo(cx + 6 * k, cy + 6 * k);
    ctx.moveTo(cx + 6 * k, cy - 6 * k);
    ctx.lineTo(cx - 6 * k, cy + 6 * k);
  } else {
    ctx.moveTo(cx - 7 * k, cy);
    ctx.lineTo(cx + 7 * k, cy);
  }
  ctx.lineWidth = 4.5 * k;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#ffffff';
  ctx.stroke();
  ctx.restore();
}

interface TileBox {
  x: number;
  y: number;
  color: string;
  sizes: WordSizes;
  L: CluesLayout;
}

function drawTile(
  ctx: CanvasRenderingContext2D,
  scene: CluesScene,
  st: SeatTurn,
  word: string,
  box: TileBox,
): void {
  const { x, y, color } = box;
  const { tileW: tw, tileH: th } = box.L;
  // The last step's shading (dimmed as the new clue appears) shifts to this step's as it lands.
  const prevFactor = scene.phase === 'prompt' ? 1 - (1 - PREV_SHADE) * scene.textFade : PREV_SHADE;
  const prev = shadeAlpha(st.prevProbabilities?.[word]) * prevFactor;
  const cur = shadeAlpha(st.probabilities?.[word]);
  const alpha = prev * (1 - st.shade) + cur * st.shade;
  const picked = st.choice === word;
  const isAnswer = word === scene.answer;
  const r = scene.reveal;
  const wrongPick = picked && !isAnswer && r > 0;

  ctx.beginPath();
  ctx.roundRect(x, y, tw, th, 12);
  ctx.fillStyle = TILE_BASE;
  ctx.fill();
  if (alpha > 0) {
    ctx.fillStyle = hexA(color, alpha);
    ctx.fill();
  }
  if (wrongPick) {
    ctx.fillStyle = hexA(RED, 0.88 * r);
    ctx.fill();
  }
  // On the reveal everything but the answer and the pick steps back.
  if (r > 0 && !isAnswer && !picked) {
    ctx.fillStyle = `rgba(7, 9, 17, ${(0.55 * r).toFixed(3)})`;
    ctx.fill();
  }
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.07)';
  ctx.stroke();

  // The word.
  const dark = darkTextOn(alpha) && !wrongPick;
  const dimmed = r > 0 && !isAnswer && !picked;
  ctx.fillStyle = dark ? '#0b1020' : dimmed ? 'rgba(232, 236, 247, 0.55)' : '#eef1fa';
  drawWord(ctx, word, x + tw / 2, y + th / 2, box.sizes, tw - 2 * box.L.tilePad);

  // The pick: a white outline until the reveal; then green if right, red if wrong.
  if (picked) {
    ctx.beginPath();
    ctx.roundRect(x + 3, y + 3, tw - 6, th - 6, 10);
    ctx.lineWidth = 6;
    ctx.strokeStyle = r > 0 && wrongPick ? '#fecaca' : '#ffffff';
    ctx.stroke();
  }
  if (isAnswer && r > 0) {
    ctx.beginPath();
    ctx.roundRect(x + 4, y + 4, tw - 8, th - 8, 10);
    ctx.lineWidth = 8;
    ctx.strokeStyle = hexA(GREEN, r);
    ctx.stroke();
  }
  // The step's pick is marked once it is scored (✓ for +1, ✗ for a wrong pick), and through the
  // word's reveal.
  const marked = scene.phase === 'score' || scene.phase === 'reveal';
  if (picked && marked) {
    const a = scene.phase === 'score' ? Math.min(1, scene.scoreTick * 3) : 1;
    drawBadge(ctx, x + tw - 10, y + 10, isAnswer, a);
  }
}

const wordFits = new Map<string, WordFit>();

/** The word centered at (cx, cy) in `maxW`, fitted once per word, width and sizes (fitWord). */
function drawWord(
  ctx: CanvasRenderingContext2D,
  word: string,
  cx: number,
  cy: number,
  sizes: WordSizes,
  maxW: number,
): void {
  const key = `${String(maxW)}|${Object.values(sizes).join('|')}|${word}`;
  let fit = wordFits.get(key);
  if (fit === undefined) {
    fit = fitWord(
      word,
      maxW,
      (s, px) => {
        ctx.font = font(px, 800);
        return ctx.measureText(s).width;
      },
      sizes,
    );
    wordFits.set(key, fit);
  }
  ctx.font = font(fit.px, 800);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const lineH = fit.px * 1.06;
  const top = cy - ((fit.lines.length - 1) * lineH) / 2;
  ctx.save();
  ctx.translate(cx, 0);
  ctx.scale(fit.scaleX, 1);
  for (const [i, line] of fit.lines.entries()) ctx.fillText(line, 0, top + i * lineH + 2);
  ctx.restore();
}

/** ✓ or ✗ in a disc on the tile's top-right corner, drawn as strokes (no glyph font needed). */
function drawBadge(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  right: boolean,
  alpha: number,
): void {
  const rad = 20;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  ctx.arc(cx, cy, rad, 0, Math.PI * 2);
  ctx.fillStyle = right ? GREEN : '#b91c1c';
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.strokeStyle = '#070911';
  ctx.stroke();
  ctx.beginPath();
  if (right) {
    ctx.moveTo(cx - 8, cy + 1);
    ctx.lineTo(cx - 2, cy + 7);
    ctx.lineTo(cx + 9, cy - 6);
  } else {
    ctx.moveTo(cx - 6, cy - 6);
    ctx.lineTo(cx + 6, cy + 6);
    ctx.moveTo(cx + 6, cy - 6);
    ctx.lineTo(cx - 6, cy + 6);
  }
  ctx.lineWidth = 5;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#ffffff';
  ctx.stroke();
  ctx.restore();
}

/** A seat that missed the turn: its grid steps back (but the revealed answer) and says so. */
function drawMiss(d: Draw, st: SeatTurn, x0: number): void {
  const { ctx, scene, L, lg } = d;
  for (const [i, word] of scene.words.entries()) {
    if (scene.reveal > 0 && word === scene.answer) continue;
    ctx.beginPath();
    ctx.roundRect(
      x0 + (i % 4) * (L.tileW + L.gap),
      L.gridTop + Math.floor(i / 4) * (L.tileH + L.gap),
      L.tileW,
      L.tileH,
      12,
    );
    ctx.fillStyle = 'rgba(7, 9, 17, 0.6)';
    ctx.fill();
  }
  const status = st.line?.status ?? 'none';
  const text = status === 'timeout' ? 'no answer · timed out' : `no answer · ${status}`;
  ctx.font = font(lg(48), 800);
  const w = ctx.measureText(text).width + 64;
  const cx = x0 + L.boardW / 2;
  const cy = L.gridTop + L.gridH / 2;
  ctx.beginPath();
  ctx.roundRect(cx - w / 2, cy - 44, w, 88, 44);
  ctx.fillStyle = 'rgba(40, 10, 16, 0.92)';
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.strokeStyle = RED;
  ctx.stroke();
  ctx.fillStyle = '#fecaca';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, cx, cy + 2);
}

/** "API-reported probability" with the shade ramp it maps to (or that none were reported). */
function drawLegend(
  ctx: CanvasRenderingContext2D,
  st: SeatTurn,
  color: string,
  x0: number,
  L: CluesLayout,
): void {
  const y = L.legendY + 26;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.font = font(32, 600);
  ctx.fillStyle = MUTED;
  const caption = 'API-reported probability';
  ctx.fillText(caption, x0 + 4, y);
  const capW = ctx.measureText(caption).width;
  const barX = x0 + capW + 32;
  if (st.arrived && !st.miss && st.probabilities === null) {
    ctx.font = font(32, 600);
    ctx.fillStyle = 'rgba(154, 160, 180, 0.75)';
    ctx.fillText('· none reported', barX - 12, y);
    return;
  }
  ctx.font = font(28, 600);
  const endLabel = '100%';
  const endW = ctx.measureText(endLabel).width;
  const startW = ctx.measureText('0%').width;
  // A clear gap between each label and the ramp (it read as touching at video size).
  const gap = 24;
  const barW = Math.max(120, x0 + L.boardW - 8 - endW - gap - (barX + startW + gap));
  const bx = barX + startW + gap;
  ctx.fillStyle = MUTED;
  ctx.fillText('0%', barX, y);
  // The ramp is drawn in steps with the same map the tiles use.
  const steps = 40;
  for (let i = 0; i < steps; i++) {
    const p = (i + 0.5) / steps;
    ctx.fillStyle = TILE_BASE;
    ctx.fillRect(bx + (i * barW) / steps, y - 13, barW / steps + 1, 26);
    ctx.fillStyle = hexA(color, shadeAlpha(p));
    ctx.fillRect(bx + (i * barW) / steps, y - 13, barW / steps + 1, 26);
  }
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
  ctx.strokeRect(bx, y - 13, barW, 26);
  ctx.fillStyle = MUTED;
  ctx.fillText(endLabel, bx + barW + gap, y);
}
