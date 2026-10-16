import { STAGE_MAX, STAGE_MIN, SUB, TICK_RATE } from '../../../games/fighter/engine/constants.js';
import { facingOf } from '../../../games/fighter/engine/fighter.js';
import type { FighterState, MatchState, Side } from '../../../games/fighter/engine/types.js';
import { font, MODEL_COLORS, NEUTRAL_COLORS } from '../../shell/theme.js';
import type { Effect, EffectDrawContext } from './effects.js';
import { drawEffect, drawProjectile, liveEffects } from './effects.js';
import type { Point, Skeleton } from './poses.js';
import { poseFor, SEGMENTS, skeleton, WIDTHS } from './poses.js';

/**
 * The fighter's stage: sky, floor, both fighters, projectiles, effects, the top bar (health,
 * rounds, clock) and the round banner, on a logical 1920x1080. The shell (src/web/shell/stage.ts)
 * draws the decision panel under it and scales the whole canvas to fit. Fighters and effects are
 * all drawn in code: no images, no fonts beyond the system UI stack. Deterministic: a frame
 * depends only on (state, overlay, ui).
 */

export const LOGICAL_W = 1920;
/** The stage (sky, floor, fighters, top bar, banner) occupies y 0..STAGE_H. */
export const STAGE_H = 1080;
export const FLOOR_Y = 950;
/** Stage edges on screen; engine x STAGE_MIN..STAGE_MAX maps linearly between them. */
export const STAGE_LEFT = 160;
export const STAGE_RIGHT = 1760;
/** Logical px per engine unit (1000 units across 1600 px). */
export const PX_PER_UNIT = (STAGE_RIGHT - STAGE_LEFT) / ((STAGE_MAX - STAGE_MIN) / SUB);

/**
 * Fighter drawing scale, local pose px -> logical px. Narrower than tall so silhouettes stay bold at
 * phone width while the core body fits within about +-45 units of the center. At the engine's
 * 60-unit minimum separation the fighters can touch; the outline and draw order keep them apart.
 * FIGHTER_STROKE scales limb thickness.
 */
export const FIGHTER_SCALE_X = 0.7;
export const FIGHTER_SCALE_Y = 0.88;
export const FIGHTER_STROKE = 0.85;
/** Dark outline around each silhouette, logical px each side, so overlapping fighters separate. */
const OUTLINE_PX = 5;

export interface FighterPalette {
  main: string;
  shade: string;
  outline: string;
  band: string;
  flash: string;
}

/**
 * The fighter's shading for each player color (shell/theme.ts): Jev's teal, OpenAI Decisions'
 * amber, and the two neutral baseline colors. A fighter is drawn in its player's color, whichever
 * seat it fights from.
 */
const SLATE_SHADING = { shade: '#64748b', outline: '#0f172a', band: '#1e293b', flash: '#f8fafc' };
const PALETTE_BY_COLOR: ReadonlyMap<string, FighterPalette> = new Map(
  (
    [
      [
        MODEL_COLORS['jev'],
        { shade: '#0f8a7e', outline: '#04262b', band: '#effffb', flash: '#e8fffb' },
      ],
      [
        MODEL_COLORS['openai'],
        { shade: '#b8650a', outline: '#2e1503', band: '#3a1d06', flash: '#fff6dc' },
      ],
      [NEUTRAL_COLORS[0], SLATE_SHADING],
      [
        NEUTRAL_COLORS[1],
        { shade: '#7e22ce', outline: '#1e0b36', band: '#faf5ff', flash: '#faf5ff' },
      ],
    ] as const
  ).map(([main = '', shading]) => [main, { main, ...shading }]),
);

/** The palette for a player color; an unknown color gets the neutral slate shading under it. */
export function paletteFor(color: string): FighterPalette {
  return PALETTE_BY_COLOR.get(color) ?? { main: color, ...SLATE_SHADING };
}

/** The default players' colors (no player known: the sandbox before a match, tests). */
export const DEFAULT_COLORS: readonly [string, string] = NEUTRAL_COLORS;

export function toScreenX(x: number): number {
  return STAGE_LEFT + ((x - STAGE_MIN) / SUB) * PX_PER_UNIT;
}

