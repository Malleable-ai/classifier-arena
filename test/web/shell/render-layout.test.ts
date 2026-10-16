import { describe, expect, it } from 'vitest';
import {
  formatRenderSize,
  layoutKind,
  parseRenderSize,
  renderLayout,
  SQUARE,
  VIEW_CSS_WIDTH,
  WIDE,
  type Rect,
} from '../../../src/web/shell/render-layout.js';

const STAGE = { width: 1920, height: 1080 };

const inside = (r: Rect, w: number, h: number): boolean =>
  r.x >= 0 && r.y >= 0 && r.x + r.w <= w && r.y + r.h <= h && r.w > 0 && r.h > 0;
const overlap = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe('parseRenderSize', () => {
  it('reads <width>x<height> with even sides in range', () => {
    expect(parseRenderSize('1080x1080')).toEqual({ width: 1080, height: 1080 });
    expect(parseRenderSize(' 1920x1080 ')).toEqual({ width: 1920, height: 1080 });
    expect(formatRenderSize(WIDE)).toBe('1920x1080');
  });

  it('rejects odd, tiny, huge or malformed sizes', () => {
    for (const bad of [
      '1081x1080',
      '100x100',
      '8000x1080',
      '1080',
      '1080X1080',
      'x',
      '',
      '1e3x1000',
    ]) {
      expect(parseRenderSize(bad), bad).toBeNull();
    }
  });
});

describe('renderLayout', () => {
  it('square 1080: the stage fills the width on top, the two cards side by side below', () => {
    const l = renderLayout(SQUARE, STAGE);
    expect(l.kind).toBe('square');
    expect(l.stageScale).toBeCloseTo(0.5625);
    expect(l.stage).toEqual({ x: 0, y: 0, w: 1080, h: 608 });
    expect(l.panel).toEqual({ x: 0, y: 608, w: 1080, h: 472 });
    expect(l.ticker).toBeNull();
    const [a, b] = l.seats;
    expect(a.y).toBe(b.y);
    expect(a.w).toBe(b.w);
    expect(a.x).toBeLessThan(b.x);
    // Big enough to read on a phone: each card is about half the width and 40% of the height.
    expect(a.w).toBeGreaterThanOrEqual(500);
    expect(a.h).toBeGreaterThanOrEqual(420);
    // A phone shows the 1080 px video ~390 CSS px wide.
    expect(l.cssScale).toBeCloseTo((0.5625 * VIEW_CSS_WIDTH.square) / 1080);
  });

  it('wide 1920x1080: the stage at 3/4 width on the left, cards stacked right, ticker under the stage', () => {
    const l = renderLayout(WIDE, STAGE);
    expect(l.kind).toBe('wide');
    expect(l.stageScale).toBeCloseTo(0.75);
    expect(l.stage).toEqual({ x: 0, y: 0, w: 1440, h: 810 });
    expect(l.ticker).toEqual({ x: 0, y: 810, w: 1440, h: 270 });
    expect(l.panel).toEqual({ x: 1440, y: 0, w: 480, h: 1080 });
    const [a, b] = l.seats;
    expect(a.x).toBe(b.x);
    expect(a.y).toBeLessThan(b.y);
    expect(a.x).toBeGreaterThanOrEqual(1440);
  });

  for (const size of [SQUARE, WIDE, { width: 1280, height: 720 }, { width: 720, height: 720 }]) {
    it(`${formatRenderSize(size)}: every rect fits the canvas and none overlap`, () => {
      const l = renderLayout(size, STAGE);
      expect([l.width, l.height]).toEqual([size.width, size.height]);
      const rects = [l.stage, l.seats[0], l.seats[1], ...(l.ticker === null ? [] : [l.ticker])];
      for (const r of rects)
        expect(inside(r, size.width, size.height), JSON.stringify(r)).toBe(true);
      for (const [i, r] of rects.entries()) {
        for (const s of rects.slice(i + 1)) expect(overlap(r, s)).toBe(false);
      }
      // The stage keeps its aspect ratio.
      expect(l.stage.w / l.stage.h).toBeCloseTo(16 / 9, 1);
    });
  }

  it('picks the layout by aspect ratio', () => {
    expect(layoutKind(SQUARE)).toBe('square');
    expect(layoutKind({ width: 1080, height: 1350 })).toBe('square');
    expect(layoutKind({ width: 1280, height: 720 })).toBe('wide');
  });

  it('keeps 35% of a square for the panel even for a taller stage', () => {
    const l = renderLayout(SQUARE, { width: 1000, height: 1000 });
    expect(l.stage.h).toBeLessThanOrEqual(702);
    expect(l.stage.x).toBeGreaterThan(0);
    expect(l.panel.h).toBeGreaterThanOrEqual(378);
  });

  it("gives a narrower square stage (the fighter's camera box) more of the square", () => {
    const l = renderLayout(SQUARE, { width: 1768, height: 1080 });
    expect(l.stage).toEqual({ x: 0, y: 0, w: 1080, h: 660 });
    expect(l.panel).toEqual({ x: 0, y: 660, w: 1080, h: 420 });
    expect(l.stage.h / 1080).toBeGreaterThan(0.6);
  });
});
