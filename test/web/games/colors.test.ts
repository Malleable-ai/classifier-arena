import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseMatchLog } from '../../../src/core/log/read.js';
import { matchesDir } from '../../../src/core/results/paths.js';
import { rendererFor } from '../../../src/web/games/index.js';
import { drawCompactPanel } from '../../../src/web/shell/compact-panel.js';
import { panelHeaderOf } from '../../../src/web/shell/panel.js';
import { renderLayout, SQUARE } from '../../../src/web/shell/render-layout.js';
import { framePanel, videoStage } from '../../../src/web/shell/stage.js';
import { MODEL_COLORS, NEUTRAL_COLORS } from '../../../src/web/shell/theme.js';
import { fakeCtx } from '../cards/fake-ctx.js';

/**
 * Colors follow the model, not the seat: Jev is teal and OpenAI Decisions amber whichever seat
 * they sit in, on the stage, in the panel and in the video cards; baselines keep neutral colors.
 * Checked on published head-to-head logs with Jev in seat 0 and in seat 1, for every game.
 */

const JEV = MODEL_COLORS['jev'] ?? '';
const OPENAI = MODEL_COLORS['openai'] ?? '';

function firstLog(game: string, pairing: string) {
  const file = readdirSync(matchesDir(game))
    .filter((f) => f.includes(`-${pairing}-`) && f.endsWith('.jsonl'))
    .sort()[0];
  if (file === undefined) throw new Error(`no ${pairing} log for ${game}`);
  return parseMatchLog(readFileSync(join(matchesDir(game), file), 'utf8'));
}

for (const game of ['fighter', 'inbox', 'clues']) {
  describe(`${game}: colors follow the model`, () => {
    const renderer = rendererFor(game);
    if (renderer === null) throw new Error(`no renderer for ${game}`);
    for (const [pairing, expected] of [
      ['jev-vs-openai', [JEV, OPENAI]],
      ['openai-vs-jev', [OPENAI, JEV]],
    ] as const) {
      it(`${pairing}: frames, stage labels and the cards`, () => {
        const log = firstLog(game, pairing);
        const tl = renderer.timeline(log);
        const frame = tl.at(Math.floor(tl.frames / 2));
        expect(frame.colors).toEqual(expected);

        // The stage draws each seat's label in its player's color.
        const box = videoStage(renderer, SQUARE);
        const layout = renderLayout(SQUARE, box);
        const stage = fakeCtx();
        renderer.draw(stage.ctx, frame, { cssScale: layout.cssScale, size: box });
        for (const seat of [0, 1] as const) {
          const tag = `P${String(seat + 1)} · `;
          const label = stage.texts.find((t) => t.text.startsWith(tag));
          expect(label?.color, `${tag}label`).toBe(expected[seat]);
        }

        // So do the panel model and the video cards.
        const panel = framePanel(frame, panelHeaderOf(log.header), renderer);
        expect(panel.panels.map((p) => p.color)).toEqual(expected);
        const cards = fakeCtx();
        drawCompactPanel(cards.ctx, panel, layout);
        for (const seat of [0, 1] as const) {
          const label = cards.texts.find((t) => t.text.startsWith(`P${String(seat + 1)} · `));
          expect(label?.color).toBe(expected[seat]);
        }
      });
    }

    it('baselines keep neutral colors', () => {
      const file = readdirSync(matchesDir(game))
        .filter((f) => /-(random|scripted)-vs-(random|scripted)-/.test(f))
        .sort()[0];
      if (file === undefined) return;
      const log = parseMatchLog(readFileSync(join(matchesDir(game), file), 'utf8'));
      expect(renderer.timeline(log).at(0).colors).toEqual(NEUTRAL_COLORS);
    });
  });
}