export interface StageOverlay {
  /** Player labels for the health bars, e.g. ['P1 · Human', 'P2 · Random']. */
  labels: readonly [string, string];
  /**
   * Each seat's player color (FrameInfo.colors): its model's whichever seat it sits in. Default:
   * the neutral colors.
   */
  colors?: readonly [string, string];
  /** Each player's name for the result banner (`displayName`), e.g. 'OpenAI Decisions'. */
  names?: readonly [string, string];
  effects: readonly Effect[];
  /** Small line under the round clock (e.g. "PAUSED"). */
  note?: string;
}

export interface StageLook {
  /** Text scale for the top bar (uiScale). */
  ui: number;
  /** The smallest logical px for text a viewer must read (shell/theme.ts legibleFloor). */
  minText?: number;
  /**
   * The logical area to fill: the whole 1920 × 1080 arena by default; narrower (the square
   * video's SQUARE_STAGE) draws the arena through a camera on the fighters (`cameraFor`), with the
   * top bar and banner laid out across the box.
   */
  box?: { width: number; height: number };
}

/** Text scale for a stage shown `cssScale` CSS px per logical px: grows on small screens. */
export function uiScale(cssScale: number): number {
  return Math.min(1.7, Math.max(1, 0.42 / cssScale));
}

/** 'OpenAI Decisions (gpt-6-luna)' -> 'OpenAI Decisions'; no label -> 'P1' / 'P2'. */
export function displayName(side: Side, label: string): string {
  const name = label.replace(/\s*\(.*\)\s*$/, '').trim();
  return name === '' ? `P${String(side + 1)}` : name;
}

/** The camera never zooms in further than this (box px per arena px). */
export const CAMERA_MAX_ZOOM = 1.25;
/** Arena px the camera keeps on each side of the fighters (reach, effects, a fireball's start). */
export const CAMERA_MARGIN = 260;

export interface Camera {
  /** Box px per arena px. */
  zoom: number;
  /** Arena (x, y) is drawn at (x * zoom + dx, y * zoom + dy). */
  dx: number;
  dy: number;
}

/**
 * The square video's camera for a `box` narrower than the arena: centred between the fighters,
 * as close as CAMERA_MAX_ZOOM while both (and CAMERA_MARGIN either side) fit, never past the
 * arena's ends, with the floor's bottom edge on the box's bottom. A function of the fighters'
 * positions only, so it moves as smoothly as they do and is the same however a frame is reached.
 * The full arena (box 1920 wide) is the identity.
 */
export function cameraFor(
  fighters: readonly [{ x: number }, { x: number }],
  box: { width: number; height: number },
  maxZoom = CAMERA_MAX_ZOOM,
): Camera {
  if (box.width >= LOGICAL_W) return { zoom: 1, dx: 0, dy: 0 };
  const minZoom = box.width / LOGICAL_W;
  const a = toScreenX(fighters[0].x);
  const b = toScreenX(fighters[1].x);
  const need = Math.abs(b - a) + 2 * CAMERA_MARGIN;
  const zoom = Math.min(Math.max(maxZoom, minZoom), Math.max(minZoom, box.width / need));
  const half = box.width / 2 / zoom;
  const cx = Math.min(Math.max((a + b) / 2, half), LOGICAL_W - half);
  return { zoom, dx: box.width / 2 - cx * zoom, dy: box.height - STAGE_H * zoom };
}

/** While a banner is up the camera eases out to this zoom, so the fighters stand clear of it. */
export const BANNER_ZOOM = 1;
/** Ticks the camera takes to ease out when a round ends, and back in after "Fight!". */
const BANNER_EASE_TICKS = 10;
/** The round-start banner shows for this many ticks of a round. */
const ROUND_START_BANNER_TICKS = 45;

/**
 * The camera's zoom limit for `state`: CAMERA_MAX_ZOOM while fighting, easing to BANNER_ZOOM over
 * BANNER_EASE_TICKS once a round ends and while a round's start banner is up, then back.
 */
