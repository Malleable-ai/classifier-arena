import { describe, expect, it } from 'vitest';
import {
  CARD_MIN_TEXT,
  cardNaturalH,
  cardScale,
  drawCompactPanel,
} from '../../../src/web/shell/compact-panel.js';
import type { PanelModel, SeatPanel } from '../../../src/web/shell/panel.js';
import { renderLayout, SQUARE, WIDE } from '../../../src/web/shell/render-layout.js';
import { fakeCtx } from '../cards/fake-ctx.js';

const STAGE = { width: 1920, height: 1080 };
const FIGHTER_SQUARE = { width: 1768, height: 1080 };

function seat(over: Partial<SeatPanel>): SeatPanel {
  return {
    seat: 0,
    label: 'P1 · Jev (TypeSafe)',
    color: '#2dd4bf',
    choice: 'heavy_punch',
    choiceLabel: 'heavy punch',
    status: 'ok',
    statusText: 'ok',
    verdict: null,
    latencyMs: 212,
    perSecond: 4.2,
    bars: [
      { id: 'heavy_punch', label: 'heavy punch', p: 0.41 },
      { id: 'jab', label: 'jab', p: 0.3 },
      { id: 'walk_forward', label: 'walk forward', p: 0.1 },
    ],
    costUsd: 0.0123,
    flash: 0,
    thinking: false,
    previous: null,
    note: null,
    ...over,
  };
}

function model(a: Partial<SeatPanel>, b: Partial<SeatPanel>): PanelModel {
  return {
    panels: [
      seat(a),
      seat({ seat: 1, label: 'P2 · OpenAI Decisions (gpt-6-luna)', color: '#fbbf24', ...b }),
    ],
    ticker: [],
  };
}

describe('compact panel sizing', () => {
  it('scales a card by its height, between 0.9 and 1.15', () => {
    expect(cardScale({ h: cardNaturalH(true) })).toBe(1);
    expect(cardScale({ h: 100 })).toBe(0.9);
    expect(cardScale({ h: 2000 })).toBe(1.15);
    // Without a note row the same height scales the other rows up.
    expect(cardScale({ h: cardNaturalH(true) }, false)).toBeGreaterThan(1);
  });

  it('fits its rows in every video card, the fighter’s shorter square cards too', () => {
    for (const [size, stage] of [
      [SQUARE, STAGE],
      [SQUARE, FIGHTER_SQUARE],
      [WIDE, STAGE],
    ] as const) {
      for (const card of renderLayout(size, stage).seats) {
        expect(card.h).toBeGreaterThanOrEqual(cardNaturalH(true) * 0.9 - 20);
      }
    }
  });
});

describe('compact panel text', () => {
  const cases = [
    ['square', renderLayout(SQUARE, STAGE)],
    ['square, fighter', renderLayout(SQUARE, FIGHTER_SQUARE)],
    ['wide', renderLayout(WIDE, STAGE)],
  ] as const;

  for (const [name, layout] of cases) {
    it(`${name}: no text under ${String(CARD_MIN_TEXT)} px (10 CSS px on a phone)`, () => {
      const states: PanelModel[] = [
        model({ note: { choiceLabel: 'throw', status: 'dropped', statusText: 'busy' } }, {}),
        model(
          { note: { choiceLabel: 'block high', status: 'dropped', statusText: 'round over' } },
          {},
        ),
        model(
          { status: 'ok', verdict: 'right' },
          { status: 'dropped', statusText: 'too late', choiceLabel: 'jab' },
        ),
        model(
          { thinking: true, status: null, choiceLabel: null, latencyMs: null, bars: null },
          {
            thinking: true,
            status: null,
            previous: {
              choiceLabel: 'submersible',
              status: 'ok',
              statusText: 'ok',
              verdict: 'wrong',
            },
          },
        ),
      ];
      for (const m of states) {
        for (const noteRow of [true, false]) {
          const { ctx, texts } = fakeCtx();
          drawCompactPanel(ctx, m, layout, { noteRow });
          expect(texts.length).toBeGreaterThan(5);
          for (const t of texts) expect(t.px, t.text).toBeGreaterThanOrEqual(CARD_MIN_TEXT);
        }
      }
    });
  }

  it("shows the headline's note only where the game keeps a note row", () => {
    const m = model({ note: { choiceLabel: 'throw', status: 'dropped', statusText: 'busy' } }, {});
    const layout = renderLayout(SQUARE, FIGHTER_SQUARE);
    const withRow = fakeCtx();
    drawCompactPanel(withRow.ctx, m, layout, { noteRow: true });
    expect(withRow.texts.map((t) => t.text)).toContain('skipped (busy): throw');
    const without = fakeCtx();
    drawCompactPanel(without.ctx, m, layout);
    expect(without.texts.map((t) => t.text).join(' ')).not.toContain('throw');
  });

  it('a long note falls back to its short form rather than being cut', () => {
    const note = {
      choiceLabel: 'block high',
      status: 'dropped',
      statusText: 'round over',
    } as const;
    const { ctx, texts } = fakeCtx();
    drawCompactPanel(ctx, model({ note }, {}), renderLayout(WIDE, STAGE), { noteRow: true });
    const shown = texts.map((t) => t.text).filter((t) => t.includes('block high'));
    expect(shown).toEqual(['round over: block high']);
  });

  it('labels a dropped answer in the game’s words and shows no running cost', () => {
    const m = model({}, { status: 'dropped', statusText: 'too late', choiceLabel: 'legit' });
    const { ctx, texts } = fakeCtx();
    drawCompactPanel(ctx, m, renderLayout(SQUARE, STAGE));
    const all = texts.map((t) => t.text);
    expect(all).toContain('TOO LATE');
    expect(all).not.toContain('DROPPED');
    expect(all).toContain('212 ms');
    expect(all.join(' ')).not.toContain('$');
  });

  it('keeps a long answer whole beside its verdict (the badge shrinks to its mark)', () => {
    const m = model(
      { choiceLabel: 'submersible', verdict: 'right', bars: null },
      { choiceLabel: 'submersible', verdict: 'wrong', bars: null },
    );
    const { ctx, texts } = fakeCtx();
    drawCompactPanel(ctx, m, renderLayout(SQUARE, STAGE));
    expect(texts.filter((t) => t.text === 'SUBMERSIBLE')).toHaveLength(2);
  });
});
