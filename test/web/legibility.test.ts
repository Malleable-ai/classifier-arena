import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseMatchLog } from '../../src/core/log/read.js';
import { matchesDir } from '../../src/core/results/paths.js';
import { cluesRenderer } from '../../src/web/games/clues/renderer.js';
import { RENDERERS } from '../../src/web/games/index.js';
import { renderLayout, SQUARE, WIDE } from '../../src/web/shell/render-layout.js';
import { videoStage } from '../../src/web/shell/stage.js';
import { legibleFloor, MIN_TEXT_CSS_PX } from '../../src/web/shell/theme.js';
import { fakeCtx } from './cards/fake-ctx.js';

/**
 * The square video is watched about 390 px wide on a phone, so every text a viewer must read is
 * drawn at least MIN_TEXT_CSS_PX (10) CSS px there: about 28 px of the 1080 × 1080 frame. Each
 * game's stage is drawn as the square layout draws it (its square stage, the layout's cssScale)
 * into a recording context, and every text's size is checked in output px.
 */

/** Output px of 10 CSS px when 1080 px are shown 390 CSS px wide, less rounding. */
const MIN_OUT_PX = (MIN_TEXT_CSS_PX * 1080) / 390 - 0.6;
/** Clue Clash: a long board word on two lines may sit a little under it. */
const TWO_LINE_OUT_PX = 25;
/** Decorative text that repeats what is said elsewhere (the probability legend). */
const DECORATIVE = new Set(['API-reported probability', '0%', '100%', '· none reported']);

function logsOf(game: string) {
  return readdirSync(matchesDir(game))
    .filter((f) => f.endsWith('.jsonl'))
    .sort()
    .slice(0, 1)
    .map((f) => parseMatchLog(readFileSync(join(matchesDir(game), f), 'utf8')));
}

describe('legibility floor', () => {
  it('is 10 CSS px in logical px, so a desktop player keeps the design sizes', () => {
    expect(legibleFloor(0.5)).toBe(20);
    expect(legibleFloor(0.2)).toBe(50);
    expect(legibleFloor(0.05)).toBe(56);
    expect(legibleFloor(0)).toBe(0);
  });
});

for (const renderer of RENDERERS) {
  describe(`${renderer.gameId} in the square video`, () => {
    for (const log of logsOf(renderer.gameId)) {
      it('draws no must-read text under ~28 px of the 1080 frame', () => {
        const box = videoStage(renderer, SQUARE);
        const layout = renderLayout(SQUARE, box);
        const tl = renderer.timeline(log);
        const frames = [0, 300, Math.floor(tl.frames / 2), tl.frames - 30, tl.frames - 1];
        let drawn = 0;
        for (const n of frames) {
          const { ctx, texts } = fakeCtx();
          renderer.draw(ctx, tl.at(n), { cssScale: layout.cssScale, size: box });
          for (const t of texts) {
            if (t.text.trim() === '' || DECORATIVE.has(t.text)) continue;
            const out = t.px * layout.stageScale;
            const min = /^[a-z-]+$/.test(t.text) ? TWO_LINE_OUT_PX : MIN_OUT_PX;
            expect(out, `"${t.text}" at frame ${String(n)}`).toBeGreaterThanOrEqual(min);
            drawn++;
          }
        }
        expect(drawn).toBeGreaterThan(10);
      });

      it('keeps its desktop sizes in the wide video (the floor is under them)', () => {
        const layout = renderLayout(WIDE, renderer.stage);
        expect(legibleFloor(layout.cssScale)).toBeLessThan(28);
      });
    }
  });
}

describe('Clue Clash in the square video: the definition is what the game is about', () => {
  const renderer = RENDERERS.find((r) => r.gameId === 'clues');
  const log = logsOf('clues')[0];

  it('draws the definition at about 40 px of the 1080 frame or more, white', () => {
    if (renderer === undefined || log === undefined) throw new Error('no clues renderer or log');
    const box = videoStage(renderer, SQUARE);
    const layout = renderLayout(SQUARE, box);
    const tl = renderer.timeline(log);
    let words = 0;
    for (const n of [300, Math.floor(tl.frames / 3), Math.floor(tl.frames / 2)]) {
      const { ctx, texts } = fakeCtx();
      renderer.draw(ctx, tl.at(n), { cssScale: layout.cssScale, size: box });
      // The definition is the stage's serif text.
      for (const t of texts.filter(
        (x) => x.font.includes('Georgia') && !x.font.includes('italic'),
      )) {
        expect(
          t.px * layout.stageScale,
          `"${t.text}" at frame ${String(n)}`,
        ).toBeGreaterThanOrEqual(39);
        expect(t.color).toBe('#ffffff');
        words++;
      }
    }
    expect(words).toBeGreaterThan(3);
  });

  it('fits every board word on one line, never hyphenated inside', () => {
    if (renderer === undefined || log === undefined) throw new Error('no clues renderer or log');
    const box = videoStage(renderer, SQUARE);
    const layout = renderLayout(SQUARE, box);
    const tl = renderer.timeline(log);
    const { ctx, texts } = fakeCtx();
    renderer.draw(ctx, tl.at(300), { cssScale: layout.cssScale, size: box });
    const board = cluesRenderer.timeline(log).at(300).scene.words;
    const drawn = texts.map((t) => t.text);
    for (const w of board) expect(drawn, w).toContain(w);
    expect(drawn.filter((t) => /^[a-z]+-$/.test(t))).toEqual([]);
  });
});