export function zoomCap(state: MatchState): number {
  const ease = (t: number): number =>
    CAMERA_MAX_ZOOM - (CAMERA_MAX_ZOOM - BANNER_ZOOM) * Math.max(0, Math.min(1, t));
  if (state.status !== 'fighting') {
    const r = state.roundResults[state.roundResults.length - 1];
    const since = r === undefined ? BANNER_EASE_TICKS : state.tick - (r.endTick + 1);
    return ease(since / BANNER_EASE_TICKS);
  }
  return ease(1 - (state.roundTick - ROUND_START_BANNER_TICKS) / BANNER_EASE_TICKS);
}

/**
 * Draws the stage for `state`: the arena 1920 × 1080, or through a camera into a narrower `box`
 * (the square video). `look.ui` scales the top bar; `look.minText` keeps small text legible.
 */
export function drawFighterStage(
  ctx: CanvasRenderingContext2D,
  state: MatchState,
  overlay: StageOverlay,
  look: StageLook,
): void {
  const tick = state.tick;
  const box = look.box ?? { width: LOGICAL_W, height: STAGE_H };
  const cam = cameraFor(state.fighters, box, zoomCap(state));
  const colors = overlay.colors ?? DEFAULT_COLORS;
  const palettes = [paletteFor(colors[0]), paletteFor(colors[1])] as const;
  const dc: EffectDrawContext = {
    ctx,
    toX: toScreenX,
    floorY: FLOOR_Y,
    colors: [palettes[0].main, palettes[1].main],
  };

  ctx.save();
  // Behind everything: the sky's top colour, for any of the box the zoomed-out arena leaves.
  ctx.fillStyle = '#0b1026';
  ctx.fillRect(0, 0, box.width, box.height);
  ctx.transform(cam.zoom, 0, 0, cam.zoom, cam.dx, cam.dy);
  drawStage(ctx);
  drawWallMarks(ctx, visibleArena(cam, box.width));
  // The attacking / active fighter draws on top, so a punch or throw reads over the opponent.
  const order = drawOrder(state);
  for (const side of order) drawFighter(ctx, state, side, tick, palettes[side]);
  for (const pr of state.projectiles) drawProjectile(dc, pr, tick);
  for (const fx of liveEffects(overlay.effects, tick)) drawEffect(dc, fx, tick);
  ctx.restore();
  const hudBottom = drawTopBar(
    ctx,
    state,
    overlay,
    palettes,
    look.ui,
    look.minText ?? 0,
    box.width,
  );
  drawBanner(ctx, state, overlay, look.minText ?? 0, box.width, hudBottom);
}

function drawPriority(f: FighterState): number {
  if (f.phase === 'active') return 3;
  if (f.phase === 'startup' || f.phase === 'airborne') return 2;
  if (f.phase === 'recovery') return 1;
  if (f.phase === 'hitstun' || f.phase === 'knockdown' || f.phase === 'blockstun') return -1;
  return 0;
}

/** Back-to-front draw order: the fighter doing something draws last (on top). Exported for tests. */
export function drawOrder(state: Pick<MatchState, 'fighters'>): [Side, Side] {
  const [a, b] = state.fighters;
  return drawPriority(a) > drawPriority(b) ? [1, 0] : [0, 1];
}

/** Skeleton in local pose px -> fighter-space logical px (before facing and the y flip). */
export function scaleSkeleton(sk: Skeleton, sx = FIGHTER_SCALE_X, sy = FIGHTER_SCALE_Y): Skeleton {
  const out = {} as Skeleton;
  for (const k of Object.keys(sk) as (keyof Skeleton)[]) {
    out[k] = { x: sk[k].x * sx, y: sk[k].y * sy };
  }
  return out;
}

