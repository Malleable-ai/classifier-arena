import { describe, expect, it } from 'vitest';
import { MOVES } from '../../../../src/games/fighter/engine/moves.js';
import type { FighterState, MatchState } from '../../../../src/games/fighter/engine/types.js';
import {
  BANNER_ZOOM,
  bannerText,
  CAMERA_MAX_ZOOM,
  cameraFor,
  displayName,
  drawOrder,
  FIGHTER_SCALE_X,
  FIGHTER_SCALE_Y,
  PX_PER_UNIT,
  scaleSkeleton,
  STAGE_LEFT,
  STAGE_RIGHT,
  toScreenX,
  visibleArena,
  WALL_MARK_FADE,
  WALL_MARK_HALF_W,
  wallMarksShown,
  zoomCap,
} from '../../../../src/web/games/fighter/canvas.js';
import type { PoseInput } from '../../../../src/web/games/fighter/poses.js';
import { bodyExtent, poseFor, skeleton } from '../../../../src/web/games/fighter/poses.js';

function f(over: Partial<PoseInput>): PoseInput {
  return { action: 'stand', phase: 'idle', phaseTick: 0, busyTicks: 0, x: 35_000, ...over };
}

function matchOver(roundsWon: [number, number], winner: 0 | 1 | 'draw'): MatchState {
  return {
    status: 'matchOver',
    winner,
    roundResults: [],
    fighters: [{ roundsWon: roundsWon[0] }, { roundsWon: roundsWon[1] }],
  } as unknown as MatchState;
}

describe('bannerText', () => {
  const NAMES = ['Jev', 'OpenAI Decisions'] as const;

  it("names the winner and puts the winner's rounds first", () => {
    expect(bannerText(matchOver([0, 2], 1), NAMES)?.line).toBe(
      'OpenAI Decisions wins the match 2–0',
    );
    expect(bannerText(matchOver([2, 1], 0), NAMES)?.line).toBe('Jev wins the match 2–1');
    expect(bannerText(matchOver([1, 1], 'draw'), NAMES)?.line).toBe('Match drawn · 1–1');
    // Without names, the seats.
    expect(bannerText(matchOver([0, 2], 1))?.line).toBe('P2 wins the match 2–0');
  });

  it('says how the last round ended in big letters, and who won it', () => {
    const s = {
      ...matchOver([1, 0], 'draw'),
      status: 'roundOver',
      roundResults: [{ round: 1, winner: 1, reason: 'ko', endTick: 900, health: [0, 40] }],
    } as unknown as MatchState;
    expect(bannerText(s, NAMES)).toEqual({
      big: 'K.O.',
      line: 'Round 1 · OpenAI Decisions wins',
      winner: 1,
    });
    const timeout = {
      ...s,
      roundResults: [{ round: 2, winner: 0, reason: 'timeout', endTick: 900, health: [9, 4] }],
    } as unknown as MatchState;
    expect(bannerText(timeout, NAMES)).toEqual({
      big: 'TIME',
      line: 'Round 2 · Jev wins',
      winner: 0,
    });
    const over = { ...s, status: 'matchOver', winner: 1 } as unknown as MatchState;
    expect(bannerText(over, NAMES)?.big).toBe('K.O.');
    // The winner (for the line's color: its model's), none on a draw.
    expect(bannerText(over, NAMES)?.winner).toBe(1);
    expect(bannerText(matchOver([1, 1], 'draw'), NAMES)?.winner).toBeNull();
  });

  it('names a model by its label without the model id', () => {
    expect(displayName(1, 'OpenAI Decisions (gpt-6-luna)')).toBe('OpenAI Decisions');
    expect(displayName(0, 'Jev (TypeSafe)')).toBe('Jev');
    expect(displayName(0, 'Scripted bot')).toBe('Scripted bot');
    expect(displayName(1, '')).toBe('P2');
  });
});

describe('the square video camera', () => {
  const BOX = { width: 1768, height: 1080 };
  const at = (a: number, b: number) => [{ x: a * 100 }, { x: b * 100 }] as const;

  it('is the identity on the full arena', () => {
    expect(cameraFor(at(350, 650), { width: 1920, height: 1080 })).toEqual({
      zoom: 1,
      dx: 0,
      dy: 0,
    });
  });

  it('zooms in on close fighters, centred between them, the floor on the bottom edge', () => {
    const cam = cameraFor(at(450, 550), BOX);
    expect(cam.zoom).toBe(CAMERA_MAX_ZOOM);
    const mid = (toScreenX(45_000) + toScreenX(55_000)) / 2;
    expect(mid * cam.zoom + cam.dx).toBeCloseTo(BOX.width / 2);
    expect(1080 * cam.zoom + cam.dy).toBeCloseTo(BOX.height);
  });

  it('zooms out to the whole arena for fighters at the walls, and never shows past its ends', () => {
    const far = cameraFor(at(30, 970), BOX);
    expect(far.zoom).toBeCloseTo(BOX.width / 1920);
    expect(far.dx).toBeCloseTo(0);
    // Both near the left wall: the camera stops at the arena's left end.
    const left = cameraFor(at(30, 100), BOX);
    expect(left.dx).toBeLessThanOrEqual(1e-9);
    expect(1920 * left.zoom + left.dx).toBeGreaterThanOrEqual(BOX.width - 1e-9);
  });

  it('eases out while a banner is up, so the fighters stand clear of it', () => {
    const fighting = (roundTick: number) =>
      ({ status: 'fighting', roundTick, tick: 500, roundResults: [] }) as unknown as MatchState;
    expect(zoomCap(fighting(0))).toBe(BANNER_ZOOM);
    expect(zoomCap(fighting(50))).toBeGreaterThan(BANNER_ZOOM);
    expect(zoomCap(fighting(50))).toBeLessThan(CAMERA_MAX_ZOOM);
    expect(zoomCap(fighting(200))).toBe(CAMERA_MAX_ZOOM);
    const ended = (since: number) =>
      ({
        status: 'roundOver',
        roundTick: 900,
        tick: 1001 + since,
        roundResults: [{ round: 1, winner: 0, reason: 'ko', endTick: 1000, health: [5, 0] }],
      }) as unknown as MatchState;
    expect(zoomCap(ended(0))).toBe(CAMERA_MAX_ZOOM);
    expect(zoomCap(ended(5))).toBeLessThan(CAMERA_MAX_ZOOM);
    expect(zoomCap(ended(60))).toBe(BANNER_ZOOM);
    // A zoom cap under the fighters' own zoom wins.
    expect(cameraFor(at(480, 520), BOX, BANNER_ZOOM).zoom).toBe(BANNER_ZOOM);
  });

  it('keeps both fighters (and a margin) in view', () => {
    for (const [a, b] of [
      [100, 400],
      [300, 900],
      [480, 520],
      [600, 950],
    ] as const) {
      const cam = cameraFor(at(a, b), BOX);
      for (const x of [toScreenX(a * 100), toScreenX(b * 100)]) {
        const bx = x * cam.zoom + cam.dx;
        expect(bx).toBeGreaterThanOrEqual(0);
        expect(bx).toBeLessThanOrEqual(BOX.width);
      }
    }
  });

  it('draws a wall mark whole or not at all, never a sliver at the box edge', () => {
    // The full arena shows both marks fully.
    expect(
      wallMarksShown(visibleArena(cameraFor(at(350, 650), { width: 1920, height: 1080 }), 1920)),
    ).toEqual([
      { x: STAGE_LEFT, alpha: 1 },
      { x: STAGE_RIGHT, alpha: 1 },
    ]);
    // Every camera position across the arena: a mark drawn lies wholly inside the box.
    for (let a = 30; a <= 900; a += 7) {
      const cam = cameraFor(at(a, a + 60), BOX);
      const view = visibleArena(cam, BOX.width);
      for (const m of wallMarksShown(view)) {
        const left = (m.x - WALL_MARK_HALF_W) * cam.zoom + cam.dx;
        const right = (m.x + WALL_MARK_HALF_W) * cam.zoom + cam.dx;
        expect(left).toBeGreaterThanOrEqual(-1e-9);
        expect(right).toBeLessThanOrEqual(BOX.width + 1e-9);
        expect(m.alpha).toBeGreaterThan(0);
      }
    }
    // A mark just past the edge (the old 8 px sliver) isn't drawn; it fades in once inside.
    const right = STAGE_RIGHT + WALL_MARK_HALF_W;
    expect(wallMarksShown({ left: 1000, right: right - 2 })).toEqual([]);
    expect(wallMarksShown({ left: 1000, right: right + WALL_MARK_FADE / 2 })).toEqual([
      { x: STAGE_RIGHT, alpha: 0.5 },
    ]);
  });
});