function drawStage(ctx: CanvasRenderingContext2D): void {
  const sky = ctx.createLinearGradient(0, 0, 0, FLOOR_Y);
  sky.addColorStop(0, '#0b1026');
  sky.addColorStop(0.55, '#26204d');
  sky.addColorStop(1, '#4a3366');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, LOGICAL_W, FLOOR_Y);

  // Distant skyline band, flat shapes only.
  ctx.fillStyle = '#1c1838';
  for (let i = 0; i < 12; i++) {
    const w = 120 + ((i * 53) % 90);
    const h = 90 + ((i * 97) % 160);
    ctx.fillRect(i * 165 - 20, FLOOR_Y - h, w, h);
  }

  const floor = ctx.createLinearGradient(0, FLOOR_Y, 0, STAGE_H);
  floor.addColorStop(0, '#3a3346');
  floor.addColorStop(1, '#17141f');
  ctx.fillStyle = floor;
  ctx.fillRect(0, FLOOR_Y, LOGICAL_W, STAGE_H - FLOOR_Y);
  ctx.fillStyle = '#8f83a8';
  ctx.fillRect(0, FLOOR_Y, LOGICAL_W, 4);

  // Floor perspective lines toward a center vanishing point.
  ctx.strokeStyle = 'rgba(160, 150, 190, 0.18)';
  ctx.lineWidth = 3;
  for (let i = -6; i <= 6; i++) {
    ctx.beginPath();
    ctx.moveTo(LOGICAL_W / 2 + i * 90, FLOOR_Y);
    ctx.lineTo(LOGICAL_W / 2 + i * 260, STAGE_H);
    ctx.stroke();
  }
}

/** Half the width of a wall mark (arena px). */
export const WALL_MARK_HALF_W = 6;

/** The arena x range a camera shows across a box `width` px wide. */
export function visibleArena(cam: Camera, width: number): { left: number; right: number } {
  return { left: -cam.dx / cam.zoom, right: (width - cam.dx) / cam.zoom };
}

/** A wall mark fades in over this many arena px once it is wholly inside the view. */
export const WALL_MARK_FADE = 48;

/**
 * The wall marks at the stage edges and their opacity: each one is drawn whole inside the visible
 * arena or not at all (never a sliver at the box's edge), fading in over WALL_MARK_FADE px as the
 * camera brings it inside, so it doesn't pop. The full arena shows both at full opacity.
 */
export function wallMarksShown(view: {
  left: number;
  right: number;
}): { x: number; alpha: number }[] {
  return [STAGE_LEFT, STAGE_RIGHT]
    .map((x) => {
      const inside = Math.min(x - WALL_MARK_HALF_W - view.left, view.right - x - WALL_MARK_HALF_W);
      return { x, alpha: Math.max(0, Math.min(1, inside / WALL_MARK_FADE)) };
    })
    .filter((m) => m.alpha > 0);
}

function drawWallMarks(ctx: CanvasRenderingContext2D, view: { left: number; right: number }): void {
  const w = 2 * WALL_MARK_HALF_W;
  for (const { x, alpha } of wallMarksShown(view)) {
    ctx.fillStyle = `rgba(226, 232, 240, ${(0.16 * alpha).toFixed(3)})`;
    ctx.fillRect(x - WALL_MARK_HALF_W, 300, w, FLOOR_Y - 300);
    ctx.fillStyle = `rgba(226, 232, 240, ${(0.55 * alpha).toFixed(3)})`;
    for (let y = 320; y < FLOOR_Y; y += 70) ctx.fillRect(x - WALL_MARK_HALF_W, y, w, 30);
  }
}

function seg(ctx: CanvasRenderingContext2D, a: Point, b: Point, width: number): void {
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
}

function dot(ctx: CanvasRenderingContext2D, c: Point, r: number): void {
  ctx.beginPath();
  ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
  ctx.fill();
}

function drawFighter(
  ctx: CanvasRenderingContext2D,
  state: MatchState,
  side: Side,
  tick: number,
  pal: FighterPalette,
) {
  const f: FighterState = state.fighters[side];
  const facing = facingOf(state, side);
  const pose = poseFor(f, { tick, facing });
  const sk = scaleSkeleton(skeleton(pose));
  const flash = f.phase === 'hitstun' && f.phaseTick < 3;
  const main = flash ? pal.flash : pal.main;
  const shade = flash ? pal.flash : pal.shade;
  const sx = toScreenX(f.x);
  const lift = (f.y / SUB) * PX_PER_UNIT;

  // Floor shadow, shrinking with height.
  ctx.save();
  ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
  const shrink = Math.max(0.4, 1 - lift / 400);
  ctx.beginPath();
  ctx.ellipse(sx, FLOOR_Y + 6, 54 * shrink, 11 * shrink, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.translate(sx, FLOOR_Y - lift);
  ctx.scale(facing, -1);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const k = FIGHTER_STROKE;
  const W = {
    torso: WIDTHS.torso * k,
    upperArm: WIDTHS.upperArm * k,
    foreArm: WIDTHS.foreArm * k,
    thigh: WIDTHS.thigh * k,
    shin: WIDTHS.shin * k,
    fist: WIDTHS.fist * k,
  };
  const headR = SEGMENTS.headR * Math.sqrt(FIGHTER_SCALE_X * FIGHTER_SCALE_Y);

  const limbs = (o: number, back: string, front: string, body: string): void => {
    // Back limbs, torso, head, front leg, front arm.
    ctx.strokeStyle = back;
    ctx.fillStyle = back;
    seg(ctx, sk.hip, sk.backKnee, W.thigh + o);
    seg(ctx, sk.backKnee, sk.backFoot, W.shin + o);
    seg(ctx, sk.shoulder, sk.backElbow, W.upperArm + o);
    seg(ctx, sk.backElbow, sk.backHand, W.foreArm + o);
    dot(ctx, sk.backHand, W.fist + o / 2);
    ctx.strokeStyle = body;
    ctx.fillStyle = body;
    seg(ctx, sk.hip, sk.neck, W.torso + o);
    dot(ctx, sk.head, headR + o / 2);
    ctx.strokeStyle = front;
    ctx.fillStyle = front;
    seg(ctx, sk.hip, sk.frontKnee, W.thigh + o);
    seg(ctx, sk.frontKnee, sk.frontFoot, W.shin + o);
    seg(ctx, sk.shoulder, sk.frontElbow, W.upperArm + o);
    seg(ctx, sk.frontElbow, sk.frontHand, W.foreArm + o);
    dot(ctx, sk.frontHand, (pose.open ? W.fist * 0.8 : W.fist) + o / 2);
  };
  // Outline pass, then color pass: one clean silhouette edge.
  limbs(OUTLINE_PX * 2, pal.outline, pal.outline, pal.outline);
  limbs(0, shade, main, main);

  // Headband and eye, so facing reads even in a small thumbnail.
  const hx = sk.head.x;
  const hy = sk.head.y;
  ctx.strokeStyle = pal.band;
  ctx.lineWidth = 7;
  ctx.lineCap = 'butt';
  ctx.beginPath();
  ctx.moveTo(hx - headR + 1, hy + 5);
  ctx.lineTo(hx + headR - 1, hy + 5);
  ctx.stroke();
  ctx.lineCap = 'round';
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.moveTo(hx - headR + 2, hy + 5);
  ctx.lineTo(hx - headR - 13, hy + 10 + 4 * Math.sin(tick * 0.3));
  ctx.stroke();
  ctx.fillStyle = pal.outline;
  dot(ctx, { x: hx + 10, y: hy - 1 }, 3.5);
  ctx.restore();
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

/** The largest size from `maxPx` down to `minPx` at which one of `texts` fits `maxW` (that one). */
function fitLabel(
  ctx: CanvasRenderingContext2D,
  texts: readonly string[],
  maxW: number,
  maxPx: number,
  minPx: number,
  weight: number,
): string {
  for (const t of texts) {
    for (let px = maxPx; px >= minPx; px -= 2) {
      ctx.font = font(px, weight);
      if (ctx.measureText(t).width <= maxW) return t;
    }
  }
  ctx.font = font(minPx, weight);
  let t = texts[texts.length - 1] ?? '';
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxW) t = t.slice(0, -1);
  return ctx.measureText(t).width <= maxW ? t : `${t}…`;
}

/** Health at or under this share of the maximum is low: the bar's outline flashes red. */
export const LOW_HEALTH = 0.3;

/**
 * Health bars, labels, round pips and the clock across the top of a `width`-wide box. Returns
 * the bottom of its band.
 */
function drawTopBar(
  ctx: CanvasRenderingContext2D,
  state: MatchState,
  overlay: StageOverlay,
  palettes: readonly [FighterPalette, FighterPalette],
  ui: number,
  minText: number,
  width: number,
): number {
  const margin = 70;
  const barW = Math.min(700, width / 2 - margin - 110);
  const barH = Math.max(26 + 14 * ui, minText + 6);
  const top = 34 + 30 * ui;
  const clockW = 2 * (width / 2 - margin - barW);
  const clockPx = Math.min(clockW * 0.6, 56 * ui);
  const roundPx = Math.max(18 * ui, minText);
  const bandBottom = Math.max(
    top + barH + 30 + 50 * ui,
    top + barH / 2 + clockPx * 0.5 + roundPx * 1.25,
  );

  ctx.fillStyle = 'rgba(5, 6, 18, 0.55)';
  ctx.fillRect(0, 0, width, bandBottom);

  for (const side of [0, 1] as const) {
    const f = state.fighters[side];
    const pal = palettes[side];
    const x0 = side === 0 ? margin : width - margin - barW;
    const frac = Math.max(0, Math.min(1, f.health / state.config.maxHealth));

    // Label above the bar, outer-aligned, fitted to the bar (without its model id if need be).
    const labelPx = Math.max(30 * ui, minText);
    const full = overlay.labels[side];
    const variants = [full, full.replace(/\s*\(.*\)\s*$/, '')].filter(
      (t, i, all) => all.indexOf(t) === i,
    );
    const label = fitLabel(ctx, variants, barW, labelPx, Math.max(minText, labelPx * 0.8), 700);
    ctx.fillStyle = pal.main;
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = side === 0 ? 'left' : 'right';
    ctx.fillText(label, side === 0 ? x0 : x0 + barW, top - 10);

    roundRect(ctx, x0 - 4, top - 4, barW + 8, barH + 8, 10);
    ctx.fillStyle = '#0d0f1c';
    ctx.fill();
    ctx.fillStyle = '#3b1420';
    ctx.fillRect(x0, top, barW, barH);
    const fillW = barW * frac;
    // The seat's colour at any health, so who is who still reads at the climax.
    ctx.fillStyle = pal.main;
    // Anchored at the outer edge, draining toward the center.
    ctx.fillRect(side === 0 ? x0 : x0 + barW - fillW, top, fillW, barH);
    if (frac <= LOW_HEALTH && f.health > 0) {
      // Low health: the outline flashes red (by tick, so frames stay deterministic).
      const pulse = 0.5 + 0.5 * Math.sin(state.tick * 0.25);
      ctx.lineWidth = 5 + 3 * pulse;
      ctx.strokeStyle = `rgba(244, 63, 94, ${(0.55 + 0.45 * pulse).toFixed(3)})`;
      roundRect(ctx, x0 - 4, top - 4, barW + 8, barH + 8, 10);
      ctx.stroke();
    }

    ctx.fillStyle = '#ffffff';
    ctx.font = font(Math.max(22 * ui, minText), 700);
    ctx.textBaseline = 'middle';
    ctx.textAlign = side === 0 ? 'right' : 'left';
    ctx.lineWidth = 6;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(5, 6, 18, 0.65)';
    const hx = side === 0 ? x0 + barW - 10 : x0 + 10;
    ctx.strokeText(String(f.health), hx, top + barH / 2 + 1);
    ctx.fillText(String(f.health), hx, top + barH / 2 + 1);

    // Round markers next to the clock.
    const pip = 9 + 4 * ui;
    for (let i = 0; i < state.config.roundsToWin; i++) {
      const px = side === 0 ? x0 + barW - pip - i * (pip * 2 + 10) : x0 + pip + i * (pip * 2 + 10);
      const py = top + barH + 14 + pip;
      ctx.beginPath();
      ctx.arc(px, py, pip, 0, Math.PI * 2);
      ctx.fillStyle = i < f.roundsWon ? pal.main : 'rgba(255,255,255,0.12)';
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(255,255,255,0.6)';
      ctx.stroke();
    }
  }

  // Round clock, and the round under it.
  const left = Math.max(0, state.config.roundTicks - state.roundTick);
  const secs = Math.ceil(left / TICK_RATE);
  const clockY = top + barH / 2;
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = font(clockPx, 800);
  ctx.fillText(String(secs), width / 2, clockY);
  ctx.font = font(roundPx, 700);
  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  const roundY = clockY + clockPx * 0.5 + roundPx * 0.55;
  ctx.fillText(`R${String(state.round)}`, width / 2, roundY);
  if (overlay.note !== undefined) {
    ctx.fillStyle = '#fde68a';
    ctx.fillText(overlay.note, width / 2, roundY + roundPx * 1.1);
  }
  return bandBottom;
}

function winnerName(winner: Side, names: readonly [string, string]): string {
  return `${names[winner]} wins`;
}

/**
 * The round-end / match-end banner, or null while fighting: a big word (the round's end: "K.O.",
 * "TIME", "DOUBLE K.O.", or "ROUND n" as one starts) and a line naming who won, by name
 * (`names`, e.g. "OpenAI Decisions wins 2–0"), with the winning side (null: none, or a draw) for
 * the line's color. Exported for tests.
 */
export function bannerText(
  state: MatchState,
  names: readonly [string, string] = ['P1', 'P2'],
): { big: string; line: string; winner: Side | null } | null {
  const last = state.roundResults[state.roundResults.length - 1];
  const reasonWord =
    last === undefined
      ? ''
      : last.reason === 'timeout'
        ? 'TIME'
        : last.reason === 'doubleKo'
          ? 'DOUBLE K.O.'
          : 'K.O.';
  if (state.status === 'matchOver') {
    const w = state.winner ?? 'draw';
    const [a, b] = [state.fighters[0].roundsWon, state.fighters[1].roundsWon];
    // Winner's rounds first ("wins 2–0"); a draw keeps P1–P2 order.
    const score = w === 1 ? `${String(b)}–${String(a)}` : `${String(a)}–${String(b)}`;
    return {
      big: reasonWord === '' ? 'MATCH OVER' : reasonWord,
      line: w === 'draw' ? `Match drawn · ${score}` : `${winnerName(w, names)} the match ${score}`,
      winner: w === 'draw' ? null : w,
    };
  }
  if (state.status === 'roundOver') {
    if (last === undefined) return null;
    const who = last.winner === 'draw' ? 'Draw' : winnerName(last.winner, names);
    return {
      big: reasonWord,
      line: `Round ${String(last.round)} · ${who}`,
      winner: last.winner === 'draw' ? null : last.winner,
    };
  }
  if (state.roundTick < ROUND_START_BANNER_TICKS) {
    return { big: `ROUND ${String(state.round)}`, line: 'Fight!', winner: null };
  }
  return null;
}

/**
 * The banner: under the top bar (from `top`), above the fighters' heads, nearly opaque, so its
 * big word never sits on a fighter.
 */
function drawBanner(
  ctx: CanvasRenderingContext2D,
  state: MatchState,
  overlay: StageOverlay,
  minText: number,
  width: number,
  top: number,
): void {
  const b = bannerText(state, overlay.names);
  if (b === null) return;
  const bigPx = 112;
  const linePx = Math.max(54, minText * 1.15);
  const h = bigPx * 1.05 + linePx * 1.35 + 40;
  const y = top + 14;
  ctx.fillStyle = 'rgba(5, 6, 18, 0.86)';
  ctx.fillRect(0, y, width, h);
  ctx.fillStyle = 'rgba(253, 230, 138, 0.35)';
  ctx.fillRect(0, y, width, 3);
  ctx.fillRect(0, y + h - 3, width, 3);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const big = fitLabel(ctx, [b.big], width - 120, bigPx, 72, 900);
  ctx.lineJoin = 'round';
  ctx.lineWidth = 10;
  ctx.strokeStyle = '#1a0f02';
  ctx.strokeText(big, width / 2, y + 20 + bigPx * 0.55);
  ctx.fillStyle = '#fde68a';
  ctx.fillText(big, width / 2, y + 20 + bigPx * 0.55);
  const line = fitLabel(ctx, [b.line], width - 120, linePx, Math.max(minText, 36), 800);
  // The winner's line in its player's color (its model's, whichever seat).
  ctx.fillStyle = b.winner === null ? '#ffffff' : (overlay.colors ?? DEFAULT_COLORS)[b.winner];
  ctx.fillText(line, width / 2, y + 20 + bigPx * 1.05 + linePx * 0.62);
}