describe('fighter layout', () => {
  it('keeps the idle and block silhouettes within +-45 units of the center (bodies may touch at the 60-unit minimum; outlines separate them)', () => {
    const inputs: PoseInput[] = [
      f({}),
      f({ action: 'block_high' }),
      f({ action: 'block_low' }),
      f({ action: 'block_high', phase: 'blockstun', phaseTick: 1, busyTicks: 10 }),
      f({ action: 'block_low', phase: 'blockstun', phaseTick: 1, busyTicks: 10 }),
    ];
    for (const input of inputs) {
      const e = bodyExtent(skeleton(poseFor(input)));
      const toUnits = (px: number) => (px * FIGHTER_SCALE_X) / PX_PER_UNIT;
      expect(toUnits(e.back), poseFor(input).name).toBeGreaterThanOrEqual(-45);
      expect(toUnits(e.front), poseFor(input).name).toBeLessThanOrEqual(45);
    }
  });

  it('keeps fighters readable: height scaled no more than width', () => {
    expect(FIGHTER_SCALE_Y).toBeGreaterThanOrEqual(FIGHTER_SCALE_X);
    const sk = scaleSkeleton(skeleton(poseFor(f({}))));
    // A standing fighter is still a good share of the 1080-px-tall stage.
    expect(sk.head.y).toBeGreaterThan(200);
  });

  it('never lifts the uppercut more than a few units off the engine y', () => {
    const m = MOVES.uppercut;
    const phases = [
      ['startup', m.startup],
      ['active', m.active],
      ['recovery', m.recovery],
    ] as const;
    for (const [phase, dur] of phases) {
      for (let t = 0; t < dur; t++) {
        const pose = poseFor(f({ action: 'uppercut', phase, phaseTick: t }));
        const units = (pose.lift * FIGHTER_SCALE_Y) / PX_PER_UNIT;
        expect(units, `${phase}:${String(t)}`).toBeLessThanOrEqual(4);
        // Grounded: the lowest point of the skeleton sits at most the hop above the floor.
        const sk = scaleSkeleton(skeleton(pose));
        const lowest = Math.min(...Object.values(sk).map((q: { y: number }) => q.y));
        expect(lowest / PX_PER_UNIT).toBeLessThanOrEqual(4 + 15);
      }
    }
  });

  it('draws the attacking fighter on top', () => {
    const st = (a: Partial<FighterState>, b: Partial<FighterState>) =>
      ({ fighters: [a, b] }) as unknown as Pick<MatchState, 'fighters'>;
    expect(drawOrder(st({ phase: 'idle' }, { phase: 'active' }))).toEqual([0, 1]);
    expect(drawOrder(st({ phase: 'active' }, { phase: 'hitstun' }))).toEqual([1, 0]);
    expect(drawOrder(st({ phase: 'knockdown' }, { phase: 'recovery' }))).toEqual([0, 1]);
    expect(drawOrder(st({ phase: 'startup' }, { phase: 'blockstun' }))).toEqual([1, 0]);
  });
});
